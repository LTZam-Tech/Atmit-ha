using System.Text.Json;
using System.Text.Json.Nodes;
using Atimtha.Api.Infrastructure;
using Atimtha.Api.Integrations;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.Identity;

using Api = Atimtha.Api.Infrastructure.Api;

public sealed class OrganizationSetting
{
    public Guid OrganizationId { get; set; }
    public string Key { get; set; } = "";
    public string Value { get; set; } = "null";
    public Guid? UpdatedBy { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

/// <summary>
/// A setting the platform knows: its default, limits and what it is for. Unknown keys are refused.
/// Kind "int" (Min..Max) or "text" (at most MaxLength characters, default TextDefault).
/// </summary>
public sealed record SettingSpec(string Key, int Default, int Min, int Max, string Description, string Kind = "int", string TextDefault = "", int MaxLength = 0);

/// <summary>Value and Default are a number for "int" settings and a string for "text" settings.</summary>
public sealed record SettingDto(string Key, JsonNode? Value, JsonNode? Default, int Min, int Max, bool Overridden, string Description, string Kind = "int", int MaxLength = 0);
public sealed record FlagDto(string Key, bool Enabled, bool PlatformDefault, bool? Override, string Description);
public sealed record PutSettingRequest(JsonNode? Value);
public sealed record PutFlagRequest(bool? Enabled);

/// <summary>Reads an organisation's settings (with defaults) for the code that needs them.</summary>
public sealed class OrganizationSettings(AtimthaDbContext db, IConfiguration configuration)
{
    public const string EvidenceRetention = "evidence.retentionDays";
    public const string MaxRunMinutes = "runs.maxDurationMinutes";
    public const string MaxVirtualUsers = "performance.maxVirtualUsers";
    public const string RequireMfa = "auth.requireMfa";
    public const string AllowedEmailDomains = "auth.allowedEmailDomains";

    public static readonly SettingSpec[] Known =
    [
        new(EvidenceRetention, 30, 1, 3650, "Days screenshots, videos, traces and reports are kept before they are deleted."),
        new(MaxRunMinutes, 360, 5, 1440, "A run still going after this many minutes is stopped and marked as an infrastructure error."),
        new(MaxVirtualUsers, 0, 0, 1000, "Most virtual users a performance run may start. 0 switches performance runs off: an administrator approves load testing by raising it."),
        new(RequireMfa, 0, 0, 1, "1 = people must sign in with multi-factor authentication (the identity provider's amr claim: mfa, otp, hwk or swk). Agents and CI tokens are not affected."),
        new(AllowedEmailDomains, 0, 0, 0, "Email domains people of this organisation may have, comma separated (e.g. client.gov.sa, iltizamtech.com). Empty = any domain. Invites and sign-ins outside them are refused.",
            Kind: "text", MaxLength: 1000),
    ];

    /// <summary>"a.com, B.org  c.net" → [a.com, b.org, c.net]; null when one of them is not a domain</summary>
    public static List<string>? ParseDomains(string? text)
    {
        var list = (text ?? "").Split([',', ';', ' ', '\n', '\r', '\t'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(d => d.TrimStart('@').ToLowerInvariant()).Distinct().ToList();
        return list.All(d => System.Text.RegularExpressions.Regex.IsMatch(d, "^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$")) ? list : null;
    }

    /// <summary>the address is in one of the domains (or a sub-domain of one); any address when the list is empty</summary>
    public static bool EmailAllowed(string? email, IReadOnlyCollection<string> domains)
    {
        if (domains.Count == 0) return true;
        var at = email?.LastIndexOf('@') ?? -1;
        if (at < 0) return false;
        var domain = email![(at + 1)..].ToLowerInvariant();
        return domains.Any(d => domain == d || domain.EndsWith("." + d, StringComparison.Ordinal));
    }

    public static readonly (string Key, string Description)[] Flags =
    [
        ("integration.jira", "File failed tests as Jira issues."),
        ("integration.azure_devops", "File failed tests as Azure DevOps work items."),
        ("integration.testrail", "Publish run results to TestRail."),
    ];

    public async Task<int> GetAsync(Guid organizationId, string key, CancellationToken ct)
    {
        var spec = Known.First(s => s.Key == key);
        var raw = await db.OrganizationSettings.AsNoTracking().Where(s => s.OrganizationId == organizationId && s.Key == key).Select(s => s.Value).FirstOrDefaultAsync(ct);
        if (raw is not null && JsonNode.Parse(raw) is JsonValue v && v.TryGetValue<int>(out var n)) return Math.Clamp(n, spec.Min, spec.Max);
        // the platform-wide configuration stays the default when an organisation sets nothing
        if (key == EvidenceRetention && int.TryParse(configuration["Evidence:RetentionDays"], out var d) && d > 0) return Math.Clamp(d, spec.Min, spec.Max);
        return spec.Default;
    }

    public Task<int> EvidenceRetentionDaysAsync(Guid organizationId, CancellationToken ct) => GetAsync(organizationId, EvidenceRetention, ct);

    public async Task<string> GetTextAsync(Guid organizationId, string key, CancellationToken ct)
    {
        var spec = Known.First(s => s.Key == key);
        var raw = await db.OrganizationSettings.AsNoTracking().Where(s => s.OrganizationId == organizationId && s.Key == key).Select(s => s.Value).FirstOrDefaultAsync(ct);
        return raw is not null && JsonNode.Parse(raw) is JsonValue v && v.TryGetValue<string>(out var text) ? text : spec.TextDefault;
    }

    /// <summary>the sign-in rules of an organisation, read together (TenantMiddleware runs this on every request)</summary>
    public async Task<(bool RequireMfa, List<string> Domains)> SignInRulesAsync(Guid organizationId, CancellationToken ct)
    {
        var rows = await db.OrganizationSettings.AsNoTracking()
            .Where(s => s.OrganizationId == organizationId && (s.Key == RequireMfa || s.Key == AllowedEmailDomains))
            .Select(s => new { s.Key, s.Value }).ToListAsync(ct);
        var mfa = rows.FirstOrDefault(r => r.Key == RequireMfa)?.Value is { } m && JsonNode.Parse(m) is JsonValue mv && mv.TryGetValue<int>(out var on) && on == 1;
        var text = rows.FirstOrDefault(r => r.Key == AllowedEmailDomains)?.Value is { } d && JsonNode.Parse(d) is JsonValue dv && dv.TryGetValue<string>(out var t) ? t : "";
        return (mfa, ParseDomains(text) ?? []);
    }
}

/// <summary>/api/v1/organization/settings and /api/v1/feature-flags: the organisation administrator's configuration.</summary>
public static class OrganizationSettingsEndpoints
{
    public static RouteGroupBuilder MapOrganizationSettings(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/organization/settings").WithTags("Organisation").RequireAuthorization(Permissions.Policy(Permissions.OrgAdmin));
        g.MapGet("/", ListSettings);
        g.MapPut("/{key}", PutSetting);
        var f = api.MapGroup("/feature-flags").WithTags("Organisation").RequireAuthorization(Permissions.Policy(Permissions.OrgAdmin));
        f.MapGet("/", ListFlags);
        f.MapPut("/{key}", PutFlag);
        return api;
    }

    private static async Task<IResult> ListSettings(AtimthaDbContext db, TenantContext tenant, OrganizationSettings settings, CancellationToken ct)
    {
        if (tenant.OrganizationId is not Guid org) return Api.Forbidden("Choose an organisation first.");
        var overridden = (await db.OrganizationSettings.AsNoTracking().Where(s => s.OrganizationId == org).Select(s => s.Key).ToListAsync(ct)).ToHashSet();
        var list = new List<SettingDto>();
        foreach (var s in OrganizationSettings.Known)
            list.Add(s.Kind == "text"
                ? new SettingDto(s.Key, JsonValue.Create(await settings.GetTextAsync(org, s.Key, ct)), JsonValue.Create(s.TextDefault), 0, 0, overridden.Contains(s.Key), s.Description, s.Kind, s.MaxLength)
                : new SettingDto(s.Key, JsonValue.Create(await settings.GetAsync(org, s.Key, ct)), JsonValue.Create(s.Default), s.Min, s.Max, overridden.Contains(s.Key), s.Description));
        return Results.Ok(list);
    }

    /// <summary>value null = back to the default</summary>
    private static async Task<IResult> PutSetting(string key, PutSettingRequest body, AtimthaDbContext db, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        if (tenant.OrganizationId is not Guid org) return Api.Forbidden("Choose an organisation first.");
        var spec = OrganizationSettings.Known.FirstOrDefault(s => s.Key == key);
        if (spec is null) return Api.NotFound("The setting");
        static IResult Bad(string message) => Results.ValidationProblem(new Dictionary<string, string[]> { ["value"] = [message] });

        JsonNode? stored = null;
        if (body.Value is not null)
        {
            if (spec.Kind == "text")
            {
                if (body.Value is not JsonValue tv || !tv.TryGetValue<string>(out var text)) return Bad("Write the value as text.");
                if (text.Length > spec.MaxLength) return Bad($"At most {spec.MaxLength} characters.");
                if (key == OrganizationSettings.AllowedEmailDomains)
                {
                    var domains = OrganizationSettings.ParseDomains(text);
                    if (domains is null) return Bad("Write domain names separated by commas, e.g. client.gov.sa, iltizamtech.com.");
                    // the administrator saving the rule must still be able to sign in afterwards
                    var mine = tenant.UserId is { } uid ? await db.Users.AsNoTracking().Where(u => u.Id == uid).Select(u => u.Email).FirstOrDefaultAsync(ct) : null;
                    if (!OrganizationSettings.EmailAllowed(mine, domains)) return Bad("Your own email domain is not in the list: you would lose access. Add it first.");
                    text = string.Join(", ", domains);
                }
                stored = JsonValue.Create(text);
            }
            else
            {
                if (body.Value is not JsonValue nv || !nv.TryGetValue<int>(out var n)) return Bad("Write the value as a whole number.");
                if (n < spec.Min || n > spec.Max) return Bad($"{spec.Min} to {spec.Max}.");
                stored = JsonValue.Create(n);
            }
        }

        var row = await db.OrganizationSettings.FirstOrDefaultAsync(s => s.OrganizationId == org && s.Key == key, ct);
        if (stored is null) { if (row is not null) db.OrganizationSettings.Remove(row); }
        else
        {
            row ??= db.OrganizationSettings.Add(new OrganizationSetting { OrganizationId = org, Key = key }).Entity;
            row.Value = stored.ToJsonString();
            row.UpdatedBy = tenant.UserId;
            row.UpdatedAt = DateTimeOffset.UtcNow;
        }
        audit.Add("organization.setting", "organization", org, new { key, value = stored?.ToJsonString() });
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> ListFlags(AtimthaDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (tenant.OrganizationId is not Guid org) return Api.Forbidden("Choose an organisation first.");
        var rows = await db.FeatureFlags.AsNoTracking().ToListAsync(ct);
        return Results.Ok(OrganizationSettings.Flags.Select(f =>
        {
            var platform = rows.FirstOrDefault(r => r.Key == f.Key && r.OrganizationId == null)?.Enabled ?? true;
            bool? own = rows.FirstOrDefault(r => r.Key == f.Key && r.OrganizationId == org)?.Enabled;
            return new FlagDto(f.Key, own ?? platform, platform, own, f.Description);
        }));
    }

    /// <summary>enabled null = follow the platform default again</summary>
    private static async Task<IResult> PutFlag(string key, PutFlagRequest body, AtimthaDbContext db, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        if (tenant.OrganizationId is not Guid org) return Api.Forbidden("Choose an organisation first.");
        if (!OrganizationSettings.Flags.Any(f => f.Key == key)) return Api.NotFound("The feature flag");
        // feature_flag has no primary key in the model (nullable organisation in a unique key): written with SQL
        if (body.Enabled is null)
            await db.Database.ExecuteSqlInterpolatedAsync($"DELETE FROM atimtha.feature_flag WHERE key = {key} AND organization_id = {org}", ct);
        else
            await db.Database.ExecuteSqlInterpolatedAsync($"""
                INSERT INTO atimtha.feature_flag (key, organization_id, enabled, updated_at) VALUES ({key}, {org}, {body.Enabled.Value}, now())
                ON CONFLICT (key, organization_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()
                """, ct);
        audit.Add("organization.feature_flag", "organization", org, new { key, enabled = body.Enabled });
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }
}
