using Atimtha.Api.Identity;
using Atimtha.Api.Infrastructure;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.Workspaces;

public sealed record ProjectDto(
    Guid Id, Guid WorkspaceId, string Key, string Name, string? Description, string TestIdAttribute, string[] Languages,
    string HealingPolicy, RunSettingsDto Run, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt)
{
    public static ProjectDto From(Project p) => new(
        p.Id, p.WorkspaceId, p.Key, p.Name, p.Description, p.TestIdAttribute, p.Languages,
        p.HealingPolicy.ToString().ToLowerInvariant(),
        new RunSettingsDto(p.RunWorkers, p.RunRetries, p.RunTestTimeoutS, p.RunWaitTimeoutS),
        p.CreatedAt, p.UpdatedAt);
}

/// <summary>Same limits as 0.1.0's app.schema.json (run: workers, retries, testTimeout, waitTimeout).</summary>
public sealed record RunSettingsDto(short? Workers, short? Retries, short? TestTimeoutSeconds, short? WaitTimeoutSeconds);

public sealed record CreateProjectRequest(string? Key, string? Name, string? Description, string? TestIdAttribute, string[]? Languages, string? HealingPolicy, RunSettingsDto? Run);

/// <summary>PATCH body: only the fields sent are changed.</summary>
public sealed record UpdateProjectRequest(string? Name, string? Description, string? TestIdAttribute, string[]? Languages, string? HealingPolicy, RunSettingsDto? Run);

/// <summary>/api/v1/workspaces/{key}/projects and /api/v1/projects/{id}.</summary>
public static class ProjectEndpoints
{
    public static RouteGroupBuilder MapProjects(this RouteGroupBuilder api)
    {
        var ws = api.MapGroup("/workspaces/{workspaceKey}/projects").WithTags("Projects");
        ws.MapGet("/", List).RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        ws.MapPost("/", Create).RequireAuthorization(Permissions.Policy(Permissions.ProjectEdit));

        var p = api.MapGroup("/projects/{projectId:guid}").WithTags("Projects");
        p.MapGet("/", Get).RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        p.MapPatch("/", Update).RequireAuthorization(Permissions.Policy(Permissions.ProjectEdit));
        p.MapDelete("/", Archive).RequireAuthorization(Permissions.Policy(Permissions.ProjectDelete));
        return api;
    }

    private static async Task<IResult> List(string workspaceKey, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        var ws = await db.Workspaces.AsNoTracking().FirstOrDefaultAsync(w => w.Key == workspaceKey && w.ArchivedAt == null, ct);
        if (ws is null || !await access.HasInWorkspaceAsync(Permissions.ProjectView, ws.Id, ct)) return Api.NotFound("The workspace");
        var items = await db.Projects.AsNoTracking()
            .Where(p => p.WorkspaceId == ws.Id && p.ArchivedAt == null)
            .OrderBy(p => p.Name)
            .ToListAsync(ct);
        return Results.Ok(items.Select(ProjectDto.From));
    }

    private static async Task<IResult> Create(string workspaceKey, CreateProjectRequest body, AtimthaDbContext db, AccessService access, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        var ws = await db.Workspaces.AsNoTracking().FirstOrDefaultAsync(w => w.Key == workspaceKey && w.ArchivedAt == null, ct);
        if (ws is null || !await access.HasInWorkspaceAsync(Permissions.ProjectView, ws.Id, ct)) return Api.NotFound("The workspace");
        if (!await access.HasInWorkspaceAsync(Permissions.ProjectEdit, ws.Id, ct)) return Api.Forbidden("You cannot create projects in this workspace.");

        var v = new Api.Validation().Key(body.Key).Text(body.Name, "name", 200).Text(body.Description, "description", 2000, required: false);
        ValidateSettings(v, body.TestIdAttribute, body.Languages, body.HealingPolicy, body.Run);
        if (!v.IsValid) return v.Problem();

        var now = DateTimeOffset.UtcNow;
        var project = new Project
        {
            Id = Guid.NewGuid(),
            OrganizationId = tenant.OrganizationId!.Value,
            WorkspaceId = ws.Id,
            Key = body.Key!,
            Name = body.Name!.Trim(),
            Description = body.Description,
            TestIdAttribute = body.TestIdAttribute ?? "data-testid",
            Languages = body.Languages is { Length: > 0 } ? body.Languages.Distinct().ToArray() : ["en"],
            HealingPolicy = ParseHealing(body.HealingPolicy) ?? HealingPolicy.Pass,
            CreatedBy = tenant.UserId,
            CreatedAt = now,
            UpdatedAt = now,
        };
        ApplyRun(project, body.Run);
        db.Projects.Add(project);
        audit.Add("project.create", "project", project.Id, new { project.Key, project.Name, workspace = ws.Key });
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException e) when (Api.IsUniqueViolation(e)) { return Api.Conflict($"A project with the key \"{project.Key}\" already exists in this workspace."); }

        return Results.Created($"/api/v1/projects/{project.Id}", ProjectDto.From(project));
    }

    private static async Task<IResult> Get(Guid projectId, HttpResponse response, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        var project = await Visible(projectId, Permissions.ProjectView, db, access, ct);
        if (project is null) return Api.NotFound("The project");
        response.Headers.ETag = Api.ETag(project.UpdatedAt);
        return Results.Ok(ProjectDto.From(project));
    }

    private static async Task<IResult> Update(Guid projectId, UpdateProjectRequest body, HttpRequest request, HttpResponse response, AtimthaDbContext db, AccessService access, AuditWriter audit, CancellationToken ct)
    {
        var project = await Visible(projectId, Permissions.ProjectView, db, access, ct, track: true);
        if (project is null) return Api.NotFound("The project");
        if (!await access.HasInWorkspaceAsync(Permissions.ProjectEdit, project.WorkspaceId, ct)) return Api.Forbidden("You cannot edit this project.");
        if (!Api.IfMatch(request, project.UpdatedAt))
            return Results.Problem(statusCode: StatusCodes.Status412PreconditionFailed, title: "Changed meanwhile", detail: "Someone else changed this project. Reload it and apply your change again.");

        var v = new Api.Validation()
            .Text(body.Name, "name", 200, required: false)
            .Require(body.Name is null || !string.IsNullOrWhiteSpace(body.Name), "name", "Cannot be empty.")
            .Text(body.Description, "description", 2000, required: false);
        ValidateSettings(v, body.TestIdAttribute, body.Languages, body.HealingPolicy, body.Run);
        if (!v.IsValid) return v.Problem();

        if (body.Name is not null) project.Name = body.Name.Trim();
        if (body.Description is not null) project.Description = body.Description.Length == 0 ? null : body.Description;
        if (body.TestIdAttribute is not null) project.TestIdAttribute = body.TestIdAttribute;
        if (body.Languages is { Length: > 0 }) project.Languages = body.Languages.Distinct().ToArray();
        if (ParseHealing(body.HealingPolicy) is { } healing) project.HealingPolicy = healing;
        ApplyRun(project, body.Run);
        project.UpdatedAt = DateTimeOffset.UtcNow;

        audit.Add("project.update", "project", project.Id, body);
        await db.SaveChangesAsync(ct);
        response.Headers.ETag = Api.ETag(project.UpdatedAt);
        return Results.Ok(ProjectDto.From(project));
    }

    /// <summary>Archives (soft delete): runs, versions and audit history stay.</summary>
    private static async Task<IResult> Archive(Guid projectId, AtimthaDbContext db, AccessService access, AuditWriter audit, CancellationToken ct)
    {
        var project = await Visible(projectId, Permissions.ProjectView, db, access, ct, track: true);
        if (project is null) return Api.NotFound("The project");
        if (!await access.HasInWorkspaceAsync(Permissions.ProjectDelete, project.WorkspaceId, ct)) return Api.Forbidden("You cannot delete this project.");
        project.ArchivedAt = DateTimeOffset.UtcNow;
        project.UpdatedAt = project.ArchivedAt.Value;
        audit.Add("project.archive", "project", project.Id, new { project.Key });
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    // ---------------------------------------------------------------- helpers

    /// <summary>The project, if it exists in this organisation (RLS), is not archived, and the user may see its workspace.</summary>
    internal static async Task<Project?> Visible(Guid projectId, string permission, AtimthaDbContext db, AccessService access, CancellationToken ct, bool track = false)
    {
        var query = track ? db.Projects : db.Projects.AsNoTracking();
        var project = await query.FirstOrDefaultAsync(p => p.Id == projectId && p.ArchivedAt == null, ct);
        if (project is null) return null;
        return await access.HasInWorkspaceAsync(permission, project.WorkspaceId, ct) ? project : null;
    }

    internal static HealingPolicy? ParseHealing(string? value) => value?.ToLowerInvariant() switch
    {
        null => null,
        "pass" => HealingPolicy.Pass,
        "flag" => HealingPolicy.Flag,
        "off" => HealingPolicy.Off,
        _ => null,
    };

    internal static void ValidateSettings(Api.Validation v, string? testIdAttribute, string[]? languages, string? healing, RunSettingsDto? run)
    {
        v.Require(testIdAttribute is null || Api.AttributePattern().IsMatch(testIdAttribute), "testIdAttribute", "Use an attribute name such as data-testid.")
         .Require(languages is null || (languages.Length > 0 && languages.All(l => l is "en" or "ar")), "languages", "Use \"en\" and/or \"ar\".")
         .Require(healing is null || ParseHealing(healing) is not null, "healingPolicy", "Use pass, flag or off.");
        if (run is null) return;
        v.Require(run.Workers is null or >= 1 and <= 16, "run.workers", "1 to 16.")
         .Require(run.Retries is null or >= 0 and <= 3, "run.retries", "0 to 3.")
         .Require(run.TestTimeoutSeconds is null or >= 5 and <= 900, "run.testTimeoutSeconds", "5 to 900 seconds.")
         .Require(run.WaitTimeoutSeconds is null or >= 1 and <= 120, "run.waitTimeoutSeconds", "1 to 120 seconds.");
    }

    private static void ApplyRun(Project p, RunSettingsDto? run)
    {
        if (run is null) return;
        if (run.Workers is not null) p.RunWorkers = run.Workers;
        if (run.Retries is not null) p.RunRetries = run.Retries;
        if (run.TestTimeoutSeconds is not null) p.RunTestTimeoutS = run.TestTimeoutSeconds;
        if (run.WaitTimeoutSeconds is not null) p.RunWaitTimeoutS = run.WaitTimeoutSeconds;
    }
}
