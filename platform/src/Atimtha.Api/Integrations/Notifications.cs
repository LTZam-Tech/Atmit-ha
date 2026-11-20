using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Atimtha.Api.Identity;
using Atimtha.Api.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Atimtha.Api.Integrations;

using Api = Atimtha.Api.Infrastructure.Api;

public enum NotificationKind { Webhook, Slack, Teams }
public enum DeliveryStatus { Pending, Sent, Failed }

public sealed class NotificationChannel
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public Guid? ProjectId { get; set; }
    public string Name { get; set; } = "";
    public NotificationKind Kind { get; set; }
    public string TargetSecretRef { get; set; } = "";
    public string? SigningSecretRef { get; set; }
    public string[] Events { get; set; } = ["run.failed"];
    public bool Enabled { get; set; } = true;
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

public sealed class NotificationDelivery
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public Guid ChannelId { get; set; }
    public Guid ExecutionId { get; set; }
    public string Event { get; set; } = "";
    public DeliveryStatus Status { get; set; }
    public short Attempts { get; set; }
    public DateTimeOffset NextAttemptAt { get; set; }
    public string? LastError { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? SentAt { get; set; }
}

public sealed record ChannelDto(Guid Id, string Name, string Kind, Guid? ProjectId, string[] Events, bool HasSigningSecret, bool Enabled, DateTimeOffset UpdatedAt);
public sealed record SaveChannelRequest(string? Name, string? Kind, Guid? ProjectId, string? TargetSecretRef, string? SigningSecretRef, string[]? Events, bool? Enabled);
public sealed record DeliveryDto(Guid Id, Guid ExecutionId, string Event, string Status, int Attempts, string? LastError, DateTimeOffset CreatedAt, DateTimeOffset? SentAt);

/// <summary>What a message says about a finished run; the same for real deliveries and for "send a test".</summary>
public sealed record RunNotice(string Event, Guid ExecutionId, string Status, string ProjectKey, string ProjectName, string Environment,
    JsonObject? Counts, string? Error, DateTimeOffset? FinishedAt, string? RunUrl);

/// <summary>Builds and sends one message. Redirects are not followed: a webhook answers where it was configured.</summary>
public sealed class NotificationSender(IHttpClientFactory factory, SecretResolver secrets)
{
    public const string Client = "notifications";

    public async Task SendAsync(NotificationKind kind, string targetRef, string? signingRef, RunNotice notice, CancellationToken ct)
    {
        var target = secrets.Resolve(targetRef) ?? throw new InvalidOperationException("The webhook address reference does not resolve on the platform.");
        if (!Uri.TryCreate(target, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps)
            throw new InvalidOperationException("The webhook address must be an https:// address.");

        var body = (kind switch
        {
            NotificationKind.Slack => new JsonObject { ["text"] = Text(notice, slack: true) },
            NotificationKind.Teams => new JsonObject { ["text"] = Text(notice, slack: false) },
            _ => Payload(notice),
        }).ToJsonString();

        using var req = new HttpRequestMessage(HttpMethod.Post, uri) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        if (kind == NotificationKind.Webhook)
        {
            req.Headers.Add("X-Atimtha-Event", notice.Event);
            req.Headers.Add("X-Atimtha-Delivery", notice.ExecutionId.ToString());
            if (secrets.Resolve(signingRef) is { Length: > 0 } key)
                req.Headers.Add("X-Atimtha-Signature", "sha256=" + Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(key), Encoding.UTF8.GetBytes(body))));
        }
        using var res = await factory.CreateClient(Client).SendAsync(req, ct);
        if (!res.IsSuccessStatusCode) throw new HttpRequestException($"The receiver answered HTTP {(int)res.StatusCode}.");
    }

    private static JsonObject Payload(RunNotice n) => new()
    {
        ["event"] = n.Event,
        ["project"] = new JsonObject { ["key"] = n.ProjectKey, ["name"] = n.ProjectName },
        ["execution"] = new JsonObject
        {
            ["id"] = n.ExecutionId.ToString(), ["status"] = n.Status, ["environment"] = n.Environment,
            ["counts"] = n.Counts?.DeepClone(), ["error"] = n.Error, ["finishedAt"] = n.FinishedAt?.ToString("O"), ["url"] = n.RunUrl,
        },
    };

    private static string Text(RunNotice n, bool slack)
    {
        int C(string k) => n.Counts?[k] is JsonValue v && v.TryGetValue<int>(out var i) ? i : 0;
        var icon = n.Status == "passed" ? "✅" : n.Status == "cancelled" ? "⏹️" : "❌";
        var title = $"{icon} {n.ProjectName} · {n.Environment}: run {n.Status}";
        var counts = $"{C("passed")}/{C("total")} passed, {C("failed")} failed, {C("flaky")} flaky, {C("healed")} healed";
        var link = n.RunUrl is null ? "" : slack ? $"\n<{n.RunUrl}|Open the run>" : $"\n[Open the run]({n.RunUrl})";
        var error = string.IsNullOrWhiteSpace(n.Error) ? "" : "\n" + (n.Error.Length > 300 ? n.Error[..300] + "…" : n.Error);
        return $"{title}\n{counts}{error}{link}";
    }
}

/// <summary>/api/v1/notification-channels: where finished runs are announced (integration.manage).</summary>
public static class NotificationEndpoints
{
    public static readonly string[] Events = ["run.failed", "run.passed", "run.finished"];

    public static RouteGroupBuilder MapNotifications(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/notification-channels").WithTags("Notifications").RequireAuthorization(Permissions.Policy(Permissions.IntegrationManage));
        g.MapGet("/", List);
        g.MapPost("/", Create);
        g.MapPut("/{id:guid}", Update);
        g.MapDelete("/{id:guid}", Delete);
        g.MapPost("/{id:guid}/test", Test);
        g.MapGet("/{id:guid}/deliveries", Deliveries);
        return api;
    }

    private static async Task<IResult> List(AtimthaDbContext db, CancellationToken ct) =>
        Results.Ok((await db.NotificationChannels.AsNoTracking().OrderBy(c => c.Name).ToListAsync(ct)).Select(ToDto));

    private static async Task<IResult> Create(SaveChannelRequest body, AtimthaDbContext db, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        if (tenant.OrganizationId is not Guid org) return Api.Forbidden("Choose an organisation first.");
        var c = new NotificationChannel { Id = Guid.NewGuid(), OrganizationId = org, CreatedAt = DateTimeOffset.UtcNow };
        if (await ApplyAsync(c, body, creating: true, db, ct) is { } problem) return problem;
        db.NotificationChannels.Add(c);
        audit.Add("notification_channel.create", "notification_channel", c.Id, new { c.Name, kind = c.Kind.ToString().ToLowerInvariant(), c.Events, c.Enabled });
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException e) when (Api.IsUniqueViolation(e)) { return Api.Conflict($"A channel named \"{c.Name}\" already exists."); }
        return Results.Created($"/api/v1/notification-channels/{c.Id}", ToDto(c));
    }

    private static async Task<IResult> Update(Guid id, SaveChannelRequest body, AtimthaDbContext db, AuditWriter audit, CancellationToken ct)
    {
        var c = await db.NotificationChannels.FirstOrDefaultAsync(x => x.Id == id, ct);
        if (c is null) return Api.NotFound("The channel");
        if (await ApplyAsync(c, body, creating: false, db, ct) is { } problem) return problem;
        audit.Add("notification_channel.update", "notification_channel", c.Id, new { c.Name, c.Events, c.Enabled });
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException e) when (Api.IsUniqueViolation(e)) { return Api.Conflict($"A channel named \"{c.Name}\" already exists."); }
        return Results.Ok(ToDto(c));
    }

    private static async Task<IResult> Delete(Guid id, AtimthaDbContext db, AuditWriter audit, CancellationToken ct)
    {
        var c = await db.NotificationChannels.FirstOrDefaultAsync(x => x.Id == id, ct);
        if (c is null) return Api.NotFound("The channel");
        db.NotificationChannels.Remove(c);
        audit.Add("notification_channel.delete", "notification_channel", c.Id, new { c.Name });
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    /// <summary>Sends a sample "run failed" message now, without recording a delivery.</summary>
    private static async Task<IResult> Test(Guid id, AtimthaDbContext db, NotificationSender sender, IConfiguration configuration, CancellationToken ct)
    {
        var c = await db.NotificationChannels.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id, ct);
        if (c is null) return Api.NotFound("The channel");
        var notice = new RunNotice("run.failed", Guid.Empty, "failed", "sample", "Sample project", "staging",
            new JsonObject { ["total"] = 12, ["passed"] = 10, ["failed"] = 2, ["flaky"] = 1, ["healed"] = 1 },
            "This is a test message from Atimtha.", DateTimeOffset.UtcNow, configuration["Platform:PublicUrl"]);
        try
        {
            await sender.SendAsync(c.Kind, c.TargetSecretRef, c.SigningSecretRef, notice, ct);
            return Results.Ok(new { ok = true, error = (string?)null });
        }
        catch (Exception e) when (e is HttpRequestException or InvalidOperationException or TaskCanceledException)
        {
            return Results.Ok(new { ok = false, error = (string?)e.Message });
        }
    }

    private static async Task<IResult> Deliveries(Guid id, AtimthaDbContext db, CancellationToken ct)
    {
        var rows = await db.NotificationDeliveries.AsNoTracking().Where(d => d.ChannelId == id).OrderByDescending(d => d.CreatedAt).Take(50).ToListAsync(ct);
        return Results.Ok(rows.Select(d => new DeliveryDto(d.Id, d.ExecutionId, d.Event, d.Status.ToString().ToLowerInvariant(), d.Attempts, d.LastError, d.CreatedAt, d.SentAt)));
    }

    private static async Task<IResult?> ApplyAsync(NotificationChannel c, SaveChannelRequest body, bool creating, AtimthaDbContext db, CancellationToken ct)
    {
        NotificationKind? kind = body.Kind switch { "webhook" => NotificationKind.Webhook, "slack" => NotificationKind.Slack, "teams" => NotificationKind.Teams, null => null, _ => null };
        var events = body.Events?.Distinct().ToArray();
        var v = new Api.Validation()
            .Text(body.Name, "name", 100, required: creating)
            .Require(!creating || kind is not null, "kind", "Use webhook, slack or teams.")
            .Require(body.Kind is null || kind is not null, "kind", "Use webhook, slack or teams.")
            .Require(!creating || body.TargetSecretRef is not null, "targetSecretRef", "Required.")
            .Require(body.TargetSecretRef is null || SecretResolver.IsReference(body.TargetSecretRef), "targetSecretRef",
                "Send a secrets-manager reference (vault:env/NAME or vault:file/name): a webhook address works like a password.")
            .Require(body.SigningSecretRef is null or "" || SecretResolver.IsReference(body.SigningSecretRef), "signingSecretRef", "Send a secrets-manager reference.")
            .Require(events is null || (events.Length > 0 && events.All(Events.Contains)), "events", "Use run.failed, run.passed or run.finished.");
        if (body.ProjectId is Guid pid) v.Require(await db.Projects.AnyAsync(p => p.Id == pid, ct), "projectId", "Unknown project.");
        if (!v.IsValid) return v.Problem();

        if (body.Name is not null) c.Name = body.Name.Trim();
        if (kind is not null) c.Kind = kind.Value;
        if (creating || body.ProjectId is not null) c.ProjectId = body.ProjectId;
        if (body.TargetSecretRef is not null) c.TargetSecretRef = body.TargetSecretRef;
        if (body.SigningSecretRef is not null) c.SigningSecretRef = body.SigningSecretRef.Length == 0 ? null : body.SigningSecretRef;
        if (events is not null) c.Events = events;
        if (body.Enabled is bool enabled) c.Enabled = enabled;
        c.UpdatedAt = DateTimeOffset.UtcNow;
        return null;
    }

    private static ChannelDto ToDto(NotificationChannel c) =>
        new(c.Id, c.Name, c.Kind.ToString().ToLowerInvariant(), c.ProjectId, c.Events, c.SigningSecretRef is not null, c.Enabled, c.UpdatedAt);
}

/// <summary>
/// Every 15 seconds (maintenance connection): adds a delivery for each finished run and each channel that wants it
/// (one message per run and channel, the most specific event), then sends due deliveries. A failure is retried after
/// 1, 2, 4 and 8 minutes, then marked failed. Deliveries are claimed first, so two instances never send the same one.
/// </summary>
public sealed class NotificationService(IConfiguration configuration, NotificationSender sender, PlatformMetrics metrics, ILogger<NotificationService> logger) : BackgroundService
{
    private const int MaxAttempts = 5;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var cs = configuration.GetConnectionString("Maintenance") ?? configuration.GetConnectionString("Migrations");
        if (string.IsNullOrWhiteSpace(cs))
        {
            logger.LogWarning("No maintenance connection string: run notifications will not be sent.");
            return;
        }
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(15));
        do
        {
            try { await RunOnceAsync(cs, stoppingToken); }
            catch (Exception e) when (e is not OperationCanceledException) { logger.LogError(e, "Notification pass failed"); }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    private async Task RunOnceAsync(string cs, CancellationToken ct)
    {
        await using var conn = new NpgsqlConnection(cs);
        await conn.OpenAsync(ct);

        await using (var enqueue = new NpgsqlCommand("""
            INSERT INTO atimtha.notification_delivery (organization_id, channel_id, execution_id, event)
            SELECT organization_id, channel_id, execution_id, event FROM (
              SELECT e.organization_id, c.id AS channel_id, e.id AS execution_id,
                     CASE WHEN e.status = 'passed' AND 'run.passed' = ANY(c.events) THEN 'run.passed'
                          WHEN e.status IN ('failed', 'error') AND 'run.failed' = ANY(c.events) THEN 'run.failed'
                          WHEN 'run.finished' = ANY(c.events) THEN 'run.finished' END AS event
              FROM atimtha.execution e
              JOIN atimtha.notification_channel c ON c.organization_id = e.organization_id AND c.enabled
                   AND (c.project_id IS NULL OR c.project_id = e.project_id) AND c.created_at <= e.finished_at
              WHERE e.finished_at > now() - interval '1 day' AND e.status IN ('passed', 'failed', 'error', 'cancelled')
                AND e.parent_execution_id IS NULL  -- a sharded run notifies once, for the whole run
                AND NOT EXISTS (SELECT 1 FROM atimtha.organization o WHERE o.id = e.organization_id AND o.archived_at IS NOT NULL)
            ) x WHERE event IS NOT NULL
            ON CONFLICT (channel_id, execution_id, event) DO NOTHING
            """, conn))
            await enqueue.ExecuteNonQueryAsync(ct);

        var due = new List<(Guid Id, short Attempts, NotificationKind Kind, string Target, string? Signing, RunNotice Notice)>();
        var publicUrl = configuration["Platform:PublicUrl"]?.TrimEnd('/');
        await using (var claim = new NpgsqlCommand("""
            WITH claimed AS (
              UPDATE atimtha.notification_delivery SET next_attempt_at = now() + interval '5 minutes'
              WHERE id IN (SELECT id FROM atimtha.notification_delivery WHERE status = 'pending' AND next_attempt_at <= now()
                           ORDER BY next_attempt_at LIMIT 50 FOR UPDATE SKIP LOCKED)
              RETURNING id, attempts, channel_id, execution_id, event)
            SELECT d.id, d.attempts, c.kind::text, c.target_secret_ref, c.signing_secret_ref, d.event,
                   e.id, e.status::text, p.key, p.name, env.key, e.counts::text, e.error, e.finished_at
            FROM claimed d
            JOIN atimtha.notification_channel c ON c.id = d.channel_id
            JOIN atimtha.execution e ON e.id = d.execution_id
            JOIN atimtha.project p ON p.id = e.project_id
            JOIN atimtha.environment env ON env.id = e.environment_id
            """, conn))
        await using (var r = await claim.ExecuteReaderAsync(ct))
        {
            while (await r.ReadAsync(ct))
            {
                var kind = r.GetString(2) switch { "slack" => NotificationKind.Slack, "teams" => NotificationKind.Teams, _ => NotificationKind.Webhook };
                var executionId = r.GetGuid(6);
                var counts = r.IsDBNull(11) ? null : JsonNode.Parse(r.GetString(11)) as JsonObject;
                var notice = new RunNotice(r.GetString(5), executionId, r.GetString(7), r.GetString(8), r.GetString(9), r.GetString(10), counts,
                    r.IsDBNull(12) ? null : r.GetString(12), r.IsDBNull(13) ? null : r.GetFieldValue<DateTimeOffset>(13),
                    publicUrl is { Length: > 0 } ? $"{publicUrl}/runs/{executionId}" : null);
                due.Add((r.GetGuid(0), r.GetInt16(1), kind, r.GetString(3), r.IsDBNull(4) ? null : r.GetString(4), notice));
            }
        }

        foreach (var d in due)
        {
            string? error = null;
            try { await sender.SendAsync(d.Kind, d.Target, d.Signing, d.Notice, ct); }
            catch (Exception e) when (e is HttpRequestException or InvalidOperationException or TaskCanceledException && !ct.IsCancellationRequested)
            {
                error = e.Message.Length > 1000 ? e.Message[..1000] : e.Message;
            }
            metrics.Delivery(error is null);
            var attempts = (short)(d.Attempts + 1);
            await using var update = new NpgsqlCommand("""
                UPDATE atimtha.notification_delivery SET
                  attempts = @attempts, last_error = @error,
                  status = CASE WHEN @error IS NULL THEN 'sent'::atimtha.delivery_status
                                WHEN @attempts >= @max THEN 'failed'::atimtha.delivery_status ELSE 'pending'::atimtha.delivery_status END,
                  sent_at = CASE WHEN @error IS NULL THEN now() END,
                  next_attempt_at = now() + make_interval(mins => power(2, @attempts - 1)::int)
                WHERE id = @id
                """, conn);
            update.Parameters.AddWithValue("id", d.Id);
            update.Parameters.AddWithValue("attempts", attempts);
            update.Parameters.AddWithValue("max", (short)MaxAttempts);
            update.Parameters.Add(new NpgsqlParameter("error", NpgsqlTypes.NpgsqlDbType.Text) { Value = (object?)error ?? DBNull.Value });
            await update.ExecuteNonQueryAsync(ct);
            if (error is not null) logger.LogWarning("Notification {DeliveryId} failed (attempt {Attempt}): {Error}", d.Id, attempts, error);
        }
    }
}
