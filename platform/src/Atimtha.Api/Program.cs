using Atimtha.Api.Integrations;
// Atimtha platform API — .NET modular monolith (ADR-0006, ADR-0013).
//   dotnet Atimtha.Api.dll            → serves /api/v1, /health/*, /openapi/v1.json
//   dotnet Atimtha.Api.dll migrate    → applies db/migrations/*.up.sql with the owner connection, then exits
using Atimtha.Api.Execution;
using Atimtha.Api.Identity;
using Atimtha.Api.Infrastructure;
using Atimtha.Api.TestAssets;
using Atimtha.Api.Workspaces;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

// ---------------------------------------------------------------- logging: JSON, one line per event, with scopes
builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole(o =>
{
    o.IncludeScopes = true;
    o.UseUtcTimestamp = true;
    o.TimestampFormat = "yyyy-MM-ddTHH:mm:ss.fffZ";
});

// ---------------------------------------------------------------- migrate mode
if (args.FirstOrDefault() == "migrate")
{
    var migrationsCs = builder.Configuration.GetConnectionString("Migrations")
        ?? throw new InvalidOperationException("ConnectionStrings:Migrations (the schema owner) is not set.");
    var folder = Path.GetFullPath(Path.Combine(builder.Environment.ContentRootPath, builder.Configuration["Migrations:Path"] ?? "migrations"));
    using var loggerFactory = LoggerFactory.Create(l => l.AddJsonConsole());
    var runner = new MigrationRunner(migrationsCs, folder, loggerFactory.CreateLogger("Atimtha.Migrations"));
    await runner.RunAsync();
    return;
}

// ---------------------------------------------------------------- refuse an unsafe production configuration
Hardening.CheckProductionConfiguration(builder.Configuration, builder.Environment);

// ---------------------------------------------------------------- data: EF Core on PostgreSQL, RLS tenant per connection
var platformCs = builder.Configuration.GetConnectionString("Platform")
    ?? throw new InvalidOperationException("ConnectionStrings:Platform is not set.");

builder.Services.AddScoped<TenantContext>();
builder.Services.AddScoped<TenantConnectionInterceptor>();
builder.Services.AddDbContext<AtimthaDbContext>((sp, o) => o
    .UseNpgsql(platformCs, AtimthaDbContext.MapEnums)
    .AddInterceptors(sp.GetRequiredService<TenantConnectionInterceptor>()));
builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<AuditWriter>();
builder.Services.AddScoped<AccessService>();
builder.Services.AddScoped<IJobQueue, PostgresJobQueue>();
builder.Services.AddHostedService<MaintenanceService>();
builder.Services.AddHostedService<SchedulerService>();
builder.Services.AddSingleton<SecretResolver>();
builder.Services.AddSingleton<IEvidenceStore, FileEvidenceStore>();
builder.Services.AddScoped<OrganizationSettings>();
builder.Services.AddSingleton<JobSigner>();
builder.Services.AddSingleton<JobTokens>();
builder.Services.AddSingleton<PlatformMetrics>();
builder.Services.AddSingleton<PlatformAdmins>();
builder.Services.AddPlatformRateLimits(builder.Configuration);
builder.Services.AddHttpClient<JiraClient>(c => c.Timeout = TimeSpan.FromSeconds(20));
builder.Services.AddHttpClient<AzureDevOpsTracker>(c => c.Timeout = TimeSpan.FromSeconds(20));
builder.Services.AddTransient<IDefectTracker, JiraTracker>();
builder.Services.AddTransient<IDefectTracker>(sp => sp.GetRequiredService<AzureDevOpsTracker>());
builder.Services.AddHttpClient<TestRailPublisher>(c => c.Timeout = TimeSpan.FromSeconds(30));
builder.Services.AddTransient<IResultPublisher>(sp => sp.GetRequiredService<TestRailPublisher>());
builder.Services.AddTransient<DefectTrackers>();
builder.Services.AddHttpClient(NotificationSender.Client, c => c.Timeout = TimeSpan.FromSeconds(10))
    .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { AllowAutoRedirect = false });
builder.Services.AddSingleton<NotificationSender>();
builder.Services.AddHostedService<NotificationService>();

// ---------------------------------------------------------------- authentication: OIDC/JWT; development login only in Development
var devLogin = builder.Configuration.GetValue<bool>("Auth:Development:Enabled");
if (devLogin && !builder.Environment.IsDevelopment())
    throw new InvalidOperationException("Auth:Development:Enabled is only allowed when ASPNETCORE_ENVIRONMENT is Development.");

// one selector scheme: agent token → AtimthaAgent; X-Dev-User (development only) → Development; otherwise OIDC bearer
const string selectorScheme = "Atimtha";
var authentication = builder.Services.AddAuthentication(selectorScheme);
authentication.AddPolicyScheme(selectorScheme, "Atimtha", o => o.ForwardDefaultSelector = ctx =>
{
    // agents, and test runners with a job token (one job only), use the agent scheme
    if (ctx.Request.Headers.Authorization.ToString().StartsWith(AgentAuthenticationHandler.Scheme + " ", StringComparison.Ordinal)
        || ctx.Request.Headers.Authorization.ToString().StartsWith(JobTokens.Scheme + " ", StringComparison.Ordinal))
        return AgentAuthenticationHandler.Scheme;
    if (ctx.Request.Headers.Authorization.ToString().StartsWith(CiTokenAuthenticationHandler.Scheme + " ", StringComparison.Ordinal))
        return CiTokenAuthenticationHandler.Scheme;
    if (devLogin && ctx.Request.Headers.ContainsKey(DevelopmentAuthenticationHandler.Header))
        return DevelopmentAuthenticationHandler.Scheme;
    return JwtBearerDefaults.AuthenticationScheme;
});
authentication.AddScheme<AuthenticationSchemeOptions, AgentAuthenticationHandler>(AgentAuthenticationHandler.Scheme, null);
authentication.AddScheme<AuthenticationSchemeOptions, CiTokenAuthenticationHandler>(CiTokenAuthenticationHandler.Scheme, null);
authentication.AddJwtBearer(o =>
{
    o.Authority = builder.Configuration["Auth:Authority"];
    o.Audience = builder.Configuration["Auth:Audience"];
    o.MapInboundClaims = false;   // keep "sub", "email", "org" as issued
    o.RequireHttpsMetadata = !builder.Environment.IsDevelopment();
});
if (devLogin)
    authentication.AddScheme<AuthenticationSchemeOptions, DevelopmentAuthenticationHandler>(DevelopmentAuthenticationHandler.Scheme, null);

// ---------------------------------------------------------------- authorisation: every endpoint needs a user; "perm:x" policies
builder.Services.AddAuthorization(o => o.FallbackPolicy = new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build());
builder.Services.AddSingleton<IAuthorizationPolicyProvider, PermissionPolicyProvider>();
builder.Services.AddScoped<IAuthorizationHandler, PermissionHandler>();

// ---------------------------------------------------------------- API standards
builder.Services.AddProblemDetails();
builder.Services.AddOpenApi("v1");
builder.Services.AddHealthChecks().AddCheck<DatabaseHealthCheck>("database", tags: ["ready"]);

var app = builder.Build();

if (devLogin) app.Logger.LogWarning("Development login (X-Dev-User header) is ENABLED. Never use this configuration outside local development.");

// outermost, so every request is counted with the status it finally got
app.UsePlatformMetrics();
app.UseExceptionHandler();
app.UseStatusCodePages();
app.UseSecurityHeaders();
if (!app.Environment.IsDevelopment()) app.UseHsts();
app.UseRateLimiter();

app.UseAuthentication();
app.UseMiddleware<TenantMiddleware>();
app.UseAuthorization();

app.MapOpenApi("/openapi/{documentName}.json").AllowAnonymous();
app.MapPlatformMetrics();
app.MapHealthChecks("/health/live", new HealthCheckOptions { Predicate = _ => false }).AllowAnonymous();
app.MapHealthChecks("/health/ready", new HealthCheckOptions { Predicate = c => c.Tags.Contains("ready") }).AllowAnonymous();

SnapshotExporter.LogoStore = app.Services.GetRequiredService<IEvidenceStore>();
_ = app.Services.GetRequiredService<JobSigner>();
_ = app.Services.GetRequiredService<JobTokens>();   // load the signing key at start-up, not on the first claim

var api = app.MapGroup("/api/v1");
api.MapMe();
api.MapPlatformAdmin();
api.MapWorkspaces();
api.MapProjects();
api.MapEnvironments();
api.MapTestAssets();
api.MapChangeSets();
api.MapTestUsers();
api.MapMembers();
api.MapRoles();
api.MapExecutions();
api.MapReports();
api.MapIntegrations();
api.MapSchedules();
api.MapSuites();
api.MapPages();
api.MapWorkflows();
api.MapBranding();
api.MapProjectData();
api.MapProjectExport();
api.MapFindings();
api.MapAnalytics();
api.MapOrganizationSettings();
api.MapNotifications();
api.MapDashboard();
app.MapAgents(api);
app.MapEvidence(api);
app.MapCi(api);
app.MapArtifacts(api);

app.Run();

/// <summary>Entry point type, visible to integration tests (WebApplicationFactory).</summary>
public partial class Program;
