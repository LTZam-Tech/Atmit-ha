using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Npgsql;

namespace Atimtha.Api.Infrastructure;

/// <summary>
/// Platform metrics (backlog §12), kept in memory and written by hand in the Prometheus text format — no extra
/// packages. Counters live here; gauges (runs by status, queue depth, agents online, deliveries) are read from the
/// database at scrape time, across organisations, with the maintenance connection.
/// </summary>
public sealed class PlatformMetrics
{
    private static readonly double[] Buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

    private sealed class Histogram
    {
        public readonly long[] Counts = new long[Buckets.Length + 1];
        public long Count;
        public double Sum;
    }

    private readonly ConcurrentDictionary<(string Method, string Route, int Status), long> requests = new();
    private readonly ConcurrentDictionary<(string Method, string Route), Histogram> durations = new();
    private readonly ConcurrentDictionary<string, long> claims = new();
    private readonly ConcurrentDictionary<string, long> deliveries = new();

    public void Request(string method, string route, int status, double seconds)
    {
        requests.AddOrUpdate((method, route, status), 1, (_, n) => n + 1);
        var h = durations.GetOrAdd((method, route), _ => new Histogram());
        lock (h)
        {
            var i = Array.FindIndex(Buckets, b => seconds <= b);
            h.Counts[i < 0 ? Buckets.Length : i]++;
            h.Count++;
            h.Sum += seconds;
        }
    }

    /// <summary>claimed: an agent got a job; empty: nothing to do (or every slot busy)</summary>
    public void Claim(bool claimed) => claims.AddOrUpdate(claimed ? "claimed" : "empty", 1, (_, n) => n + 1);

    /// <summary>one delivery attempt of a run notification: sent or error</summary>
    public void Delivery(bool sent) => deliveries.AddOrUpdate(sent ? "sent" : "error", 1, (_, n) => n + 1);

    private static string Label(string v) => v.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n");
    private static string Num(double v) => v.ToString(CultureInfo.InvariantCulture);

    public async Task<string> RenderAsync(string? maintenanceConnection, ILogger logger, CancellationToken ct)
    {
        var sb = new StringBuilder();
        sb.Append("# HELP atimtha_http_requests_total HTTP requests by method, route and status.\n# TYPE atimtha_http_requests_total counter\n");
        foreach (var ((m, r, s), n) in requests.OrderBy(x => x.Key.Route).ThenBy(x => x.Key.Method).ThenBy(x => x.Key.Status))
            sb.Append($"atimtha_http_requests_total{{method=\"{Label(m)}\",route=\"{Label(r)}\",status=\"{s}\"}} {n}\n");

        sb.Append("# HELP atimtha_http_request_duration_seconds Time to answer HTTP requests.\n# TYPE atimtha_http_request_duration_seconds histogram\n");
        foreach (var ((m, r), h) in durations.OrderBy(x => x.Key.Route).ThenBy(x => x.Key.Method))
        {
            long[] counts; long count; double sum;
            lock (h) { counts = (long[])h.Counts.Clone(); count = h.Count; sum = h.Sum; }
            var labels = $"method=\"{Label(m)}\",route=\"{Label(r)}\"";
            long cumulative = 0;
            for (var i = 0; i < Buckets.Length; i++)
            {
                cumulative += counts[i];
                sb.Append($"atimtha_http_request_duration_seconds_bucket{{{labels},le=\"{Num(Buckets[i])}\"}} {cumulative}\n");
            }
            sb.Append($"atimtha_http_request_duration_seconds_bucket{{{labels},le=\"+Inf\"}} {count}\n");
            sb.Append($"atimtha_http_request_duration_seconds_sum{{{labels}}} {Num(sum)}\n");
            sb.Append($"atimtha_http_request_duration_seconds_count{{{labels}}} {count}\n");
        }

        sb.Append("# HELP atimtha_job_claims_total Agent claim calls: claimed a job, or found none.\n# TYPE atimtha_job_claims_total counter\n");
        foreach (var result in new[] { "claimed", "empty" }) sb.Append($"atimtha_job_claims_total{{result=\"{result}\"}} {claims.GetValueOrDefault(result)}\n");
        sb.Append("# HELP atimtha_notification_deliveries_total Run notification delivery attempts since start.\n# TYPE atimtha_notification_deliveries_total counter\n");
        foreach (var result in new[] { "sent", "error" }) sb.Append($"atimtha_notification_deliveries_total{{result=\"{result}\"}} {deliveries.GetValueOrDefault(result)}\n");

        if (!string.IsNullOrWhiteSpace(maintenanceConnection))
        {
            try { await GaugesAsync(sb, maintenanceConnection, ct); }
            catch (Exception e) when (e is NpgsqlException or InvalidOperationException)
            {
                logger.LogWarning(e, "Metrics: database gauges not read");
                sb.Append("# HELP atimtha_metrics_database_up 1 when the database gauges could be read.\n# TYPE atimtha_metrics_database_up gauge\natimtha_metrics_database_up 0\n");
                return sb.ToString();
            }
            sb.Append("# HELP atimtha_metrics_database_up 1 when the database gauges could be read.\n# TYPE atimtha_metrics_database_up gauge\natimtha_metrics_database_up 1\n");
        }
        return sb.ToString();
    }

    private static async Task GaugesAsync(StringBuilder sb, string cs, CancellationToken ct)
    {
        await using var conn = new NpgsqlConnection(cs);
        await conn.OpenAsync(ct);

        async Task Rows(string sql, Action<NpgsqlDataReader> each)
        {
            await using var cmd = new NpgsqlCommand(sql, conn);
            await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct)) each(r);
        }

        // a sharded run counts once (its parent); queue depth counts the jobs agents can claim (its shards)
        sb.Append("# HELP atimtha_runs Runs by status (a sharded run counts once).\n# TYPE atimtha_runs gauge\n");
        await Rows("SELECT status::text, count(*) FROM atimtha.execution WHERE parent_execution_id IS NULL GROUP BY status ORDER BY 1",
            r => sb.Append($"atimtha_runs{{status=\"{Label(r.GetString(0))}\"}} {r.GetInt64(1)}\n"));
        sb.Append("# HELP atimtha_queue_depth Jobs waiting for an agent.\n# TYPE atimtha_queue_depth gauge\n");
        await Rows("""
            SELECT engine::text, count(*) FROM atimtha.execution
            WHERE status = 'queued' AND NOT cancel_requested AND NOT (shard_total IS NOT NULL AND parent_execution_id IS NULL)
            GROUP BY engine ORDER BY 1
            """, r => sb.Append($"atimtha_queue_depth{{engine=\"{Label(r.GetString(0))}\"}} {r.GetInt64(1)}\n"));
        sb.Append("# HELP atimtha_agents Agents by status (active = sent a heartbeat recently).\n# TYPE atimtha_agents gauge\n");
        await Rows("SELECT status::text, count(*) FROM atimtha.execution_agent GROUP BY status ORDER BY 1",
            r => sb.Append($"atimtha_agents{{status=\"{Label(r.GetString(0))}\"}} {r.GetInt64(1)}\n"));
        sb.Append("# HELP atimtha_notification_deliveries Run notifications by delivery status.\n# TYPE atimtha_notification_deliveries gauge\n");
        await Rows("SELECT status::text, count(*) FROM atimtha.notification_delivery GROUP BY status ORDER BY 1",
            r => sb.Append($"atimtha_notification_deliveries{{status=\"{Label(r.GetString(0))}\"}} {r.GetInt64(1)}\n"));
    }
}

public static class MetricsEndpoint
{
    /// <summary>times every request by its route template (never the raw path, so ids do not explode the series)</summary>
    public static IApplicationBuilder UsePlatformMetrics(this IApplicationBuilder app)
    {
        var metrics = app.ApplicationServices.GetRequiredService<PlatformMetrics>();
        return app.Use(async (ctx, next) =>
        {
            if (ctx.Request.Path.StartsWithSegments("/metrics")) { await next(ctx); return; }
            var started = Stopwatch.GetTimestamp();
            try { await next(ctx); }
            finally
            {
                var route = (ctx.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText ?? "unmatched";
                metrics.Request(ctx.Request.Method, route.Length > 200 ? route[..200] : route, ctx.Response.StatusCode, Stopwatch.GetElapsedTime(started).TotalSeconds);
            }
        });
    }

    /// <summary>GET /metrics: with <c>Authorization: Bearer &lt;Metrics:Token&gt;</c>, or from this machine (loopback)</summary>
    public static void MapPlatformMetrics(this IEndpointRouteBuilder app)
    {
        app.MapGet("/metrics", async (HttpContext ctx, PlatformMetrics metrics, IConfiguration configuration, ILogger<PlatformMetrics> logger, CancellationToken ct) =>
        {
            var token = configuration["Metrics:Token"];
            var header = ctx.Request.Headers.Authorization.ToString();
            var bearer = header.StartsWith("Bearer ", StringComparison.Ordinal) ? header[7..].Trim() : null;
            var tokenOk = !string.IsNullOrEmpty(token) && bearer is not null
                && CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(bearer), Encoding.UTF8.GetBytes(token));
            var local = ctx.Connection.RemoteIpAddress is { } ip && System.Net.IPAddress.IsLoopback(ip);
            if (!tokenOk && !local) return Results.StatusCode(StatusCodes.Status404NotFound);
            var text = await metrics.RenderAsync(configuration.GetConnectionString("Maintenance") ?? configuration.GetConnectionString("Migrations"), logger, ct);
            return Results.Text(text, "text/plain; version=0.0.4; charset=utf-8");
        }).AllowAnonymous().ExcludeFromDescription();
    }
}
