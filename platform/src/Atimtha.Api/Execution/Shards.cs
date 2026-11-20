using System.Text.Json.Nodes;
using Atimtha.Api.Infrastructure;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.Execution;

public sealed record ShardDto(Guid Id, int Index, int Total, string Status, string? Agent, JsonNode? Counts, DateTimeOffset? StartedAt, DateTimeOffset? FinishedAt, string? Error);

/// <summary>
/// Sharded runs (backlog §6/§10, migration 0011): a parent run holds no job; each child runs one slice
/// (<c>--shard=i/n</c>) on whichever agent claims it. Readers of a run (detail, CSV, JUnit, findings, compare, defects,
/// publishing) take the results of the parent and all its children; lists and trends show the parent only.
/// </summary>
public static class Shards
{
    public const int Min = 2;
    public const int Max = 8;

    public static bool IsParent(ExecutionRun r) => r.ShardTotal is not null && r.ParentExecutionId is null;

    /// <summary>the run itself and, for a sharded run, its children: where its results live</summary>
    public static async Task<List<Guid>> RunIdsAsync(AtimthaDbContext db, Guid executionId, CancellationToken ct)
    {
        var children = await db.Executions.AsNoTracking().Where(e => e.ParentExecutionId == executionId).Select(e => e.Id).ToListAsync(ct);
        return [executionId, .. children];
    }

    public static async Task<List<ShardDto>> ListAsync(AtimthaDbContext db, Guid parentId, CancellationToken ct)
    {
        var children = await db.Executions.AsNoTracking().Where(e => e.ParentExecutionId == parentId).OrderBy(e => e.ShardIndex).ToListAsync(ct);
        var agentIds = children.Where(c => c.AgentId != null).Select(c => c.AgentId!.Value).Distinct().ToList();
        var names = await db.Agents.AsNoTracking().Where(a => agentIds.Contains(a.Id)).ToDictionaryAsync(a => a.Id, a => a.Name, ct);
        return children.Select(c => new ShardDto(c.Id, c.ShardIndex ?? 0, c.ShardTotal ?? 0, c.Status.ToString().ToLowerInvariant(),
            c.AgentId is { } a ? names.GetValueOrDefault(a) : null, c.Counts is null ? null : JsonNode.Parse(c.Counts), c.StartedAt, c.FinishedAt, c.Error)).ToList();
    }

    private static bool Finished(ExecutionStatus s) => s is ExecutionStatus.Passed or ExecutionStatus.Failed or ExecutionStatus.Cancelled or ExecutionStatus.Error;

    /// <summary>
    /// The parent follows its children: running once one has started; when the last one finishes, the worst status
    /// (error, failed, cancelled, passed), the summed counts and the children's errors. The caller saves.
    /// </summary>
    public static async Task RollUpAsync(AtimthaDbContext db, Guid parentId, CancellationToken ct)
    {
        var parent = await db.Executions.FirstOrDefaultAsync(e => e.Id == parentId, ct);
        if (parent is null || Finished(parent.Status)) return;
        var children = await db.Executions.Where(e => e.ParentExecutionId == parentId).ToListAsync(ct);
        // the children being saved in this unit of work count with their new state
        foreach (var tracked in db.ChangeTracker.Entries<ExecutionRun>().Select(x => x.Entity).Where(x => x.ParentExecutionId == parentId))
        {
            var i = children.FindIndex(c => c.Id == tracked.Id);
            if (i >= 0) children[i] = tracked;
        }
        if (children.Count == 0) return;
        if (children.Any(c => c.StartedAt != null))
        {
            parent.StartedAt ??= children.Where(c => c.StartedAt != null).Min(c => c.StartedAt);
            if (parent.Status == ExecutionStatus.Queued) parent.Status = ExecutionStatus.Running;
        }
        if (!children.All(c => Finished(c.Status))) return;

        parent.Status = children.Any(c => c.Status == ExecutionStatus.Error) ? ExecutionStatus.Error
            : children.Any(c => c.Status == ExecutionStatus.Failed) ? ExecutionStatus.Failed
            : children.Any(c => c.Status == ExecutionStatus.Cancelled) ? ExecutionStatus.Cancelled
            : ExecutionStatus.Passed;
        parent.FinishedAt = children.Max(c => c.FinishedAt) ?? DateTimeOffset.UtcNow;
        var sum = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var c in children)
        {
            if (c.Counts is null || JsonNode.Parse(c.Counts) is not JsonObject o) continue;
            foreach (var (k, v) in o)
                if (v is JsonValue jv && jv.TryGetValue<int>(out var n)) sum[k] = sum.GetValueOrDefault(k) + n;
        }
        parent.Counts = new JsonObject(sum.Select(kv => KeyValuePair.Create(kv.Key, (JsonNode?)kv.Value))).ToJsonString();
        var errors = children.Where(c => !string.IsNullOrWhiteSpace(c.Error)).Select(c => $"Shard {c.ShardIndex}/{c.ShardTotal}: {c.Error}").ToList();
        var joined = string.Join("\n", errors);
        parent.Error = errors.Count == 0 ? null : joined.Length > 20_000 ? joined[..20_000] : joined;
    }

    /// <summary>
    /// After a shard's events are saved: the parent row is locked, so shards finishing at the same moment take turns and
    /// the last one sees every other shard finished.
    /// </summary>
    public static async Task RollUpLockedAsync(AtimthaDbContext db, Guid parentId, CancellationToken ct)
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await db.Database.ExecuteSqlAsync($"SELECT id FROM atimtha.execution WHERE id = {parentId} FOR UPDATE", ct);
        db.ChangeTracker.Clear();
        await RollUpAsync(db, parentId, ct);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
    }

    /// <summary>
    /// Maintenance (owner connection): parents whose children all finished some other way (a lost agent, the run time
    /// limit) are closed with the same rule as <see cref="RollUpAsync"/>.
    /// </summary>
    public const string MaintenanceSql = """
        WITH agg AS (
          SELECT c.parent_execution_id AS id,
                 count(*) FILTER (WHERE c.status NOT IN ('passed', 'failed', 'cancelled', 'error')) AS open,
                 bool_or(c.status = 'error') AS err, bool_or(c.status = 'failed') AS failed, bool_or(c.status = 'cancelled') AS cancelled,
                 min(c.started_at) AS started, max(c.finished_at) AS finished,
                 jsonb_build_object(
                   'total',   sum(COALESCE((c.counts->>'total')::int, 0)),
                   'passed',  sum(COALESCE((c.counts->>'passed')::int, 0)),
                   'failed',  sum(COALESCE((c.counts->>'failed')::int, 0)),
                   'flaky',   sum(COALESCE((c.counts->>'flaky')::int, 0)),
                   'skipped', sum(COALESCE((c.counts->>'skipped')::int, 0)),
                   'healed',  sum(COALESCE((c.counts->>'healed')::int, 0)),
                   'healingFailed', sum(COALESCE((c.counts->>'healingFailed')::int, 0))) AS counts
          FROM atimtha.execution c WHERE c.parent_execution_id IS NOT NULL GROUP BY c.parent_execution_id)
        UPDATE atimtha.execution p SET
          status = CASE WHEN agg.err THEN 'error' WHEN agg.failed THEN 'failed' WHEN agg.cancelled THEN 'cancelled' ELSE 'passed' END::atimtha.execution_status,
          started_at = COALESCE(p.started_at, agg.started), finished_at = COALESCE(agg.finished, now()), counts = agg.counts
        FROM agg WHERE p.id = agg.id AND agg.open = 0 AND p.status IN ('queued', 'assigned', 'running');
        """;

    /// <summary>cancelling a sharded run cancels every shard that has not finished</summary>
    public static async Task CancelChildrenAsync(AtimthaDbContext db, Guid parentId, CancellationToken ct)
    {
        foreach (var c in await db.Executions.Where(e => e.ParentExecutionId == parentId).ToListAsync(ct))
        {
            if (Finished(c.Status)) continue;
            if (c.Status == ExecutionStatus.Queued) { c.Status = ExecutionStatus.Cancelled; c.FinishedAt = DateTimeOffset.UtcNow; }
            else c.CancelRequested = true;
        }
    }

    internal static IResult? Refusal(short? shards, string kind) =>
        shards is null ? null
        : shards is < Min or > Max ? Results.ValidationProblem(new Dictionary<string, string[]> { ["shards"] = [$"{Min} to {Max} shards."] })
        : kind != "run" ? Results.ValidationProblem(new Dictionary<string, string[]> { ["shards"] = ["Only test runs are split into shards."] })
        : null;
}
