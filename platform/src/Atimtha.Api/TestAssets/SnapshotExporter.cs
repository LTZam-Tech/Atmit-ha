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
        return new JsonObject
        {
            ["contract"] = SnapshotImporter.Contract,
            ["key"] = project.Key,
            ["app"] = Content(AssetType.Project),
            ["messages"] = Content(AssetType.Messages),
            ["pages"] = pages,
            ["cases"] = cases,
            ["flows"] = flows,
            ["navigation"] = navigation is JsonObject { Count: > 0 } ? navigation : new JsonObject { ["edges"] = new JsonArray() },
            ["suites"] = Content(AssetType.RunSuite),
        };
    }
}
