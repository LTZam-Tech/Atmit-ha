using System.Security.Cryptography;
using Atimtha.Api.Identity;
using Atimtha.Api.Infrastructure;
using Atimtha.Api.Workspaces;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.Execution;

using Api = Atimtha.Api.Infrastructure.Api;

public sealed record EvidenceDto(Guid Id, string Kind, string Name, string ContentType, long SizeBytes, DateTimeOffset CreatedAt, DateTimeOffset? ExpiresAt);

/// <summary>
/// Agent upload: POST /api/agent/v1/jobs/{executionId}/results/{resultId}/evidence?kind=screenshot&amp;name=…, raw body.
/// People: GET /api/v1/evidence/{id} (evidence.view in the project's workspace).
/// </summary>
public static class EvidenceEndpoints
{
    public const long MaxBytes = 50L * 1024 * 1024;
    public const int MaxPerResult = 20;

    /// <summary>content types an agent may upload, per kind; images are the only ones ever shown inline</summary>
    private static readonly Dictionary<EvidenceKind, string[]> Allowed = new()
    {
        [EvidenceKind.Screenshot] = ["image/png", "image/jpeg", "image/webp"],
        [EvidenceKind.Video] = ["video/webm", "video/mp4"],
        [EvidenceKind.Trace] = ["application/zip"],
        [EvidenceKind.Log] = ["text/plain"],
        [EvidenceKind.Har] = ["application/json"],
        [EvidenceKind.Other] = ["text/plain", "application/json", "application/octet-stream"],
    };

    private static readonly string[] Inline = ["image/png", "image/jpeg", "image/webp"];

    public static void MapEvidence(this IEndpointRouteBuilder app, RouteGroupBuilder api)
    {
        api.MapGet("/evidence/{evidenceId:guid}", Download).WithTags("Evidence").RequireAuthorization(Permissions.Policy(Permissions.EvidenceView));
        app.MapPost("/api/agent/v1/jobs/{executionId:guid}/results/{resultId:guid}/evidence", Upload)
            .WithTags("Agent protocol").RequireAuthorization(AgentEndpoints.AgentPolicy)
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(MaxBytes));
    }

    internal static EvidenceDto ToDto(Evidence e) =>
        new(e.Id, ExecutionEndpoints.Snake(e.Kind.ToString()), e.Name, e.ContentType, e.SizeBytes, e.CreatedAt, e.ExpiresAt);

    private static async Task<IResult> Upload(Guid executionId, Guid resultId, string? kind, string? name, HttpContext http, AtimthaDbContext db,
        IEvidenceStore store, Identity.OrganizationSettings settings, CancellationToken ct)
    {
        if (AgentAuthenticationHandler.AgentId(http.User) is not { } agentId) return Results.Unauthorized();
        var run = await db.Executions.AsNoTracking().FirstOrDefaultAsync(e => e.Id == executionId, ct);
        // only the agent that claimed the job may attach evidence to it
        if (run is null || run.AgentId != agentId || !AgentAuthenticationHandler.MayReport(http.User, executionId)) return Api.NotFound("The job");
        var result = await db.Results.AsNoTracking().FirstOrDefaultAsync(r => r.Id == resultId && r.ExecutionId == executionId, ct);
        if (result is null) return Api.NotFound("The result");

        if (!Enum.TryParse<EvidenceKind>(kind?.Replace("_", ""), ignoreCase: true, out var k))
            return Results.ValidationProblem(new Dictionary<string, string[]> { ["kind"] = ["Use screenshot, video, trace, log, har or other."] });
        var contentType = (http.Request.ContentType ?? "").Split(';')[0].Trim().ToLowerInvariant();
        if (!Allowed[k].Contains(contentType))
            return Results.Problem(statusCode: StatusCodes.Status415UnsupportedMediaType, title: "Unsupported media type",
                detail: $"A {kind} must be one of: {string.Join(", ", Allowed[k])}.");
        if (http.Request.ContentLength is > MaxBytes) return Results.Problem(statusCode: 413, title: "Too large", detail: $"At most {MaxBytes / 1024 / 1024} MB per file.");
        if (await db.Evidence.CountAsync(e => e.TestResultId == resultId, ct) >= MaxPerResult)
            return Api.Conflict($"A result keeps at most {MaxPerResult} files.");

        using var buffer = new MemoryStream();
        await http.Request.Body.CopyToAsync(buffer, ct);
        if (buffer.Length > MaxBytes) return Results.Problem(statusCode: 413, title: "Too large", detail: $"At most {MaxBytes / 1024 / 1024} MB per file.");
        var bytes = buffer.ToArray();

        var id = Guid.NewGuid();
        var objectKey = $"{run.OrganizationId}/{run.Id}/{id}";
        await store.PutAsync(objectKey, bytes, ct);
        var days = await settings.EvidenceRetentionDaysAsync(run.OrganizationId, ct);
        var row = db.Evidence.Add(new Evidence
        {
            Id = id, OrganizationId = run.OrganizationId, TestResultId = resultId, Kind = k,
            Name = SafeName(name, k), ObjectKey = objectKey, ContentType = contentType, SizeBytes = bytes.LongLength,
            Sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)), CreatedAt = DateTimeOffset.UtcNow, ExpiresAt = DateTimeOffset.UtcNow.AddDays(days),
        }).Entity;
        try { await db.SaveChangesAsync(ct); }
        catch
        {
            await store.DeleteAsync(objectKey, CancellationToken.None);   // no orphaned files
            throw;
        }
        return Results.Created($"/api/v1/evidence/{id}", ToDto(row));
    }

    private static async Task<IResult> Download(Guid evidenceId, HttpContext http, AtimthaDbContext db, AccessService access, IEvidenceStore store, CancellationToken ct)
    {
        var e = await db.Evidence.AsNoTracking().FirstOrDefaultAsync(x => x.Id == evidenceId, ct);
        if (e is null) return Api.NotFound("The file");
        var projectId = await (from r in db.Results.AsNoTracking() join x in db.Executions.AsNoTracking() on r.ExecutionId equals x.Id
                               where r.Id == e.TestResultId select x.ProjectId).FirstOrDefaultAsync(ct);
        var project = await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct);
        if (project is null || !await access.HasInWorkspaceAsync(Permissions.EvidenceView, project.WorkspaceId, ct)) return Api.NotFound("The file");

        var bytes = await store.GetAsync(e.ObjectKey, ct);
        if (bytes is null) return Results.Problem(statusCode: StatusCodes.Status410Gone, title: "Gone", detail: "The file is no longer kept.");
        http.Response.Headers.XContentTypeOptions = "nosniff";
        http.Response.Headers.CacheControl = "private, max-age=300";
        http.Response.Headers.ContentSecurityPolicy = "default-src 'none'; img-src 'self'; media-src 'self'; sandbox";
        var inline = Inline.Contains(e.ContentType) || e.ContentType.StartsWith("video/", StringComparison.Ordinal);
        return Results.File(bytes, inline ? e.ContentType : "application/octet-stream", inline ? null : e.Name);
    }

    private static string SafeName(string? name, EvidenceKind kind)
    {
        var n = new string((name ?? "").Where(c => char.IsLetterOrDigit(c) || c is '.' or '-' or '_' or ' ').ToArray()).Trim();
        if (n.Length == 0) n = ExecutionEndpoints.Snake(kind.ToString());
        return n.Length > 120 ? n[..120] : n;
    }
}
