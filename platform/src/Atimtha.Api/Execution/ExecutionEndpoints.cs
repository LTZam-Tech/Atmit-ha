using System.Text.Json;
using System.Text.Json.Nodes;
using Atimtha.Api.Identity;
using Atimtha.Api.Infrastructure;
using Atimtha.Api.TestAssets;
using Atimtha.Api.Workspaces;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.Execution;

using Api = Atimtha.Api.Infrastructure.Api;

public sealed record SelectionDto(string[]? Cases, string[]? Rows, string[]? Tags, string? Suite, string? Grep, string[]? Flows = null);

public sealed record StartExecutionRequest(string? Environment, string? Engine, SelectionDto? Selection, string? Locale, string? Healing, short? Workers, short? Retries,
    string? Kind = null, ExploreDto? Explore = null, short? Shards = null);
/// <summary>an explore job: the pages to collect (paths or addresses on the environment's host) and who signs in first</summary>
public sealed record ExploreDto(string[]? Urls, string? As);

public sealed record ExecutionDto(
    Guid Id, Guid ProjectId, string Environment, string Engine, string Status, string Locale, string HealingPolicy,
    JsonNode? Selection, JsonNode? Counts, string? Error, DateTimeOffset QueuedAt, DateTimeOffset? StartedAt, DateTimeOffset? FinishedAt, bool CancelRequested,
    int? Shards = null, int? ShardIndex = null, Guid? ParentId = null);

public sealed record HealingDto(string Kind, string Purpose, string Target, string Original, string HealedBy, string? Fix);

public sealed record TestResultDto(
    Guid Id, string Title, string? Module, string? Kind, string Status, bool Flaky, int Retries, string? Category,
    string? Error, int? DurationMs, string? CaseKey, string? RowKey, IReadOnlyList<HealingDto> Healing, IReadOnlyList<EvidenceDto>? Evidence = null);

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
        var kind = (body.Kind ?? "run").ToLowerInvariant();
        var healing = body.Healing is null ? project.HealingPolicy : ProjectEndpoints.ParseHealing(body.Healing);
        var v = new Api.Validation()
            .Require(Engines.IsKnown(engine), "engine", "Use web, api, mobile or performance.")
            .Require(JobKinds.Contains(kind), "kind", "Use run, explore or export.")
            .Require(kind == "run" || engine == "web", "engine", "Collecting pages and exporting code use the web engine.")
            .Require(kind != "explore" || body.Explore?.Urls is { Length: >= 1 and <= MaxExploreUrls }, "explore.urls", $"Give 1 to {MaxExploreUrls} page addresses.")
            .Require(body.Locale is null or "en" or "ar", "locale", "Use \"en\" or \"ar\".")
            .Require(healing is not null, "healing", "Use pass, flag or off.")
            .Require(body.Workers is null or >= 1 and <= 16, "workers", "1 to 16.")
            .Require(body.Retries is null or >= 0 and <= 3, "retries", "0 to 3.");
        if (!v.IsValid) return v.Problem();
        if (Shards.Refusal(body.Shards, kind) is { } badShards) return badShards;

        var env = body.Environment is null
            ? await db.Environments.AsNoTracking().FirstOrDefaultAsync(x => x.ProjectId == projectId && x.IsDefault, ct)
            : await db.Environments.AsNoTracking().FirstOrDefaultAsync(x => x.ProjectId == projectId && x.Key == body.Environment, ct);
        if (env is null) return Api.NotFound("The environment");
        if (await Engines.RefusalAsync(db, project.OrganizationId, engine, ct) is { } refused) return refused;

        JsonObject? explore = null;
        if (kind == "explore")
        {
            var (urls, problem) = ExploreUrls(body.Explore!.Urls!, env.BaseUrl);
            if (problem is not null) return Results.ValidationProblem(new Dictionary<string, string[]> { ["explore.urls"] = [problem] });
            var user = string.IsNullOrWhiteSpace(body.Explore.As) || body.Explore.As == "none" ? null : body.Explore.As.Trim();
            if (user is not null && !await db.TestUsers.AsNoTracking().AnyAsync(u => u.ProjectId == projectId && u.Key == user, ct))
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["explore.as"] = [$"The project has no test user \"{user}\"."] });
            explore = new JsonObject { ["urls"] = new JsonArray(urls.Select(u => (JsonNode)u).ToArray()), ["as"] = user };
        }

        var run = await QueueAsync(db, project, env, engine, healing!.Value, body.Selection, body.Locale ?? "en", body.Workers, body.Retries, tenant.UserId, ct, kind, explore, body.Shards);
        if (run is null) return Api.NotFound("The project");
        audit.Add(kind == "run" ? "execution.start" : $"execution.{kind}", "execution", run.Id, new { project = project.Key, environment = env.Key, engine, kind, selection = body.Selection, shards = body.Shards });
        await db.SaveChangesAsync(ct);
        return Results.Created($"/api/v1/executions/{run.Id}", ToDto(run, env.Key));
    }

    /// <summary>
    /// Builds the job (snapshot, secret references, settings) and adds a queued run to the unit of work; the caller
    /// saves. Used by "start a run" and by the scheduler. Null when the project has no snapshot to run.
    /// </summary>
    internal static async Task<ExecutionRun?> QueueAsync(AtimthaDbContext db, Project project, ProjectEnvironment env, string engine, HealingPolicy healing,
        SelectionDto? selectionDto, string locale, short? workers, short? retries, Guid? requestedBy, CancellationToken ct,
        string kind = "run", JsonObject? explore = null, short? shards = null)
    {
        var projectId = project.Id;
        var snapshot = await SnapshotExporter.BuildAsync(db, projectId, ct);
        if (snapshot is null) return null;

        // secrets travel as references only (ADR-0014); the agent resolves them with its job token
        var secretRefs = new JsonObject();
        foreach (var u in await db.TestUsers.AsNoTracking().Where(u => u.ProjectId == projectId && u.PasswordSecretRef != null).ToListAsync(ct))
            secretRefs[$"users.{u.Key}.password"] = u.PasswordSecretRef;
        if (env.HttpPasswordSecretRef is not null) secretRefs[$"environments.{env.Key}.httpCredentials.password"] = env.HttpPasswordSecretRef;

        var executionId = Guid.NewGuid();
        var seed = Random.Shared.NextInt64(1, 1_000_000);
        var selection = JsonSerializer.SerializeToNode(selectionDto ?? new SelectionDto(null, null, null, null, null))!;
        // what kind of job: a test run, page collection (explore) or Playwright code export; kept with the selection
        if (kind != "run") selection["kind"] = kind;
        if (explore is not null) selection["explore"] = explore.DeepClone();
        var job = new JsonObject
        {
            ["contract"] = "atimtha.job/1",
            ["jobId"] = Guid.NewGuid().ToString(),
            ["executionId"] = executionId.ToString(),
            ["organizationId"] = project.OrganizationId.ToString(),
            ["engine"] = engine,
            ["kind"] = kind,
            ["project"] = snapshot,
            ["environment"] = new JsonObject { ["key"] = env.Key, ["baseURL"] = env.BaseUrl, ["secretRefs"] = secretRefs },
            ["selection"] = selectionDto is null ? new JsonObject() : JsonSerializer.SerializeToNode(selectionDto)!,
            ["explore"] = explore?.DeepClone(),
            ["settings"] = new JsonObject
            {
                ["locale"] = locale,
                ["healing"] = healing.ToString().ToLowerInvariant(),
                ["seed"] = seed,
                ["workers"] = workers ?? project.RunWorkers,
                ["retries"] = retries ?? project.RunRetries,
                ["testTimeoutSeconds"] = project.RunTestTimeoutS,
                // performance runs: the organisation's load cap (the agent never exceeds its own either)
                ["maxVirtualUsers"] = engine == "performance" ? await Engines.MaxVirtualUsersAsync(db, project.OrganizationId, ct) : null,
            },
            ["expiresAt"] = DateTimeOffset.UtcNow.AddHours(24).ToString("O"),
            // the request's trace: the agent logs it on every line and sends it back (traceparent), so a run can be
            // followed from the API to the agent and its test runner
            ["traceId"] = (System.Diagnostics.Activity.Current?.TraceId ?? System.Diagnostics.ActivityTraceId.CreateRandom()).ToString(),
        };
        RemoveNulls(job["settings"]!.AsObject());
        RemoveNulls(job);

        var run = new ExecutionRun
        {
            Id = executionId, OrganizationId = project.OrganizationId, ProjectId = projectId, EnvironmentId = env.Id,
            Engine = Engines.Parse(engine),
            Selection = selection.ToJsonString(), Locale = locale, Target = "agent", HealingPolicy = healing, Seed = seed,
            Status = ExecutionStatus.Queued, RequestedBy = requestedBy, QueuedAt = DateTimeOffset.UtcNow, Job = job.ToJsonString(),
        };
        db.Executions.Add(run);
        if (shards is >= Shards.Min and <= Shards.Max)
        {
            // the parent keeps no job; each shard is a job of its own that any free agent claims (--shard=i/n)
            run.ShardTotal = shards;
            run.Job = null;
            for (short i = 1; i <= shards; i++)
            {
                var childId = Guid.NewGuid();
                var childJob = job.DeepClone().AsObject();
                childJob["jobId"] = Guid.NewGuid().ToString();
                childJob["executionId"] = childId.ToString();
                childJob["shard"] = new JsonObject { ["index"] = i, ["total"] = shards };
                db.Executions.Add(new ExecutionRun
                {
                    Id = childId, OrganizationId = run.OrganizationId, ProjectId = run.ProjectId, EnvironmentId = run.EnvironmentId, Engine = run.Engine,
                    Selection = run.Selection, Locale = run.Locale, Target = run.Target, HealingPolicy = run.HealingPolicy, Seed = run.Seed,
                    Status = ExecutionStatus.Queued, RequestedBy = run.RequestedBy, QueuedAt = run.QueuedAt, Job = childJob.ToJsonString(),
                    ParentExecutionId = run.Id, ShardIndex = i, ShardTotal = shards,
                });
            }
        }
        return run;
    }

    public static readonly string[] JobKinds = ["run", "explore", "export"];
    public const int MaxExploreUrls = 20;

    /// <summary>paths, or full addresses on the environment's own host only: an agent never collects pages elsewhere</summary>
    internal static (List<string> Urls, string? Problem) ExploreUrls(IEnumerable<string> raw, string baseUrl)
    {
        var list = new List<string>();
        Uri.TryCreate(baseUrl, UriKind.Absolute, out var root);
        foreach (var u in raw.Select(x => (x ?? "").Trim()).Where(x => x.Length > 0).Distinct())
        {
            if (u.Length > 2000) return (list, "An address is too long.");
            if (u.StartsWith('/') && !u.StartsWith("//", StringComparison.Ordinal)) { list.Add(u); continue; }
            if (!Uri.TryCreate(u, UriKind.Absolute, out var abs) || (abs.Scheme != Uri.UriSchemeHttp && abs.Scheme != Uri.UriSchemeHttps))
                return (list, $"\"{u}\" is neither a path (/…) nor an http(s) address.");
            if (root is null || !string.Equals(abs.Authority, root.Authority, StringComparison.OrdinalIgnoreCase))
                return (list, $"\"{u}\" is not on the environment's host ({root?.Authority ?? baseUrl}).");
            list.Add(abs.ToString());
        }
        return list.Count == 0 ? (list, "Give at least one page address.") : (list, null);
    }

    private static async Task<IResult> List(Guid projectId, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        if (await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct) is null) return Api.NotFound("The project");
        // a sharded run is listed once (its parent); its shards show on the run page
        var runs = await db.Executions.AsNoTracking().Where(x => x.ProjectId == projectId && x.ParentExecutionId == null).OrderByDescending(x => x.QueuedAt).Take(50).ToListAsync(ct);
        var envKeys = await db.Environments.AsNoTracking().Where(x => x.ProjectId == projectId).ToDictionaryAsync(x => x.Id, x => x.Key, ct);
        return Results.Ok(runs.Select(r => ToDto(r, envKeys.GetValueOrDefault(r.EnvironmentId, "?"))));
    }

    private static async Task<IResult> Get(Guid executionId, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        var run = await db.Executions.AsNoTracking().FirstOrDefaultAsync(x => x.Id == executionId, ct);
        if (run is null || await ProjectEndpoints.Visible(run.ProjectId, Permissions.ProjectView, db, access, ct) is null) return Api.NotFound("The run");
        var envKey = await db.Environments.AsNoTracking().Where(x => x.Id == run.EnvironmentId).Select(x => x.Key).FirstOrDefaultAsync(ct) ?? "?";

        var runIds = await Shards.RunIdsAsync(db, executionId, ct);
        var results = await db.Results.AsNoTracking().Where(r => runIds.Contains(r.ExecutionId)).OrderBy(r => r.StartedAt).ThenBy(r => r.Title).ToListAsync(ct);
        var ids = results.Select(r => r.Id).ToList();
        var heals = (await db.HealingEvents.AsNoTracking().Where(h => ids.Contains(h.TestResultId)).ToListAsync(ct)).ToLookup(h => h.TestResultId);
        var files = (await db.Evidence.AsNoTracking().Where(e => ids.Contains(e.TestResultId)).OrderBy(e => e.CreatedAt).ToListAsync(ct)).ToLookup(e => e.TestResultId);
        var caseKeys = await db.Cases.AsNoTracking().Where(c => c.ProjectId == run.ProjectId).ToDictionaryAsync(c => c.Id, c => c.Key, ct);
        var rowIds = results.Where(r => r.DataRowId != null).Select(r => r.DataRowId!.Value).ToList();
        var rowKeys = await db.DataRows.AsNoTracking().Where(r => rowIds.Contains(r.Id)).ToDictionaryAsync(r => r.Id, r => r.Key, ct);

        return Results.Ok(new
        {
            execution = ToDto(run, envKey),
            shards = Shards.IsParent(run) ? await Shards.ListAsync(db, run.Id, ct) : null,
            results = results.Select(r => new TestResultDto(
                r.Id, r.Title, r.Module, r.Kind, Snake(r.Status.ToString()), r.Flaky, r.Retries, r.Category is null ? null : Snake(r.Category.ToString()!),
                r.Error, r.DurationMs,
                r.CaseId is { } c ? caseKeys.GetValueOrDefault(c) : null,
                r.DataRowId is { } d ? rowKeys.GetValueOrDefault(d) : null,
                heals[r.Id].Select(h => new HealingDto(HealKindName(h.Kind), h.Purpose.ToString().ToLowerInvariant(), h.Target, h.Original, h.HealedBy, h.Fix)).ToList(),
                files[r.Id].Select(EvidenceEndpoints.ToDto).ToList())),
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

        if (Shards.IsParent(run))
        {
            // every unfinished shard stops; the parent follows them
            await Shards.CancelChildrenAsync(db, run.Id, ct);
            run.CancelRequested = true;
            await Shards.RollUpAsync(db, run.Id, ct);
        }
        else if (run.Status == ExecutionStatus.Queued)
        {
            run.Status = ExecutionStatus.Cancelled;
            run.FinishedAt = DateTimeOffset.UtcNow;
        }
        else run.CancelRequested = true; // the agent sees it on its next event and stops
        if (run.ParentExecutionId is { } parentId) await Shards.RollUpAsync(db, parentId, ct);
        audit.Add("execution.cancel", "execution", run.Id);
        await db.SaveChangesAsync(ct);
        return Results.Accepted($"/api/v1/executions/{run.Id}");
    }

    internal static ExecutionDto ToDto(ExecutionRun r, string envKey) => new(
        r.Id, r.ProjectId, envKey, r.Engine.ToString().ToLowerInvariant(), r.Status.ToString().ToLowerInvariant(), r.Locale,
        r.HealingPolicy.ToString().ToLowerInvariant(),
        r.Selection is null ? null : JsonNode.Parse(r.Selection), r.Counts is null ? null : JsonNode.Parse(r.Counts),
        r.Error, r.QueuedAt, r.StartedAt, r.FinishedAt, r.CancelRequested, r.ShardTotal, r.ShardIndex, r.ParentExecutionId);

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
