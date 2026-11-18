using System.Diagnostics;
using System.Security.Claims;
using Atimtha.Api.Infrastructure;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.Identity;

/// <summary>
/// After authentication: finds the user's account and the organisation the request acts in
/// (header <c>X-Atimtha-Organization: &lt;key&gt;</c>, else the token's <c>org</c> claim). An unknown or archived
/// organisation simply leaves the request without one: every permission check then fails, and nothing reveals
/// whether that organisation exists.
/// </summary>
public sealed class TenantMiddleware(RequestDelegate next)
{
    public const string OrganizationHeader = "X-Atimtha-Organization";

    public async Task InvokeAsync(HttpContext ctx, TenantContext tenant, AtimthaDbContext db, ILogger<TenantMiddleware> logger)
    {
        var ct = ctx.RequestAborted;
        if (ctx.User.Identity?.IsAuthenticated == true)
        {
            var user = await UserResolver.ResolveAsync(db, ctx.User, ct);
            if (user is not null) tenant.UserId = user.Id;

            var orgKey = ctx.Request.Headers[OrganizationHeader].FirstOrDefault() ?? ctx.User.FindFirstValue("org");
            if (!string.IsNullOrWhiteSpace(orgKey))
            {
                var org = await db.Organizations.AsNoTracking()
                    .Where(o => o.Key == orgKey && o.ArchivedAt == null)
                    .Select(o => new { o.Id, o.Key })
                    .FirstOrDefaultAsync(ct);
                if (org is not null) tenant.SetOrganization(org.Id, org.Key);
            }
        }

        using (logger.BeginScope(new Dictionary<string, object?>
        {
            ["TraceId"] = Activity.Current?.TraceId.ToString() ?? ctx.TraceIdentifier,
            ["OrganizationId"] = tenant.OrganizationId,
            ["UserId"] = tenant.UserId,
        }))
        {
            await next(ctx);
        }
    }
}

/// <summary>Maps a signed-in principal to a user_account row; links an invited account (email only) on first sign-in.</summary>
public static class UserResolver
{
    public const string ProviderClaim = "atimtha:provider";

    public static async Task<UserAccount?> ResolveAsync(AtimthaDbContext db, ClaimsPrincipal principal, CancellationToken ct)
    {
        var subject = principal.FindFirstValue("sub") ?? principal.FindFirstValue(ClaimTypes.NameIdentifier);
        if (string.IsNullOrEmpty(subject)) return null;
        var provider = principal.FindFirstValue(ProviderClaim) ?? "oidc";

        var user = await db.Users.FirstOrDefaultAsync(u => u.AuthProvider == provider && u.ExternalSubject == subject, ct);
        if (user is not null) return user.Status == "disabled" ? null : user;

        // an administrator invited this person by email: link the identity on first sign-in
        var email = principal.FindFirstValue("email") ?? principal.FindFirstValue(ClaimTypes.Email);
        if (string.IsNullOrEmpty(email)) return null;
        user = await db.Users.FirstOrDefaultAsync(u => u.Email == email && u.ExternalSubject == null && u.Status == "invited", ct);
        if (user is null) return null;

        user.AuthProvider = provider;
        user.ExternalSubject = subject;
        user.Status = "active";
        user.LastLoginAt = DateTimeOffset.UtcNow;
        var name = principal.FindFirstValue("name");
        if (!string.IsNullOrWhiteSpace(name)) user.DisplayName = name;
        await db.SaveChangesAsync(ct);
        return user;
    }
}
