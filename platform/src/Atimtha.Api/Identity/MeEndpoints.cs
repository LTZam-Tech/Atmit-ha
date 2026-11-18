using Atimtha.Api.Infrastructure;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.Identity;

public sealed record MeDto(Guid Id, string Email, string DisplayName, string Locale, IReadOnlyList<MyOrganizationDto> Organizations);
public sealed record MyOrganizationDto(string Key, string Name, IReadOnlyList<string> Roles);

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

    private static async Task<IResult> Get(TenantContext tenant, AtimthaDbContext db, CancellationToken ct)
    {
        if (tenant.UserId is not { } userId)
            return Api.Forbidden("Your account has no access yet. Ask an administrator to invite your email address.");

        var user = await db.Users.AsNoTracking().FirstAsync(u => u.Id == userId, ct);
        var rows = await db.Database
            .SqlQuery<MyOrganizationRow>($"SELECT org_key AS \"OrgKey\", org_name AS \"OrgName\", role_key AS \"RoleKey\" FROM atimtha.user_organizations({userId})")
            .ToListAsync(ct);
        var orgs = rows
            .GroupBy(r => (r.OrgKey, r.OrgName))
            .OrderBy(g => g.Key.OrgName)
            .Select(g => new MyOrganizationDto(g.Key.OrgKey, g.Key.OrgName, g.Select(r => r.RoleKey).Distinct().Order().ToList()))
            .ToList();
        return Results.Ok(new MeDto(user.Id, user.Email, user.DisplayName, user.Locale, orgs));
    }
}
