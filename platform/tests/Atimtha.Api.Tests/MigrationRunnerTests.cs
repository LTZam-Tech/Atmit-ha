using Atimtha.Api.Infrastructure;

namespace Atimtha.Api.Tests;

public sealed class MigrationRunnerTests : IDisposable
{
    private readonly string dir = Directory.CreateTempSubdirectory("atimtha-migrations-").FullName;

    public void Dispose() => Directory.Delete(dir, recursive: true);

    [Fact]
    public void Discover_orders_up_scripts_by_name_and_ignores_down_scripts()
    {
        File.WriteAllText(Path.Combine(dir, "0002_b.up.sql"), "SELECT 2;");
        File.WriteAllText(Path.Combine(dir, "0001_a.up.sql"), "SELECT 1;");
        File.WriteAllText(Path.Combine(dir, "0001_a.down.sql"), "SELECT -1;");

        var found = MigrationRunner.Discover(dir);

        Assert.Equal(new[] { "0001_a.up.sql", "0002_b.up.sql" }, found.Select(m => m.Name));
    }

    [Fact]
    public void Pending_skips_applied_migrations()
    {
        var all = new[] { M("0001_a.up.sql", "x"), M("0002_b.up.sql", "y") };
        var applied = new Dictionary<string, string> { ["0001_a.up.sql"] = MigrationRunner.Hash("x") };

        var pending = MigrationRunner.Pending(all, applied);

        Assert.Equal(new[] { "0002_b.up.sql" }, pending.Select(m => m.Name));
    }

    [Fact]
    public void Pending_refuses_an_applied_migration_whose_content_changed()
    {
        var all = new[] { M("0001_a.up.sql", "changed") };
        var applied = new Dictionary<string, string> { ["0001_a.up.sql"] = MigrationRunner.Hash("original") };

        var e = Assert.Throws<InvalidOperationException>(() => MigrationRunner.Pending(all, applied));
        Assert.Contains("0001_a.up.sql", e.Message);
    }

    [Fact]
    public void Hash_ignores_windows_line_endings()
    {
        Assert.Equal(MigrationRunner.Hash("a\nb"), MigrationRunner.Hash("a\r\nb"));
    }

    [Fact]
    public void Repository_migrations_are_discovered_in_order()
    {
        var repoMigrations = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../../db/migrations"));
        if (!Directory.Exists(repoMigrations)) return; // running outside the repository
        var names = MigrationRunner.Discover(repoMigrations).Select(m => m.Name).ToList();
        Assert.Equal(names.OrderBy(n => n, StringComparer.Ordinal), names);
        Assert.Contains("0001_initial_schema.up.sql", names);
        Assert.Contains("0002_permissions_roles_grants.up.sql", names);
    }

    private static MigrationRunner.Migration M(string name, string sql) => new(name, sql, MigrationRunner.Hash(sql));
}
