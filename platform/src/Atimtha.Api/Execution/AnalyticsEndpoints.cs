using Atimtha.Api.Identity;
using Atimtha.Api.Infrastructure;
using Atimtha.Api.TestAssets;
using Atimtha.Api.Workspaces;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.Execution;

using Api = Atimtha.Api.Infrastructure.Api;

public sealed record HealedLocatorDto(string Target, string Kind, int Count, int Tests, DateTimeOffset LastAt, string LastHealedBy, string? Fix, bool DuringChecks);
public sealed record HealingDayDto(DateOnly Day, int Heals);
public sealed record HealingReportDto(int Days, int Heals, int HealedTests, IReadOnlyList<HealedLocatorDto> Locators, IReadOnlyList<HealingDayDto> PerDay);

public sealed record CaseCoverageDto(string Key, string Title, string? Module, string Engine, int Rows, string? LastStatus, DateTimeOffset? LastRunAt,
    Guid? LastExecutionId, int Runs, int Failures, string[] Suites);
public sealed record ModuleCoverageDto(string Module, int Cases, int Rows, int Passing, int Failing, int NeverRun);
public sealed record SuiteCoverageDto(string Key, int Cases);
public sealed record CoverageDto(int Days, int Cases, int NeverRun, IReadOnlyList<ModuleCoverageDto> Modules, IReadOnlyList<SuiteCoverageDto> Suites, IReadOnlyList<CaseCoverageDto> CaseList);

/// <summary>
/// Project analytics (backlog §11): which locators keep needing self-healing (what to fix in the object repository),
/// and what the tests cover — per module, per suite, per case with its last result and the cases never run.
/// </summary>
public static class AnalyticsEndpoints
{
    public static RouteGroupBuilder MapAnalytics(this RouteGroupBuilder api)
    {
        api.MapGet("/projects/{projectId:guid}/analytics/healing", Healing).WithTags("Reports").RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        api.MapGet("/projects/{projectId:guid}/analytics/coverage", Coverage).WithTags("Reports").RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        return api;
    }

    private static async Task<IResult> Healing(Guid projectId, int? days, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        if (await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct) is null) return Api.NotFound("The project");
        var n = Math.Clamp(days ?? 30, 1, 365);
        var since = DateTimeOffset.UtcNow.AddDays(-n);
        var heals = await (
            from h in db.HealingEvents.AsNoTracking()
            join r in db.Results.AsNoTracking() on h.TestResultId equals r.Id
            join x in db.Executions.AsNoTracking() on r.ExecutionId equals x.Id
            where x.ProjectId == projectId && x.QueuedAt >= since
            select new { h.Target, h.Kind, h.Purpose, h.HealedBy, h.Fix, r.Title, r.Id, At = x.QueuedAt }).ToListAsync(ct);

        var locators = heals.GroupBy(h => (h.Target, h.Kind)).Select(g =>
        {
            var last = g.MaxBy(x => x.At)!;
            return new HealedLocatorDto(g.Key.Target, ExecutionEndpoints.HealKindName(g.Key.Kind), g.Count(), g.Select(x => x.Title).Distinct().Count(),
                last.At, last.HealedBy, last.Fix, g.Any(x => x.Purpose == HealPurpose.Check));
        }).OrderByDescending(l => l.Count).ThenBy(l => l.Target).ToList();
        var perDay = heals.GroupBy(h => DateOnly.FromDateTime(h.At.UtcDateTime)).OrderBy(g => g.Key).Select(g => new HealingDayDto(g.Key, g.Count())).ToList();
        return Results.Ok(new HealingReportDto(n, heals.Count, heals.Select(h => h.Id).Distinct().Count(), locators, perDay));
    }

    private static async Task<IResult> Coverage(Guid projectId, int? days, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        if (await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct) is null) return Api.NotFound("The project");
        var n = Math.Clamp(days ?? 90, 1, 365);
        var since = DateTimeOffset.UtcNow.AddDays(-n);
        var cases = await db.Cases.AsNoTracking().Where(c => c.ProjectId == projectId).OrderBy(c => c.Module).ThenBy(c => c.Title).ToListAsync(ct);
        var rowCounts = await db.DataRows.AsNoTracking().Where(r => cases.Select(c => c.Id).Contains(r.CaseId))
            .GroupBy(r => r.CaseId).Select(g => new { g.Key, Count = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.Count, ct);
        var results = await (
            from r in db.Results.AsNoTracking()
            join x in db.Executions.AsNoTracking() on r.ExecutionId equals x.Id
            where x.ProjectId == projectId && x.QueuedAt >= since && r.CaseId != null
            select new { CaseId = r.CaseId!.Value, r.Status, r.Flaky, x.Id, At = r.StartedAt ?? x.QueuedAt }).ToListAsync(ct);
        var byCase = results.ToLookup(r => r.CaseId);

        // suite membership as the engine selects it: by module, by tag or by name
        var suites = await db.Suites.AsNoTracking().Where(s => s.ProjectId == projectId).OrderBy(s => s.Key).ToListAsync(ct);
        var explicitCases = (await db.SuiteCases.AsNoTracking().Where(sc => suites.Select(s => s.Id).Contains(sc.SuiteId)).ToListAsync(ct)).ToLookup(sc => sc.SuiteId, sc => sc.CaseId);
        bool InSuite(RunSuite s, TestCase c) =>
            explicitCases[s.Id].Contains(c.Id) || (c.Module is not null && s.Modules.Contains(c.Module)) || c.Tags.Intersect(s.Tags).Any();

        static bool Failed(ResultStatus s) => s is ResultStatus.Failed or ResultStatus.TimedOut or ResultStatus.Interrupted;
        var list = cases.Select(c =>
        {
            var rs = byCase[c.Id].ToList();
            // the last run of the case: worst result among its rows in that run
            var lastRun = rs.MaxBy(r => r.At);
            var lastRows = rs.Where(r => lastRun is not null && r.Id == lastRun.Id).ToList();
            string? status = lastRun is null ? null
                : lastRows.Any(r => Failed(r.Status)) ? "failed" : lastRows.Any(r => r.Flaky) ? "flaky" : lastRows.All(r => r.Status == ResultStatus.Skipped) ? "skipped" : "passed";
            return new CaseCoverageDto(c.Key, c.Title, c.Module, c.Engine, Math.Max(rowCounts.GetValueOrDefault(c.Id), 1), status, lastRun?.At, lastRun?.Id,
                rs.Select(r => r.Id).Distinct().Count(), rs.Count(r => Failed(r.Status)), suites.Where(s => InSuite(s, c)).Select(s => s.Key).ToArray());
        }).ToList();

        var modules = list.GroupBy(c => c.Module ?? "—").Select(g => new ModuleCoverageDto(g.Key, g.Count(), g.Sum(c => c.Rows),
            g.Count(c => c.LastStatus is "passed" or "flaky"), g.Count(c => c.LastStatus == "failed"), g.Count(c => c.LastStatus is null))).OrderBy(m => m.Module).ToList();
        return Results.Ok(new CoverageDto(n, list.Count, list.Count(c => c.LastStatus is null), modules,
            suites.Select(s => new SuiteCoverageDto(s.Key, list.Count(c => c.Suites.Contains(s.Key)))).ToList(), list));
    }
}
