/**
 * Performance test engine — runs a performance case with k6 (backlog §9) inside the test, so results, retries,
 * evidence and reports are the same as for every other case. The k6 script is generated from the case; templates
 * are filled once per test ({{var.x}} values saved during an iteration are filled by the script itself).
 *
 * The agent needs k6 (K6_PATH, default "k6" on the PATH) and advertises the "performance" engine only then.
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { step } from '../../utils/steps';
import { withBaseQuery } from '../../utils/url';
import { environment } from '../../../config/environment';
import { appRequests, renderDeep } from '../api-engine/runner';
import { resolveRequest } from '../api-engine/model';
import type { Step } from '../cases/model';
import type { TemplateContext } from '../cases/template';
import { seconds, type LoadProfile, type Thresholds } from './model';

/** {{var.x}} stays as written: the script fills it during each iteration from values saved before it */
const keepVars = new Proxy({} as Record<string, string>, { get: (_t, k) => (typeof k === 'string' ? `{{var.${k}}}` : undefined) });

/** $.a.b[0].c → a.b.0.c (k6 response.json() uses GJSON paths) */
export function gjson(path: string): string {
  if (!/^\$(\.[A-Za-z_]\w*|\[\d+\])*$/.test(path)) throw new Error(`"${path}": a performance case saves simple paths only, like $.data.items[0].id`);
  return path.replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '.$1').replace(/^\./, '');
}

export interface Caps { maxVus: number; maxMinutes: number }

export function caps(): Caps {
  return { maxVus: Number(process.env.ATIMTHA_MAX_VUS ?? 50), maxMinutes: Number(process.env.ATIMTHA_MAX_LOAD_MINUTES ?? 15) };
}

/** the safeguards: no more load than the agent allows, and only on the environment's own host */
export function checkLoad(load: LoadProfile, requests: string[], c = caps()) {
  if (c.maxVus <= 0) throw new Error('Performance runs are not allowed for this organisation (performance.maxVirtualUsers is 0)');
  if (load.vus > c.maxVus) throw new Error(`The case asks for ${load.vus} virtual users; this run allows at most ${c.maxVus}`);
  const total = seconds(load.rampUp) + seconds(load.duration) + seconds(load.rampDown);
  if (total / 60 > c.maxMinutes) throw new Error(`The load lasts ${Math.ceil(total / 60)} min; this run allows at most ${c.maxMinutes} min`);
  const host = new URL(environment.baseURL).host;
  for (const u of requests) {
    if (new URL(u).host !== host) throw new Error(`Load may only target the environment's host (${host}), not ${new URL(u).host}`);
  }
}

/** the k6 script for one data row */
export function script(steps: Step[], ctx: TemplateContext, load: LoadProfile, thresholds: Thresholds): { source: string; requests: string[] } {
  const rendered = steps.map((s) => {
    if ((s.action as string) === 'request') {
      const where = s.name ?? `step ${s.index ?? ''}`.trim();
      const b = renderDeep(resolveRequest(s.api as Record<string, unknown>, appRequests(), where), { ...ctx, vars: keepVars }) as Record<string, unknown>;
      if (b.multipart !== undefined) throw new Error(`${where}: multipart bodies are not sent under load; use json, form or body`);
      const headers: Record<string, string> = Object.fromEntries(Object.entries((b.headers ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
      const auth = b.auth as { bearer?: string; basic?: { username: string; password: string }; apiKey?: { in: string; name: string; value: unknown }; oauth2?: unknown } | undefined;
      if (auth?.oauth2) throw new Error(`${where}: OAuth2 is not fetched under load; get a token first and pass it as { bearer }`);
      if (auth?.bearer) headers.Authorization = `Bearer ${auth.bearer}`;
      if (auth?.basic) headers.Authorization = `Basic ${Buffer.from(`${auth.basic.username}:${auth.basic.password}`).toString('base64')}`;
      if (auth?.apiKey?.in === 'header') headers[auth.apiKey.name] = String(auth.apiKey.value);
      if (auth?.apiKey?.in === 'query') b.query = { ...((b.query ?? {}) as Record<string, unknown>), [auth.apiKey.name]: String(auth.apiKey.value) };
      // k6 needs absolute addresses: relative ones resolve against the environment (Playwright did that for the API engine)
      const url = new URL(withBaseQuery(String(b.url), environment.baseURL), environment.baseURL).toString();
      const query = b.query ? '?' + new URLSearchParams(Object.entries(b.query as Record<string, unknown>).map(([k, v]) => [k, String(v)])).toString() : '';
      return { request: { method: String(b.method ?? 'GET'), url: url + (url.includes('?') && query ? '&' + query.slice(1) : query), headers, json: b.json, form: b.form, body: b.body, name: s.name } };
    }
    if ((s.action as string) === 'status') return { status: s.api };
    if ((s.action as string) === 'save') {
      const a = s.api as { path?: string; header?: string; as: string };
      return { save: { as: a.as, gjson: a.path ? gjson(a.path) : undefined, header: a.header } };
    }
    if ((s.action as string) === 'think') return { think: (s.api as { ms: number }).ms };
    throw new Error(`"${s.action}" cannot run under load`);
  });

  const scenario = load.iterations
    ? { executor: 'per-vu-iterations', vus: load.vus, iterations: load.iterations, maxDuration: `${caps().maxMinutes}m` }
    : load.rampUp || load.rampDown
      ? { executor: 'ramping-vus', startVUs: 0, stages: [
          ...(load.rampUp ? [{ duration: load.rampUp, target: load.vus }] : [{ duration: '1s', target: load.vus }]),
          { duration: load.duration, target: load.vus },
          ...(load.rampDown ? [{ duration: load.rampDown, target: 0 }] : []),
        ] }
      : { executor: 'constant-vus', vus: load.vus, duration: load.duration };
  const k6Thresholds: Record<string, string[]> = {};
  const d: string[] = [];
  if (thresholds.avg !== undefined) d.push(`avg<${thresholds.avg}`);
  for (const p of ['p90', 'p95', 'p99'] as const) if (thresholds[p] !== undefined) d.push(`p(${p.slice(1)})<${thresholds[p]}`);
  if (thresholds.max !== undefined) d.push(`max<${thresholds.max}`);
  if (d.length) k6Thresholds.http_req_duration = d;
  if (thresholds.errorRate !== undefined) k6Thresholds.http_req_failed = [`rate<=${thresholds.errorRate}`];
  if (thresholds.minRps !== undefined) k6Thresholds.http_reqs = [`rate>=${thresholds.minRps}`];

  const options = { scenarios: { load: scenario }, thresholds: k6Thresholds, summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'], insecureSkipTLSVerify: environment.ignoreHTTPSErrors };
  const source = `// generated by Atimtha from a performance case — do not edit
import http from 'k6/http';
import { check, sleep } from 'k6';
export const options = ${JSON.stringify(options, null, 2)};
const steps = ${JSON.stringify(rendered, null, 2)};
function fill(v, vars) {
  if (typeof v === 'string') return v.replace(/\\{\\{\\s*var\\.(\\w+)\\s*\\}\\}/g, (_, n) => (vars[n] === undefined ? '' : String(vars[n])));
  if (Array.isArray(v)) return v.map((x) => fill(x, vars));
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = fill(v[k], vars); return o; }
  return v;
}
export default function () {
  const vars = {};
  let res;
  for (const s of steps) {
    if (s.request) {
      const r = fill(s.request, vars);
      const params = { headers: Object.assign({}, r.headers), tags: { name: r.name || (r.method + ' ' + r.url.split('?')[0]) } };
      let body = null;
      if (r.json !== undefined) { body = JSON.stringify(r.json); params.headers['Content-Type'] = 'application/json'; }
      else if (r.form !== undefined) body = r.form;
      else if (r.body !== undefined) body = String(r.body);
      res = http.request(r.method, r.url, body, params);
    } else if (s.status) {
      const ok = s.status.in ? (x) => s.status.in.includes(x.status) : (x) => x.status === Number(s.status.equals);
      check(res, { ['status ' + JSON.stringify(s.status.in || s.status.equals)]: ok });
    } else if (s.save) {
      vars[s.save.as] = s.save.header ? res.headers[s.save.header] : res.json(s.save.gjson);
    } else if (s.think !== undefined) {
      sleep(s.think / 1000);
    }
  }
}
`;
  return { source, requests: rendered.filter((r) => 'request' in r).map((r) => (r as { request: { url: string } }).request.url) };
}

interface Summary { metrics: Record<string, Record<string, number>> }

/** runs the case's load with k6 and checks the thresholds; the k6 summary and script are attached to the result */
export async function runLoad(steps: Step[], ctx: TemplateContext, load: LoadProfile, thresholds: Thresholds) {
  const info = test.info();
  const { source, requests } = script(steps, ctx, load, thresholds);
  checkLoad(load, requests);
  const scriptFile = info.outputPath('load.js');
  const summaryFile = info.outputPath('k6-summary.json');
  fs.writeFileSync(scriptFile, source);
  const total = seconds(load.rampUp) + seconds(load.duration) + seconds(load.rampDown);
  info.setTimeout(Math.max(info.timeout, (total + 120) * 1000));

  const label = load.iterations ? `${load.vus} users × ${load.iterations} iterations` : `${load.vus} users for ${load.duration}${load.rampUp ? ` (ramp-up ${load.rampUp})` : ''}`;
  const code = await step.api(`Load: ${label}`, () => new Promise<number>((resolve, reject) => {
    const k6 = spawn(process.env.K6_PATH ?? 'k6', ['run', '--quiet', '--no-color', `--summary-export=${summaryFile}`, scriptFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    k6.stderr.on('data', (c) => { err = (err + c).slice(-4000); });
    k6.on('error', (e) => reject(new Error(`k6 could not start (${(e as Error).message}): install k6 on this agent or set K6_PATH`)));
    k6.on('close', (c) => (c === 0 || c === 99 ? resolve(c ?? 0) : reject(new Error(`k6 stopped with code ${c}: ${err.trim().slice(-800)}`))));
  }));

  await info.attach('k6 script', { path: scriptFile, contentType: 'text/javascript' });
  const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8')) as Summary;
  await info.attach('k6 summary', { path: summaryFile, contentType: 'application/json' });
  const dur = summary.metrics.http_req_duration ?? {};
  const failed = summary.metrics.http_req_failed?.value ?? 0;
  const rps = summary.metrics.http_reqs?.rate ?? 0;
  const checks = summary.metrics.checks;
  const ms = (v: number | undefined) => `${Math.round(v ?? 0)} ms`;
  info.annotations.push({ type: 'performance', description: JSON.stringify({ avg: dur.avg, p90: dur['p(90)'], p95: dur['p(95)'], p99: dur['p(99)'], max: dur.max, errorRate: failed, rps, requests: summary.metrics.http_reqs?.count ?? 0 }) });

  await step.verify(`Response times: avg ${ms(dur.avg)} · p95 ${ms(dur['p(95)'])} · p99 ${ms(dur['p(99)'])} · max ${ms(dur.max)}`, async () => {
    if (thresholds.avg !== undefined) expect.soft(dur.avg, 'average response time (ms)').toBeLessThan(thresholds.avg);
    for (const p of ['p90', 'p95', 'p99'] as const) if (thresholds[p] !== undefined) expect.soft(dur[`p(${p.slice(1)})`], `${p} response time (ms)`).toBeLessThan(thresholds[p]!);
    if (thresholds.max !== undefined) expect.soft(dur.max, 'slowest response (ms)').toBeLessThan(thresholds.max);
  });
  await step.verify(`Throughput ${rps.toFixed(1)} req/s · errors ${(failed * 100).toFixed(2)} %`, async () => {
    if (thresholds.errorRate !== undefined) expect.soft(failed, 'share of failed requests').toBeLessThanOrEqual(thresholds.errorRate);
    if (thresholds.minRps !== undefined) expect.soft(rps, 'requests per second').toBeGreaterThanOrEqual(thresholds.minRps);
    if (checks && checks.fails > 0) expect.soft(checks.fails, 'failed status checks').toBe(0);
  });
  if (code === 99 && !info.errors.length) throw new Error('k6 reports that a threshold was crossed');
}
