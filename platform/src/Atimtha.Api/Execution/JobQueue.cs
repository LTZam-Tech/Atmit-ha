using Atimtha.Api.Infrastructure;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.Execution;

/// <summary>Where queued executions wait for an agent (ADR-0015). Swappable for a message broker.</summary>
public interface IJobQueue
{
    /// <summary>
    /// Atomically assigns the oldest queued job this agent can run; null when there is none, or when the agent already
    /// holds <paramref name="slots"/> assigned or running jobs.
    /// </summary>
    Task<Guid?> ClaimAsync(Guid agentId, IReadOnlyCollection<string> engines, int slots, CancellationToken ct);
}

/// <summary>
/// PostgreSQL queue: <c>FOR UPDATE SKIP LOCKED</c> lets many agents claim concurrently without taking the same job.
/// Row-level security limits the agent to its own organisation's jobs.
/// </summary>
public sealed class PostgresJobQueue(AtimthaDbContext db) : IJobQueue
{
    public async Task<Guid?> ClaimAsync(Guid agentId, IReadOnlyCollection<string> engines, int slots, CancellationToken ct)
    {
        if (engines.Count == 0) return null;
        var engineArray = engines.ToArray();
        var ids = await db.Database.SqlQuery<Guid>($"""
            UPDATE atimtha.execution SET status = 'assigned', agent_id = {agentId}
            WHERE id = (
              SELECT id FROM atimtha.execution
              WHERE status = 'queued' AND NOT cancel_requested AND engine::text = ANY({engineArray})
                -- the parent of a sharded run holds no job: only its shards are claimed
                AND NOT (shard_total IS NOT NULL AND parent_execution_id IS NULL)
                AND (SELECT count(*) FROM atimtha.execution busy
                     WHERE busy.agent_id = {agentId} AND busy.status IN ('assigned', 'running')) < {slots}
              ORDER BY queued_at
              FOR UPDATE SKIP LOCKED
              LIMIT 1)
            RETURNING id AS "Value"
            """).ToListAsync(ct);
        return ids.Count == 1 ? ids[0] : null;
    }
}
