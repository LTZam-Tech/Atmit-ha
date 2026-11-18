using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Atimtha.Api.Infrastructure;

/// <summary>Shared API helpers: validation, problem responses, ETags (docs/architecture/target-architecture.md §7).</summary>
public static partial class Api
{
    [GeneratedRegex("^[a-z][a-z0-9-]{0,62}$")]
    public static partial Regex KeyPattern();

    [GeneratedRegex("^[a-zA-Z][a-zA-Z0-9_-]{0,62}$")]
    public static partial Regex AttributePattern();

    /// <summary>Collects field errors and turns them into a 400 problem response.</summary>
    public sealed class Validation
    {
        private readonly Dictionary<string, List<string>> errors = new(StringComparer.Ordinal);

        public Validation Require(bool ok, string field, string message)
        {
            if (!ok)
            {
                if (!errors.TryGetValue(field, out var list)) errors[field] = list = [];
                list.Add(message);
            }
            return this;
        }

        public Validation Key(string? value, string field = "key") =>
            Require(value is not null && KeyPattern().IsMatch(value), field, "Use lowercase letters, digits and \"-\", starting with a letter (max 63).");

        public Validation Text(string? value, string field, int max, bool required = true) =>
            Require(!required || !string.IsNullOrWhiteSpace(value), field, "Required.")
                .Require(value is null || value.Length <= max, field, $"At most {max} characters.");

        public Validation HttpUrl(string? value, string field) =>
            Require(Uri.TryCreate(value, UriKind.Absolute, out var u) && (u.Scheme == Uri.UriSchemeHttp || u.Scheme == Uri.UriSchemeHttps),
                field, "Use a full http:// or https:// address.");

        public bool IsValid => errors.Count == 0;
        public IResult Problem() => Results.ValidationProblem(errors.ToDictionary(e => e.Key, e => e.Value.ToArray()));
    }

    public static bool IsUniqueViolation(DbUpdateException e) =>
        e.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation };

    public static IResult Conflict(string detail) => Results.Problem(statusCode: StatusCodes.Status409Conflict, title: "Conflict", detail: detail);

    public static IResult Forbidden(string detail) => Results.Problem(statusCode: StatusCodes.Status403Forbidden, title: "Forbidden", detail: detail);

    /// <summary>Not found — also used for other organisations' data, so its existence is never revealed.</summary>
    public static IResult NotFound(string what) => Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "Not found", detail: $"{what} was not found.");

    public static string ETag(DateTimeOffset updatedAt) => $"\"{updatedAt.UtcTicks}\"";

    /// <summary>true when the request has no If-Match, or it matches the current version</summary>
    public static bool IfMatch(HttpRequest request, DateTimeOffset updatedAt)
    {
        var header = request.Headers.IfMatch.ToString();
        return string.IsNullOrEmpty(header) || header == "*" || header.Split(',').Select(h => h.Trim()).Contains(ETag(updatedAt));
    }
}
