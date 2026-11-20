using System.Text.Json;
using System.Text.Json.Nodes;
using Atimtha.Api.Identity;
using Atimtha.Api.Infrastructure;
using Atimtha.Api.TestAssets;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.Execution;

using Api = Atimtha.Api.Infrastructure.Api;

public sealed record CreateAgentRequest(string? Name, string? Kind, string[]? Engines);
public sealed record AgentDto(Guid Id, string Name, string Kind, string Status, JsonNode? Capabilities, string? Version, DateTimeOffset? LastHeartbeatAt, DateTimeOffset RegisteredAt);
public sealed record CreatedAgentDto(AgentDto Agent, string Token);
public sealed record HeartbeatRequest(string? Version, JsonObject? Capabilities);

/// <summary>
/// Administration of agents (/api/v1/agents, org.admin) and the agent-facing API (/api/agent/v1, agent token):
/// heartbeat, claim a job, report events. Agents only ever call out; nothing connects to them (backlog §10).
/// </summary>
public static class AgentEndpoints
{
    public static readonly AuthorizationPolicy AgentPolicy = new AuthorizationPolicyBuilder(AgentAuthenticationHandler.Scheme)
        .RequireClaim(AgentAuthenticationHandler.AgentClaim)
        .Build();

    private const int MaxEventsPerCall = 500;
    public const int MaxSlots = 8;
    /// <summary>how long a claimed job (and its job token) stays valid</summary>
    public static readonly TimeSpan JobLifetime = TimeSpan.FromHours(6);

    public static IEndpointRouteBuilder MapAgents(this IEndpointRouteBuilder app, RouteGroupBuilder api)
    {
        var admin = api.MapGroup("/agents").WithTags("Agents").RequireAuthorization(Permissions.Policy(Permissions.OrgAdmin));
        admin.MapGet("/", List);
        admin.MapPost("/", Create);
        admin.MapDelete("/{agentId:guid}", Revoke);
        admin.MapPost("/{agentId:guid}/rotate-token", RotateToken);

        var agent = app.MapGroup("/api/agent/v1").WithTags("Agent protocol").RequireAuthorization(AgentPolicy);
        agent.MapPost("/heartbeat", Heartbeat);
        agent.MapPost("/jobs/claim", Claim);
        agent.MapGet("/signing-key", SigningKey);
        agent.MapPost("/jobs/{executionId:guid}/events", Events);
        return app;
    }

    // ---------------------------------------------------------------- administration

    private static async Task<IResult> List(AtimthaDbContext db, CancellationToken ct)
    {
        var agents = await db.Agents.AsNoTracking().OrderBy(a => a.Name).ToListAsync(ct);
        return Results.Ok(agents.Select(ToDto));
    }

    private static async Task<IResult> Create(CreateAgentRequest body, AtimthaDbContext db, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        var kind = body.Kind?.ToLowerInvariant() switch { "central" => AgentKind.Central, "local" => AgentKind.Local, "private" => AgentKind.Private, _ => (AgentKind?)null };
        var engines = body.Engines is { Length: > 0 } ? body.Engines.Select(e => e.ToLowerInvariant()).Distinct().ToArray() : ["web"];
        var v = new Api.Validation()
            .Text(body.Name, "name", 100)
            .Require(kind is not null, "kind", "Use central, local or private.")
            .Require(engines.All(global::Atimtha.Api.Execution.Engines.IsKnown), "engines", "Use web, api, mobile and/or performance.");
        if (!v.IsValid) return v.Problem();

        var token = AgentAuthenticationHandler.NewToken();
        var agent = new ExecutionAgent
        {
            Id = Guid.NewGuid(), OrganizationId = tenant.OrganizationId!.Value, Name = body.Name!.Trim(), Kind = kind!.Value,
            Status = AgentStatus.Pending, Capabilities = new JsonObject { ["engines"] = new JsonArray(engines.Select(e => (JsonNode)e).ToArray()) }.ToJsonString(),
            TokenHash = AgentAuthenticationHandler.HashToken(token), RegisteredAt = DateTimeOffset.UtcNow,
        };
        db.Agents.Add(agent);
        audit.Add("agent.create", "execution_agent", agent.Id, new { agent.Name, kind = agent.Kind.ToString(), engines });
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException e) when (Api.IsUniqueViolation(e)) { return Api.Conflict($"An agent named \"{agent.Name}\" already exists."); }
        // the only time the token is ever shown
        return Results.Created($"/api/v1/agents/{agent.Id}", new CreatedAgentDto(ToDto(agent), token));
    }

    private static async Task<IResult> Revoke(Guid agentId, AtimthaDbContext db, AuditWriter audit, CancellationToken ct)
    {
        var agent = await db.Agents.FirstOrDefaultAsync(a => a.Id == agentId, ct);
        if (agent is null) return Api.NotFound("The agent");
        agent.Status = AgentStatus.Revoked;
        agent.RevokedAt = DateTimeOffset.UtcNow;
        agent.TokenHash = null;
        // its unfinished jobs go back to the queue
        foreach (var run in await db.Executions.Where(e => e.AgentId == agentId && (e.Status == ExecutionStatus.Assigned || e.Status == ExecutionStatus.Running)).ToListAsync(ct))
        {
            run.Status = ExecutionStatus.Queued;
            run.AgentId = null;
            run.RequeueCount++;
        }
        audit.Add("agent.revoke", "execution_agent", agent.Id, new { agent.Name });
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    /// <summary>
    /// A new token for an agent (rotation, or a leaked token): the old one stops working at once. The agent keeps its
    /// identity, history and running job; it needs the new token on its next call.
    /// </summary>
    private static async Task<IResult> RotateToken(Guid agentId, AtimthaDbContext db, AuditWriter audit, CancellationToken ct)
    {
        var agent = await db.Agents.FirstOrDefaultAsync(a => a.Id == agentId, ct);
        if (agent is null) return Api.NotFound("The agent");
        if (agent.Status == AgentStatus.Revoked) return Api.Conflict("A revoked agent cannot get a new token: register a new agent.");
        var token = AgentAuthenticationHandler.NewToken();
        agent.TokenHash = AgentAuthenticationHandler.HashToken(token);
        audit.Add("agent.rotate_token", "execution_agent", agent.Id, new { agent.Name });
        await db.SaveChangesAsync(ct);
        return Results.Ok(new CreatedAgentDto(ToDto(agent), token));
    }

    // ---------------------------------------------------------------- agent protocol

    private static IResult SigningKey(JobSigner signer) =>
        Results.Ok(new { keyId = signer.KeyId, algorithm = "ES256", publicKeyPem = signer.PublicKeyPem, ephemeral = signer.Ephemeral });

    private static async Task<IResult> Heartbeat(HeartbeatRequest body, HttpContext http, AtimthaDbContext db, CancellationToken ct)
    {
        if (AgentAuthenticationHandler.JobId(http.User) is not null) return Api.Forbidden("A job token only reports on its own job.");
        var agent = await CurrentAgent(http, db, ct);
        if (agent is null) return Results.Unauthorized();
        agent.LastHeartbeatAt = DateTimeOffset.UtcNow;
        if (agent.Status is AgentStatus.Pending or AgentStatus.Offline) agent.Status = AgentStatus.Active;
        if (body.Version is { Length: <= 50 }) agent.Version = body.Version;
        if (body.Capabilities is { } caps && caps["engines"] is JsonArray reported)
        {
            // an agent may report fewer engines than it was registered for, never more
            var allowed = Engines(agent);
            var now = reported.Select(n => n?.GetValue<string>()?.ToLowerInvariant()).Where(e => e is not null && allowed.Contains(e)).Select(e => e!).ToArray();
            caps["engines"] = new JsonArray(now.Select(e => (JsonNode)e).ToArray());
            // parallel jobs this agent runs (ATIMTHA_AGENT_SLOTS), 1 to 8
            caps["slots"] = caps["slots"] is JsonValue sv && sv.TryGetValue<int>(out var slots) ? Math.Clamp(slots, 1, MaxSlots) : 1;
            agent.Capabilities = caps.ToJsonString();
        }
        await db.SaveChangesAsync(ct);
        var since = DateTimeOffset.UtcNow.AddHours(-1);
        var cancel = await db.Executions.AsNoTracking()
            .Where(e => e.AgentId == agent.Id && e.CancelRequested &&
                (e.Status == ExecutionStatus.Assigned || e.Status == ExecutionStatus.Running || (e.Status == ExecutionStatus.Error && e.FinishedAt > since)))
            .Select(e => e.Id).ToListAsync(ct);
        return Results.Ok(new { cancel });
    }

    private static async Task<IResult> Claim(HttpContext http, AtimthaDbContext db, IJobQueue queue, JobSigner signer, JobTokens tokens, PlatformMetrics metrics,
        Identity.OrganizationSettings settings, CancellationToken ct)
    {
        if (AgentAuthenticationHandler.JobId(http.User) is not null) return Api.Forbidden("A job token cannot claim jobs.");
        var agent = await CurrentAgent(http, db, ct);
        if (agent is null) return Results.Unauthorized();
        agent.LastHeartbeatAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        var executionId = await queue.ClaimAsync(agent.Id, Engines(agent), Slots(agent), ct);
        metrics.Claim(executionId is not null);
        if (executionId is null) return Results.NoContent();
        var run = await db.Executions.AsNoTracking().FirstAsync(e => e.Id == executionId, ct);
        var job = JsonNode.Parse(run.Job ?? "{}")!.AsObject();
        // the job (and its token) lasts at least as long as the organisation lets a run go on, plus a margin for uploads
        var maxRun = TimeSpan.FromMinutes(await settings.GetAsync(run.OrganizationId, Identity.OrganizationSettings.MaxRunMinutes, ct) + 30);
        var expires = DateTimeOffset.UtcNow.Add(maxRun > JobLifetime ? maxRun : JobLifetime);
        job["expiresAt"] = expires.ToString("O");
        // the job is bound to the agent that claimed it, then signed over the exact bytes sent
        job["agentId"] = agent.Id.ToString();
        // what the test runner reports with: this execution only, until the job expires
        job["jobToken"] = tokens.Mint(run.Id, agent.Id, run.OrganizationId, expires);
        var body = job.ToJsonString();
        http.Response.Headers[JobSigner.Header] = signer.Sign(body);
        return Results.Text(body, "application/json", System.Text.Encoding.UTF8);
    }

    private static async Task<IResult> Events(Guid executionId, JsonArray events, HttpContext http, AtimthaDbContext db, CancellationToken ct)
    {
        var agent = await CurrentAgent(http, db, ct);
        if (agent is null) return Results.Unauthorized();
        if (events.Count > MaxEventsPerCall) return Results.Problem(statusCode: 413, title: "Too many events", detail: $"Send at most {MaxEventsPerCall} events per call.");

        var run = await db.Executions.FirstOrDefaultAsync(e => e.Id == executionId, ct);
        // a job belongs to the agent that claimed it (and a job token to its own job); anyone else sees "not found"
        if (run is null || run.AgentId != agent.Id || !AgentAuthenticationHandler.MayReport(http.User, executionId)) return Api.NotFound("The job");
        if (run.Status is ExecutionStatus.Passed or ExecutionStatus.Failed or ExecutionStatus.Cancelled or ExecutionStatus.Error)
            return Results.Ok(new { cancel = true, reason = "finished" });

        agent.LastHeartbeatAt = DateTimeOffset.UtcNow;
        var caseIds = await db.Cases.AsNoTracking().Where(c => c.ProjectId == run.ProjectId).ToDictionaryAsync(c => c.Key, c => c.Id, ct);
        var problems = new List<string>();
        // a batch sent again after a lost response must not add the same results twice
        var named = events.OfType<JsonObject>().Select(ev => Guid.TryParse(SnapshotImporter.Str(ev["id"]), out var g) ? g : Guid.Empty)
            .Where(g => g != Guid.Empty).ToList();
        var known = (await db.Results.AsNoTracking().Where(r => named.Contains(r.Id)).Select(r => r.Id).ToListAsync(ct)).ToHashSet();

        foreach (var node in events)
        {
            if (node is not JsonObject ev) { problems.Add("an event must be an object"); continue; }
            switch (SnapshotImporter.Str(ev["type"]))
            {
                case "job.started":
                    run.Status = ExecutionStatus.Running;
                    run.StartedAt ??= DateTimeOffset.UtcNow;
                    break;
                case "test.finished":
                    if (Guid.TryParse(SnapshotImporter.Str(ev["id"]), out var named1) && !known.Add(named1)) break;
                    if (ResultFrom(ev, run, caseIds, db, out var problem) is { } result) db.Results.Add(result);
                    else problems.Add(problem!);
                    break;
                case "job.finished":
                    run.Status = SnapshotImporter.Str(ev["status"]) switch
                    {
                        "passed" => ExecutionStatus.Passed,
                        "cancelled" => ExecutionStatus.Cancelled,
                        "error" => ExecutionStatus.Error,
                        _ => ExecutionStatus.Failed,
                    };
                    run.FinishedAt = DateTimeOffset.UtcNow;
                    run.Counts = ev["counts"]?.ToJsonString();
                    run.Error = Truncate(SnapshotImporter.Str(ev["error"]), 20_000);
                    break;
                default:
                    problems.Add($"unknown event type \"{SnapshotImporter.Str(ev["type"])}\"");
                    break;
            }
        }
        await db.SaveChangesAsync(ct);
        // a shard: its parent run follows (running, then the rolled-up result when the last shard finishes)
        if (run.ParentExecutionId is { } parentId) await Shards.RollUpLockedAsync(db, parentId, ct);
        return Results.Ok(new { cancel = run.CancelRequested, problems });
    }

    private static TestResult? ResultFrom(JsonObject ev, ExecutionRun run, Dictionary<string, Guid> caseIds, AtimthaDbContext db, out string? problem)
    {
        problem = null;
        var title = SnapshotImporter.Str(ev["title"]);
        if (string.IsNullOrWhiteSpace(title)) { problem = "test.finished needs a title"; return null; }
        var status = SnapshotImporter.Str(ev["status"]) switch
        {
            "passed" => ResultStatus.Passed,
            "failed" => ResultStatus.Failed,
            "timed_out" or "timedOut" => ResultStatus.TimedOut,
            "skipped" => ResultStatus.Skipped,
            "interrupted" => ResultStatus.Interrupted,
            _ => (ResultStatus?)null,
        };
        if (status is null) { problem = $"test \"{title}\": unknown status"; return null; }

        Guid? caseId = SnapshotImporter.Str(ev["caseKey"]) is { } ck && caseIds.TryGetValue(ck, out var cid) ? cid : null;
        Guid? rowId = null;
        if (caseId is { } c && SnapshotImporter.Str(ev["rowKey"]) is { } rk)
            rowId = db.DataRows.AsNoTracking().Where(r => r.CaseId == c && r.Key == rk).Select(r => (Guid?)r.Id).FirstOrDefault();

        var result = new TestResult
        {
            Id = Guid.TryParse(SnapshotImporter.Str(ev["id"]), out var named) && named != Guid.Empty ? named : Guid.NewGuid(),
            OrganizationId = run.OrganizationId, ExecutionId = run.Id, CaseId = caseId, DataRowId = rowId,
            Title = Truncate(title, 1000)!, Module = Truncate(SnapshotImporter.Str(ev["module"]), 300), Kind = SnapshotImporter.Str(ev["kind"]),
            Status = status.Value,
            Flaky = ev["flaky"] is JsonValue fv && fv.GetValueKind() == JsonValueKind.True,
            Retries = ev["retries"] is JsonValue rv && rv.TryGetValue<int>(out var retries) ? (short)Math.Clamp(retries, 0, 10) : (short)0,
            Category = CategoryFrom(SnapshotImporter.Str(ev["category"])),
            Error = Truncate(SnapshotImporter.Str(ev["error"]), 20_000),
            DurationMs = ev["durationMs"] is JsonValue dv && dv.TryGetValue<int>(out var ms) ? ms : null,
            Steps = ev["steps"]?.ToJsonString(), LastPage = ev["lastPage"]?.ToJsonString(), Discoveries = ev["discoveries"]?.ToJsonString(),
            StartedAt = DateTimeOffset.UtcNow,
        };
        foreach (var h in ev["healing"] as JsonArray ?? [])
        {
            var kind = SnapshotImporter.Str(h?["kind"]) switch { "fallback-locator" => HealKind.FallbackLocator, "ready-element" => HealKind.ReadyElement, "navigation-route" => HealKind.NavigationRoute, _ => (HealKind?)null };
            var purpose = SnapshotImporter.Str(h?["purpose"]) switch { "check" => HealPurpose.Check, "action" => HealPurpose.Action, "navigation" => HealPurpose.Navigation, _ => (HealPurpose?)null };
            if (kind is null || purpose is null) continue;
            db.HealingEvents.Add(new HealingEvent
            {
                Id = Guid.NewGuid(), OrganizationId = run.OrganizationId, TestResultId = result.Id, Kind = kind.Value, Purpose = purpose.Value,
                Target = Truncate(SnapshotImporter.Str(h?["target"]), 500) ?? "", Original = Truncate(SnapshotImporter.Str(h?["original"]), 4000) ?? "",
                HealedBy = Truncate(SnapshotImporter.Str(h?["healedBy"]), 1000) ?? "", Fix = Truncate(SnapshotImporter.Str(h?["fix"]), 1000),
            });
        }
        return result;
    }

    private static FailureCategory? CategoryFrom(string? value) => value switch
    {
        "application_defect" or "Application defect" => FailureCategory.ApplicationDefect,
        "locator_or" or "Locator / OR" => FailureCategory.LocatorOr,
        "self_healing" or "Self-healing" => FailureCategory.SelfHealing,
        "environment" or "Environment" => FailureCategory.Environment,
        "timeout" or "Timeout" => FailureCategory.Timeout,
        "script_error" or "Script error" => FailureCategory.ScriptError,
        "infrastructure" => FailureCategory.Infrastructure,
        _ => null,
    };

    private static async Task<ExecutionAgent?> CurrentAgent(HttpContext http, AtimthaDbContext db, CancellationToken ct)
    {
        if (AgentAuthenticationHandler.AgentId(http.User) is not { } id) return null;
        var agent = await db.Agents.FirstOrDefaultAsync(a => a.Id == id, ct);
        return agent is null || agent.Status == AgentStatus.Revoked ? null : agent;
    }

    private static string[] Engines(ExecutionAgent agent)
    {
        try
        {
            return JsonNode.Parse(agent.Capabilities)?["engines"] is JsonArray a
                ? a.Select(n => n?.GetValue<string>() ?? "").Where(e => e.Length > 0).ToArray()
                : ["web"];
        }
        catch (JsonException) { return ["web"]; }
    }

    /// <summary>parallel jobs the agent reported (capabilities.slots), 1 when it never said</summary>
    internal static int Slots(ExecutionAgent agent)
    {
        try { return JsonNode.Parse(agent.Capabilities)?["slots"] is JsonValue v && v.TryGetValue<int>(out var n) ? Math.Clamp(n, 1, MaxSlots) : 1; }
        catch (JsonException) { return 1; }
    }

    private static AgentDto ToDto(ExecutionAgent a) => new(
        a.Id, a.Name, a.Kind.ToString().ToLowerInvariant(), a.Status.ToString().ToLowerInvariant(),
        JsonNode.Parse(a.Capabilities), a.Version, a.LastHeartbeatAt, a.RegisteredAt);

    private static string? Truncate(string? s, int max) => s is null || s.Length <= max ? s : s[..max];
}
