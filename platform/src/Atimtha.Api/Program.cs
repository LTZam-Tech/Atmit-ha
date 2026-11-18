// Atimtha platform API — .NET modular monolith (ADR-0006, ADR-0013).
//   dotnet Atimtha.Api.dll            → serves /api/v1, /health/*, /openapi/v1.json
//   dotnet Atimtha.Api.dll migrate    → applies db/migrations/*.up.sql with the owner connection, then exits
using Atimtha.Api.Identity;
using Atimtha.Api.Infrastructure;
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

// ---------------------------------------------------------------- data: EF Core on PostgreSQL, RLS tenant per connection
var platformCs = builder.Configuration.GetConnectionString("Platform")
    ?? throw new InvalidOperationException("ConnectionStrings:Platform is not set.");

builder.Services.AddScoped<TenantContext>();
builder.Services.AddScoped<TenantConnectionInterceptor>();
builder.Services.AddDbContext<AtimthaDbContext>((sp, o) => o
    .UseNpgsql(platformCs, n => n.MapEnum<HealingPolicy>("healing_policy", AtimthaDbContext.Schema))
    .AddInterceptors(sp.GetRequiredService<TenantConnectionInterceptor>()));
builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<AuditWriter>();
builder.Services.AddScoped<AccessService>();

// ---------------------------------------------------------------- authentication: OIDC/JWT; development login only in Development
var devLogin = builder.Configuration.GetValue<bool>("Auth:Development:Enabled");
if (devLogin && !builder.Environment.IsDevelopment())
    throw new InvalidOperationException("Auth:Development:Enabled is only allowed when ASPNETCORE_ENVIRONMENT is Development.");

var authentication = builder.Services.AddAuthentication(devLogin ? DevelopmentAuthenticationHandler.Scheme : JwtBearerDefaults.AuthenticationScheme);
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

app.UseExceptionHandler();
app.UseStatusCodePages();
app.Use(async (ctx, next) =>
{
    var h = ctx.Response.Headers;
    h.XContentTypeOptions = "nosniff";
    h.XFrameOptions = "DENY";
    h["Referrer-Policy"] = "no-referrer";
    h["Cross-Origin-Resource-Policy"] = "same-origin";
    await next();
});

app.UseAuthentication();
app.UseMiddleware<TenantMiddleware>();
app.UseAuthorization();

app.MapOpenApi("/openapi/{documentName}.json").AllowAnonymous();
app.MapHealthChecks("/health/live", new HealthCheckOptions { Predicate = _ => false }).AllowAnonymous();
app.MapHealthChecks("/health/ready", new HealthCheckOptions { Predicate = c => c.Tags.Contains("ready") }).AllowAnonymous();

var api = app.MapGroup("/api/v1");
api.MapMe();
api.MapWorkspaces();
api.MapProjects();
api.MapEnvironments();

app.Run();

/// <summary>Entry point type, visible to integration tests (WebApplicationFactory).</summary>
public partial class Program;
