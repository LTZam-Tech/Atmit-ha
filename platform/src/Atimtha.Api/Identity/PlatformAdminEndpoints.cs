using Atimtha.Api.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Atimtha.Api.Identity;

using Api = Atimtha.Api.Infrastructure.Api;

public sealed record PlatformOrganizationDto(Guid Id, string Key, string Name, DateTimeOffset CreatedAt, DateTimeOffset? ArchivedAt, int Workspaces, int Projects, int Members);
public sealed record CreateOrganizationRequest(string? Key, string? Name, string? AdminEmail, string? AdminName);
public sealed record UpdateOrganizationRequest(string? Name, bool? Archived);

/// <summary>
/// Platform administrators are named in configuration (<c>Platform:Admins</c>: a list, or one comma-separated value of
/// emails). They manage organisations, which sit outside every tenant; nothing else is granted by this role.
/// </summary>
public sealed class PlatformAdmins(IConfiguration configuration)
{
    private readonly HashSet<string> emails = Read(configuration);

    private static HashSet<string> Read(IConfiguration configuration)
    {
        var section = configuration.GetSection("Platform:Admins");
        var values = section.GetChildren().Select(c => c.Value).Append(section.Value)
            .Where(v => !string.IsNullOrWhiteSpace(v))
            .SelectMany(v => v!.Split([',', ';', ' '], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
        return new HashSet<string>(values.Select(v => v.ToLowerInvariant()), StringComparer.Ordinal);
    }

    public bool Any => emails.Count > 0;

    public bool Is(string? email) => !string.IsNullOrWhiteSpace(email) && emails.Contains(email.Trim().ToLowerInvariant());

    /// <summary>a signed-in person (never an agent or CI token) whose account email is listed</summary>
    public async Task<bool> IsCurrentAsync(TenantContext tenant, AtimthaDbContext db, CancellationToken ct)
    {
        if (tenant.UserId is not { } userId || !Any) return false;
        var email = await db.Users.AsNoTracking().Where(u => u.Id == userId && u.Status == "active").Select(u => u.Email).FirstOrDefaultAsync(ct);
        return Is(email);
    }
}

/// <summary>
/// /api/v1/platform/organizations — create, rename and archive organisations (platform administrators only).
/// These rows sit outside a tenant, and the first administrator's membership belongs to the new organisation, so these
/// calls use the maintenance (owner) connection, as MaintenanceService does; nothing else in the API does.
/// </summary>
public static class PlatformAdminEndpoints
{
    public static RouteGroupBuilder MapPlatformAdmin(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/platform/organizations").WithTags("Platform");
        g.AddEndpointFilter(async (context, next) =>
        {
            var http = context.HttpContext;
            var admins = http.RequestServices.GetRequiredService<PlatformAdmins>();
            var tenant = http.RequestServices.GetRequiredService<TenantContext>();
            var db = http.RequestServices.GetRequiredService<AtimthaDbContext>();
            if (!await admins.IsCurrentAsync(tenant, db, http.RequestAborted))
                return Api.Forbidden("Only a platform administrator can manage organisations.");
            return await next(context);
        });
        g.MapGet("/", List);
        g.MapPost("/", Create);
        g.MapPatch("/{key}", Update);
        return api;
    }

    private static string? OwnerConnection(IConfiguration configuration) =>
        configuration.GetConnectionString("Maintenance") ?? configuration.GetConnectionString("Migrations");

    private static IResult NoOwnerConnection() =>
        Results.Problem(statusCode: StatusCodes.Status503ServiceUnavailable, title: "Not configured",
            detail: "Organisation management needs the maintenance connection (ConnectionStrings:Maintenance).");

    private static async Task<IResult> List(IConfiguration configuration, CancellationToken ct)
    {
        if (OwnerConnection(configuration) is not { } cs) return NoOwnerConnection();
        await using var conn = new NpgsqlConnection(cs);
        await conn.OpenAsync(ct);
        await using var cmd = new NpgsqlCommand("""
            SELECT o.id, o.key, o.name, o.created_at, o.archived_at,
              (SELECT count(*) FROM atimtha.workspace w WHERE w.organization_id = o.id AND w.archived_at IS NULL)::int,
              (SELECT count(*) FROM atimtha.project p WHERE p.organization_id = o.id AND p.archived_at IS NULL)::int,
              (SELECT count(DISTINCT m.user_id) FROM atimtha.membership m WHERE m.organization_id = o.id)::int
            FROM atimtha.organization o ORDER BY o.archived_at IS NOT NULL, o.name
            """, conn);
        var items = new List<PlatformOrganizationDto>();
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct))
            items.Add(new PlatformOrganizationDto(r.GetGuid(0), r.GetString(1), r.GetString(2), r.GetFieldValue<DateTimeOffset>(3),
                r.IsDBNull(4) ? null : r.GetFieldValue<DateTimeOffset>(4), r.GetInt32(5), r.GetInt32(6), r.GetInt32(7)));
        return Results.Ok(items);
    }

    private static async Task<IResult> Create(CreateOrganizationRequest body, IConfiguration configuration, TenantContext tenant, IHttpContextAccessor http, CancellationToken ct)
    {
        var email = body.AdminEmail?.Trim().ToLowerInvariant();
        var v = new Api.Validation()
            .Require(body.Key is not null && System.Text.RegularExpressions.Regex.IsMatch(body.Key, "^[a-z][a-z0-9-]{1,62}$"), "key",
                "Use lowercase letters, digits and \"-\", starting with a letter (2 to 63).")
            .Text(body.Name, "name", 200)
            .Require(email is { Length: > 3 and <= 254 } && email.Contains('@') && !email.Contains(' '), "adminEmail", "Enter the first administrator's email address.")
            .Text(body.AdminName, "adminName", 200, required: false);
        if (!v.IsValid) return v.Problem();
        if (OwnerConnection(configuration) is not { } cs) return NoOwnerConnection();

        await using var conn = new NpgsqlConnection(cs);
        await conn.OpenAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        var now = DateTimeOffset.UtcNow;
        var orgId = Guid.NewGuid();
        try
        {
            await Exec(conn, tx, "INSERT INTO atimtha.organization (id, key, name, created_at) VALUES (@id, @key, @name, @at)", ct,
                ("id", orgId), ("key", body.Key!), ("name", body.Name!.Trim()), ("at", now));
        }
        catch (PostgresException e) when (e.SqlState == PostgresErrorCodes.UniqueViolation)
        {
            return Api.Conflict($"An organisation with the key \"{body.Key}\" already exists.");
        }

        // the first administrator: an existing account, or an invited one linked on first sign-in (as MemberEndpoints invites)
        Guid userId;
        await using (var find = new NpgsqlCommand("SELECT id FROM atimtha.user_account WHERE email = @email", conn, tx))
        {
            find.Parameters.AddWithValue("email", email!);
            userId = await find.ExecuteScalarAsync(ct) is Guid existing ? existing : Guid.Empty;
        }
        var invited = userId == Guid.Empty;
        if (invited)
        {
            userId = Guid.NewGuid();
            await Exec(conn, tx, """
                INSERT INTO atimtha.user_account (id, email, display_name, auth_provider, status, created_at)
                VALUES (@id, @email, @name, 'oidc', 'invited', @at)
                """, ct, ("id", userId), ("email", email!), ("name", string.IsNullOrWhiteSpace(body.AdminName) ? email! : body.AdminName!.Trim()), ("at", now));
        }
        var membershipId = Guid.NewGuid();
        await Exec(conn, tx, """
            INSERT INTO atimtha.membership (id, organization_id, workspace_id, user_id, role_id, created_at)
            SELECT @id, @org, NULL, @user, r.id, @at FROM atimtha.role r WHERE r.organization_id IS NULL AND r.key = 'org-admin'
            """, ct, ("id", membershipId), ("org", orgId), ("user", userId), ("at", now));
        await Audit(conn, tx, orgId, tenant.UserId, "platform.organization.create", orgId,
            System.Text.Json.JsonSerializer.Serialize(new { key = body.Key, name = body.Name!.Trim(), adminEmail = email, invited }), http, ct);
        await tx.CommitAsync(ct);

        return Results.Created($"/api/v1/platform/organizations/{body.Key}",
            new PlatformOrganizationDto(orgId, body.Key!, body.Name!.Trim(), now, null, 0, 0, 1));
    }

    private static async Task<IResult> Update(string key, UpdateOrganizationRequest body, IConfiguration configuration, TenantContext tenant, IHttpContextAccessor http, CancellationToken ct)
    {
        var v = new Api.Validation()
            .Require(body.Name is not null || body.Archived is not null, "name", "Nothing to change.")
            .Text(body.Name, "name", 200, required: false)
            .Require(body.Name is null || !string.IsNullOrWhiteSpace(body.Name), "name", "Required.");
        if (!v.IsValid) return v.Problem();
        if (OwnerConnection(configuration) is not { } cs) return NoOwnerConnection();

        await using var conn = new NpgsqlConnection(cs);
        await conn.OpenAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        Guid orgId;
        await using (var find = new NpgsqlCommand("SELECT id FROM atimtha.organization WHERE key = @key FOR UPDATE", conn, tx))
        {
            find.Parameters.AddWithValue("key", key);
            if (await find.ExecuteScalarAsync(ct) is not Guid id) return Api.NotFound("The organisation");
            orgId = id;
        }
        if (body.Name is not null)
            await Exec(conn, tx, "UPDATE atimtha.organization SET name = @name WHERE id = @id", ct, ("name", body.Name.Trim()), ("id", orgId));
        if (body.Archived is { } archived)
        {
            // an archived organisation is invisible to everyone (TenantMiddleware); its data stays for a later restore
            await Exec(conn, tx, archived
                ? "UPDATE atimtha.organization SET archived_at = COALESCE(archived_at, now()) WHERE id = @id"
                : "UPDATE atimtha.organization SET archived_at = NULL WHERE id = @id", ct, ("id", orgId));
        }
        await Audit(conn, tx, orgId, tenant.UserId, body.Archived switch { true => "platform.organization.archive", false => "platform.organization.restore", _ => "platform.organization.rename" },
            orgId, System.Text.Json.JsonSerializer.Serialize(new { key, name = body.Name?.Trim(), body.Archived }), http, ct);
        await tx.CommitAsync(ct);
        return Results.NoContent();
    }

    private static async Task Exec(NpgsqlConnection conn, NpgsqlTransaction tx, string sql, CancellationToken ct, params (string Name, object Value)[] args)
    {
        await using var cmd = new NpgsqlCommand(sql, conn, tx);
        foreach (var (name, value) in args) cmd.Parameters.AddWithValue(name, value);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static Task Audit(NpgsqlConnection conn, NpgsqlTransaction tx, Guid orgId, Guid? actor, string action, Guid resourceId, string details, IHttpContextAccessor http, CancellationToken ct)
    {
        var args = new List<(string, object)>
        {
            ("org", orgId), ("actor", (object?)actor ?? DBNull.Value), ("action", action), ("rid", resourceId.ToString()),
            ("details", details), ("ip", (object?)http.HttpContext?.Connection.RemoteIpAddress ?? DBNull.Value),
        };
        return ExecTyped(conn, tx, """
            INSERT INTO atimtha.audit_log (organization_id, actor_user_id, action, resource_type, resource_id, details, ip, at)
            VALUES (@org, @actor, @action, 'organization', @rid, @details::jsonb, @ip, now())
            """, args, ct);
    }

    private static async Task ExecTyped(NpgsqlConnection conn, NpgsqlTransaction tx, string sql, List<(string Name, object Value)> args, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand(sql, conn, tx);
        foreach (var (name, value) in args)
        {
            if (name == "actor") cmd.Parameters.Add(new NpgsqlParameter(name, NpgsqlTypes.NpgsqlDbType.Uuid) { Value = value });
            else if (name == "ip") cmd.Parameters.Add(new NpgsqlParameter(name, NpgsqlTypes.NpgsqlDbType.Inet) { Value = value });
            else cmd.Parameters.AddWithValue(name, value);
        }
        await cmd.ExecuteNonQueryAsync(ct);
    }
}
