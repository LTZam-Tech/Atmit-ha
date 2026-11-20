using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Atimtha.Api.Infrastructure;

namespace Atimtha.Api.TestAssets;

using Api = Atimtha.Api.Infrastructure.Api;

/// <summary>
/// Imports a 0.1.0 project snapshot (contracts/project-snapshot.schema.json) into the platform tables (backlog §5
/// "migration utilities for existing YAML/JSON projects"). Structural checks happen here; the engine's own validator
/// stays the authority for step semantics (ADR-0014). Every asset also gets version 1 with its original content, so
/// the project exports back as the same YAML.
/// </summary>
public sealed partial class SnapshotImporter(AtimthaDbContext db, Guid organizationId, Guid workspaceId, Guid? userId)
{
    public const string Contract = "atimtha.project/1";
    private static readonly string[] StrategyKeys = ["testid", "role", "name", "exact", "label", "placeholder", "text", "alt", "title", "id", "css", "xpath"];
    private static readonly HashSet<string> ReservedRowKeys = ["id", "title", "type", "outcome", "tags", "skip"];

    [GeneratedRegex(@"^\s*([a-zA-Z][\w]*)\.([a-zA-Z][\w]*)\s*(?:\((.*)\))?\s*$")]
    private static partial Regex ElementRef();

    [GeneratedRegex(@",(?![^{]*\}\})")]
    private static partial Regex ParamSplit();

    public List<string> Problems { get; } = [];

    private readonly DateTimeOffset now = DateTimeOffset.UtcNow;
    private readonly Dictionary<string, Guid> users = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Guid> pages = new(StringComparer.Ordinal);
    private readonly Dictionary<(string Page, string Element), Guid> elements = [];
    private readonly Dictionary<string, Guid> cases = new(StringComparer.Ordinal);
    private readonly Dictionary<(Guid Case, string Row), Guid> rows = [];
    private readonly Dictionary<string, Guid> flows = new(StringComparer.Ordinal);

    // Rows are saved in dependency phases (1 project → 7 versions): the context does not model these foreign keys,
    // and pages and elements reference each other, so one SaveChanges could insert a row before its parent.
    private readonly List<object>[] staged = Enumerable.Range(0, 9).Select(_ => new List<object>()).ToArray();
    private readonly List<Action>[] later = Enumerable.Range(0, 9).Select(_ => new List<Action>()).ToArray();

    private void Stage(int phase, object entity) => staged[phase].Add(entity);
    private void Later(int phase, Action update) => later[phase].Add(update);

    /// <summary>Saves the import in phases, inside the caller's transaction.</summary>
    public async Task PersistAsync(CancellationToken ct)
    {
        for (var phase = 1; phase < staged.Length; phase++)
        {
            foreach (var update in later[phase]) update();
            foreach (var entity in staged[phase]) db.Add(entity);
            await db.SaveChangesAsync(ct);
        }
    }

    /// <summary>Builds every row (nothing is saved — see PersistAsync); returns the project, or null with Problems filled.</summary>
    public Project? Import(JsonObject snapshot)
    {
        if (Str(snapshot["contract"]) != Contract) { Problems.Add($"contract must be \"{Contract}\""); return null; }
        var key = Str(snapshot["key"]) ?? "";
        if (!Api.KeyPattern().IsMatch(key)) { Problems.Add("key: use lowercase letters, digits and \"-\""); return null; }
        if (snapshot["app"] is not JsonObject app) { Problems.Add("app is missing"); return null; }

        var project = ImportProject(key, app);
        ImportEnvironments(project, app);
        ImportUsers(project, app);
        ImportMessages(project, snapshot["messages"] as JsonObject);
        var pageNodes = snapshot["pages"] as JsonObject ?? [];
        ImportPages(project, pageNodes);
        ImportNavigation(project, snapshot["navigation"] as JsonObject);
        ImportLogin(project, app["login"] as JsonObject);
        var caseNodes = snapshot["cases"] as JsonObject ?? [];
        ImportCases(project, caseNodes);
        var flowNodes = snapshot["flows"] as JsonObject ?? [];
        ImportFlows(project, flowNodes);
        ImportSuites(project, snapshot["suites"] as JsonObject);

        // version 1 of everything, in the 0.1.0 shape
        Version(project, AssetType.Project, project.Id, app);
        Version(project, AssetType.Messages, project.Id, snapshot["messages"] ?? new JsonObject());
        Version(project, AssetType.Navigation, project.Id, snapshot["navigation"] ?? new JsonObject { ["edges"] = new JsonArray() });
        Version(project, AssetType.RunSuite, project.Id, snapshot["suites"] ?? new JsonObject());
        foreach (var (pageKey, node) in pageNodes) if (pages.TryGetValue(pageKey, out var id)) Version(project, AssetType.Page, id, node!);
        foreach (var (caseKey, node) in caseNodes) if (cases.TryGetValue(caseKey, out var id)) Version(project, AssetType.TestCase, id, node!);
        foreach (var (flowKey, node) in flowNodes) if (flows.TryGetValue(flowKey, out var id)) Version(project, AssetType.Workflow, id, node!);
        return Problems.Count == 0 ? project : null;
    }

    // ---------------------------------------------------------------- project

    private Project ImportProject(string key, JsonObject app)
    {
        var run = app["run"] as JsonObject;
        var project = new Project
        {
            Id = Guid.NewGuid(), OrganizationId = organizationId, WorkspaceId = workspaceId, Key = key,
            Name = Str(app["name"]) ?? key,
            Description = Str(app["description"]),
            TestIdAttribute = Str(app["testIdAttribute"]) ?? "data-testid",
            Languages = Strings(app["languages"]) is { Length: > 0 } l ? l : ["en"],
            RunWorkers = Short(run?["workers"]), RunRetries = Short(run?["retries"]),
            RunTestTimeoutS = Short(run?["testTimeout"]), RunWaitTimeoutS = Short(run?["waitTimeout"]),
            HealingPolicy = Str(run?["healing"]) switch { "flag" => HealingPolicy.Flag, "off" => HealingPolicy.Off, _ => HealingPolicy.Pass },
            CreatedBy = userId, CreatedAt = now, UpdatedAt = now,
        };
        Stage(1, project);
        return project;
    }

    private void ImportEnvironments(Project project, JsonObject app)
    {
        if (app["environments"] is not JsonObject envs || envs.Count == 0) { Problems.Add("app.environments: at least one environment is required"); return; }
        var defaultKey = Str(app["defaultEnv"]) ?? envs.First().Key;
        foreach (var (key, node) in envs)
        {
            if (node is not JsonObject e || Str(e["baseURL"]) is not { } url) { Problems.Add($"environment {key}: baseURL is required"); continue; }
            Stage(2, new ProjectEnvironment
            {
                Id = Guid.NewGuid(), OrganizationId = organizationId, ProjectId = project.Id, Key = key, BaseUrl = url,
                IsDefault = key == defaultKey,
                StartDemoApp = Bool(e["startDemoApp"]), IgnoreHttpsErrors = Bool(e["ignoreHTTPSErrors"]),
                HttpUsername = Str((e["httpCredentials"] as JsonObject)?["username"]),
            });
        }
    }

    private void ImportUsers(Project project, JsonObject app)
    {
        foreach (var (key, node) in app["users"] as JsonObject ?? [])
        {
            if (node is not JsonObject u || Str(u["username"]) is not { } username) { Problems.Add($"user {key}: username is required"); continue; }
            var user = new TestUser { Id = Guid.NewGuid(), OrganizationId = organizationId, ProjectId = project.Id, Key = key, Username = username, Description = Str(u["description"]) };
            users[key] = user.Id;
            Stage(2, user);
        }
    }

    private void ImportMessages(Project project, JsonObject? messages)
    {
        foreach (var (locale, node) in messages ?? [])
        {
            if (locale is not ("en" or "ar")) { Problems.Add($"messages: unknown language \"{locale}\""); continue; }
            foreach (var (key, text) in node as JsonObject ?? [])
                Stage(2, new ExpectedMessage { Id = Guid.NewGuid(), OrganizationId = organizationId, ProjectId = project.Id, Locale = locale, Key = key, Text = Str(text) ?? "" });
        }
    }

    // ---------------------------------------------------------------- pages and elements

    private void ImportPages(Project project, JsonObject pageNodes)
    {
        var pending = new List<(Page Page, string? ReadyWhen, List<(Element Element, string? Within)> Elements)>();
        foreach (var (pageKey, node) in pageNodes)
        {
            if (node is not JsonObject p || Str(p["page"]) != pageKey) { Problems.Add($"page {pageKey}: \"page\" must equal its key"); continue; }
            var auth = Str(p["auth"]);
            var page = new Page
            {
                Id = Guid.NewGuid(), OrganizationId = organizationId, ProjectId = project.Id, Key = pageKey,
                Url = Str(p["url"]),
                OpenMode = Str(p["open"]) == "navigate" ? PageOpenMode.Navigate : PageOpenMode.Url,
                Description = Str(p["description"]),
                AuthLoggedOut = auth == "none",
                AuthUserId = auth is not null and not "none" && users.TryGetValue(auth, out var uid) ? uid : null,
                Tags = Strings(p["tags"]),
                Settings = (p["settings"] as JsonObject)?.ToJsonString() ?? "{}",
                UpdatedAt = now,
            };
            if (auth is not null and not "none" && page.AuthUserId is null) Problems.Add($"page {pageKey}: auth user \"{auth}\" is not defined");
            pages[pageKey] = page.Id;
            Stage(3, page);   // after the test users it may sign in as

            var defaultStrategy = Str((p["settings"] as JsonObject)?["defaultStrategy"]) ?? "testid";
            var list = new List<(Element, string?)>();
            var position = 0;
            foreach (var (elKey, elNode) in p["elements"] as JsonObject ?? [])
            {
                var el = new Element { Id = Guid.NewGuid(), OrganizationId = organizationId, PageId = page.Id, Key = elKey, Position = position++ };
                string? within = null;
                if (elNode is JsonValue v && v.TryGetValue<string>(out var shorthand))
                {
                    el.Strategy = new JsonObject { [defaultStrategy] = shorthand }.ToJsonString();
                }
                else if (elNode is JsonObject d)
                {
                    el.Strategy = Pick(d, StrategyKeys).ToJsonString();
                    within = Str(d["within"]);
                    el.Frame = Str(d["frame"]);
                    el.Nth = d["nth"] is JsonValue nv && nv.TryGetValue<int>(out var nth) ? nth : null;
                    el.HasText = d["hasText"]?.ToJsonString();
                    el.Control = Str(d["control"]);
                    el.Semantic = Str(d["semantic"]);
                    el.Rules = d["rules"]?.ToJsonString();
                    el.Format = Str(d["format"]);
                    el.Options = d["options"] is JsonArray ? Strings(d["options"]) : null;
                    el.Href = Str(d["href"]);
                    el.NewTab = d["newTab"] is JsonValue tv && tv.TryGetValue<bool>(out var nt) ? nt : null;
                    el.Messages = d["messages"] is JsonArray ? Strings(d["messages"]) : null;
                    el.Description = Str(d["description"]);
                    var fallbackPosition = 1;
                    foreach (var fb in d["fallback"] as JsonArray ?? [])
                    {
                        if (fb is JsonObject f)
                            Stage(5, new LocatorFallback { Id = Guid.NewGuid(), OrganizationId = organizationId, ElementId = el.Id, Position = fallbackPosition++, Strategy = f.ToJsonString() });
                    }
                }
                else { Problems.Add($"page {pageKey}, element {elKey}: must be a string or an object"); continue; }
                elements[(pageKey, elKey)] = el.Id;
                Stage(4, el);
                list.Add((el, within));
            }
            pending.Add((page, Str(p["readyWhen"]), list));
        }

        // second pass: references between elements of the same page
        foreach (var (page, readyWhen, list) in pending)
        {
            if (readyWhen is not null)
            {
                if (elements.TryGetValue((page.Key, readyWhen), out var r)) Later(5, () => page.ReadyWhenElementId = r);
                else Problems.Add($"page {page.Key}: readyWhen \"{readyWhen}\" is not one of its elements");
            }
            foreach (var (el, within) in list)
            {
                if (within is null) continue;
                if (elements.TryGetValue((page.Key, within), out var w)) Later(5, () => el.WithinElementId = w);
                else Problems.Add($"page {page.Key}, element {el.Key}: within \"{within}\" is not on the page");
            }
        }
    }

    private void ImportNavigation(Project project, JsonObject? navigation)
    {
        var i = 0;
        foreach (var edge in navigation?["edges"] as JsonArray ?? [])
        {
            i++;
            var from = Str(edge?["from"]);
            var to = Str(edge?["to"]);
            if (from is null || to is null || !pages.TryGetValue(from, out var f) || !pages.TryGetValue(to, out var t)) { Problems.Add($"navigation edge {i}: unknown page"); continue; }
            Stage(5, new NavigationEdge { Id = Guid.NewGuid(), OrganizationId = organizationId, ProjectId = project.Id, FromPageId = f, ToPageId = t, Steps = edge!["steps"]?.ToJsonString() ?? "[]" });
        }
    }

    private void ImportLogin(Project project, JsonObject? login)
    {
        if (login is null) return;
        var pageKey = Str(login["page"]);
        var fields = login["fields"] as JsonObject;
        Guid? El(string? name) => pageKey is not null && name is not null && elements.TryGetValue((pageKey, name), out var id) ? id : null;
        var (u, p, s) = (El(Str(fields?["username"])), El(Str(fields?["password"])), El(Str(fields?["submit"])));
        if (pageKey is null || !pages.TryGetValue(pageKey, out var pageId) || u is null || p is null || s is null)
        {
            Problems.Add("app.login: page and its username / password / submit elements must exist");
            return;
        }
        var success = login["success"] as JsonObject;
        Stage(5, new LoginConfig
        {
            ProjectId = project.Id, OrganizationId = organizationId, PageId = pageId,
            UsernameElementId = u.Value, PasswordElementId = p.Value, SubmitElementId = s.Value,
            SuccessElementId = ElementOf(Str(success?["element"])),
            SuccessUrlContains = Str(success?["urlContains"]),
        });
    }

    // ---------------------------------------------------------------- cases, workflows, suites

    private void ImportCases(Project project, JsonObject caseNodes)
    {
        var pendingLinks = new List<(TestCase Case, string[] DependsOn, string? ContinueFrom)>();
        foreach (var (caseKey, node) in caseNodes)
        {
            if (node is not JsonObject c || Str(c["case"]) is not { } title) { Problems.Add($"case {caseKey}: \"case\" (its name) is required"); continue; }
            var startPage = Str(c["page"]);
            var user = Str(c["user"]);
            var tc = new TestCase
            {
                Id = Guid.NewGuid(), OrganizationId = organizationId, ProjectId = project.Id, Key = caseKey,
                Engine = Str(c["engine"]) == "api" ? "api" : "web",
                Title = title, Description = Str(c["description"]), Module = Str(c["module"]),
                CaseType = Str(c["type"]) switch { "positive" => CaseType.Positive, "negative" => CaseType.Negative, _ => null },
                StartPageId = startPage is not null && pages.TryGetValue(startPage, out var sp) ? sp : null,
                StartUrl = Str(c["url"]),
                StartLoggedOut = user == "none",
                StartUserId = user is not null and not "none" && users.TryGetValue(user, out var su) ? su : null,
                Tags = Strings(c["tags"]),
                ContinueFromRowKey = Str((c["continueFrom"] as JsonObject)?["row"]),
                CreatedBy = userId, UpdatedAt = now,
            };
            if (startPage is not null && tc.StartPageId is null) Problems.Add($"case {caseKey}: page \"{startPage}\" is not defined");
            if (user is not null and not "none" && tc.StartUserId is null) Problems.Add($"case {caseKey}: user \"{user}\" is not defined");
            cases[caseKey] = tc.Id;
            Stage(6, tc);

            ImportSteps(tc, "", c["steps"] as JsonArray, caseKey);
            foreach (var (outcome, list) in c["outcomes"] as JsonObject ?? [])
            {
                if (string.IsNullOrEmpty(outcome)) { Problems.Add($"case {caseKey}: an outcome needs a name"); continue; }
                ImportSteps(tc, outcome, list as JsonArray, caseKey);
            }
            ImportRows(tc, c["data"] as JsonArray, caseKey);
            pendingLinks.Add((tc, Strings(c["dependsOn"]), Str((c["continueFrom"] as JsonObject)?["case"])));
        }

        foreach (var (tc, dependsOn, continueFrom) in pendingLinks)
        {
            foreach (var d in dependsOn)
            {
                if (cases.TryGetValue(d, out var dep) && dep != tc.Id) Stage(7, new CaseDependency { OrganizationId = organizationId, CaseId = tc.Id, DependsOnCaseId = dep });
                else Problems.Add($"case {tc.Key}: dependsOn \"{d}\" is not a case");
            }
            if (continueFrom is not null)
            {
                if (cases.TryGetValue(continueFrom, out var cf)) Later(7, () => tc.ContinueFromCaseId = cf);
                else Problems.Add($"case {tc.Key}: continueFrom \"{continueFrom}\" is not a case");
            }
        }
    }

    private void ImportSteps(TestCase tc, string outcome, JsonArray? steps, string caseKey)
    {
        var position = 0;
        foreach (var node in steps ?? [])
        {
            var where = $"case {caseKey}, {(outcome == "" ? "step" : $"outcome {outcome} step")} {position + 1}";
            if (node is not JsonObject step) { Problems.Add($"{where}: a step must be an object"); position++; continue; }
            var actions = step.Select(kv => kv.Key).Where(k => k != "name").ToList();
            if (actions.Count != 1) { Problems.Add($"{where}: a step needs exactly one action"); position++; continue; }
            var action = actions[0];
            var body = step[action];
            var refText = body is JsonValue bv && bv.TryGetValue<string>(out var s) ? s : Str((body as JsonObject)?["element"]);
            Guid? elementId = null;
            string? elementParams = null;
            if (refText is not null && ElementRef().Match(refText) is { Success: true } m)
            {
                if (elements.TryGetValue((m.Groups[1].Value, m.Groups[2].Value), out var id)) elementId = id;
                else if (pages.ContainsKey(m.Groups[1].Value)) Problems.Add($"{where}: element \"{m.Groups[1].Value}.{m.Groups[2].Value}\" not found");
                if (m.Groups[3].Success && m.Groups[3].Value.Trim().Length > 0)
                {
                    var parameters = new JsonObject();
                    foreach (var part in ParamSplit().Split(m.Groups[3].Value))
                    {
                        var eq = part.IndexOf('=');
                        if (eq > 0) parameters[part[..eq].Trim()] = part[(eq + 1)..].Trim();
                    }
                    elementParams = parameters.ToJsonString();
                }
            }
            Stage(7, new TestStep
            {
                Id = Guid.NewGuid(), OrganizationId = organizationId, CaseId = tc.Id, Outcome = outcome, Position = position++,
                Action = action, ElementId = elementId, ElementParams = elementParams, Body = step.ToJsonString(), Name = Str(step["name"]),
            });
        }
    }

    private void ImportRows(TestCase tc, JsonArray? data, string caseKey)
    {
        var position = 0;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in data ?? [])
        {
            if (node is not JsonObject r) { Problems.Add($"case {caseKey}: data row {position + 1} must be an object"); position++; continue; }
            var key = Str(r["id"]) ?? $"ROW-{position + 1:000}";
            if (!seen.Add(key)) { Problems.Add($"case {caseKey}: data row id \"{key}\" is repeated"); position++; continue; }
            var fields = new JsonObject();
            foreach (var (k, v) in r) if (!ReservedRowKeys.Contains(k)) fields[k] = v?.DeepClone();
            var row = new DataRow
            {
                Id = Guid.NewGuid(), OrganizationId = organizationId, CaseId = tc.Id, Key = key, Position = position++,
                Title = Str(r["title"]),
                RowType = Str(r["type"]) switch { "positive" => CaseType.Positive, "negative" => CaseType.Negative, _ => null },
                Outcome = Str(r["outcome"]), Tags = Strings(r["tags"]), Skip = Bool(r["skip"]), Fields = fields.ToJsonString(),
            };
            rows[(tc.Id, key)] = row.Id;
            Stage(7, row);
        }
    }

    private void ImportFlows(Project project, JsonObject flowNodes)
    {
        foreach (var (flowKey, node) in flowNodes)
        {
            if (node is not JsonObject f || Str(f["flow"]) is not { } title) { Problems.Add($"workflow {flowKey}: \"flow\" (its name) is required"); continue; }
            var wf = new Workflow { Id = Guid.NewGuid(), OrganizationId = organizationId, ProjectId = project.Id, Key = flowKey, Title = title, Description = Str(f["description"]), Module = Str(f["module"]), Tags = Strings(f["tags"]) };
            Stage(7, wf); flows[flowKey] = wf.Id;
            var position = 1;
            foreach (var stepNode in f["steps"] as JsonArray ?? [])
            {
                var caseKey = Str(stepNode?["case"])?.Replace(".case.yml", "");
                if (caseKey is null || !cases.TryGetValue(caseKey, out var caseId)) { Problems.Add($"workflow {flowKey}, step {position}: case \"{caseKey}\" not found"); position++; continue; }
                var rowKey = Str(stepNode?["row"]);
                var asUser = Str(stepNode?["as"]);
                Guid? rowId = rowKey is not null && rows.TryGetValue((caseId, rowKey), out var rid) ? rid : null;
                if (rowKey is not null && rowId is null) Problems.Add($"workflow {flowKey}, step {position}: row \"{rowKey}\" not found");
                Stage(8, new WorkflowStep
                {
                    Id = Guid.NewGuid(), OrganizationId = organizationId, WorkflowId = wf.Id, Position = position++,
                    CaseId = caseId, DataRowId = rowId,
                    RunAsUserId = asUser is not null and not "none" && users.TryGetValue(asUser, out var au) ? au : null,
                    StartMode = Str(stepNode?["start"]) switch { "open" => WorkflowStart.Open, "continue" => WorkflowStart.Continue, _ => null },
                });
            }
        }
    }

    private void ImportSuites(Project project, JsonObject? suitesFile)
    {
        foreach (var (name, node) in suitesFile?["suites"] as JsonObject ?? [])
        {
            var s = node as JsonObject;
            var suite = new RunSuite { Id = Guid.NewGuid(), OrganizationId = organizationId, ProjectId = project.Id, Key = name, Description = Str(s?["description"]), Modules = Strings(s?["modules"]), Tags = Strings(s?["tags"]) };
            Stage(7, suite);
            foreach (var c in Strings(s?["cases"]))
            {
                if (cases.TryGetValue(c, out var caseId)) Stage(8, new RunSuiteCase { OrganizationId = organizationId, SuiteId = suite.Id, CaseId = caseId });
                else Problems.Add($"suite {name}: case \"{c}\" not found");
            }
        }
    }

    // ---------------------------------------------------------------- helpers

    private void Version(Project project, AssetType type, Guid assetId, JsonNode content)
    {
        var json = content.ToJsonString();
        Stage(8, new AssetVersion
        {
            Id = Guid.NewGuid(), OrganizationId = organizationId, ProjectId = project.Id, AssetType = type, AssetId = assetId,
            Version = 1, Content = json, ContentSha256 = Sha256(json), CreatedBy = userId, CreatedAt = now,
        });
    }

    private Guid? ElementOf(string? reference)
    {
        if (reference is null || ElementRef().Match(reference) is not { Success: true } m) return null;
        return elements.TryGetValue((m.Groups[1].Value, m.Groups[2].Value), out var id) ? id : null;
    }

    private static JsonObject Pick(JsonObject source, IEnumerable<string> keys)
    {
        var o = new JsonObject();
        foreach (var k in keys) if (source[k] is { } v) o[k] = v.DeepClone();
        return o;
    }

    internal static string Sha256(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();

    internal static string? Str(JsonNode? n) => n is JsonValue v && v.GetValueKind() == JsonValueKind.String ? v.GetValue<string>() : n is JsonValue x && x.GetValueKind() is JsonValueKind.Number ? x.ToJsonString() : null;

    internal static string[] Strings(JsonNode? n) => n is JsonArray a ? a.Select(Str).Where(s => s is not null).Select(s => s!).ToArray() : [];

    private static bool Bool(JsonNode? n) => n is JsonValue v && v.GetValueKind() == JsonValueKind.True;

    private static short? Short(JsonNode? n) => n is JsonValue v && v.TryGetValue<double>(out var d) && d is >= short.MinValue and <= short.MaxValue ? (short)d : null;
}
