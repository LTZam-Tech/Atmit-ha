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
      need(!!b, '"request" needs { method, url }');
      need(typeof b!.url === 'string' && (b!.url as string).length > 0, '"request" needs a url');
      const method = String(b!.method ?? 'GET').toUpperCase();
      need((HTTP_METHODS as readonly string[]).includes(method), `method must be one of ${HTTP_METHODS.join(', ')}`);
      const bodies = ['json', 'form', 'body'].filter((k) => k in b!);
      need(bodies.length <= 1, 'use only one of json, form or body');
      if ('headers' in b!) need(!!obj(b!.headers), '"headers" must be a map');
      if ('query' in b!) need(!!obj(b!.query), '"query" must be a map');
      if ('auth' in b!) {
        const a = obj(b!.auth);
        need(!!a && (('bearer' in a!) !== ('basic' in a!)), '"auth" needs either { bearer: token } or { basic: { username, password } }');
      }
      if ('as' in b!) need(/^\w+$/.test(String(b!.as)), '"as" (a name for this response) uses letters, digits and _');
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
