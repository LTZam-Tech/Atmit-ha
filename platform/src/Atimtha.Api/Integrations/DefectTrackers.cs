using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Atimtha.Api.Execution;

namespace Atimtha.Api.Integrations;

/// <summary>A failure the tracker refused or could not take; Status is the tracker's HTTP status when there is one.</summary>
public class TrackerException(string message, int? status = null) : Exception(message)
{
    public int? Status { get; } = status;
}

/// <summary>One failed result, as every tracker files it.</summary>
public sealed record DefectReport(string ProjectKey, string ProjectName, string Environment, ExecutionRun Run, TestResult Result, string? RunUrl)
{
    public string Summary => $"[{ProjectKey}] {(string.IsNullOrWhiteSpace(Result.Module) ? "" : Result.Module + " › ")}{Result.Title}";
    public string Status => ExecutionEndpoints.Snake(Result.Status.ToString()) + (Result.Retries > 0 ? $" after {Result.Retries} retries" : "");
    public string? Category => Result.Category is FailureCategory c ? ExecutionEndpoints.Snake(c.ToString()) : null;
    public string? Error => string.IsNullOrWhiteSpace(Result.Error) ? null : Result.Error.Length > 8000 ? Result.Error[..8000] : Result.Error;
}

/// <summary>
/// The integration contract of ADR-0010: check the connection, file a defect. Each tracker validates its own
/// configuration (never a secret: the token is the integration's credential reference).
/// </summary>
public interface IDefectTracker
{
    IntegrationKind Kind { get; }
    /// <summary>feature flag that switches this tracker off for an organisation</summary>
    string Flag { get; }
    /// <summary>problems as (field, message); the normalised configuration when there are none</summary>
    IReadOnlyList<(string Field, string Message)> Validate(JsonObject config, bool development, out JsonObject? normalized);
    Task<string> CheckAsync(string configJson, string token, CancellationToken ct);
    Task<(string Key, string Url)> CreateAsync(string configJson, string token, DefectReport report, CancellationToken ct);
}

/// <summary>The integration adapters by kind: defect trackers (Jira, Azure DevOps) and result publishers (TestRail).</summary>
public sealed class DefectTrackers(IEnumerable<IDefectTracker> trackers, IEnumerable<IResultPublisher> publishers)
{
    private readonly Dictionary<IntegrationKind, IDefectTracker> byKind = trackers.ToDictionary(t => t.Kind);
    private readonly Dictionary<IntegrationKind, IResultPublisher> publishersByKind = publishers.ToDictionary(p => p.Kind);
    public IDefectTracker? For(IntegrationKind kind) => byKind.GetValueOrDefault(kind);
    public IResultPublisher? Publisher(IntegrationKind kind) => publishersByKind.GetValueOrDefault(kind);
    public bool Knows(IntegrationKind kind) => byKind.ContainsKey(kind) || publishersByKind.ContainsKey(kind);

    public IReadOnlyList<(string Field, string Message)> Validate(IntegrationKind kind, JsonObject config, bool development, out JsonObject? normalized)
    {
        if (For(kind) is { } t) return t.Validate(config, development, out normalized);
        if (Publisher(kind) is { } p) return p.Validate(config, development, out normalized);
        normalized = null;
        return [("kind", "This kind of integration is not available.")];
    }

    public Task<string> CheckAsync(IntegrationKind kind, string configJson, string token, CancellationToken ct) =>
        For(kind)?.CheckAsync(configJson, token, ct) ?? Publisher(kind)?.CheckAsync(configJson, token, ct)
        ?? throw new TrackerException("This kind of integration cannot be checked.");

    public static IntegrationKind? ParseKind(string? kind) => kind switch
    {
        "jira" => IntegrationKind.Jira, "azure_devops" => IntegrationKind.AzureDevops, "testrail" => IntegrationKind.Testrail, _ => null,
    };
}

/// <summary>Jira Cloud and Data Center (JiraClient), issues in Jira wiki markup.</summary>
public sealed partial class JiraTracker(JiraClient jira) : IDefectTracker
{
    public IntegrationKind Kind => IntegrationKind.Jira;
    public string Flag => "integration.jira";

    [GeneratedRegex("^[A-Z][A-Z0-9_]{0,9}$")]
    private static partial Regex ProjectKey();

    public IReadOnlyList<(string, string)> Validate(JsonObject config, bool development, out JsonObject? normalized)
    {
        var c = JiraConfig.From(config.ToJsonString());
        var p = new List<(string, string)>();
        if (!Uri.TryCreate(c.BaseUrl, UriKind.Absolute, out var u) || (u.Scheme != "https" && !(development && u.Scheme == "http")))
            p.Add(("config.baseUrl", "Use an https:// address."));
        if (!ProjectKey().IsMatch(c.ProjectKey)) p.Add(("config.projectKey", "Use the Jira project key, e.g. QA."));
        if (c.IssueType.Length is 0 or > 60) p.Add(("config.issueType", "1 to 60 characters."));
        if (c.Auth is not ("basic" or "bearer")) p.Add(("config.auth", "Use \"basic\" (Jira Cloud: email + API token) or \"bearer\" (Data Center: personal access token)."));
        if (c.Auth == "basic" && !(c.Email?.Contains('@') ?? false)) p.Add(("config.email", "Jira Cloud needs the account email."));
        if (c.Labels.Count > 10 || c.Labels.Any(l => l.Length > 50)) p.Add(("config.labels", "At most 10 labels of 50 characters."));
        normalized = p.Count == 0 ? c.ToJson() : null;
        return p;
    }

    public Task<string> CheckAsync(string configJson, string token, CancellationToken ct) => jira.CheckAsync(JiraConfig.From(configJson), token, ct);

    public async Task<(string, string)> CreateAsync(string configJson, string token, DefectReport r, CancellationToken ct)
    {
        var sb = new StringBuilder();
        sb.AppendLine("Automated test failed in Atimtha.").AppendLine();
        sb.AppendLine($"*Project:* {r.ProjectName}");
        sb.AppendLine($"*Environment:* {r.Environment}");
        sb.AppendLine($"*Result:* {r.Status}");
        if (r.Category is { } cat) sb.AppendLine($"*Category:* {cat}");
        if (r.Run.FinishedAt is DateTimeOffset at) sb.AppendLine($"*Run finished:* {at:yyyy-MM-dd HH:mm} UTC");
        if (r.RunUrl is not null) sb.AppendLine($"*Run:* {r.RunUrl}");
        if (r.Error is { } err) sb.AppendLine().AppendLine("{noformat}").AppendLine(err).AppendLine("{noformat}");
        var issue = await jira.CreateIssueAsync(JiraConfig.From(configJson), token, r.Summary, sb.ToString(), ct);
        return (issue.Key, issue.Url);
    }
}

/// <summary>
/// Azure DevOps Services and Server: work items through REST 7.1 with a personal access token (Basic, empty user).
/// Config: baseUrl (https://dev.azure.com/&lt;org&gt; or the collection URL), project, workItemType (default Bug),
/// areaPath (optional), tags.
/// </summary>
public sealed class AzureDevOpsTracker(HttpClient http) : IDefectTracker
{
    public IntegrationKind Kind => IntegrationKind.AzureDevops;
    public string Flag => "integration.azure_devops";
    private const string ApiVersion = "7.1";

    private sealed record Config(string BaseUrl, string Project, string WorkItemType, string? AreaPath, IReadOnlyList<string> Tags)
    {
        public static Config From(string json)
        {
            var o = JsonNode.Parse(json) as JsonObject ?? new JsonObject();
            string? S(string k) => o[k] is JsonValue v && v.TryGetValue<string>(out var s) && !string.IsNullOrWhiteSpace(s) ? s.Trim() : null;
            var tags = o["tags"] is JsonArray a ? a.Select(x => x?.GetValue<string>()).Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x!.Trim()).ToList() : [];
            return new Config((S("baseUrl") ?? "").TrimEnd('/'), S("project") ?? "", S("workItemType") ?? "Bug", S("areaPath"), tags);
        }

        public JsonObject ToJson() => new()
        {
            ["baseUrl"] = BaseUrl, ["project"] = Project, ["workItemType"] = WorkItemType, ["areaPath"] = AreaPath,
            ["tags"] = new JsonArray(Tags.Select(t => (JsonNode)JsonValue.Create(t)!).ToArray()),
        };
    }

    public IReadOnlyList<(string, string)> Validate(JsonObject config, bool development, out JsonObject? normalized)
    {
        var c = Config.From(config.ToJsonString());
        var p = new List<(string, string)>();
        if (!Uri.TryCreate(c.BaseUrl, UriKind.Absolute, out var u) || (u.Scheme != "https" && !(development && u.Scheme == "http")))
            p.Add(("config.baseUrl", "Use an https:// address, e.g. https://dev.azure.com/your-organisation."));
        if (c.Project.Length is 0 or > 64 || c.Project.IndexOfAny(['/', '\\', '?', '#']) >= 0) p.Add(("config.project", "Use the Azure DevOps project name."));
        if (c.WorkItemType.Length is 0 or > 60 || c.WorkItemType.IndexOfAny(['/', '?', '#']) >= 0) p.Add(("config.workItemType", "A work item type such as Bug."));
        if (c.AreaPath is { Length: > 256 }) p.Add(("config.areaPath", "At most 256 characters."));
        if (c.Tags.Count > 10 || c.Tags.Any(t => t.Length > 50 || t.Contains(';'))) p.Add(("config.tags", "At most 10 tags of 50 characters, without \";\"."));
        normalized = p.Count == 0 ? c.ToJson() : null;
        return p;
    }

    public async Task<string> CheckAsync(string configJson, string token, CancellationToken ct)
    {
        var c = Config.From(configJson);
        using var req = Request(HttpMethod.Get, $"{c.BaseUrl}/_apis/connectionData", token);
        using var res = await http.SendAsync(req, ct);
        await EnsureOk(res, ct);
        // the project must exist and be visible to the token
        using var project = Request(HttpMethod.Get, $"{c.BaseUrl}/_apis/projects/{Uri.EscapeDataString(c.Project)}?api-version={ApiVersion}", token);
        using var pres = await http.SendAsync(project, ct);
        await EnsureOk(pres, ct);
        var data = await res.Content.ReadFromJsonAsync<JsonObject>(ct);
        return data?["authenticatedUser"]?["providerDisplayName"]?.GetValue<string>() ?? "?";
    }

    public async Task<(string, string)> CreateAsync(string configJson, string token, DefectReport r, CancellationToken ct)
    {
        var c = Config.From(configJson);
        string E(string? s) => WebUtility.HtmlEncode(s ?? "");
        var html = new StringBuilder("<p>Automated test failed in Atimtha.</p><ul>");
        html.Append($"<li><b>Project:</b> {E(r.ProjectName)}</li><li><b>Environment:</b> {E(r.Environment)}</li><li><b>Result:</b> {E(r.Status)}</li>");
        if (r.Category is { } cat) html.Append($"<li><b>Category:</b> {E(cat)}</li>");
        if (r.Run.FinishedAt is DateTimeOffset at) html.Append($"<li><b>Run finished:</b> {at:yyyy-MM-dd HH:mm} UTC</li>");
        if (r.RunUrl is not null) html.Append($"<li><b>Run:</b> <a href=\"{E(r.RunUrl)}\">{E(r.RunUrl)}</a></li>");
        html.Append("</ul>");
        if (r.Error is { } err) html.Append($"<pre>{E(err)}</pre>");

        var ops = new JsonArray
        {
            Op("System.Title", r.Summary.Length > 255 ? r.Summary[..255] : r.Summary),
            Op("Microsoft.VSTS.TCM.ReproSteps", html.ToString()),
            Op("System.Description", html.ToString()),
        };
        if (c.AreaPath is not null) ops.Add(Op("System.AreaPath", c.AreaPath));
        if (c.Tags.Count > 0) ops.Add(Op("System.Tags", string.Join("; ", c.Tags)));

        var url = $"{c.BaseUrl}/{Uri.EscapeDataString(c.Project)}/_apis/wit/workitems/${Uri.EscapeDataString(c.WorkItemType)}?api-version={ApiVersion}";
        using var req = Request(HttpMethod.Post, url, token);
        req.Content = new StringContent(ops.ToJsonString(), Encoding.UTF8);
        req.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json-patch+json");
        using var res = await http.SendAsync(req, ct);
        await EnsureOk(res, ct);
        var body = await res.Content.ReadFromJsonAsync<JsonObject>(ct);
        var id = body?["id"]?.GetValue<int>() ?? throw new TrackerException("Azure DevOps did not return a work item id.");
        var link = body?["_links"]?["html"]?["href"]?.GetValue<string>() ?? $"{c.BaseUrl}/{Uri.EscapeDataString(c.Project)}/_workitems/edit/{id}";
        return ($"#{id}", link);
    }

    private static JsonObject Op(string field, string value) => new() { ["op"] = "add", ["path"] = $"/fields/{field}", ["value"] = value };

    private static HttpRequestMessage Request(HttpMethod method, string url, string token)
    {
        var req = new HttpRequestMessage(method, url);
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        req.Headers.Authorization = new AuthenticationHeaderValue("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes(":" + token)));
        return req;
    }

    private static async Task EnsureOk(HttpResponseMessage res, CancellationToken ct)
    {
        if (res.IsSuccessStatusCode && res.Content.Headers.ContentType?.MediaType != "text/html") return;
        // a sign-in page (HTML 203/302) means the token was not accepted
        if (res.Content.Headers.ContentType?.MediaType == "text/html") throw new TrackerException("Azure DevOps did not accept the token.", 401);
        var text = await res.Content.ReadAsStringAsync(ct);
        string detail;
        try { detail = JsonNode.Parse(text)?["message"]?.GetValue<string>() ?? $"HTTP {(int)res.StatusCode}"; }
        catch (JsonException) { detail = $"HTTP {(int)res.StatusCode}"; }
        throw new TrackerException(detail, (int)res.StatusCode);
    }
}
