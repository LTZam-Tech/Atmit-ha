using System.Text.Json.Nodes;
using Atimtha.Api.Identity;
using Atimtha.Api.Infrastructure;
using Atimtha.Api.Workspaces;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.TestAssets;

using Api = Atimtha.Api.Infrastructure.Api;

public sealed record SuiteDto(string Key, string? Description, string[] Modules, string[] Tags, string[] Cases);
public sealed record PutSuiteRequest(string? Description, string[]? Modules, string[]? Tags, string[]? Cases);

/// <summary>
/// /api/v1/projects/{id}/suites: named selections of cases by module, tag or name (0.1.0 suites.yml).
/// A run picks one with selection.suite; agents receive the suites rebuilt from these rows.
/// </summary>
public static class SuiteEndpoints
{
    public static RouteGroupBuilder MapSuites(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/projects/{projectId:guid}/suites").WithTags("Suites");
        g.MapGet("/", List).RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        g.MapPut("/{key}", Put).RequireAuthorization(Permissions.Policy(Permissions.ProjectEdit));
        g.MapDelete("/{key}", Delete).RequireAuthorization(Permissions.Policy(Permissions.ProjectEdit));
        return api;
    }

    private static async Task<IResult> List(Guid projectId, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        if (await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct) is null) return Api.NotFound("The project");
        return Results.Ok(await LoadAsync(db, projectId, ct));
    }

    private static async Task<IResult> Put(Guid projectId, string key, PutSuiteRequest body, AtimthaDbContext db, AccessService access, AuditWriter audit, CancellationToken ct)
    {
        var project = await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct);
        if (project is null) return Api.NotFound("The project");
        if (!await access.HasInWorkspaceAsync(Permissions.ProjectEdit, project.WorkspaceId, ct)) return Api.Forbidden("You cannot edit this project.");

        var modules = Clean(body.Modules);
        var tags = Clean(body.Tags).Select(t => t.StartsWith('@') ? t : "@" + t).ToArray();
        var caseKeys = Clean(body.Cases);
        var known = await db.Cases.AsNoTracking().Where(c => c.ProjectId == projectId && caseKeys.Contains(c.Key)).ToDictionaryAsync(c => c.Key, c => c.Id, ct);
        var v = new Api.Validation()
            .Require(Api.AttributePattern().IsMatch(key) && key.Length <= 100, "key", "Use letters, digits, \"-\" or \"_\", starting with a letter.")
            .Text(body.Description, "description", 500, required: false)
            .Require(modules.Length + tags.Length + caseKeys.Length > 0, "selection", "Pick at least one module, tag or case.")
            .Require(modules.Length <= 50 && tags.Length <= 50 && caseKeys.Length <= 1000, "selection", "Too many entries.")
            .Require(tags.All(t => t.Length <= 100 && t.Skip(1).All(c => char.IsLetterOrDigit(c) || c is '-' or '_')), "tags", "Tags look like @smoke.")
            .Require(caseKeys.All(known.ContainsKey), "cases", $"Unknown cases: {string.Join(", ", caseKeys.Where(c => !known.ContainsKey(c)).Take(10))}.");
        if (!v.IsValid) return v.Problem();

        var suite = await db.Suites.FirstOrDefaultAsync(s => s.ProjectId == projectId && s.Key == key, ct);
        var created = suite is null;
        suite ??= db.Suites.Add(new RunSuite { Id = Guid.NewGuid(), OrganizationId = project.OrganizationId, ProjectId = projectId, Key = key }).Entity;
        suite.Description = string.IsNullOrWhiteSpace(body.Description) ? null : body.Description.Trim();
        suite.Modules = modules;
        suite.Tags = tags;
        if (!created) db.SuiteCases.RemoveRange(await db.SuiteCases.Where(c => c.SuiteId == suite.Id).ToListAsync(ct));
        foreach (var c in caseKeys) db.SuiteCases.Add(new RunSuiteCase { OrganizationId = project.OrganizationId, SuiteId = suite.Id, CaseId = known[c] });
        audit.Add(created ? "suite.create" : "suite.update", "run_suite", suite.Id, new { project = project.Key, key, modules, tags, cases = caseKeys.Length });
        await db.SaveChangesAsync(ct);
        var dto = new SuiteDto(suite.Key, suite.Description, suite.Modules, suite.Tags, caseKeys);
        return created ? Results.Created($"/api/v1/projects/{projectId}/suites/{key}", dto) : Results.Ok(dto);
    }

    private static async Task<IResult> Delete(Guid projectId, string key, AtimthaDbContext db, AccessService access, AuditWriter audit, CancellationToken ct)
    {
        var project = await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct);
        if (project is null) return Api.NotFound("The project");
        if (!await access.HasInWorkspaceAsync(Permissions.ProjectEdit, project.WorkspaceId, ct)) return Api.Forbidden("You cannot edit this project.");
        var suite = await db.Suites.FirstOrDefaultAsync(s => s.ProjectId == projectId && s.Key == key, ct);
        if (suite is null) return Api.NotFound("The suite");
        db.Suites.Remove(suite);   // run_suite_case rows go with it (ON DELETE CASCADE)
        audit.Add("suite.delete", "run_suite", suite.Id, new { project = project.Key, key });
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    internal static async Task<List<SuiteDto>> LoadAsync(AtimthaDbContext db, Guid projectId, CancellationToken ct)
    {
        var suites = await db.Suites.AsNoTracking().Where(s => s.ProjectId == projectId).OrderBy(s => s.Key).ToListAsync(ct);
        var ids = suites.Select(s => s.Id).ToList();
        var members = (await (from sc in db.SuiteCases.AsNoTracking().Where(sc => ids.Contains(sc.SuiteId))
                              join c in db.Cases.AsNoTracking() on sc.CaseId equals c.Id
                              select new { sc.SuiteId, c.Key }).ToListAsync(ct)).ToLookup(x => x.SuiteId, x => x.Key);
        return suites.Select(s => new SuiteDto(s.Key, s.Description, s.Modules, s.Tags, members[s.Id].Order().ToArray())).ToList();
    }

    /// <summary>The suites file as agents read it (0.1.0 suites.yml shape), built from the rows.</summary>
    internal static async Task<JsonObject> ToSnapshotAsync(AtimthaDbContext db, Guid projectId, CancellationToken ct)
    {
        var suites = new JsonObject();
        foreach (var s in await LoadAsync(db, projectId, ct))
        {
            var o = new JsonObject();
            if (s.Description is not null) o["description"] = s.Description;
            if (s.Modules.Length > 0) o["modules"] = new JsonArray(s.Modules.Select(m => (JsonNode)m).ToArray());
            if (s.Tags.Length > 0) o["tags"] = new JsonArray(s.Tags.Select(t => (JsonNode)t).ToArray());
            if (s.Cases.Length > 0) o["cases"] = new JsonArray(s.Cases.Select(c => (JsonNode)c).ToArray());
            suites[s.Key] = o;
        }
        return new JsonObject { ["suites"] = suites };
    }

    private static string[] Clean(string[]? values) =>
        (values ?? []).Select(x => x?.Trim() ?? "").Where(x => x.Length > 0).Distinct(StringComparer.Ordinal).ToArray();
}
