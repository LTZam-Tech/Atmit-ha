using System.Text.Json;
using Atimtha.Api.Identity;
using Atimtha.Api.Infrastructure;
using Atimtha.Api.TestAssets;
using Atimtha.Api.Workspaces;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Atimtha.Api.Execution;

using Api = Atimtha.Api.Infrastructure.Api;

public sealed class RunSchedule
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public string Name { get; set; } = "";
    public string Cron { get; set; } = "";
    public string TimeZone { get; set; } = "Asia/Riyadh";
    public Guid EnvironmentId { get; set; }
    public EngineKind Engine { get; set; } = EngineKind.Web;
    public string Selection { get; set; } = "{}";
    public HealingPolicy? Healing { get; set; }
    /// <summary>runs split into this many shards (db/migrations/0011), or one run</summary>
    public short? Shards { get; set; }
    public bool Enabled { get; set; } = true;
    public DateTimeOffset? NextRunAt { get; set; }
    public DateTimeOffset? LastRunAt { get; set; }
    public Guid? LastExecutionId { get; set; }
    public Guid? CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

public sealed record ScheduleDto(
    Guid Id, string Name, string Cron, string TimeZone, string Environment, string Engine, SelectionDto Selection, string? Healing,
    bool Enabled, DateTimeOffset? NextRunAt, DateTimeOffset? LastRunAt, Guid? LastExecutionId, DateTimeOffset UpdatedAt, int? Shards = null);

public sealed record SaveScheduleRequest(string? Name, string? Cron, string? TimeZone, string? Environment, string? Engine, SelectionDto? Selection, string? Healing, bool? Enabled,
    short? Shards = null);

/// <summary>/api/v1/projects/{id}/schedules and /api/v1/schedules/{id}: runs that start on a cron schedule.</summary>
public static class ScheduleEndpoints
{
    public static RouteGroupBuilder MapSchedules(this RouteGroupBuilder api)
    {
        api.MapGet("/projects/{projectId:guid}/schedules", List).WithTags("Schedules").RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        api.MapPost("/projects/{projectId:guid}/schedules", Create).WithTags("Schedules").RequireAuthorization(Permissions.Policy(Permissions.ExecutionRun));
        api.MapPut("/schedules/{id:guid}", Update).WithTags("Schedules").RequireAuthorization(Permissions.Policy(Permissions.ExecutionRun));
        api.MapDelete("/schedules/{id:guid}", Delete).WithTags("Schedules").RequireAuthorization(Permissions.Policy(Permissions.ExecutionRun));
        api.MapPost("/schedules/preview", Preview).WithTags("Schedules").RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        return api;
    }

    private static async Task<IResult> List(Guid projectId, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        if (await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct) is null) return Api.NotFound("The project");
        var rows = await db.Schedules.AsNoTracking().Where(s => s.ProjectId == projectId).OrderBy(s => s.Name).ToListAsync(ct);
        var envKeys = await db.Environments.AsNoTracking().Where(e => e.ProjectId == projectId).ToDictionaryAsync(e => e.Id, e => e.Key, ct);
        return Results.Ok(rows.Select(s => ToDto(s, envKeys.GetValueOrDefault(s.EnvironmentId, "?"))));
    }

    private static async Task<IResult> Create(Guid projectId, SaveScheduleRequest body, AtimthaDbContext db, AccessService access, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        var project = await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct);
        if (project is null) return Api.NotFound("The project");
        if (!await access.HasInWorkspaceAsync(Permissions.ExecutionRun, project.WorkspaceId, ct)) return Api.Forbidden("You cannot run tests in this project.");

        var now = DateTimeOffset.UtcNow;
        var s = new RunSchedule { Id = Guid.NewGuid(), OrganizationId = project.OrganizationId, ProjectId = projectId, CreatedBy = tenant.UserId, CreatedAt = now };
        var problem = await ApplyAsync(s, body, creating: true, db, ct);
        if (problem is not null) return problem;
        s.UpdatedAt = now;
        db.Schedules.Add(s);
        audit.Add("schedule.create", "run_schedule", s.Id, new { project = project.Key, s.Name, s.Cron, s.TimeZone, s.Enabled });
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException e) when (Api.IsUniqueViolation(e)) { return Api.Conflict($"A schedule named \"{s.Name}\" already exists."); }
        return Results.Created($"/api/v1/schedules/{s.Id}", await DtoAsync(s, db, ct));
    }

    private static async Task<IResult> Update(Guid id, SaveScheduleRequest body, HttpRequest request, AtimthaDbContext db, AccessService access, AuditWriter audit, CancellationToken ct)
    {
        var s = await db.Schedules.FirstOrDefaultAsync(x => x.Id == id, ct);
        if (s is null) return Api.NotFound("The schedule");
        var project = await ProjectEndpoints.Visible(s.ProjectId, Permissions.ProjectView, db, access, ct);
        if (project is null) return Api.NotFound("The schedule");
        if (!await access.HasInWorkspaceAsync(Permissions.ExecutionRun, project.WorkspaceId, ct)) return Api.Forbidden("You cannot run tests in this project.");
        if (!Api.IfMatch(request, s.UpdatedAt)) return Results.StatusCode(StatusCodes.Status412PreconditionFailed);

        var problem = await ApplyAsync(s, body, creating: false, db, ct);
        if (problem is not null) return problem;
        s.UpdatedAt = DateTimeOffset.UtcNow;
        audit.Add("schedule.update", "run_schedule", s.Id, new { project = project.Key, s.Name, s.Cron, s.TimeZone, s.Enabled });
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException e) when (Api.IsUniqueViolation(e)) { return Api.Conflict($"A schedule named \"{s.Name}\" already exists."); }
        request.HttpContext.Response.Headers.ETag = Api.ETag(s.UpdatedAt);
        return Results.Ok(await DtoAsync(s, db, ct));
    }

    private static async Task<IResult> Delete(Guid id, AtimthaDbContext db, AccessService access, AuditWriter audit, CancellationToken ct)
    {
        var s = await db.Schedules.FirstOrDefaultAsync(x => x.Id == id, ct);
        if (s is null) return Api.NotFound("The schedule");
        var project = await ProjectEndpoints.Visible(s.ProjectId, Permissions.ProjectView, db, access, ct);
        if (project is null) return Api.NotFound("The schedule");
        if (!await access.HasInWorkspaceAsync(Permissions.ExecutionRun, project.WorkspaceId, ct)) return Api.Forbidden("You cannot run tests in this project.");
        db.Schedules.Remove(s);
        audit.Add("schedule.delete", "run_schedule", s.Id, new { project = project.Key, s.Name });
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    public sealed record PreviewRequest(string? Cron, string? TimeZone);

    /// <summary>The next five start times, for the schedule editor.</summary>
    private static IResult Preview(PreviewRequest body)
    {
        if (!Execution.Cron.TryParse(body.Cron, out var cron, out var error)) return Results.ValidationProblem(new Dictionary<string, string[]> { ["cron"] = [error!] });
        if (Zone(body.TimeZone ?? "Asia/Riyadh") is not { } zone) return Results.ValidationProblem(new Dictionary<string, string[]> { ["timeZone"] = ["Unknown time zone."] });
        var list = new List<DateTimeOffset>();
        var at = DateTimeOffset.UtcNow;
        for (var i = 0; i < 5 && cron!.Next(at, zone) is { } next; i++) { list.Add(next); at = next; }
        return Results.Ok(list);
    }

    private static async Task<IResult?> ApplyAsync(RunSchedule s, SaveScheduleRequest body, bool creating, AtimthaDbContext db, CancellationToken ct)
    {
        var v = new Api.Validation().Text(body.Name, "name", 100, required: creating);
        Cron? cron = null;
        string? cronError = null;
        var cronText = body.Cron ?? (creating ? null : s.Cron);
        v.Require(Execution.Cron.TryParse(cronText, out cron, out cronError), "cron", cronError ?? "Required.");
        var zoneId = body.TimeZone ?? s.TimeZone;
        var zone = Zone(zoneId);
        v.Require(zone is not null, "timeZone", "Unknown time zone, e.g. Asia/Riyadh.");
        var engine = (body.Engine ?? (creating ? "web" : s.Engine.ToString())).ToLowerInvariant();
        v.Require(Engines.IsKnown(engine), "engine", "Use web, api, mobile or performance.");
        HealingPolicy? healing = body.Healing is null or "" ? (body.Healing == "" ? null : s.Healing) : ProjectEndpoints.ParseHealing(body.Healing);
        v.Require(body.Healing is null or "" || healing is not null, "healing", "Use pass, flag or off.");
        // 0 or 1 = not sharded
        v.Require(body.Shards is null or 0 or 1 or (>= Shards.Min and <= Shards.Max), "shards", $"{Shards.Min} to {Shards.Max} shards, or 1.");
        if (!v.IsValid) return v.Problem();

        if (body.Environment is not null || creating)
        {
            var env = body.Environment is null
                ? await db.Environments.AsNoTracking().FirstOrDefaultAsync(x => x.ProjectId == s.ProjectId && x.IsDefault, ct)
                : await db.Environments.AsNoTracking().FirstOrDefaultAsync(x => x.ProjectId == s.ProjectId && x.Key == body.Environment, ct);
            if (env is null) return Api.NotFound("The environment");
            s.EnvironmentId = env.Id;
        }
        if (body.Name is not null) s.Name = body.Name.Trim();
        s.Cron = string.Join(' ', cronText!.Split(' ', StringSplitOptions.RemoveEmptyEntries));
        s.TimeZone = zoneId;
        s.Engine = Engines.Parse(engine);
        if (body.Selection is not null || creating) s.Selection = JsonSerializer.Serialize(body.Selection ?? new SelectionDto(null, null, null, null, null), Json);
        s.Healing = healing;
        if (body.Shards is { } shards) s.Shards = shards >= Shards.Min ? shards : null;
        if (body.Enabled is bool enabled) s.Enabled = enabled;
        s.NextRunAt = s.Enabled ? cron!.Next(DateTimeOffset.UtcNow, zone!) : null;
        return null;
    }

    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    internal static TimeZoneInfo? Zone(string id)
    {
        try { return TimeZoneInfo.FindSystemTimeZoneById(id); }
        catch (Exception e) when (e is TimeZoneNotFoundException or InvalidTimeZoneException) { return null; }
    }

    private static async Task<ScheduleDto> DtoAsync(RunSchedule s, AtimthaDbContext db, CancellationToken ct) =>
        ToDto(s, await db.Environments.AsNoTracking().Where(e => e.Id == s.EnvironmentId).Select(e => e.Key).FirstOrDefaultAsync(ct) ?? "?");

    private static ScheduleDto ToDto(RunSchedule s, string envKey) => new(
        s.Id, s.Name, s.Cron, s.TimeZone, envKey, s.Engine.ToString().ToLowerInvariant(),
        JsonSerializer.Deserialize<SelectionDto>(s.Selection, Json) ?? new SelectionDto(null, null, null, null, null),
        s.Healing?.ToString().ToLowerInvariant(), s.Enabled, s.NextRunAt, s.LastRunAt, s.LastExecutionId, s.UpdatedAt, s.Shards);
}

/// <summary>
/// Every 30 seconds: finds due schedules across organisations (maintenance connection), then starts each run inside
/// that organisation's tenant context, so row-level security applies to everything the run reads and writes.
/// A schedule is claimed by moving next_run_at forward first, so two platform instances never start the same run twice.
/// </summary>
public sealed class SchedulerService(IServiceScopeFactory scopes, IConfiguration configuration, ILogger<SchedulerService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var cs = configuration.GetConnectionString("Maintenance") ?? configuration.GetConnectionString("Migrations");
        if (string.IsNullOrWhiteSpace(cs))
        {
            logger.LogWarning("No maintenance connection string: scheduled runs will not start.");
            return;
        }
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(30));
        do
        {
            try { await RunOnceAsync(cs, stoppingToken); }
            catch (Exception e) when (e is not OperationCanceledException) { logger.LogError(e, "Scheduler pass failed"); }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    private async Task RunOnceAsync(string cs, CancellationToken ct)
    {
        var due = new List<(Guid Id, Guid Org, string OrgKey)>();
        await using (var conn = new NpgsqlConnection(cs))
        {
            await conn.OpenAsync(ct);
            await using var cmd = new NpgsqlCommand("""
                SELECT s.id, s.organization_id, o.key FROM atimtha.run_schedule s
                JOIN atimtha.organization o ON o.id = s.organization_id
                JOIN atimtha.project p ON p.id = s.project_id
                -- archived organisations and projects start nothing (their schedules wait until a restore)
                WHERE s.enabled AND s.next_run_at IS NOT NULL AND s.next_run_at <= now() AND o.archived_at IS NULL AND p.archived_at IS NULL
                ORDER BY s.next_run_at LIMIT 100
                """, conn);
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct)) due.Add((reader.GetGuid(0), reader.GetGuid(1), reader.GetString(2)));
        }

        foreach (var (id, org, orgKey) in due)
        {
            try { await StartAsync(id, org, orgKey, ct); }
            catch (Exception e) when (e is not OperationCanceledException) { logger.LogError(e, "Scheduled run {ScheduleId} could not start", id); }
        }
    }

    private async Task StartAsync(Guid id, Guid org, string orgKey, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var tenant = scope.ServiceProvider.GetRequiredService<TenantContext>();
        tenant.SetOrganization(org, orgKey);
        var db = scope.ServiceProvider.GetRequiredService<AtimthaDbContext>();
        var audit = scope.ServiceProvider.GetRequiredService<AuditWriter>();

        var s = await db.Schedules.FirstOrDefaultAsync(x => x.Id == id, ct);
        if (s is null || !s.Enabled || s.NextRunAt is not { } dueAt || dueAt > DateTimeOffset.UtcNow) return;
        tenant.UserId = s.CreatedBy;

        // claim: only the instance that moves next_run_at forward starts the run
        var zone = ScheduleEndpoints.Zone(s.TimeZone) ?? TimeZoneInfo.Utc;
        DateTimeOffset? next = Cron.TryParse(s.Cron, out var cron, out _) ? cron!.Next(DateTimeOffset.UtcNow, zone) : null;
        var claimed = await db.Schedules.Where(x => x.Id == id && x.NextRunAt == dueAt)
            .ExecuteUpdateAsync(u => u.SetProperty(x => x.NextRunAt, next).SetProperty(x => x.LastRunAt, DateTimeOffset.UtcNow), ct);
        if (claimed == 0) return;

        var project = await db.Projects.AsNoTracking().FirstOrDefaultAsync(p => p.Id == s.ProjectId, ct);
        var env = await db.Environments.AsNoTracking().FirstOrDefaultAsync(e => e.Id == s.EnvironmentId, ct);
        if (project is null || env is null) return;
        // a run missed by more than a day (platform down) is not started late
        if (DateTimeOffset.UtcNow - dueAt > TimeSpan.FromDays(1)) { logger.LogWarning("Skipped a missed run of schedule {ScheduleId}", id); return; }

        var selection = JsonSerializer.Deserialize<SelectionDto>(s.Selection, ScheduleEndpoints.Json);
        var run = await ExecutionEndpoints.QueueAsync(db, project, env, Engines.Name(s.Engine), s.Healing ?? project.HealingPolicy,
            selection, locale: "en", workers: null, retries: null, requestedBy: s.CreatedBy, ct, shards: s.Shards);
        if (run is null) return;
        run.ScheduleId = s.Id;
        await db.Schedules.Where(x => x.Id == id).ExecuteUpdateAsync(u => u.SetProperty(x => x.LastExecutionId, run.Id), ct);
        audit.Add("execution.start", "execution", run.Id, new { project = project.Key, environment = env.Key, schedule = s.Name });
        await db.SaveChangesAsync(ct);
        logger.LogInformation("Scheduled run {ExecutionId} queued by schedule {ScheduleId}", run.Id, id);
    }
}
