using System.Text.Json.Nodes;
using Atimtha.Api.Identity;
using Atimtha.Api.Infrastructure;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.Execution;

public sealed record DashboardProjectDto(
    Guid Id, string Key, string Name, string? LastStatus, DateTimeOffset? LastRunAt, Guid? LastExecutionId,
    double? PassRate30d, int Runs7d, int FailingNow);

public sealed record FlakyTestDto(Guid ProjectId, string ProjectKey, string Title, string? Module, int Flaky, int Runs);

public sealed record DashboardDto(
    int Projects, int Runs7d, int Active, int AgentsOnline, double? PassRate30d, int Healed30d,
    IReadOnlyList<DashboardProjectDto> ProjectHealth, IReadOnlyList<FlakyTestDto> Flaky);

/// <summary>GET /api/v1/dashboard: the organisation at a glance, limited to the projects the caller may see.</summary>
public static class DashboardEndpoints
{
    public static RouteGroupBuilder MapDashboard(this RouteGroupBuilder api)
    {
        api.MapGet("/dashboard", Get).WithTags("Reports").RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        return api;
    }

    private static async Task<IResult> Get(AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        var scope = await access.ScopeAsync(Permissions.ProjectView, ct);
        var projects = await db.Projects.AsNoTracking().OrderBy(p => p.Name).ToListAsync(ct);
        projects = projects.Where(p => scope.Includes(p.WorkspaceId)).ToList();
        var ids = projects.Select(p => p.Id).ToList();

        var since30 = DateTimeOffset.UtcNow.AddDays(-30);
        var since7 = DateTimeOffset.UtcNow.AddDays(-7);
        var runs = await db.Executions.AsNoTracking()
            .Where(e => ids.Contains(e.ProjectId) && e.ParentExecutionId == null && (e.QueuedAt >= since30 || e.FinishedAt >= since30))
            .Select(e => new { e.Id, e.ProjectId, e.Status, e.QueuedAt, e.FinishedAt, e.Counts })
            .ToListAsync(ct);
        var latestAny = await db.Executions.AsNoTracking().Where(e => ids.Contains(e.ProjectId) && e.FinishedAt != null && e.ParentExecutionId == null)
            .GroupBy(e => e.ProjectId)
            .Select(g => g.OrderByDescending(e => e.FinishedAt).Select(e => new { e.ProjectId, e.Id, e.Status, e.FinishedAt }).First())
            .ToListAsync(ct);

        static (int total, int passed, int skipped, int healed) Counts(string? json)
        {
            var c = json is null ? null : JsonNode.Parse(json) as JsonObject;
            int Get(string k) => c?[k] is JsonValue v && v.TryGetValue<int>(out var i) ? i : 0;
            return (Get("total"), Get("passed"), Get("skipped"), Get("healed"));
        }

        double? Rate(IEnumerable<string?> counts)
        {
            var (counted, passed) = (0, 0);
            foreach (var c in counts) { var x = Counts(c); counted += x.total - x.skipped; passed += x.passed; }
            return counted > 0 ? Math.Round(100.0 * passed / counted, 1) : null;
        }

        var finished30 = runs.Where(r => r.FinishedAt >= since30).ToList();
        var failingIds = latestAny.Where(l => l.Status is ExecutionStatus.Failed or ExecutionStatus.Error).Select(l => l.Id).ToList();
        // results of a sharded run sit on its shards
        var failingCounts = await (
            from r in db.Results.AsNoTracking()
            join e in db.Executions.AsNoTracking() on r.ExecutionId equals e.Id
            where failingIds.Contains(e.ParentExecutionId ?? e.Id) && (r.Status == ResultStatus.Failed || r.Status == ResultStatus.TimedOut || r.Status == ResultStatus.Interrupted)
            group r by e.ParentExecutionId ?? e.Id into g
            select new { g.Key, Count = g.Count() }).ToDictionaryAsync(g => g.Key, g => g.Count, ct);

        var health = projects.Select(p =>
        {
            var last = latestAny.FirstOrDefault(l => l.ProjectId == p.Id);
            return new DashboardProjectDto(p.Id, p.Key, p.Name, last is null ? null : ExecutionEndpoints.Snake(last.Status.ToString()), last?.FinishedAt, last?.Id,
                Rate(finished30.Where(r => r.ProjectId == p.Id).Select(r => r.Counts)),
                runs.Count(r => r.ProjectId == p.Id && r.QueuedAt >= since7),
                last is null ? 0 : failingCounts.GetValueOrDefault(last.Id));
        })
        // what needs attention first: failing projects, then the lowest pass rate
        .OrderByDescending(p => p.FailingNow).ThenBy(p => p.PassRate30d ?? 101).ThenBy(p => p.Name).ToList();

        var runIds30 = finished30.Select(r => r.Id).ToList();
        var flaky = await (
            from r in db.Results.AsNoTracking()
            join e in db.Executions.AsNoTracking() on r.ExecutionId equals e.Id
            where runIds30.Contains(e.ParentExecutionId ?? e.Id)
            group r by new { e.ProjectId, r.Title, r.Module } into g
            where g.Count(x => x.Flaky) > 0
            orderby g.Count(x => x.Flaky) descending
            select new { g.Key.ProjectId, g.Key.Title, g.Key.Module, Flaky = g.Count(x => x.Flaky), Runs = g.Count() }
        ).Take(10).ToListAsync(ct);
        var keys = projects.ToDictionary(p => p.Id, p => p.Key);

        var agentsOnline = await db.Agents.AsNoTracking().CountAsync(a => a.Status == AgentStatus.Active, ct);
        return Results.Ok(new DashboardDto(
            projects.Count,
            runs.Count(r => r.QueuedAt >= since7),
            runs.Count(r => r.Status is ExecutionStatus.Queued or ExecutionStatus.Assigned or ExecutionStatus.Running),
            agentsOnline,
            Rate(finished30.Select(r => r.Counts)),
            finished30.Sum(r => Counts(r.Counts).healed),
            health,
            flaky.Select(f => new FlakyTestDto(f.ProjectId, keys.GetValueOrDefault(f.ProjectId, "?"), f.Title, f.Module, f.Flaky, f.Runs)).ToList()));
    }
}
