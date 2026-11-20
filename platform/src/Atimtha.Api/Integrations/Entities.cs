namespace Atimtha.Api.Integrations;

// Integrations (ERD E23, backlog §14, ADR-0010), mapped onto db/migrations/0001 + 0005.

public enum IntegrationKind { Git, Jira, AzureDevops, Testrail, Ci }

public sealed class Integration
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public IntegrationKind Kind { get; set; }
    public string Name { get; set; } = "";
    /// <summary>URLs, project keys, field mappings; never a secret.</summary>
    public string Config { get; set; } = "{}";
    /// <summary>vault:env/NAME or vault:file/name; resolved only when the platform calls the tool.</summary>
    public string? CredentialSecretRef { get; set; }
    public bool Enabled { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

/// <summary>Platform default (OrganizationId null) or a per-organisation override.</summary>
public sealed class FeatureFlag
{
    public string Key { get; set; } = "";
    public Guid? OrganizationId { get; set; }
    public bool Enabled { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

/// <summary>A defect filed for one failed result; unique per integration and result.</summary>
public sealed class IntegrationIssue
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public Guid IntegrationId { get; set; }
    public Guid TestResultId { get; set; }
    public Guid ExecutionId { get; set; }
    public string IssueKey { get; set; } = "";
    public string IssueUrl { get; set; } = "";
    public Guid? CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}
