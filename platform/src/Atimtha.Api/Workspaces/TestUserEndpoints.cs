using Atimtha.Api.Identity;
using Atimtha.Api.Infrastructure;
using Atimtha.Api.TestAssets;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.Workspaces;

using Api = Atimtha.Api.Infrastructure.Api;

public sealed record TestUserDto(string Key, string Username, string? Description, bool HasPassword);

/// <summary>Password = a secrets-manager reference (vault:…); the platform never stores or returns a password.</summary>
public sealed record PutTestUserRequest(string? Username, string? Description, string? PasswordSecretRef);

/// <summary>/api/v1/projects/{id}/users — the application's test users ({{user.&lt;key&gt;.username|password}}).</summary>
public static class TestUserEndpoints
{
    public static RouteGroupBuilder MapTestUsers(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/projects/{projectId:guid}/users").WithTags("Test users");
        g.MapGet("/", List).RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        g.MapPut("/{key}", Put).RequireAuthorization(Permissions.Policy(Permissions.ProjectEdit));
        g.MapDelete("/{key}", Delete).RequireAuthorization(Permissions.Policy(Permissions.ProjectEdit));
        return api;
    }

    private static async Task<IResult> List(Guid projectId, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        if (await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct) is null) return Api.NotFound("The project");
        var users = await db.TestUsers.AsNoTracking().Where(u => u.ProjectId == projectId).OrderBy(u => u.Key).ToListAsync(ct);
        return Results.Ok(users.Select(u => new TestUserDto(u.Key, u.Username, u.Description, u.PasswordSecretRef is not null)));
    }

    private static async Task<IResult> Put(Guid projectId, string key, PutTestUserRequest body, AtimthaDbContext db, AccessService access, AuditWriter audit, CancellationToken ct)
    {
        var project = await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct);
        if (project is null) return Api.NotFound("The project");
        if (!await access.HasInWorkspaceAsync(Permissions.ProjectEdit, project.WorkspaceId, ct)) return Api.Forbidden("You cannot edit this project.");
        var v = new Api.Validation()
            .Require(Api.AttributePattern().IsMatch(key), "key", "Use letters, digits, \"-\" or \"_\", starting with a letter.")
            .Text(body.Username, "username", 200)
            .Text(body.Description, "description", 500, required: false)
            .Require(body.PasswordSecretRef is null || body.PasswordSecretRef.StartsWith("vault:", StringComparison.Ordinal),
                "passwordSecretRef", "Send a secrets-manager reference (vault:env/NAME or vault:file/name), never the password itself.");
        if (!v.IsValid) return v.Problem();

        var user = await db.TestUsers.FirstOrDefaultAsync(u => u.ProjectId == projectId && u.Key == key, ct);
        var created = user is null;
        user ??= db.TestUsers.Add(new TestUser { Id = Guid.NewGuid(), OrganizationId = project.OrganizationId, ProjectId = projectId, Key = key }).Entity;
        user.Username = body.Username!.Trim();
        user.Description = body.Description;
        user.PasswordSecretRef = body.PasswordSecretRef;
        audit.Add(created ? "test_user.create" : "test_user.update", "test_user", user.Id, new { project = project.Key, key, hasPassword = user.PasswordSecretRef is not null });
        await db.SaveChangesAsync(ct);
        var dto = new TestUserDto(user.Key, user.Username, user.Description, user.PasswordSecretRef is not null);
        return created ? Results.Created($"/api/v1/projects/{projectId}/users/{key}", dto) : Results.Ok(dto);
    }

    private static async Task<IResult> Delete(Guid projectId, string key, AtimthaDbContext db, AccessService access, AuditWriter audit, CancellationToken ct)
    {
        var project = await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct);
        if (project is null) return Api.NotFound("The project");
        if (!await access.HasInWorkspaceAsync(Permissions.ProjectEdit, project.WorkspaceId, ct)) return Api.Forbidden("You cannot edit this project.");
        var user = await db.TestUsers.FirstOrDefaultAsync(u => u.ProjectId == projectId && u.Key == key, ct);
        if (user is null) return Api.NotFound("The user");
        var used = await db.Pages.AnyAsync(p => p.AuthUserId == user.Id, ct) || await db.Cases.AnyAsync(c => c.StartUserId == user.Id, ct)
            || await db.WorkflowSteps.AnyAsync(s => s.RunAsUserId == user.Id, ct);
        if (used) return Api.Conflict($"User \"{key}\" is used by pages, cases or workflows. Change those first.");
        db.TestUsers.Remove(user);
        audit.Add("test_user.delete", "test_user", user.Id, new { project = project.Key, key });
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }
}
