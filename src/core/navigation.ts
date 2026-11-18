/**
 * Navigation map — apps/<app>/navigation.yml: how to get from one page to another.
 *
 *   edges:
 *     - from: home
 *       to: patientForm
 *       steps:
 *         - click: home.patientsMenu
 *         - click: patientList.newButton
 *
 * A page with `open: navigate` in its OR file is never opened by URL: the runner finds the
 * shortest route from a page that does open by URL and replays the steps.
 * Recorded journeys add edges automatically.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { appDir, currentApp, orDir } from './app';
import { readRepository } from './or/loader';
import type { NormalizedPageDef } from './or/types';
import { normalizeStep, parseElementRef, type RawStep, type Step } from './cases/model';

export interface Edge { from: string; to: string; steps: Step[] }
export interface RawEdge { from: string; to: string; steps: RawStep[] }

export const navFile = (app = currentApp()) => path.join(appDir(app), 'navigation.yml');

export function readRawNavigation(app = currentApp()): RawEdge[] {
  const f = navFile(app);
  if (!fs.existsSync(f)) return [];
  const doc = YAML.parse(fs.readFileSync(f, 'utf8')) ?? {};
  return Array.isArray(doc.edges) ? doc.edges : [];
}

export function readNavigation(app = currentApp(), repo?: Map<string, NormalizedPageDef>): { edges: Edge[]; issues: string[] } {
  const issues: string[] = [];
  const pages = repo ?? (() => { try { return readRepository(orDir(app)); } catch { return new Map(); } })();
  const edges: Edge[] = [];
  readRawNavigation(app).forEach((e, i) => {
    const where = `navigation edge ${i + 1} (${e.from} → ${e.to})`;
    if (!pages.has(e.from)) issues.push(`${where}: page "${e.from}" is not in the OR`);
    if (!pages.has(e.to)) issues.push(`${where}: page "${e.to}" is not in the OR`);
    const steps: Step[] = [];
    (e.steps ?? []).forEach((s, j) => {
      try {
        const st = normalizeStep(s, `${where} step ${j + 1}`);
        if (st.element) {
          const ref = parseElementRef(st.element);
          if (!ref || !pages.get(ref.page)?.elements[ref.element]) issues.push(`${where} step ${j + 1}: element "${st.element}" not found`);
        }
        steps.push(st);
      } catch (err) { issues.push((err as Error).message); }
    });
    if (!steps.length) issues.push(`${where}: needs at least one step`);
    edges.push({ from: e.from, to: e.to, steps });
  });
  return { edges, issues };
}

export function writeNavigation(app: string, edges: RawEdge[]) {
  // de-duplicate identical routes
  const seen = new Set<string>();
  const unique = edges.filter((e) => { const k = JSON.stringify([e.from, e.to, e.steps]); if (seen.has(k)) return false; seen.add(k); return true; });
  fs.writeFileSync(navFile(app), '# Navigation map — how to reach one page from another (edit in Control Panel → Pages → Map)\n' + YAML.stringify({ edges: unique }, { lineWidth: 0 }));
}

/** Shortest route to `target` starting from any page that opens by URL */
export function findRoute(target: string, edges: Edge[], pages: Map<string, NormalizedPageDef>): { start: string; edges: Edge[] } | null {
  const starts = [...pages.values()].filter((p) => p.open !== 'navigate').map((p) => p.page);
  const queue: { page: string; path: Edge[] }[] = starts.map((s) => ({ page: s, path: [] }));
  const seen = new Set(starts);
  while (queue.length) {
    const { page, path: route } = queue.shift()!;
    if (page === target && route.length) return { start: route[0].from, edges: route };
    for (const e of edges.filter((x) => x.from === page)) {
      if (e.to === target) return { start: (route[0] ?? e).from, edges: [...route, e] };
      if (!seen.has(e.to)) { seen.add(e.to); queue.push({ page: e.to, path: [...route, e] }); }
    }
  }
  return null;
}
