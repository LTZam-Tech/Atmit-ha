/**
 * Playwright reporter used by the execution agent (agent/agent.ts, ADR-0014/0015):
 *   • streams a `test.finished` event per test to the platform (batched, retried),
 *   • writes the run summary (counts) to AGENT_SUMMARY_FILE for the agent's `job.finished` event.
 *
 * Environment (set by the agent): AGENT_EVENTS_URL, AGENT_TOKEN, AGENT_SUMMARY_FILE.
 * Never sends secrets: values typed into password fields are already masked by the step titles (src/utils/steps.ts).
 */
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

export default class AgentReporter implements Reporter {
  private readonly url = process.env.AGENT_EVENTS_URL;
  private readonly token = process.env.AGENT_TOKEN;
  private readonly summaryFile = process.env.AGENT_SUMMARY_FILE;
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
    this.push({
      type: 'test.finished',
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
    this.sending = this.sending.then(() => send(this.url!, this.token!, batch));
  }
}

/** POST events with up to 5 attempts (1, 2, 4, 8 s apart); a lost batch is logged, never fatal for the run */
export async function send(url: string, token: string, events: unknown[]): Promise<{ cancel?: boolean } | undefined> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `AtimthaAgent ${token}` },
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
