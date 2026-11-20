using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Atimtha.Api.Identity;
using Atimtha.Api.Infrastructure;
using Atimtha.Api.Workspaces;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.Execution;

using Api = Atimtha.Api.Infrastructure.Api;

public sealed class ExecutionArtifact
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public Guid ExecutionId { get; set; }
    public string Kind { get; set; } = "report";
    public string Name { get; set; } = "";
    public string ObjectKey { get; set; } = "";
    public string ContentType { get; set; } = "";
    public long SizeBytes { get; set; }
    public string Sha256 { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? ExpiresAt { get; set; }
}

public sealed record ArtifactDto(Guid Id, string Kind, string Name, string ContentType, long SizeBytes, DateTimeOffset CreatedAt, DateTimeOffset? ExpiresAt);

/// <summary>
/// Run-level files (backlog §11): the agent uploads the Smart HTML report at the end of a job
/// (POST /api/agent/v1/jobs/{id}/artifacts?kind=report&amp;name=…); people list and download them, and export the run's
/// results as CSV or JSON. A report contains scripts, so it is always served as a download, never inline.
/// </summary>
public static class ArtifactEndpoints
{
    public const long MaxBytes = 100L * 1024 * 1024;
    private static readonly Dictionary<string, string[]> Allowed = new()
    {
        ["report"] = ["text/html"],
        ["log"] = ["text/plain"],
        ["other"] = ["application/json", "application/zip", "text/plain"],
    };

    public static void MapArtifacts(this IEndpointRouteBuilder app, RouteGroupBuilder api)
    {
        api.MapGet("/executions/{executionId:guid}/artifacts", List).WithTags("Reports").RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        api.MapGet("/artifacts/{artifactId:guid}", Download).WithTags("Reports").RequireAuthorization(Permissions.Policy(Permissions.EvidenceView));
        api.MapGet("/artifacts/{artifactId:guid}/zip", DownloadZip).WithTags("Reports").RequireAuthorization(Permissions.Policy(Permissions.EvidenceView));
        api.MapGet("/executions/{executionId:guid}/results.csv", Csv).WithTags("Reports").RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        app.MapPost("/api/agent/v1/jobs/{executionId:guid}/artifacts", Upload)
            .WithTags("Agent protocol").RequireAuthorization(AgentEndpoints.AgentPolicy)
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(MaxBytes));
    }

    private static ArtifactDto ToDto(ExecutionArtifact a) => new(a.Id, a.Kind, a.Name, a.ContentType, a.SizeBytes, a.CreatedAt, a.ExpiresAt);

    private static async Task<IResult> Upload(Guid executionId, string? kind, string? name, HttpContext http, AtimthaDbContext db, IEvidenceStore store,
        Identity.OrganizationSettings settings, CancellationToken ct)
    {
        if (AgentAuthenticationHandler.AgentId(http.User) is not { } agentId) return Results.Unauthorized();
        var run = await db.Executions.AsNoTracking().FirstOrDefaultAsync(e => e.Id == executionId, ct);
        if (run is null || run.AgentId != agentId || !AgentAuthenticationHandler.MayReport(http.User, executionId)) return Api.NotFound("The job");
        var k = kind ?? "report";
        if (!Allowed.TryGetValue(k, out var types)) return Results.ValidationProblem(new Dictionary<string, string[]> { ["kind"] = ["Use report, log or other."] });
        var contentType = (http.Request.ContentType ?? "").Split(';')[0].Trim().ToLowerInvariant();
        if (!types.Contains(contentType)) return Results.Problem(statusCode: 415, title: "Unsupported media type", detail: $"A {k} must be one of: {string.Join(", ", types)}.");
        if (await db.Artifacts.CountAsync(a => a.ExecutionId == executionId, ct) >= 10) return Api.Conflict("A run keeps at most 10 files.");

        using var buffer = new MemoryStream();
        await http.Request.Body.CopyToAsync(buffer, ct);
        if (buffer.Length is 0 or > MaxBytes) return Results.Problem(statusCode: 413, title: "Too large", detail: "At most 100 MB per file.");
        var bytes = buffer.ToArray();
        var id = Guid.NewGuid();
        var objectKey = $"{run.OrganizationId}/{run.Id}/{id}";
        await store.PutAsync(objectKey, bytes, ct);
        var days = await settings.EvidenceRetentionDaysAsync(run.OrganizationId, ct);
        var row = db.Artifacts.Add(new ExecutionArtifact
        {
            Id = id, OrganizationId = run.OrganizationId, ExecutionId = run.Id, Kind = k, Name = SafeName(name, k), ObjectKey = objectKey,
            ContentType = contentType, SizeBytes = bytes.LongLength, Sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)),
            CreatedAt = DateTimeOffset.UtcNow, ExpiresAt = DateTimeOffset.UtcNow.AddDays(days),
        }).Entity;
        try { await db.SaveChangesAsync(ct); }
        catch { await store.DeleteAsync(objectKey, CancellationToken.None); throw; }
        return Results.Created($"/api/v1/artifacts/{id}", ToDto(row));
    }

    private static async Task<IResult> List(Guid executionId, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        var run = await db.Executions.AsNoTracking().FirstOrDefaultAsync(e => e.Id == executionId, ct);
        if (run is null || await ProjectEndpoints.Visible(run.ProjectId, Permissions.ProjectView, db, access, ct) is null) return Api.NotFound("The run");
        // a sharded run: every shard's report
        var runIds = await Shards.RunIdsAsync(db, executionId, ct);
        var rows = await db.Artifacts.AsNoTracking().Where(a => runIds.Contains(a.ExecutionId)).OrderBy(a => a.CreatedAt).ToListAsync(ct);
        return Results.Ok(rows.Select(ToDto));
    }

    private static async Task<IResult> Download(Guid artifactId, HttpContext http, AtimthaDbContext db, AccessService access, IEvidenceStore store, CancellationToken ct)
    {
        var a = await db.Artifacts.AsNoTracking().FirstOrDefaultAsync(x => x.Id == artifactId, ct);
        if (a is null) return Api.NotFound("The file");
        var run = await db.Executions.AsNoTracking().FirstAsync(e => e.Id == a.ExecutionId, ct);
        var project = await ProjectEndpoints.Visible(run.ProjectId, Permissions.ProjectView, db, access, ct);
        if (project is null || !await access.HasInWorkspaceAsync(Permissions.EvidenceView, project.WorkspaceId, ct)) return Api.NotFound("The file");
        var bytes = await store.GetAsync(a.ObjectKey, ct);
        if (bytes is null) return Results.Problem(statusCode: StatusCodes.Status410Gone, title: "Gone", detail: "The file is no longer kept.");
        http.Response.Headers.XContentTypeOptions = "nosniff";
        http.Response.Headers.ContentSecurityPolicy = "default-src 'none'; sandbox";
        // always a download: an HTML report must never run inside the platform's origin
        return Results.File(bytes, "application/octet-stream", a.Name);
    }

    /// <summary>
    /// A code export (an "export" job uploads <c>{ files: { path: text }, warnings }</c> as JSON) downloaded as a ZIP of
    /// the standalone Playwright project. Paths are checked: relative, no "..", no drive or root.
    /// </summary>
    private static async Task<IResult> DownloadZip(Guid artifactId, HttpContext http, AtimthaDbContext db, AccessService access, IEvidenceStore store, CancellationToken ct)
    {
        var a = await db.Artifacts.AsNoTracking().FirstOrDefaultAsync(x => x.Id == artifactId, ct);
        if (a is null || a.ContentType != "application/json" || a.Name != ExportArtifactName) return Api.NotFound("The code export");
        var run = await db.Executions.AsNoTracking().FirstAsync(e => e.Id == a.ExecutionId, ct);
        var project = await ProjectEndpoints.Visible(run.ProjectId, Permissions.ProjectView, db, access, ct);
        if (project is null || !await access.HasInWorkspaceAsync(Permissions.EvidenceView, project.WorkspaceId, ct)) return Api.NotFound("The code export");
        var bytes = await store.GetAsync(a.ObjectKey, ct);
        if (bytes is null) return Results.Problem(statusCode: StatusCodes.Status410Gone, title: "Gone", detail: "The file is no longer kept.");

        System.Text.Json.Nodes.JsonObject? files;
        try { files = System.Text.Json.Nodes.JsonNode.Parse(bytes)?["files"] as System.Text.Json.Nodes.JsonObject; }
        catch (System.Text.Json.JsonException) { files = null; }
        if (files is null) return Api.Conflict("The code export is not readable.");

        var folder = $"{project.Key}-playwright";
        using var zip = new MemoryStream();
        using (var archive = new System.IO.Compression.ZipArchive(zip, System.IO.Compression.ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (path, node) in files)
            {
                var p = path.Replace('\\', '/');
                if (p.Length is 0 or > 300 || p.StartsWith('/') || p.Contains(':') || p.Split('/').Any(s => s is "" or "." or ".."))
                    return Api.Conflict($"The code export contains an unsafe path ({path}).");
                var entry = archive.CreateEntry($"{folder}/{p}", System.IO.Compression.CompressionLevel.Optimal);
                await using var w = new StreamWriter(entry.Open(), new UTF8Encoding(false));
                await w.WriteAsync(node?.GetValue<string>() ?? "");
            }
        }
        http.Response.Headers.XContentTypeOptions = "nosniff";
        return Results.File(zip.ToArray(), "application/zip", $"{folder}.zip");
    }

    /// <summary>the file an "export" job uploads; an "explore" job uploads <see cref="ExploreArtifactName"/></summary>
    public const string ExportArtifactName = "playwright-project.json";
    public const string ExploreArtifactName = "explore.json";

    /// <summary>The run's results as CSV (one line per test; spreadsheets open it as UTF-8 thanks to the BOM).</summary>
    private static async Task<IResult> Csv(Guid executionId, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        var run = await db.Executions.AsNoTracking().FirstOrDefaultAsync(e => e.Id == executionId, ct);
        if (run is null || await ProjectEndpoints.Visible(run.ProjectId, Permissions.ProjectView, db, access, ct) is null) return Api.NotFound("The run");
        var runIds = await Shards.RunIdsAsync(db, executionId, ct);
        var results = await db.Results.AsNoTracking().Where(r => runIds.Contains(r.ExecutionId)).OrderBy(r => r.Module).ThenBy(r => r.Title).ToListAsync(ct);
        var caseKeys = await db.Cases.AsNoTracking().Where(c => c.ProjectId == run.ProjectId).ToDictionaryAsync(c => c.Id, c => c.Key, ct);
        var rowIds = results.Where(r => r.DataRowId != null).Select(r => r.DataRowId!.Value).ToList();
        var rowKeys = await db.DataRows.AsNoTracking().Where(r => rowIds.Contains(r.Id)).ToDictionaryAsync(r => r.Id, r => r.Key, ct);
        var healed = (await db.HealingEvents.AsNoTracking().Where(h => results.Select(r => r.Id).Contains(h.TestResultId)).Select(h => h.TestResultId).ToListAsync(ct)).ToHashSet();

        var sb = new StringBuilder("﻿");
        sb.AppendLine("module,title,case,row,status,flaky,healed,retries,category,duration_ms,error");
        foreach (var r in results)
        {
            string[] cells =
            [
                r.Module ?? "", r.Title, r.CaseId is { } c ? caseKeys.GetValueOrDefault(c, "") : "", r.DataRowId is { } d ? rowKeys.GetValueOrDefault(d, "") : "",
                ExecutionEndpoints.Snake(r.Status.ToString()), r.Flaky ? "yes" : "no", healed.Contains(r.Id) ? "yes" : "no", r.Retries.ToString(CultureInfo.InvariantCulture),
                r.Category is { } cat ? ExecutionEndpoints.Snake(cat.ToString()) : "", r.DurationMs?.ToString(CultureInfo.InvariantCulture) ?? "",
                (r.Error ?? "").Split('\n')[0],
            ];
            sb.AppendLine(string.Join(',', cells.Select(Cell)));
        }
        return Results.File(Encoding.UTF8.GetBytes(sb.ToString()), "text/csv; charset=utf-8", $"run-{run.Id.ToString()[..8]}.csv");
    }

    /// <summary>CSV cell: quoted when needed; a leading = + - @ is neutralised so a spreadsheet never runs it as a formula.</summary>
    internal static string Cell(string s)
    {
        if (s.Length > 0 && "=+-@\t\r".Contains(s[0])) s = "'" + s;
        return s.IndexOfAny([',', '"', '\n', '\r']) >= 0 ? "\"" + s.Replace("\"", "\"\"") + "\"" : s;
    }

    private static string SafeName(string? name, string kind)
    {
        var n = new string((name ?? "").Where(c => char.IsLetterOrDigit(c) || c is '.' or '-' or '_' or ' ').ToArray()).Trim();
        if (n.Length == 0) n = kind == "report" ? "smart-report.html" : kind;
        return n.Length > 120 ? n[..120] : n;
    }
}
