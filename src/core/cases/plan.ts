/**
 * Run planning for no-code cases:
 *   • Run suites  — apps/<app>/suites.yml picks cases by module, tag or name (Smoke, Regression…)
 *   • Chains      — cases linked by `dependsOn` run in order, in one worker, sharing saved values;
 *                   when a case fails, the cases after it are skipped (not failed misleadingly)
 *
 *   suites:
 *     smoke:
 *       description: Quick check after every deployment
 *       tags: ['@smoke']          # rows or cases with any of these tags
 *     regression:
 *       modules: [Login, Cart]    # every case of these modules
 *       cases: [profile-form]     # these cases (file name without .case.yml)
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { appDir, currentApp } from '../app';
import type { CaseDef, DataRow } from './model';

export interface Suite { name: string; description?: string; modules?: string[]; tags?: string[]; cases?: string[] }

export const suitesFile = (app = currentApp()) => path.join(appDir(app), 'suites.yml');

export function readSuites(app = currentApp()): Suite[] {
  const f = suitesFile(app);
  if (!fs.existsSync(f)) return [];
  const raw = (YAML.parse(fs.readFileSync(f, 'utf8')) ?? {}) as { suites?: Record<string, Omit<Suite, 'name'>> };
  return Object.entries(raw.suites ?? {}).map(([name, s]) => ({ name, ...s, tags: (s.tags ?? []).map((t) => (t.startsWith('@') ? t : '@' + t)) }));
}

export function writeSuites(app: string, suites: Suite[]) {
  const doc = { suites: Object.fromEntries(suites.map(({ name, ...s }) => [name, Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length) && v !== ''))])) };
  fs.writeFileSync(suitesFile(app), '# Run suites — pick cases by module, tag or name (edit in Control Panel → Run)\n' + YAML.stringify(doc));
}

export const rowTags = (c: CaseDef, row: DataRow) =>
  [...c.tags, ...(row.type ? [`@${row.type}`] : []), ...(row.tags ?? []).map((t) => (t.startsWith('@') ? t : '@' + t))];

/** rows of each case a suite runs (dependencies included, whole case) — undefined suite = everything */
export function selectRows(cases: CaseDef[], suite?: Suite): Map<string, Set<number>> {
  const sel = new Map<string, Set<number>>();
  const all = (c: CaseDef) => new Set((c.data.length ? c.data : [{}]).map((_, i) => i));
  for (const c of cases) {
    if (!suite || suite.cases?.includes(c.id) || (c.module && suite.modules?.includes(c.module))) { sel.set(c.id, all(c)); continue; }
    if (suite.tags?.length) {
      const rows = (c.data.length ? c.data : [{} as DataRow]).map((r, i) => (rowTags(c, r).some((t) => suite.tags!.includes(t)) ? i : -1)).filter((i) => i >= 0);
      if (rows.length) sel.set(c.id, new Set(rows));
    }
  }
  // a selected case needs the cases it depends on
  const byId = new Map(cases.map((c) => [c.id, c]));
  const add = (id: string) => {
    for (const d of byId.get(id)?.dependsOn ?? []) {
      const dc = byId.get(d);
      if (dc && !sel.has(d)) { sel.set(d, all(dc)); add(d); }
    }
  };
  [...sel.keys()].forEach(add);
  return sel;
}

/** groups of cases linked by dependsOn, each in run order (independent cases are groups of one) */
export function chains(cases: CaseDef[]): CaseDef[][] {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const parent = new Map(cases.map((c) => [c.id, c.id]));
  const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
  for (const c of cases) for (const d of c.dependsOn) if (byId.has(d)) parent.set(find(c.id), find(d));
  const groups = new Map<string, CaseDef[]>();
  for (const c of cases) { const r = find(c.id); groups.set(r, [...(groups.get(r) ?? []), c]); }
  return [...groups.values()].map((g) => {
    const ordered: CaseDef[] = [], done = new Set<string>();
    const visit = (c: CaseDef) => { if (done.has(c.id)) return; done.add(c.id); c.dependsOn.forEach((d) => byId.get(d) && g.includes(byId.get(d)!) && visit(byId.get(d)!)); ordered.push(c); };
    g.forEach(visit);
    return ordered;
  });
}
