/**
 * Generic runner for no-code cases — apps/<app>/cases/*.case.yml.
 * Every data row becomes one test: start page → shared steps → the row's checks.
 *   SUITE=smoke      run only the cases / rows of a suite (apps/<app>/suites.yml)
 *   dependsOn        linked cases run in order in one worker and share saved values
 *   continueFrom     replays another case first, then continues on the page it ended on
 * Nobody needs to edit this file to add tests.
 */
import { test } from '../src/fixtures';
import { readCases } from '../src/core/cases/loader';
import type { CaseDef, DataRow } from '../src/core/cases/model';
import { play, startPageOf, userOf } from '../src/core/cases/play';
import { chains, readSuites, selectRows } from '../src/core/cases/plan';

const { cases: loaded, issues } = readCases();

if (issues.length) {
  // Show every problem as a failing test with a clear message instead of crashing the run
  test.describe('Case files', () => {
    for (const i of issues) test(`✖ ${i.file}: ${i.message}`, () => { throw new Error(`apps/<app>/cases/${i.file} — ${i.message}`); });
  });
}

const valid = loaded.filter((x) => !issues.some((i) => i.file === x.file));
const byId = new Map(valid.map((c) => [c.id, c]));
// a case whose dependency / source has a problem can't run either
const runnable = valid.filter((c) => [...c.dependsOn, ...(c.continueFrom ? [c.continueFrom.case] : [])].every((d) => byId.has(d)));

const suiteName = process.env.SUITE;
const suite = suiteName ? readSuites().find((s) => s.name === suiteName) : undefined;
if (suiteName && !suite) test(`✖ suite "${suiteName}" not found in suites.yml`, () => { throw new Error(`No suite "${suiteName}" in apps/<app>/suites.yml`); });
const selected = selectRows(runnable, suite);

// ENGINE=mobile | performance runs only those cases; any other run (web, api, local) leaves them out: they need a
// device or k6, which only agents with that engine have
const runEngine = process.env.ENGINE;
for (const id of [...selected.keys()]) {
  const e = byId.get(id)?.engine ?? 'web';
  const special = e === 'mobile' || e === 'performance';
  if (runEngine === 'mobile' || runEngine === 'performance' ? e !== runEngine : special) selected.delete(id);
}

// ONLY_CASES=a,b / ONLY_ROWS=TC-001,TC-002 — a run started from the platform for chosen cases or rows
// (execution agent, ADR-0014). Cases the chosen ones depend on stay, so chains still work.
const onlyCases = (process.env.ONLY_CASES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const onlyRows = (process.env.ONLY_ROWS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (onlyCases.length) {
  const keep = new Set<string>();
  const add = (id: string) => {
    if (keep.has(id)) return;
    keep.add(id);
    const c = byId.get(id);
    for (const d of [...(c?.dependsOn ?? []), ...(c?.continueFrom ? [c.continueFrom.case] : [])]) add(d);
  };
  onlyCases.forEach(add);
  for (const id of [...selected.keys()]) if (!keep.has(id)) selected.delete(id);
}
// a run for chosen workflows only (ONLY_FLOWS without ONLY_CASES) runs no single cases
if ((process.env.ONLY_FLOWS ?? '').trim() && !onlyCases.length) selected.clear();
if (onlyRows.length) {
  for (const [id, rows] of selected) {
    if (onlyCases.length && !onlyCases.includes(id)) continue; // dependencies run whole
    const c = byId.get(id);
    for (const i of [...rows]) {
      const rowId = c?.data[i]?.id;
      if (!rowId || !onlyRows.includes(rowId)) rows.delete(i);
    }
    if (!rows.size) selected.delete(id);
  }
}

const startOf = (c: CaseDef) => startPageOf(c, byId);
// two cases (or two rows) with the same name must not stop the whole run: the repeated one gets its file id
const usedNames = new Set<string>();
const uniqueTitle = (name: string, extra: string, used: Set<string>) => {
  let t = used.has(name) ? `${name} [${extra}]` : name;
  for (let n = 2; used.has(t); n++) t = `${name} [${extra} #${n}]`;
  used.add(t);
  return t;
};
function declareCase(c: CaseDef, shared?: Record<string, string>) {
  const rows = selected.get(c.id);
  if (!rows) return;
  const start = startOf(c);
  const user = userOf(c, byId);
  const tags = [...new Set([...c.tags, ...(start ? [`@${start}`] : []), ...(user ? [`@as-${user}`] : [])])];
  const annotation = [{ type: 'case-file', description: `cases/${c.file}` }, ...(c.module ? [{ type: 'module', description: c.module }] : [])];
  test.describe(uniqueTitle(c.case, c.id, usedNames), { tag: tags, annotation }, () => {
    const usedRows = new Set<string>();
    (c.data.length ? c.data : [{ type: c.type } as DataRow]).forEach((row, i) => {
      if (!rows.has(i)) return;
      const title = uniqueTitle(`${row.id ? `${row.id} · ` : ''}${row.title ?? c.case}`, `row ${i + 1}`, usedRows);
      const rowTags = [row.type ? `@${row.type}` : '', row.id ? `@${row.id}` : '', ...(row.tags ?? []).map((t) => (t.startsWith('@') ? t : '@' + t))].filter(Boolean);
      (row.skip ? test.skip : test)(title, { tag: rowTags }, async ({ ui, page, data }) => {
        const vars: Record<string, string> = { ...(shared ?? {}) };
        await play(c, row, ui, page, data.faker, vars, byId);
        if (shared) Object.assign(shared, vars); // values for the cases that depend on this one
      });
    });
  });
}

for (const chain of chains(runnable.filter((c) => selected.has(c.id)))) {
  if (chain.length === 1) { declareCase(chain[0]); continue; }
  // dependent cases: one worker, in order, saved values flow to the next case; a failure skips the rest
  test.describe.serial(uniqueTitle(`⛓ ${chain.map((c) => c.case).join(' → ')}`, chain[0].id, usedNames), () => {
    const shared: Record<string, string> = {};
    for (const c of chain) declareCase(c, shared);
  });
}
