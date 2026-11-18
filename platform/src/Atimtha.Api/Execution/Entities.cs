using NpgsqlTypes;

namespace Atimtha.Api.Execution;

// Execution, agents and results (ERD E18–E19, backlog §10–§11), mapped onto db/migrations/0001 + 0003.

public enum AgentKind { Central, Local, Private }
public enum AgentStatus { Pending, Active, Offline, Revoked }
public enum ExecutionStatus { Queued, Assigned, Running, Passed, Failed, Cancelled, Error }
public enum EngineKind { Web, Api, Mobile, Performance }
public enum ResultStatus { Passed, Failed, TimedOut, Skipped, Interrupted }
public enum FailureCategory { ApplicationDefect, LocatorOr, SelfHealing, Environment, Timeout, ScriptError, Infrastructure }

public enum HealKind
{
    [PgName("fallback-locator")] FallbackLocator,
    [PgName("ready-element")] ReadyElement,
    [PgName("navigation-route")] NavigationRoute,
}

public enum HealPurpose { Check, Action, Navigation }

public sealed class ExecutionAgent
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public string Name { get; set; } = "";
    public AgentKind Kind { get; set; }
    public AgentStatus Status { get; set; } = AgentStatus.Pending;
    /// <summary>{"engines": ["web","api"], "browsers": ["chromium"], "maxJobs": 1}</summary>
    public string Capabilities { get; set; } = "{}";
    public string? CertificateFingerprint { get; set; }
    public string? Version { get; set; }
    /// <summary>SHA-256 of the agent's token; the token itself is shown once, at creation</summary>
    public string? TokenHash { get; set; }
    public DateTimeOffset? LastHeartbeatAt { get; set; }
    public DateTimeOffset RegisteredAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
}

public sealed class ExecutionRun
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public Guid EnvironmentId { get; set; }
    public EngineKind Engine { get; set; } = EngineKind.Web;
    public Guid? SuiteId { get; set; }
    public string Selection { get; set; } = "{}";
    public string Locale { get; set; } = "en";
    public string Target { get; set; } = "local";
    public Infrastructure.HealingPolicy HealingPolicy { get; set; }
    public long? Seed { get; set; }
    public ExecutionStatus Status { get; set; } = ExecutionStatus.Queued;
    public Guid? AgentId { get; set; }
    public Guid? RequestedBy { get; set; }
    public DateTimeOffset QueuedAt { get; set; }
    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? FinishedAt { get; set; }
    public string? Counts { get; set; }
    /// <summary>the job document frozen when the run was requested (migration 0003)</summary>
    public string? Job { get; set; }
    public bool CancelRequested { get; set; }
    public short RequeueCount { get; set; }
    public string? Error { get; set; }
}

public sealed class TestResult
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public Guid ExecutionId { get; set; }
    public Guid? CaseId { get; set; }
    public Guid? DataRowId { get; set; }
    public Guid? WorkflowId { get; set; }
    public string Title { get; set; } = "";
    public string? Module { get; set; }
    public string? Kind { get; set; }
    public ResultStatus Status { get; set; }
    public bool Flaky { get; set; }
    public short Retries { get; set; }
    public FailureCategory? Category { get; set; }
    public string? Error { get; set; }
    public int? DurationMs { get; set; }
    public string? Steps { get; set; }
    public string? LastPage { get; set; }
    public string? Discoveries { get; set; }
    public DateTimeOffset? StartedAt { get; set; }
}

public sealed class HealingEvent
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public Guid TestResultId { get; set; }
    public HealKind Kind { get; set; }
    public HealPurpose Purpose { get; set; }
    public string Target { get; set; } = "";
    public string Original { get; set; } = "";
    public string HealedBy { get; set; } = "";
    public string? Fix { get; set; }
}
