namespace Atimtha.Api.Integrations;

/// <summary>
/// Resolves secrets-manager references for the platform's own outbound calls (integration credentials), with the same
/// syntax the agent uses: <c>vault:env/NAME</c> (process environment) and <c>vault:file/name</c> (a file under
/// <c>Secrets:Directory</c>, default /run/secrets, as Docker and Kubernetes mount them). Values are never logged or stored.
/// </summary>
public sealed class SecretResolver(IConfiguration configuration)
{
    public string? Resolve(string? reference)
    {
        if (string.IsNullOrWhiteSpace(reference)) return null;
        if (reference.StartsWith("vault:env/", StringComparison.Ordinal))
        {
            var name = reference["vault:env/".Length..];
            return IsName(name) ? Environment.GetEnvironmentVariable(name) : null;
        }
        if (reference.StartsWith("vault:file/", StringComparison.Ordinal))
        {
            var name = reference["vault:file/".Length..];
            if (!IsName(name)) return null;   // no "..", no separators: stays inside the secrets folder
            var folder = Path.GetFullPath(configuration["Secrets:Directory"] ?? "/run/secrets");
            var path = Path.GetFullPath(Path.Combine(folder, name));
            if (!path.StartsWith(folder, StringComparison.Ordinal) || !File.Exists(path)) return null;
            return File.ReadAllText(path).TrimEnd('\r', '\n');
        }
        return null;
    }

    public static bool IsReference(string? value) =>
        value is not null && (value.StartsWith("vault:env/", StringComparison.Ordinal) || value.StartsWith("vault:file/", StringComparison.Ordinal));

    private static bool IsName(string name) =>
        name.Length is > 0 and <= 128 && name.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-' or '.') && !name.Contains("..");
}
