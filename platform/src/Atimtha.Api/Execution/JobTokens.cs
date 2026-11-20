using System.Security.Cryptography;
using System.Text;

namespace Atimtha.Api.Execution;

/// <summary>
/// Short-lived job tokens (backlog §10): <c>Authorization: AtimthaJob ajt_…</c>. The platform mints one when an agent
/// claims a job; it is valid only for that execution, that agent and until it expires, and it can report events and
/// upload evidence and artifacts — nothing else. The agent hands it, not its long-lived <c>atk_</c> token, to the
/// test runner, so test code never holds the agent's identity.
/// Format: <c>ajt_&lt;base64url(v1|execution|agent|organisation|expiry)&gt;.&lt;base64url(HMAC-SHA256)&gt;</c>, key
/// <c>Jobs:TokenKey</c> (base64, at least 32 bytes; generated per process in Development, required in Production).
/// </summary>
public sealed class JobTokens
{
    public const string Scheme = "AtimthaJob";
    public const string Prefix = "ajt_";
    private readonly byte[] key;

    public bool Ephemeral { get; }

    public JobTokens(IConfiguration configuration, ILogger<JobTokens> logger)
    {
        var configured = configuration["Jobs:TokenKey"];
        if (!string.IsNullOrWhiteSpace(configured))
        {
            try { key = Convert.FromBase64String(configured.Trim()); }
            catch (FormatException) { throw new InvalidOperationException("Jobs:TokenKey must be base64 (at least 32 bytes)."); }
            if (key.Length < 32) throw new InvalidOperationException("Jobs:TokenKey must be at least 32 bytes (base64).");
        }
        else
        {
            key = RandomNumberGenerator.GetBytes(32);
            Ephemeral = true;
            logger.LogWarning("Jobs:TokenKey is not set: job tokens use a temporary key and stop working when the API restarts.");
        }
    }

    public sealed record Claims(Guid ExecutionId, Guid AgentId, Guid OrganizationId, DateTimeOffset ExpiresAt);

    public string Mint(Guid executionId, Guid agentId, Guid organizationId, DateTimeOffset expiresAt)
    {
        var payload = $"v1|{executionId:N}|{agentId:N}|{organizationId:N}|{expiresAt.ToUnixTimeSeconds()}";
        var bytes = Encoding.UTF8.GetBytes(payload);
        return Prefix + B64(bytes) + "." + B64(HMACSHA256.HashData(key, bytes));
    }

    /// <summary>the token's claims when the signature is right and it has not expired; null otherwise</summary>
    public Claims? Read(string token, DateTimeOffset now)
    {
        if (!token.StartsWith(Prefix, StringComparison.Ordinal) || token.Length > 400) return null;
        var parts = token[Prefix.Length..].Split('.');
        if (parts.Length != 2) return null;
        byte[] payload, mac;
        try { payload = FromB64(parts[0]); mac = FromB64(parts[1]); }
        catch (FormatException) { return null; }
        if (!CryptographicOperations.FixedTimeEquals(mac, HMACSHA256.HashData(key, payload))) return null;
        var f = Encoding.UTF8.GetString(payload).Split('|');
        if (f.Length != 5 || f[0] != "v1" || !Guid.TryParseExact(f[1], "N", out var exec) || !Guid.TryParseExact(f[2], "N", out var agent)
            || !Guid.TryParseExact(f[3], "N", out var org) || !long.TryParse(f[4], out var exp)) return null;
        var expires = DateTimeOffset.FromUnixTimeSeconds(exp);
        return expires <= now ? null : new Claims(exec, agent, org, expires);
    }

    private static string B64(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] FromB64(string s)
    {
        var t = s.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(t.PadRight(t.Length + (4 - t.Length % 4) % 4, '='));
    }
}
