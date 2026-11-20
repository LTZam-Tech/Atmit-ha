/**
 * No-code test case model — apps/<app>/cases/*.case.yml
 *
 *   case: Login
 *   page: login                 # start page: opened first, its `auth` decides the session
 *   tags: ['@smoke']
 *   steps:                      # shared by every data row
 *     - fill: { element: login.username, value: "{{data.username}}" }
 *     - fill: { element: login.password, value: "{{data.password}}" }
 *     - click: login.submit
 *   outcomes:                   # what to verify, chosen per row by `outcome`
 *     success:
 *       - visible: inventory.title
 *     error:
 *       - text: { element: login.errorMessage, equals: "{{data.message}}" }
 *   type: positive              # optional — one scenario, one expected result: every row is positive (or negative)
 *   user: doctor                # optional — start logged in as this user ('none' = logged out); default: the page's auth
 *   url: /patients/new?type=walk-in   # optional — start at this address (relative to the environment)
 *   module: Login               # optional — groups cases (Registration, Billing…)
 *   dependsOn: [register]       # optional — runs after these cases, uses the values they saved
 *   continueFrom: { case: login, row: TC-001 }   # optional — first replays that case, then continues on its last page
 *   (rows without `outcome`: positive rows use the success checks, negative rows the error checks)
 *   data:
 *     - { id: TC-001, title: valid user, type: positive, outcome: success, username: "{{user.standard.username}}", password: "{{user.standard.password}}" }
 *     - { id: TC-101, title: wrong password, type: negative, outcome: error, username: "{{user.standard.username}}", password: "{{faker.internet.password}}", message: "{{msg.invalidCredentials}}" }
 */
import type { StepKind } from '../../utils/steps';

export const ACTIONS = {
  // Navigate
  open: { kind: 'Navigate', target: 'page', label: 'Open page' },
  goto: { kind: 'Navigate', target: 'url', label: 'Go to URL' },
  // Data entry
  fill: { kind: 'Data entry', target: 'element', value: true, label: 'Type into' },
  clear: { kind: 'Data entry', target: 'element', label: 'Clear' },
  select: { kind: 'Data entry', target: 'element', value: true, label: 'Select from dropdown' },
  choose: { kind: 'Data entry', target: 'element', value: true, label: 'Choose radio option' },
  check: { kind: 'Data entry', target: 'element', valueOptional: true, label: 'Tick checkbox(es)' },
  uncheck: { kind: 'Data entry', target: 'element', valueOptional: true, label: 'Untick checkbox(es)' },
  // Click
  click: { kind: 'Click', target: 'element', label: 'Click' },
  dblclick: { kind: 'Click', target: 'element', label: 'Double click' },
  hover: { kind: 'Click', target: 'element', label: 'Hover' },
  press: { kind: 'Click', target: 'element?', value: true, label: 'Press key' },
  // Verify
  visible: { kind: 'Verify', target: 'element', label: 'Is visible' },
  hidden: { kind: 'Verify', target: 'element', label: 'Is NOT visible' },
  enabled: { kind: 'Verify', target: 'element', label: 'Is enabled' },
  disabled: { kind: 'Verify', target: 'element', label: 'Is disabled' },
  text: { kind: 'Verify', target: 'element', match: true, label: 'Text' },
  value: { kind: 'Verify', target: 'element', match: true, label: 'Field value' },
  count: { kind: 'Verify', target: 'element', match: true, label: 'Number of elements' },
  url: { kind: 'Verify', target: 'none', match: true, label: 'Page URL' },
  title: { kind: 'Verify', target: 'none', match: true, label: 'Page title' },
  link: { kind: 'Verify', target: 'element', match: true, label: 'Link works (address + answer)' },
  // Wait (use sparingly — Playwright waits automatically)
  waitFor: { kind: 'Verify', target: 'element', label: 'Wait until visible' },
  // Runtime values — capture something from the page for later steps: {{var.<name>}}
  save: { kind: 'Data entry', target: 'element?', save: true, label: 'Save value as variable' },
} as const satisfies Record<string, { kind: StepKind; target: string; label: string; value?: boolean; valueOptional?: boolean; match?: boolean; save?: boolean }>;

export type Action = keyof typeof ACTIONS;
export const MATCHERS = ['equals', 'contains'] as const;
export type Matcher = (typeof MATCHERS)[number];

/** A step as written in YAML: { <action>: string | { element?, value?, equals?, contains?, key? } } */
export type RawStep = Record<string, unknown>;

export interface Step {
  action: Action;
  page?: string;      // open
  element?: string;   // page.element(params)
  url?: string;       // goto
  value?: string;     // fill/select/press
  matcher?: Matcher;  // text/value/count/url/title
  expected?: string;
  name?: string;      // optional custom title in the report
  index?: number;     // position in the YAML list (for messages)
  as?: string;        // save: variable name → {{var.<as>}}
  pattern?: string;   // save: regex, first group (or whole match) is kept
  /** API engine steps (engine: api): the step's body, validated by src/core/api-engine/model.ts */
  api?: Record<string, unknown>;
  /** mobile engine steps (engine: mobile): the step's body, validated by src/core/mobile-engine/model.ts */
  mobile?: Record<string, unknown>;
}

export interface DataRow {
  id?: string;
  title?: string;
  type?: 'positive' | 'negative';
  outcome?: string;
  tags?: string[];
  skip?: boolean;
  [field: string]: unknown;
}

export interface CaseDef {
  file: string;
  /** file name without .case.yml — how other cases refer to this one */
  id: string;
  case: string;
  description?: string;
  /** web (default) runs browser steps; api HTTP steps; mobile an app through Appium; performance load through k6 */
  engine?: 'web' | 'api' | 'mobile' | 'performance';
  /** performance cases: how much load, and the limits it must stay within (src/core/performance-engine) */
  load?: import('../performance-engine/model').LoadProfile;
  thresholds?: import('../performance-engine/model').Thresholds;
  module?: string;
  /** positive = the scenario must succeed, negative = it must be rejected; every row inherits it */
  type?: 'positive' | 'negative';
  dependsOn: string[];
  continueFrom?: { case: string; row?: string };
  page?: string;
  /** start at this address instead of the page's URL (relative to the environment, may use {{…}}) */
  url?: string;
  /** user whose saved session the case starts with ('none' = logged out); default: the start page's auth */
  user?: string;
  tags: string[];
  steps: Step[];
  outcomes: Record<string, Step[]>;
  data: DataRow[];
}

export const RESERVED_ROW_KEYS = new Set(['id', 'title', 'type', 'outcome', 'tags', 'skip']);

/** "inventory.addToCart(sku=backpack, size=M)" → { page, element, params } */
export function parseElementRef(ref: string): { page: string; element: string; params: Record<string, string> } | undefined {
  const m = /^\s*([a-zA-Z][\w]*)\.([a-zA-Z][\w]*)\s*(?:\((.*)\))?\s*$/.exec(ref);
  if (!m) return undefined;
  const params: Record<string, string> = {};
  if (m[3]?.trim()) {
    for (const part of m[3].split(/,(?![^{]*\}\})/)) {
      const i = part.indexOf('=');
      if (i > 0) params[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
  }
  return { page: m[1], element: m[2], params };
}

/** YAML step → normalized Step (throws a readable error) */
export function normalizeStep(raw: RawStep, where: string): Step {
  if (!raw || typeof raw !== 'object') throw new Error(`${where}: a step must be an object like "click: login.submit"`);
  const name = typeof raw.name === 'string' ? raw.name : undefined;
  const keys = Object.keys(raw).filter((k) => k !== 'name');
  if (keys.length !== 1) throw new Error(`${where}: a step needs exactly one action, found [${keys.join(', ')}]`);
  const action = keys[0] as Action;
  const spec = ACTIONS[action];
  if (!spec) throw new Error(`${where}: unknown action "${action}". Use one of: ${Object.keys(ACTIONS).join(', ')}`);
  const body = raw[action];
  const step: Step = { action, name };
  const obj = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));

  if (spec.target === 'page') step.page = str(typeof body === 'string' ? body : obj.page);
  else if (spec.target === 'url') step.url = str(typeof body === 'string' ? body : obj.url);
  else if (spec.target === 'element' || spec.target === 'element?') step.element = str(typeof body === 'string' && action !== 'press' ? body : obj.element);

  if ('value' in spec && spec.value) step.value = str(action === 'press' ? (typeof body === 'string' ? body : obj.key ?? obj.value) : obj.value);
  if ('valueOptional' in spec && spec.valueOptional && typeof body === 'object') step.value = str(obj.value);
  if ('match' in spec && spec.match) {
    const m = MATCHERS.find((k) => k in obj);
    if (!m) throw new Error(`${where}: "${action}" needs "equals" or "contains"`);
    step.matcher = m;
    step.expected = str(obj[m]);
  }
  if ('save' in spec && spec.save) {
    step.as = str(obj.as);
    step.pattern = str(obj.pattern);
    if (!step.as || !/^\w+$/.test(step.as)) throw new Error(`${where}: "save" needs "as: <name>" (letters, digits, _)`);
    if (step.pattern) { try { new RegExp(step.pattern); } catch { throw new Error(`${where}: invalid pattern ${step.pattern}`); } }
  }
  if ((spec.target === 'element') && !step.element) throw new Error(`${where}: "${action}" needs an element (page.element)`);
  if (spec.target === 'page' && !step.page) throw new Error(`${where}: "open" needs a page`);
  if (spec.target === 'url' && !step.url) throw new Error(`${where}: "goto" needs a url`);
  if ('value' in spec && spec.value && step.value === undefined) throw new Error(`${where}: "${action}" needs a value`);
  return step;
}

/** Normalized Step → YAML form (used by the Control Panel when saving) */
export function serializeStep(s: Step): RawStep {
  const spec = ACTIONS[s.action];
  let body: unknown;
  if (spec.target === 'page') body = s.page;
  else if (spec.target === 'url') body = s.url;
  else if ('match' in spec && spec.match) body = { ...(s.element ? { element: s.element } : {}), [s.matcher ?? 'equals']: s.expected ?? '' };
  else if (s.action === 'press') body = s.element ? { element: s.element, key: s.value } : s.value;
  else if (s.action === 'save') body = { ...(s.element ? { element: s.element } : {}), as: s.as ?? '', ...(s.pattern ? { pattern: s.pattern } : {}) };
  else if ('value' in spec && spec.value) body = { element: s.element, value: s.value ?? '' };
  else if ('valueOptional' in spec && spec.valueOptional && s.value) body = { element: s.element, value: s.value };
  else body = s.element;
  return { ...(s.name ? { name: s.name } : {}), [s.action]: body };
}

/** {{var.x}} references in any value */
export const varsUsed = (v: unknown): string[] => [...JSON.stringify(v).matchAll(/\{\{\s*var\.(\w+)\s*\}\}/g)].map((m) => m[1]);

/** {{data.x}} references used by a list of steps */
export function dataFieldsUsed(steps: Step[]): string[] {
  const out = new Set<string>();
  for (const m of JSON.stringify(steps.map(({ index, ...s }) => s)).matchAll(/\{\{\s*data\.(\w+)\s*\}\}/g)) out.add(m[1]);
  return [...out];
}

export const caseId = (file: string) => file.replace(/\.case\.ya?ml$/, '');

/** Outcome a row uses: its own `outcome`, else by type (positive → success/positive, negative → error/negative/failure), else `default` */
export function outcomeFor(row: DataRow, outcomes: Record<string, unknown>): string | undefined {
  if (row.outcome) return row.outcome;
  const pick = (names: string[]) => names.find((n) => n in outcomes);
  if (row.type === 'negative') return pick(['error', 'negative', 'failure', 'rejected', 'default']);
  return pick(['success', 'positive', 'default']);
}
