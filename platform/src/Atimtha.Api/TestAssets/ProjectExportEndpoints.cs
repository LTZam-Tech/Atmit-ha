using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Atimtha.Api.Identity;
using Atimtha.Api.Infrastructure;
using Atimtha.Api.Workspaces;

namespace Atimtha.Api.TestAssets;

using Api = Atimtha.Api.Infrastructure.Api;

/// <summary>
/// GET /api/v1/projects/{id}/download.zip (backlog §14 Git integration): the project in the 0.1.0 folder layout,
/// apps/&lt;key&gt;/…, ready to unzip into a framework checkout and commit. The platform never runs git itself and never
/// holds Git credentials. Files are JSON, which every YAML parser reads (YAML 1.2 is a superset of JSON).
/// No passwords: test users and environments carry secret references only.
/// </summary>
public static partial class ProjectExportEndpoints
{
    [GeneratedRegex("^[a-zA-Z0-9][a-zA-Z0-9._-]{0,149}$")]
    private static partial Regex SafeName();

    private static readonly JsonSerializerOptions Pretty = new() { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public static RouteGroupBuilder MapProjectExport(this RouteGroupBuilder api)
    {
        api.MapGet("/projects/{projectId:guid}/download.zip", Download).WithTags("Test assets").RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        return api;
    }

    private static async Task<IResult> Download(Guid projectId, AtimthaDbContext db, AccessService access, AuditWriter audit, CancellationToken ct)
    {
        var project = await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct);
        if (project is null) return Api.NotFound("The project");
        var snapshot = await SnapshotExporter.BuildAsync(db, projectId, ct);
        if (snapshot is null) return Api.NotFound("The project");

        var key = project.Key;
        using var buffer = new MemoryStream();
        using (var zip = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            void Write(string path, JsonNode? content, string header)
            {
                if (content is null) return;
                var entry = zip.CreateEntry($"apps/{key}/{path}", CompressionLevel.Optimal);
                using var w = new StreamWriter(entry.Open(), new UTF8Encoding(false));
                w.Write($"# {header} — exported from the Atimtha platform {DateTimeOffset.UtcNow:yyyy-MM-dd HH:mm} UTC\n");
                w.Write(content.ToJsonString(Pretty));
                w.Write('\n');
            }

            var app = snapshot["app"]?.DeepClone() as JsonObject ?? new JsonObject();
            app.Remove("branding");   // report profiles live in branding/profiles.yml of the framework, not in the project
            Write("app.yml", app, "Project settings");
            if (snapshot["messages"] is JsonObject { Count: > 0 } messages) Write("messages.yml", messages, "Expected UI messages");
            if (snapshot["navigation"] is JsonObject navigation) Write("navigation.yml", navigation, "Navigation map");
            if (snapshot["suites"] is JsonObject suites) Write("suites.yml", suites, "Run suites");
            foreach (var (name, page) in snapshot["pages"] as JsonObject ?? [])
                if (SafeName().IsMatch(name)) Write($"or/{name}.page.yml", page, $"Page {name}");
            foreach (var (name, c) in snapshot["cases"] as JsonObject ?? [])
                if (SafeName().IsMatch(name)) Write($"cases/{name}.case.yml", c, $"Test case {name}");
            foreach (var (name, f) in snapshot["flows"] as JsonObject ?? [])
                if (SafeName().IsMatch(name)) Write($"flows/{name}.flow.yml", f, $"Workflow {name}");
            var readme = zip.CreateEntry($"apps/{key}/secrets.example.yml");
            using (var w = new StreamWriter(readme.Open(), new UTF8Encoding(false)))
                w.Write("# Passwords are not exported. To run locally, copy this file to secrets.yml (git-ignored) and fill in:\n# users:\n#   <user key>: { password: \"...\" }\n");
        }
        audit.Add("project.download", "project", projectId, new { project = key });
        await db.SaveChangesAsync(ct);
        return Results.File(buffer.ToArray(), "application/zip", $"atimtha-{key}-{DateTimeOffset.UtcNow:yyyyMMdd-HHmm}.zip");
    }
}
