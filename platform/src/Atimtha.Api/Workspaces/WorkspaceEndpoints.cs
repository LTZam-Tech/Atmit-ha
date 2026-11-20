using Atimtha.Api.Identity;
using Atimtha.Api.Infrastructure;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.Workspaces;

using Api = Atimtha.Api.Infrastructure.Api;

public sealed record WorkspaceDto(Guid Id, string Key, string Name, DateTimeOffset CreatedAt);
public sealed record CreateWorkspaceRequest(string? Key, string? Name);
public sealed record RenameWorkspaceRequest(string? Name);

/// <summary>/api/v1/workspaces — workspaces of the current organisation.</summary>
public static class WorkspaceEndpoints
{
    public static RouteGroupBuilder MapWorkspaces(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/workspaces").WithTags("Workspaces");
        g.MapGet("/", List).RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        g.MapPost("/", Create).RequireAuthorization(Permissions.Policy(Permissions.WorkspaceManage));
        g.MapPatch("/{key}", Rename).RequireAuthorization(Permissions.Policy(Permissions.WorkspaceManage));
        g.MapDelete("/{key}", Archive).RequireAuthorization(Permissions.Policy(Permissions.WorkspaceManage));
        return api;
    }

    private static async Task<IResult> List(AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        var scope = await access.ScopeAsync(Permissions.ProjectView, ct);
        var ids = scope.WorkspaceIds.ToList();
        var items = await db.Workspaces.AsNoTracking()
            .Where(w => w.ArchivedAt == null && (scope.AllWorkspaces || ids.Contains(w.Id)))
            .OrderBy(w => w.Name)
            .Select(w => new WorkspaceDto(w.Id, w.Key, w.Name, w.CreatedAt))
            .ToListAsync(ct);
        return Results.Ok(items);
    }

    private static async Task<IResult> Create(CreateWorkspaceRequest body, AtimthaDbContext db, AccessService access, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        // creating workspaces is an organisation-wide right, not one held inside a single workspace
        if (!(await access.ScopeAsync(Permissions.WorkspaceManage, ct)).AllWorkspaces)
            return Api.Forbidden("Creating workspaces needs an organisation-wide role.");

        var v = new Api.Validation().Key(body.Key).Text(body.Name, "name", 200);
        if (!v.IsValid) return v.Problem();

        var ws = new Workspace
        {
            Id = Guid.NewGuid(),
            OrganizationId = tenant.OrganizationId!.Value,
            Key = body.Key!,
            Name = body.Name!.Trim(),
            CreatedAt = DateTimeOffset.UtcNow,
        };
        db.Workspaces.Add(ws);
        audit.Add("workspace.create", "workspace", ws.Id, new { ws.Key, ws.Name });
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException e) when (Api.IsUniqueViolation(e)) { return Api.Conflict($"A workspace with the key \"{ws.Key}\" already exists."); }

        return Results.Created($"/api/v1/workspaces/{ws.Key}", new WorkspaceDto(ws.Id, ws.Key, ws.Name, ws.CreatedAt));
    }

    private static async Task<IResult> Rename(string key, RenameWorkspaceRequest body, AtimthaDbContext db, AccessService access, AuditWriter audit, CancellationToken ct)
    {
        if (!(await access.ScopeAsync(Permissions.WorkspaceManage, ct)).AllWorkspaces)
            return Api.Forbidden("Renaming workspaces needs an organisation-wide role.");
        var v = new Api.Validation().Text(body.Name, "name", 200);
        if (!v.IsValid) return v.Problem();
        var ws = await db.Workspaces.FirstOrDefaultAsync(w => w.Key == key && w.ArchivedAt == null, ct);
        if (ws is null) return Api.NotFound("The workspace");
        var before = ws.Name;
        ws.Name = body.Name!.Trim();
        audit.Add("workspace.rename", "workspace", ws.Id, new { ws.Key, from = before, to = ws.Name });
        await db.SaveChangesAsync(ct);
        return Results.Ok(new WorkspaceDto(ws.Id, ws.Key, ws.Name, ws.CreatedAt));
    }

    /// <summary>archives (sets archived_at); refused while the workspace still holds active projects</summary>
    private static async Task<IResult> Archive(string key, AtimthaDbContext db, AccessService access, AuditWriter audit, CancellationToken ct)
    {
        if (!(await access.ScopeAsync(Permissions.WorkspaceManage, ct)).AllWorkspaces)
            return Api.Forbidden("Archiving workspaces needs an organisation-wide role.");
        var ws = await db.Workspaces.FirstOrDefaultAsync(w => w.Key == key && w.ArchivedAt == null, ct);
        if (ws is null) return Api.NotFound("The workspace");
        var active = await db.Projects.CountAsync(p => p.WorkspaceId == ws.Id && p.ArchivedAt == null, ct);
        if (active > 0)
            return Api.Conflict($"The workspace still has {active} active project(s). Archive or move them first.");
        ws.ArchivedAt = DateTimeOffset.UtcNow;
        audit.Add("workspace.archive", "workspace", ws.Id, new { ws.Key, ws.Name });
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }
}
