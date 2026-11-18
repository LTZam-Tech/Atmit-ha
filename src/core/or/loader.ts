/**
 * Loads every or/*.page.yml, validates it against or/or.schema.json plus semantic rules,
 * expands shorthands and caches the result. Any mistake stops the run with a clear message.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import Ajv from 'ajv';
import { ELEMENT_KEYS, STRATEGY_KEYS, type ElementDef, type NormalizedPageDef, type PageDef } from './types';

import { currentApp, orDir } from '../app';

/** OR folder of the current app (apps/<app>/or) */
export const OR_DIR = orDir(currentApp());
export const SCHEMA_FILE = path.join(import.meta.dirname, 'or.schema.json');
const schema = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));
const validate = new Ajv({ allErrors: true, allowUnionTypes: true }).compile(schema);

let cache: Map<string, NormalizedPageDef> | undefined;

/** Current app's repository (cached for the test run). Pass a dir to read another app (never cached). */
export function loadRepository(dir?: string): Map<string, NormalizedPageDef> {
  if (!dir) return (cache ??= readRepository(OR_DIR));
  return readRepository(dir);
}

/** Reads and validates every *.page.yml in a folder (no cache) */
export function readRepository(dir: string): Map<string, NormalizedPageDef> {
  const pages = new Map<string, NormalizedPageDef>();
  const errors: string[] = [];

  if (!fs.existsSync(dir)) return pages;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.page.yml')).sort()) {
    const full = path.join(dir, file);
    let raw: PageDef;
    try {
      raw = YAML.parse(fs.readFileSync(full, 'utf8'));
    } catch (e) {
      errors.push(`${file}: invalid YAML — ${(e as Error).message}`);
      continue;
    }
    // Semantic rules first — they give the clearest messages (typos, missing strategy, bad `within`)
    const fileErrors = raw && typeof raw === 'object' && raw.elements ? semanticCheck(raw, file) : [];
    if (fileErrors.length) {
      errors.push(...fileErrors);
      continue;
    }
    if (!validate(raw)) {
      errors.push(...schemaErrors(file));
      continue;
    }
    if (pages.has(raw.page)) errors.push(`${file}: duplicate page key "${raw.page}" (also in ${pages.get(raw.page)!.file})`);
    pages.set(raw.page, normalize(raw, file));
  }

  if (errors.length) {
    throw new Error(`[Smart OR] Repository has ${errors.length} problem(s):\n  - ${errors.join('\n  - ')}`);
  }
  return pages;
}

/** One readable message per location instead of Ajv's oneOf noise */
function schemaErrors(file: string): string[] {
  const byPath = new Map<string, string>();
  for (const err of validate.errors ?? []) {
    const where = err.instancePath || '/';
    const msg = err.keyword === 'oneOf' || err.keyword === 'required'
      ? 'invalid definition — check the strategy key and value types'
      : err.message ?? 'invalid';
    if (!byPath.has(where) || err.keyword === 'additionalProperties' || err.keyword === 'type') byPath.set(where, msg);
  }
  return [...byPath].map(([where, msg]) => `${file}: ${where} ${msg}`);
}

function normalize(raw: PageDef, file: string): NormalizedPageDef {
  const strategy = raw.settings?.defaultStrategy ?? 'testid';
  const elements: Record<string, ElementDef> = {};
  for (const [name, def] of Object.entries(raw.elements)) {
    elements[name] = typeof def === 'string' ? { [strategy]: def } : def;
  }
  return { ...raw, elements, file };
}

function semanticCheck(raw: PageDef, file: string): string[] {
  const errs: string[] = [];
  const names = Object.keys(raw.elements);
  if (raw.readyWhen && !names.includes(raw.readyWhen)) errs.push(`${file}: readyWhen "${raw.readyWhen}" is not an element`);

  for (const [name, def] of Object.entries(raw.elements)) {
    if (typeof def === 'string') continue;
    const unknown = Object.keys(def).filter((k) => !ELEMENT_KEYS.has(k));
    if (unknown.length) errs.push(`${file}: element "${name}" has unknown key(s): ${unknown.join(', ')}`);
    const strategies = STRATEGY_KEYS.filter((k) => k in def);
    if (strategies.length !== 1) errs.push(`${file}: element "${name}" must have exactly one strategy, found [${strategies.join(', ')}]`);
    if (def.within && !names.includes(def.within)) errs.push(`${file}: element "${name}" within "${def.within}" which does not exist`);
    if (def.within === name) errs.push(`${file}: element "${name}" cannot be within itself`);
    // cycle check
    const seen = new Set([name]);
    let parent = def.within;
    while (parent) {
      if (seen.has(parent)) { errs.push(`${file}: circular "within" chain at "${name}"`); break; }
      seen.add(parent);
      const p = raw.elements[parent];
      parent = typeof p === 'object' ? p.within : undefined;
    }
  }
  return errs;
}

/** Placeholder names like {sku} used by an element (including its parents via `within`). */
export function paramsOf(page: NormalizedPageDef, element: string): string[] {
  const out = new Set<string>();
  let current: string | undefined = element;
  while (current) {
    const def: ElementDef = page.elements[current];
    for (const m of JSON.stringify(def).matchAll(/\{(\w+)\}/g)) out.add(m[1]);
    current = def.within;
  }
  return [...out];
}
