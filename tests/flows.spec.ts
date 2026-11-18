/**
 * Workflows — apps/<app>/flows/*.flow.yml. Each workflow is ONE test: its cases run one after another
 * in the same browser session, each continuing on the page the previous one ended on. A step with
 * another user runs in that user's own window (its saved session); values saved earlier stay available.
 */
import { test } from '../src/fixtures';
import { UI } from '../src/fixtures';
import type { BrowserContext, Page } from '@playwright/test';
import { readCases } from '../src/core/cases/loader';
import { readFlows } from '../src/core/cases/flows';
import { play, startPageOf, userOf } from '../src/core/cases/play';
import { authFile } from '../src/core/pages-setup';
import { loadRepository } from '../src/core/or/loader';
import { step } from '../src/utils/steps';

const { cases, issues: caseIssues } = readCases();
const valid = cases.filter((c) => !caseIssues.some((i) => i.file === c.file));
const byId = new Map(valid.map((c) => [c.id, c]));
const { flows, issues } = readFlows(valid);

if (issues.length) {
  test.describe('Workflow files', () => {
    for (const i of issues) test(`✖ ${i.file}: ${i.message}`, () => { throw new Error(`apps/<app>/flows/${i.file} — ${i.message}`); });
  });
}

const repo = loadRepository();
/** who a step runs as: the step's `as`, else whoever ran before, else (first step) the case's user / its start page's auth */
const userFor = (stepAs: string | undefined, caseId: string, previous: string | undefined): string => {
  const c = byId.get(caseId)!;
  const page = startPageOf(c, byId);
  // a workflow keeps its session: only a step's own `as` switches user; the first step uses the case / page setting
  return stepAs ?? previous ?? userOf(c, byId) ?? (page ? repo.get(page)?.auth : undefined) ?? 'none';
};

const usedFlowNames = new Set<string>();
test.describe('Workflows', () => {
for (const f of flows) {
  let title = f.flow;
  for (let n = 2; usedFlowNames.has(title); n++) title = `${f.flow} [${f.file}${n > 2 ? ` #${n}` : ''}]`;
  usedFlowNames.add(title);
  const tags = [...new Set(['@workflow', ...f.tags])];
  test(title, { tag: tags, annotation: [{ type: 'case-file', description: `flows/${f.file}` }, ...(f.module ? [{ type: 'module', description: f.module }] : [])] }, async ({ browser, data, discover }, testInfo) => {
    const use = testInfo.project.use;
    const windows = new Map<string, { context: BrowserContext; page: Page; ui: UI }>();
    const vars: Record<string, string> = {};
    let current: string | undefined;
    let failed = false;
    try {
      for (const [i, s] of f.steps.entries()) {
        const c = byId.get(s.case)!;
        const row = (s.row ? c.data.find((r) => r.id === s.row) : c.data[0]) ?? { type: c.type };
        const user = userFor(s.as, s.case, current);
        let w = windows.get(user);
        const fresh = !w;
        if (!w) {
          const context = await browser.newContext({
            baseURL: use.baseURL, ignoreHTTPSErrors: use.ignoreHTTPSErrors, httpCredentials: use.httpCredentials, locale: use.locale, viewport: use.viewport,
            storageState: user === 'none' ? undefined : authFile(user),
          });
          await discover.watch(context, user);
          if (use.actionTimeout) context.setDefaultTimeout(use.actionTimeout);
          if (use.navigationTimeout) context.setDefaultNavigationTimeout(use.navigationTimeout);
          await context.tracing.start({ screenshots: true, snapshots: true }).catch(() => {});
          const page = await context.newPage();
          w = { context, page, ui: new UI(page) };
          windows.set(user, w);
        }
        // continue where the previous case stopped — unless it is a new window, or the step says open
        const continueHere = s.start === 'continue' || (s.start !== 'open' && !fresh && i > 0);
        const who = user === 'none' ? 'no saved login' : `as ${user}`;
        const label = `${i + 1}. ${c.case}${row.id ? ` · ${row.id}` : ''} — ${who}${continueHere ? ' · continues' : fresh && i > 0 ? ' · new window' : ''}`;
        await step.setup(label, () => play(c, row, w!.ui, w!.page, data.faker, vars, byId, { continueHere }));
        current = user;
      }
    } catch (e) {
      failed = true;
      throw e;
    } finally {
      for (const [user, w] of windows) {
        if (failed) {
          await testInfo.attach(`screenshot — ${user}`, { body: await w.page.screenshot().catch(() => Buffer.from('')), contentType: 'image/png' }).catch(() => {});
          const trace = testInfo.outputPath(`trace-${user}.zip`);
          await w.context.tracing.stop({ path: trace }).then(() => testInfo.attach('trace', { path: trace, contentType: 'application/zip' })).catch(() => {});
        } else await w.context.tracing.stop().catch(() => {});
        const url = w.page.url();
        if (/^https?:/.test(url)) testInfo.annotations.push({ type: 'runtime-value', description: `${user} ended on ${url}` });
        await w.context.close().catch(() => {});
      }
    }
  });
}
});
