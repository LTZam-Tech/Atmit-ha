/**
 * Plays a no-code case for one data row: start (page / URL / continuation) → steps → expected result.
 * Shared by tests/cases.spec.ts (one test per row) and tests/flows.spec.ts (cases chained in one session).
 */
import type { Page } from '@playwright/test';
import type { Faker } from '@faker-js/faker';
import type { UI } from '../../fixtures';
import { step } from '../../utils/steps';
import { withBaseQuery } from '../../utils/url';
import { environment } from '../../../config/environment';
import { runSteps } from './runner';
import { render, resolveRow, type TemplateContext } from './template';
import { outcomeFor, type CaseDef, type DataRow } from './model';

export interface PlayOptions {
  /** do not open the start page: continue on the page the browser is on now (workflows) */
  continueHere?: boolean;
}

export async function play(c: CaseDef, row: DataRow, ui: UI, page: Page, faker: Faker, vars: Record<string, string>, byId: Map<string, CaseDef>, opts: PlayOptions = {}) {
  const ctx: TemplateContext = { data: resolveRow(row, faker), faker, vars };
  if (!opts.continueHere) {
    if (c.continueFrom) {
      const src = byId.get(c.continueFrom.case)!;
      const srcRow = (c.continueFrom.row ? src.data.find((r) => r.id === c.continueFrom!.row) : src.data[0]) ?? { type: src.type };
      await step.setup(`Continue from "${src.case}"${srcRow.id ? ` · ${srcRow.id}` : ''}`, () => play(src, srcRow, ui, page, faker, vars, byId));
    } else if (c.url) {
      const url = withBaseQuery(render(c.url, ctx), environment.baseURL);
      await step.navigate(`Go to ${url}`, async () => {
        await page.goto(url);
        if (c.page) await ui.ready(c.page);
      });
    } else if (c.page) await ui.open(c.page);
  }
  await runSteps(ui, page, c.steps, ctx);
  const outcome = outcomeFor(row.type || !c.type ? row : { ...row, type: c.type }, c.outcomes);
  if (outcome) await runSteps(ui, page, c.outcomes[outcome], ctx);
}

/** the user a case starts with: its own `user`, else the one of the case it continues from; undefined = the page decides */
export function userOf(c: CaseDef, byId: Map<string, CaseDef>): string | undefined {
  if (c.continueFrom) return userOf(byId.get(c.continueFrom.case)!, byId);
  return c.user;
}
/** the page a case starts on, following continueFrom */
export function startPageOf(c: CaseDef, byId: Map<string, CaseDef>): string | undefined {
  return c.continueFrom ? startPageOf(byId.get(c.continueFrom.case)!, byId) : c.page;
}
