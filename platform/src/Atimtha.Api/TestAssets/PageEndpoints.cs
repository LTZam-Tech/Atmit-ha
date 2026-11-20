using System.Text.Json.Nodes;
using Atimtha.Api.Execution;
using Atimtha.Api.Identity;
using Atimtha.Api.Infrastructure;
using Atimtha.Api.Workspaces;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.TestAssets;

using Api = Atimtha.Api.Infrastructure.Api;

public sealed record ElementDto(
    string Key, JsonNode? Locator, IReadOnlyList<JsonNode?> Fallbacks, string? Within, string? Frame, int? Nth, string? HasText,
    string? Control, string? Description, int Healed30d, string? LastHealedBy);

public sealed record PageLinkDto(string Page, int Steps);

public sealed record PageDetailDto(
    string Key, string? Url, string OpenMode, string? Description, string? ReadyWhen, string? SignedInAs, bool LoggedOut, string[] Tags,
    int Version, IReadOnlyList<ElementDto> Elements, IReadOnlyList<PageLinkDto> LeadsTo, IReadOnlyList<PageLinkDto> ReachedFrom);

/// <summary>
/// GET /api/v1/projects/{id}/pages/{key}: one page of the object repository with its elements, locators and fallbacks,
/// the navigation around it, and how often each locator needed self-healing in the last 30 days (which locators to fix).
/// </summary>
public static class PageEndpoints
{
    public static RouteGroupBuilder MapPages(this RouteGroupBuilder api)
    {
        api.MapGet("/projects/{projectId:guid}/pages/{key}", Get).WithTags("Test assets").RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        api.MapGet("/projects/{projectId:guid}/elements", Elements).WithTags("Test assets").RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        return api;
    }

    public sealed record ElementRefDto(string Page, string Element, string? Control, string? Description);

    /// <summary>Every element of the project as "page.element", for the Test Builder's element picker.</summary>
    private static async Task<IResult> Elements(Guid projectId, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        if (await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct) is null) return Api.NotFound("The project");
        var rows = await (
            from e in db.Elements.AsNoTracking()
            join p in db.Pages.AsNoTracking() on e.PageId equals p.Id
            where p.ProjectId == projectId
            orderby p.Key, e.Position
            select new ElementRefDto(p.Key, e.Key, e.Control, e.Description)).ToListAsync(ct);
        return Results.Ok(rows);
    }

    private static async Task<IResult> Get(Guid projectId, string key, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        if (await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct) is null) return Api.NotFound("The project");
        var page = await db.Pages.AsNoTracking().FirstOrDefaultAsync(p => p.ProjectId == projectId && p.Key == key, ct);
        if (page is null) return Api.NotFound("The page");

        var elements = await db.Elements.AsNoTracking().Where(e => e.PageId == page.Id).OrderBy(e => e.Position).ToListAsync(ct);
        var ids = elements.Select(e => e.Id).ToList();
        var fallbacks = (await db.LocatorFallbacks.AsNoTracking().Where(f => ids.Contains(f.ElementId)).OrderBy(f => f.Position).ToListAsync(ct))
            .ToLookup(f => f.ElementId);
        var keyOf = elements.ToDictionary(e => e.Id, e => e.Key);

        var pageKeys = await db.Pages.AsNoTracking().Where(p => p.ProjectId == projectId).ToDictionaryAsync(p => p.Id, p => p.Key, ct);
        var edges = await db.NavigationEdges.AsNoTracking().Where(e => e.FromPageId == page.Id || e.ToPageId == page.Id).ToListAsync(ct);
        static int StepCount(string json) => JsonNode.Parse(json) is JsonArray a ? a.Count : 0;

        // self-healing of this page's elements in the project's runs of the last 30 days
        var since = DateTimeOffset.UtcNow.AddDays(-30);
        var prefix = page.Key + ".";
        var heals = await (
            from h in db.HealingEvents.AsNoTracking()
            join r in db.Results.AsNoTracking() on h.TestResultId equals r.Id
            join x in db.Executions.AsNoTracking() on r.ExecutionId equals x.Id
            where x.ProjectId == projectId && x.QueuedAt >= since && h.Kind == HealKind.FallbackLocator && h.Target.StartsWith(prefix)
            select new { h.Target, h.HealedBy, x.QueuedAt }).ToListAsync(ct);
        var healsByElement = heals.GroupBy(h => h.Target[prefix.Length..]).ToDictionary(g => g.Key, g => (Count: g.Count(), Last: g.MaxBy(x => x.QueuedAt)!.HealedBy));

        var signedInAs = page.AuthUserId is Guid uid
            ? await db.TestUsers.AsNoTracking().Where(u => u.Id == uid).Select(u => u.Key).FirstOrDefaultAsync(ct)
            : null;

        return Results.Ok(new PageDetailDto(
            page.Key, page.Url, page.OpenMode == PageOpenMode.Navigate ? "navigate" : "url", page.Description,
            page.ReadyWhenElementId is Guid rw ? keyOf.GetValueOrDefault(rw) : null, signedInAs, page.AuthLoggedOut, page.Tags, page.CurrentVersion,
            elements.Select(e => new ElementDto(
                e.Key, Parse(e.Strategy), fallbacks[e.Id].Select(f => Parse(f.Strategy)).ToList(),
                e.WithinElementId is Guid w ? keyOf.GetValueOrDefault(w) : null, e.Frame, e.Nth, e.HasText, e.Control, e.Description,
                healsByElement.TryGetValue(e.Key, out var hs) ? hs.Count : 0, healsByElement.TryGetValue(e.Key, out var hl) ? hl.Last : null)).ToList(),
            edges.Where(e => e.FromPageId == page.Id).Select(e => new PageLinkDto(pageKeys.GetValueOrDefault(e.ToPageId, "?"), StepCount(e.Steps))).OrderBy(l => l.Page).ToList(),
            edges.Where(e => e.ToPageId == page.Id).Select(e => new PageLinkDto(pageKeys.GetValueOrDefault(e.FromPageId, "?"), StepCount(e.Steps))).OrderBy(l => l.Page).ToList()));
    }

    private static JsonNode? Parse(string json)
    {
        try { return JsonNode.Parse(json); }
        catch (System.Text.Json.JsonException) { return JsonValue.Create(json); }
    }
}
