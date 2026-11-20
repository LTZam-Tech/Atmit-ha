using Atimtha.Api.Infrastructure;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.Identity;

using Api = Atimtha.Api.Infrastructure.Api;

public sealed record MemberDto(Guid Id, Guid UserId, string Email, string DisplayName, string UserStatus, string Role, string? Workspace, DateTimeOffset CreatedAt);
public sealed record RoleDto(string Key, string Name, bool BuiltIn, IReadOnlyList<string> Permissions);
public sealed record InviteRequest(string? Email, string? DisplayName, string? Role, string? Workspace);
public sealed record ChangeRoleRequest(string? Role);

/// <summary>
/// /api/v1/members and /api/v1/roles — invite people, change their role, remove them (backlog §4).
/// A person invited by email signs in through the identity provider and is linked on first sign-in (UserResolver).
/// Rules: only an organisation administrator grants org-admin; anyone else grants only roles whose permissions they
/// hold themselves there (custom roles cannot escalate); a manager limited to some workspaces manages only those;
/// the last organisation administrator cannot be removed or downgraded.
/// </summary>
public static class MemberEndpoints
{
    public static RouteGroupBuilder MapMembers(this RouteGroupBuilder api)
    {
        api.MapGet("/roles", Roles).WithTags("Members").RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        var g = api.MapGroup("/members").WithTags("Members").RequireAuthorization(Permissions.Policy(Permissions.MemberManage));
        g.MapGet("/", List);
        g.MapPost("/", Invite);
        g.MapPatch("/{membershipId:guid}", ChangeRole);
        g.MapDelete("/{membershipId:guid}", Remove);
        return api;
    }

    private static async Task<IResult> Roles(AtimthaDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var roles = await db.Roles.AsNoTracking().Include(r => r.Permissions)
            .Where(r => r.OrganizationId == null || r.OrganizationId == tenant.OrganizationId)
            .OrderBy(r => r.Name).ToListAsync(ct);
        return Results.Ok(roles.Select(r => new RoleDto(r.Key, r.Name, r.BuiltIn, r.Permissions.Select(p => p.PermissionKey).Order().ToList())));
    }

    private static async Task<IResult> List(AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        var scope = await access.ScopeAsync(Permissions.MemberManage, ct);
        var ids = scope.WorkspaceIds.ToList();
        var rows = await (
            from m in db.Memberships.AsNoTracking()
            join u in db.Users.AsNoTracking() on m.UserId equals u.Id
            join r in db.Roles.AsNoTracking() on m.RoleId equals r.Id
            join w in db.Workspaces.AsNoTracking() on m.WorkspaceId equals w.Id into ws
            from w in ws.DefaultIfEmpty()
            where scope.AllWorkspaces || (m.WorkspaceId != null && ids.Contains(m.WorkspaceId.Value))
            orderby u.DisplayName
            select new MemberDto(m.Id, u.Id, u.Email, u.DisplayName, u.Status, r.Key, w == null ? null : w.Key, m.CreatedAt)
        ).ToListAsync(ct);
        return Results.Ok(rows);
    }

    private static async Task<IResult> Invite(InviteRequest body, AtimthaDbContext db, AccessService access, TenantContext tenant, AuditWriter audit,
        OrganizationSettings settings, CancellationToken ct)
    {
        var email = body.Email?.Trim().ToLowerInvariant();
        var v = new Api.Validation()
            .Require(email is { Length: > 3 and <= 254 } && email.Contains('@') && !email.Contains(' '), "email", "Enter an email address.")
            .Text(body.DisplayName, "displayName", 200, required: false)
            .Require(!string.IsNullOrWhiteSpace(body.Role), "role", "Choose a role.");
        if (!v.IsValid) return v.Problem();
        // the organisation's allowed email domains (auth.allowedEmailDomains)
        var (_, domains) = await settings.SignInRulesAsync(tenant.OrganizationId!.Value, ct);
        if (!OrganizationSettings.EmailAllowed(email, domains))
            return Results.ValidationProblem(new Dictionary<string, string[]> { ["email"] = [$"This organisation accepts only these email domains: {string.Join(", ", domains)}."] });

        var role = await RoleByKey(db, tenant, body.Role!, ct);
        if (role is null) return Results.ValidationProblem(new Dictionary<string, string[]> { ["role"] = ["Unknown role."] });

        Guid? workspaceId = null;
        if (!string.IsNullOrWhiteSpace(body.Workspace))
        {
            workspaceId = await db.Workspaces.AsNoTracking().Where(w => w.Key == body.Workspace && w.ArchivedAt == null).Select(w => (Guid?)w.Id).FirstOrDefaultAsync(ct);
            if (workspaceId is null) return Api.NotFound("The workspace");
        }
        var guard = await CanGrant(access, role, workspaceId, ct);
        if (guard is not null) return guard;

        var user = await db.Users.FirstOrDefaultAsync(u => u.Email == email, ct);
        if (user is null)
        {
            user = new UserAccount
            {
                Id = Guid.NewGuid(), Email = email!, DisplayName = string.IsNullOrWhiteSpace(body.DisplayName) ? email! : body.DisplayName!.Trim(),
                AuthProvider = "oidc", Status = "invited", CreatedAt = DateTimeOffset.UtcNow,
            };
            db.Users.Add(user);
        }
        if (await db.Memberships.AnyAsync(m => m.UserId == user.Id && m.WorkspaceId == workspaceId, ct))
            return Api.Conflict("This person already has a role there. Change their role instead.");

        var membership = new Membership { Id = Guid.NewGuid(), OrganizationId = tenant.OrganizationId!.Value, WorkspaceId = workspaceId, UserId = user.Id, RoleId = role.Id, CreatedAt = DateTimeOffset.UtcNow };
        db.Memberships.Add(membership);
        audit.Add("member.invite", "membership", membership.Id, new { email, role = role.Key, workspace = body.Workspace });
        await db.SaveChangesAsync(ct);
        return Results.Created($"/api/v1/members/{membership.Id}", new MemberDto(membership.Id, user.Id, user.Email, user.DisplayName, user.Status, role.Key, body.Workspace, membership.CreatedAt));
    }

    private static async Task<IResult> ChangeRole(Guid membershipId, ChangeRoleRequest body, AtimthaDbContext db, AccessService access, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        var m = await db.Memberships.Include(x => x.Role).ThenInclude(r => r!.Permissions).FirstOrDefaultAsync(x => x.Id == membershipId, ct);
        if (m is null || !await Manages(access, m.WorkspaceId, ct)) return Api.NotFound("The member");
        var role = await RoleByKey(db, tenant, body.Role ?? "", ct);
        if (role is null) return Results.ValidationProblem(new Dictionary<string, string[]> { ["role"] = ["Unknown role."] });
        var guard = await CanGrant(access, role, m.WorkspaceId, ct) ?? await CanGrant(access, m.Role!, m.WorkspaceId, ct);
        if (guard is not null) return guard;
        if (m.Role!.Key == "org-admin" && role.Key != "org-admin" && await IsLastAdmin(db, m, ct))
            return Api.Conflict("This is the last organisation administrator. Make someone else an administrator first.");

        var before = m.Role.Key;
        m.RoleId = role.Id;
        audit.Add("member.role_change", "membership", m.Id, new { from = before, to = role.Key });
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> Remove(Guid membershipId, AtimthaDbContext db, AccessService access, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        var m = await db.Memberships.Include(x => x.Role).ThenInclude(r => r!.Permissions).FirstOrDefaultAsync(x => x.Id == membershipId, ct);
        if (m is null || !await Manages(access, m.WorkspaceId, ct)) return Api.NotFound("The member");
        var guard = await CanGrant(access, m.Role!, m.WorkspaceId, ct);
        if (guard is not null) return guard;
        if (m.Role!.Key == "org-admin" && await IsLastAdmin(db, m, ct))
            return Api.Conflict("This is the last organisation administrator and cannot be removed.");
        if (m.UserId == tenant.UserId) return Api.Conflict("You cannot remove yourself.");
        db.Memberships.Remove(m);
        audit.Add("member.remove", "membership", m.Id, new { user = m.UserId, role = m.Role.Key });
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    // ---------------------------------------------------------------- rules

    private static Task<Role?> RoleByKey(AtimthaDbContext db, TenantContext tenant, string key, CancellationToken ct) =>
        db.Roles.Include(r => r.Permissions).FirstOrDefaultAsync(r => r.Key == key && (r.OrganizationId == null || r.OrganizationId == tenant.OrganizationId), ct);

    private static async Task<bool> Manages(AccessService access, Guid? workspaceId, CancellationToken ct)
    {
        var scope = await access.ScopeAsync(Permissions.MemberManage, ct);
        return workspaceId is null ? scope.AllWorkspaces : scope.Includes(workspaceId.Value);
    }

    /// <summary>null = allowed; otherwise the refusal</summary>
    internal static async Task<IResult?> CanGrant(AccessService access, Role role, Guid? workspaceId, CancellationToken ct)
    {
        if (role.Key == "org-admin" && !await access.HasAsync(Permissions.OrgAdmin, ct))
            return Api.Forbidden("Only an organisation administrator can grant or change the administrator role.");
        if (!await Manages(access, workspaceId, ct))
            return Api.Forbidden(workspaceId is null ? "Organisation-wide roles need an organisation-wide manager." : "You do not manage members of this workspace.");
        if (await access.HasAsync(Permissions.OrgAdmin, ct)) return null;
        // a manager cannot hand out more than they hold there
        foreach (var p in role.Permissions.Select(p => p.PermissionKey))
        {
            var holds = workspaceId is Guid w ? await access.HasInWorkspaceAsync(p, w, ct) : (await access.ScopeAsync(p, ct)).AllWorkspaces;
            if (!holds) return Api.Forbidden($"You cannot grant a role with a permission you do not have ({p}).");
        }
        return null;
    }

    private static async Task<bool> IsLastAdmin(AtimthaDbContext db, Membership m, CancellationToken ct) =>
        !await db.Memberships.AnyAsync(x => x.Id != m.Id && x.WorkspaceId == null && x.Role!.Key == "org-admin", ct);
}
