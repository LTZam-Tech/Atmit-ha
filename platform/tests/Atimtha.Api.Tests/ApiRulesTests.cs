using Atimtha.Api.Identity;
using Atimtha.Api.Infrastructure;
using Atimtha.Api.Workspaces;
using Microsoft.AspNetCore.Authorization;
using Microsoft.Extensions.Options;

namespace Atimtha.Api.Tests;

public sealed class ApiRulesTests
{
    [Theory]
    [InlineData("TestIdAttribute", "test_id_attribute")]
    [InlineData("OrganizationId", "organization_id")]
    [InlineData("RunTestTimeoutS", "run_test_timeout_s")]
    [InlineData("HttpPasswordSecretRef", "http_password_secret_ref")]
    [InlineData("Id", "id")]
    [InlineData("Ip", "ip")]
    public void Property_names_map_to_the_sql_columns(string property, string column) =>
        Assert.Equal(column, AtimthaDbContext.ToSnakeCase(property));

    [Theory]
    [InlineData("demo", true)]
    [InlineData("qa-team-2", true)]
    [InlineData("Demo", false)]
    [InlineData("2demo", false)]
    [InlineData("-demo", false)]
    [InlineData("de mo", false)]
    [InlineData("", false)]
    public void Keys_follow_the_0_1_0_project_key_pattern(string key, bool valid) =>
        Assert.Equal(valid, Api.KeyPattern().IsMatch(key));

    [Fact]
    public void Validation_collects_every_field_error()
    {
        var v = new Api.Validation().Key("Bad Key").Text("", "name", 10).HttpUrl("ftp://x", "baseUrl");
        Assert.False(v.IsValid);
    }

    [Fact]
    public void Validation_accepts_good_input()
    {
        var v = new Api.Validation().Key("demo").Text("Demo shop", "name", 200).HttpUrl("https://uat.example.com/app", "baseUrl");
        Assert.True(v.IsValid);
    }

    [Theory]
    [InlineData("pass", HealingPolicy.Pass)]
    [InlineData("FLAG", HealingPolicy.Flag)]
    [InlineData("off", HealingPolicy.Off)]
    [InlineData(null, null)]
    [InlineData("sometimes", null)]
    public void Healing_policy_names_match_the_engine(string? value, HealingPolicy? expected) =>
        Assert.Equal(expected, ProjectEndpoints.ParseHealing(value));

    [Fact]
    public void Run_settings_use_the_0_1_0_limits()
    {
        var bad = new Api.Validation();
        ProjectEndpoints.ValidateSettings(bad, "data testid", ["fr"], "maybe", new RunSettingsDto(17, 4, 1, 121));
        Assert.False(bad.IsValid);

        var good = new Api.Validation();
        ProjectEndpoints.ValidateSettings(good, "data-test", ["en", "ar"], "flag", new RunSettingsDto(16, 3, 900, 120));
        Assert.True(good.IsValid);
    }

    [Fact]
    public async Task Permission_policies_exist_only_for_known_permissions()
    {
        var provider = new PermissionPolicyProvider(Options.Create(new AuthorizationOptions()));

        var known = await provider.GetPolicyAsync(Permissions.Policy(Permissions.ProjectEdit));
        Assert.NotNull(known);
        Assert.Contains(known!.Requirements, r => r is PermissionRequirement { Permission: Permissions.ProjectEdit });

        Assert.Null(await provider.GetPolicyAsync(Permissions.Policy("project.everything")));
    }

    [Fact]
    public void Workspace_scope_all_or_listed()
    {
        var a = Guid.NewGuid();
        var b = Guid.NewGuid();
        Assert.True(new WorkspaceScope(true, new HashSet<Guid>()).Includes(a));
        Assert.True(new WorkspaceScope(false, new HashSet<Guid> { a }).Includes(a));
        Assert.False(new WorkspaceScope(false, new HashSet<Guid> { a }).Includes(b));
        Assert.False(WorkspaceScope.None.Any);
    }

    [Fact]
    public void Etag_and_if_match()
    {
        var at = new DateTimeOffset(2026, 11, 18, 10, 0, 0, TimeSpan.Zero);
        var ctx = new Microsoft.AspNetCore.Http.DefaultHttpContext();
        Assert.True(Api.IfMatch(ctx.Request, at)); // no header: allowed
        ctx.Request.Headers.IfMatch = Api.ETag(at);
        Assert.True(Api.IfMatch(ctx.Request, at));
        Assert.False(Api.IfMatch(ctx.Request, at.AddSeconds(1)));
    }
}
