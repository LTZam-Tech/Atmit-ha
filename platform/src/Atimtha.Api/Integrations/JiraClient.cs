using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Atimtha.Api.Integrations;

/// <summary>Jira settings kept in integration.config (no secret here; the token is integration.credential_secret_ref).</summary>
public sealed record JiraConfig(string BaseUrl, string ProjectKey, string IssueType, string Auth, string? Email, IReadOnlyList<string> Labels)
{
    public static JiraConfig From(string json)
    {
        var o = JsonNode.Parse(json) as JsonObject ?? new JsonObject();
        string? S(string k) => o[k] is JsonValue v && v.TryGetValue<string>(out var s) && !string.IsNullOrWhiteSpace(s) ? s.Trim() : null;
        var labels = o["labels"] is JsonArray a ? a.Select(x => x?.GetValue<string>()).Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x!).ToList() : [];
        return new JiraConfig((S("baseUrl") ?? "").TrimEnd('/'), S("projectKey") ?? "", S("issueType") ?? "Bug", S("auth") ?? "basic", S("email"), labels);
    }

    public JsonObject ToJson() => new()
    {
        ["baseUrl"] = BaseUrl, ["projectKey"] = ProjectKey, ["issueType"] = IssueType, ["auth"] = Auth, ["email"] = Email,
        ["labels"] = new JsonArray(Labels.Select(l => (JsonNode)JsonValue.Create(l)!).ToArray()),
    };
}

public sealed record JiraIssue(string Key, string Url);

public sealed class JiraException(string message, int? status = null) : TrackerException(message, status);

/// <summary>
/// Minimal Jira REST v2 client (works with Jira Cloud and Data Center): check the credentials, create an issue.
/// Cloud: auth "basic" with the account email and an API token. Data Center: auth "bearer" with a personal access token.
/// </summary>
public sealed class JiraClient(HttpClient http)
{
    public async Task<string> CheckAsync(JiraConfig config, string token, CancellationToken ct)
    {
        using var req = Request(HttpMethod.Get, config, token, "/rest/api/2/myself");
        using var res = await http.SendAsync(req, ct);
        await EnsureOk(res, ct);
        var me = await res.Content.ReadFromJsonAsync<JsonObject>(ct);
        return me?["displayName"]?.GetValue<string>() ?? me?["name"]?.GetValue<string>() ?? "?";
    }

    public async Task<JiraIssue> CreateIssueAsync(JiraConfig config, string token, string summary, string description, CancellationToken ct)
    {
        var fields = new JsonObject
        {
            ["project"] = new JsonObject { ["key"] = config.ProjectKey },
            ["issuetype"] = new JsonObject { ["name"] = config.IssueType },
            ["summary"] = summary.Length > 250 ? summary[..250] : summary,
            ["description"] = description.Length > 30000 ? description[..30000] : description,
        };
        if (config.Labels.Count > 0) fields["labels"] = new JsonArray(config.Labels.Select(l => (JsonNode)JsonValue.Create(l.Replace(' ', '-'))!).ToArray());

        using var req = Request(HttpMethod.Post, config, token, "/rest/api/2/issue");
        req.Content = new StringContent(new JsonObject { ["fields"] = fields }.ToJsonString(), Encoding.UTF8, "application/json");
        using var res = await http.SendAsync(req, ct);
        await EnsureOk(res, ct);
        var body = await res.Content.ReadFromJsonAsync<JsonObject>(ct);
        var key = body?["key"]?.GetValue<string>() ?? throw new JiraException("Jira did not return an issue key.");
        return new JiraIssue(key, $"{config.BaseUrl}/browse/{Uri.EscapeDataString(key)}");
    }

    private static HttpRequestMessage Request(HttpMethod method, JiraConfig config, string token, string path)
    {
        var req = new HttpRequestMessage(method, config.BaseUrl + path);
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        req.Headers.Authorization = config.Auth == "bearer"
            ? new AuthenticationHeaderValue("Bearer", token)
            : new AuthenticationHeaderValue("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes($"{config.Email}:{token}")));
        return req;
    }

    private static async Task EnsureOk(HttpResponseMessage res, CancellationToken ct)
    {
        if (res.IsSuccessStatusCode) return;
        var text = await res.Content.ReadAsStringAsync(ct);
        string detail;
        try
        {
            // Jira: {"errorMessages":[...],"errors":{"field":"message"}}
            var o = JsonNode.Parse(text) as JsonObject;
            var parts = new List<string>();
            if (o?["errorMessages"] is JsonArray m) parts.AddRange(m.Select(x => x?.GetValue<string>() ?? ""));
            if (o?["errors"] is JsonObject e) parts.AddRange(e.Select(kv => $"{kv.Key}: {kv.Value}"));
            detail = parts.Count > 0 ? string.Join("; ", parts.Where(p => p.Length > 0)) : $"HTTP {(int)res.StatusCode}";
        }
        catch (JsonException)
        {
            detail = $"HTTP {(int)res.StatusCode}";
        }
        throw new JiraException(detail, (int)res.StatusCode);
    }
}
