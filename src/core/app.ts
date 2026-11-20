/**
 * Application registry — every web application under test lives in apps/<app>/:
 *
 *   apps/<app>/app.yml        name, environments, login, users        (committed)
 *   apps/<app>/secrets.yml    passwords / basic-auth                  (git-ignored)
 *   apps/<app>/messages.yml   expected UI messages per language
 *   apps/<app>/or/            Smart OR — one YAML per page
 *   apps/<app>/cases/         no-code test cases (YAML)
 *   apps/<app>/tests/         optional code tests (TypeScript)
 *
 * Current app: APP env var → apps/.current → "demo".
 * Any string value may use ${ENV_VAR} (resolved from the process environment, e.g. on CI).
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import Ajv from 'ajv';

export const ROOT = path.resolve(import.meta.dirname, '../..');
export const APPS_DIR = path.join(ROOT, 'apps');
const CURRENT_FILE = path.join(APPS_DIR, '.current');

export interface AppEnvironment {
  baseURL: string;
  startDemoApp?: boolean;
  ignoreHTTPSErrors?: boolean;
  httpCredentials?: { username: string; password: string };
}
export interface AppUser { username: string; password?: string; description?: string }
export interface AppConfig {
  key: string;
  name: string;
  description?: string;
  testIdAttribute: string;
  languages: ('en' | 'ar')[];
  defaultEnv?: string;
  branding?: string;
  /** mobile engine: the Appium server and the app/device capabilities (src/core/mobile-engine) */
  mobile?: { appiumUrl?: string; capabilities: Record<string, unknown>; waitTimeoutMs?: number };
  /** API engine: named requests that steps reuse with `request: { use: name, …overrides }` */
  api?: { requests?: Record<string, Record<string, unknown>> };
  environments: Record<string, AppEnvironment>;
  login?: {
    page: string;
    fields: { username: string; password: string; submit: string };
    success?: { element?: string; urlContains?: string };
  };
  users: Record<string, AppUser>;
  messages: Record<string, Record<string, string>>;
  /** parallel browsers, timeouts (seconds) and retries for runs */
  /** healing: self-healing policy pass | flag | off (src/core/healing.ts) */
  run?: { workers?: number; retries?: number; testTimeout?: number; waitTimeout?: number; healing?: 'pass' | 'flag' | 'off' };
}

const validate = new Ajv({ allErrors: true, allowUnionTypes: true }).compile<any>(
  JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'app.schema.json'), 'utf8')),
);

export const appDir = (app: string) => path.join(APPS_DIR, app);
export const orDir = (app: string) => path.join(appDir(app), 'or');
export const casesDir = (app: string) => path.join(appDir(app), 'cases');

export function listApps(): string[] {
  if (!fs.existsSync(APPS_DIR)) return [];
  return fs.readdirSync(APPS_DIR).filter((d) => fs.existsSync(path.join(APPS_DIR, d, 'app.yml'))).sort();
}

export function currentApp(): string {
  if (process.env.APP) return process.env.APP;
  if (fs.existsSync(CURRENT_FILE)) {
    const v = fs.readFileSync(CURRENT_FILE, 'utf8').trim();
    if (v && fs.existsSync(path.join(APPS_DIR, v, 'app.yml'))) return v;
  }
  return listApps().includes('demo') ? 'demo' : listApps()[0] ?? 'demo';
}

export function setCurrentApp(app: string) {
  if (!listApps().includes(app)) throw new Error(`App "${app}" not found in apps/`);
  fs.writeFileSync(CURRENT_FILE, app + '\n');
}

const readYaml = (file: string) => (fs.existsSync(file) ? YAML.parse(fs.readFileSync(file, 'utf8')) ?? {} : {});

/** ${VAR} → process.env.VAR (left as-is when not set) */
function interpolate<T>(value: T): T {
  if (typeof value === 'string') return value.replace(/\$\{(\w+)\}/g, (m, k) => process.env[k] ?? m) as T;
  if (Array.isArray(value)) return value.map(interpolate) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v)])) as T;
  return value;
}

export function loadApp(app = currentApp()): AppConfig {
  const file = path.join(appDir(app), 'app.yml');
  if (!fs.existsSync(file)) throw new Error(`[app] apps/${app}/app.yml not found. Apps: ${listApps().join(', ') || '(none)'}`);
  const raw = readYaml(file);
  if (!validate(raw)) {
    const errs = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`);
    throw new Error(`[app] apps/${app}/app.yml is invalid:\n  - ${errs.join('\n  - ')}`);
  }
  const secrets = readYaml(path.join(appDir(app), 'secrets.yml'));
  const users: Record<string, AppUser> = {};
  for (const [k, u] of Object.entries<AppUser>(raw.users ?? {})) users[k] = { ...u, ...(secrets.users?.[k] ?? {}) };
  const environments: Record<string, AppEnvironment> = {};
  for (const [k, e] of Object.entries<AppEnvironment>(raw.environments)) {
    environments[k] = { ...e, ...(secrets.environments?.[k] ?? {}) };
  }
  return interpolate({
    key: app,
    name: raw.name,
    description: raw.description,
    testIdAttribute: raw.testIdAttribute ?? 'data-testid',
    languages: raw.languages ?? ['en'],
    defaultEnv: raw.defaultEnv,
    branding: raw.branding,
    mobile: raw.mobile,
    api: raw.api,
    environments,
    login: raw.login,
    run: raw.run,
    users,
    messages: readYaml(path.join(appDir(app), 'messages.yml')),
  });
}
