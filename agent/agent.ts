/**
 * Atimtha execution agent (backlog §10, ADR-0014, ADR-0015). Runs next to the applications under test — on a
 * central server, a tester's machine or inside a client network — and only ever calls OUT to the platform.
 *
 *   ATIMTHA_PLATFORM_URL=https://atimtha.client.local  ATIMTHA_AGENT_TOKEN=atk_…  npm run agent
 *
 * Loop: heartbeat → claim a job → write its project snapshot as apps/job-<id>/ → resolve secret references →
 * run the engine's own runner (Playwright, tests/cases.spec.ts + flows.spec.ts) → stream results → clean up.
 * A job is data; this agent never runs a command it receives (there is no such field in the contract).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { APPS_DIR, ROOT } from '../src/core/app';
import { writeSnapshot, type ProjectSnapshot } from '../src/core/snapshot';
import { resolveSecrets } from './secrets';
import { send } from '../reporters/agent-reporter';

export const AGENT_VERSION = '1.0.0-dev';

interface Job {
  contract: string;
  jobId: string;
  executionId: string;
  organizationId: string;
  engine: 'web' | 'api';
  project: ProjectSnapshot;
  environment: { key: string; baseURL: string; secretRefs?: Record<string, string> };
  selection: { cases?: string[] | null; rows?: string[] | null; tags?: string[] | null; suite?: string | null; grep?: string | null };
  settings: { locale?: 'en' | 'ar'; workers?: number; retries?: number; healing?: string; testTimeoutSeconds?: number; seed?: number };
  expiresAt: string;
}

const config = {
  platform: (process.env.ATIMTHA_PLATFORM_URL ?? '').replace(/\/+$/, ''),
  token: process.env.ATIMTHA_AGENT_TOKEN ?? '',
  engines: (process.env.ATIMTHA_AGENT_ENGINES ?? 'web,api').split(',').map((e) => e.trim()).filter(Boolean),
  pollSeconds: Number(process.env.ATIMTHA_POLL_SECONDS ?? 5),
  heartbeatSeconds: 15,
};

const log = (level: 'info' | 'warn' | 'error', message: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), level, message, ...extra }));

const PW_CLI = path.join(ROOT, 'node_modules/@playwright/test/cli.js');

let running: { job: Job; child: ChildProcess; cancelled: boolean } | undefined;
let stopping = false;

async function api<T>(method: 'POST', route: string, body?: unknown): Promise<{ status: number; data?: T }> {
  const res = await fetch(`${config.platform}/api/agent/v1${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `AtimthaAgent ${config.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return { status: 204 };
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} → HTTP ${res.status} ${text.slice(0, 300)}`);
  return { status: res.status, data: text ? (JSON.parse(text) as T) : undefined };
}

async function heartbeat() {
  try {
    const { data } = await api<{ cancel?: string[] }>('POST', '/heartbeat', { version: AGENT_VERSION, capabilities: { engines: config.engines, os: `${os.platform()} ${os.release()}` } });
    if (running && data?.cancel?.includes(running.job.executionId)) cancel('cancelled from the platform');
  } catch (e) {
    log('warn', 'heartbeat failed', { error: (e as Error).message });
  }
}

function cancel(reason: string) {
  if (!running || running.cancelled) return;
  running.cancelled = true;
  log('info', 'stopping the run', { executionId: running.job.executionId, reason });
  running.child.kill('SIGTERM');
  setTimeout(() => running?.child.kill('SIGKILL'), 15_000).unref();
}

/** environment for the engine's runner — built from data only, never from strings the job could turn into code */
export function runnerEnv(job: Job, appKey: string, summaryFile: string): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP, TMP: process.env.TMP, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
    BROWSER_CHANNEL: process.env.BROWSER_CHANNEL,
    CI: 'true', REPORT_OPEN: 'never', DISCOVER: '1',
    APP: appKey,
    ENV: job.environment.key,
    BASE_URL: job.environment.baseURL,
    LOCALE: job.settings.locale === 'ar' ? 'ar' : 'en',
    HEALING: ['pass', 'flag', 'off'].includes(String(job.settings.healing)) ? String(job.settings.healing) : 'pass',
    AGENT_EVENTS_URL: `${config.platform}/api/agent/v1/jobs/${job.executionId}/events`,
    AGENT_TOKEN: config.token,
    AGENT_SUMMARY_FILE: summaryFile,
  };
  const int = (v: unknown, lo: number, hi: number) => (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? String(v) : undefined);
  e.SEED = int(job.settings.seed, 0, Number.MAX_SAFE_INTEGER);
  e.WORKERS = int(job.settings.workers, 1, 16);
  e.RETRIES = int(job.settings.retries, 0, 3);
  e.TEST_TIMEOUT = int(job.settings.testTimeoutSeconds, 5, 900);
  const list = (v?: string[] | null) => (v ?? []).filter((x) => /^[\w.@-]{1,150}$/.test(x)).join(',');
  if (job.selection.cases?.length) e.ONLY_CASES = list(job.selection.cases);
  if (job.selection.rows?.length) e.ONLY_ROWS = list(job.selection.rows);
  if (job.selection.suite && /^[\w-]{1,100}$/.test(job.selection.suite)) e.SUITE = job.selection.suite;
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return e;
}

/** Playwright arguments: the runner, our reporters, and a grep built from tags — values escaped, nothing else */
export function runnerArgs(job: Job): string[] {
  const args = [PW_CLI, 'test', '--reporter=list,./reporters/agent-reporter.ts'];
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tags = (job.selection.tags ?? []).filter((t) => /^@?[\w-]{1,100}$/.test(t)).map((t) => escape(t.startsWith('@') ? t : `@${t}`));
  const parts = [...(tags.length ? [`(${tags.join('|')})`] : []), ...(job.selection.grep ? [escape(job.selection.grep.slice(0, 200))] : [])];
  if (parts.length) args.push(`--grep=${parts.join('.*')}`);
  return args;
}

async function runJob(job: Job) {
  const events = (list: unknown[]) => send(`${config.platform}/api/agent/v1/jobs/${job.executionId}/events`, config.token, list);
  const finish = (status: 'passed' | 'failed' | 'error' | 'cancelled', extra: Record<string, unknown> = {}) => events([{ type: 'job.finished', status, ...extra }]);

  if (job.contract !== 'atimtha.job/1') return void (await finish('error', { error: `Unsupported job contract ${job.contract}` }));
  if (!config.engines.includes(job.engine)) return void (await finish('error', { error: `This agent does not run "${job.engine}" jobs` }));
  if (Date.parse(job.expiresAt) < Date.now()) return void (await finish('error', { error: 'The job expired before it started' }));

  const appKey = `job-${job.executionId.replace(/[^a-f0-9]/gi, '').slice(0, 12).toLowerCase()}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'atimtha-job-'));
  const summaryFile = path.join(work, 'summary.json');
  const { secrets, missing } = resolveSecrets(job.environment.secretRefs);
  try {
    if (missing.length) log('warn', 'secret references not resolved on this agent', { executionId: job.executionId, missing });
    writeSnapshot(job.project, APPS_DIR, { as: appKey, overwrite: true, secrets });
    await events([{ type: 'job.started', agentVersion: AGENT_VERSION }]);
    log('info', 'job started', { executionId: job.executionId, project: job.project.key, environment: job.environment.key });

    const child = spawn(process.execPath, runnerArgs(job), { cwd: ROOT, env: runnerEnv(job, appKey, summaryFile), stdio: ['ignore', 'inherit', 'inherit'] });
    running = { job, child, cancelled: false };
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    const wasCancelled = running.cancelled;
    running = undefined;

    const summary = fs.existsSync(summaryFile) ? (JSON.parse(fs.readFileSync(summaryFile, 'utf8')) as { status: string; counts: Record<string, number> }) : undefined;
    if (wasCancelled) await finish('cancelled', summary ? { counts: summary.counts } : {});
    else if (!summary) await finish('error', { error: `The test runner stopped before reporting (exit code ${code}).` });
    else await finish(summary.status === 'passed' ? 'passed' : 'failed', { counts: summary.counts });
    log('info', 'job finished', { executionId: job.executionId, exitCode: code, cancelled: wasCancelled, counts: summary?.counts });
  } catch (e) {
    log('error', 'job failed', { executionId: job.executionId, error: (e as Error).message });
    await finish('error', { error: (e as Error).message.slice(0, 2000) });
  } finally {
    // the project, its secrets and saved sessions never outlive the job
    fs.rmSync(path.join(APPS_DIR, appKey), { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, '.auth', appKey), { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  if (!/^https?:\/\//.test(config.platform) || !config.token.startsWith('atk_')) {
    console.error('Set ATIMTHA_PLATFORM_URL (https://…) and ATIMTHA_AGENT_TOKEN (atk_…).');
    process.exit(2);
  }
  if (!config.platform.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(config.platform))
    log('warn', 'the platform address is not HTTPS: use HTTPS outside local development');

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      stopping = true;
      cancel(`agent received ${signal}`);
    });
  }

  log('info', 'agent started', { version: AGENT_VERSION, platform: config.platform, engines: config.engines });
  await heartbeat();
  const beat = setInterval(heartbeat, config.heartbeatSeconds * 1000);

  while (!stopping) {
    try {
      const { status, data } = await api<Job>('POST', '/jobs/claim');
      if (status === 200 && data) {
        await runJob(data);
        continue; // look for the next job straight away
      }
    } catch (e) {
      log('warn', 'claim failed', { error: (e as Error).message });
    }
    await new Promise((r) => setTimeout(r, config.pollSeconds * 1000));
  }
  clearInterval(beat);
  log('info', 'agent stopped');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((e) => {
    log('error', 'agent crashed', { error: (e as Error).message });
    process.exit(1);
  });
}
