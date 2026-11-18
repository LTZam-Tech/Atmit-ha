using System.Text.Json;
using System.Text.Json.Nodes;
using Atimtha.Api.Identity;
using Atimtha.Api.Infrastructure;
using Atimtha.Api.TestAssets;
using Atimtha.Api.Workspaces;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.Execution;

public sealed record SelectionDto(string[]? Cases, string[]? Rows, string[]? Tags, string? Suite, string? Grep);

public sealed record StartExecutionRequest(string? Environment, string? Engine, SelectionDto? Selection, string? Locale, string? Healing, short? Workers, short? Retries);

public sealed record ExecutionDto(
    Guid Id, Guid ProjectId, string Environment, string Engine, string Status, string Locale, string HealingPolicy,
    JsonNode? Selection, JsonNode? Counts, string? Error, DateTimeOffset QueuedAt, DateTimeOffset? StartedAt, DateTimeOffset? FinishedAt, bool CancelRequested);

public sealed record HealingDto(string Kind, string Purpose, string Target, string Original, string HealedBy, string? Fix);

public sealed record TestResultDto(
    Guid Id, string Title, string? Module, string? Kind, string Status, bool Flaky, int Retries, string? Category,
    string? Error, int? DurationMs, string? CaseKey, string? RowKey, IReadOnlyList<HealingDto> Healing);

/// <summary>/api/v1/projects/{id}/executions and /api/v1/executions/{id}: start, follow and cancel runs.</summary>
public static class ExecutionEndpoints
{
    public static RouteGroupBuilder MapExecutions(this RouteGroupBuilder api)
    {
        var p = api.MapGroup("/projects/{projectId:guid}/executions").WithTags("Executions");
        p.MapPost("/", Start).RequireAuthorization(Permissions.Policy(Permissions.ExecutionRun));
        p.MapGet("/", List).RequireAuthorization(Permissions.Policy(Permissions.ProjectView));

        var e = api.MapGroup("/executions/{executionId:guid}").WithTags("Executions");
        e.MapGet("/", Get).RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        e.MapPost("/cancel", Cancel).RequireAuthorization(Permissions.Policy(Permissions.ExecutionRun));
        return api;
    }

    private static async Task<IResult> Start(Guid projectId, StartExecutionRequest body, AtimthaDbContext db, AccessService access, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        var project = await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct);
        if (project is null) return Api.NotFound("The project");
        if (!await access.HasInWorkspaceAsync(Permissions.ExecutionRun, project.WorkspaceId, ct)) return Api.Forbidden("You cannot run tests in this project.");

        var engine = (body.Engine ?? "web").ToLowerInvariant();
        var healing = body.Healing is null ? project.HealingPolicy : ProjectEndpoints.ParseHealing(body.Healing);
        var v = new Api.Validation()
            .Require(engine is "web" or "api", "engine", "1.0 runs \"web\" or \"api\" (ADR-0009).")
            .Require(body.Locale is null or "en" or "ar", "locale", "Use \"en\" or \"ar\".")
            .Require(healing is not null, "healing", "Use pass, flag or off.")
            .Require(body.Workers is null or >= 1 and <= 16, "workers", "1 to 16.")
            .Require(body.Retries is null or >= 0 and <= 3, "retries", "0 to 3.");
        if (!v.IsValid) return v.Problem();

        var env = body.Environment is null
            ? await db.Environments.AsNoTracking().FirstOrDefaultAsync(x => x.ProjectId == projectId && x.IsDefault, ct)
            : await db.Environments.AsNoTracking().FirstOrDefaultAsync(x => x.ProjectId == projectId && x.Key == body.Environment, ct);
        if (env is null) return Api.NotFound("The environment");

        var snapshot = await SnapshotExporter.BuildAsync(db, projectId, ct);
        if (snapshot is null) return Api.NotFound("The project");

        // secrets travel as references only (ADR-0014); the agent resolves them with its job token
        var secretRefs = new JsonObject();
        foreach (var u in await db.TestUsers.AsNoTracking().Where(u => u.ProjectId == projectId && u.PasswordSecretRef != null).ToListAsync(ct))
            secretRefs[$"users.{u.Key}.password"] = u.PasswordSecretRef;
        if (env.HttpPasswordSecretRef is not null) secretRefs[$"environments.{env.Key}.httpCredentials.password"] = env.HttpPasswordSecretRef;

        var executionId = Guid.NewGuid();
        var seed = Random.Shared.NextInt64(1, 1_000_000);
        var selection = JsonSerializer.SerializeToNode(body.Selection ?? new SelectionDto(null, null, null, null, null))!;
        var locale = body.Locale ?? "en";
        var job = new JsonObject
        {
            ["contract"] = "atimtha.job/1",
            ["jobId"] = Guid.NewGuid().ToString(),
            ["executionId"] = executionId.ToString(),
            ["organizationId"] = project.OrganizationId.ToString(),
            ["engine"] = engine,
            ["project"] = snapshot,
            ["environment"] = new JsonObject { ["key"] = env.Key, ["baseURL"] = env.BaseUrl, ["secretRefs"] = secretRefs },
            ["selection"] = selection.DeepClone(),
            ["settings"] = new JsonObject
            {
                ["locale"] = locale,
                ["healing"] = healing!.Value.ToString().ToLowerInvariant(),
                ["seed"] = seed,
                ["workers"] = body.Workers ?? project.RunWorkers,
                ["retries"] = body.Retries ?? project.RunRetries,
                ["testTimeoutSeconds"] = project.RunTestTimeoutS,
            },
            ["expiresAt"] = DateTimeOffset.UtcNow.AddHours(24).ToString("O"),
        };
        RemoveNulls(job["settings"]!.AsObject());

        var run = new ExecutionRun
        {
            Id = executionId, OrganizationId = project.OrganizationId, ProjectId = projectId, EnvironmentId = env.Id,
            Engine = engine == "api" ? EngineKind.Api : EngineKind.Web,
            Selection = selection.ToJsonString(), Locale = locale, Target = "agent", HealingPolicy = healing.Value, Seed = seed,
            Status = ExecutionStatus.Queued, RequestedBy = tenant.UserId, QueuedAt = DateTimeOffset.UtcNow, Job = job.ToJsonString(),
        };
        db.Executions.Add(run);
        audit.Add("execution.start", "execution", run.Id, new { project = project.Key, environment = env.Key, engine, selection = body.Selection });
        await db.SaveChangesAsync(ct);
        return Results.Created($"/api/v1/executions/{run.Id}", ToDto(run, env.Key));
    }

    private static async Task<IResult> List(Guid projectId, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        if (await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct) is null) return Api.NotFound("The project");
        var runs = await db.Executions.AsNoTracking().Where(x => x.ProjectId == projectId).OrderByDescending(x => x.QueuedAt).Take(50).ToListAsync(ct);
        var envKeys = await db.Environments.AsNoTracking().Where(x => x.ProjectId == projectId).ToDictionaryAsync(x => x.Id, x => x.Key, ct);
        return Results.Ok(runs.Select(r => ToDto(r, envKeys.GetValueOrDefault(r.EnvironmentId, "?"))));
    }

    private static async Task<IResult> Get(Guid executionId, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        var run = await db.Executions.AsNoTracking().FirstOrDefaultAsync(x => x.Id == executionId, ct);
        if (run is null || await ProjectEndpoints.Visible(run.ProjectId, Permissions.ProjectView, db, access, ct) is null) return Api.NotFound("The run");
        var envKey = await db.Environments.AsNoTracking().Where(x => x.Id == run.EnvironmentId).Select(x => x.Key).FirstOrDefaultAsync(ct) ?? "?";

        var results = await db.Results.AsNoTracking().Where(r => r.ExecutionId == executionId).OrderBy(r => r.StartedAt).ThenBy(r => r.Title).ToListAsync(ct);
        var ids = results.Select(r => r.Id).ToList();
        var heals = (await db.HealingEvents.AsNoTracking().Where(h => ids.Contains(h.TestResultId)).ToListAsync(ct)).ToLookup(h => h.TestResultId);
        var caseKeys = await db.Cases.AsNoTracking().Where(c => c.ProjectId == run.ProjectId).ToDictionaryAsync(c => c.Id, c => c.Key, ct);
        var rowIds = results.Where(r => r.DataRowId != null).Select(r => r.DataRowId!.Value).ToList();
        var rowKeys = await db.DataRows.AsNoTracking().Where(r => rowIds.Contains(r.Id)).ToDictionaryAsync(r => r.Id, r => r.Key, ct);

        return Results.Ok(new
        {
            execution = ToDto(run, envKey),
            results = results.Select(r => new TestResultDto(
                r.Id, r.Title, r.Module, r.Kind, Snake(r.Status.ToString()), r.Flaky, r.Retries, r.Category is null ? null : Snake(r.Category.ToString()!),
                r.Error, r.DurationMs,
                r.CaseId is { } c ? caseKeys.GetValueOrDefault(c) : null,
                r.DataRowId is { } d ? rowKeys.GetValueOrDefault(d) : null,
                heals[r.Id].Select(h => new HealingDto(HealKindName(h.Kind), h.Purpose.ToString().ToLowerInvariant(), h.Target, h.Original, h.HealedBy, h.Fix)).ToList())),
        });
    }

    private static async Task<IResult> Cancel(Guid executionId, AtimthaDbContext db, AccessService access, AuditWriter audit, CancellationToken ct)
    {
        var run = await db.Executions.FirstOrDefaultAsync(x => x.Id == executionId, ct);
        if (run is null || await ProjectEndpoints.Visible(run.ProjectId, Permissions.ProjectView, db, access, ct) is null) return Api.NotFound("The run");
        var workspace = await db.Projects.AsNoTracking().Where(p => p.Id == run.ProjectId).Select(p => p.WorkspaceId).FirstAsync(ct);
        if (!await access.HasInWorkspaceAsync(Permissions.ExecutionRun, workspace, ct)) return Api.Forbidden("You cannot cancel runs in this project.");
        if (run.Status is ExecutionStatus.Passed or ExecutionStatus.Failed or ExecutionStatus.Cancelled or ExecutionStatus.Error)
            return Api.Conflict("The run has already finished.");

        if (run.Status == ExecutionStatus.Queued)
        {
            run.Status = ExecutionStatus.Cancelled;
            run.FinishedAt = DateTimeOffset.UtcNow;
        }
        else run.CancelRequested = true; // the agent sees it on its next event and stops
        audit.Add("execution.cancel", "execution", run.Id);
        await db.SaveChangesAsync(ct);
        return Results.Accepted($"/api/v1/executions/{run.Id}");
    }

    internal static ExecutionDto ToDto(ExecutionRun r, string envKey) => new(
        r.Id, r.ProjectId, envKey, r.Engine.ToString().ToLowerInvariant(), r.Status.ToString().ToLowerInvariant(), r.Locale,
        r.HealingPolicy.ToString().ToLowerInvariant(),
        r.Selection is null ? null : JsonNode.Parse(r.Selection), r.Counts is null ? null : JsonNode.Parse(r.Counts),
        r.Error, r.QueuedAt, r.StartedAt, r.FinishedAt, r.CancelRequested);

    internal static string Snake(string pascal) => AtimthaDbContext.ToSnakeCase(pascal);

    internal static string HealKindName(HealKind k) => k switch
    {
        HealKind.FallbackLocator => "fallback-locator",
        HealKind.ReadyElement => "ready-element",
        _ => "navigation-route",
    };

    private static void RemoveNulls(JsonObject o)
    {
        foreach (var key in o.Where(kv => kv.Value is null).Select(kv => kv.Key).ToList()) o.Remove(key);
    }
}
