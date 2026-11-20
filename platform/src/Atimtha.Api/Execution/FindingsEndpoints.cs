using System.Text.Json.Nodes;
using Atimtha.Api.Identity;
using Atimtha.Api.Infrastructure;
using Atimtha.Api.Workspaces;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.Execution;

using Api = Atimtha.Api.Infrastructure.Api;

public sealed record FoundPageDto(string Url, string? Page, int Tests, IReadOnlyList<string> SeenBy);
public sealed record FoundMessageDto(string Text, string Kind, string? Tone, string? Title, string? Page, string Url, string? Selector, bool Known, int Tests, IReadOnlyList<string> SeenBy);
public sealed record FindingsDto(IReadOnlyList<FoundPageDto> NewPages, IReadOnlyList<FoundPageDto> KnownPages, IReadOnlyList<FoundMessageDto> Messages);

/// <summary>
/// GET /api/v1/executions/{id}/findings (backlog §11 "findings and post-run discoveries"): every page the run's tests
/// reached and every message that popped up, merged across tests. Pages not in the object repository and messages
/// not yet in the expected messages are the ones worth turning into pages, messages and test cases.
/// </summary>
public static class FindingsEndpoints
{
    public static RouteGroupBuilder MapFindings(this RouteGroupBuilder api)
    {
        api.MapGet("/executions/{executionId:guid}/findings", Get).WithTags("Reports").RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        return api;
    }

    private static async Task<IResult> Get(Guid executionId, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        var run = await db.Executions.AsNoTracking().FirstOrDefaultAsync(e => e.Id == executionId, ct);
        if (run is null || await ProjectEndpoints.Visible(run.ProjectId, Permissions.ProjectView, db, access, ct) is null) return Api.NotFound("The run");
        var runIds = await Shards.RunIdsAsync(db, executionId, ct);
        var results = await db.Results.AsNoTracking().Where(r => runIds.Contains(r.ExecutionId) && r.Discoveries != null)
            .Select(r => new { r.Title, r.Discoveries }).ToListAsync(ct);
        var knownTexts = (await db.Messages.AsNoTracking().Where(m => m.ProjectId == run.ProjectId).Select(m => m.Text).ToListAsync(ct))
            .Select(Normalize).ToHashSet();

        var pages = new Dictionary<string, (string Url, string? Page, HashSet<string> Tests)>();
        var messages = new Dictionary<string, (JsonObject M, HashSet<string> Tests)>();
        foreach (var r in results)
        {
            JsonObject? d;
            try { d = JsonNode.Parse(r.Discoveries!) as JsonObject; } catch (System.Text.Json.JsonException) { continue; }
            foreach (var v in d?["visits"] as JsonArray ?? [])
            {
                var url = Str(v?["url"]);
                if (url is null) continue;
                var key = PathOf(url);
                if (!pages.TryGetValue(key, out var p)) pages[key] = p = (url, Str(v?["page"]), []);
                p.Tests.Add(r.Title);
            }
            foreach (var m in d?["messages"] as JsonArray ?? [])
            {
                if (m is not JsonObject o || Str(o["text"]) is not { } text) continue;
                var key = $"{Str(o["kind"])}|{Normalize(text)}";
                if (!messages.TryGetValue(key, out var e)) messages[key] = e = (o, []);
                e.Tests.Add(r.Title);
            }
        }

        static List<string> Some(HashSet<string> s) => s.Order().Take(5).ToList();
        var found = pages.Values.Select(p => new FoundPageDto(p.Url, p.Page, p.Tests.Count, Some(p.Tests))).OrderByDescending(p => p.Tests).ToList();
        return Results.Ok(new FindingsDto(
            found.Where(p => p.Page is null).ToList(),
            found.Where(p => p.Page is not null).ToList(),
            messages.Values.Select(e => new FoundMessageDto(
                Str(e.M["text"])!, Str(e.M["kind"]) ?? "alert", Str(e.M["tone"]), Str(e.M["title"]), Str(e.M["page"]), Str(e.M["url"]) ?? "",
                Str(e.M["testid"]) is { } tid ? $"testid={tid}" : Str(e.M["id"]) is { } id ? $"id={id}" : Str(e.M["css"]),
                knownTexts.Contains(Normalize(Str(e.M["text"])!)), e.Tests.Count, Some(e.Tests)))
                .OrderBy(m => m.Known).ThenByDescending(m => m.Tests).ToList()));
    }

    private static string? Str(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) && s.Length > 0 ? s : null;

    /// <summary>the address without query and fragment: one finding per page, not per visit</summary>
    private static string PathOf(string url) => Uri.TryCreate(url, UriKind.Absolute, out var u) ? $"{u.Host}{u.AbsolutePath}" : url.Split('?', '#')[0];

    private static string Normalize(string s) => string.Join(' ', s.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)).ToLowerInvariant();
}
