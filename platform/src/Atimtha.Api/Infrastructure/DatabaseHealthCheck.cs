using Microsoft.Extensions.Diagnostics.HealthChecks;
using Npgsql;

namespace Atimtha.Api.Infrastructure;

/// <summary>/health/ready: the platform database answers.</summary>
public sealed class DatabaseHealthCheck(IConfiguration configuration) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        try
        {
            await using var conn = new NpgsqlConnection(configuration.GetConnectionString("Platform"));
            await conn.OpenAsync(cancellationToken);
            await using var cmd = new NpgsqlCommand("SELECT 1", conn);
            await cmd.ExecuteScalarAsync(cancellationToken);
            return HealthCheckResult.Healthy();
        }
        catch (Exception e)
        {
            // no connection string or host details in the answer
            return HealthCheckResult.Unhealthy("The database is not reachable.", e);
        }
    }
}
