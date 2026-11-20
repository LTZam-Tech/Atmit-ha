/**
 * Playwright reporter used by the execution agent (agent/agent.ts, ADR-0014/0015):
 *   • streams a `test.finished` event per test to the platform (batched, retried),
 *   • writes the run summary (counts) to AGENT_SUMMARY_FILE for the agent's `job.finished` event.
 *
 *   • uploads the evidence of failed and flaky tests (screenshot, video, trace) after their result is saved;
 *     AGENT_EVIDENCE=all uploads it for every test, AGENT_EVIDENCE=off for none.
 *
 * Environment (set by the agent): AGENT_EVENTS_URL, AGENT_EVIDENCE_URL, AGENT_TOKEN, AGENT_SUMMARY_FILE, AGENT_EVIDENCE.
 * Never sends secrets: values typed into password fields are already masked by the step titles (src/utils/steps.ts).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { FullResult, Reporter, TestCase, TestResult, TestStep } from '@playwright/test/reporter';
import { healsOf } from '../src/core/healing';

type Status = 'passed' | 'failed' | 'timed_out' | 'skipped' | 'interrupted';

const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

/** same buckets as the Smart Report, in the contract's enum (contracts/job-event.schema.json) */
export function category(msg: string): string {
  if (msg.includes('[Healing]')) return 'self_healing';
  if (msg.includes('[Smart OR]')) return 'locator_or';
  if (/net::ERR|ECONNREFUSED|ENOTFOUND|browserType\.connect|Target page, context or browser has been closed/i.test(msg)) return 'environment';
  if (/Test timeout of|exceeded while/i.test(msg) && !/expect\(/.test(msg)) return 'timeout';
  if (/expect\(|toHave|toBe/.test(msg)) return 'application_defect';
  return 'script_error';
}

export function statusOf(s: TestResult['status']): Status {
  return s === 'timedOut' ? 'timed_out' : s;
}

function steps(list: TestStep[]): { title: string; durationMs: number; error?: string }[] {
  return list.filter((s) => s.category === 'test.step').map((s) => ({ title: s.title, durationMs: Math.round(s.duration), ...(s.error ? { error: strip(s.error.message ?? '').slice(0, 2000) } : {}) }));
}

/** Playwright attachment → evidence kind and content type the platform accepts (EvidenceEndpoints) */
export function evidenceOf(a: { name: string; contentType: string; path?: string }): { kind: string; contentType: string } | undefined {
  if (!a.path) return undefined;
  if (a.contentType.startsWith('image/') && ['image/png', 'image/jpeg', 'image/webp'].includes(a.contentType)) return { kind: 'screenshot', contentType: a.contentType };
  if (a.name === 'video' || a.contentType.startsWith('video/')) return { kind: 'video', contentType: a.contentType.startsWith('video/') ? a.contentType : 'video/webm' };
  if (a.name === 'trace' || a.contentType === 'application/zip') return { kind: 'trace', contentType: 'application/zip' };
  return undefined;
}

const MAX_EVIDENCE_BYTES = 50 * 1024 * 1024;

export default class AgentReporter implements Reporter {
  private readonly url = process.env.AGENT_EVENTS_URL;
  private readonly token = process.env.AGENT_TOKEN;
  private readonly summaryFile = process.env.AGENT_SUMMARY_FILE;
  private readonly evidenceUrl = process.env.AGENT_EVIDENCE_URL;
  private readonly evidenceMode = process.env.AGENT_EVIDENCE ?? 'failed';
  private queue: unknown[] = [];
  private sending: Promise<void> = Promise.resolve();
  private final = new Map<string, { status: Status; flaky: boolean; healed: boolean }>();

  printsToStdio() { return false; }

  onTestEnd(test: TestCase, result: TestResult) {
    const ann = (type: string) => test.annotations.filter((a) => a.type === type).map((a) => a.description ?? '');
    const tags = test.tags;
    const kind = tags.includes('@positive') ? 'positive' : tags.includes('@negative') ? 'negative' : 'other';
    const caseFile = ann('case-file')[0]?.replace(/^cases\//, '').replace(/\.case\.ya?ml$/, '');
    const rowKey = /^(\S+) · /.exec(test.title)?.[1];
    const error = result.errors.map((e) => strip(e.message ?? e.value ?? '')).join('\n\n') || undefined;
    const heals = healsOf(test.annotations);
    const status = statusOf(result.status);
    const flaky = result.status === 'passed' && result.retry > 0;
    this.final.set(test.id, { status, flaky, healed: heals.length > 0 }); // the last retry wins

    // only the final attempt is reported: a retried test sends one result, marked flaky when it passed late
    const willRetry = result.status !== 'passed' && result.status !== 'skipped' && result.retry < test.retries;
    if (willRetry) return;

    const parse = (s?: string) => { try { return s ? JSON.parse(s) : undefined; } catch { return undefined; } };
    const id = crypto.randomUUID();
    this.push({
      type: 'test.finished',
      id,
      title: test.title.slice(0, 1000),
      module: test.titlePath().slice(3, -1).join(' › ') || undefined,
      kind,
      ...(caseFile ? { caseKey: caseFile } : {}),
      ...(rowKey ? { rowKey } : {}),
      status,
      flaky,
      retries: result.retry,
      ...(error ? { error: error.slice(0, 20000), category: category(error) } : {}),
      durationMs: Math.round(result.duration),
      steps: steps(result.steps),
      ...(parse(ann('last-page').at(-1)) ? { lastPage: parse(ann('last-page').at(-1)) } : {}),
      ...(parse(ann('discoveries').at(-1)) ? { discoveries: parse(ann('discoveries').at(-1)) } : {}),
      ...(heals.length ? { healing: heals } : {}),
    });

    const wanted = this.evidenceMode === 'all' || (this.evidenceMode !== 'off' && (status !== 'passed' && status !== 'skipped' || flaky));
    const files = wanted ? result.attachments.map((a) => ({ a, e: evidenceOf(a) })).filter((x) => x.e) : [];
    if (files.length && this.evidenceUrl && this.token) {
      // the result must exist on the platform before its files: send the batch now, then upload after it
      this.flush();
      const base = `${this.evidenceUrl}/${id}/evidence`;
      for (const { a, e } of files) this.sending = this.sending.then(() => upload(base, this.token!, a.path!, a.name, e!.kind, e!.contentType));
    }
  }

  async onEnd(result: FullResult) {
    this.flush();
    await this.sending;
    const all = [...this.final.values()];
    const counts = {
      total: all.length,
      passed: all.filter((t) => t.status === 'passed' && !t.flaky).length,
      failed: all.filter((t) => ['failed', 'timed_out', 'interrupted'].includes(t.status)).length,
      flaky: all.filter((t) => t.flaky).length,
      skipped: all.filter((t) => t.status === 'skipped').length,
      healed: all.filter((t) => t.status === 'passed' && t.healed).length,
      healingFailed: 0,
    };
    if (this.summaryFile) fs.writeFileSync(this.summaryFile, JSON.stringify({ status: result.status, counts }));
  }

  private push(event: unknown) {
    this.queue.push(event);
    if (this.queue.length >= 25) this.flush();
  }

  private flush() {
    if (!this.queue.length || !this.url || !this.token) { this.queue = []; return; }
    const batch = this.queue;
    this.queue = [];
    this.sending = this.sending.then(async () => { await send(this.url!, this.token!, batch); });
  }
}

/** one evidence file, 3 attempts; a lost file is logged, never fatal for the run */
export async function upload(base: string, token: string, file: string, name: string, kind: string, contentType: string): Promise<void> {
  let body: Buffer;
  try {
    if (fs.statSync(file).size > MAX_EVIDENCE_BYTES) return void console.error(`[agent-reporter] ${kind} ${name} is larger than 50 MB: not uploaded`);
    body = fs.readFileSync(file);
  } catch {
    return; // Playwright removed it, or it was never written
  }
  const url = `${base}?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(name.slice(0, 120))}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': contentType, Authorization: authorization(token), ...traceparent() }, body: new Uint8Array(body) });
      if (res.ok) return;
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        return void console.error(`[agent-reporter] platform refused ${kind} ${name}: HTTP ${res.status} ${await res.text().catch(() => '')}`);
      }
    } catch (e) {
      if (attempt === 2) console.error(`[agent-reporter] could not upload ${kind} ${name}: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

/** POST events with up to 5 attempts (1, 2, 4, 8 s apart); a lost batch is logged, never fatal for the run */
/** W3C trace context for the job's trace (ATIMTHA_TRACE_ID or the id given): the platform's logs carry the same trace id */
export function traceparent(traceId = process.env.ATIMTHA_TRACE_ID): Record<string, string> {
  if (!traceId || !/^[0-9a-f]{32}$/.test(traceId)) return {};
  const span = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return { traceparent: `00-${traceId}-${span}-01` };
}

/** a job token (ajt_…, one job only) or the agent's own token (atk_…) */
export const authorization = (token: string) => (token.startsWith('ajt_') ? `AtimthaJob ${token}` : `AtimthaAgent ${token}`);

/** set by the agent: the trace id of the job a URL belongs to (the agent runs several jobs at once) */
let traceIdFor: ((url: string) => string | undefined) | undefined;
export function useTraceIds(lookup: (url: string) => string | undefined) { traceIdFor = lookup; }

export async function send(url: string, token: string, events: unknown[]): Promise<{ cancel?: boolean } | undefined> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authorization(token), ...traceparent(traceIdFor?.(url)) },
        body: JSON.stringify(events),
      });
      if (res.ok) return (await res.json().catch(() => ({}))) as { cancel?: boolean };
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        console.error(`[agent-reporter] platform refused ${events.length} event(s): HTTP ${res.status} ${await res.text().catch(() => '')}`);
        return undefined;
      }
    } catch (e) {
      if (attempt === 4) console.error(`[agent-reporter] could not reach the platform: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
  return undefined;
}
