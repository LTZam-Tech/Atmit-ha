using System.Text.Json.Nodes;
using Atimtha.Api.Infrastructure;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.TestAssets;

/// <summary>Applying one reviewed page change (object repository, ADR-0007) onto an existing project.</summary>
public sealed partial class SnapshotImporter
{
    /// <summary>
    /// Rebuilds one page from new content, inside the caller's transaction. The page row keeps its id (cases, navigation
    /// and login keep pointing at it); elements are matched by key and updated in place, so test steps keep theirs.
    /// An element that test steps or the login settings still use cannot be removed. Fallback locators are replaced.
    /// Returns the page, or null with Problems filled (nothing saved then).
    /// </summary>
    public async Task<Page?> ApplyPageAsync(Project project, string pageKey, JsonObject p, CancellationToken ct)
    {
        if (Str(p["page"]) != pageKey) { Problems.Add($"page {pageKey}: \"page\" must equal its key"); return null; }
        var existing = await db.Pages.FirstOrDefaultAsync(x => x.ProjectId == project.Id && x.Key == pageKey, ct);
        var page = existing ?? new Page { Id = Guid.NewGuid(), OrganizationId = organizationId, ProjectId = project.Id, Key = pageKey, CurrentVersion = 0 };
        pages[pageKey] = page.Id;

        var auth = Str(p["auth"]);
        page.Url = Str(p["url"]);
        page.OpenMode = Str(p["open"]) == "navigate" ? PageOpenMode.Navigate : PageOpenMode.Url;
        page.Description = Str(p["description"]);
        page.AuthLoggedOut = auth == "none";
        page.AuthUserId = auth is not null and not "none" && users.TryGetValue(auth, out var uid) ? uid : null;
        page.Tags = Strings(p["tags"]);
        page.Settings = (p["settings"] as JsonObject)?.ToJsonString() ?? "{}";
        page.UpdatedAt = now;
        if (auth is not null and not "none" && page.AuthUserId is null) Problems.Add($"page {pageKey}: auth user \"{auth}\" is not defined");

        // proposed elements, in order
        var defaultStrategy = Str((p["settings"] as JsonObject)?["defaultStrategy"]) ?? "testid";
        var proposed = new List<(string Key, JsonNode Node)>();
        foreach (var (elKey, elNode) in p["elements"] as JsonObject ?? [])
        {
            if (elNode is not (JsonObject or JsonValue)) { Problems.Add($"page {pageKey}, element {elKey}: must be a string or an object"); continue; }
            proposed.Add((elKey, elNode));
        }
        var keys = proposed.Select(e => e.Key).ToHashSet(StringComparer.Ordinal);
        var readyWhen = Str(p["readyWhen"]);
        if (readyWhen is not null && !keys.Contains(readyWhen)) Problems.Add($"page {pageKey}: readyWhen \"{readyWhen}\" is not one of its elements");
        foreach (var (k, n) in proposed)
            if (n is JsonObject d && Str(d["within"]) is { } w && (!keys.Contains(w) || w == k)) Problems.Add($"page {pageKey}, element {k}: within \"{w}\" is not another element of the page");

        // elements that disappear must not be in use
        var oldElements = existing is null ? new List<Element>() : await db.Elements.Where(e => e.PageId == page.Id).ToListAsync(ct);
        var removed = oldElements.Where(e => !keys.Contains(e.Key)).ToList();
        if (removed.Count > 0)
        {
            var removedIds = removed.Select(e => e.Id).ToList();
            var usedBySteps = await (
                from s in db.Steps.AsNoTracking().Where(s => s.ElementId != null && removedIds.Contains(s.ElementId.Value))
                join c in db.Cases.AsNoTracking() on s.CaseId equals c.Id
                select new { s.ElementId, Case = c.Key }).Distinct().ToListAsync(ct);
            foreach (var g in usedBySteps.GroupBy(u => u.ElementId))
                Problems.Add($"page {pageKey}: element \"{removed.First(e => e.Id == g.Key).Key}\" is still used by {string.Join(", ", g.Select(x => x.Case).Distinct().Take(5))}");
            var login = await db.LoginConfigs.AsNoTracking().FirstOrDefaultAsync(l => l.ProjectId == project.Id, ct);
            if (login is not null && new Guid?[] { login.UsernameElementId, login.PasswordElementId, login.SubmitElementId, login.SuccessElementId }.Any(id => id is Guid g && removedIds.Contains(g)))
                Problems.Add($"page {pageKey}: the login settings use an element that this change removes");
        }
        if (Problems.Count > 0) return null;

        // 1. unlink references inside the page, drop fallbacks and removed elements
        page.ReadyWhenElementId = null;
        foreach (var e in oldElements) e.WithinElementId = null;
        if (existing is not null)
        {
            await db.SaveChangesAsync(ct);
            var oldIds = oldElements.Select(e => e.Id).ToList();
            db.LocatorFallbacks.RemoveRange(await db.LocatorFallbacks.Where(f => oldIds.Contains(f.ElementId)).ToListAsync(ct));
            db.Elements.RemoveRange(removed);
            await db.SaveChangesAsync(ct);
        }

        // 2. the page, then its elements (updated in place or new), then fallbacks and references
        page.CurrentVersion += 1;
        if (existing is null) db.Pages.Add(page);
        await db.SaveChangesAsync(ct);

        var byKey = new Dictionary<string, Element>(StringComparer.Ordinal);
        var withins = new List<(Element Element, string Within)>();
        var fallbacks = new List<LocatorFallback>();
        var position = 0;
        foreach (var (elKey, node) in proposed)
        {
            var el = oldElements.FirstOrDefault(o => o.Key == elKey)
                ?? db.Elements.Add(new Element { Id = Guid.NewGuid(), OrganizationId = organizationId, PageId = page.Id, Key = elKey }).Entity;
            el.Position = position++;
            // reset everything, then fill from the proposed definition
            el.Frame = null; el.Nth = null; el.HasText = null; el.Control = null; el.Semantic = null; el.Rules = null;
            el.Format = null; el.Options = null; el.Href = null; el.NewTab = null; el.Messages = null; el.Description = null;
            if (node is JsonValue v && v.TryGetValue<string>(out var shorthand))
            {
                el.Strategy = new JsonObject { [defaultStrategy] = shorthand }.ToJsonString();
            }
            else if (node is JsonObject d)
            {
                el.Strategy = Pick(d, StrategyKeys).ToJsonString();
                el.Frame = Str(d["frame"]);
                el.Nth = d["nth"] is JsonValue nv && nv.TryGetValue<int>(out var nth) ? nth : null;
                el.HasText = d["hasText"]?.ToJsonString();
                el.Control = Str(d["control"]);
                el.Semantic = Str(d["semantic"]);
                el.Rules = d["rules"]?.ToJsonString();
                el.Format = Str(d["format"]);
                el.Options = d["options"] is JsonArray ? Strings(d["options"]) : null;
                el.Href = Str(d["href"]);
                el.NewTab = d["newTab"] is JsonValue tv && tv.TryGetValue<bool>(out var nt) ? nt : null;
                el.Messages = d["messages"] is JsonArray ? Strings(d["messages"]) : null;
                el.Description = Str(d["description"]);
                if (Str(d["within"]) is { } within) withins.Add((el, within));
                var fallbackPosition = 1;
                foreach (var fb in d["fallback"] as JsonArray ?? [])
                    if (fb is JsonObject f)
                        fallbacks.Add(new LocatorFallback { Id = Guid.NewGuid(), OrganizationId = organizationId, ElementId = el.Id, Position = fallbackPosition++, Strategy = f.ToJsonString() });
            }
            byKey[elKey] = el;
            elements[(pageKey, elKey)] = el.Id;
        }
        await db.SaveChangesAsync(ct);

        db.LocatorFallbacks.AddRange(fallbacks);
        foreach (var (el, within) in withins) el.WithinElementId = byKey[within].Id;
        page.ReadyWhenElementId = readyWhen is null ? null : byKey[readyWhen].Id;
        await db.SaveChangesAsync(ct);

        // 3. the new immutable version (what agents receive)
        var json = p.ToJsonString();
        db.AssetVersions.Add(new AssetVersion
        {
            Id = Guid.NewGuid(), OrganizationId = organizationId, ProjectId = project.Id, AssetType = AssetType.Page, AssetId = page.Id,
            Version = page.CurrentVersion, Content = json, ContentSha256 = Sha256(json), CreatedBy = userId, CreatedAt = now,
        });
        return page;
    }

    /// <summary>The asset_version row just staged for an asset, to link it to its change set.</summary>
    public AssetVersion? LastVersionFor(Guid assetId, AssetType type) =>
        db.ChangeTracker.Entries<AssetVersion>().Select(e => e.Entity).LastOrDefault(v => v.AssetId == assetId && v.AssetType == type);
}
