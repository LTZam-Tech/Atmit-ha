using System.Text.Json.Nodes;
using Atimtha.Api.Identity;
using Atimtha.Api.Infrastructure;
using Atimtha.Api.Workspaces;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.TestAssets;

public sealed record PageSummaryDto(string Key, string? Url, string OpenMode, int Elements, int Version);
public sealed record CaseSummaryDto(string Key, string Title, string? Module, string Engine, string? Type, int Rows, int Steps, int Version);
public sealed record ImportResultDto(ProjectDto Project, int Pages, int Elements, int Cases, int DataRows, int Workflows);

/// <summary>Import and export 0.1.0 projects; read the project's pages and cases.</summary>
public static class TestAssetEndpoints
{
    public static RouteGroupBuilder MapTestAssets(this RouteGroupBuilder api)
    {
        api.MapPost("/workspaces/{workspaceKey}/projects/import", Import)
            .RequireAuthorization(Permissions.Policy(Permissions.ProjectEdit)).WithTags("Projects");

        var p = api.MapGroup("/projects/{projectId:guid}").WithTags("Test assets");
        p.MapGet("/snapshot", Snapshot).RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        p.MapGet("/pages", Pages).RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        p.MapGet("/cases", Cases).RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        return api;
    }

    /// <summary>Body: a project snapshot (npx tsx scripts/snapshot.ts export &lt;app&gt;). All or nothing.</summary>
    private static async Task<IResult> Import(string workspaceKey, JsonObject body, AtimthaDbContext db, AccessService access, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        var ws = await db.Workspaces.AsNoTracking().FirstOrDefaultAsync(w => w.Key == workspaceKey && w.ArchivedAt == null, ct);
        if (ws is null || !await access.HasInWorkspaceAsync(Permissions.ProjectView, ws.Id, ct)) return Api.NotFound("The workspace");
        if (!await access.HasInWorkspaceAsync(Permissions.ProjectEdit, ws.Id, ct)) return Api.Forbidden("You cannot create projects in this workspace.");

        var importer = new SnapshotImporter(db, tenant.OrganizationId!.Value, ws.Id, tenant.UserId);
        var project = importer.Import(body);
        if (project is null)
            return Results.ValidationProblem(new Dictionary<string, string[]> { ["snapshot"] = importer.Problems.Take(200).ToArray() },
                title: "The project cannot be imported", detail: $"{importer.Problems.Count} problem(s) found; nothing was saved.");

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        try
        {
            await importer.PersistAsync(ct);
            audit.Add("project.import", "project", project.Id, new { project.Key, workspace = ws.Key });
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
        }
        catch (DbUpdateException e) when (Api.IsUniqueViolation(e))
        {
            await tx.RollbackAsync(ct);
            return Api.Conflict($"A project with the key \"{project.Key}\" already exists in this workspace, or the snapshot repeats a key.");
        }

        var counts = new ImportResultDto(
            ProjectDto.From(project),
            await db.Pages.CountAsync(x => x.ProjectId == project.Id, ct),
            await db.Elements.CountAsync(e => db.Pages.Any(pg => pg.Id == e.PageId && pg.ProjectId == project.Id), ct),
            await db.Cases.CountAsync(x => x.ProjectId == project.Id, ct),
            await db.DataRows.CountAsync(r => db.Cases.Any(c => c.Id == r.CaseId && c.ProjectId == project.Id), ct),
            await db.Workflows.CountAsync(x => x.ProjectId == project.Id, ct));
        return Results.Created($"/api/v1/projects/{project.Id}", counts);
    }

    private static async Task<IResult> Snapshot(Guid projectId, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        if (await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct) is null) return Api.NotFound("The project");
        var snapshot = await SnapshotExporter.BuildAsync(db, projectId, ct);
        return snapshot is null ? Api.NotFound("The project") : Results.Json(snapshot);
    }

    private static async Task<IResult> Pages(Guid projectId, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        if (await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct) is null) return Api.NotFound("The project");
        var items = await db.Pages.AsNoTracking()
            .Where(p => p.ProjectId == projectId)
            .OrderBy(p => p.Key)
            .Select(p => new PageSummaryDto(p.Key, p.Url, p.OpenMode == PageOpenMode.Navigate ? "navigate" : "url",
                db.Elements.Count(e => e.PageId == p.Id), p.CurrentVersion))
            .ToListAsync(ct);
        return Results.Ok(items);
    }

    private static async Task<IResult> Cases(Guid projectId, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        if (await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct) is null) return Api.NotFound("The project");
        var items = await db.Cases.AsNoTracking()
            .Where(c => c.ProjectId == projectId)
            .OrderBy(c => c.Module).ThenBy(c => c.Title)
            .Select(c => new CaseSummaryDto(c.Key, c.Title, c.Module, c.Engine,
                c.CaseType == CaseType.Positive ? "positive" : c.CaseType == CaseType.Negative ? "negative" : null,
                db.DataRows.Count(r => r.CaseId == c.Id), db.Steps.Count(s => s.CaseId == c.Id), c.CurrentVersion))
            .ToListAsync(ct);
        return Results.Ok(items);
    }
}
