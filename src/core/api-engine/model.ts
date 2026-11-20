/**
 * API test engine — step model (backlog §7, ADR-0009). A case with `engine: api` uses these steps instead of the
 * 24 web actions; everything else (data rows, outcomes, {{templates}}, suites, dependsOn, workflows, reports) is shared.
 *
 *   case: Create order
 *   engine: api
 *   steps:
 *     - request: { method: POST, url: /api/orders, json: { sku: "{{data.sku}}", qty: 2 }, auth: { bearer: "{{var.token}}" } }
 *     - save: { path: $.id, as: orderId }
 *   outcomes:
 *     success:
 *       - status: 201
 *       - json: { path: $.status, equals: NEW }
 *       - schema: { type: object, required: [id, status] }
 *       - time: { below: 1500 }
 *     error:
 *       - status: { in: [400, 422] }
 *       - json: { path: $.errors[0].field, equals: "{{data.field}}" }
 *
 * Auth: { bearer } | { basic: { username, password } } | { apiKey: { in: header|query, name, value } }
 *       | { oauth2: { tokenUrl, clientId, clientSecret, scope? } } (client credentials; the token is reused until it expires)
 * Body: one of json | form | body | multipart: { field: "text" | { name, mimeType?, content | base64 } }
 * Reuse: app.yml `api.requests: { login: { method: POST, url: /api/login, json: … } }`, then a step
 *        `request: { use: login, json: { … } }` takes the named request and overrides what it lists
 *        (headers and query are merged key by key).
 */
import type { Step } from '../cases/model';

export const API_ACTIONS = {
  request: { kind: 'API', label: 'Send request' },
  status: { kind: 'Verify', label: 'Response status' },
  header: { kind: 'Verify', label: 'Response header' },
  json: { kind: 'Verify', label: 'Response body (JSON path)' },
  body: { kind: 'Verify', label: 'Response body (text)' },
  schema: { kind: 'Verify', label: 'Response matches JSON Schema' },
  time: { kind: 'Verify', label: 'Response time' },
  save: { kind: 'Data entry', label: 'Save value as variable' },
} as const;

export type ApiAction = keyof typeof API_ACTIONS;

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** YAML API step → Step { action, api: body } (throws a readable error) */
export function normalizeApiStep(raw: Record<string, unknown>, where: string): Step {
  if (!raw || typeof raw !== 'object') throw new Error(`${where}: a step must be an object like "status: 200"`);
  const name = typeof raw.name === 'string' ? raw.name : undefined;
  const keys = Object.keys(raw).filter((k) => k !== 'name');
  if (keys.length !== 1) throw new Error(`${where}: a step needs exactly one action, found [${keys.join(', ')}]`);
  const action = keys[0] as ApiAction;
  if (!(action in API_ACTIONS)) throw new Error(`${where}: unknown API action "${action}". Use one of: ${Object.keys(API_ACTIONS).join(', ')}`);
  const body = raw[action];
  const b = obj(body);
  const need = (ok: boolean, msg: string) => { if (!ok) throw new Error(`${where}: ${msg}`); };
  const oneMatcher = (o: Record<string, unknown>, allowed: string[]) => {
    const found = allowed.filter((m) => m in o);
    need(found.length === 1, `"${action}" needs exactly one of ${allowed.join(', ')}`);
  };

  switch (action) {
    case 'request': {
      need(!!b, '"request" needs { method, url } or { use: <named request> }');
      if ('use' in b!) {
        need(/^\w[\w-]*$/.test(String(b!.use)), '"use" names a request of app.yml api.requests (letters, digits, _ and -)');
        // the named request is merged at run time (resolveRequest); only what is written here can be checked now
        checkRequest({ url: '/', ...b! }, where);
        return { action: 'request' as never, name, api: { ...b!, ...(b!.method ? { method: String(b!.method).toUpperCase() } : {}) } };
      }
      const method = checkRequest(b!, where);
      return { action: 'request' as never, name, api: { ...b!, method } };
    }
    case 'status': {
      if (typeof body === 'number' || (typeof body === 'string' && /^\d{3}$/.test(body))) return { action: 'status' as never, name, api: { equals: Number(body) } };
      need(!!b, '"status" needs a code (200) or { equals | in }');
      oneMatcher(b!, ['equals', 'in']);
      return { action: 'status' as never, name, api: b };
    }
    case 'header': {
      need(!!b && typeof b!.name === 'string', '"header" needs { name, equals | contains | exists }');
      oneMatcher(b!, ['equals', 'contains', 'exists']);
      return { action: 'header' as never, name, api: b };
    }
    case 'json': {
      need(!!b && typeof b!.path === 'string' && String(b!.path).startsWith('$'), '"json" needs { path: $.…, equals | contains | exists | type | count }');
      oneMatcher(b!, ['equals', 'contains', 'exists', 'type', 'count']);
      return { action: 'json' as never, name, api: b };
    }
    case 'body': {
      need(!!b, '"body" needs { equals | contains | matches }');
      oneMatcher(b!, ['equals', 'contains', 'matches']);
      if ('matches' in b!) { try { new RegExp(String(b!.matches)); } catch { need(false, `invalid pattern ${String(b!.matches)}`); } }
      return { action: 'body' as never, name, api: b };
    }
    case 'schema': {
      need(!!b, '"schema" needs a JSON Schema object');
      return { action: 'schema' as never, name, api: { schema: b } };
    }
    case 'time': {
      need(!!b && Number(b!.below) > 0, '"time" needs { below: milliseconds }');
      return { action: 'time' as never, name, api: { below: Number(b!.below) } };
    }
    case 'save': {
      need(!!b && /^\w+$/.test(String(b!.as ?? '')), '"save" needs as: <name> (letters, digits, _)');
      need(typeof b!.path === 'string' || typeof b!.header === 'string', '"save" needs path: $.… or header: <name>');
      return { action: 'save' as never, name, as: String(b!.as), api: b };
    }
  }
}

/** the shape of a request (also run on a merged named request): returns the upper-case method */
export function checkRequest(b: Record<string, unknown>, where: string): string {
  const need = (ok: boolean, msg: string) => { if (!ok) throw new Error(`${where}: ${msg}`); };
  need(typeof b.url === 'string' && (b.url as string).length > 0, '"request" needs a url');
  const method = String(b.method ?? 'GET').toUpperCase();
  need((HTTP_METHODS as readonly string[]).includes(method), `method must be one of ${HTTP_METHODS.join(', ')}`);
  const bodies = ['json', 'form', 'body', 'multipart'].filter((k) => k in b && b[k] !== undefined);
  need(bodies.length <= 1, 'use only one of json, form, body or multipart');
  if ('headers' in b) need(!!obj(b.headers), '"headers" must be a map');
  if ('query' in b) need(!!obj(b.query), '"query" must be a map');
  if ('multipart' in b) {
    const m = obj(b.multipart);
    need(!!m, '"multipart" must be a map of field: value or field: { name, mimeType, content }');
    for (const [field, v] of Object.entries(m!)) {
      const f = obj(v);
      if (!f) { need(['string', 'number', 'boolean'].includes(typeof v), `multipart field "${field}" must be text or a file { name, content }`); continue; }
      need(typeof f.name === 'string' && f.name.length > 0, `multipart file "${field}" needs a name`);
      need((typeof f.content === 'string') !== (typeof f.base64 === 'string'), `multipart file "${field}" needs content (text) or base64, not both`);
    }
  }
  if ('auth' in b) {
    const a = obj(b.auth);
    const kinds = a ? ['bearer', 'basic', 'apiKey', 'oauth2'].filter((k) => k in a) : [];
    need(kinds.length === 1, '"auth" needs either { bearer }, { basic: { username, password } }, { apiKey: { in, name, value } } or { oauth2: { tokenUrl, clientId, clientSecret } }');
    if (kinds[0] === 'apiKey') {
      const k = obj(a!.apiKey);
      need(!!k && (k!.in === 'header' || k!.in === 'query') && typeof k!.name === 'string' && (k!.name as string).length > 0 && k!.value !== undefined,
        '"apiKey" needs { in: header | query, name, value }');
    }
    if (kinds[0] === 'oauth2') {
      const o = obj(a!.oauth2);
      need(!!o && typeof o!.tokenUrl === 'string' && typeof o!.clientId === 'string' && typeof o!.clientSecret === 'string',
        '"oauth2" needs { tokenUrl, clientId, clientSecret, scope? } (client credentials)');
    }
  }
  if ('as' in b) need(/^\w+$/.test(String(b.as)), '"as" (a name for this response) uses letters, digits and _');
  return method;
}

/**
 * `request: { use: name, …overrides }` → the named request of app.yml (api.requests) with the overrides on top;
 * headers and query are merged key by key, a body written in the step replaces the named one. Other steps pass through.
 */
export function resolveRequest(spec: Record<string, unknown>, requests: Record<string, unknown> | undefined, where: string): Record<string, unknown> {
  if (!('use' in spec)) return spec;
  const { use, ...over } = spec;
  const base = obj(requests?.[String(use)]);
  if (!base) throw new Error(`${where}: no request named "${String(use)}" in app.yml api.requests${requests ? ` (known: ${Object.keys(requests).join(', ') || 'none'})` : ''}`);
  const bodies = ['json', 'form', 'body', 'multipart'];
  const merged: Record<string, unknown> = { ...base };
  if (bodies.some((k) => k in over)) for (const k of bodies) delete merged[k];
  for (const [k, v] of Object.entries(over)) {
    merged[k] = (k === 'headers' || k === 'query') && obj(base[k]) && obj(v) ? { ...obj(base[k]), ...obj(v) } : v;
  }
  merged.method = checkRequest(merged, where);
  return merged;
}

