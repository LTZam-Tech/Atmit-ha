/**
 * Workflows — apps/<app>/flows/*.flow.yml: test cases chained as ONE test in one session.
 *
 *   flow: Order journey
 *   module: Cart
 *   steps:
 *     - case: login-to-cart          # case file name without .case.yml
 *       row: TC-001                  # optional — which data row (default: the first)
 *     - case: go-to-checkout         # continues on the page the previous case ended on
 *     - case: place-order
 *       as: standard                 # optional — run this case as another user (opens that user's window)
 *       start: open                  # optional — open the case's start page / URL instead of continuing
 *
 * Saved values ({{var.…}}) flow from one case to the next. When the user changes, that user gets
 * its own browser window with its saved session; going back to a user returns to its window.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { appDir, currentApp, loadApp } from '../app';
import type { CaseDef } from './model';
import { caseId } from './model';

export interface FlowStep { case: string; row?: string; as?: string; start?: 'open' | 'continue' }
export interface FlowDef { file: string; id: string; flow: string; description?: string; module?: string; tags: string[]; steps: FlowStep[] }
export interface FlowIssue { file: string; message: string }

export const flowsDir = (app = currentApp()) => path.join(appDir(app), 'flows');

export function readFlows(cases: CaseDef[], app = currentApp()): { flows: FlowDef[]; issues: FlowIssue[] } {
  const dir = flowsDir(app);
  const flows: FlowDef[] = [], issues: FlowIssue[] = [];
  if (!fs.existsSync(dir)) return { flows, issues };
  const cfg = loadApp(app);
  const byId = new Map(cases.map((c) => [c.id, c]));
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.flow.yml')).sort()) {
    const errs: string[] = [];
    let raw: Record<string, unknown>;
    try { raw = YAML.parse(fs.readFileSync(path.join(dir, file), 'utf8')) ?? {}; }
    catch (e) { issues.push({ file, message: `invalid YAML — ${(e as Error).message}` }); continue; }
    for (const k of Object.keys(raw)) if (!['flow', 'description', 'module', 'tags', 'steps'].includes(k)) errs.push(`unknown key "${k}"`);
    if (typeof raw.flow !== 'string' || !raw.flow.trim()) errs.push('"flow" (the workflow name) is required');
    const steps = (Array.isArray(raw.steps) ? raw.steps : []).map((s: Record<string, unknown>) => ({
      case: caseId(String(s?.case ?? '')), row: s?.row === undefined ? undefined : String(s.row), as: s?.as === undefined ? undefined : String(s.as),
      start: s?.start === undefined ? undefined : String(s.start) as FlowStep['start'],
    }));
    if (!steps.length) errs.push('a workflow needs at least one step (case)');
    steps.forEach((s, i) => {
      const where = `step ${i + 1}`;
      const c = byId.get(s.case);
      if (!c) return errs.push(`${where}: no valid case "${s.case}"`);
      if (s.row && !c.data.some((r) => r.id === s.row)) errs.push(`${where}: case "${c.case}" has no row "${s.row}"`);
      if (s.as && s.as !== 'none' && !cfg.users[s.as]) errs.push(`${where}: user "${s.as}" is not defined`);
      if (s.start && !['open', 'continue'].includes(s.start)) errs.push(`${where}: start must be "open" or "continue"`);
      if (i === 0 && s.start === 'continue') errs.push('step 1 cannot continue — nothing ran before it');
    });
    if (errs.length) { errs.forEach((message) => issues.push({ file, message })); continue; }
    flows.push({ file, id: file.replace(/\.flow\.yml$/, ''), flow: String(raw.flow), description: raw.description as string | undefined, module: raw.module ? String(raw.module) : undefined,
      tags: (Array.isArray(raw.tags) ? raw.tags : []).map(String).map((t) => (t.startsWith('@') ? t : '@' + t)), steps });
  }
  return { flows, issues };
}

export function writeFlow(app: string, name: string, body: { flow: string; description?: string; module?: string; tags?: string[]; steps: FlowStep[] }) {
  const file = name.replace(/\.flow\.yml$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.flow.yml';
  const doc: Record<string, unknown> = { flow: body.flow };
  if (body.description) doc.description = body.description;
  if (body.module) doc.module = body.module;
  if (body.tags?.length) doc.tags = body.tags;
  doc.steps = body.steps.map((s) => Object.fromEntries(Object.entries({ case: s.case, row: s.row || undefined, as: s.as || undefined, start: s.start || undefined }).filter(([, v]) => v !== undefined)));
  fs.mkdirSync(flowsDir(app), { recursive: true });
  fs.writeFileSync(path.join(flowsDir(app), file), '# Workflow — test cases chained in one session (edit in Control Panel → Test builder → Workflows)\n' + YAML.stringify(doc));
  return file;
}
