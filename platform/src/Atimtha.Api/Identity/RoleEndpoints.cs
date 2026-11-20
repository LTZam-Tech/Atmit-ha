using System.Text.RegularExpressions;
using Atimtha.Api.Infrastructure;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.Identity;

using Api = Atimtha.Api.Infrastructure.Api;

public sealed record PermissionDto(string Key, string Description);
public sealed record SaveRoleRequest(string? Key, string? Name, string[]? Permissions);

/// <summary>
/// Custom roles (backlog §4 RBAC): an organisation administrator composes roles from the platform's permissions.
/// Built-in roles stay read-only; org.admin is never part of a custom role (only the built-in administrator role
/// carries it); a role in use cannot be deleted.
/// </summary>
public static partial class RoleEndpoints
{
    [GeneratedRegex("^[a-z][a-z0-9-]{1,40}$")]
    private static partial Regex RoleKey();

    private sealed class PermissionRow
    {
        public string Key { get; set; } = "";
        public string Description { get; set; } = "";
    }

    public static RouteGroupBuilder MapRoles(this RouteGroupBuilder api)
    {
        api.MapGet("/permissions", ListPermissions).WithTags("Members").RequireAuthorization(Permissions.Policy(Permissions.OrgAdmin));
        var g = api.MapGroup("/roles").WithTags("Members").RequireAuthorization(Permissions.Policy(Permissions.OrgAdmin));
        g.MapPost("/", Create);
        g.MapPut("/{key}", Update);
        g.MapDelete("/{key}", Delete);
        return api;
    }

    private static async Task<List<PermissionDto>> AllAsync(AtimthaDbContext db, CancellationToken ct) =>
        (await db.Database.SqlQueryRaw<PermissionRow>("SELECT key AS \"Key\", description AS \"Description\" FROM atimtha.permission ORDER BY key").ToListAsync(ct))
        .Select(p => new PermissionDto(p.Key, p.Description)).ToList();

    private static async Task<IResult> ListPermissions(AtimthaDbContext db, CancellationToken ct) => Results.Ok(await AllAsync(db, ct));

    private static async Task<IResult> Create(SaveRoleRequest body, AtimthaDbContext db, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        if (tenant.OrganizationId is not Guid org) return Api.Forbidden("Choose an organisation first.");
        var key = body.Key?.Trim().ToLowerInvariant() ?? "";
        var problem = await ValidateAsync(body, db, ct);
        if (!RoleKey().IsMatch(key)) return Results.ValidationProblem(new Dictionary<string, string[]> { ["key"] = ["Lowercase letters, digits and -, 2 to 41 characters."] });
        if (problem is not null) return problem;
        if (await db.Roles.AnyAsync(r => r.Key == key && (r.OrganizationId == null || r.OrganizationId == org), ct)) return Api.Conflict($"A role \"{key}\" already exists.");

        var role = new Role { Id = Guid.NewGuid(), OrganizationId = org, Key = key, Name = body.Name!.Trim(), BuiltIn = false };
        role.Permissions = body.Permissions!.Distinct().Select(p => new RolePermission { RoleId = role.Id, PermissionKey = p }).ToList();
        db.Roles.Add(role);
        audit.Add("role.create", "role", role.Id, new { key, role.Name, permissions = body.Permissions });
        await db.SaveChangesAsync(ct);
        return Results.Created($"/api/v1/roles/{key}", new RoleDto(role.Key, role.Name, false, role.Permissions.Select(p => p.PermissionKey).Order().ToList()));
    }

    private static async Task<IResult> Update(string key, SaveRoleRequest body, AtimthaDbContext db, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        var role = await db.Roles.Include(r => r.Permissions).FirstOrDefaultAsync(r => r.Key == key && r.OrganizationId == tenant.OrganizationId && !r.BuiltIn, ct);
        if (role is null) return Api.NotFound("The custom role");
        var problem = await ValidateAsync(body, db, ct);
        if (problem is not null) return problem;
        role.Name = body.Name!.Trim();
        db.RolePermissions.RemoveRange(role.Permissions);
        await db.SaveChangesAsync(ct);
        foreach (var p in body.Permissions!.Distinct()) db.RolePermissions.Add(new RolePermission { RoleId = role.Id, PermissionKey = p });
        audit.Add("role.update", "role", role.Id, new { key, role.Name, permissions = body.Permissions });
        await db.SaveChangesAsync(ct);
        return Results.Ok(new RoleDto(role.Key, role.Name, false, body.Permissions!.Distinct().Order().ToList()));
    }

    private static async Task<IResult> Delete(string key, AtimthaDbContext db, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        var role = await db.Roles.FirstOrDefaultAsync(r => r.Key == key && r.OrganizationId == tenant.OrganizationId && !r.BuiltIn, ct);
        if (role is null) return Api.NotFound("The custom role");
        var inUse = await db.Memberships.CountAsync(m => m.RoleId == role.Id, ct);
        if (inUse > 0) return Api.Conflict($"{inUse} member(s) still have this role. Give them another role first.");
        db.Roles.Remove(role);
        audit.Add("role.delete", "role", role.Id, new { key });
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult?> ValidateAsync(SaveRoleRequest body, AtimthaDbContext db, CancellationToken ct)
    {
        var known = (await AllAsync(db, ct)).Select(p => p.Key).ToHashSet();
        var perms = body.Permissions ?? [];
        var v = new Api.Validation()
            .Text(body.Name, "name", 100)
            .Require(perms.Length > 0, "permissions", "Choose at least one permission.")
            .Require(perms.All(known.Contains), "permissions", $"Unknown permissions: {string.Join(", ", perms.Where(p => !known.Contains(p)))}.")
            .Require(!perms.Contains(Permissions.OrgAdmin), "permissions", "org.admin belongs to the built-in administrator role only.");
        return v.IsValid ? null : v.Problem();
    }
}
