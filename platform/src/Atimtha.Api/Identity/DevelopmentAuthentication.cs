using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

namespace Atimtha.Api.Identity;

/// <summary>
/// LOCAL DEVELOPMENT ONLY: signs a request in as the email in the <c>X-Dev-User</c> header, so the API can be used
/// on Docker Compose without an identity provider. Program.cs registers it only when the environment is Development
/// AND Auth:Development:Enabled is true, and refuses to start if it is enabled anywhere else.
/// </summary>
public sealed class DevelopmentAuthenticationHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string Scheme = "Development";
    /// <summary>X-Dev-Amr: comma-separated amr values, standing in for an identity provider's claim (local checks of auth.requireMfa)</summary>
    public const string AmrHeader = "X-Dev-Amr";
    public const string AmrSimulatedClaim = "atimtha:dev_amr";
    public const string Header = "X-Dev-User";

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var email = Request.Headers[Header].FirstOrDefault();
        if (string.IsNullOrWhiteSpace(email)) return Task.FromResult(AuthenticateResult.NoResult());
        if (!email.Contains('@') || email.Length > 200) return Task.FromResult(AuthenticateResult.Fail("X-Dev-User must be an email address"));

        var identity = new ClaimsIdentity(
        [
            new Claim("sub", email.ToLowerInvariant()),
            new Claim("email", email),
            new Claim(UserResolver.ProviderClaim, "dev"),
        ], Scheme);
        // X-Dev-Amr: pwd | pwd,otp | mfa … — what an identity provider would report in amr (local checks only)
        if (Request.Headers[AmrHeader].FirstOrDefault() is { Length: > 0 and <= 100 } amr)
        {
            identity.AddClaim(new Claim(AmrSimulatedClaim, "1"));
            foreach (var v in amr.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)) identity.AddClaim(new Claim("amr", v));
        }
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(identity), Scheme)));
    }
}
