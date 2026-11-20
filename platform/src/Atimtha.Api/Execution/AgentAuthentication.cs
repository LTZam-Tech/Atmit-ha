using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using Atimtha.Api.Infrastructure;
using Microsoft.AspNetCore.Authentication;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Atimtha.Api.Execution;

/// <summary>
/// Execution agents sign in with <c>Authorization: AtimthaAgent &lt;token&gt;</c>. Only the token's SHA-256 is stored;
/// the token is shown once when an administrator creates the agent. (mTLS client certificates are the next layer,
/// backlog §10; this scheme stays as the application-level identity.)
/// </summary>
public sealed class AgentAuthenticationHandler(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string Scheme = "AtimthaAgent";
    public const string AgentClaim = "atimtha:agent";
    public const string AgentOrgClaim = "atimtha:agent_org";
    public const string TokenPrefix = "atk_";

    private sealed class AgentRow
    {
        public Guid AgentId { get; set; }
        public Guid OrganizationId { get; set; }
        public string Status { get; set; } = "";
    }

    /// <summary>set when the caller used a job token: the one execution it may act on</summary>
    public const string JobClaim = "atimtha:job";

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var header = Request.Headers.Authorization.ToString();
        if (header.StartsWith(JobTokens.Scheme + " ", StringComparison.Ordinal))
        {
            // a short-lived job token: the agent's identity, limited to one execution (JobTokens)
            var jobToken = header[(JobTokens.Scheme.Length + 1)..].Trim();
            var claims = Context.RequestServices.GetRequiredService<JobTokens>().Read(jobToken, DateTimeOffset.UtcNow);
            if (claims is null) return AuthenticateResult.Fail("Invalid or expired job token");
            var jobIdentity = new ClaimsIdentity(
            [
                new Claim(AgentClaim, claims.AgentId.ToString()),
                new Claim(AgentOrgClaim, claims.OrganizationId.ToString()),
                new Claim(JobClaim, claims.ExecutionId.ToString()),
            ], Scheme);
            return AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(jobIdentity), Scheme));
        }
        if (!header.StartsWith(Scheme + " ", StringComparison.Ordinal)) return AuthenticateResult.NoResult();
        var token = header[(Scheme.Length + 1)..].Trim();
        if (!token.StartsWith(TokenPrefix, StringComparison.Ordinal) || token.Length > 200) return AuthenticateResult.Fail("Malformed agent token");

        var hash = HashToken(token);
        var db = Context.RequestServices.GetRequiredService<AtimthaDbContext>();
        var row = await db.Database
            .SqlQuery<AgentRow>($"SELECT agent_id AS \"AgentId\", organization_id AS \"OrganizationId\", status::text AS \"Status\" FROM atimtha.agent_by_token({hash})")
            .FirstOrDefaultAsync(Context.RequestAborted);
        if (row is null || row.Status == "revoked") return AuthenticateResult.Fail("Unknown or revoked agent token");

        var identity = new ClaimsIdentity(
        [
            new Claim(AgentClaim, row.AgentId.ToString()),
            new Claim(AgentOrgClaim, row.OrganizationId.ToString()),
        ], Scheme);
        return AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(identity), Scheme));
    }

    public static string NewToken() => TokenPrefix + Base64Url(RandomNumberGenerator.GetBytes(32));

    public static string HashToken(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))).ToLowerInvariant();

    private static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public static Guid? AgentId(ClaimsPrincipal user) => Guid.TryParse(user.FindFirstValue(AgentClaim), out var id) ? id : null;

    /// <summary>the execution a job token is limited to; null for the agent's own token</summary>
    public static Guid? JobId(ClaimsPrincipal user) => Guid.TryParse(user.FindFirstValue(JobClaim), out var id) ? id : null;

    /// <summary>true for the agent's own token, or a job token minted for this very execution</summary>
    public static bool MayReport(ClaimsPrincipal user, Guid executionId) => JobId(user) is not { } job || job == executionId;
}
