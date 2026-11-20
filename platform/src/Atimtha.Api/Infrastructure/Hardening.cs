using System.Security.Cryptography;
using System.Text;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

namespace Atimtha.Api.Infrastructure;

/// <summary>
/// API hardening (backlog §13): request rate limits, response security headers, and start-up checks that refuse an
/// unsafe production configuration instead of running with it.
/// </summary>
public static class Hardening
{
    /// <summary>
    /// Two limits, both per minute: per caller (the credential sent, else the address) and per client address, so
    /// rotating fake tokens does not escape the second one. Health probes are not limited.
    /// RateLimit:PerCaller (default 600) and RateLimit:PerAddress (default 3000).
    /// </summary>
    public static IServiceCollection AddPlatformRateLimits(this IServiceCollection services, IConfiguration configuration)
    {
        var perCaller = configuration.GetValue<int?>("RateLimit:PerCaller") ?? 600;
        var perAddress = configuration.GetValue<int?>("RateLimit:PerAddress") ?? 3000;
        services.AddRateLimiter(o =>
        {
            o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            o.OnRejected = (ctx, _) =>
            {
                if (ctx.Lease.TryGetMetadata(MetadataName.RetryAfter, out var after))
                    ctx.HttpContext.Response.Headers.RetryAfter = ((int)Math.Ceiling(after.TotalSeconds)).ToString();
                return ValueTask.CompletedTask;
            };
            o.GlobalLimiter = PartitionedRateLimiter.CreateChained(
                PartitionedRateLimiter.Create<HttpContext, string>(ctx => Bucket(ctx, CallerKey(ctx), perCaller)),
                PartitionedRateLimiter.Create<HttpContext, string>(ctx => Bucket(ctx, "ip:" + ctx.Connection.RemoteIpAddress, perAddress)));
        });
        return services;
    }

    private static RateLimitPartition<string> Bucket(HttpContext ctx, string key, int perMinute) =>
        ctx.Request.Path.StartsWithSegments("/health")
            ? RateLimitPartition.GetNoLimiter("health")
            : RateLimitPartition.GetTokenBucketLimiter(key, _ => new TokenBucketRateLimiterOptions
            {
                TokenLimit = perMinute, TokensPerPeriod = perMinute, ReplenishmentPeriod = TimeSpan.FromMinutes(1), QueueLimit = 0, AutoReplenishment = true,
            });

    /// <summary>a hash of the credential (never the credential itself), else the development user, else the address</summary>
    private static string CallerKey(HttpContext ctx)
    {
        var auth = ctx.Request.Headers.Authorization.ToString();
        if (auth.Length > 0) return "a:" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(auth)))[..20];
        var dev = ctx.Request.Headers["X-Dev-User"].ToString();
        return dev.Length > 0 ? "d:" + dev : "ip:" + ctx.Connection.RemoteIpAddress;
    }

    /// <summary>Headers on every response; an endpoint may still set its own Content-Security-Policy (evidence, files).</summary>
    public static IApplicationBuilder UseSecurityHeaders(this IApplicationBuilder app) => app.Use(async (ctx, next) =>
    {
        var h = ctx.Response.Headers;
        h.XContentTypeOptions = "nosniff";
        h.XFrameOptions = "DENY";
        h["Referrer-Policy"] = "no-referrer";
        h["Cross-Origin-Resource-Policy"] = "same-origin";
        h["Cross-Origin-Opener-Policy"] = "same-origin";
        h["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=()";
        // the API serves data, never pages: nothing may load, run or frame it
        h.ContentSecurityPolicy = "default-src 'none'; frame-ancestors 'none'";
        h.CacheControl = "no-store";
        await next();
    });

    /// <summary>Outside Development: refuse to start with settings that would be unsafe in production.</summary>
    public static void CheckProductionConfiguration(IConfiguration c, IHostEnvironment env)
    {
        if (env.IsDevelopment()) return;
        var problems = new List<string>();
        if (c.GetValue<bool>("Auth:Development:Enabled")) problems.Add("Auth:Development:Enabled must be false.");
        if (string.IsNullOrWhiteSpace(c["Auth:Authority"]) || !c["Auth:Authority"]!.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            problems.Add("Auth:Authority must be the identity provider's https:// address.");
        if (string.IsNullOrWhiteSpace(c["Auth:Audience"])) problems.Add("Auth:Audience must be set.");
        if (string.IsNullOrWhiteSpace(c["Jobs:SigningKey"])) problems.Add("Jobs:SigningKey (ECDSA P-256 private key, PEM) must be set: agents verify every job with it.");
        if (string.IsNullOrWhiteSpace(c["Jobs:TokenKey"])) problems.Add("Jobs:TokenKey (32 bytes, base64) must be set: test runners report with job tokens signed by it.");
        if (string.IsNullOrWhiteSpace(c["Evidence:EncryptionKey"])) problems.Add("Evidence:EncryptionKey (32 bytes, base64) must be set: evidence is encrypted at rest.");
        if (c["Platform:PublicUrl"] is { Length: > 0 } url && !url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            problems.Add("Platform:PublicUrl must be an https:// address.");
        if (problems.Count > 0)
            throw new InvalidOperationException("Unsafe production configuration:\n - " + string.Join("\n - ", problems));
    }
}
