using Npgsql;

namespace Atimtha.Api.Execution;

/// <summary>
/// Every minute, across organisations: a job whose agent stopped sending heartbeats is put back in the queue once,
/// then marked as an infrastructure error (never as an application failure); silent agents are marked offline.
/// Runs with the maintenance (owner, BYPASSRLS) connection; does nothing when that is not configured.
/// </summary>
public sealed class MaintenanceService(IConfiguration configuration, IEvidenceStore evidence, ILogger<MaintenanceService> logger) : BackgroundService
{
    public static readonly TimeSpan Silence = TimeSpan.FromMinutes(2);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var cs = configuration.GetConnectionString("Maintenance") ?? configuration.GetConnectionString("Migrations");
        if (string.IsNullOrWhiteSpace(cs))
        {
            logger.LogWarning("No maintenance connection string: lost jobs will not be requeued automatically.");
            return;
        }
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(1));
        do
        {
            try { await RunOnceAsync(cs, stoppingToken); }
            catch (Exception e) when (e is not OperationCanceledException) { logger.LogError(e, "Maintenance pass failed"); }
            try { await ExpireEvidenceAsync(cs, evidence, logger, stoppingToken); }
            catch (Exception e) when (e is not OperationCanceledException) { logger.LogError(e, "Evidence retention pass failed"); }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    internal static async Task RunOnceAsync(string connectionString, CancellationToken ct)
    {
        await using var conn = new NpgsqlConnection(connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = new NpgsqlCommand("""
            WITH stale AS (SELECT * FROM atimtha.stale_jobs(@silence))
            UPDATE atimtha.execution e SET
              status        = CASE WHEN s.requeue_count < 1 THEN 'queued'::atimtha.execution_status ELSE 'error'::atimtha.execution_status END,
              agent_id      = CASE WHEN s.requeue_count < 1 THEN NULL ELSE e.agent_id END,
              requeue_count = e.requeue_count + 1,
              finished_at   = CASE WHEN s.requeue_count < 1 THEN NULL ELSE now() END,
              error         = CASE WHEN s.requeue_count < 1 THEN e.error ELSE 'The agent stopped responding; the job was retried once.' END
            FROM stale s WHERE e.id = s.execution_id;

            -- runs longer than the organisation allows (organization_setting runs.maxDurationMinutes, default 360)
            UPDATE atimtha.execution e SET
              status = 'error'::atimtha.execution_status, finished_at = now(), cancel_requested = true,
              error = 'The run took longer than ' || lim.minutes || ' minutes and was stopped.'
            FROM (
              SELECT x.id, COALESCE((SELECT (s.value #>> '{}')::int FROM atimtha.organization_setting s
                                     WHERE s.organization_id = x.organization_id AND s.key = 'runs.maxDurationMinutes'), 360) AS minutes
              FROM atimtha.execution x WHERE x.status IN ('assigned', 'running')
                -- a sharded run's parent has no agent: its shards are limited one by one, and it follows them
                AND NOT (x.shard_total IS NOT NULL AND x.parent_execution_id IS NULL)
            ) lim
            WHERE e.id = lim.id AND COALESCE(e.started_at, e.queued_at) < now() - make_interval(mins => lim.minutes);

            UPDATE atimtha.execution_agent SET status = 'offline'
            WHERE status = 'active' AND (last_heartbeat_at IS NULL OR last_heartbeat_at < now() - @silence);
            """, conn);
        cmd.Parameters.AddWithValue("silence", Silence);
        await cmd.ExecuteNonQueryAsync(ct);
        // sharded runs whose shards all finished another way (a lost agent, the run time limit) are closed too
        await using var rollUp = new NpgsqlCommand(Shards.MaintenanceSql, conn);
        await rollUp.ExecuteNonQueryAsync(ct);
    }

    /// <summary>Deletes up to 500 expired evidence files per pass: the file first, then its row.</summary>
    internal static async Task ExpireEvidenceAsync(string connectionString, IEvidenceStore store, ILogger logger, CancellationToken ct)
    {
        await using var conn = new NpgsqlConnection(connectionString);
        await conn.OpenAsync(ct);
        foreach (var table in new[] { "evidence", "execution_artifact" })
            await ExpireAsync(conn, table, store, logger, ct);
    }

    private static async Task ExpireAsync(NpgsqlConnection conn, string table, IEvidenceStore store, ILogger logger, CancellationToken ct)
    {
        var expired = new List<(Guid Id, string Key)>();
        await using (var select = new NpgsqlCommand(
            $"SELECT id, object_key FROM atimtha.{table} WHERE expires_at IS NOT NULL AND expires_at < now() ORDER BY expires_at LIMIT 500", conn))
        await using (var reader = await select.ExecuteReaderAsync(ct))
        {
            while (await reader.ReadAsync(ct)) expired.Add((reader.GetGuid(0), reader.GetString(1)));
        }
        if (expired.Count == 0) return;

        var removed = new List<Guid>();
        foreach (var (id, key) in expired)
        {
            try { await store.DeleteAsync(key, ct); removed.Add(id); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException) { logger.LogWarning(e, "Could not delete evidence {EvidenceId}", id); }
        }
        await using var delete = new NpgsqlCommand($"DELETE FROM atimtha.{table} WHERE id = ANY(@ids)", conn);
        delete.Parameters.AddWithValue("ids", removed.ToArray());
        await delete.ExecuteNonQueryAsync(ct);
        logger.LogInformation("Removed {Count} expired files from {Table}", removed.Count, table);
    }
}
