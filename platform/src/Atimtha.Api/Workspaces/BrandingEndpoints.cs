using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Atimtha.Api.Execution;
using Atimtha.Api.Identity;
using Atimtha.Api.Infrastructure;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.Workspaces;

using Api = Atimtha.Api.Infrastructure.Api;

/// <summary>Report branding of a client or delivery (0.1.0 branding/profiles.yml), mapped onto branding_profile.</summary>
public sealed class BrandingProfile
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public string Key { get; set; } = "";
    public string Name { get; set; } = "";
    public string? Company { get; set; }
    public string? Client { get; set; }
    public string? PrimaryColor { get; set; }
    public string? ReportTitle { get; set; }
    public string? Footer { get; set; }
    public string? Confidentiality { get; set; }
    public string? LogoObjectKey { get; set; }
}

public sealed record BrandingDto(string Key, string Name, string? Company, string? Client, string? PrimaryColor, string? ReportTitle, string? Footer,
    string? Confidentiality, bool HasLogo, int Projects);
public sealed record PutBrandingRequest(string? Name, string? Company, string? Client, string? PrimaryColor, string? ReportTitle, string? Footer, string? Confidentiality);
public sealed record ProjectBrandingRequest(string? Profile);

/// <summary>
/// /api/v1/branding: report branding profiles (logo, colour, titles) for client deliveries; a project picks one, and
/// agents receive it with the job so the Smart Report carries the client's branding.
/// </summary>
public static partial class BrandingEndpoints
{
    private const int MaxLogoBytes = 512 * 1024;
    private static readonly string[] LogoTypes = ["image/png", "image/jpeg", "image/webp"];

    [GeneratedRegex("^#[0-9a-fA-F]{6}$")]
    private static partial Regex Color();

    public static RouteGroupBuilder MapBranding(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/branding").WithTags("Branding");
        g.MapGet("/", List).RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        g.MapPut("/{key}", Put).RequireAuthorization(Permissions.Policy(Permissions.WorkspaceManage));
        g.MapDelete("/{key}", Delete).RequireAuthorization(Permissions.Policy(Permissions.WorkspaceManage));
        g.MapPut("/{key}/logo", PutLogo).RequireAuthorization(Permissions.Policy(Permissions.WorkspaceManage))
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(MaxLogoBytes + 1024));
        g.MapDelete("/{key}/logo", DeleteLogo).RequireAuthorization(Permissions.Policy(Permissions.WorkspaceManage));
        g.MapGet("/{key}/logo", GetLogo).RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        api.MapGet("/projects/{projectId:guid}/branding", Assigned).WithTags("Branding").RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        api.MapPut("/projects/{projectId:guid}/branding", Assign).WithTags("Branding").RequireAuthorization(Permissions.Policy(Permissions.ProjectEdit));
        return api;
    }

    private static async Task<IResult> List(AtimthaDbContext db, CancellationToken ct)
    {
        var rows = await db.BrandingProfiles.AsNoTracking().OrderBy(b => b.Name).ToListAsync(ct);
        var counts = await db.Projects.AsNoTracking().Where(p => p.BrandingProfileId != null && p.ArchivedAt == null)
            .GroupBy(p => p.BrandingProfileId).Select(g => new { g.Key, Count = g.Count() }).ToDictionaryAsync(x => x.Key!.Value, x => x.Count, ct);
        return Results.Ok(rows.Select(b => ToDto(b, counts.GetValueOrDefault(b.Id))));
    }

    private static async Task<IResult> Put(string key, PutBrandingRequest body, AtimthaDbContext db, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        if (tenant.OrganizationId is not Guid org) return Api.Forbidden("Choose an organisation first.");
        var v = new Api.Validation()
            .Key(key)
            .Text(body.Name, "name", 100)
            .Require(body.PrimaryColor is null or "" || Color().IsMatch(body.PrimaryColor), "primaryColor", "Use a colour like #0e2a2a.");
        foreach (var (field, value) in new[] { ("company", body.Company), ("client", body.Client), ("reportTitle", body.ReportTitle), ("footer", body.Footer), ("confidentiality", body.Confidentiality) })
            v.Text(value, field, 200, required: false);
        if (!v.IsValid) return v.Problem();

        var b = await db.BrandingProfiles.FirstOrDefaultAsync(x => x.Key == key, ct);
        var created = b is null;
        b ??= db.BrandingProfiles.Add(new BrandingProfile { Id = Guid.NewGuid(), OrganizationId = org, Key = key }).Entity;
        static string? N(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
        b.Name = body.Name!.Trim();
        b.Company = N(body.Company);
        b.Client = N(body.Client);
        b.PrimaryColor = N(body.PrimaryColor)?.ToLowerInvariant();
        b.ReportTitle = N(body.ReportTitle);
        b.Footer = N(body.Footer);
        b.Confidentiality = N(body.Confidentiality);
        audit.Add(created ? "branding.create" : "branding.update", "branding_profile", b.Id, new { key, b.Name, b.Client });
        await db.SaveChangesAsync(ct);
        var dto = ToDto(b, await db.Projects.CountAsync(p => p.BrandingProfileId == b.Id, ct));
        return created ? Results.Created($"/api/v1/branding/{key}", dto) : Results.Ok(dto);
    }

    private static async Task<IResult> Delete(string key, AtimthaDbContext db, IEvidenceStore store, AuditWriter audit, CancellationToken ct)
    {
        var b = await db.BrandingProfiles.FirstOrDefaultAsync(x => x.Key == key, ct);
        if (b is null) return Api.NotFound("The branding profile");
        if (await db.Projects.AnyAsync(p => p.BrandingProfileId == b.Id, ct)) return Api.Conflict("Projects still use this profile. Give them another one first.");
        db.BrandingProfiles.Remove(b);
        audit.Add("branding.delete", "branding_profile", b.Id, new { key });
        await db.SaveChangesAsync(ct);
        if (b.LogoObjectKey is { } k) await store.DeleteAsync(k, ct);
        return Results.NoContent();
    }

    /// <summary>Raw image body (png, jpeg or webp, at most 512 KB). SVG is refused: it can carry scripts.</summary>
    private static async Task<IResult> PutLogo(string key, HttpRequest request, AtimthaDbContext db, IEvidenceStore store, AuditWriter audit, CancellationToken ct)
    {
        var b = await db.BrandingProfiles.FirstOrDefaultAsync(x => x.Key == key, ct);
        if (b is null) return Api.NotFound("The branding profile");
        var type = (request.ContentType ?? "").Split(';')[0].Trim().ToLowerInvariant();
        if (!LogoTypes.Contains(type)) return Results.Problem(statusCode: 415, title: "Unsupported media type", detail: "Use a PNG, JPEG or WebP image.");
        using var buffer = new MemoryStream();
        await request.Body.CopyToAsync(buffer, ct);
        if (buffer.Length is 0 or > MaxLogoBytes) return Results.Problem(statusCode: 413, title: "Too large", detail: "The logo must be under 512 KB.");
        var bytes = buffer.ToArray();
        if (!LooksLike(type, bytes)) return Results.Problem(statusCode: 415, title: "Unsupported media type", detail: "The file is not the image type it claims to be.");

        var old = b.LogoObjectKey;
        b.LogoObjectKey = $"{b.OrganizationId}/{b.Id}/{Guid.NewGuid()}";
        // content type travels with the bytes: the first byte names it
        await store.PutAsync(b.LogoObjectKey, [(byte)Array.IndexOf(LogoTypes, type), .. bytes], ct);
        audit.Add("branding.logo", "branding_profile", b.Id, new { key, bytes = bytes.Length, type });
        await db.SaveChangesAsync(ct);
        if (old is not null) await store.DeleteAsync(old, ct);
        return Results.NoContent();
    }

    private static async Task<IResult> DeleteLogo(string key, AtimthaDbContext db, IEvidenceStore store, AuditWriter audit, CancellationToken ct)
    {
        var b = await db.BrandingProfiles.FirstOrDefaultAsync(x => x.Key == key, ct);
        if (b is null) return Api.NotFound("The branding profile");
        if (b.LogoObjectKey is { } k)
        {
            b.LogoObjectKey = null;
            audit.Add("branding.logo_remove", "branding_profile", b.Id, new { key });
            await db.SaveChangesAsync(ct);
            await store.DeleteAsync(k, ct);
        }
        return Results.NoContent();
    }

    private static async Task<IResult> GetLogo(string key, HttpContext http, AtimthaDbContext db, IEvidenceStore store, CancellationToken ct)
    {
        var b = await db.BrandingProfiles.AsNoTracking().FirstOrDefaultAsync(x => x.Key == key, ct);
        if (b?.LogoObjectKey is null) return Api.NotFound("The logo");
        var logo = await ReadLogoAsync(store, b.LogoObjectKey, ct);
        if (logo is null) return Api.NotFound("The logo");
        http.Response.Headers.XContentTypeOptions = "nosniff";
        http.Response.Headers.CacheControl = "private, max-age=300";
        return Results.File(logo.Value.Bytes, logo.Value.Type);
    }

    private static async Task<IResult> Assigned(Guid projectId, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        var project = await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct);
        if (project is null) return Api.NotFound("The project");
        var key = project.BrandingProfileId is Guid id ? await db.BrandingProfiles.AsNoTracking().Where(b => b.Id == id).Select(b => b.Key).FirstOrDefaultAsync(ct) : null;
        return Results.Ok(new ProjectBrandingRequest(key));
    }

    private static async Task<IResult> Assign(Guid projectId, ProjectBrandingRequest body, AtimthaDbContext db, AccessService access, AuditWriter audit, CancellationToken ct)
    {
        var visible = await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct);
        if (visible is null) return Api.NotFound("The project");
        if (!await access.HasInWorkspaceAsync(Permissions.ProjectEdit, visible.WorkspaceId, ct)) return Api.Forbidden("You cannot edit this project.");
        var project = await db.Projects.FirstAsync(p => p.Id == projectId, ct);
        Guid? profileId = null;
        if (!string.IsNullOrEmpty(body.Profile))
        {
            profileId = await db.BrandingProfiles.Where(b => b.Key == body.Profile).Select(b => (Guid?)b.Id).FirstOrDefaultAsync(ct);
            if (profileId is null) return Api.NotFound("The branding profile");
        }
        project.BrandingProfileId = profileId;
        project.UpdatedAt = DateTimeOffset.UtcNow;
        audit.Add("project.branding", "project", project.Id, new { project = project.Key, profile = body.Profile });
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    // ---------------------------------------------------------------- shared with the snapshot

    internal static async Task<(byte[] Bytes, string Type)?> ReadLogoAsync(IEvidenceStore store, string objectKey, CancellationToken ct)
    {
        var data = await store.GetAsync(objectKey, ct);
        if (data is null || data.Length < 2 || data[0] >= LogoTypes.Length) return null;
        return (data[1..], LogoTypes[data[0]]);
    }

    /// <summary>The profile as the 0.1.0 Smart Report reads it (src/core/branding.ts), logo as a data URI.</summary>
    internal static async Task<JsonObject?> ToReportProfileAsync(AtimthaDbContext db, IEvidenceStore? store, Guid? profileId, CancellationToken ct)
    {
        if (profileId is null) return null;
        var b = await db.BrandingProfiles.AsNoTracking().FirstOrDefaultAsync(x => x.Id == profileId, ct);
        if (b is null) return null;
        var o = new JsonObject { ["key"] = b.Key, ["name"] = b.Name };
        void Set(string k, string? v) { if (v is not null) o[k] = v; }
        Set("company", b.Company); Set("client", b.Client); Set("primaryColor", b.PrimaryColor); Set("reportTitle", b.ReportTitle);
        Set("footer", b.Footer); Set("confidentiality", b.Confidentiality);
        if (store is not null && b.LogoObjectKey is not null && await ReadLogoAsync(store, b.LogoObjectKey, ct) is { } logo)
            o["logo"] = $"data:{logo.Type};base64,{Convert.ToBase64String(logo.Bytes)}";
        return o;
    }

    private static bool LooksLike(string type, byte[] b) => type switch
    {
        "image/png" => b.Length > 8 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47,
        "image/jpeg" => b.Length > 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF,
        "image/webp" => b.Length > 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P',
        _ => false,
    };

    private static BrandingDto ToDto(BrandingProfile b, int projects) =>
        new(b.Key, b.Name, b.Company, b.Client, b.PrimaryColor, b.ReportTitle, b.Footer, b.Confidentiality, b.LogoObjectKey is not null, projects);
}
