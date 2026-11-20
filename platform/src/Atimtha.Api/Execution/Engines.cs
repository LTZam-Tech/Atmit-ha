using System.Text.Json.Nodes;
using Atimtha.Api.Identity;
using Atimtha.Api.Infrastructure;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.Execution;

using Api = Atimtha.Api.Infrastructure.Api;

/// <summary>
/// The test engines (ADR-0009): web and API since 1.0, mobile (Appium) and performance (k6) since 1.1.
/// Performance runs put load on a system, so they need an organisation's explicit approval: the setting
/// performance.maxVirtualUsers is 0 (off) until an administrator raises it, and it caps every run.
/// </summary>
public static class Engines
{
    public static readonly string[] Known = ["web", "api", "mobile", "performance"];

    public static bool IsKnown(string engine) => Known.Contains(engine);

    public static EngineKind Parse(string engine) => engine switch
    {
        "api" => EngineKind.Api, "mobile" => EngineKind.Mobile, "performance" => EngineKind.Performance, _ => EngineKind.Web,
    };

    public static string Name(EngineKind kind) => kind.ToString().ToLowerInvariant();

    public static async Task<int> MaxVirtualUsersAsync(AtimthaDbContext db, Guid organizationId, CancellationToken ct)
    {
        var raw = await db.OrganizationSettings.AsNoTracking()
            .Where(s => s.OrganizationId == organizationId && s.Key == OrganizationSettings.MaxVirtualUsers).Select(s => s.Value).FirstOrDefaultAsync(ct);
        return raw is not null && JsonNode.Parse(raw) is JsonValue v && v.TryGetValue<int>(out var n) ? Math.Clamp(n, 0, 1000) : 0;
    }

    /// <summary>null = the run may start</summary>
    public static async Task<IResult?> RefusalAsync(AtimthaDbContext db, Guid organizationId, string engine, CancellationToken ct)
    {
        if (engine != "performance") return null;
        return await MaxVirtualUsersAsync(db, organizationId, ct) > 0 ? null
            : Api.Conflict("Performance runs are switched off for this organisation. An administrator approves load testing by setting performance.maxVirtualUsers in Organisation settings.");
    }
}
