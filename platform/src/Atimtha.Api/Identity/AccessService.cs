using Atimtha.Api.Infrastructure;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Atimtha.Api.Identity;

/// <summary>Which workspaces a permission covers for the current user: all of the organisation, or a list.</summary>
public sealed record WorkspaceScope(bool AllWorkspaces, IReadOnlySet<Guid> WorkspaceIds)
{
    public static readonly WorkspaceScope None = new(false, new HashSet<Guid>());
    public bool Includes(Guid workspaceId) => AllWorkspaces || WorkspaceIds.Contains(workspaceId);
    public bool Any => AllWorkspaces || WorkspaceIds.Count > 0;
}

/// <summary>
/// Permission checks against memberships → roles → permissions. Memberships are read under row-level security,
/// so only the current organisation's grants are ever seen. "org.admin" includes every permission.
/// </summary>
public sealed class AccessService(AtimthaDbContext db, TenantContext tenant)
{
    public async Task<WorkspaceScope> ScopeAsync(string permission, CancellationToken ct = default)
    {
        if (tenant.OrganizationId is not { } org || tenant.UserId is not { } user) return WorkspaceScope.None;
        var workspaceIds = await db.Memberships.AsNoTracking()
            .Where(m => m.UserId == user && m.OrganizationId == org)
            .Where(m => m.Role!.Permissions.Any(p => p.PermissionKey == permission || p.PermissionKey == Permissions.OrgAdmin))
            .Select(m => m.WorkspaceId)
            .ToListAsync(ct);
        if (workspaceIds.Count == 0) return WorkspaceScope.None;
        return workspaceIds.Any(w => w is null)
            ? new WorkspaceScope(true, new HashSet<Guid>())
            : new WorkspaceScope(false, workspaceIds.Select(w => w!.Value).ToHashSet());
    }

    public async Task<bool> HasAsync(string permission, CancellationToken ct = default) => (await ScopeAsync(permission, ct)).Any;

    public async Task<bool> HasInWorkspaceAsync(string permission, Guid workspaceId, CancellationToken ct = default) =>
        (await ScopeAsync(permission, ct)).Includes(workspaceId);
}

public sealed record PermissionRequirement(string Permission) : IAuthorizationRequirement;

/// <summary>Grants a "perm:x" policy when the user holds permission x somewhere in the current organisation.</summary>
public sealed class PermissionHandler(AccessService access) : AuthorizationHandler<PermissionRequirement>
{
    protected override async Task HandleRequirementAsync(AuthorizationHandlerContext context, PermissionRequirement requirement)
    {
        if (await access.HasAsync(requirement.Permission)) context.Succeed(requirement);
    }
}

/// <summary>Builds "perm:&lt;key&gt;" policies on demand, so endpoints can say RequireAuthorization(Permissions.Policy(…)).</summary>
public sealed class PermissionPolicyProvider(IOptions<AuthorizationOptions> options) : DefaultAuthorizationPolicyProvider(options)
{
    public override async Task<AuthorizationPolicy?> GetPolicyAsync(string policyName)
    {
        if (!policyName.StartsWith(Permissions.PolicyPrefix, StringComparison.Ordinal)) return await base.GetPolicyAsync(policyName);
        var permission = policyName[Permissions.PolicyPrefix.Length..];
        if (!Permissions.All.Contains(permission)) return null;
        return new AuthorizationPolicyBuilder()
            .RequireAuthenticatedUser()
            .AddRequirements(new PermissionRequirement(permission))
            .Build();
    }
}
