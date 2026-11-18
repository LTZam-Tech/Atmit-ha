using System.Security.Cryptography;
using System.Text;
using Npgsql;

namespace Atimtha.Api.Infrastructure;

/// <summary>
/// Applies db/migrations/NNNN_name.up.sql in order (ADR-0013). Each file runs once; its SHA-256 is recorded so an
/// edited, already-applied migration is detected instead of silently diverging. Run with: <c>Atimtha.Api migrate</c>,
/// using the owner connection string (ConnectionStrings:Migrations), never the application's RLS-bound role.
/// </summary>
public sealed class MigrationRunner(string connectionString, string directory, ILogger logger)
{
    private const string Ledger = "public.atimtha_schema_migration";

    public sealed record Migration(string Name, string Sql, string Sha256);

    /// <summary>The *.up.sql files of a folder, ordered by name (0001_, 0002_ …).</summary>
    public static IReadOnlyList<Migration> Discover(string directory)
    {
        if (!Directory.Exists(directory)) throw new DirectoryNotFoundException($"Migrations folder not found: {directory}");
        return Directory.GetFiles(directory, "*.up.sql")
            .Select(path => new { path, name = Path.GetFileName(path) })
            .OrderBy(f => f.name, StringComparer.Ordinal)
            .Select(f =>
            {
                var sql = File.ReadAllText(f.path, Encoding.UTF8);
                return new Migration(f.name, sql, Hash(sql));
            })
            .ToList();
    }

    /// <summary>Migrations still to apply; throws when an applied migration's content changed.</summary>
    public static IReadOnlyList<Migration> Pending(IReadOnlyList<Migration> all, IReadOnlyDictionary<string, string> applied)
    {
        foreach (var m in all)
        {
            if (applied.TryGetValue(m.Name, out var sha) && sha != m.Sha256)
                throw new InvalidOperationException($"Migration {m.Name} was changed after it was applied (checksum differs). Add a new migration instead.");
        }
        return all.Where(m => !applied.ContainsKey(m.Name)).ToList();
    }

    public static string Hash(string sql) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sql.Replace("\r\n", "\n")))).ToLowerInvariant();

    public async Task<int> RunAsync(CancellationToken ct = default)
    {
        var all = Discover(directory);
        await using var conn = new NpgsqlConnection(connectionString);
        await conn.OpenAsync(ct);

        await using (var create = new NpgsqlCommand(
            $"CREATE TABLE IF NOT EXISTS {Ledger} (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())", conn))
            await create.ExecuteNonQueryAsync(ct);

        // one runner at a time
        await using (var lockCmd = new NpgsqlCommand("SELECT pg_advisory_lock(727274)", conn))
            await lockCmd.ExecuteNonQueryAsync(ct);
        try
        {
            var applied = new Dictionary<string, string>();
            await using (var read = new NpgsqlCommand($"SELECT name, sha256 FROM {Ledger}", conn))
            await using (var reader = await read.ExecuteReaderAsync(ct))
                while (await reader.ReadAsync(ct)) applied[reader.GetString(0)] = reader.GetString(1);

            var pending = Pending(all, applied);
            foreach (var m in pending)
            {
                logger.LogInformation("Applying migration {Migration}", m.Name);
                // the migration files manage their own transaction (BEGIN … COMMIT)
                await using (var run = new NpgsqlCommand(m.Sql, conn) { CommandTimeout = 600 })
                    await run.ExecuteNonQueryAsync(ct);
                await using var record = new NpgsqlCommand($"INSERT INTO {Ledger} (name, sha256) VALUES (@n, @s)", conn);
                record.Parameters.AddWithValue("n", m.Name);
                record.Parameters.AddWithValue("s", m.Sha256);
                await record.ExecuteNonQueryAsync(ct);
            }
            logger.LogInformation("Migrations: {Applied} applied now, {Total} in total", pending.Count, all.Count);
            return pending.Count;
        }
        finally
        {
            await using var unlock = new NpgsqlCommand("SELECT pg_advisory_unlock(727274)", conn);
            await unlock.ExecuteNonQueryAsync(CancellationToken.None);
        }
    }
}
