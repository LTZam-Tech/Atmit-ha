using System.Net;

namespace Atimtha.Api.Infrastructure;

// EF Core entities mapped onto db/migrations/0001_initial_schema.up.sql.
// Column names are the snake_case form of the property names (see AtimthaDbContext.ApplySnakeCase).

public enum HealingPolicy { Pass, Flag, Off }

// ---------------------------------------------------------------- tenancy and identity

public sealed class Organization
{
    public Guid Id { get; set; }
    public string Key { get; set; } = "";
    public string Name { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? ArchivedAt { get; set; }
}

public sealed class Workspace
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public string Key { get; set; } = "";
    public string Name { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? ArchivedAt { get; set; }
}

public sealed class UserAccount
{
    public Guid Id { get; set; }
    public string Email { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string Locale { get; set; } = "en";
    public string AuthProvider { get; set; } = "local";
    public string? ExternalSubject { get; set; }
    public string? PasswordHash { get; set; }
    public bool MfaEnabled { get; set; }
    public string Status { get; set; } = "active";
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? LastLoginAt { get; set; }
}

public sealed class Role
{
    public Guid Id { get; set; }
    public Guid? OrganizationId { get; set; }
    public string Key { get; set; } = "";
    public string Name { get; set; } = "";
    public bool BuiltIn { get; set; }
    public List<RolePermission> Permissions { get; set; } = [];
}

public sealed class RolePermission
{
    public Guid RoleId { get; set; }
    public string PermissionKey { get; set; } = "";
}

public sealed class Membership
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    /// <summary>null = organisation-wide</summary>
    public Guid? WorkspaceId { get; set; }
    public Guid UserId { get; set; }
    public Guid RoleId { get; set; }
    public Role? Role { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

public sealed class AuditLogEntry
{
    public long Id { get; set; }
    public Guid? OrganizationId { get; set; }
    public Guid? ActorUserId { get; set; }
    public Guid? ActorAgentId { get; set; }
    public string Action { get; set; } = "";
    public string ResourceType { get; set; } = "";
    public string? ResourceId { get; set; }
    /// <summary>JSON; never secrets</summary>
    public string Details { get; set; } = "{}";
    public IPAddress? Ip { get; set; }
    public DateTimeOffset At { get; set; }
}

// ---------------------------------------------------------------- workspaces and projects

public sealed class Project
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public Guid WorkspaceId { get; set; }
    public string Key { get; set; } = "";
    public string Name { get; set; } = "";
    public string? Description { get; set; }
    public string TestIdAttribute { get; set; } = "data-testid";
    public string[] Languages { get; set; } = ["en"];
    public Guid? BrandingProfileId { get; set; }
    public short? RunWorkers { get; set; }
    public short? RunRetries { get; set; }
    public short? RunTestTimeoutS { get; set; }
    public short? RunWaitTimeoutS { get; set; }
    public HealingPolicy HealingPolicy { get; set; } = HealingPolicy.Pass;
    public Guid? CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset? ArchivedAt { get; set; }
}

public sealed class ProjectEnvironment
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public string Key { get; set; } = "";
    public string BaseUrl { get; set; } = "";
    public bool IsDefault { get; set; }
    public bool StartDemoApp { get; set; }
    public bool IgnoreHttpsErrors { get; set; }
    public string? HttpUsername { get; set; }
    /// <summary>reference into the secrets manager — never the password</summary>
    public string? HttpPasswordSecretRef { get; set; }
}
