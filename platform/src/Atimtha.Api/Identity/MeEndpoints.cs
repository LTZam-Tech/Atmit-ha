using Atimtha.Api.Infrastructure;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.Identity;

using Api = Atimtha.Api.Infrastructure.Api;

/// <summary>PlatformAdmin: may manage organisations (Platform:Admins).</summary>
public sealed record MeDto(Guid Id, string Email, string DisplayName, string Locale, IReadOnlyList<MyOrganizationDto> Organizations, bool PlatformAdmin);
/// <summary>Permissions: what the person may do somewhere in the organisation (a hint for the UI; every API call checks).</summary>
public sealed record MyOrganizationDto(string Key, string Name, IReadOnlyList<string> Roles, IReadOnlyList<string> Permissions);

/// <summary>Row of atimtha.user_organizations(user) (db/migrations/0002): the one cross-organisation read the API makes.</summary>
internal sealed class MyOrganizationRow
{
    public string OrgKey { get; set; } = "";
    public string OrgName { get; set; } = "";
    public string RoleKey { get; set; } = "";
}

/// <summary>/api/v1/me — who am I, and which organisations can I choose from (no organisation header needed).</summary>
public static class MeEndpoints
{
    public static RouteGroupBuilder MapMe(this RouteGroupBuilder api)
    {
        api.MapGet("/me", Get).WithTags("Me");
        return api;
    }

    private static async Task<IResult> Get(TenantContext tenant, AtimthaDbContext db, PlatformAdmins admins, CancellationToken ct)
    {
        if (tenant.UserId is not { } userId)
            return Api.Forbidden("Your account has no access yet. Ask an administrator to invite your email address.");

        var user = await db.Users.AsNoTracking().FirstAsync(u => u.Id == userId, ct);
        var rows = await db.Database
            .SqlQuery<MyOrganizationRow>($"SELECT org_key AS \"OrgKey\", org_name AS \"OrgName\", role_key AS \"RoleKey\" FROM atimtha.user_organizations({userId})")
            .ToListAsync(ct);
        // the permissions of those roles: built-in roles, or the organisation's own custom roles
        var orgKeys = rows.Select(r => r.OrgKey).Distinct().ToList();
        var orgIds = await db.Organizations.AsNoTracking().Where(o => orgKeys.Contains(o.Key)).ToDictionaryAsync(o => o.Key, o => o.Id, ct);
        var roleKeys = rows.Select(r => r.RoleKey).Distinct().ToList();
        var roles = await db.Roles.AsNoTracking().Include(r => r.Permissions).Where(r => roleKeys.Contains(r.Key)).ToListAsync(ct);
        IReadOnlyList<string> PermissionsOf(string orgKey, IEnumerable<string> keys) =>
            roles.Where(r => keys.Contains(r.Key) && (r.OrganizationId == null || r.OrganizationId == orgIds.GetValueOrDefault(orgKey)))
                .SelectMany(r => r.Permissions.Select(p => p.PermissionKey)).Distinct().Order().ToList();
        var orgs = rows
            .GroupBy(r => (r.OrgKey, r.OrgName))
            .OrderBy(g => g.Key.OrgName)
            .Select(g => new MyOrganizationDto(g.Key.OrgKey, g.Key.OrgName, g.Select(r => r.RoleKey).Distinct().Order().ToList(),
                PermissionsOf(g.Key.OrgKey, g.Select(r => r.RoleKey))))
            .ToList();
        return Results.Ok(new MeDto(user.Id, user.Email, user.DisplayName, user.Locale, orgs, user.Status == "active" && admins.Is(user.Email)));
    }
}
