using Atimtha.Api.Identity;
using Atimtha.Api.Infrastructure;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.Workspaces;

using Api = Atimtha.Api.Infrastructure.Api;

public sealed record EnvironmentDto(string Key, string BaseUrl, bool IsDefault, bool StartDemoApp, bool IgnoreHttpsErrors, string? HttpUsername, bool HasHttpPassword)
{
    public static EnvironmentDto From(ProjectEnvironment e) =>
        new(e.Key, e.BaseUrl, e.IsDefault, e.StartDemoApp, e.IgnoreHttpsErrors, e.HttpUsername, e.HttpPasswordSecretRef is not null);
}

/// <summary>
/// Create or replace an environment. The basic-auth password is never accepted here in plain text:
/// it is stored in the secrets manager first and only its reference is sent (backlog §13).
/// </summary>
public sealed record PutEnvironmentRequest(string? BaseUrl, bool? IsDefault, bool? StartDemoApp, bool? IgnoreHttpsErrors, string? HttpUsername, string? HttpPasswordSecretRef);

/// <summary>/api/v1/projects/{id}/environments</summary>
public static class EnvironmentEndpoints
{
    public static RouteGroupBuilder MapEnvironments(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/projects/{projectId:guid}/environments").WithTags("Environments");
        g.MapGet("/", List).RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        g.MapPut("/{key}", Put).RequireAuthorization(Permissions.Policy(Permissions.ProjectEdit));
        g.MapDelete("/{key}", Delete).RequireAuthorization(Permissions.Policy(Permissions.ProjectEdit));
        return api;
    }

    private static async Task<IResult> List(Guid projectId, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        var project = await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct);
        if (project is null) return Api.NotFound("The project");
        var envs = await db.Environments.AsNoTracking().Where(e => e.ProjectId == projectId).OrderBy(e => e.Key).ToListAsync(ct);
        return Results.Ok(envs.Select(EnvironmentDto.From));
    }

    private static async Task<IResult> Put(Guid projectId, string key, PutEnvironmentRequest body, AtimthaDbContext db, AccessService access, AuditWriter audit, CancellationToken ct)
    {
        var project = await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct);
        if (project is null) return Api.NotFound("The project");
        if (!await access.HasInWorkspaceAsync(Permissions.ProjectEdit, project.WorkspaceId, ct)) return Api.Forbidden("You cannot edit this project.");

        var v = new Api.Validation()
            .Require(Api.AttributePattern().IsMatch(key), "key", "Use letters, digits, \"-\" or \"_\", starting with a letter.")
            .HttpUrl(body.BaseUrl, "baseUrl")
            .Text(body.HttpUsername, "httpUsername", 200, required: false)
            .Require(body.HttpPasswordSecretRef is null || body.HttpPasswordSecretRef.StartsWith("vault:", StringComparison.Ordinal),
                "httpPasswordSecretRef", "Send a secrets-manager reference (vault:…), never the password itself.");
        if (!v.IsValid) return v.Problem();

        var env = await db.Environments.FirstOrDefaultAsync(e => e.ProjectId == projectId && e.Key == key, ct);
        var created = env is null;
        env ??= db.Environments.Add(new ProjectEnvironment
        {
            Id = Guid.NewGuid(), OrganizationId = project.OrganizationId, ProjectId = projectId, Key = key,
        }).Entity;

        env.BaseUrl = body.BaseUrl!;
        env.StartDemoApp = body.StartDemoApp ?? false;
        env.IgnoreHttpsErrors = body.IgnoreHttpsErrors ?? false;
        env.HttpUsername = body.HttpUsername;
        env.HttpPasswordSecretRef = body.HttpPasswordSecretRef;

        // exactly one default per project: the first environment, or the one marked default
        var others = await db.Environments.Where(e => e.ProjectId == projectId && e.Key != key).ToListAsync(ct);
        if (body.IsDefault == true || others.Count == 0)
        {
            foreach (var o in others.Where(o => o.IsDefault)) o.IsDefault = false;
            env.IsDefault = true;
        }
        else if (body.IsDefault == false && env.IsDefault)
        {
            return Api.Conflict("A project needs a default environment: mark another environment as default instead.");
        }

        audit.Add(created ? "environment.create" : "environment.update", "environment", env.Id,
            new { project = project.Key, env.Key, env.BaseUrl, env.IsDefault, basicAuth = env.HttpUsername is not null });
        // the default flag moves in two steps so the "one default" unique index never sees two at once
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var newDefault = env.IsDefault;
        if (newDefault) env.IsDefault = false;
        await db.SaveChangesAsync(ct);
        if (newDefault)
        {
            env.IsDefault = true;
            await db.SaveChangesAsync(ct);
        }
        await tx.CommitAsync(ct);

        return created ? Results.Created($"/api/v1/projects/{projectId}/environments/{key}", EnvironmentDto.From(env)) : Results.Ok(EnvironmentDto.From(env));
    }

    private static async Task<IResult> Delete(Guid projectId, string key, AtimthaDbContext db, AccessService access, AuditWriter audit, CancellationToken ct)
    {
        var project = await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct);
        if (project is null) return Api.NotFound("The project");
        if (!await access.HasInWorkspaceAsync(Permissions.ProjectEdit, project.WorkspaceId, ct)) return Api.Forbidden("You cannot edit this project.");
        var env = await db.Environments.FirstOrDefaultAsync(e => e.ProjectId == projectId && e.Key == key, ct);
        if (env is null) return Api.NotFound("The environment");
        if (env.IsDefault && await db.Environments.AnyAsync(e => e.ProjectId == projectId && e.Key != key, ct))
            return Api.Conflict("This is the default environment: make another one the default first.");
        // runs and schedules keep pointing at their environment (history and reports)
        if (await db.Executions.AnyAsync(e => e.EnvironmentId == env.Id, ct))
            return Api.Conflict("Runs were made on this environment; it stays so their results keep their context.");
        if (await db.Schedules.AnyAsync(s => s.EnvironmentId == env.Id, ct))
            return Api.Conflict("A schedule runs on this environment: change or delete the schedule first.");
        db.Environments.Remove(env);
        audit.Add("environment.delete", "environment", env.Id, new { project = project.Key, env.Key });
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }
}
