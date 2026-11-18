/**
 * Run context — which APP, which ENV of that app, which language.
 *
 *   APP=<app>          apps/<app>/  (default: apps/.current, set from the Control Panel)
 *   ENV=<env>          one of the environments in apps/<app>/app.yml (default: first / defaultEnv)
 *   LOCALE=en | ar     language used by the Smart OR and expected messages
 *   SEED=<number>      reproduce the exact generated data of a run
 *   BASE_URL=<url>     override the environment URL for a one-off run
 */
import { currentApp, loadApp } from '../src/core/app';
import { healingPolicy } from '../src/core/healing';

const APP = currentApp();
const app = loadApp(APP);
const ENV = process.env.ENV ?? app.defaultEnv ?? Object.keys(app.environments)[0];
const env = app.environments[ENV];
if (!env) {
  throw new Error(`[config] Environment "${ENV}" not defined for app "${APP}". Available: ${Object.keys(app.environments).join(', ')} — run with ENV=<one of them>, or remove ENV to use the project default`);
}

// One seed per run, shared with all workers through process.env (workers inherit it).
if (!process.env.SEED) process.env.SEED = String(Math.floor(Math.random() * 1_000_000));
// Workers must resolve the same app/env even if apps/.current changes mid-run.
process.env.APP = APP;
process.env.ENV = ENV;

export type Locale = 'en' | 'ar';

export const environment = {
  app: APP,
  appName: app.name,
  name: ENV,
  baseURL: process.env.BASE_URL ?? env.baseURL,
  testIdAttribute: app.testIdAttribute,
  startDemoApp: env.startDemoApp === true,
  ignoreHTTPSErrors: env.ignoreHTTPSErrors === true,
  httpCredentials: env.httpCredentials?.username ? env.httpCredentials : undefined,
  locale: (process.env.LOCALE ?? 'en') as Locale,
  seed: Number(process.env.SEED),
};

export const appConfig = app;

/**
 * How many browsers run at once and how long to wait — apps/<app>/app.yml → run: (Control Panel → Project).
 * Env vars win for one run: WORKERS, RETRIES, TEST_TIMEOUT (s), WAIT_TIMEOUT (s).
 * Default 2 browsers locally: more parallel browsers on a laptop (or against a slow UAT server) cause timeouts.
 */
const num = (v: string | undefined) => (v === undefined || v === '' || isNaN(Number(v)) ? undefined : Number(v));
const isCIRun = !!process.env.CI;
export const runConfig = {
  workers: num(process.env.WORKERS) ?? app.run?.workers ?? (isCIRun ? 4 : 2),
  retries: num(process.env.RETRIES) ?? app.run?.retries ?? (isCIRun ? 1 : 0),
  testTimeout: (num(process.env.TEST_TIMEOUT) ?? app.run?.testTimeout ?? 60) * 1000,
  waitTimeout: (num(process.env.WAIT_TIMEOUT) ?? app.run?.waitTimeout ?? 10) * 1000,
  /** self-healing policy: pass | flag | off (HEALING env var wins) — see src/core/healing.ts */
  healing: healingPolicy(app.run?.healing),
};
