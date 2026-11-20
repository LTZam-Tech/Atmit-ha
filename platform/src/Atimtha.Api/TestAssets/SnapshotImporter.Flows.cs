using System.Text.Json.Nodes;
using Atimtha.Api.Infrastructure;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.TestAssets;

/// <summary>Applying one reviewed workflow change (ADR-0007) onto an existing project.</summary>
public sealed partial class SnapshotImporter
{
    /// <summary>
    /// Rebuilds one workflow from new content, inside the caller's transaction. The workflow row keeps its id; its
    /// steps are replaced (results point at cases and rows, never at workflow steps). Returns the workflow, or null
    /// with Problems filled (nothing saved then).
    /// </summary>
    public async Task<Workflow?> ApplyFlowAsync(Project project, string flowKey, JsonObject f, CancellationToken ct)
    {
        if (Str(f["flow"]) is not { } title) { Problems.Add($"workflow {flowKey}: \"flow\" (its name) is required"); return null; }
        var existing = await db.Workflows.FirstOrDefaultAsync(w => w.ProjectId == project.Id && w.Key == flowKey, ct);
        var wf = existing ?? new Workflow { Id = Guid.NewGuid(), OrganizationId = organizationId, ProjectId = project.Id, Key = flowKey, CurrentVersion = 0 };
        wf.Title = title;
        wf.Description = Str(f["description"]);
        wf.Module = Str(f["module"]);
        wf.Tags = Strings(f["tags"]);

        // resolve every step first: a workflow is applied whole or not at all
        var resolved = new List<WorkflowStep>();
        var position = 1;
        foreach (var stepNode in f["steps"] as JsonArray ?? [])
        {
            var caseKey = Str(stepNode?["case"])?.Replace(".case.yml", "");
            if (caseKey is null || !cases.TryGetValue(caseKey, out var caseId)) { Problems.Add($"workflow {flowKey}, step {position}: case \"{caseKey}\" not found"); position++; continue; }
            var rowKey = Str(stepNode?["row"]);
            Guid? rowId = null;
            if (rowKey is not null)
            {
                rowId = await db.DataRows.AsNoTracking().Where(r => r.CaseId == caseId && r.Key == rowKey).Select(r => (Guid?)r.Id).FirstOrDefaultAsync(ct);
                if (rowId is null) Problems.Add($"workflow {flowKey}, step {position}: row \"{rowKey}\" is not a row of {caseKey}");
            }
            var asUser = Str(stepNode?["as"]);
            Guid? runAs = null;
            if (asUser is not null and not "none")
            {
                if (users.TryGetValue(asUser, out var au)) runAs = au;
                else Problems.Add($"workflow {flowKey}, step {position}: user \"{asUser}\" is not defined");
            }
            var start = Str(stepNode?["start"]);
            if (start is not null and not ("open" or "continue")) Problems.Add($"workflow {flowKey}, step {position}: start is \"open\" or \"continue\"");
            resolved.Add(new WorkflowStep
            {
                Id = Guid.NewGuid(), OrganizationId = organizationId, WorkflowId = wf.Id, Position = position++, CaseId = caseId, DataRowId = rowId,
                RunAsUserId = runAs, StartMode = start switch { "open" => WorkflowStart.Open, "continue" => WorkflowStart.Continue, _ => null },
            });
        }
        if (resolved.Count == 0 && Problems.Count == 0) Problems.Add($"workflow {flowKey}: needs at least one step");
        if (Problems.Count > 0) return null;

        if (existing is not null)
        {
            db.WorkflowSteps.RemoveRange(await db.WorkflowSteps.Where(s => s.WorkflowId == wf.Id).ToListAsync(ct));
            await db.SaveChangesAsync(ct);
        }
        wf.CurrentVersion += 1;
        if (existing is null) db.Workflows.Add(wf);
        await db.SaveChangesAsync(ct);
        db.WorkflowSteps.AddRange(resolved);
        await db.SaveChangesAsync(ct);
        flows[flowKey] = wf.Id;

        // the new immutable version: added, not saved, so the caller can still link it to its change set
        // (asset_version rows are insert-only for the application role)
        var json = f.ToJsonString();
        db.AssetVersions.Add(new AssetVersion
        {
            Id = Guid.NewGuid(), OrganizationId = organizationId, ProjectId = project.Id, AssetType = AssetType.Workflow, AssetId = wf.Id,
            Version = wf.CurrentVersion, Content = json, ContentSha256 = Sha256(json), CreatedBy = userId, CreatedAt = now,
        });
        return wf;
    }
}
