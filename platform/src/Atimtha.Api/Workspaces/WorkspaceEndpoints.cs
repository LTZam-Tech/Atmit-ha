using Atimtha.Api.Identity;
using Atimtha.Api.Infrastructure;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.Workspaces;

public sealed record WorkspaceDto(Guid Id, string Key, string Name, DateTimeOffset CreatedAt);
public sealed record CreateWorkspaceRequest(string? Key, string? Name);

/// <summary>/api/v1/workspaces — workspaces of the current organisation.</summary>
public static class WorkspaceEndpoints
{
    public static RouteGroupBuilder MapWorkspaces(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/workspaces").WithTags("Workspaces");
        g.MapGet("/", List).RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        g.MapPost("/", Create).RequireAuthorization(Permissions.Policy(Permissions.WorkspaceManage));
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
}
