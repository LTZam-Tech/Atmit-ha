using System.Text.Json.Nodes;
using Atimtha.Api.Identity;
using Atimtha.Api.Infrastructure;
using Atimtha.Api.Workspaces;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.Execution;

using Api = Atimtha.Api.Infrastructure.Api;

public sealed record TrendPointDto(Guid ExecutionId, DateTimeOffset At, string Status, string Environment, int Total, int Passed, int Failed, int Flaky, int Healed, double? PassRate);

/// <summary>How one test changed between two runs: fixed, broke, still failing, unchanged, added, removed.</summary>
public sealed record ComparisonRowDto(string Title, string? Module, string? Before, string? After, string Change);
public sealed record ComparisonDto(ExecutionDto Before, ExecutionDto After, IReadOnlyDictionary<string, int> Summary, IReadOnlyList<ComparisonRowDto> Tests);

public sealed record AuditEntryDto(long Id, DateTimeOffset At, string Action, string ResourceType, string? ResourceId, string? Actor, string Details);

/// <summary>Pass-rate trend, run comparison (backlog §11) and the audit log (§4, §13).</summary>
public static class ReportEndpoints
{
    public static RouteGroupBuilder MapReports(this RouteGroupBuilder api)
    {
        api.MapGet("/projects/{projectId:guid}/trend", Trend).WithTags("Reports").RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        api.MapGet("/executions/compare", Compare).WithTags("Reports").RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        api.MapGet("/audit", Audit).WithTags("Audit").RequireAuthorization(Permissions.Policy(Permissions.AuditView));
        return api;
    }

    /// <summary>The last <c>take</c> finished runs, oldest first. Pass rate = passed (first try) ÷ (total − skipped).</summary>
    private static async Task<IResult> Trend(Guid projectId, int? take, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        if (await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct) is null) return Api.NotFound("The project");
        var n = Math.Clamp(take ?? 30, 1, 200);
        var runs = await db.Executions.AsNoTracking()
            .Where(e => e.ProjectId == projectId && e.FinishedAt != null && e.Status != ExecutionStatus.Cancelled && e.ParentExecutionId == null)
            .OrderByDescending(e => e.FinishedAt).Take(n).ToListAsync(ct);
        var envKeys = await db.Environments.AsNoTracking().Where(e => e.ProjectId == projectId).ToDictionaryAsync(e => e.Id, e => e.Key, ct);
        var points = runs.OrderBy(r => r.FinishedAt).Select(r =>
        {
            var c = r.Counts is null ? null : JsonNode.Parse(r.Counts) as JsonObject;
            int Get(string k) => c?[k] is JsonValue v && v.TryGetValue<int>(out var i) ? i : 0;
            var (total, passed, skipped) = (Get("total"), Get("passed"), Get("skipped"));
            var counted = total - skipped;
            return new TrendPointDto(r.Id, r.FinishedAt!.Value, r.Status.ToString().ToLowerInvariant(), envKeys.GetValueOrDefault(r.EnvironmentId, "?"),
                total, passed, Get("failed"), Get("flaky"), Get("healed"), counted > 0 ? Math.Round(100.0 * passed / counted, 1) : null);
        }).ToList();
        return Results.Ok(points);
    }

    private static async Task<IResult> Compare(Guid before, Guid after, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        var runs = await db.Executions.AsNoTracking().Where(e => e.Id == before || e.Id == after).ToListAsync(ct);
        var a = runs.FirstOrDefault(r => r.Id == before);
        var b = runs.FirstOrDefault(r => r.Id == after);
        if (a is null || b is null) return Api.NotFound("The run");
        if (a.ProjectId != b.ProjectId) return Results.ValidationProblem(new Dictionary<string, string[]> { ["after"] = ["Compare two runs of the same project."] });
        if (await ProjectEndpoints.Visible(a.ProjectId, Permissions.ProjectView, db, access, ct) is null) return Api.NotFound("The run");

        // a sharded run's results sit on its shards: they count as the run's own
        var owner = (await db.Executions.AsNoTracking().Where(e => e.ParentExecutionId == before || e.ParentExecutionId == after)
            .Select(e => new { e.Id, Parent = e.ParentExecutionId!.Value }).ToListAsync(ct)).ToDictionary(x => x.Id, x => x.Parent);
        owner[before] = before;
        owner[after] = after;
        var ownerIds = owner.Keys.ToList();
        var results = (await db.Results.AsNoTracking().Where(r => ownerIds.Contains(r.ExecutionId))
            .Select(r => new { r.ExecutionId, r.Title, r.Module, r.Status, r.Flaky }).ToListAsync(ct))
            .Select(r => new { ExecutionId = owner[r.ExecutionId], r.Title, r.Module, r.Status, r.Flaky }).ToList();
        string Key(string? module, string title) => $"{module} › {title}";
        string StatusOf(ResultStatus s, bool flaky) => flaky ? "flaky" : ExecutionEndpoints.Snake(s.ToString());
        var left = results.Where(r => r.ExecutionId == before).GroupBy(r => Key(r.Module, r.Title)).ToDictionary(g => g.Key, g => g.Last());
        var right = results.Where(r => r.ExecutionId == after).GroupBy(r => Key(r.Module, r.Title)).ToDictionary(g => g.Key, g => g.Last());

        var rows = new List<ComparisonRowDto>();
        foreach (var key in left.Keys.Union(right.Keys).Order())
        {
            var l = left.GetValueOrDefault(key);
            var r = right.GetValueOrDefault(key);
            var ls = l is null ? null : StatusOf(l.Status, l.Flaky);
            var rs = r is null ? null : StatusOf(r.Status, r.Flaky);
            rows.Add(new ComparisonRowDto((r ?? l)!.Title, (r ?? l)!.Module, ls, rs, Change(ls, rs)));
        }
        var envKeys = await db.Environments.AsNoTracking().Where(e => e.ProjectId == a.ProjectId).ToDictionaryAsync(e => e.Id, e => e.Key, ct);
        var summary = rows.GroupBy(r => r.Change).ToDictionary(g => g.Key, g => g.Count());
        // most important first: what broke, then what was fixed
        var order = new[] { "broke", "fixed", "still_failing", "added", "removed", "unchanged" };
        return Results.Ok(new ComparisonDto(
            ExecutionEndpoints.ToDto(a, envKeys.GetValueOrDefault(a.EnvironmentId, "?")),
            ExecutionEndpoints.ToDto(b, envKeys.GetValueOrDefault(b.EnvironmentId, "?")),
            summary,
            rows.OrderBy(r => Array.IndexOf(order, r.Change)).ThenBy(r => r.Module).ThenBy(r => r.Title).ToList()));
    }

    internal static string Change(string? before, string? after)
    {
        static bool Ok(string? s) => s is "passed" or "flaky" or "skipped";
        if (before is null) return "added";
        if (after is null) return "removed";
        if (Ok(before) && !Ok(after)) return "broke";
        if (!Ok(before) && Ok(after)) return "fixed";
        if (!Ok(before) && !Ok(after)) return "still_failing";
        return "unchanged";
    }

    /// <summary>The organisation's audit trail, newest first; filter by resource type or action prefix.</summary>
    private static async Task<IResult> Audit(string? resourceType, string? action, long? before, int? take, AtimthaDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var n = Math.Clamp(take ?? 100, 1, 500);
        var org = tenant.OrganizationId;
        var q = db.AuditLog.AsNoTracking().Where(a => a.OrganizationId == org);
        if (!string.IsNullOrWhiteSpace(resourceType)) q = q.Where(a => a.ResourceType == resourceType);
        if (!string.IsNullOrWhiteSpace(action)) q = q.Where(a => a.Action.StartsWith(action));
        if (before is not null) q = q.Where(a => a.Id < before);
        var rows = await (
            from a in q.OrderByDescending(a => a.Id).Take(n)
            join u in db.Users.AsNoTracking() on a.ActorUserId equals u.Id into us
            from u in us.DefaultIfEmpty()
            select new AuditEntryDto(a.Id, a.At, a.Action, a.ResourceType, a.ResourceId, u == null ? (a.ActorAgentId == null ? null : "agent") : u.Email, a.Details)
        ).ToListAsync(ct);
        return Results.Ok(rows);
    }
}
