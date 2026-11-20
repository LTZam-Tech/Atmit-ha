using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Atimtha.Api.Identity;
using Atimtha.Api.Infrastructure;
using Atimtha.Api.TestAssets;
using Microsoft.EntityFrameworkCore;

namespace Atimtha.Api.Workspaces;

using Api = Atimtha.Api.Infrastructure.Api;

public sealed record LoginFieldsDto(string? Username, string? Password, string? Submit);
public sealed record LoginSuccessDto(string? Element, string? UrlContains);
/// <summary>0.1.0 app.yml "login": the page whose form signs a user in, and how success is recognised.</summary>
public sealed record LoginSettingsDto(string? Page, LoginFieldsDto? Fields, LoginSuccessDto? Success);

/// <summary>
/// Data &amp; Settings of a project (backlog §3 stage 3): expected UI messages ({{msg.key}}, per language) and the login
/// form used to create saved sessions. Edited directly (like environments and test users), audited; agents receive
/// both through the snapshot (SnapshotExporter.ApplyLiveSettingsAsync).
/// </summary>
public static partial class ProjectDataEndpoints
{
    [GeneratedRegex("^[a-zA-Z][a-zA-Z0-9_]{0,99}$")]
    private static partial Regex MessageKey();

    public static readonly string[] Locales = ["en", "ar"];

    public static RouteGroupBuilder MapProjectData(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/projects/{projectId:guid}").WithTags("Project data");
        g.MapGet("/messages", GetMessages).RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        g.MapPut("/messages", PutMessages).RequireAuthorization(Permissions.Policy(Permissions.ProjectEdit));
        g.MapGet("/login", GetLogin).RequireAuthorization(Permissions.Policy(Permissions.ProjectView));
        g.MapPut("/login", PutLogin).RequireAuthorization(Permissions.Policy(Permissions.ProjectEdit));
        g.MapDelete("/login", DeleteLogin).RequireAuthorization(Permissions.Policy(Permissions.ProjectEdit));
        return api;
    }

    // ---------------------------------------------------------------- messages

    private static async Task<IResult> GetMessages(Guid projectId, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        if (await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct) is null) return Api.NotFound("The project");
        return Results.Ok(await MessagesAsync(db, projectId, ct));
    }

    /// <summary>{ en: { key: text }, ar: { key: text } }: the whole set is replaced.</summary>
    private static async Task<IResult> PutMessages(Guid projectId, JsonObject body, AtimthaDbContext db, AccessService access, AuditWriter audit, CancellationToken ct)
    {
        var project = await Editable(projectId, db, access, ct);
        if (project is null) return Api.NotFound("The project");
        if (!await access.HasInWorkspaceAsync(Permissions.ProjectEdit, project.WorkspaceId, ct)) return Api.Forbidden("You cannot edit this project.");

        var v = new Api.Validation();
        var rows = new List<ExpectedMessage>();
        foreach (var (locale, node) in body)
        {
            if (!Locales.Contains(locale)) { v.Require(false, locale, "Use the languages en and ar."); continue; }
            if (node is not JsonObject map) { v.Require(false, locale, "A map of message key → text."); continue; }
            foreach (var (key, textNode) in map)
            {
                var text = textNode is JsonValue tv && tv.TryGetValue<string>(out var t) ? t : null;
                v.Require(MessageKey().IsMatch(key), $"{locale}.{key}", "Keys use letters, digits and _, starting with a letter.");
                v.Require(text is not null && text.Length <= 2000, $"{locale}.{key}", "A text of at most 2000 characters.");
                if (text is not null) rows.Add(new ExpectedMessage { Id = Guid.NewGuid(), OrganizationId = project.OrganizationId, ProjectId = projectId, Locale = locale, Key = key, Text = text });
            }
        }
        v.Require(rows.Count <= 2000, "messages", "At most 2000 messages.");
        if (!v.IsValid) return v.Problem();

        db.Messages.RemoveRange(await db.Messages.Where(m => m.ProjectId == projectId).ToListAsync(ct));
        await db.SaveChangesAsync(ct);
        db.Messages.AddRange(rows);
        audit.Add("project.messages", "project", projectId, new { project = project.Key, messages = rows.Count });
        await db.SaveChangesAsync(ct);
        return Results.Ok(await MessagesAsync(db, projectId, ct));
    }

    internal static async Task<JsonObject> MessagesAsync(AtimthaDbContext db, Guid projectId, CancellationToken ct)
    {
        var rows = await db.Messages.AsNoTracking().Where(m => m.ProjectId == projectId).OrderBy(m => m.Key).ToListAsync(ct);
        var o = new JsonObject();
        foreach (var g in rows.GroupBy(r => r.Locale).OrderBy(g => g.Key == "en" ? 0 : 1))
            o[g.Key] = new JsonObject(g.Select(r => KeyValuePair.Create(r.Key, (JsonNode?)JsonValue.Create(r.Text))));
        return o;
    }

    // ---------------------------------------------------------------- login

    private static async Task<IResult> GetLogin(Guid projectId, AtimthaDbContext db, AccessService access, CancellationToken ct)
    {
        if (await ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct) is null) return Api.NotFound("The project");
        return Results.Ok(await LoginAsync(db, projectId, ct) ?? new LoginSettingsDto(null, null, null));
    }

    private static async Task<IResult> PutLogin(Guid projectId, LoginSettingsDto body, AtimthaDbContext db, AccessService access, AuditWriter audit, CancellationToken ct)
    {
        var project = await Editable(projectId, db, access, ct);
        if (project is null) return Api.NotFound("The project");
        if (!await access.HasInWorkspaceAsync(Permissions.ProjectEdit, project.WorkspaceId, ct)) return Api.Forbidden("You cannot edit this project.");

        var page = body.Page is null ? null : await db.Pages.AsNoTracking().FirstOrDefaultAsync(p => p.ProjectId == projectId && p.Key == body.Page, ct);
        var elements = page is null ? new Dictionary<string, Guid>()
            : await db.Elements.AsNoTracking().Where(e => e.PageId == page.Id).ToDictionaryAsync(e => e.Key, e => e.Id, ct);
        Guid? El(string? key) => key is not null && elements.TryGetValue(key, out var id) ? id : null;

        // the success element may live on any page: "inventory.title"
        Guid? successId = null;
        if (body.Success?.Element is { Length: > 0 } successRef)
        {
            var parts = successRef.Split('.', 2);
            if (parts.Length == 2)
                successId = await (from e in db.Elements.AsNoTracking()
                                   join p in db.Pages.AsNoTracking() on e.PageId equals p.Id
                                   where p.ProjectId == projectId && p.Key == parts[0] && e.Key == parts[1]
                                   select (Guid?)e.Id).FirstOrDefaultAsync(ct);
        }
        var v = new Api.Validation()
            .Require(page is not null, "page", "Choose a page of this project.")
            .Require(El(body.Fields?.Username) is not null, "fields.username", "An element of the login page.")
            .Require(El(body.Fields?.Password) is not null, "fields.password", "An element of the login page.")
            .Require(El(body.Fields?.Submit) is not null, "fields.submit", "An element of the login page.")
            .Require(body.Success?.Element is null or "" || successId is not null, "success.element", "Use page.element of this project.")
            .Require(body.Success?.UrlContains is null || body.Success.UrlContains.Length <= 300, "success.urlContains", "At most 300 characters.");
        if (!v.IsValid) return v.Problem();

        var row = await db.LoginConfigs.FirstOrDefaultAsync(l => l.ProjectId == projectId, ct);
        if (row is null) row = db.LoginConfigs.Add(new LoginConfig { ProjectId = projectId, OrganizationId = project.OrganizationId }).Entity;
        row.PageId = page!.Id;
        row.UsernameElementId = El(body.Fields!.Username)!.Value;
        row.PasswordElementId = El(body.Fields.Password)!.Value;
        row.SubmitElementId = El(body.Fields.Submit)!.Value;
        row.SuccessElementId = successId;
        row.SuccessUrlContains = string.IsNullOrWhiteSpace(body.Success?.UrlContains) ? null : body.Success.UrlContains.Trim();
        audit.Add("project.login", "project", projectId, new { project = project.Key, page = body.Page });
        await db.SaveChangesAsync(ct);
        return Results.Ok(await LoginAsync(db, projectId, ct));
    }

    private static async Task<IResult> DeleteLogin(Guid projectId, AtimthaDbContext db, AccessService access, AuditWriter audit, CancellationToken ct)
    {
        var project = await Editable(projectId, db, access, ct);
        if (project is null) return Api.NotFound("The project");
        if (!await access.HasInWorkspaceAsync(Permissions.ProjectEdit, project.WorkspaceId, ct)) return Api.Forbidden("You cannot edit this project.");
        var row = await db.LoginConfigs.FirstOrDefaultAsync(l => l.ProjectId == projectId, ct);
        if (row is not null)
        {
            db.LoginConfigs.Remove(row);
            audit.Add("project.login_remove", "project", projectId, new { project = project.Key });
            await db.SaveChangesAsync(ct);
        }
        return Results.NoContent();
    }

    internal static async Task<LoginSettingsDto?> LoginAsync(AtimthaDbContext db, Guid projectId, CancellationToken ct)
    {
        var row = await db.LoginConfigs.AsNoTracking().FirstOrDefaultAsync(l => l.ProjectId == projectId, ct);
        if (row is null) return null;
        var ids = new[] { row.UsernameElementId, row.PasswordElementId, row.SubmitElementId, row.SuccessElementId ?? Guid.Empty };
        var names = await (from e in db.Elements.AsNoTracking()
                           join p in db.Pages.AsNoTracking() on e.PageId equals p.Id
                           where ids.Contains(e.Id)
                           select new { e.Id, Page = p.Key, e.Key }).ToDictionaryAsync(x => x.Id, ct);
        var pageKey = await db.Pages.AsNoTracking().Where(p => p.Id == row.PageId).Select(p => p.Key).FirstOrDefaultAsync(ct);
        string? Name(Guid id) => names.TryGetValue(id, out var n) ? n.Key : null;
        var success = row.SuccessElementId is Guid s && names.TryGetValue(s, out var se) ? $"{se.Page}.{se.Key}" : null;
        return new LoginSettingsDto(pageKey, new LoginFieldsDto(Name(row.UsernameElementId), Name(row.PasswordElementId), Name(row.SubmitElementId)),
            success is null && row.SuccessUrlContains is null ? null : new LoginSuccessDto(success, row.SuccessUrlContains));
    }

    /// <summary>The 0.1.0 app.yml "login" block, or null.</summary>
    internal static async Task<JsonObject?> LoginBlockAsync(AtimthaDbContext db, Guid projectId, CancellationToken ct)
    {
        var l = await LoginAsync(db, projectId, ct);
        if (l?.Page is null || l.Fields is null) return null;
        var o = new JsonObject
        {
            ["page"] = l.Page,
            ["fields"] = new JsonObject { ["username"] = l.Fields.Username, ["password"] = l.Fields.Password, ["submit"] = l.Fields.Submit },
        };
        if (l.Success is not null)
        {
            var s = new JsonObject();
            if (l.Success.Element is not null) s["element"] = l.Success.Element;
            if (l.Success.UrlContains is not null) s["urlContains"] = l.Success.UrlContains;
            o["success"] = s;
        }
        return o;
    }

    private static Task<Project?> Editable(Guid projectId, AtimthaDbContext db, AccessService access, CancellationToken ct) =>
        ProjectEndpoints.Visible(projectId, Permissions.ProjectView, db, access, ct);
}
