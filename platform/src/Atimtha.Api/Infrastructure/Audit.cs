using System.Text.Json;

namespace Atimtha.Api.Infrastructure;

/// <summary>Adds audit rows to the current unit of work, so they commit with the change they describe.</summary>
public sealed class AuditWriter(AtimthaDbContext db, TenantContext tenant, IHttpContextAccessor http)
{
    public void Add(string action, string resourceType, object? resourceId, object? details = null)
    {
        db.AuditLog.Add(new AuditLogEntry
        {
            OrganizationId = tenant.OrganizationId,
            ActorUserId = tenant.UserId,
            Action = action,
            ResourceType = resourceType,
            ResourceId = resourceId?.ToString(),
            Details = details is null ? "{}" : JsonSerializer.Serialize(details),
            Ip = http.HttpContext?.Connection.RemoteIpAddress,
            At = DateTimeOffset.UtcNow,
        });
    }
}
