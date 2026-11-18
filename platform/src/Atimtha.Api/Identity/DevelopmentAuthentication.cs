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
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(identity), Scheme)));
    }
}
