/**
 * Runs once before the browser projects — no code changes needed per application:
 *   1) environment health check
 *   2) one saved session per user that any page needs (auth: <user> in or/*.page.yml),
 *      using the login defined in apps/<app>/app.yml
 */
import { test, expect, authFile } from '../../src/fixtures';
import { appConfig, environment } from '../../config/environment';
import { requiredSessions } from '../../src/core/pages-setup';
import { step } from '../../src/utils/steps';

// Opened in the browser (like a user): many UAT environments sit behind a WAF that rejects
// plain API calls. Any answer below 500 means the server is up (401/403 = up but protected).
test('environment is reachable', async ({ page }) => {
  const res = await page.goto('/', { waitUntil: 'domcontentloaded' });
  const status = res?.status() ?? 0;
  expect(status, `Environment ${environment.baseURL} answered ${status || 'nothing'}`).toBeGreaterThan(0);
  expect(status, `Environment ${environment.baseURL} has a server error (${status})`).toBeLessThan(500);
});

for (const user of requiredSessions()) {
  test(`save session: ${user}`, async ({ ui, page }) => {
    const login = appConfig.login;
    if (!login) throw new Error(`A page needs a "${user}" session but apps/${appConfig.key}/app.yml has no "login" section. Run the Setup Wizard or add it.`);
    const creds = appConfig.users[user];
    if (!creds) throw new Error(`User "${user}" is not defined in apps/${appConfig.key}/app.yml`);
    if (!creds.password) throw new Error(`User "${user}" has no password — add it to apps/${appConfig.key}/secrets.yml`);

    const or = ui.or(login.page);
    await ui.open(login.page);
    await step.enter(`Username = "${creds.username}"`, async () => (await or.el(login.fields.username)).fill(creds.username));
    await step.enter('Password = ••••••••', async () => (await or.el(login.fields.password)).fill(creds.password!));
    await step.click('Login', async () => (await or.el(login.fields.submit)).click());

    await step.verify('Logged in', async () => {
      if (login.success?.element) {
        const [pageKey, element] = login.success.element.split('.');
        await expect(await ui.or(pageKey).el(element)).toBeVisible();
      } else if (login.success?.urlContains) {
        await expect(page).toHaveURL(new RegExp(login.success.urlContains.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      } else {
        await expect(or.locator(login.fields.password)).toBeHidden(); // login form is gone
      }
    }, page);
    await step.setup(`Save session → .auth/${appConfig.key}/${user}.json`, () => page.context().storageState({ path: authFile(user) }));
  });
}
