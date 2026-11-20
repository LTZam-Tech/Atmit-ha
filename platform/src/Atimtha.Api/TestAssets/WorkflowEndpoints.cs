using Atimtha.Api.Identity;
using Atimtha.Api.Infrastructure;
using Atimtha.Api.Workspaces;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.TestAssets;

using Api = Atimtha.Api.Infrastructure.Api;

public sealed record WorkflowSummaryDto(string Key, string Title, string? Module, string[] Tags, int Steps, int Version);
public sealed record WorkflowStepDto(int Position, string CaseKey, string CaseTitle, string? Row, string? RunAs, string? Start);
public sealed record WorkflowDetailDto(string Key, string Title, string? Description, string? Module, string[] Tags, int Version, IReadOnlyList<WorkflowStepDto> Steps);

/// <summary>
/// /api/v1/projects/{id}/flows: workflows, test cases chained in one browser session (0.1.0 flows/*.flow.yml).
/// A run picks workflows with selection.flows.
/// </summary>
public static class WorkflowEndpoints
{
    public static RouteGroupBuilder MapWorkflows(this RouteGroupBuilder api)
    {
        api.MapGet("/projects/{projectId:guid}/flows", List).WithTags("Test assets").RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        api.MapGet("/projects/{projectId:guid}/flows/{key}", Get).WithTags("Test assets").RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        return api;
    }

    private static async Task<IResult> List(Guid projectId, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        if (await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct) is null) return Api.NotFound("The project");
        var flows = await db.Workflows.AsNoTracking().Where(w => w.ProjectId == projectId).OrderBy(w => w.Title)
            .Select(w => new WorkflowSummaryDto(w.Key, w.Title, w.Module, w.Tags, db.WorkflowSteps.Count(s => s.WorkflowId == w.Id), w.CurrentVersion))
            .ToListAsync(ct);
        return Results.Ok(flows);
    }

    private static async Task<IResult> Get(Guid projectId, string key, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        if (await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct) is null) return Api.NotFound("The project");
        var flow = await db.Workflows.AsNoTracking().FirstOrDefaultAsync(w => w.ProjectId == projectId && w.Key == key, ct);
        if (flow is null) return Api.NotFound("The workflow");
        var steps = await (
            from s in db.WorkflowSteps.AsNoTracking().Where(s => s.WorkflowId == flow.Id)
            join c in db.Cases.AsNoTracking() on s.CaseId equals c.Id
            join r in db.DataRows.AsNoTracking() on s.DataRowId equals r.Id into rows
            from r in rows.DefaultIfEmpty()
            join u in db.TestUsers.AsNoTracking() on s.RunAsUserId equals u.Id into users
            from u in users.DefaultIfEmpty()
            orderby s.Position
            select new { s.Position, CaseKey = c.Key, c.Title, Row = r == null ? null : r.Key, RunAs = u == null ? null : u.Key, s.StartMode }
        ).ToListAsync(ct);
        return Results.Ok(new WorkflowDetailDto(flow.Key, flow.Title, flow.Description, flow.Module, flow.Tags, flow.CurrentVersion,
            steps.Select(s => new WorkflowStepDto(s.Position, s.CaseKey, s.Title, s.Row, s.RunAs, s.StartMode?.ToString().ToLowerInvariant())).ToList()));
    }
}
