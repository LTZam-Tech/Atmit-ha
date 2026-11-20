/**
 * The no-code step vocabulary, mirrored from the engine so the builder writes exactly what the engine reads:
 *   web steps  ← src/core/cases/model.ts (ACTIONS, MATCHERS, normalizeStep, serializeStep)
 *   API steps  ← src/core/api-engine/model.ts (API_ACTIONS)
 *   mobile     ← src/core/mobile-engine/model.ts (MOBILE_ACTIONS); performance ← src/core/performance-engine/model.ts
 * Keep both in step when the engine gains an action.
 */

export type StepKind = 'Navigate' | 'Data entry' | 'Click' | 'Verify' | 'API';

export interface ActionSpec {
  kind: StepKind;
  target: 'page' | 'url' | 'element' | 'element?' | 'none';
  label: string;
  value?: boolean;
  valueOptional?: boolean;
  match?: boolean;
  save?: boolean;
}

export const WEB_ACTIONS: Record<string, ActionSpec> = {
  open: { kind: 'Navigate', target: 'page', label: 'Open page' },
  goto: { kind: 'Navigate', target: 'url', label: 'Go to URL' },
  fill: { kind: 'Data entry', target: 'element', value: true, label: 'Type into' },
  clear: { kind: 'Data entry', target: 'element', label: 'Clear' },
  select: { kind: 'Data entry', target: 'element', value: true, label: 'Select from dropdown' },
  choose: { kind: 'Data entry', target: 'element', value: true, label: 'Choose radio option' },
  check: { kind: 'Data entry', target: 'element', valueOptional: true, label: 'Tick checkbox(es)' },
  uncheck: { kind: 'Data entry', target: 'element', valueOptional: true, label: 'Untick checkbox(es)' },
  click: { kind: 'Click', target: 'element', label: 'Click' },
  dblclick: { kind: 'Click', target: 'element', label: 'Double click' },
  hover: { kind: 'Click', target: 'element', label: 'Hover' },
  press: { kind: 'Click', target: 'element?', value: true, label: 'Press key' },
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
  waitFor: { kind: 'Verify', target: 'element', label: 'Wait until visible' },
  save: { kind: 'Data entry', target: 'element?', save: true, label: 'Save value as variable' },
};

export const API_ACTIONS: Record<string, { kind: StepKind; label: string; example: string }> = {
  request: {
    kind: 'API', label: 'Send request',
    example: '{ "method": "POST", "url": "/api/orders", "json": { "sku": "{{data.sku}}" } }'
      + '   or   { "use": "login", "json": { "user": "{{data.user}}" } }'
      + '   ·   auth: { "bearer": "…" } | { "basic": { "username", "password" } } | { "apiKey": { "in": "header", "name": "X-Api-Key", "value": "…" } }'
      + ' | { "oauth2": { "tokenUrl": "/oauth/token", "clientId": "…", "clientSecret": "{{env.secret}}", "scope": "orders" } }'
      + '   ·   body: json | form | body | multipart: { "file": { "name": "a.txt", "mimeType": "text/plain", "content": "hi" } }',
  },
  status: { kind: 'Verify', label: 'Response status', example: '200   or   { "in": [400, 422] }' },
  header: { kind: 'Verify', label: 'Response header', example: '{ "name": "content-type", "contains": "json" }' },
  json: { kind: 'Verify', label: 'Response body (JSON path)', example: '{ "path": "$.status", "equals": "NEW" }' },
  body: { kind: 'Verify', label: 'Response body (text)', example: '{ "contains": "created" }' },
  schema: { kind: 'Verify', label: 'Response matches JSON Schema', example: '{ "type": "object", "required": ["id"] }' },
  time: { kind: 'Verify', label: 'Response time', example: '{ "below": 1500 }' },
  save: { kind: 'Data entry', label: 'Save value as variable', example: '{ "path": "$.id", "as": "orderId" }' },
};

export const MOBILE_ACTIONS: Record<string, { kind: StepKind; label: string; example: string }> = {
  launch: { kind: 'Navigate', label: 'Open the app', example: 'null   or   "com.example.app"' },
  close: { kind: 'Navigate', label: 'Close the app', example: 'null' },
  back: { kind: 'Navigate', label: 'Back', example: 'null' },
  tap: { kind: 'Click', label: 'Tap', example: '{ "accessibility": "login" }   or   "login.submit"' },
  type: { kind: 'Data entry', label: 'Type into', example: '{ "element": { "accessibility": "username" }, "value": "{{data.user}}" }' },
  clear: { kind: 'Data entry', label: 'Clear', example: '{ "id": "com.example:id/search" }' },
  hideKeyboard: { kind: 'Data entry', label: 'Hide the keyboard', example: 'null' },
  swipe: { kind: 'Click', label: 'Swipe', example: '"up"   or   { "direction": "left", "element": { "id": "carousel" } }' },
  visible: { kind: 'Verify', label: 'Is visible', example: '{ "accessibility": "home" }' },
  hidden: { kind: 'Verify', label: 'Is NOT visible', example: '{ "text": "Loading" }' },
  text: { kind: 'Verify', label: 'Text', example: '{ "element": { "id": "title" }, "equals": "Welcome" }' },
  wait: { kind: 'Verify', label: 'Wait until visible', example: '{ "element": { "accessibility": "list" }, "timeout": 20000 }' },
  save: { kind: 'Data entry', label: 'Save value as variable', example: '{ "element": { "id": "order" }, "as": "orderId" }' },
  screenshot: { kind: 'Verify', label: 'Take a screenshot', example: '"after login"' },
};

/** a performance case: what one virtual user does (requests, status checks, saved values, pauses) */
export const PERF_ACTIONS: Record<string, { kind: StepKind; label: string; example: string }> = {
  request: { ...API_ACTIONS['request'], example: '{ "method": "GET", "url": "/api/orders", "auth": { "bearer": "{{var.token}}" } }   or   { "use": "listOrders" }' },
  status: API_ACTIONS['status'],
  save: API_ACTIONS['save'],
  think: { kind: 'Verify', label: 'Pause (think time, ms)', example: '1000' },
};

export type Engine = 'web' | 'api' | 'mobile' | 'performance';

/** the actions of an engine whose steps are edited as a value (every engine except web) */
export function bodyActions(engine: Engine) {
  return engine === 'mobile' ? MOBILE_ACTIONS : engine === 'performance' ? PERF_ACTIONS : API_ACTIONS;
}

export const MATCHERS = ['equals', 'contains'] as const;
export const RESERVED_ROW_KEYS = new Set(['id', 'title', 'type', 'outcome', 'tags', 'skip']);
export const KEYS = ['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowDown', 'ArrowUp', 'Space'];

/** One editable step row. `raw` keeps a step the builder cannot show, so nothing is ever lost. */
export interface BuilderStep {
  action: string;
  name: string;
  page: string;
  element: string;
  url: string;
  value: string;
  matcher: 'equals' | 'contains';
  expected: string;
  as: string;
  pattern: string;
  /** API steps: the step body as JSON text (or a bare value such as 200) */
  body: string;
  raw?: Record<string, unknown>;
  problem?: string;
}

export const emptyStep = (action = 'click'): BuilderStep =>
  ({ action, name: '', page: '', element: '', url: '', value: '', matcher: 'equals', expected: '', as: '', pattern: '', body: '' });

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));

/** YAML/JSON step → editable row (tolerant: anything unknown is kept raw) */
export function parseStep(raw: unknown, engine: Engine): BuilderStep {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...emptyStep(), raw: { value: raw }, problem: 'not a step' };
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => k !== 'name');
  const step = emptyStep(keys[0] ?? 'click');
  step.name = str(o['name']);
  if (keys.length !== 1) return { ...step, raw: o, problem: 'needs exactly one action' };
  const action = keys[0];
  const body = o[action];

  if (engine !== 'web') {
    if (!(action in bodyActions(engine))) return { ...step, raw: o, problem: `unknown ${engine} action "${action}"` };
    step.body = body === null || body === undefined ? 'null' : typeof body === 'object' ? JSON.stringify(body) : str(body);
    return step;
  }

  const spec = WEB_ACTIONS[action];
  if (!spec) return { ...step, raw: o, problem: `unknown action "${action}"` };
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (spec.target === 'page') step.page = str(typeof body === 'string' ? body : b['page']);
  else if (spec.target === 'url') step.url = str(typeof body === 'string' ? body : b['url']);
  else if (spec.target === 'element' || spec.target === 'element?') step.element = str(typeof body === 'string' && action !== 'press' ? body : b['element']);
  if (spec.value) step.value = action === 'press' ? str(typeof body === 'string' ? body : b['key'] ?? b['value']) : str(b['value']);
  if (spec.valueOptional) step.value = str(b['value']);
  if (spec.match) {
    const m = MATCHERS.find((k) => k in b) ?? 'equals';
    step.matcher = m;
    step.expected = str(b[m]);
  }
  if (spec.save) { step.as = str(b['as']); step.pattern = str(b['pattern']); }
  return step;
}

/** editable row → YAML/JSON step, as serializeStep writes it (throws a readable message for an incomplete row) */
export function serializeStep(s: BuilderStep, engine: Engine): Record<string, unknown> {
  if (s.raw) return s.raw;
  const named = (body: unknown) => ({ ...(s.name.trim() ? { name: s.name.trim() } : {}), [s.action]: body });

  if (engine !== 'web') {
    const text = s.body.trim();
    if (!text || text === 'null') {
      if (engine === 'mobile' && ['launch', 'close', 'back', 'hideKeyboard', 'screenshot'].includes(s.action)) return named(null);
      throw new Error(`"${s.action}" needs a value`);
    }
    if (/^\d+$/.test(text)) return named(Number(text));
    try { return named(JSON.parse(text)); }
    catch {
      // a bare word is a string ("up", "page.element", an app id)
      if (/^[\w.:/-]+$/.test(text)) return named(text);
      throw new Error(`"${s.action}": write the value as JSON, e.g. ${bodyActions(engine)[s.action]?.example ?? '{ }'}`);
    }
  }

  const spec = WEB_ACTIONS[s.action];
  if (!spec) throw new Error(`unknown action "${s.action}"`);
  const need = (ok: boolean, what: string) => { if (!ok) throw new Error(`"${spec.label}" needs ${what}`); };
  if (spec.target === 'element') need(!!s.element.trim(), 'an element');
  if (spec.target === 'page') need(!!s.page.trim(), 'a page');
  if (spec.target === 'url') need(!!s.url.trim(), 'an address');
  if (spec.value) need(s.value !== '', 'a value');
  if (spec.save) need(/^\w+$/.test(s.as), 'a variable name (letters, digits, _)');

  const el = s.element.trim();
  if (spec.target === 'page') return named(s.page.trim());
  if (spec.target === 'url') return named(s.url.trim());
  if (spec.match) return named({ ...(el ? { element: el } : {}), [s.matcher]: s.expected });
  if (s.action === 'press') return named(el ? { element: el, key: s.value } : s.value);
  if (s.action === 'save') return named({ ...(el ? { element: el } : {}), as: s.as, ...(s.pattern ? { pattern: s.pattern } : {}) });
  if (spec.value) return named({ element: el, value: s.value });
  if (spec.valueOptional && s.value) return named({ element: el, value: s.value });
  return named(el);
}

/** {{data.x}} fields used by any steps */
export function dataFieldsUsed(steps: unknown): string[] {
  return [...new Set([...JSON.stringify(steps).matchAll(/\{\{\s*data\.(\w+)\s*\}\}/g)].map((m) => m[1]))];
}
