namespace Atimtha.Api.TestAssets;

// Test assets (ERD E3–E16) mapped onto db/migrations/0001. JSON columns are strings with column type jsonb.

public enum PageOpenMode { Url, Navigate }
public enum CaseType { Positive, Negative }
public enum WorkflowStart { Continue, Open }
public enum AssetType { Project, Page, TestCase, Workflow, Navigation, RunSuite, Messages }

public sealed class TestUser
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public string Key { get; set; } = "";
    public string Username { get; set; } = "";
    public string? PasswordSecretRef { get; set; }
    public string? Description { get; set; }
}

public sealed class ExpectedMessage
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public string Locale { get; set; } = "en";
    public string Key { get; set; } = "";
    public string Text { get; set; } = "";
}

public sealed class Page
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public string Key { get; set; } = "";
    public string? Url { get; set; }
    public PageOpenMode OpenMode { get; set; } = PageOpenMode.Url;
    public string? Description { get; set; }
    public Guid? ReadyWhenElementId { get; set; }
    public Guid? AuthUserId { get; set; }
    public bool AuthLoggedOut { get; set; }
    public string[] Tags { get; set; } = [];
    public string Settings { get; set; } = "{}";
    public int CurrentVersion { get; set; } = 1;
    public DateTimeOffset UpdatedAt { get; set; }
}

public sealed class Element
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public Guid PageId { get; set; }
    public string Key { get; set; } = "";
    public int Position { get; set; }
    /// <summary>primary locator: {"testid": "…"} | {"role": "button", "name": "Save"} | …</summary>
    public string Strategy { get; set; } = "{}";
    public Guid? WithinElementId { get; set; }
    public string? Frame { get; set; }
    public int? Nth { get; set; }
    public string? HasText { get; set; }
    public string? Control { get; set; }
    public string? Semantic { get; set; }
    public string? Rules { get; set; }
    public string? Format { get; set; }
    public string[]? Options { get; set; }
    public string? Href { get; set; }
    public bool? NewTab { get; set; }
    public string[]? Messages { get; set; }
    public string? Description { get; set; }
}

public sealed class LocatorFallback
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public Guid ElementId { get; set; }
    public int Position { get; set; }
    public string Strategy { get; set; } = "{}";
}

public sealed class NavigationEdge
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public Guid FromPageId { get; set; }
    public Guid ToPageId { get; set; }
    public string Steps { get; set; } = "[]";
}

public sealed class LoginConfig
{
    public Guid ProjectId { get; set; }
    public Guid OrganizationId { get; set; }
    public Guid PageId { get; set; }
    public Guid UsernameElementId { get; set; }
    public Guid PasswordElementId { get; set; }
    public Guid SubmitElementId { get; set; }
    public Guid? SuccessElementId { get; set; }
    public string? SuccessUrlContains { get; set; }
}

public sealed class TestCase
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public string Key { get; set; } = "";
    public string Engine { get; set; } = "web";
    public string Title { get; set; } = "";
    public string? Description { get; set; }
    public string? Module { get; set; }
    public CaseType? CaseType { get; set; }
    public Guid? StartPageId { get; set; }
    public string? StartUrl { get; set; }
    public Guid? StartUserId { get; set; }
    public bool StartLoggedOut { get; set; }
    public string[] Tags { get; set; } = [];
    public Guid? ContinueFromCaseId { get; set; }
    public string? ContinueFromRowKey { get; set; }
    public int CurrentVersion { get; set; } = 1;
    public Guid? CreatedBy { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

public sealed class CaseDependency
{
    public Guid OrganizationId { get; set; }
    public Guid CaseId { get; set; }
    public Guid DependsOnCaseId { get; set; }
}

public sealed class TestStep
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public Guid CaseId { get; set; }
    /// <summary>"" = the case's main steps, else the outcome name</summary>
    public string Outcome { get; set; } = "";
    public int Position { get; set; }
    public string Action { get; set; } = "";
    public Guid? ElementId { get; set; }
    public string? ElementParams { get; set; }
    /// <summary>the step exactly as in the YAML: {"fill": {"element": "…", "value": "…"}}</summary>
    public string Body { get; set; } = "{}";
    public string? Name { get; set; }
}

public sealed class DataRow
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public Guid CaseId { get; set; }
    public string Key { get; set; } = "";
    public int Position { get; set; }
    public string? Title { get; set; }
    public CaseType? RowType { get; set; }
    public string? Outcome { get; set; }
    public string[] Tags { get; set; } = [];
    public bool Skip { get; set; }
    public string Fields { get; set; } = "{}";
}

public sealed class Workflow
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public string Key { get; set; } = "";
    public string Title { get; set; } = "";
    public string? Description { get; set; }
    public string? Module { get; set; }
    public string[] Tags { get; set; } = [];
    public int CurrentVersion { get; set; } = 1;
}

public sealed class WorkflowStep
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public Guid WorkflowId { get; set; }
    public int Position { get; set; }
    public Guid CaseId { get; set; }
    public Guid? DataRowId { get; set; }
    public Guid? RunAsUserId { get; set; }
    public WorkflowStart? StartMode { get; set; }
}

public sealed class RunSuite
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public string Key { get; set; } = "";
    public string? Description { get; set; }
    public string[] Modules { get; set; } = [];
    public string[] Tags { get; set; } = [];
}

public sealed class RunSuiteCase
{
    public Guid OrganizationId { get; set; }
    public Guid SuiteId { get; set; }
    public Guid CaseId { get; set; }
}

public enum ChangeStatus { Draft, Submitted, Approved, Rejected, Merged }
public enum ChangeSource { Central, Local }

/// <summary>Reviewed edits (ADR-0007): central edits and offline drafts alike.</summary>
public sealed class ChangeSet
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public string Title { get; set; } = "";
    public ChangeStatus Status { get; set; } = ChangeStatus.Submitted;
    public ChangeSource Source { get; set; } = ChangeSource.Central;
    public string BaseVersions { get; set; } = "{}";
    public Guid CreatedBy { get; set; }
    public Guid? ReviewedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? DecidedAt { get; set; }
    public string? DecisionNote { get; set; }
}

public sealed class ChangeSetItem
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public Guid ChangeSetId { get; set; }
    public AssetType AssetType { get; set; }
    public string AssetKey { get; set; } = "";
    public Guid? AssetId { get; set; }
    public int? BaseVersion { get; set; }
    public string Content { get; set; } = "{}";
    public string ContentSha256 { get; set; } = "";
}

/// <summary>Immutable snapshot of one asset (ADR-0012): content is the 0.1.0 YAML as JSON.</summary>
public sealed class AssetVersion
{
    public Guid Id { get; set; }
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public AssetType AssetType { get; set; }
    public Guid AssetId { get; set; }
    public int Version { get; set; }
    public string Content { get; set; } = "{}";
    public string ContentSha256 { get; set; } = "";
    public Guid? ChangeSetId { get; set; }
    public Guid? CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}
