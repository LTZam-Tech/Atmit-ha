using System.Text;
using Atimtha.Api.Execution;
using Atimtha.Api.Integrations;
using Atimtha.Api.TestAssets;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Npgsql.EntityFrameworkCore.PostgreSQL.Infrastructure;

namespace Atimtha.Api.Infrastructure;

/// <summary>
/// EF Core view of the platform schema. The schema itself is owned by the SQL migrations (ADR-0013);
/// this context never creates or migrates tables.
/// </summary>
public sealed class AtimthaDbContext(DbContextOptions<AtimthaDbContext> options) : DbContext(options)
{
    public const string Schema = "atimtha";

    /// <summary>PostgreSQL enums of the schema; registered on the data source in Program.cs.</summary>
    public static void MapEnums(NpgsqlDbContextOptionsBuilder n)
    {
        n.MapEnum<HealingPolicy>("healing_policy", Schema);
        n.MapEnum<PageOpenMode>("page_open_mode", Schema);
        n.MapEnum<CaseType>("case_type", Schema);
        n.MapEnum<WorkflowStart>("workflow_start", Schema);
        n.MapEnum<AssetType>("asset_type", Schema);
        n.MapEnum<ChangeStatus>("change_status", Schema);
        n.MapEnum<ChangeSource>("change_source", Schema);
        n.MapEnum<AgentKind>("agent_kind", Schema);
        n.MapEnum<AgentStatus>("agent_status", Schema);
        n.MapEnum<ExecutionStatus>("execution_status", Schema);
        n.MapEnum<EngineKind>("engine_kind", Schema);
        n.MapEnum<ResultStatus>("result_status", Schema);
        n.MapEnum<FailureCategory>("failure_category", Schema);
        n.MapEnum<HealKind>("heal_kind", Schema);
        n.MapEnum<HealPurpose>("heal_purpose", Schema);
        n.MapEnum<EvidenceKind>("evidence_kind", Schema);
        n.MapEnum<IntegrationKind>("integration_kind", Schema);
        n.MapEnum<NotificationKind>("notification_kind", Schema);
        n.MapEnum<DeliveryStatus>("delivery_status", Schema);
    }

    // identity and tenancy
    public DbSet<Organization> Organizations => Set<Organization>();
    public DbSet<Workspace> Workspaces => Set<Workspace>();
    public DbSet<UserAccount> Users => Set<UserAccount>();
    public DbSet<Role> Roles => Set<Role>();
    public DbSet<RolePermission> RolePermissions => Set<RolePermission>();
    public DbSet<Membership> Memberships => Set<Membership>();
    public DbSet<AuditLogEntry> AuditLog => Set<AuditLogEntry>();
    // projects
    public DbSet<Project> Projects => Set<Project>();
    public DbSet<ProjectEnvironment> Environments => Set<ProjectEnvironment>();
    public DbSet<TestUser> TestUsers => Set<TestUser>();
    public DbSet<ExpectedMessage> Messages => Set<ExpectedMessage>();
    // test assets
    public DbSet<Page> Pages => Set<Page>();
    public DbSet<Element> Elements => Set<Element>();
    public DbSet<LocatorFallback> LocatorFallbacks => Set<LocatorFallback>();
    public DbSet<NavigationEdge> NavigationEdges => Set<NavigationEdge>();
    public DbSet<LoginConfig> LoginConfigs => Set<LoginConfig>();
    public DbSet<TestCase> Cases => Set<TestCase>();
    public DbSet<CaseDependency> CaseDependencies => Set<CaseDependency>();
    public DbSet<TestStep> Steps => Set<TestStep>();
    public DbSet<DataRow> DataRows => Set<DataRow>();
    public DbSet<Workflow> Workflows => Set<Workflow>();
    public DbSet<WorkflowStep> WorkflowSteps => Set<WorkflowStep>();
    public DbSet<RunSuite> Suites => Set<RunSuite>();
    public DbSet<RunSuiteCase> SuiteCases => Set<RunSuiteCase>();
    public DbSet<AssetVersion> AssetVersions => Set<AssetVersion>();
    public DbSet<ChangeSet> ChangeSets => Set<ChangeSet>();
    public DbSet<ChangeSetItem> ChangeSetItems => Set<ChangeSetItem>();
    // execution
    public DbSet<ExecutionAgent> Agents => Set<ExecutionAgent>();
    public DbSet<ExecutionRun> Executions => Set<ExecutionRun>();
    public DbSet<TestResult> Results => Set<TestResult>();
    public DbSet<HealingEvent> HealingEvents => Set<HealingEvent>();
    public DbSet<Evidence> Evidence => Set<Evidence>();
    public DbSet<ExecutionArtifact> Artifacts => Set<ExecutionArtifact>();
    public DbSet<Identity.OrganizationSetting> OrganizationSettings => Set<Identity.OrganizationSetting>();
    public DbSet<RunSchedule> Schedules => Set<RunSchedule>();
    // integrations
    public DbSet<Integration> Integrations => Set<Integration>();
    public DbSet<IntegrationIssue> IntegrationIssues => Set<IntegrationIssue>();
    public DbSet<FeatureFlag> FeatureFlags => Set<FeatureFlag>();
    public DbSet<NotificationChannel> NotificationChannels => Set<NotificationChannel>();
    public DbSet<NotificationDelivery> NotificationDeliveries => Set<NotificationDelivery>();
    public DbSet<CiToken> CiTokens => Set<CiToken>();
    public DbSet<Workspaces.BrandingProfile> BrandingProfiles => Set<Workspaces.BrandingProfile>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.HasDefaultSchema(Schema);

        b.Entity<Organization>().ToTable("organization");
        b.Entity<Workspace>().ToTable("workspace");
        b.Entity<UserAccount>().ToTable("user_account");
        b.Entity<Role>(e =>
        {
            e.ToTable("role");
            e.HasMany(r => r.Permissions).WithOne().HasForeignKey(p => p.RoleId);
        });
        b.Entity<RolePermission>(e => { e.ToTable("role_permission"); e.HasKey(p => new { p.RoleId, p.PermissionKey }); });
        b.Entity<Membership>(e =>
        {
            e.ToTable("membership");
            e.HasOne(m => m.Role).WithMany().HasForeignKey(m => m.RoleId);
            // an invitation adds the account and its membership in one save: the account must be inserted first
            e.HasOne<UserAccount>().WithMany().HasForeignKey(m => m.UserId);
        });
        b.Entity<AuditLogEntry>(e =>
        {
            e.ToTable("audit_log");
            e.Property(a => a.Id).UseIdentityAlwaysColumn();
            Json(e.Property(a => a.Details));
        });

        b.Entity<Project>().ToTable("project");
        b.Entity<ProjectEnvironment>().ToTable("environment");
        b.Entity<TestUser>().ToTable("test_user");
        b.Entity<ExpectedMessage>().ToTable("expected_message");

        b.Entity<Page>(e => { e.ToTable("page"); Json(e.Property(p => p.Settings)); });
        b.Entity<Element>(e =>
        {
            e.ToTable("element");
            Json(e.Property(x => x.Strategy));
            Json(e.Property(x => x.HasText));
            Json(e.Property(x => x.Rules));
        });
        b.Entity<LocatorFallback>(e => { e.ToTable("locator_fallback"); Json(e.Property(x => x.Strategy)); });
        b.Entity<NavigationEdge>(e => { e.ToTable("navigation_edge"); Json(e.Property(x => x.Steps)); });
        b.Entity<LoginConfig>(e => { e.ToTable("login_config"); e.HasKey(x => x.ProjectId); });
        b.Entity<TestCase>(e =>
        {
            e.ToTable("test_case");
            // the entity keeps the 0.1.0 text ("web", "api"); the column is the engine_kind enum
            e.Property(x => x.Engine).HasConversion(v => Enum.Parse<EngineKind>(v, true), v => v.ToString().ToLowerInvariant());
        });
        b.Entity<CaseDependency>(e => { e.ToTable("case_dependency"); e.HasKey(x => new { x.CaseId, x.DependsOnCaseId }); });
        b.Entity<TestStep>(e =>
        {
            e.ToTable("test_step");
            Json(e.Property(x => x.Body));
            Json(e.Property(x => x.ElementParams));
        });
        b.Entity<DataRow>(e => { e.ToTable("data_row"); Json(e.Property(x => x.Fields)); });
        b.Entity<Workflow>().ToTable("workflow");
        b.Entity<WorkflowStep>().ToTable("workflow_step");
        b.Entity<RunSuite>().ToTable("run_suite");
        b.Entity<RunSuiteCase>(e => { e.ToTable("run_suite_case"); e.HasKey(x => new { x.SuiteId, x.CaseId }); });
        b.Entity<AssetVersion>(e => { e.ToTable("asset_version"); Json(e.Property(x => x.Content)); });
        b.Entity<ChangeSet>(e => { e.ToTable("change_set"); Json(e.Property(x => x.BaseVersions)); });
        b.Entity<ChangeSetItem>(e => { e.ToTable("change_set_item"); Json(e.Property(x => x.Content)); });

        b.Entity<ExecutionAgent>(e => { e.ToTable("execution_agent"); Json(e.Property(x => x.Capabilities)); });
        b.Entity<ExecutionRun>(e =>
        {
            e.ToTable("execution");
            // a sharded run's parent is inserted before its children
            e.HasOne<ExecutionRun>().WithMany().HasForeignKey(x => x.ParentExecutionId);
            Json(e.Property(x => x.Selection));
            Json(e.Property(x => x.Counts));
            Json(e.Property(x => x.Job));
        });
        b.Entity<TestResult>(e =>
        {
            e.ToTable("test_result");
            Json(e.Property(x => x.Steps));
            Json(e.Property(x => x.LastPage));
            Json(e.Property(x => x.Discoveries));
        });
        // the relationship tells EF to insert a result before its healing events (the SQL keys are composite with
        // organization_id; this mapping only orders the inserts of one SaveChanges)
        b.Entity<HealingEvent>(e => { e.ToTable("healing_event"); e.HasOne<TestResult>().WithMany().HasForeignKey(x => x.TestResultId); });
        b.Entity<Evidence>().ToTable("evidence");
        b.Entity<ExecutionArtifact>().ToTable("execution_artifact");
        b.Entity<Identity.OrganizationSetting>(e => { e.ToTable("organization_setting"); e.HasKey(x => new { x.OrganizationId, x.Key }); Json(e.Property(x => x.Value)); });
        b.Entity<RunSchedule>(e => { e.ToTable("run_schedule"); Json(e.Property(x => x.Selection)); });

        b.Entity<Integration>(e => { e.ToTable("integration"); Json(e.Property(x => x.Config)); });
        b.Entity<IntegrationIssue>().ToTable("integration_issue");
        b.Entity<NotificationChannel>().ToTable("notification_channel");
        b.Entity<NotificationDelivery>().ToTable("notification_delivery");
        b.Entity<CiToken>().ToTable("ci_token");
        b.Entity<Workspaces.BrandingProfile>().ToTable("branding_profile");
        // no primary key in SQL (unique key + nullable organisation): read-only here
        b.Entity<FeatureFlag>(e => { e.ToTable("feature_flag"); e.HasNoKey(); });

        ApplySnakeCase(b);
    }

    private static void Json(PropertyBuilder property) => property.HasColumnType("jsonb");

    /// <summary>Column names follow the SQL schema: property "TestIdAttribute" → column "test_id_attribute".</summary>
    private static void ApplySnakeCase(ModelBuilder b)
    {
        foreach (IMutableEntityType entity in b.Model.GetEntityTypes())
        {
            foreach (IMutableProperty property in entity.GetProperties())
                property.SetColumnName(ToSnakeCase(property.Name));
        }
    }

    internal static string ToSnakeCase(string name)
    {
        var sb = new StringBuilder(name.Length + 8);
        for (var i = 0; i < name.Length; i++)
        {
            var c = name[i];
            if (char.IsUpper(c))
            {
                if (i > 0) sb.Append('_');
                sb.Append(char.ToLowerInvariant(c));
            }
            else sb.Append(c);
        }
        return sb.ToString();
    }
}
