using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Atimtha.Api.Execution;

namespace Atimtha.Api.Integrations;

/// <summary>One result as a test-management tool receives it: the tool's case id comes from a C123 tag.</summary>
public sealed record PublishedResult(long CaseId, ResultStatus Status, bool Flaky, string Title, string? Error, int? DurationMs, string? Category);

/// <summary>A whole run, for result publishing (backlog §14 "result publishing").</summary>
public sealed record RunReport(string ProjectKey, string ProjectName, string Environment, ExecutionRun Run, IReadOnlyList<PublishedResult> Results, string? RunUrl);

/// <summary>
/// Test-management contract of ADR-0010 next to IDefectTracker: publish a run's results. TestRail first; a tool
/// such as Azure Test Plans or Xray becomes another adapter of this interface.
/// </summary>
public interface IResultPublisher
{
    IntegrationKind Kind { get; }
    string Flag { get; }
    IReadOnlyList<(string Field, string Message)> Validate(JsonObject config, bool development, out JsonObject? normalized);
    Task<string> CheckAsync(string configJson, string token, CancellationToken ct);
    /// <returns>the tool's run id and address</returns>
    Task<(string RunId, string Url)> PublishAsync(string configJson, string token, RunReport report, CancellationToken ct);
}

/// <summary>
/// TestRail (cloud and server, API v2). Config: baseUrl, email, projectId, suiteId (multi-suite projects),
/// closeRun. The token is a TestRail API key. Results map to TestRail cases by tags such as @C123 on the data row
/// (first) or the test case; several rows of one TestRail case report their worst result.
/// </summary>
public sealed partial class TestRailPublisher(HttpClient http) : IResultPublisher
{
    public IntegrationKind Kind => IntegrationKind.Testrail;
    public string Flag => "integration.testrail";

    [GeneratedRegex("^@?C(\\d{1,10})$", RegexOptions.IgnoreCase)]
    public static partial Regex CaseTag();

    private sealed record Config(string BaseUrl, string Email, long ProjectId, long? SuiteId, bool CloseRun)
    {
        public static Config From(string json)
        {
            var o = JsonNode.Parse(json) as JsonObject ?? new JsonObject();
            string? S(string k) => o[k] is JsonValue v && v.TryGetValue<string>(out var s) && !string.IsNullOrWhiteSpace(s) ? s.Trim() : null;
            long? L(string k) => o[k] is JsonValue v ? (v.TryGetValue<long>(out var n) ? n : v.TryGetValue<string>(out var s) && long.TryParse(s, out var p) ? p : null) : null;
            return new Config((S("baseUrl") ?? "").TrimEnd('/'), S("email") ?? "", L("projectId") ?? 0, L("suiteId"),
                o["closeRun"] is JsonValue c && c.TryGetValue<bool>(out var close) && close);
        }

        public JsonObject ToJson() => new() { ["baseUrl"] = BaseUrl, ["email"] = Email, ["projectId"] = ProjectId, ["suiteId"] = SuiteId, ["closeRun"] = CloseRun };
    }

    public IReadOnlyList<(string, string)> Validate(JsonObject config, bool development, out JsonObject? normalized)
    {
        var c = Config.From(config.ToJsonString());
        var p = new List<(string, string)>();
        if (!Uri.TryCreate(c.BaseUrl, UriKind.Absolute, out var u) || (u.Scheme != "https" && !(development && u.Scheme == "http")))
            p.Add(("config.baseUrl", "Use an https:// address, e.g. https://your-team.testrail.io."));
        if (!c.Email.Contains('@') || c.Email.Length > 254) p.Add(("config.email", "The TestRail account's email."));
        if (c.ProjectId <= 0) p.Add(("config.projectId", "The TestRail project id (a number)."));
        if (c.SuiteId is <= 0) p.Add(("config.suiteId", "A suite id (a number), or leave it empty."));
        normalized = p.Count == 0 ? c.ToJson() : null;
        return p;
    }

    public async Task<string> CheckAsync(string configJson, string token, CancellationToken ct)
    {
        var c = Config.From(configJson);
        var project = await Send(HttpMethod.Get, c, token, $"get_project/{c.ProjectId}", null, ct);
        return $"{c.Email} · {project?["name"]?.GetValue<string>() ?? "?"}";
    }

    public async Task<(string, string)> PublishAsync(string configJson, string token, RunReport r, CancellationToken ct)
    {
        var c = Config.From(configJson);
        // several rows of one TestRail case: the worst result wins (failed > flaky > passed)
        static int Rank(PublishedResult x) => x.Status is ResultStatus.Failed or ResultStatus.TimedOut or ResultStatus.Interrupted ? 3 : x.Flaky ? 2 : 1;
        var byCase = r.Results.Where(x => x.Status != ResultStatus.Skipped).GroupBy(x => x.CaseId)
            .Select(g => (Id: g.Key, Worst: g.OrderByDescending(Rank).First(), All: g.ToList())).ToList();
        if (byCase.Count == 0) throw new TrackerException("No result of this run is linked to a TestRail case (tag a case or row with @C123).");

        var run = new JsonObject
        {
            ["name"] = $"Atimtha · {r.ProjectName} · {r.Environment} · {(r.Run.FinishedAt ?? r.Run.QueuedAt):yyyy-MM-dd HH:mm} UTC",
            ["description"] = $"Automated run of Atimtha project {r.ProjectKey}.{(r.RunUrl is null ? "" : $" {r.RunUrl}")}",
            ["include_all"] = false,
            ["case_ids"] = new JsonArray(byCase.Select(x => (JsonNode)JsonValue.Create(x.Id)!).ToArray()),
        };
        if (c.SuiteId is long suite) run["suite_id"] = suite;
        var created = await Send(HttpMethod.Post, c, token, $"add_run/{c.ProjectId}", run, ct);
        var runId = created?["id"]?.GetValue<long>() ?? throw new TrackerException("TestRail did not return a run id.");

        var results = new JsonArray(byCase.Select(x =>
        {
            var w = x.Worst;
            var failed = Rank(w) == 3;
            var comment = new StringBuilder($"{x.All.Count} test(s) in Atimtha: {string.Join(", ", x.All.Select(a => a.Title).Take(10))}");
            if (w.Flaky) comment.Append("\nFlaky: passed after a retry.");
            if (failed && w.Category is not null) comment.Append($"\nCategory: {w.Category}");
            if (failed && w.Error is not null) comment.Append($"\n\n{(w.Error.Length > 4000 ? w.Error[..4000] : w.Error)}");
            var result = new JsonObject { ["case_id"] = x.Id, ["status_id"] = failed ? 5 : 1, ["comment"] = comment.ToString() };
            var seconds = (int)Math.Ceiling(x.All.Sum(a => a.DurationMs ?? 0) / 1000.0);
            if (seconds > 0) result["elapsed"] = $"{seconds}s";
            return (JsonNode)result;
        }).ToArray());
        await Send(HttpMethod.Post, c, token, $"add_results_for_cases/{runId}", new JsonObject { ["results"] = results }, ct);
        if (c.CloseRun) await Send(HttpMethod.Post, c, token, $"close_run/{runId}", new JsonObject(), ct);
        return (runId.ToString(), $"{c.BaseUrl}/index.php?/runs/view/{runId}");
    }

    private async Task<JsonObject?> Send(HttpMethod method, Config c, string token, string call, JsonObject? body, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(method, $"{c.BaseUrl}/index.php?/api/v2/{call}");
        req.Headers.Authorization = new AuthenticationHeaderValue("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes($"{c.Email}:{token}")));
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (body is not null) req.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        using var res = await http.SendAsync(req, ct);
        var text = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode)
        {
            string detail;
            try { detail = JsonNode.Parse(text)?["error"]?.GetValue<string>() ?? $"HTTP {(int)res.StatusCode}"; }
            catch (JsonException) { detail = $"HTTP {(int)res.StatusCode}"; }
            throw new TrackerException($"TestRail: {detail}", (int)res.StatusCode);
        }
        try { return JsonNode.Parse(text) as JsonObject; } catch (JsonException) { return null; }
    }
}
