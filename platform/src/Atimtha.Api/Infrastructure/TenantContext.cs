using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Npgsql;

namespace Atimtha.Api.Infrastructure;

/// <summary>The organisation this request acts in, and the signed-in user (scoped per request).</summary>
public sealed class TenantContext
{
    public Guid? OrganizationId { get; private set; }
    public string? OrganizationKey { get; private set; }
    public Guid? UserId { get; set; }

    public void SetOrganization(Guid id, string key)
    {
        if (OrganizationId is not null && OrganizationId != id)
            throw new InvalidOperationException("The organisation of a request cannot change.");
        OrganizationId = id;
        OrganizationKey = key;
    }
}

/// <summary>
/// Sets <c>app.organization_id</c> on every connection EF Core opens, so PostgreSQL row-level security
/// (db/migrations/0001) shows and accepts only this organisation's rows. An empty value means "no organisation":
/// tenant tables then return no rows.
/// </summary>
public sealed class TenantConnectionInterceptor(TenantContext tenant) : DbConnectionInterceptor
{
    private const string Sql = "SELECT set_config('app.organization_id', @org, false)";

    public override void ConnectionOpened(DbConnection connection, ConnectionEndEventData eventData)
    {
        using var cmd = Command(connection);
        cmd.ExecuteNonQuery();
    }

    public override async Task ConnectionOpenedAsync(DbConnection connection, ConnectionEndEventData eventData, CancellationToken cancellationToken = default)
    {
        await using var cmd = Command(connection);
        await cmd.ExecuteNonQueryAsync(cancellationToken);
    }

    private DbCommand Command(DbConnection connection)
    {
        var cmd = connection.CreateCommand();
        cmd.CommandText = Sql;
        cmd.Parameters.Add(new NpgsqlParameter("org", tenant.OrganizationId?.ToString() ?? string.Empty));
        return cmd;
    }
}
