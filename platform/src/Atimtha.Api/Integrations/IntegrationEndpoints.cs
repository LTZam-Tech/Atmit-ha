using System.Text;
using System.Text.Json.Nodes;
using Atimtha.Api.Execution;
using Atimtha.Api.Identity;
using Atimtha.Api.Infrastructure;
using Atimtha.Api.Workspaces;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.Integrations;

using Api = Atimtha.Api.Infrastructure.Api;

public sealed record IntegrationDto(Guid Id, string Kind, string Name, JsonObject Config, bool HasCredential, bool Enabled, DateTimeOffset UpdatedAt);

/// <summary>
/// kind jira: baseUrl, projectKey, issueType (default Bug), auth basic|bearer, email (basic), labels.
/// kind azure_devops: baseUrl, project, workItemType (default Bug), areaPath, tags.
/// </summary>
public sealed record SaveIntegrationRequest(string? Kind, string? Name, JsonObject? Config, string? CredentialSecretRef, bool? Enabled);

public sealed record CheckResultDto(bool Ok, string? Account, string? Error);

/// <summary>resultIds empty = every failed result of the run that has no issue in this integration yet.</summary>
public sealed record PublishRequest(Guid IntegrationId, IReadOnlyList<Guid>? ResultIds);

public sealed record IssueDto(Guid ResultId, string Title, string IssueKey, string IssueUrl, DateTimeOffset CreatedAt);
public sealed record PublishFailureDto(Guid ResultId, string Title, string Error);
public sealed record PublishResultDto(IReadOnlyList<IssueDto> Created, int AlreadyFiled, IReadOnlyList<PublishFailureDto> Failed);

/// <summary>
/// /api/v1/integrations (configure, check) and /api/v1/executions/{id}/issues (file failed results as defects).
/// ADR-0010: Jira first, Azure DevOps behind the same contract (IDefectTracker); credentials stay in the secrets store;
/// every tracker can be switched off by feature flag.
/// </summary>
public static class IntegrationEndpoints
{
    public static RouteGroupBuilder MapIntegrations(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/integrations").WithTags("Integrations");
        g.MapGet("/", List).RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        g.MapPost("/", Create).RequireAuthorization(Permissions.Policy(Permissions.IntegrationManage));
        g.MapPut("/{id:guid}", Update).RequireAuthorization(Permissions.Policy(Permissions.IntegrationManage));
        g.MapDelete("/{id:guid}", Delete).RequireAuthorization(Permissions.Policy(Permissions.IntegrationManage));
        g.MapPost("/{id:guid}/check", Check).RequireAuthorization(Permissions.Policy(Permissions.IntegrationManage));

        api.MapGet("/executions/{executionId:guid}/issues", Issues).WithTags("Integrations").RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        api.MapPost("/executions/{executionId:guid}/issues", Publish).WithTags("Integrations").RequireAuthorization(Permissions.Policy(Permissions.ExecutionRun));
        api.MapPost("/executions/{executionId:guid}/publish", PublishResults).WithTags("Integrations").RequireAuthorization(Permissions.Policy(Permissions.ExecutionRun));
        return api;
    }

    // ------------------------------------------------------------------ configuration

    private static async Task<IResult> List(AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        var rows = await db.Integrations.AsNoTracking().OrderBy(i => i.Name).ToListAsync(ct);
        // people who cannot manage integrations see that one exists (to publish to it), not how it is set up
        var manage = await access.HasAsync(Permissions.IntegrationManage, ct);
        return Results.Ok(rows.Select(i => manage ? ToDto(i) : ToDto(i) with { Config = new JsonObject() }));
    }

    private static async Task<IResult> Create(SaveIntegrationRequest body, AtimthaDbContext db, TenantContext tenant, AuditWriter audit, IHostEnvironment env,
        DefectTrackers trackers, CancellationToken ct)
    {
        if (tenant.OrganizationId is not Guid org) return Api.Forbidden("Choose an organisation first.");
        var v = Validate(body, creating: true, env, trackers, out var kind, out var config);
        if (!v.IsValid) return v.Problem();

        var now = DateTimeOffset.UtcNow;
        var row = db.Integrations.Add(new Integration
        {
            Id = Guid.NewGuid(), OrganizationId = org, Kind = kind, Name = body.Name!.Trim(), Config = config!.ToJsonString(),
            CredentialSecretRef = body.CredentialSecretRef, Enabled = body.Enabled ?? false, CreatedAt = now, UpdatedAt = now,
        }).Entity;
        audit.Add("integration.create", "integration", row.Id, new { row.Name, kind = Snake(kind), row.Enabled, hasCredential = row.CredentialSecretRef is not null });
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException e) when (Api.IsUniqueViolation(e)) { return Api.Conflict($"An integration named \"{row.Name}\" already exists."); }
        return Results.Created($"/api/v1/integrations/{row.Id}", ToDto(row));
    }

    private static async Task<IResult> Update(Guid id, SaveIntegrationRequest body, HttpRequest request, AtimthaDbContext db, AuditWriter audit, IHostEnvironment env,
        DefectTrackers trackers, CancellationToken ct)
    {
        var row = await db.Integrations.FirstOrDefaultAsync(i => i.Id == id, ct);
        if (row is null) return Api.NotFound("The integration");
        if (!Api.IfMatch(request, row.UpdatedAt)) return Results.StatusCode(StatusCodes.Status412PreconditionFailed);
        var v = Validate(body with { Kind = Snake(row.Kind) }, creating: false, env, trackers, out _, out var config);
        if (!v.IsValid) return v.Problem();

        if (body.Name is not null) row.Name = body.Name.Trim();
        if (config is not null) row.Config = config.ToJsonString();
        // "" clears the credential; null keeps it
        if (body.CredentialSecretRef is not null) row.CredentialSecretRef = body.CredentialSecretRef.Length == 0 ? null : body.CredentialSecretRef;
        if (body.Enabled is bool enabled) row.Enabled = enabled;
        row.UpdatedAt = DateTimeOffset.UtcNow;
        audit.Add("integration.update", "integration", row.Id, new { row.Name, row.Enabled, hasCredential = row.CredentialSecretRef is not null });
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException e) when (Api.IsUniqueViolation(e)) { return Api.Conflict($"An integration named \"{row.Name}\" already exists."); }
        request.HttpContext.Response.Headers.ETag = Api.ETag(row.UpdatedAt);
        return Results.Ok(ToDto(row));
    }

    private static async Task<IResult> Delete(Guid id, AtimthaDbContext db, AuditWriter audit, CancellationToken ct)
    {
        var row = await db.Integrations.FirstOrDefaultAsync(i => i.Id == id, ct);
        if (row is null) return Api.NotFound("The integration");
        db.Integrations.Remove(row);
        audit.Add("integration.delete", "integration", row.Id, new { row.Name });
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> Check(Guid id, AtimthaDbContext db, SecretResolver secrets, DefectTrackers trackers, CancellationToken ct)
    {
        var row = await db.Integrations.AsNoTracking().FirstOrDefaultAsync(i => i.Id == id, ct);
        if (row is null) return Api.NotFound("The integration");
        if (!trackers.Knows(row.Kind)) return Api.Conflict("This kind of integration cannot be checked in this version.");
        var token = secrets.Resolve(row.CredentialSecretRef);
        if (token is null) return Results.Ok(new CheckResultDto(false, null, "The credential reference does not resolve on the platform."));
        try { return Results.Ok(new CheckResultDto(true, await trackers.CheckAsync(row.Kind, row.Config, token, ct), null)); }
        catch (Exception e) when (e is TrackerException or HttpRequestException or TaskCanceledException)
        {
            return Results.Ok(new CheckResultDto(false, null, e.Message));
        }
    }

    // ------------------------------------------------------------------ publishing failures

    private static async Task<IResult> Issues(Guid executionId, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        var run = await db.Executions.AsNoTracking().FirstOrDefaultAsync(e => e.Id == executionId, ct);
        if (run is null || await ProjectEndpoints.Visible(run.ProjectId, Permissions.ProjectView, db, access, ct) is null) return Api.NotFound("The run");
        var rows = await (
            from i in db.IntegrationIssues.AsNoTracking().Where(i => i.ExecutionId == executionId)
            join r in db.Results.AsNoTracking() on i.TestResultId equals r.Id
            orderby i.CreatedAt
            select new IssueDto(r.Id, r.Title, i.IssueKey, i.IssueUrl, i.CreatedAt)).ToListAsync(ct);
        return Results.Ok(rows);
    }

    private static async Task<IResult> Publish(Guid executionId, PublishRequest body, AtimthaDbContext db, AccessService access, TenantContext tenant,
        SecretResolver secrets, DefectTrackers trackers, AuditWriter audit, IConfiguration configuration, CancellationToken ct)
    {
        var run = await db.Executions.AsNoTracking().FirstOrDefaultAsync(e => e.Id == executionId, ct);
        if (run is null) return Api.NotFound("The run");
        var project = await ProjectEndpoints.Visible(run.ProjectId, Permissions.ProjectView, db, access, ct);
        if (project is null) return Api.NotFound("The run");
        if (!await access.HasInWorkspaceAsync(Permissions.ExecutionRun, project.WorkspaceId, ct)) return Api.Forbidden("You cannot publish results of this project.");

        var integration = await db.Integrations.AsNoTracking().FirstOrDefaultAsync(i => i.Id == body.IntegrationId, ct);
        if (integration is null) return Api.NotFound("The integration");
        if (trackers.For(integration.Kind) is not { } tracker) return Api.Conflict("This kind of integration cannot receive defects.");
        if (!integration.Enabled) return Api.Conflict($"The integration \"{integration.Name}\" is switched off.");
        if (!await FlagOnAsync(db, tenant.OrganizationId, tracker.Flag, ct)) return Api.Conflict($"This integration is switched off for this organisation ({tracker.Flag}).");
        var token = secrets.Resolve(integration.CredentialSecretRef);
        if (token is null) return Api.Conflict("The integration's credential reference does not resolve on the platform.");

        var failedStatuses = new[] { ResultStatus.Failed, ResultStatus.TimedOut, ResultStatus.Interrupted };
        var runIds = await Shards.RunIdsAsync(db, executionId, ct);
        var q = db.Results.AsNoTracking().Where(r => runIds.Contains(r.ExecutionId) && failedStatuses.Contains(r.Status));
        if (body.ResultIds is { Count: > 0 } ids) q = q.Where(r => ids.Contains(r.Id));
        var failed = await q.OrderBy(r => r.Module).ThenBy(r => r.Title).ToListAsync(ct);
        var filed = (await db.IntegrationIssues.AsNoTracking().Where(i => i.IntegrationId == integration.Id && i.ExecutionId == executionId)
            .Select(i => i.TestResultId).ToListAsync(ct)).ToHashSet();

        var envKey = await db.Environments.AsNoTracking().Where(e => e.Id == run.EnvironmentId).Select(e => e.Key).FirstOrDefaultAsync(ct) ?? "?";
        var runUrl = configuration["Platform:PublicUrl"] is { Length: > 0 } baseUrl ? $"{baseUrl.TrimEnd('/')}/runs/{run.Id}" : null;

        var created = new List<IssueDto>();
        var errors = new List<PublishFailureDto>();
        foreach (var r in failed.Where(r => !filed.Contains(r.Id)))
        {
            try
            {
                var issue = await tracker.CreateAsync(integration.Config, token, new DefectReport(project.Key, project.Name, envKey, run, r, runUrl), ct);
                var link = db.IntegrationIssues.Add(new IntegrationIssue
                {
                    Id = Guid.NewGuid(), OrganizationId = integration.OrganizationId, IntegrationId = integration.Id, TestResultId = r.Id,
                    ExecutionId = executionId, IssueKey = issue.Key, IssueUrl = issue.Url, CreatedBy = tenant.UserId, CreatedAt = DateTimeOffset.UtcNow,
                }).Entity;
                // save per issue: an issue that exists in the tracker is never forgotten because a later one failed
                await db.SaveChangesAsync(ct);
                created.Add(new IssueDto(r.Id, r.Title, link.IssueKey, link.IssueUrl, link.CreatedAt));
            }
            catch (Exception e) when (e is TrackerException or HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
            {
                errors.Add(new PublishFailureDto(r.Id, r.Title, e.Message));
                if (e is TrackerException { Status: 401 or 403 }) break;   // the remaining ones would fail the same way
            }
        }

        audit.Add("execution.publish_issues", "execution", run.Id, new
        {
            integration = integration.Name, created = created.Select(c => c.IssueKey).ToList(), alreadyFiled = failed.Count(r => filed.Contains(r.Id)), failed = errors.Count,
        });
        await db.SaveChangesAsync(ct);
        return Results.Ok(new PublishResultDto(created, failed.Count(r => filed.Contains(r.Id)), errors));
    }

    public sealed record PublishResultsRequest(Guid IntegrationId);
    public sealed record PublishedRunDto(string Integration, string RunId, string Url, int Published, int NotLinked);

    /// <summary>
    /// The run's results → a test-management tool (TestRail): one test run there, one result per linked case.
    /// A result is linked by a C123 tag on its data row, else on its test case; unlinked results are counted, not sent.
    /// </summary>
    private static async Task<IResult> PublishResults(Guid executionId, PublishResultsRequest body, AtimthaDbContext db, AccessService access, TenantContext tenant,
        SecretResolver secrets, DefectTrackers trackers, AuditWriter audit, IConfiguration configuration, CancellationToken ct)
    {
        var run = await db.Executions.AsNoTracking().FirstOrDefaultAsync(e => e.Id == executionId, ct);
        if (run is null) return Api.NotFound("The run");
        var project = await ProjectEndpoints.Visible(run.ProjectId, Permissions.ProjectView, db, access, ct);
        if (project is null) return Api.NotFound("The run");
        if (!await access.HasInWorkspaceAsync(Permissions.ExecutionRun, project.WorkspaceId, ct)) return Api.Forbidden("You cannot publish results of this project.");
        if (run.FinishedAt is null) return Api.Conflict("The run has not finished yet.");

        var integration = await db.Integrations.AsNoTracking().FirstOrDefaultAsync(i => i.Id == body.IntegrationId, ct);
        if (integration is null) return Api.NotFound("The integration");
        if (trackers.Publisher(integration.Kind) is not { } publisher) return Api.Conflict("This kind of integration does not receive run results.");
        if (!integration.Enabled) return Api.Conflict($"The integration \"{integration.Name}\" is switched off.");
        if (!await FlagOnAsync(db, tenant.OrganizationId, publisher.Flag, ct)) return Api.Conflict($"This integration is switched off for this organisation ({publisher.Flag}).");
        var token = secrets.Resolve(integration.CredentialSecretRef);
        if (token is null) return Api.Conflict("The integration's credential reference does not resolve on the platform.");

        var runIds = await Shards.RunIdsAsync(db, executionId, ct);
        var results = await db.Results.AsNoTracking().Where(r => runIds.Contains(r.ExecutionId)).ToListAsync(ct);
        var caseTags = await db.Cases.AsNoTracking().Where(c => c.ProjectId == run.ProjectId).ToDictionaryAsync(c => c.Id, c => c.Tags, ct);
        var rowIds = results.Where(r => r.DataRowId != null).Select(r => r.DataRowId!.Value).ToList();
        var rowTags = await db.DataRows.AsNoTracking().Where(r => rowIds.Contains(r.Id)).ToDictionaryAsync(r => r.Id, r => r.Tags, ct);
        static long? Linked(string[]? tags) =>
            (tags ?? []).Select(t => TestRailPublisher.CaseTag().Match(t)).Where(m => m.Success).Select(m => (long?)long.Parse(m.Groups[1].Value)).FirstOrDefault();

        var published = new List<PublishedResult>();
        var notLinked = 0;
        foreach (var r in results)
        {
            var id = Linked(r.DataRowId is Guid d ? rowTags.GetValueOrDefault(d) : null) ?? Linked(r.CaseId is Guid c ? caseTags.GetValueOrDefault(c) : null);
            if (id is null) { notLinked++; continue; }
            published.Add(new PublishedResult(id.Value, r.Status, r.Flaky, r.Title, r.Error, r.DurationMs,
                r.Category is { } cat ? ExecutionEndpoints.Snake(cat.ToString()) : null));
        }
        var envKey = await db.Environments.AsNoTracking().Where(e => e.Id == run.EnvironmentId).Select(e => e.Key).FirstOrDefaultAsync(ct) ?? "?";
        var runUrl = configuration["Platform:PublicUrl"] is { Length: > 0 } baseUrl ? $"{baseUrl.TrimEnd('/')}/runs/{run.Id}" : null;
        try
        {
            var (externalId, url) = await publisher.PublishAsync(integration.Config, token, new RunReport(project.Key, project.Name, envKey, run, published, runUrl), ct);
            audit.Add("execution.publish_results", "execution", run.Id, new { integration = integration.Name, externalRun = externalId, published = published.Count, notLinked });
            await db.SaveChangesAsync(ct);
            return Results.Ok(new PublishedRunDto(integration.Name, externalId, url, published.Select(p => p.CaseId).Distinct().Count(), notLinked));
        }
        catch (Exception e) when (e is TrackerException or HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            return Results.Problem(statusCode: StatusCodes.Status502BadGateway, title: "Not published", detail: e.Message);
        }
    }

    // ------------------------------------------------------------------ helpers

    /// <summary>Organisation override, else platform default, else on.</summary>
    internal static async Task<bool> FlagOnAsync(AtimthaDbContext db, Guid? org, string key, CancellationToken ct)
    {
        var flags = await db.FeatureFlags.AsNoTracking().Where(f => f.Key == key && (f.OrganizationId == null || f.OrganizationId == org)).ToListAsync(ct);
        return (flags.FirstOrDefault(f => f.OrganizationId == org) ?? flags.FirstOrDefault(f => f.OrganizationId == null))?.Enabled ?? true;
    }

    private static Api.Validation Validate(SaveIntegrationRequest body, bool creating, IHostEnvironment env, DefectTrackers trackers,
        out IntegrationKind kind, out JsonObject? config)
    {
        var v = new Api.Validation();
        config = null;
        var parsed = DefectTrackers.ParseKind(body.Kind);
        kind = parsed ?? IntegrationKind.Jira;
        v.Require(parsed is not null, "kind", "Use \"jira\", \"azure_devops\" or \"testrail\".");
        v.Text(body.Name, "name", 100, required: creating);
        v.Require(body.CredentialSecretRef is null || body.CredentialSecretRef.Length == 0 || SecretResolver.IsReference(body.CredentialSecretRef),
            "credentialSecretRef", "Send a secrets-manager reference (vault:env/NAME or vault:file/name), never the token itself.");
        v.Require(!creating || body.Config is not null, "config", "Required.");
        if (body.Config is null || parsed is null) return v;

        // the platform calls this address with a credential: https only, except while developing
        foreach (var (field, message) in trackers.Validate(kind, body.Config, env.IsDevelopment(), out config)) v.Require(false, field, message);
        return v;
    }

    private static IntegrationDto ToDto(Integration i) =>
        new(i.Id, Snake(i.Kind), i.Name, JsonNode.Parse(i.Config) as JsonObject ?? new JsonObject(), i.CredentialSecretRef is not null, i.Enabled, i.UpdatedAt);

    private static string Snake(IntegrationKind k) => AtimthaDbContext.ToSnakeCase(k.ToString());
}
