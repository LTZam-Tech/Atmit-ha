namespace Atimtha.Api.Identity;

/// <summary>
/// Permission keys. The same keys are seeded into atimtha.permission by db/migrations/0002 and granted to roles there.
/// </summary>
public static class Permissions
{
    /// <summary>Everything in the organisation.</summary>
    public const string OrgAdmin = "org.admin";
    public const string WorkspaceManage = "workspace.manage";
    public const string MemberManage = "member.manage";
    public const string ProjectView = "project.view";
    public const string ProjectEdit = "project.edit";
    public const string ProjectDelete = "project.delete";
    public const string ExecutionRun = "execution.run";
    public const string EvidenceView = "evidence.view";
    public const string IntegrationManage = "integration.manage";
    public const string AuditView = "audit.view";

    public static readonly IReadOnlyList<string> All =
    [
        OrgAdmin, WorkspaceManage, MemberManage, ProjectView, ProjectEdit, ProjectDelete,
        ExecutionRun, EvidenceView, IntegrationManage, AuditView,
    ];

    /// <summary>Authorization policy name for a permission: "perm:project.edit".</summary>
    public const string PolicyPrefix = "perm:";
    public static string Policy(string permission) => PolicyPrefix + permission;
}
