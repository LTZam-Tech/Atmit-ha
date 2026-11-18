/**
 * Reads apps/<app>/cases/*.case.yml, normalizes steps and checks them against the app's
 * Smart OR, users and messages — so a typo is reported before the run, in plain words.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { casesDir, currentApp, loadApp, orDir } from '../app';
import { readRepository, paramsOf } from '../or/loader';
import type { NormalizedPageDef } from '../or/types';
import { caseId, dataFieldsUsed, normalizeStep, outcomeFor, parseElementRef, varsUsed, type CaseDef, type DataRow, type RawStep, type Step } from './model';

export interface CaseIssue { file: string; message: string }

export function readCases(app = currentApp(), opts: { strict?: boolean } = {}): { cases: CaseDef[]; issues: CaseIssue[] } {
  const dir = casesDir(app);
  const cases: CaseDef[] = [];
  const issues: CaseIssue[] = [];
  if (!fs.existsSync(dir)) return { cases, issues };

  let repo: Map<string, NormalizedPageDef> = new Map();
  try { repo = readRepository(orDir(app)); } catch (e) { issues.push({ file: 'or/', message: (e as Error).message }); }
  const cfg = loadApp(app);

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.case.yml')).sort();
  // pre-scan: raw content + values each case saves (dependents and continuations may use them)
  const raws = new Map<string, Record<string, unknown>>();
  for (const file of files) {
    try { raws.set(caseId(file), YAML.parse(fs.readFileSync(path.join(dir, file), 'utf8')) ?? {}); }
    catch (e) { issues.push({ file, message: `invalid YAML — ${(e as Error).message}` }); }
  }
  const savesOf = (id: string): string[] => {
    const r = raws.get(id);
    if (!r) return [];
    return [...JSON.stringify([r.steps, r.outcomes]).matchAll(/"as":"(\w+)"/g)].map((m) => m[1]);
  };
  const deps = (r: Record<string, unknown>) => (Array.isArray(r.dependsOn) ? r.dependsOn : typeof r.dependsOn === 'string' ? [r.dependsOn] : []).map((d) => caseId(String(d)));
  const from = (r: Record<string, unknown>) => {
    const c = r.continueFrom as { case?: unknown; row?: unknown } | string | undefined;
    if (!c) return undefined;
    return typeof c === 'string' ? { case: caseId(c) } : { case: caseId(String(c.case ?? '')), row: c.row === undefined ? undefined : String(c.row) };
  };
  /** values available at the start of a case: saved by every case it depends on (transitively) or continues from */
  const inherited = (id: string, seen = new Set<string>()): Set<string> => {
    const out = new Set<string>();
    if (seen.has(id)) return out;
    seen.add(id);
    const r = raws.get(id) ?? {};
    for (const d of [...deps(r), ...(from(r) ? [from(r)!.case] : [])]) {
      savesOf(d).forEach((v) => out.add(v));
      inherited(d, seen).forEach((v) => out.add(v));
    }
    return out;
  };
  const cycle = (id: string, path: string[] = []): string[] | undefined => {
    if (path.includes(id)) return [...path, id];
    const r = raws.get(id);
    if (!r) return undefined;
    for (const d of [...deps(r), ...(from(r) ? [from(r)!.case] : [])]) { const c = cycle(d, [...path, id]); if (c) return c; }
    return undefined;
  };

  for (const file of files) {
    const errs: string[] = [];
    const raw = raws.get(caseId(file));
    if (!raw) continue;
    const known = new Set(['case', 'description', 'type', 'user', 'url', 'module', 'dependsOn', 'continueFrom', 'page', 'tags', 'steps', 'outcomes', 'data']);
    for (const k of Object.keys(raw)) if (!known.has(k)) errs.push(`unknown key "${k}"`);
    if (typeof raw.case !== 'string' || !raw.case.trim()) errs.push('"case" (the case name) is required');

    const norm = (list: unknown, where: string): Step[] => {
      if (list === undefined) return [];
      if (!Array.isArray(list)) { errs.push(`${where} must be a list`); return []; }
      return list.flatMap((s, i) => {
        try { return [{ ...normalizeStep(s as RawStep, `${where} #${i + 1}`), index: i + 1 }]; } catch (e) { errs.push((e as Error).message); return []; }
      });
    };
    const steps = norm(raw.steps, 'steps');
    const outcomes: Record<string, Step[]> = {};
    for (const [name, list] of Object.entries((raw.outcomes ?? {}) as Record<string, unknown>)) outcomes[name] = norm(list, `outcome "${name}"`);
    const data = (Array.isArray(raw.data) ? raw.data : raw.data === undefined ? [] : (errs.push('"data" must be a list'), [])) as DataRow[];
    const tags = (Array.isArray(raw.tags) ? raw.tags : []).map(String).map((t) => (t.startsWith('@') ? t : '@' + t));
    const startPage = raw.page === undefined ? undefined : String(raw.page);
    const id = caseId(file);
    const caseType = raw.type === undefined ? undefined : String(raw.type);
    if (caseType && !['positive', 'negative'].includes(caseType)) errs.push('"type" must be positive or negative');
    // rows inherit the case type; a row of the other type belongs in another case (one scenario = one expected result)
    if (caseType === 'positive' || caseType === 'negative') {
      data.forEach((row, i) => {
        if (row.type && row.type !== caseType) errs.push(`data row ${i + 1}${row.id ? ` (${row.id})` : ''} is ${row.type} but the case is ${caseType} — move it to a ${row.type} case`);
        else row.type = caseType;
      });
    }
    const dependsOn = deps(raw);
    const continueFrom = from(raw);
    for (const d of dependsOn) if (!raws.has(d)) errs.push(`dependsOn: no case "${d}" (cases: ${[...raws.keys()].join(', ')})`);
    if (continueFrom) {
      const src = raws.get(continueFrom.case);
      if (!src) errs.push(`continueFrom: no case "${continueFrom.case}"`);
      else if (continueFrom.row && !(Array.isArray(src.data) && src.data.some((r: DataRow) => r.id === continueFrom.row))) errs.push(`continueFrom: case "${continueFrom.case}" has no row "${continueFrom.row}"`);
      if (startPage) errs.push('a case that continues from another case starts on that case\'s last page — remove "page"');
    }
    const user = raw.user === undefined ? undefined : String(raw.user);
    const url = raw.url === undefined ? undefined : String(raw.url);
    if (user && user !== 'none' && !cfg.users[user]) errs.push(`user "${user}" is not defined (${Object.keys(cfg.users).join(', ') || 'no users yet'}) — add it in Data & settings`);
    if (continueFrom && (user || url)) errs.push('a case that continues from another case keeps its user and page — remove "user" / "url"');
    if (url && /^https?:\/\//i.test(url) && !url.includes('{{')) { /* absolute addresses are allowed (another system) */ }
    const loop = cycle(id);
    if (loop) errs.push(`circular dependency: ${loop.join(' → ')}`);

    // ---- references
    if (startPage && !repo.has(startPage)) errs.push(`start page "${startPage}" is not in the OR (${[...repo.keys()].join(', ')})`);
    const checkStep = (s: Step, where: string) => {
      if (s.page && !repo.has(s.page)) errs.push(`${where}: page "${s.page}" is not in the OR`);
      if (s.element) {
        const ref = parseElementRef(s.element);
        if (!ref) return errs.push(`${where}: "${s.element}" must look like page.element`);
        const page = repo.get(ref.page);
        if (!page) return errs.push(`${where}: page "${ref.page}" is not in the OR`);
        if (!page.elements[ref.element]) return errs.push(`${where}: element "${ref.element}" does not exist on page "${ref.page}"`);
        const missing = paramsOf(page, ref.element).filter((p) => !(p in ref.params));
        if (missing.length) errs.push(`${where}: ${s.element} needs parameter(s) ${missing.map((m) => `${m}=…`).join(', ')}`);
        // literal option values must exist on the page (values with {{…}} are checked at run time)
        const opts = page.elements[ref.element].options;
        if (opts?.length && s.value && !s.value.includes('{{') && ['select', 'choose', 'check', 'uncheck'].includes(s.action)) {
          for (const v of s.value.split(/\s*[,،]\s*/).filter(Boolean)) {
            if (!opts.some((o) => o.toLowerCase() === v.toLowerCase())) errs.push(`${where}: "${v}" is not an option of ${s.element} (${opts.join(' | ')})`);
          }
        }
      }
      for (const m of JSON.stringify(s).matchAll(/\{\{\s*(user|msg)\.(\w+)/g)) {
        if (m[1] === 'user' && !cfg.users[m[2]]) errs.push(`${where}: user "${m[2]}" is not in app.yml`);
        if (m[1] === 'msg' && cfg.messages.en?.[m[2]] === undefined) errs.push(`${where}: message "${m[2]}" is not in messages.yml`);
      }
    };
    steps.forEach((s) => checkStep(s, `steps #${s.index}`));
    for (const [name, list] of Object.entries(outcomes)) list.forEach((s) => checkStep(s, `outcome "${name}" #${s.index}`));

    // ---- runtime values: saved before use
    const checkVars = (list: Step[], saved: Set<string>, where: string) => {
      for (const st of list) {
        for (const v of varsUsed({ ...st, as: undefined })) if (!saved.has(v)) errs.push(`${where} #${st.index}: {{var.${v}}} is used before a "Save value" step creates it`);
        if (st.action === 'save' && st.as) saved.add(st.as);
      }
      return saved;
    };
    const afterSteps = checkVars(steps, inherited(id), 'steps');
    for (const [name, list] of Object.entries(outcomes)) checkVars(list, new Set(afterSteps), `outcome "${name}"`);

    // ---- data rows
    const ids = new Set<string>();
    data.forEach((row, i) => {
      const where = `data row ${i + 1}${row.id ? ` (${row.id})` : ''}`;
      if (row.id) { if (ids.has(row.id)) errs.push(`${where}: duplicate id`); ids.add(row.id); }
      if (row.type && !['positive', 'negative'].includes(row.type)) errs.push(`${where}: type must be positive or negative`);
      if (row.outcome && !outcomes[row.outcome]) errs.push(`${where}: outcome "${row.outcome}" is not defined (${Object.keys(outcomes).join(', ') || 'none'})`);
      const oc = outcomeFor(row, outcomes);
      const needed = dataFieldsUsed([...steps, ...(oc ? outcomes[oc] ?? [] : [])]);
      for (const f of needed) if (!(f in row)) errs.push(`${where}: missing value for "${f}" (used as {{data.${f}}})`);
      if (varsUsed(row).length) errs.push(`${where}: {{var.…}} can only be used in steps, not in data rows`);
      for (const m of JSON.stringify(row).matchAll(/\{\{\s*(user|msg)\.(\w+)/g)) {
        if (m[1] === 'user' && !cfg.users[m[2]]) errs.push(`${where}: user "${m[2]}" is not in app.yml`);
        if (m[1] === 'msg' && cfg.messages.en?.[m[2]] === undefined) errs.push(`${where}: message "${m[2]}" is not in messages.yml`);
      }
    });
    if (!data.length && dataFieldsUsed(steps).length) errs.push(`steps use {{data.…}} but the case has no data rows`);

    if (errs.length) {
      for (const message of errs) issues.push({ file, message });
      if (opts.strict) continue;
    }
    cases.push({ file, id, case: String(raw.case ?? file), description: raw.description as string | undefined, module: raw.module ? String(raw.module) : undefined, type: caseType as CaseDef['type'], user, url, dependsOn, continueFrom, page: startPage, tags, steps, outcomes, data });
  }
  return { cases, issues };
}
