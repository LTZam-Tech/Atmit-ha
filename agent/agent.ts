/**
 * Atimtha execution agent (backlog §10, ADR-0014, ADR-0015). Runs next to the applications under test — on a
 * central server, a tester's machine or inside a client network — and only ever calls OUT to the platform.
 *
 *   ATIMTHA_PLATFORM_URL=https://atimtha.client.local  ATIMTHA_AGENT_TOKEN=atk_…  npm run agent
 *
 * Loop: heartbeat → claim a job → write its project snapshot as apps/job-<id>/ → resolve secret references →
 * run the engine's own runner (Playwright, tests/cases.spec.ts + flows.spec.ts) → stream results → clean up.
 * A job is data; this agent never runs a command it receives (there is no such field in the contract).
 * ATIMTHA_AGENT_SLOTS (1–8, default 1): jobs run at the same time, each in its own folders. The test runner reports
 * with the job's short-lived token (jobToken), never with this agent's own token.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { APPS_DIR, ROOT, loadApp } from '../src/core/app';
import { authFile } from '../src/core/pages-setup';
import { explore, type ExploreInput } from './explore';
import { exportProject } from './export';
import { acquireDemo, isLocal, releaseDemo } from './demo-app';
import { writeSnapshot, type ProjectSnapshot } from '../src/core/snapshot';
import { resolveSecrets } from './secrets';
import { authorization, send, traceparent, useTraceIds } from '../reporters/agent-reporter';
import { SIGNATURE_HEADER, trustedKey, verifyJob, type TrustedKey } from './job-signature';

export const AGENT_VERSION = '1.0.0-dev';

interface Job {
  contract: string;
  jobId: string;
  executionId: string;
  organizationId: string;
  engine: 'web' | 'api' | 'mobile' | 'performance';
  /** run (default): the tests; explore: collect pages; export: Playwright code */
  kind?: 'run' | 'explore' | 'export';
  explore?: ExploreInput;
  /** one slice of a sharded run: Playwright --shard=index/total */
  shard?: { index: number; total: number };
  project: ProjectSnapshot;
  environment: { key: string; baseURL: string; secretRefs?: Record<string, string> };
  selection: { cases?: string[] | null; rows?: string[] | null; tags?: string[] | null; suite?: string | null; grep?: string | null; flows?: string[] | null };
  settings: { locale?: 'en' | 'ar'; workers?: number; retries?: number; healing?: string; testTimeoutSeconds?: number; seed?: number; maxVirtualUsers?: number };
  expiresAt: string;
  /** the agent the platform handed the job to (part of the signed bytes) */
  agentId?: string;
  /** short-lived token for this job only (events, evidence, artifacts); older platforms send none */
  jobToken?: string;
  /** the platform request's trace id: logged on every line of this job and sent back as traceparent */
  traceId?: string;
}

const config = {
  platform: (process.env.ATIMTHA_PLATFORM_URL ?? '').replace(/\/+$/, ''),
  token: process.env.ATIMTHA_AGENT_TOKEN ?? '',
  engines: (process.env.ATIMTHA_AGENT_ENGINES ?? 'web,api').split(',').map((e) => e.trim()).filter(Boolean),
  pollSeconds: Number(process.env.ATIMTHA_POLL_SECONDS ?? 5),
  heartbeatSeconds: 15,
  slots: Math.min(8, Math.max(1, Math.trunc(Number(process.env.ATIMTHA_AGENT_SLOTS ?? 1)) || 1)),
};

/** one JSON line; a line about a job carries that job's trace id */
const log = (level: 'info' | 'warn' | 'error', message: string, extra: Record<string, unknown> = {}) => {
  const traceId = typeof extra.executionId === 'string' ? traceOf(extra.executionId) : undefined;
  console.log(JSON.stringify({ at: new Date().toISOString(), level, message, ...(traceId ? { traceId } : {}), ...extra }));
};
const traceOf = (executionId: string) => {
  const t = running.get(executionId)?.job.traceId;
  return t && /^[0-9a-f]{32}$/.test(t) ? t : undefined;
};
// the reporter's calls for a job carry its trace id too
useTraceIds((url) => {
  const id = /\/jobs\/([0-9a-f-]{36})\//.exec(url)?.[1];
  return id ? traceOf(id) : undefined;
});

const PW_CLI = path.join(ROOT, 'node_modules/@playwright/test/cli.js');

interface Running { job: Job; child?: ChildProcess; cancelled: boolean }
/** jobs that use the agent's shared demo app (environments with startDemoApp) */
const sharedDemo = new Set<string>();
/** jobs in progress, by execution id (at most config.slots) */
const running = new Map<string, Running>();
let trusted: TrustedKey | undefined;
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

/** the key jobs are verified with: pinned (ATIMTHA_JOB_KEY) or the one the platform publishes */
async function loadSigningKey() {
  let published: { keyId: string; publicKeyPem: string; ephemeral?: boolean } | undefined;
  try {
    const res = await fetch(`${config.platform}/api/agent/v1/signing-key`, { headers: { Authorization: `AtimthaAgent ${config.token}` } });
    if (res.ok) published = (await res.json()) as typeof published;
  } catch (e) {
    log('warn', 'could not read the platform signing key', { error: (e as Error).message });
  }
  trusted = trustedKey(published);
  if (published?.ephemeral) log('warn', 'the platform signs jobs with a temporary key (development)');
  log('info', 'job signatures', { keyId: trusted?.keyId ?? null, pinned: trusted?.pinned ?? false, required: process.env.ATIMTHA_REQUIRE_SIGNED_JOBS !== 'false' });
}

/** claims a job and verifies its signature over the exact bytes received; an invalid job is refused, never run */
async function claim(): Promise<Job | undefined> {
  const res = await fetch(`${config.platform}/api/agent/v1/jobs/claim`, { method: 'POST', headers: { Authorization: `AtimthaAgent ${config.token}` } });
  if (res.status === 204) return undefined;
  const text = await res.text();
  if (!res.ok) throw new Error(`POST /jobs/claim → HTTP ${res.status} ${text.slice(0, 300)}`);
  let problem = verifyJob(text, res.headers.get(SIGNATURE_HEADER), trusted);
  if (problem && trusted && !trusted.pinned) {
    // the platform may have rotated its key since the agent started: read it again once
    await loadSigningKey();
    problem = verifyJob(text, res.headers.get(SIGNATURE_HEADER), trusted);
  }
  const job = JSON.parse(text) as Job;
  if (problem) {
    log('error', 'job refused', { executionId: job.executionId, reason: problem });
    await send(`${config.platform}/api/agent/v1/jobs/${job.executionId}/events`, config.token,
      [{ type: 'job.finished', status: 'error', error: `The agent refused the job: ${problem}. Nothing was run.` }]);
    return undefined;
  }
  return job;
}

async function heartbeat() {
  try {
    const { data } = await api<{ cancel?: string[] }>('POST', '/heartbeat', {
      version: AGENT_VERSION, capabilities: { engines: config.engines, slots: config.slots, os: `${os.platform()} ${os.release()}` },
    });
    for (const id of data?.cancel ?? []) cancel(id, 'cancelled from the platform');
  } catch (e) {
    log('warn', 'heartbeat failed', { error: (e as Error).message });
  }
}

function cancel(executionId: string, reason: string) {
  const r = running.get(executionId);
  if (!r || r.cancelled) return;
  r.cancelled = true;
  log('info', 'stopping the run', { executionId, reason });
  r.child?.kill('SIGTERM');
  setTimeout(() => r.child?.kill('SIGKILL'), 15_000).unref();
}

/** the token the test runner reports with: the job's own token when the platform sent one */
const reportToken = (job: Job) => job.jobToken ?? config.token;

/** environment for the engine's runner — built from data only, never from strings the job could turn into code */
export function runnerEnv(job: Job, appKey: string, summaryFile: string, brandingFile?: string, reportDir?: string): NodeJS.ProcessEnv {
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
    AGENT_EVIDENCE_URL: `${config.platform}/api/agent/v1/jobs/${job.executionId}/results`,
    AGENT_EVIDENCE: ['all', 'failed', 'off'].includes(String(process.env.ATIMTHA_EVIDENCE)) ? String(process.env.ATIMTHA_EVIDENCE) : 'failed',
    // the job's short-lived token: test code never sees this agent's own identity
    AGENT_TOKEN: reportToken(job),
    ATIMTHA_TRACE_ID: job.traceId && /^[0-9a-f]{32}$/.test(job.traceId) ? job.traceId : undefined,
    AGENT_SUMMARY_FILE: summaryFile,
    ATIMTHA_BRANDING_FILE: brandingFile,
    REPORT_OUTPUT: reportDir,
    ENGINE: job.engine,
    APPIUM_URL: process.env.APPIUM_URL,
    K6_PATH: process.env.K6_PATH,
    // load caps: the organisation's limit from the job, never above this agent's own limit
    ATIMTHA_MAX_VUS: String(Math.min(Number(job.settings.maxVirtualUsers ?? 0), Number(process.env.ATIMTHA_MAX_VUS ?? 200))),
    ATIMTHA_MAX_LOAD_MINUTES: process.env.ATIMTHA_MAX_LOAD_MINUTES,
    REPORT_HISTORY: '0',
    // the agent already runs the shared demo app for this job: Playwright reuses it instead of starting another
    ATIMTHA_DEMO_SHARED: sharedDemo.has(job.executionId) ? '1' : undefined,
  };
  const int = (v: unknown, lo: number, hi: number) => (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? String(v) : undefined);
  e.SEED = int(job.settings.seed, 0, Number.MAX_SAFE_INTEGER);
  e.WORKERS = int(job.settings.workers, 1, 16);
  e.RETRIES = int(job.settings.retries, 0, 3);
  e.TEST_TIMEOUT = int(job.settings.testTimeoutSeconds, 5, 900);
  const list = (v?: string[] | null) => (v ?? []).filter((x) => /^[\w.@-]{1,150}$/.test(x)).join(',');
  if (job.selection.cases?.length) e.ONLY_CASES = list(job.selection.cases);
  if (job.selection.rows?.length) e.ONLY_ROWS = list(job.selection.rows);
  if (job.selection.flows?.length) e.ONLY_FLOWS = list(job.selection.flows);
  if (job.selection.suite && /^[\w-]{1,100}$/.test(job.selection.suite)) e.SUITE = job.selection.suite;
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return e;
}

/** Playwright arguments: the runner, our reporters, and a grep built from tags — values escaped, nothing else */
export function runnerArgs(job: Job, outputDir?: string): string[] {
  const args = [PW_CLI, 'test', '--reporter=list,./reporters/agent-reporter.ts,./reporters/smart-reporter.ts'];
  // each job keeps its traces, videos and screenshots in its own folder (jobs may run side by side)
  if (outputDir) args.push(`--output=${outputDir}`);
  const sh = job.shard;
  if (sh && Number.isInteger(sh.index) && Number.isInteger(sh.total) && sh.total >= 2 && sh.total <= 8 && sh.index >= 1 && sh.index <= sh.total)
    args.push(`--shard=${sh.index}/${sh.total}`);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tags = (job.selection.tags ?? []).filter((t) => /^@?[\w-]{1,100}$/.test(t)).map((t) => escape(t.startsWith('@') ? t : `@${t}`));
  const parts = [...(tags.length ? [`(${tags.join('|')})`] : []), ...(job.selection.grep ? [escape(job.selection.grep.slice(0, 200))] : [])];
  if (parts.length) args.push(`--grep=${parts.join('.*')}`);
  return args;
}

async function runJob(job: Job) {
  const events = (list: unknown[]) => send(`${config.platform}/api/agent/v1/jobs/${job.executionId}/events`, reportToken(job), list);
  const finish = (status: 'passed' | 'failed' | 'error' | 'cancelled', extra: Record<string, unknown> = {}) => events([{ type: 'job.finished', status, ...extra }]);

  if (job.contract !== 'atimtha.job/1') return void (await finish('error', { error: `Unsupported job contract ${job.contract}` }));
  if (!config.engines.includes(job.engine)) return void (await finish('error', { error: `This agent does not run "${job.engine}" jobs` }));
  if (Date.parse(job.expiresAt) < Date.now()) return void (await finish('error', { error: 'The job expired before it started' }));

  const appKey = `job-${job.executionId.replace(/[^a-f0-9]/gi, '').slice(0, 12).toLowerCase()}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'atimtha-job-'));
  const summaryFile = path.join(work, 'summary.json');
  const brandingFile = job.project.branding ? path.join(work, 'branding.json') : undefined;
  const reportDir = path.join(work, 'smart-report');
  if (brandingFile) fs.writeFileSync(brandingFile, JSON.stringify(job.project.branding));
  const { secrets, missing } = resolveSecrets(job.environment.secretRefs);
  try {
    if (missing.length) log('warn', 'secret references not resolved on this agent', { executionId: job.executionId, missing });
    writeSnapshot(job.project, APPS_DIR, { as: appKey, overwrite: true, secrets });
    // the bundled demo app: one copy for every job that needs it (parallel slots, explore)
    if (loadApp(appKey).environments[job.environment.key]?.startDemoApp && isLocal(job.environment.baseURL)) {
      await acquireDemo(job.environment.baseURL);
      sharedDemo.add(job.executionId);
    }
    await events([{ type: 'job.started', agentVersion: AGENT_VERSION }]);
    log('info', 'job started', { executionId: job.executionId, project: job.project.key, environment: job.environment.key, kind: job.kind ?? 'run', ...(job.shard ? { shard: `${job.shard.index}/${job.shard.total}` } : {}) });

    if (job.kind === 'explore' || job.kind === 'export') {
      const entry: Running = running.get(job.executionId) ?? { job, cancelled: false };
      running.set(job.executionId, entry);
      const r = job.kind === 'explore' ? await exploreJob(job, appKey, work, entry, summaryFile, brandingFile, reportDir) : await exportJob(job, appKey);
      if (entry.cancelled) await finish('cancelled', { counts: r.counts });
      else await finish(r.status, { counts: r.counts, ...(r.error ? { error: r.error } : {}) });
      log('info', 'job finished', { executionId: job.executionId, kind: job.kind, counts: r.counts });
      return;
    }

    const entry = running.get(job.executionId) ?? { job, cancelled: false };
    running.set(job.executionId, entry);
    if (entry.cancelled) throw new Error('cancelled before it started');
    const child = spawn(process.execPath, runnerArgs(job, path.join(work, 'artifacts')), {
      cwd: ROOT, env: runnerEnv(job, appKey, summaryFile, brandingFile, reportDir), stdio: ['ignore', 'inherit', 'inherit'],
    });
    entry.child = child;
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    const wasCancelled = entry.cancelled;

    await uploadReport(job, path.join(reportDir, 'index.html'));
    const summary = fs.existsSync(summaryFile) ? (JSON.parse(fs.readFileSync(summaryFile, 'utf8')) as { status: string; counts: Record<string, number> }) : undefined;
    if (wasCancelled) await finish('cancelled', summary ? { counts: summary.counts } : {});
    else if (!summary) await finish('error', { error: `The test runner stopped before reporting (exit code ${code}).` });
    else await finish(summary.status === 'passed' ? 'passed' : 'failed', { counts: summary.counts });
    log('info', 'job finished', { executionId: job.executionId, exitCode: code, cancelled: wasCancelled, counts: summary?.counts });
  } catch (e) {
    log('error', 'job failed', { executionId: job.executionId, error: (e as Error).message });
    await finish('error', { error: (e as Error).message.slice(0, 2000) });
  } finally {
    running.delete(job.executionId);
    if (sharedDemo.delete(job.executionId)) releaseDemo();
    // the project, its secrets and saved sessions never outlive the job
    fs.rmSync(path.join(APPS_DIR, appKey), { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, '.auth', appKey), { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
}

type Outcome = { status: 'passed' | 'failed' | 'error'; counts: Record<string, number>; error?: string };

/** collects the job's pages (signed in first when explore.as is set) and uploads them as explore.json */
async function exploreJob(job: Job, appKey: string, work: string, entry: Running, summaryFile: string, brandingFile?: string, reportDir?: string): Promise<Outcome> {
  const input = job.explore ?? { urls: [] };
  if (!input.urls?.length) return { status: 'error', counts: { total: 0 }, error: 'The explore job names no pages.' };
  const app = loadApp(appKey);
  let storageState: string | undefined;
  if (input.as) {
    // the project's own login (tests/setup/auth.setup.ts) saves that user's session
    const env = { ...runnerEnv(job, appKey, summaryFile, brandingFile, reportDir), EXTRA_SESSIONS: input.as };
    const child = spawn(process.execPath, [PW_CLI, 'test', '--project=setup', '--reporter=list', `--output=${path.join(work, 'setup')}`],
      { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] });
    entry.child = child;
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    entry.child = undefined;
    storageState = authFile(input.as, appKey);
    if (code !== 0 || !fs.existsSync(storageState))
      return { status: 'error', counts: { total: input.urls.length }, error: `Signing in as "${input.as}" failed (login setup exit code ${code}). No pages were collected.` };
  }
  const result = await explore({
    input, baseURL: job.environment.baseURL, testIdAttribute: app.testIdAttribute, storageState,
    ignoreHTTPSErrors: app.environments[job.environment.key]?.ignoreHTTPSErrors, locale: job.settings.locale,
    stopped: () => entry.cancelled, log: (m, x) => log('info', m, { executionId: job.executionId, ...x }),
  });
  const uploaded = await uploadArtifact(job, 'other', 'explore.json', 'application/json', Buffer.from(JSON.stringify(result)));
  const counts = { total: input.urls.length, passed: result.pages.length, failed: result.errors.length };
  if (!uploaded) return { status: 'error', counts, error: 'The collected pages could not be uploaded.' };
  return { status: result.pages.length && !result.errors.length ? 'passed' : result.pages.length ? 'failed' : 'error', counts,
    ...(result.errors.length ? { error: result.errors.map((e) => `${e.url}: ${e.error}`).join('\n').slice(0, 2000) } : {}) };
}

/** the project as a standalone Playwright project, uploaded as playwright-project.json (the platform zips it) */
async function exportJob(job: Job, appKey: string): Promise<Outcome> {
  const result = exportProject(appKey);
  const files = Object.keys(result.files).length;
  const uploaded = await uploadArtifact(job, 'other', 'playwright-project.json', 'application/json', Buffer.from(JSON.stringify(result)));
  if (!uploaded) return { status: 'error', counts: { total: files }, error: 'The exported project could not be uploaded.' };
  return { status: 'passed', counts: { total: files, passed: files, warnings: result.warnings.length } };
}

/** a run-level file → the platform (POST …/artifacts); false when it was not accepted */
async function uploadArtifact(job: Job, kind: 'report' | 'log' | 'other', name: string, contentType: string, body: Buffer): Promise<boolean> {
  if (body.length > 100 * 1024 * 1024) { log('warn', 'run file larger than 100 MB: not uploaded', { executionId: job.executionId, name }); return false; }
  try {
    const res = await fetch(`${config.platform}/api/agent/v1/jobs/${job.executionId}/artifacts?kind=${kind}&name=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'Content-Type': contentType, Authorization: authorization(reportToken(job)), ...traceparent(job.traceId) }, body: new Uint8Array(body),
    });
    if (!res.ok) log('warn', 'run file not accepted', { executionId: job.executionId, name, status: res.status, detail: (await res.text()).slice(0, 300) });
    return res.ok;
  } catch (e) {
    log('warn', 'run file upload failed', { executionId: job.executionId, name, error: (e as Error).message });
    return false;
  }
}

/** the run's Smart HTML report → the platform (run-level artifact); a lost report is logged, never fatal */
async function uploadReport(job: Job, file: string) {
  if (!fs.existsSync(file)) return;
  const size = fs.statSync(file).size;
  if (size > 100 * 1024 * 1024) return log('warn', 'smart report larger than 100 MB: not uploaded', { executionId: job.executionId, size });
  try {
    const res = await fetch(`${config.platform}/api/agent/v1/jobs/${job.executionId}/artifacts?kind=report&name=smart-report.html`, {
      method: 'POST', headers: { 'Content-Type': 'text/html', Authorization: authorization(reportToken(job)), ...traceparent(job.traceId) }, body: new Uint8Array(fs.readFileSync(file)),
    });
    if (!res.ok) log('warn', 'smart report not accepted', { executionId: job.executionId, status: res.status });
  } catch (e) {
    log('warn', 'smart report upload failed', { executionId: job.executionId, error: (e as Error).message });
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
      for (const id of running.keys()) cancel(id, `agent received ${signal}`);
    });
  }

  // the performance engine needs k6 on this machine: an agent without it does not offer the engine
  if (config.engines.includes('performance') && spawnSync(process.env.K6_PATH ?? 'k6', ['version'], { stdio: 'ignore' }).status !== 0) {
    config.engines = config.engines.filter((e) => e !== 'performance');
    log('warn', 'k6 not found (K6_PATH): the performance engine is not offered');
  }
  log('info', 'agent started', { version: AGENT_VERSION, platform: config.platform, engines: config.engines, slots: config.slots });
  await loadSigningKey();
  await heartbeat();
  const beat = setInterval(heartbeat, config.heartbeatSeconds * 1000);

  const jobs = new Set<Promise<void>>();
  while (!stopping) {
    if (jobs.size >= config.slots) {
      // every slot is busy: wait for one to free up
      await Promise.race(jobs);
      continue;
    }
    try {
      const job = await claim();
      if (job) {
        running.set(job.executionId, { job, cancelled: false });
        const p: Promise<void> = runJob(job).finally(() => { jobs.delete(p); running.delete(job.executionId); });
        jobs.add(p);
        continue; // look for the next job straight away
      }
    } catch (e) {
      log('warn', 'claim failed', { error: (e as Error).message });
    }
    await new Promise((r) => setTimeout(r, config.pollSeconds * 1000));
  }
  await Promise.allSettled(jobs);
  clearInterval(beat);
  log('info', 'agent stopped');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((e) => {
    log('error', 'agent crashed', { error: (e as Error).message });
    process.exit(1);
  });
}
