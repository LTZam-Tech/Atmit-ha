using System.Text.Json;
using System.Text.Json.Nodes;
using Atimtha.Api.Identity;
using Atimtha.Api.Infrastructure;
using Atimtha.Api.Workspaces;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.TestAssets;

using Api = Atimtha.Api.Infrastructure.Api;

public sealed record AssetContentDto(string Key, int Version, JsonNode Content);
public sealed record ChangeItemRequest(string? AssetType, string? Key, int? BaseVersion, JsonObject? Content);
public sealed record CreateChangeSetRequest(string? Title, string? Source, ChangeItemRequest[]? Items);
public sealed record DecideRequest(string? Note);

public sealed record ChangeItemDto(Guid Id, string AssetType, string Key, int? BaseVersion, int? CurrentVersion, bool IsNew, bool Conflict, JsonNode Content, JsonNode? Current);
public sealed record ChangeSetDto(
    Guid Id, Guid ProjectId, string Title, string Status, string Source, string CreatedBy, string? ReviewedBy,
    DateTimeOffset CreatedAt, DateTimeOffset? DecidedAt, string? DecisionNote, int Items, bool HasConflicts);

/// <summary>
/// Reviewed edits of test cases, pages and workflows (ADR-0007). An edit — made in the platform or offline as a draft — is a change set
/// that records the version each item started from. A reviewer other than the author approves it; a conflict (the
/// case changed since) is shown and must be resolved by a new change set; nothing merges automatically.
/// </summary>
public static class ChangeSetEndpoints
{
    public static RouteGroupBuilder MapChangeSets(this RouteGroupBuilder api)
    {
        api.MapGet("/projects/{projectId:guid}/cases/{key}", GetCase).WithTags("Test assets").RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        api.MapGet("/projects/{projectId:guid}/flows/{key}/content", GetFlow).WithTags("Test assets").RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        api.MapGet("/projects/{projectId:guid}/pages/{key}/content", GetPage).WithTags("Test assets").RequireAuthorization(Permissions.Policy(Permissions.ProjectView));

        var p = api.MapGroup("/projects/{projectId:guid}/change-sets").WithTags("Change sets");
        p.MapGet("/", List).RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        p.MapPost("/", Create).RequireAuthorization(Permissions.Policy(Permissions.ProjectEdit));

        var c = api.MapGroup("/change-sets/{changeSetId:guid}").WithTags("Change sets");
        c.MapGet("/", Get).RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        c.MapPost("/approve", Approve).RequireAuthorization(Permissions.Policy(Permissions.ProjectEdit));
        c.MapPost("/reject", Reject).RequireAuthorization(Permissions.Policy(Permissions.ProjectEdit));
        return api;
    }

    private static async Task<IResult> GetCase(Guid projectId, string key, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        if (await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct) is null) return Api.NotFound("The project");
        var tc = await db.Cases.AsNoTracking().FirstOrDefaultAsync(c => c.ProjectId == projectId && c.Key == key, ct);
        if (tc is null) return Api.NotFound("The case");
        var v = await Latest(db, AssetType.TestCase, tc.Id, ct);
        return v is null ? Api.NotFound("The case") : Results.Ok(new AssetContentDto(key, v.Version, JsonNode.Parse(v.Content)!));
    }

    private static async Task<IResult> GetPage(Guid projectId, string key, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        if (await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct) is null) return Api.NotFound("The project");
        var page = await db.Pages.AsNoTracking().FirstOrDefaultAsync(p => p.ProjectId == projectId && p.Key == key, ct);
        if (page is null) return Api.NotFound("The page");
        var v = await Latest(db, AssetType.Page, page.Id, ct);
        return v is null ? Api.NotFound("The page") : Results.Ok(new AssetContentDto(key, v.Version, JsonNode.Parse(v.Content)!));
    }

    private static async Task<IResult> GetFlow(Guid projectId, string key, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        if (await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct) is null) return Api.NotFound("The project");
        var flow = await db.Workflows.AsNoTracking().FirstOrDefaultAsync(w => w.ProjectId == projectId && w.Key == key, ct);
        if (flow is null) return Api.NotFound("The workflow");
        var v = await Latest(db, AssetType.Workflow, flow.Id, ct);
        return v is null ? Api.NotFound("The workflow") : Results.Ok(new AssetContentDto(key, v.Version, JsonNode.Parse(v.Content)!));
    }

    /// <summary>"test_case" (default), "page" or "workflow"; anything else is refused.</summary>
    internal static AssetType? TypeOf(string? assetType) => (assetType ?? "test_case") switch
    {
        "test_case" => AssetType.TestCase, "page" => AssetType.Page, "workflow" => AssetType.Workflow, _ => null,
    };
    internal static string NameOf(AssetType t) => t switch { AssetType.Page => "page", AssetType.Workflow => "workflow", _ => "test_case" };

    private static async Task<Guid?> AssetIdAsync(AtimthaDbContext db, Guid projectId, AssetType type, string key, CancellationToken ct) => type switch
    {
        AssetType.Page => await db.Pages.Where(p => p.ProjectId == projectId && p.Key == key).Select(p => (Guid?)p.Id).FirstOrDefaultAsync(ct),
        AssetType.Workflow => await db.Workflows.Where(w => w.ProjectId == projectId && w.Key == key).Select(w => (Guid?)w.Id).FirstOrDefaultAsync(ct),
        _ => await db.Cases.Where(c => c.ProjectId == projectId && c.Key == key).Select(c => (Guid?)c.Id).FirstOrDefaultAsync(ct),
    };

    private static async Task<IResult> List(Guid projectId, string? status, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        if (await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct) is null) return Api.NotFound("The project");
        var q = db.ChangeSets.AsNoTracking().Where(s => s.ProjectId == projectId);
        var st = ParseStatus(status);
        if (st is not null) q = q.Where(s => s.Status == st);
        var sets = await q.OrderByDescending(s => s.CreatedAt).Take(100).ToListAsync(ct);
        var dtos = new List<ChangeSetDto>();
        foreach (var s in sets) dtos.Add(await ToDto(db, s, ct));
        return Results.Ok(dtos);
    }

    private static async Task<IResult> Create(Guid projectId, CreateChangeSetRequest body, AtimthaDbContext db, AccessService access, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        var project = await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct);
        if (project is null) return Api.NotFound("The project");
        if (!await access.HasInWorkspaceAsync(Permissions.ProjectEdit, project.WorkspaceId, ct)) return Api.Forbidden("You cannot edit this project.");
        if (tenant.UserId is not { } author) return Api.Forbidden("A change set needs a signed-in person.");

        var items = body.Items ?? [];
        var v = new Api.Validation()
            .Text(body.Title, "title", 200)
            .Require(body.Source is null or "central" or "local", "source", "Use central or local.")
            .Require(items.Length is > 0 and <= 200, "items", "Send 1 to 200 changed items.")
            .Require(items.All(i => TypeOf(i.AssetType) is not null), "items", "Use assetType test_case, page or workflow.")
            .Require(items.All(i => i.Content is not null && i.Key is not null && System.Text.RegularExpressions.Regex.IsMatch(i.Key, "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,149}$")),
                "items", "Every item needs a key (the file name without .case.yml / .page.yml / .flow.yml) and its content.")
            .Require(items.Select(i => (i.AssetType ?? "test_case") + ":" + i.Key).Distinct().Count() == items.Length, "items", "An item appears twice.");
        if (!v.IsValid) return v.Problem();

        // structural check of each case now, so a broken change set is refused before review
        var problems = items.SelectMany(i => TypeOf(i.AssetType) switch
        {
            AssetType.Page => PageProblems(i.Key!, i.Content!),
            AssetType.Workflow => FlowProblems(i.Key!, i.Content!),
            _ => StructuralProblems(i.Key!, i.Content!),
        }).ToList();
        if (problems.Count > 0) return Results.ValidationProblem(new Dictionary<string, string[]> { ["items"] = problems.Take(100).ToArray() });

        var set = new ChangeSet
        {
            Id = Guid.NewGuid(), OrganizationId = project.OrganizationId, ProjectId = projectId, Title = body.Title!.Trim(),
            Status = ChangeStatus.Submitted, Source = body.Source == "local" ? ChangeSource.Local : ChangeSource.Central,
            BaseVersions = JsonSerializer.Serialize(items.ToDictionary(i => TypeOf(i.AssetType) switch { AssetType.Page => "page:", AssetType.Workflow => "workflow:", _ => "" } + i.Key!, i => i.BaseVersion)),
            CreatedBy = author, CreatedAt = DateTimeOffset.UtcNow,
        };
        db.ChangeSets.Add(set);
        foreach (var i in items)
        {
            var json = i.Content!.ToJsonString();
            var type = TypeOf(i.AssetType)!.Value;
            db.ChangeSetItems.Add(new ChangeSetItem
            {
                Id = Guid.NewGuid(), OrganizationId = project.OrganizationId, ChangeSetId = set.Id, AssetType = type,
                AssetKey = i.Key!, AssetId = await AssetIdAsync(db, projectId, type, i.Key!, ct), BaseVersion = i.BaseVersion,
                Content = json, ContentSha256 = SnapshotImporter.Sha256(json),
            });
        }
        audit.Add("change_set.submit", "change_set", set.Id, new { project = project.Key, set.Title, items = items.Select(i => (i.AssetType ?? "test_case") + ":" + i.Key) });
        await db.SaveChangesAsync(ct);
        return Results.Created($"/api/v1/change-sets/{set.Id}", await ToDto(db, set, ct));
    }

    private static async Task<IResult> Get(Guid changeSetId, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        var set = await db.ChangeSets.AsNoTracking().FirstOrDefaultAsync(s => s.Id == changeSetId, ct);
        if (set is null || await ProjectEndpoints.Visible(set.ProjectId, Permissions.ProjectView, db, access, ct) is null) return Api.NotFound("The change set");
        var items = await db.ChangeSetItems.AsNoTracking().Where(i => i.ChangeSetId == changeSetId).OrderBy(i => i.AssetType).ThenBy(i => i.AssetKey).ToListAsync(ct);
        var dtos = new List<ChangeItemDto>();
        foreach (var i in items)
        {
            var current = i.AssetId is { } id ? await Latest(db, i.AssetType, id, ct) : null;
            dtos.Add(new ChangeItemDto(i.Id, NameOf(i.AssetType), i.AssetKey, i.BaseVersion, current?.Version, i.AssetId is null,
                IsConflict(i, current?.Version, set.Status), JsonNode.Parse(i.Content)!, current is null ? null : JsonNode.Parse(current.Content)));
        }
        return Results.Ok(new { changeSet = await ToDto(db, set, ct), items = dtos });
    }

    private static async Task<IResult> Approve(Guid changeSetId, DecideRequest? body, AtimthaDbContext db, AccessService access, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        var set = await db.ChangeSets.FirstOrDefaultAsync(s => s.Id == changeSetId, ct);
        var project = set is null ? null : await ProjectEndpoints.Visible(set.ProjectId, Permissions.ProjectView, db, access, ct);
        if (set is null || project is null) return Api.NotFound("The change set");
        if (!await access.HasInWorkspaceAsync(Permissions.ProjectEdit, project.WorkspaceId, ct)) return Api.Forbidden("You cannot review changes in this project.");
        if (set.Status != ChangeStatus.Submitted) return Api.Conflict($"This change set is already {set.Status.ToString().ToLowerInvariant()}.");
        if (tenant.UserId is not { } reviewer || reviewer == set.CreatedBy) return Api.Forbidden("A change set is approved by someone other than its author.");

        var items = await db.ChangeSetItems.Where(i => i.ChangeSetId == changeSetId).ToListAsync(ct);
        var conflicts = new List<string>();
        foreach (var i in items)
        {
            var currentId = i.AssetId ?? await AssetIdAsync(db, project.Id, i.AssetType, i.AssetKey, ct);
            var current = currentId is { } id ? await Latest(db, i.AssetType, id, ct) : null;
            if (ConflictsNow(i, currentId, current?.Version)) conflicts.Add($"{i.AssetKey}: changed since this edit started (version {i.BaseVersion?.ToString() ?? "new"} → {current?.Version.ToString() ?? "none"})");
        }
        if (conflicts.Count > 0)
            return Results.Problem(statusCode: StatusCodes.Status409Conflict, title: "Conflicts", detail: string.Join("\n", conflicts) +
                "\nReject this change set and submit the edit again on top of the current version.");

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var applier = new SnapshotImporter(db, project.OrganizationId, project.WorkspaceId, set.CreatedBy);
        await applier.LoadLookupsAsync(project.Id, ct);
        // pages first (cases may use their new elements), then cases (workflows may chain the new ones)
        foreach (var i in items.OrderBy(i => i.AssetType switch { AssetType.Page => 0, AssetType.TestCase => 1, _ => 2 }))
        {
            var content = JsonNode.Parse(i.Content)!.AsObject();
            Guid? appliedId = i.AssetType switch
            {
                AssetType.Page => (await applier.ApplyPageAsync(project, i.AssetKey, content, ct))?.Id,
                AssetType.Workflow => (await applier.ApplyFlowAsync(project, i.AssetKey, content, ct))?.Id,
                _ => (await applier.ApplyCaseAsync(project, i.AssetKey, content, ct))?.Id,
            };
            if (appliedId is not Guid assetId)
            {
                await tx.RollbackAsync(ct);
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["items"] = applier.Problems.Take(100).ToArray() },
                    title: "The change cannot be applied", detail: "Nothing was changed.");
            }
            if (applier.LastVersionFor(assetId, i.AssetType) is { } version) version.ChangeSetId = set.Id;
            i.AssetId = assetId;
        }
        set.Status = ChangeStatus.Merged;
        set.ReviewedBy = reviewer;
        set.DecidedAt = DateTimeOffset.UtcNow;
        set.DecisionNote = body?.Note;
        audit.Add("change_set.approve", "change_set", set.Id, new { project = project.Key, items = items.Select(i => NameOf(i.AssetType) + ":" + i.AssetKey), note = body?.Note });
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return Results.Ok(await ToDto(db, set, ct));
    }

    private static async Task<IResult> Reject(Guid changeSetId, DecideRequest? body, AtimthaDbContext db, AccessService access, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        var set = await db.ChangeSets.FirstOrDefaultAsync(s => s.Id == changeSetId, ct);
        var project = set is null ? null : await ProjectEndpoints.Visible(set.ProjectId, Permissions.ProjectView, db, access, ct);
        if (set is null || project is null) return Api.NotFound("The change set");
        if (set.Status != ChangeStatus.Submitted) return Api.Conflict($"This change set is already {set.Status.ToString().ToLowerInvariant()}.");
        // the author may withdraw; anyone else needs edit rights
        if (tenant.UserId != set.CreatedBy && !await access.HasInWorkspaceAsync(Permissions.ProjectEdit, project.WorkspaceId, ct))
            return Api.Forbidden("You cannot review changes in this project.");
        // an author withdrawing their own change set is not a review: reviewed_by stays empty (the database refuses
        // reviewed_by = created_by, no self-review)
        var withdrawn = tenant.UserId == set.CreatedBy;
        set.Status = ChangeStatus.Rejected;
        set.ReviewedBy = withdrawn ? null : tenant.UserId;
        set.DecidedAt = DateTimeOffset.UtcNow;
        set.DecisionNote = body?.Note;
        audit.Add(withdrawn ? "change_set.withdraw" : "change_set.reject", "change_set", set.Id, new { project = project.Key, note = body?.Note });
        await db.SaveChangesAsync(ct);
        return Results.Ok(await ToDto(db, set, ct));
    }

    // ---------------------------------------------------------------- helpers

    private static Task<AssetVersion?> Latest(AtimthaDbContext db, AssetType type, Guid assetId, CancellationToken ct) =>
        db.AssetVersions.AsNoTracking().Where(v => v.AssetType == type && v.AssetId == assetId).OrderByDescending(v => v.Version).FirstOrDefaultAsync(ct);

    /// <summary>A conflict: the case exists now but the edit started from another version (or from nothing).</summary>
    internal static bool IsConflict(ChangeSetItem i, int? currentVersion, ChangeStatus status = ChangeStatus.Submitted) =>
        status == ChangeStatus.Submitted && currentVersion is not null && i.BaseVersion != currentVersion;

    /// <summary>At approval: the case exists (perhaps created by someone else meanwhile) at another version than the base.</summary>
    internal static bool ConflictsNow(ChangeSetItem i, Guid? currentAssetId, int? currentVersion) =>
        currentAssetId is not null && currentVersion is not null && i.BaseVersion != currentVersion;

    /// <summary>Shape checks before review (the engine validates step meaning when it runs).</summary>
    internal static IEnumerable<string> StructuralProblems(string key, JsonObject c)
    {
        if (SnapshotImporter.Str(c["case"]) is null) yield return $"{key}: \"case\" (its name) is required";
        if (c["steps"] is not null and not JsonArray) yield return $"{key}: \"steps\" must be a list";
        if (c["data"] is not null and not JsonArray) yield return $"{key}: \"data\" must be a list";
        if (c["outcomes"] is not null and not JsonObject) yield return $"{key}: \"outcomes\" must be a map";
        var lists = new List<(string Where, JsonArray List)>();
        if (c["steps"] is JsonArray s) lists.Add(("steps", s));
        foreach (var (name, list) in c["outcomes"] as JsonObject ?? []) if (list is JsonArray a) lists.Add(($"outcome {name}", a));
        foreach (var (where, list) in lists)
        {
            var n = 0;
            foreach (var step in list)
            {
                n++;
                if (step is not JsonObject o || o.Count(kv => kv.Key != "name") != 1) yield return $"{key}: {where} #{n} needs exactly one action";
            }
        }
    }

    /// <summary>Shape checks of a workflow (0.1.0 flows/*.flow.yml) before review.</summary>
    internal static IEnumerable<string> FlowProblems(string key, JsonObject f)
    {
        if (SnapshotImporter.Str(f["flow"]) is null) yield return $"{key}: \"flow\" (its name) is required";
        if (f["steps"] is not JsonArray steps || steps.Count == 0) { yield return $"{key}: \"steps\" must list at least one case"; yield break; }
        var n = 0;
        foreach (var step in steps)
        {
            n++;
            if (step is not JsonObject o || SnapshotImporter.Str(o["case"]) is null) yield return $"{key}: step {n} needs a case";
        }
    }

    /// <summary>Shape checks of a page (0.1.0 or/*.page.yml) before review.</summary>
    internal static IEnumerable<string> PageProblems(string key, JsonObject p)
    {
        if (SnapshotImporter.Str(p["page"]) != key) yield return $"{key}: \"page\" must equal the file name ({key})";
        if (p["elements"] is not JsonObject elements) { yield return $"{key}: \"elements\" must be a map of element name → locator"; yield break; }
        foreach (var (name, node) in elements)
        {
            if (node is JsonValue v && v.TryGetValue<string>(out var s) && s.Length > 0) continue;
            if (node is JsonObject o && o.Count > 0) { if (o["fallback"] is not null and not JsonArray) yield return $"{key}.{name}: \"fallback\" must be a list"; continue; }
            yield return $"{key}.{name}: a locator is a text or an object such as {{ testid: … }}";
        }
    }

    private static ChangeStatus? ParseStatus(string? s) => s?.ToLowerInvariant() switch
    {
        "submitted" => ChangeStatus.Submitted, "merged" => ChangeStatus.Merged, "rejected" => ChangeStatus.Rejected,
        "approved" => ChangeStatus.Approved, "draft" => ChangeStatus.Draft, _ => null,
    };

    private static async Task<ChangeSetDto> ToDto(AtimthaDbContext db, ChangeSet s, CancellationToken ct)
    {
        var people = await db.Users.AsNoTracking().Where(u => u.Id == s.CreatedBy || u.Id == s.ReviewedBy).ToDictionaryAsync(u => u.Id, u => u.Email, ct);
        var items = await db.ChangeSetItems.AsNoTracking().Where(i => i.ChangeSetId == s.Id).ToListAsync(ct);
        var conflicts = false;
        if (s.Status == ChangeStatus.Submitted)
        {
            foreach (var i in items.Where(i => i.AssetId is not null))
            {
                var v = await Latest(db, i.AssetType, i.AssetId!.Value, ct);
                if (IsConflict(i, v?.Version)) { conflicts = true; break; }
            }
        }
        return new ChangeSetDto(s.Id, s.ProjectId, s.Title, s.Status.ToString().ToLowerInvariant(), s.Source.ToString().ToLowerInvariant(),
            people.GetValueOrDefault(s.CreatedBy, "?"), s.ReviewedBy is { } r ? people.GetValueOrDefault(r) : null,
            s.CreatedAt, s.DecidedAt, s.DecisionNote, items.Count, conflicts);
    }
}
