using Npgsql;

namespace Atimtha.Api.Execution;

/// <summary>
/// Every minute, across organisations: a job whose agent stopped sending heartbeats is put back in the queue once,
/// then marked as an infrastructure error (never as an application failure); silent agents are marked offline.
/// Runs with the maintenance (owner, BYPASSRLS) connection; does nothing when that is not configured.
/// </summary>
public sealed class MaintenanceService(IConfiguration configuration, ILogger<MaintenanceService> logger) : BackgroundService
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

            UPDATE atimtha.execution_agent SET status = 'offline'
            WHERE status = 'active' AND (last_heartbeat_at IS NULL OR last_heartbeat_at < now() - @silence);
            """, conn);
        cmd.Parameters.AddWithValue("silence", Silence);
        await cmd.ExecuteNonQueryAsync(ct);
    }
}
