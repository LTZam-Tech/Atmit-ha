using System.Text.Json.Nodes;
using Atimtha.Api.Infrastructure;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.TestAssets;

/// <summary>
/// Builds the project snapshot from the latest version of every asset (ADR-0012: versions hold the 0.1.0 shape),
/// for export, for agents (ADR-0014) and for the 0.1.0 Control Panel to import back.
/// </summary>
public static class SnapshotExporter
{
    /// <summary>where branding logos live (set at start-up); null in tools that build snapshots without it</summary>
    public static Execution.IEvidenceStore? LogoStore { get; set; }

    public static async Task<JsonObject?> BuildAsync(AtimthaDbContext db, Guid projectId, CancellationToken ct)
    {
        var project = await db.Projects.AsNoTracking().FirstOrDefaultAsync(p => p.Id == projectId, ct);
        if (project is null) return null;

        // latest version per asset (versions are few per asset; picking in memory keeps the query simple)
        var versions = await db.AssetVersions.AsNoTracking()
            .Where(v => v.ProjectId == projectId)
            .Select(v => new { v.AssetType, v.AssetId, v.Version, v.Content })
            .ToListAsync(ct);
        var latest = versions
            .GroupBy(v => (v.AssetType, v.AssetId))
            .Select(g => g.MaxBy(v => v.Version)!)
            .ToList();

        var caseKeys = await db.Cases.AsNoTracking().Where(c => c.ProjectId == projectId).ToDictionaryAsync(c => c.Id, c => c.Key, ct);
        var flowKeys = await db.Workflows.AsNoTracking().Where(w => w.ProjectId == projectId).ToDictionaryAsync(w => w.Id, w => w.Key, ct);

        JsonNode Content(AssetType type) =>
            latest.FirstOrDefault(v => v.AssetType == type && v.AssetId == projectId) is { } v ? JsonNode.Parse(v.Content)! : new JsonObject();

        var pages = new JsonObject();
        var cases = new JsonObject();
        var flows = new JsonObject();
        foreach (var v in latest.OrderBy(v => v.AssetId))
        {
            var node = JsonNode.Parse(v.Content)!;
            switch (v.AssetType)
            {
                case AssetType.Page when SnapshotImporter.Str(node["page"]) is { } key:
                    pages[key] = node;
                    break;
                case AssetType.TestCase when caseKeys.TryGetValue(v.AssetId, out var key):
                    cases[key] = node;
                    break;
                case AssetType.Workflow when flowKeys.TryGetValue(v.AssetId, out var key):
                    flows[key] = node;
                    break;
            }
        }

        var navigation = Content(AssetType.Navigation);
        var app = Content(AssetType.Project) as JsonObject ?? new JsonObject();
        await ApplyLiveSettingsAsync(db, project, app, ct);
        // the project's report branding travels with the job (src/core/branding.ts reads it on the agent)
        var branding = await Workspaces.BrandingEndpoints.ToReportProfileAsync(db, LogoStore, project.BrandingProfileId, ct);
        if (branding is not null) app["branding"] = branding["key"]!.GetValue<string>(); else app.Remove("branding");

        var versionMap = new JsonObject
        {
            ["pages"] = new JsonObject(latest.Where(v => v.AssetType == AssetType.Page)
                .Select(v => (Key: SnapshotImporter.Str(JsonNode.Parse(v.Content)!["page"]), v.Version))
                .Where(x => x.Key is not null).Select(x => KeyValuePair.Create(x.Key!, (JsonNode?)x.Version))),
            ["cases"] = new JsonObject(latest.Where(v => v.AssetType == AssetType.TestCase && caseKeys.ContainsKey(v.AssetId))
                .Select(v => KeyValuePair.Create(caseKeys[v.AssetId], (JsonNode?)v.Version))),
            ["flows"] = new JsonObject(latest.Where(v => v.AssetType == AssetType.Workflow && flowKeys.ContainsKey(v.AssetId))
                .Select(v => KeyValuePair.Create(flowKeys[v.AssetId], (JsonNode?)v.Version))),
        };

        return new JsonObject
        {
            ["contract"] = SnapshotImporter.Contract,
            ["key"] = project.Key,
            ["versions"] = versionMap,
            ["app"] = app,
            ["messages"] = await Workspaces.ProjectDataEndpoints.MessagesAsync(db, project.Id, ct),   // edited as rows
            ["pages"] = pages,
            ["cases"] = cases,
            ["flows"] = flows,
            ["navigation"] = navigation is JsonObject { Count: > 0 } ? navigation : new JsonObject { ["edges"] = new JsonArray() },
            ["suites"] = await SuiteEndpoints.ToSnapshotAsync(db, project.Id, ct),   // edited as rows (SuiteEndpoints)
            ["branding"] = branding,
        };
    }

    /// <summary>
    /// Project settings, environments and users are edited as rows (API), so the app.yml given to agents is rebuilt
    /// from them; everything else in the imported app.yml (login, branding, messages key…) is kept as it was.
    /// </summary>
    internal static async Task ApplyLiveSettingsAsync(AtimthaDbContext db, Infrastructure.Project project, JsonObject app, CancellationToken ct)
    {
        // the login form is edited as a row (ProjectDataEndpoints); without one the imported app.yml block is dropped
        if (await Workspaces.ProjectDataEndpoints.LoginBlockAsync(db, project.Id, ct) is { } login) app["login"] = login; else app.Remove("login");

        app["name"] = project.Name;
        if (project.Description is null) app.Remove("description"); else app["description"] = project.Description;
        app["testIdAttribute"] = project.TestIdAttribute;
        app["languages"] = new JsonArray(project.Languages.Select(l => (JsonNode)l).ToArray());

        var run = app["run"] as JsonObject ?? new JsonObject();
        void Set(string key, short? value) { if (value is null) run.Remove(key); else run[key] = (int)value.Value; }
        Set("workers", project.RunWorkers);
        Set("retries", project.RunRetries);
        Set("testTimeout", project.RunTestTimeoutS);
        Set("waitTimeout", project.RunWaitTimeoutS);
        run["healing"] = project.HealingPolicy.ToString().ToLowerInvariant();
        app["run"] = run;

        var envs = await db.Environments.AsNoTracking().Where(e => e.ProjectId == project.Id).OrderBy(e => e.Key).ToListAsync(ct);
        var environments = new JsonObject();
        foreach (var e in envs)
        {
            var o = new JsonObject { ["baseURL"] = e.BaseUrl };
            if (e.StartDemoApp) o["startDemoApp"] = true;
            if (e.IgnoreHttpsErrors) o["ignoreHTTPSErrors"] = true;
            if (e.HttpUsername is not null) o["httpCredentials"] = new JsonObject { ["username"] = e.HttpUsername };
            environments[e.Key] = o;
        }
        app["environments"] = environments;
        if (envs.FirstOrDefault(e => e.IsDefault) is { } def) app["defaultEnv"] = def.Key; else app.Remove("defaultEnv");

        var users = new JsonObject();
        foreach (var u in await db.TestUsers.AsNoTracking().Where(u => u.ProjectId == project.Id).OrderBy(u => u.Key).ToListAsync(ct))
        {
            var o = new JsonObject { ["username"] = u.Username };
            if (u.Description is not null) o["description"] = u.Description;
            users[u.Key] = o;
        }
        app["users"] = users;
    }
}
