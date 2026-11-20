using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json.Nodes;
using System.Xml.Linq;
using Atimtha.Api.Execution;
using Atimtha.Api.Identity;
using Atimtha.Api.Infrastructure;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Atimtha.Api.Integrations;

using Api = Atimtha.Api.Infrastructure.Api;

public sealed class CiToken
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public Guid? ProjectId { get; set; }
    public string Name { get; set; } = "";
    public string TokenHash { get; set; } = "";
    public string TokenHint { get; set; } = "";
    public string[] Scopes { get; set; } = [CiScopes.Start, CiScopes.Read];
    public Guid? CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? ExpiresAt { get; set; }
    public DateTimeOffset? LastUsedAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
}

public static class CiScopes
{
    public const string Start = "runs.start";
    public const string Read = "runs.read";
    public static readonly string[] All = [Start, Read];
}

/// <summary>Pipelines sign in with <c>Authorization: AtimthaCI ctk_…</c>; only the token's SHA-256 is stored.</summary>
public sealed class CiTokenAuthenticationHandler(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public new const string Scheme = "AtimthaCI";
    public const string TokenClaim = "atimtha:ci_token";
    public const string OrgClaim = "atimtha:ci_org";
    public const string ProjectClaim = "atimtha:ci_project";
    public const string ScopeClaim = "atimtha:ci_scope";
    public const string TokenPrefix = "ctk_";

    private sealed class TokenRow
    {
        public Guid TokenId { get; set; }
        public Guid OrganizationId { get; set; }
        public Guid? ProjectId { get; set; }
        public string[] Scopes { get; set; } = [];
    }

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var header = Request.Headers.Authorization.ToString();
        if (!header.StartsWith(Scheme + " ", StringComparison.Ordinal)) return AuthenticateResult.NoResult();
        var token = header[(Scheme.Length + 1)..].Trim();
        if (!token.StartsWith(TokenPrefix, StringComparison.Ordinal) || token.Length > 200) return AuthenticateResult.Fail("Malformed CI token");

        var hash = Hash(token);
        var db = Context.RequestServices.GetRequiredService<AtimthaDbContext>();
        var row = await db.Database
            .SqlQuery<TokenRow>($"SELECT token_id AS \"TokenId\", organization_id AS \"OrganizationId\", project_id AS \"ProjectId\", scopes AS \"Scopes\" FROM atimtha.ci_token_by_hash({hash})")
            .FirstOrDefaultAsync(Context.RequestAborted);
        if (row is null) return AuthenticateResult.Fail("Unknown, expired or revoked CI token");

        var claims = new List<Claim> { new(TokenClaim, row.TokenId.ToString()), new(OrgClaim, row.OrganizationId.ToString()) };
        if (row.ProjectId is Guid p) claims.Add(new Claim(ProjectClaim, p.ToString()));
        claims.AddRange(row.Scopes.Select(s => new Claim(ScopeClaim, s)));
        return AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(new ClaimsIdentity(claims, Scheme)), Scheme));
    }

    public static string NewToken() => TokenPrefix + Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    public static string Hash(string token) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
    public static Guid? TokenId(ClaimsPrincipal user) => Guid.TryParse(user.FindFirstValue(TokenClaim), out var id) ? id : null;
    public static Guid? OrganizationId(ClaimsPrincipal user) => Guid.TryParse(user.FindFirstValue(OrgClaim), out var id) ? id : null;
    public static Guid? ProjectId(ClaimsPrincipal user) => Guid.TryParse(user.FindFirstValue(ProjectClaim), out var id) ? id : null;
}

public sealed record CiTokenDto(Guid Id, string Name, Guid? ProjectId, string[] Scopes, string Hint, DateTimeOffset CreatedAt, DateTimeOffset? ExpiresAt, DateTimeOffset? LastUsedAt, DateTimeOffset? RevokedAt);
public sealed record CreatedCiTokenDto(CiTokenDto Token, string Secret);
public sealed record CreateCiTokenRequest(string? Name, Guid? ProjectId, string[]? Scopes, int? ExpiresInDays);
public sealed record CiStartRequest(string? Environment, string? Engine, string? Suite, string[]? Tags, string[]? Cases, string? Locale, string[]? Flows = null, short? Shards = null);
public sealed record CiRunDto(Guid Id, string Project, string Environment, string Status, bool Finished, bool Passed, JsonNode? Counts, string? Error,
    DateTimeOffset QueuedAt, DateTimeOffset? FinishedAt, string? Url);

/// <summary>
/// Administration (/api/v1/ci-tokens, integration.manage) and the pipeline API (/api/ci/v1, CI token):
/// start a run, follow it, and download its results as JUnit XML for the CI server's own test report.
/// </summary>
public static class CiEndpoints
{
    public static readonly AuthorizationPolicy CiPolicy = new AuthorizationPolicyBuilder(CiTokenAuthenticationHandler.Scheme)
        .RequireClaim(CiTokenAuthenticationHandler.TokenClaim).Build();

    public static IEndpointRouteBuilder MapCi(this IEndpointRouteBuilder app, RouteGroupBuilder api)
    {
        var admin = api.MapGroup("/ci-tokens").WithTags("CI").RequireAuthorization(Permissions.Policy(Permissions.IntegrationManage));
        admin.MapGet("/", List);
        admin.MapPost("/", Create);
        admin.MapDelete("/{id:guid}", Revoke);

        var ci = app.MapGroup("/api/ci/v1").WithTags("CI pipeline API").RequireAuthorization(CiPolicy);
        ci.MapPost("/projects/{projectKey}/runs", Start);
        ci.MapGet("/runs/{executionId:guid}", Status);
        ci.MapGet("/runs/{executionId:guid}/junit", Junit);
        return app;
    }

    // ---------------------------------------------------------------- administration

    private static async Task<IResult> List(AtimthaDbContext db, CancellationToken ct) =>
        Results.Ok((await db.CiTokens.AsNoTracking().OrderBy(t => t.RevokedAt != null).ThenBy(t => t.Name).ToListAsync(ct)).Select(ToDto));

    private static async Task<IResult> Create(CreateCiTokenRequest body, AtimthaDbContext db, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        if (tenant.OrganizationId is not Guid org) return Api.Forbidden("Choose an organisation first.");
        var scopes = (body.Scopes is { Length: > 0 } s ? s : CiScopes.All).Distinct().ToArray();
        var v = new Api.Validation()
            .Text(body.Name, "name", 100)
            .Require(scopes.All(CiScopes.All.Contains), "scopes", "Use runs.start and/or runs.read.")
            .Require(body.ExpiresInDays is null or >= 1 and <= 730, "expiresInDays", "1 to 730 days.");
        if (body.ProjectId is Guid pid) v.Require(await db.Projects.AnyAsync(p => p.Id == pid, ct), "projectId", "Unknown project.");
        if (!v.IsValid) return v.Problem();

        var secret = CiTokenAuthenticationHandler.NewToken();
        var token = db.CiTokens.Add(new CiToken
        {
            Id = Guid.NewGuid(), OrganizationId = org, ProjectId = body.ProjectId, Name = body.Name!.Trim(),
            TokenHash = CiTokenAuthenticationHandler.Hash(secret), TokenHint = secret[..8] + "…", Scopes = scopes, CreatedBy = tenant.UserId,
            CreatedAt = DateTimeOffset.UtcNow, ExpiresAt = body.ExpiresInDays is int d ? DateTimeOffset.UtcNow.AddDays(d) : null,
        }).Entity;
        audit.Add("ci_token.create", "ci_token", token.Id, new { token.Name, token.ProjectId, token.Scopes, token.ExpiresAt });
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException e) when (Api.IsUniqueViolation(e)) { return Api.Conflict($"A token named \"{token.Name}\" already exists."); }
        // the only time the token is shown
        return Results.Created($"/api/v1/ci-tokens/{token.Id}", new CreatedCiTokenDto(ToDto(token), secret));
    }

    private static async Task<IResult> Revoke(Guid id, AtimthaDbContext db, AuditWriter audit, CancellationToken ct)
    {
        var token = await db.CiTokens.FirstOrDefaultAsync(t => t.Id == id, ct);
        if (token is null) return Api.NotFound("The token");
        token.RevokedAt ??= DateTimeOffset.UtcNow;
        audit.Add("ci_token.revoke", "ci_token", token.Id, new { token.Name });
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static CiTokenDto ToDto(CiToken t) => new(t.Id, t.Name, t.ProjectId, t.Scopes, t.TokenHint, t.CreatedAt, t.ExpiresAt, t.LastUsedAt, t.RevokedAt);

    // ---------------------------------------------------------------- pipeline API

    private static bool HasScope(HttpContext http, string scope) => http.User.HasClaim(CiTokenAuthenticationHandler.ScopeClaim, scope);

    private static async Task Touch(AtimthaDbContext db, Guid tokenId, CancellationToken ct) =>
        await db.CiTokens.Where(t => t.Id == tokenId).ExecuteUpdateAsync(u => u.SetProperty(t => t.LastUsedAt, DateTimeOffset.UtcNow), ct);

    private static async Task<IResult> Start(string projectKey, CiStartRequest body, HttpContext http, AtimthaDbContext db, AuditWriter audit,
        IConfiguration configuration, CancellationToken ct)
    {
        if (!HasScope(http, CiScopes.Start)) return Api.Forbidden("This token cannot start runs.");
        var tokenId = CiTokenAuthenticationHandler.TokenId(http.User)!.Value;
        var project = await db.Projects.AsNoTracking().FirstOrDefaultAsync(p => p.Key == projectKey && p.ArchivedAt == null, ct);
        // a token limited to one project sees no other project
        if (project is null || (CiTokenAuthenticationHandler.ProjectId(http.User) is Guid only && only != project.Id)) return Api.NotFound("The project");

        var engine = (body.Engine ?? "web").ToLowerInvariant();
        var v = new Api.Validation()
            .Require(Engines.IsKnown(engine), "engine", "Use web, api, mobile or performance.")
            .Require(body.Locale is null or "en" or "ar", "locale", "Use \"en\" or \"ar\".")
            .Require(body.Suite is null || (body.Suite.Length <= 100 && body.Suite.All(c => char.IsLetterOrDigit(c) || c is '-' or '_')), "suite", "Unknown suite.");
        if (!v.IsValid) return v.Problem();
        if (Shards.Refusal(body.Shards, "run") is { } badShards) return badShards;
        if (body.Suite is not null && !await db.Suites.AnyAsync(s => s.ProjectId == project.Id && s.Key == body.Suite, ct)) return Api.NotFound("The suite");

        var env = body.Environment is null
            ? await db.Environments.AsNoTracking().FirstOrDefaultAsync(x => x.ProjectId == project.Id && x.IsDefault, ct)
            : await db.Environments.AsNoTracking().FirstOrDefaultAsync(x => x.ProjectId == project.Id && x.Key == body.Environment, ct);
        if (env is null) return Api.NotFound("The environment");
        if (await Engines.RefusalAsync(db, project.OrganizationId, engine, ct) is { } refused) return refused;

        var selection = new SelectionDto(body.Cases is { Length: > 0 } ? body.Cases : null, null, body.Tags is { Length: > 0 } ? body.Tags : null, body.Suite, null, body.Flows is { Length: > 0 } ? body.Flows : null);
        var run = await ExecutionEndpoints.QueueAsync(db, project, env, engine, project.HealingPolicy, selection, body.Locale ?? "en", null, null, null, ct, shards: body.Shards);
        if (run is null) return Api.NotFound("The project");
        run.CiTokenId = tokenId;
        audit.Add("execution.start", "execution", run.Id, new { project = project.Key, environment = env.Key, engine, selection, ciToken = tokenId });
        await db.SaveChangesAsync(ct);
        await Touch(db, tokenId, ct);
        return Results.Created($"/api/ci/v1/runs/{run.Id}", ToRun(run, project.Key, env.Key, configuration));
    }

    private static async Task<(ExecutionRun? Run, string ProjectKey, string EnvKey)> FindAsync(Guid executionId, HttpContext http, AtimthaDbContext db, CancellationToken ct)
    {
        var run = await db.Executions.AsNoTracking().FirstOrDefaultAsync(e => e.Id == executionId, ct);
        if (run is null || (CiTokenAuthenticationHandler.ProjectId(http.User) is Guid only && only != run.ProjectId)) return (null, "", "");
        var projectKey = await db.Projects.AsNoTracking().Where(p => p.Id == run.ProjectId).Select(p => p.Key).FirstAsync(ct);
        var envKey = await db.Environments.AsNoTracking().Where(e => e.Id == run.EnvironmentId).Select(e => e.Key).FirstOrDefaultAsync(ct) ?? "?";
        return (run, projectKey, envKey);
    }

    private static async Task<IResult> Status(Guid executionId, HttpContext http, AtimthaDbContext db, IConfiguration configuration, CancellationToken ct)
    {
        if (!HasScope(http, CiScopes.Read)) return Api.Forbidden("This token cannot read runs.");
        var (run, projectKey, envKey) = await FindAsync(executionId, http, db, ct);
        if (run is null) return Api.NotFound("The run");
        await Touch(db, CiTokenAuthenticationHandler.TokenId(http.User)!.Value, ct);
        return Results.Ok(ToRun(run, projectKey, envKey, configuration));
    }

    /// <summary>JUnit XML: one testsuite per module, one testcase per result; failures carry the error and category.</summary>
    private static async Task<IResult> Junit(Guid executionId, HttpContext http, AtimthaDbContext db, CancellationToken ct)
    {
        if (!HasScope(http, CiScopes.Read)) return Api.Forbidden("This token cannot read runs.");
        var (run, projectKey, _) = await FindAsync(executionId, http, db, ct);
        if (run is null) return Api.NotFound("The run");
        var runIds = await Shards.RunIdsAsync(db, executionId, ct);
        var results = await db.Results.AsNoTracking().Where(r => runIds.Contains(r.ExecutionId)).OrderBy(r => r.Module).ThenBy(r => r.Title).ToListAsync(ct);

        static bool Failed(ResultStatus s) => s is ResultStatus.Failed or ResultStatus.TimedOut or ResultStatus.Interrupted;
        var suites = results.GroupBy(r => r.Module ?? projectKey).Select(g => new XElement("testsuite",
            new XAttribute("name", g.Key),
            new XAttribute("tests", g.Count()),
            new XAttribute("failures", g.Count(r => Failed(r.Status))),
            new XAttribute("skipped", g.Count(r => r.Status == ResultStatus.Skipped)),
            new XAttribute("time", (g.Sum(r => r.DurationMs ?? 0) / 1000.0).ToString("0.###", System.Globalization.CultureInfo.InvariantCulture)),
            g.Select(r => new XElement("testcase",
                new XAttribute("classname", $"{projectKey}.{g.Key}"),
                new XAttribute("name", r.Title),
                new XAttribute("time", ((r.DurationMs ?? 0) / 1000.0).ToString("0.###", System.Globalization.CultureInfo.InvariantCulture)),
                Failed(r.Status)
                    ? new XElement("failure",
                        new XAttribute("message", Clean(FirstLine(r.Error) ?? ExecutionEndpoints.Snake(r.Status.ToString()))),
                        new XAttribute("type", r.Category is { } c ? ExecutionEndpoints.Snake(c.ToString()) : "failure"),
                        Clean(r.Error ?? ""))
                    : r.Status == ResultStatus.Skipped ? new XElement("skipped") : null,
                r.Flaky ? new XElement("system-out", $"Flaky: passed after {r.Retries} retries.") : null))));
        var doc = new XDocument(new XDeclaration("1.0", "utf-8", null),
            new XElement("testsuites", new XAttribute("name", $"Atimtha · {projectKey}"), new XAttribute("tests", results.Count),
                new XAttribute("failures", results.Count(r => Failed(r.Status))), suites));
        await Touch(db, CiTokenAuthenticationHandler.TokenId(http.User)!.Value, ct);
        return Results.Text(doc.Declaration + "\n" + doc.Root, "application/xml", Encoding.UTF8);
    }

    private static string? FirstLine(string? s) => s?.Split('\n', 2)[0].Trim() is { Length: > 0 } l ? (l.Length > 300 ? l[..300] : l) : null;

    /// <summary>XML 1.0 cannot carry most control characters (terminal colours in Playwright errors).</summary>
    private static string Clean(string s) => new(s.Where(c => c is '\t' or '\n' or '\r' || (c >= ' ' && c != '￾' && c != '￿')).ToArray());

    private static CiRunDto ToRun(ExecutionRun r, string projectKey, string envKey, IConfiguration configuration)
    {
        var finished = r.Status is ExecutionStatus.Passed or ExecutionStatus.Failed or ExecutionStatus.Cancelled or ExecutionStatus.Error;
        var url = configuration["Platform:PublicUrl"] is { Length: > 0 } b ? $"{b.TrimEnd('/')}/runs/{r.Id}" : null;
        return new CiRunDto(r.Id, projectKey, envKey, ExecutionEndpoints.Snake(r.Status.ToString()), finished, r.Status == ExecutionStatus.Passed,
            r.Counts is null ? null : JsonNode.Parse(r.Counts), r.Error, r.QueuedAt, r.FinishedAt, url);
    }
}
