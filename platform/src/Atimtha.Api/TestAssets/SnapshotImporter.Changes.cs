using System.Text.Json.Nodes;
using Atimtha.Api.Infrastructure;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.TestAssets;

/// <summary>Applying one reviewed case change (ADR-0007) onto an existing project.</summary>
public sealed partial class SnapshotImporter
{
    /// <summary>Fills the name → id lookups from the database (users, pages, elements, cases of the project).</summary>
    public async Task LoadLookupsAsync(Guid projectId, CancellationToken ct)
    {
        foreach (var u in await db.TestUsers.AsNoTracking().Where(x => x.ProjectId == projectId).Select(x => new { x.Key, x.Id }).ToListAsync(ct)) users[u.Key] = u.Id;
        foreach (var p in await db.Pages.AsNoTracking().Where(x => x.ProjectId == projectId).Select(x => new { x.Key, x.Id }).ToListAsync(ct)) pages[p.Key] = p.Id;
        var els = await (
            from e in db.Elements.AsNoTracking()
            join p in db.Pages.AsNoTracking() on e.PageId equals p.Id
            where p.ProjectId == projectId
            select new { Page = p.Key, e.Key, e.Id }).ToListAsync(ct);
        foreach (var e in els) elements[(e.Page, e.Key)] = e.Id;
        foreach (var c in await db.Cases.AsNoTracking().Where(x => x.ProjectId == projectId).Select(x => new { x.Key, x.Id }).ToListAsync(ct)) cases[c.Key] = c.Id;
    }

    /// <summary>
    /// Rebuilds one case from new content, inside the caller's transaction. The case row keeps its id (results keep
    /// pointing at it); data rows are matched by key and updated in place (workflow steps and results keep theirs);
    /// steps and dependencies are replaced. Returns the case, or null with Problems filled (nothing saved then).
    /// </summary>
    public async Task<TestCase?> ApplyCaseAsync(Project project, string caseKey, JsonObject c, CancellationToken ct)
    {
        if (Str(c["case"]) is not { } title) { Problems.Add($"case {caseKey}: \"case\" (its name) is required"); return null; }
        var existing = await db.Cases.FirstOrDefaultAsync(x => x.ProjectId == project.Id && x.Key == caseKey, ct);
        var tc = existing ?? new TestCase { Id = Guid.NewGuid(), OrganizationId = organizationId, ProjectId = project.Id, Key = caseKey, CreatedBy = userId, CurrentVersion = 0 };
        cases[caseKey] = tc.Id;

        var startPage = Str(c["page"]);
        var user = Str(c["user"]);
        tc.Engine = Str(c["engine"]) == "api" ? "api" : "web";
        tc.Title = title;
        tc.Description = Str(c["description"]);
        tc.Module = Str(c["module"]);
        tc.CaseType = Str(c["type"]) switch { "positive" => CaseType.Positive, "negative" => CaseType.Negative, _ => null };
        tc.StartPageId = startPage is not null && pages.TryGetValue(startPage, out var sp) ? sp : null;
        tc.StartUrl = Str(c["url"]);
        tc.StartLoggedOut = user == "none";
        tc.StartUserId = user is not null and not "none" && users.TryGetValue(user, out var su) ? su : null;
        tc.Tags = Strings(c["tags"]);
        tc.ContinueFromRowKey = Str((c["continueFrom"] as JsonObject)?["row"]);
        tc.UpdatedAt = now;
        if (startPage is not null && tc.StartPageId is null) Problems.Add($"case {caseKey}: page \"{startPage}\" is not defined");
        if (user is not null and not "none" && tc.StartUserId is null) Problems.Add($"case {caseKey}: user \"{user}\" is not defined");
        var continueFrom = Str((c["continueFrom"] as JsonObject)?["case"]);
        if (continueFrom is not null)
        {
            if (cases.TryGetValue(continueFrom, out var cf) && cf != tc.Id) tc.ContinueFromCaseId = cf;
            else Problems.Add($"case {caseKey}: continueFrom \"{continueFrom}\" is not another case");
        }
        else tc.ContinueFromCaseId = null;

        // new steps (staged, saved below)
        ImportSteps(tc, "", c["steps"] as JsonArray, caseKey);
        foreach (var (outcome, list) in c["outcomes"] as JsonObject ?? [])
        {
            if (string.IsNullOrEmpty(outcome)) { Problems.Add($"case {caseKey}: an outcome needs a name"); continue; }
            ImportSteps(tc, outcome, list as JsonArray, caseKey);
        }
        var dependsOn = Strings(c["dependsOn"]);
        foreach (var d in dependsOn)
            if (!cases.TryGetValue(d, out var dep) || dep == tc.Id) Problems.Add($"case {caseKey}: dependsOn \"{d}\" is not another case");

        // proposed rows, by key
        var proposed = new List<(string Key, JsonObject Node)>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var i = 0;
        foreach (var node in c["data"] as JsonArray ?? [])
        {
            if (node is not JsonObject r) { Problems.Add($"case {caseKey}: data row {i + 1} must be an object"); i++; continue; }
            var key = Str(r["id"]) ?? $"ROW-{i + 1:000}";
            if (!seen.Add(key)) Problems.Add($"case {caseKey}: data row id \"{key}\" is repeated");
            proposed.Add((key, r));
            i++;
        }
        if (Problems.Count > 0) return null;

        // 1. remove old steps and dependencies; unlink workflow steps from rows that disappear
        var oldRows = existing is null ? new List<DataRow>() : await db.DataRows.Where(r => r.CaseId == tc.Id).ToListAsync(ct);
        var removedRows = oldRows.Where(r => !seen.Contains(r.Key)).ToList();
        if (existing is not null)
        {
            db.Steps.RemoveRange(await db.Steps.Where(s => s.CaseId == tc.Id).ToListAsync(ct));
            db.CaseDependencies.RemoveRange(await db.CaseDependencies.Where(d => d.CaseId == tc.Id).ToListAsync(ct));
            var removedIds = removedRows.Select(r => r.Id).ToList();
            foreach (var ws in await db.WorkflowSteps.Where(w => w.DataRowId != null && removedIds.Contains(w.DataRowId.Value)).ToListAsync(ct)) ws.DataRowId = null;
            await db.SaveChangesAsync(ct);
            db.DataRows.RemoveRange(removedRows);
            await db.SaveChangesAsync(ct);
        }

        // 2. the case itself, then rows (updated in place or new), then steps and dependencies
        tc.CurrentVersion += 1;
        if (existing is null) db.Cases.Add(tc);
        await db.SaveChangesAsync(ct);

        var position = 0;
        foreach (var (key, r) in proposed)
        {
            var fields = new JsonObject();
            foreach (var (k, v) in r) if (!ReservedRowKeys.Contains(k)) fields[k] = v?.DeepClone();
            var row = oldRows.FirstOrDefault(o => o.Key == key) ?? db.DataRows.Add(new DataRow { Id = Guid.NewGuid(), OrganizationId = organizationId, CaseId = tc.Id, Key = key }).Entity;
            row.Position = position++;
            row.Title = Str(r["title"]);
            row.RowType = Str(r["type"]) switch { "positive" => CaseType.Positive, "negative" => CaseType.Negative, _ => null };
            row.Outcome = Str(r["outcome"]);
            row.Tags = Strings(r["tags"]);
            row.Skip = Bool(r["skip"]);
            row.Fields = fields.ToJsonString();
            rows[(tc.Id, key)] = row.Id;
        }
        foreach (var d in dependsOn.Distinct()) db.CaseDependencies.Add(new CaseDependency { OrganizationId = organizationId, CaseId = tc.Id, DependsOnCaseId = cases[d] });
        foreach (var step in staged[6].OfType<TestStep>()) db.Steps.Add(step);
        staged[6].RemoveAll(e => e is TestStep);
        await db.SaveChangesAsync(ct);

        // 3. the new immutable version
        var json = c.ToJsonString();
        db.AssetVersions.Add(new AssetVersion
        {
            Id = Guid.NewGuid(), OrganizationId = organizationId, ProjectId = project.Id, AssetType = AssetType.TestCase, AssetId = tc.Id,
            Version = tc.CurrentVersion, Content = json, ContentSha256 = Sha256(json), CreatedBy = userId, CreatedAt = now,
        });
        return tc;
    }

    /// <summary>The asset_version row just staged for a case, to link it to its change set.</summary>
    public AssetVersion? LastVersionFor(Guid caseId) =>
        db.ChangeTracker.Entries<AssetVersion>().Select(e => e.Entity).LastOrDefault(v => v.AssetId == caseId && v.AssetType == AssetType.TestCase);
}
