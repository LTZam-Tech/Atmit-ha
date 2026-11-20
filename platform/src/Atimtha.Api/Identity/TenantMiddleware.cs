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

    /// <summary>amr values (RFC 8176) that count as multi-factor sign-in</summary>
    private static readonly string[] MultiFactor = ["mfa", "otp", "hwk", "swk"];

    public async Task InvokeAsync(HttpContext ctx, TenantContext tenant, AtimthaDbContext db, OrganizationSettings settings, ILogger<TenantMiddleware> logger)
    {
        var ct = ctx.RequestAborted;
        if (Execution.AgentAuthenticationHandler.AgentId(ctx.User) is { } agentId)
        {
            // an execution agent acts in the organisation that owns it — never in one named by a header
            if (Guid.TryParse(ctx.User.FindFirstValue(Execution.AgentAuthenticationHandler.AgentOrgClaim), out var agentOrg))
            {
                var org = await db.Organizations.AsNoTracking()
                    .Where(o => o.Id == agentOrg && o.ArchivedAt == null)
                    .Select(o => new { o.Id, o.Key })
                    .FirstOrDefaultAsync(ct);
                if (org is not null) tenant.SetOrganization(org.Id, org.Key);
            }
            using (logger.BeginScope(new Dictionary<string, object?> { ["AgentId"] = agentId, ["OrganizationId"] = tenant.OrganizationId }))
                await next(ctx);
            return;
        }
        if (Integrations.CiTokenAuthenticationHandler.OrganizationId(ctx.User) is { } ciOrg)
        {
            var org = await db.Organizations.AsNoTracking()
                .Where(o => o.Id == ciOrg && o.ArchivedAt == null)
                .Select(o => new { o.Id, o.Key })
                .FirstOrDefaultAsync(ct);
            if (org is not null) tenant.SetOrganization(org.Id, org.Key);
            using (logger.BeginScope(new Dictionary<string, object?> { ["CiTokenId"] = Integrations.CiTokenAuthenticationHandler.TokenId(ctx.User), ["OrganizationId"] = tenant.OrganizationId }))
                await next(ctx);
            return;
        }
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

            // the organisation's sign-in rules (auth.requireMfa, auth.allowedEmailDomains); /me stays open so the
            // application can still list the person's organisations and explain the refusal
            // (members only: anyone else is refused by the permission checks, and learns nothing about the organisation)
            if (tenant.OrganizationId is { } orgId && tenant.UserId is { } uid && !ctx.Request.Path.StartsWithSegments("/api/v1/me")
                && await db.Memberships.AsNoTracking().AnyAsync(m => m.UserId == uid, ct))
            {
                var (requireMfa, domains) = await settings.SignInRulesAsync(orgId, ct);
                if (domains.Count > 0)
                {
                    var email = await db.Users.AsNoTracking().Where(u => u.Id == uid).Select(u => u.Email).FirstOrDefaultAsync(ct);
                    if (!OrganizationSettings.EmailAllowed(email, domains))
                    {
                        await Refuse(ctx, "This organisation accepts only accounts from its own email domains. Sign in with your organisation account.");
                        return;
                    }
                }
                if (requireMfa && NeedsMfaCheck(ctx.User) && !HasMultiFactor(ctx.User))
                {
                    await Refuse(ctx, "This organisation requires multi-factor sign-in. Sign out, then sign in again with your second factor.");
                    return;
                }
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

    /// <summary>
    /// people signed in through the identity provider (JWT). The development login is exempt, unless it sends
    /// X-Dev-Amr to stand in for a provider's amr claim (local checks only).
    /// </summary>
    private static bool NeedsMfaCheck(ClaimsPrincipal user) =>
        user.Identity?.AuthenticationType != DevelopmentAuthenticationHandler.Scheme || user.HasClaim(c => c.Type == DevelopmentAuthenticationHandler.AmrSimulatedClaim);

    /// <summary>the token's amr claim (one value, several claims, or a JSON array) names a second factor</summary>
    private static bool HasMultiFactor(ClaimsPrincipal user)
    {
        var values = new List<string>();
        foreach (var c in user.FindAll("amr"))
        {
            if (c.Value.TrimStart().StartsWith('['))
            {
                try { values.AddRange(System.Text.Json.JsonSerializer.Deserialize<string[]>(c.Value) ?? []); }
                catch (System.Text.Json.JsonException) { /* not a list: ignored */ }
            }
            else values.Add(c.Value);
        }
        return values.Any(v => MultiFactor.Contains(v.Trim().ToLowerInvariant()));
    }

    private static Task Refuse(HttpContext ctx, string detail)
    {
        ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
        return ctx.Response.WriteAsJsonAsync(new { type = "https://tools.ietf.org/html/rfc9110#section-15.5.4", title = "Forbidden", status = 403, detail },
            options: (System.Text.Json.JsonSerializerOptions?)null, contentType: "application/problem+json");
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
