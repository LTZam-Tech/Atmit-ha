using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;

namespace Atimtha.Api.Infrastructure;

/// <summary>
/// EF Core view of the platform schema. The schema itself is owned by the SQL migrations (ADR-0013);
/// this context never creates or migrates tables.
/// </summary>
public sealed class AtimthaDbContext(DbContextOptions<AtimthaDbContext> options) : DbContext(options)
{
    public const string Schema = "atimtha";

    public DbSet<Organization> Organizations => Set<Organization>();
    public DbSet<Workspace> Workspaces => Set<Workspace>();
    public DbSet<UserAccount> Users => Set<UserAccount>();
    public DbSet<Role> Roles => Set<Role>();
    public DbSet<RolePermission> RolePermissions => Set<RolePermission>();
    public DbSet<Membership> Memberships => Set<Membership>();
    public DbSet<AuditLogEntry> AuditLog => Set<AuditLogEntry>();
    public DbSet<Project> Projects => Set<Project>();
    public DbSet<ProjectEnvironment> Environments => Set<ProjectEnvironment>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.HasDefaultSchema(Schema);
        b.HasPostgresEnum<HealingPolicy>(Schema, "healing_policy");

        b.Entity<Organization>().ToTable("organization");
        b.Entity<Workspace>().ToTable("workspace");
        b.Entity<UserAccount>().ToTable("user_account");
        b.Entity<Role>(e =>
        {
            e.ToTable("role");
            e.HasMany(r => r.Permissions).WithOne().HasForeignKey(p => p.RoleId);
        });
        b.Entity<RolePermission>(e =>
        {
            e.ToTable("role_permission");
            e.HasKey(p => new { p.RoleId, p.PermissionKey });
        });
        b.Entity<Membership>(e =>
        {
            e.ToTable("membership");
            e.HasOne(m => m.Role).WithMany().HasForeignKey(m => m.RoleId);
        });
        b.Entity<AuditLogEntry>(e =>
        {
            e.ToTable("audit_log");
            e.Property(a => a.Id).UseIdentityAlwaysColumn();
            e.Property(a => a.Details).HasColumnType("jsonb");
        });
        b.Entity<Project>(e =>
        {
            e.ToTable("project");
            e.Property(p => p.HealingPolicy).HasColumnType($"{Schema}.healing_policy");
        });
        b.Entity<ProjectEnvironment>().ToTable("environment");

        ApplySnakeCase(b);
    }

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
