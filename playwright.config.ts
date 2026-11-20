import { defineConfig, devices } from '@playwright/test';
import { environment, runConfig } from './config/environment';
import { resolveTarget, TARGET } from './config/targets';

const target = resolveTarget();
// no-code cases (all apps share one runner) + the current app's code tests
const TEST_MATCH = ['tests/cases.spec.ts', 'tests/flows.spec.ts', `apps/${environment.app}/tests/**/*.spec.ts`];
const isCI = !!process.env.CI;

export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: runConfig.retries,
  workers: runConfig.workers,          // browsers at the same time (Project → Running tests, or WORKERS=…)
  timeout: runConfig.testTimeout,
  expect: { timeout: runConfig.waitTimeout },
  outputDir: 'reports/artifacts',

  reporter: [
    ['list'],
    ['./reporters/smart-reporter.ts', { outputFolder: 'reports/smart-report', title: `${environment.appName} — Smart Report`, open: 'always' }], // always | on-failure | never (REPORT_OPEN=...)
    ['html', { outputFolder: 'reports/playwright-html', open: 'never' }], // engineers' debug view
  ],

  use: {
    baseURL: environment.baseURL,
    ignoreHTTPSErrors: environment.ignoreHTTPSErrors,
    httpCredentials: environment.httpCredentials,
    testIdAttribute: environment.testIdAttribute,
    actionTimeout: runConfig.waitTimeout * 2,
    navigationTimeout: Math.max(30_000, runConfig.waitTimeout * 3),
    locale: environment.locale === 'ar' ? 'ar-JO' : 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: process.env.VIDEO === 'on' ? 'on' : 'retain-on-failure',   // VIDEO=on → record every test
    launchOptions: { slowMo: Number(process.env.SLOWMO ?? 0) },        // SLOWMO=500 → watch each action
    connectOptions: target.connectOptions,
  },

  projects: [
    { name: 'setup', testMatch: 'tests/setup/*.setup.ts' },
    {
      name: 'chromium',
      dependencies: ['setup'],
      testMatch: TEST_MATCH,
      use: { ...devices['Desktop Chrome'], channel: target.channel },
    },
    // Enable when needed — same tests, more browsers:
    // { name: 'firefox', dependencies: ['setup'], testMatch: TEST_MATCH, use: { ...devices['Desktop Firefox'] } },
    // { name: 'webkit',  dependencies: ['setup'], testMatch: TEST_MATCH, use: { ...devices['Desktop Safari'] } },
    // { name: 'mobile',  dependencies: ['setup'], testMatch: TEST_MATCH, use: { ...devices['Pixel 7'] } },
  ],

  // The bundled demo app starts automatically when the environment has startDemoApp: true (app.yml).
  webServer: environment.startDemoApp
    ? { command: 'node demo-app/server.js', url: environment.baseURL, reuseExistingServer: !isCI || process.env.ATIMTHA_DEMO_SHARED === '1', timeout: 15_000 }
    : undefined,

  metadata: { app: environment.app, env: environment.name, target: TARGET, locale: environment.locale, seed: environment.seed },
});
