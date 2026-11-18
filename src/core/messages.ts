/**
 * Messages that appear after an action (toasts, alert boxes, modal dialogs): save them in the Smart OR of a page,
 * and turn them into checks. Shared by 🧭 Explore and by "What the run found" after a test run.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { orDir } from './app';
import { messageElements, uniqueName, type SeenMessage } from './harvest';
import type { Step } from './cases/model';

/** a message saved in the Smart OR: page.element (+ its close button) */
export interface FoundMessage { element: string; close?: string; text: string; kind: 'alert' | 'dialog'; tone?: 'error' | 'success' | 'info' }

const locOf = (d: Record<string, unknown>) => JSON.stringify(d.testid ?? d.id ?? d.css ?? '');

/** OR element of a page that already holds this message (same locator, or the same text seen before) */
export function knownMessage(app: string, pageKey: string, m: SeenMessage): string | undefined {
  const file = path.join(orDir(app), `${pageKey}.page.yml`);
  if (!fs.existsSync(file)) return undefined;
  const els = ((YAML.parse(fs.readFileSync(file, 'utf8')) ?? {}).elements ?? {}) as Record<string, Record<string, unknown>>;
  const loc = JSON.stringify(m.testid ?? m.id ?? m.css);
  const msgs = Object.entries(els).filter(([, d]) => ['alert', 'dialog'].includes(String(d.control)));
  return (msgs.find(([, d]) => locOf(d) === loc) ?? msgs.find(([, d]) => d.control === m.kind && ((d.messages as string[]) ?? []).includes(m.text)))?.[0];
}

/** seen messages → elements of an OR page (merged with the ones it already has, new texts added) */
export function saveMessages(app: string, pageKey: string, seen: SeenMessage[]): FoundMessage[] {
  const file = path.join(orDir(app), `${pageKey}.page.yml`);
  if (!fs.existsSync(file) || !seen.length) return [];
  const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
  const els = (doc.get('elements') as YAML.YAMLMap) ?? doc.createNode({});
  const current = (els.toJSON?.() ?? {}) as Record<string, Record<string, unknown>>;
  const used = new Set(Object.keys(current));
  const found: FoundMessage[] = [];
  for (const m of messageElements(seen, new Set(used))) {
    const existing = Object.entries(current).find(([, d]) => locOf(d) === locOf(m.def));
    let name: string;
    if (existing) {
      name = existing[0];
      const texts = new Set([...((existing[1].messages as string[]) ?? []), ...(m.def.messages as string[])]);
      els.setIn([name, 'messages'], doc.createNode([...texts]));
      if (!existing[1].control) els.setIn([name, 'control'], m.def.control);
    } else {
      name = uniqueName(m.name, used);
      els.set(name, doc.createNode(m.def));
      current[name] = m.def;
    }
    let close: string | undefined;
    if (m.close) {
      const ex = Object.entries(current).find(([, d]) => locOf(d) === locOf(m.close!.def));
      const cn = ex ? ex[0] : uniqueName(`${name}Close`, used);
      if (!ex) { els.set(cn, doc.createNode(m.close.def)); current[cn] = m.close.def; }
      close = `${pageKey}.${cn}`;
    }
    found.push({ element: `${pageKey}.${name}`, close, text: m.msg.text, kind: m.msg.kind, tone: m.msg.tone });
  }
  doc.set('elements', els);
  fs.writeFileSync(file, doc.toString({ lineWidth: 0 }));
  return found;
}

/** checks for messages: toasts first (they disappear by themselves), dialogs last — checked, then closed */
export function messageChecks(list: FoundMessage[], withText = true): Step[] {
  return [...list].sort((a, b) => (a.kind === 'dialog' ? 1 : 0) - (b.kind === 'dialog' ? 1 : 0)).flatMap((f) => [
    { action: 'visible', element: f.element } as Step,
    ...(withText && f.text ? [{ action: 'text', element: f.element, matcher: 'contains', expected: f.text.slice(0, 80) } as Step] : []),
    ...(f.close ? [{ action: 'click', element: f.close } as Step] : []),
  ]);
}
