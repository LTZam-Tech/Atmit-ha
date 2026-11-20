/**
 * API test engine — runs `engine: api` steps with Playwright's APIRequestContext (backlog §7).
 * Relative URLs resolve against the environment's baseURL. Every request and check is a report step; header values
 * named like secrets (Authorization, cookies, tokens, keys) are masked in step titles.
 */
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import Ajv from 'ajv';
import { step, mask } from '../../utils/steps';
import { withBaseQuery } from '../../utils/url';
import { environment } from '../../../config/environment';
import { render, type TemplateContext } from '../cases/template';
import type { Step } from '../cases/model';
import { evaluate, typeOf } from './jsonpath';
import { resolveRequest } from './model';
import { loadApp } from '../app';

export interface ApiResponseState {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: unknown;
  timeMs: number;
}

const SECRET_HEADER = /authorization|cookie|token|secret|api[-_]?key|password/i;
const ajv = new Ajv({ allErrors: true, strict: false });

/** app.yml api.requests, read once per worker */
let namedRequests: Record<string, unknown> | undefined | null = null;
export function appRequests(): Record<string, unknown> | undefined {
  if (namedRequests === null) {
    try { namedRequests = loadApp().api?.requests; } catch { namedRequests = undefined; }
  }
  return namedRequests;
}

/** OAuth2 client-credentials tokens, reused within this run until shortly before they expire */
const tokens = new Map<string, { token: string; until: number }>();

async function clientCredentialsToken(request: APIRequestContext, o: { tokenUrl: string; clientId: string; clientSecret: string; scope?: string }): Promise<string> {
  const key = `${o.tokenUrl}|${o.clientId}|${o.scope ?? ''}`;
  const hit = tokens.get(key);
  if (hit && hit.until > Date.now()) return hit.token;
  const url = withBaseQuery(o.tokenUrl, environment.baseURL);
  const res = await request.post(url, {
    form: { grant_type: 'client_credentials', client_id: o.clientId, client_secret: o.clientSecret, ...(o.scope ? { scope: o.scope } : {}) },
    failOnStatusCode: false,
  });
  const text = await res.text();
  let body: { access_token?: string; expires_in?: number } = {};
  try { body = JSON.parse(text); } catch { /* reported below */ }
  if (!res.ok() || !body.access_token) throw new Error(`OAuth2 token request to ${url} failed: HTTP ${res.status()} ${text.slice(0, 300)}`);
  // renew 30 s early; a token without expires_in is kept for 5 minutes
  const seconds = Number(body.expires_in) > 0 ? Number(body.expires_in) : 300;
  tokens.set(key, { token: body.access_token, until: Date.now() + Math.max(0, seconds - 30) * 1000 });
  return body.access_token;
}

type MultipartValue = string | number | boolean | { name: string; mimeType: string; buffer: Buffer };
function multipartOf(m: Record<string, unknown>): Record<string, MultipartValue> {
  return Object.fromEntries(Object.entries(m).map(([k, v]) => {
    if (v && typeof v === 'object') {
      const f = v as { name: string; mimeType?: string; content?: string; base64?: string };
      return [k, { name: f.name, mimeType: f.mimeType ?? 'application/octet-stream', buffer: f.base64 !== undefined ? Buffer.from(f.base64, 'base64') : Buffer.from(String(f.content ?? ''), 'utf8') }];
    }
    return [k, v as string | number | boolean];
  }));
}

/** render every string inside a value ({{data.x}}, {{var.x}}, {{faker…}}, {{user…}}) */
export function renderDeep(value: unknown, ctx: TemplateContext): unknown {
  if (typeof value === 'string') {
    const out = render(value, ctx);
    // a value that is exactly one template keeps numbers and booleans as such in JSON bodies
    if (/^\{\{[^}]+\}\}$/.test(value.trim()) && /^-?\d+(\.\d+)?$|^(true|false)$/.test(out)) return JSON.parse(out);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, ctx));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderDeep(v, ctx)]));
  return value;
}

const fmt = (v: unknown) => (typeof v === 'string' ? `"${v}"` : JSON.stringify(v));

export async function runApiSteps(request: APIRequestContext, steps: Step[], ctx: TemplateContext, state: { last?: ApiResponseState; named: Record<string, ApiResponseState> }) {
  for (const s of steps) await runApiStep(request, s, ctx, state);
}

async function runApiStep(request: APIRequestContext, s: Step, ctx: TemplateContext, state: { last?: ApiResponseState; named: Record<string, ApiResponseState> }) {
  const spec = (s.api ?? {}) as Record<string, unknown>;
  const last = () => {
    if (!state.last) throw new Error(`"${s.action}" needs a response: add a "request" step before it`);
    return state.last;
  };

  switch (s.action as string) {
    case 'request': {
      // a named request (app.yml api.requests) with this step's overrides, then {{templates}}
      const b = renderDeep(resolveRequest(spec, appRequests(), s.name ?? `step ${s.index ?? ''}`.trim()), ctx) as Record<string, unknown>;
      const method = String(b.method ?? 'GET').toUpperCase();
      const url = withBaseQuery(String(b.url), environment.baseURL);
      const headers: Record<string, string> = Object.fromEntries(Object.entries((b.headers ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
      const params: Record<string, string | number | boolean> = { ...((b.query ?? {}) as Record<string, string | number | boolean>) };
      const secretHeaders = new Set<string>();
      const auth = b.auth as {
        bearer?: string; basic?: { username: string; password: string };
        apiKey?: { in: 'header' | 'query'; name: string; value: unknown };
        oauth2?: { tokenUrl: string; clientId: string; clientSecret: string; scope?: string };
      } | undefined;
      if (auth?.bearer) headers.Authorization = `Bearer ${auth.bearer}`;
      if (auth?.basic) headers.Authorization = `Basic ${Buffer.from(`${auth.basic.username}:${auth.basic.password}`).toString('base64')}`;
      if (auth?.apiKey) {
        if (auth.apiKey.in === 'header') { headers[auth.apiKey.name] = String(auth.apiKey.value); secretHeaders.add(auth.apiKey.name); }
        else params[auth.apiKey.name] = String(auth.apiKey.value);
      }
      if (auth?.oauth2) headers.Authorization = `Bearer ${await clientCredentialsToken(request, auth.oauth2)}`;
      const shownHeaders = Object.entries(headers).map(([k, v]) => `${k}: ${SECRET_HEADER.test(k) || secretHeaders.has(k) ? mask(v) : v}`).join('; ');
      const title = s.name ?? `${method} ${url}${shownHeaders ? ` · ${shownHeaders}` : ''}`;
      await step.api(title, async () => {
        const started = performance.now();
        const res: APIResponse = await request.fetch(url, {
          method,
          headers,
          params: Object.keys(params).length ? params : undefined,
          data: b.json !== undefined ? b.json : b.body !== undefined ? String(b.body) : undefined,
          form: b.form as Record<string, string | number | boolean> | undefined,
          multipart: b.multipart ? multipartOf(b.multipart as Record<string, unknown>) : undefined,
          failOnStatusCode: false,
          timeout: typeof b.timeout === 'number' ? b.timeout : undefined,
        });
        const timeMs = Math.round(performance.now() - started);
        const text = await res.text();
        let json: unknown;
        try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
        state.last = { status: res.status(), headers: res.headers(), text, json, timeMs };
        if (typeof b.as === 'string') state.named[b.as] = state.last;
        test.info().annotations.push({ type: 'api-call', description: `${method} ${url} → ${res.status()} in ${timeMs} ms` });
      });
      return;
    }

    case 'status': {
      const exp = renderDeep(spec, ctx) as { equals?: number; in?: number[] };
      const title = s.name ?? (exp.in ? `Status is one of ${exp.in.join(', ')}` : `Status is ${exp.equals}`);
      return step.verify(title, async () => {
        const got = last().status;
        if (exp.in) expect(exp.in.map(Number), `HTTP status ${got}\n${last().text.slice(0, 500)}`).toContain(got);
        else expect(got, `HTTP status\n${last().text.slice(0, 500)}`).toBe(Number(exp.equals));
      });
    }

    case 'header': {
      const exp = renderDeep(spec, ctx) as { name: string; equals?: string; contains?: string; exists?: boolean };
      const value = last().headers[exp.name.toLowerCase()];
      const shown = (v?: string) => (SECRET_HEADER.test(exp.name) ? mask(v ?? '') : fmt(v));
      return step.verify(s.name ?? `Header ${exp.name} ${exp.exists !== undefined ? (exp.exists ? 'exists' : 'is absent') : `${exp.equals !== undefined ? 'is' : 'contains'} ${shown(exp.equals ?? exp.contains)}`}`, async () => {
        if (exp.exists !== undefined) expect(value !== undefined, `header ${exp.name}`).toBe(Boolean(exp.exists));
        else if (exp.equals !== undefined) expect(value, `header ${exp.name}`).toBe(String(exp.equals));
        else expect(value ?? '', `header ${exp.name}`).toContain(String(exp.contains));
      });
    }

    case 'json': {
      const exp = renderDeep(spec, ctx) as { path: string; equals?: unknown; contains?: unknown; exists?: boolean; type?: string; count?: number };
      const matcher = (['equals', 'contains', 'exists', 'type', 'count'] as const).find((m) => m in exp)!;
      return step.verify(s.name ?? `JSON ${exp.path} ${matcher} ${fmt(exp[matcher])}`, async () => {
        const body = last().json;
        if (body === undefined) throw new Error(`The response is not JSON:\n${last().text.slice(0, 500)}`);
        const r = evaluate(body, exp.path);
        switch (matcher) {
          case 'exists': return expect(r.found, `${exp.path} exists`).toBe(Boolean(exp.exists));
          case 'equals': expect(r.found, `${exp.path} not found`).toBe(true); return expect(r.value).toEqual(exp.equals);
          case 'contains':
            expect(r.found, `${exp.path} not found`).toBe(true);
            if (Array.isArray(r.value)) return expect(r.value).toContainEqual(exp.contains);
            return expect(String(r.value)).toContain(String(exp.contains));
          case 'type': expect(r.found, `${exp.path} not found`).toBe(true); return expect(typeOf(r.value)).toBe(exp.type);
          case 'count': expect(Array.isArray(r.value), `${exp.path} is not a list`).toBe(true); return expect((r.value as unknown[]).length).toBe(Number(exp.count));
        }
      });
    }

    case 'body': {
      const exp = renderDeep(spec, ctx) as { equals?: string; contains?: string; matches?: string };
      return step.verify(s.name ?? `Body ${exp.equals !== undefined ? 'is' : exp.contains !== undefined ? 'contains' : 'matches'} ${fmt(exp.equals ?? exp.contains ?? exp.matches)}`, async () => {
        const text = last().text;
        if (exp.equals !== undefined) expect(text).toBe(String(exp.equals));
        else if (exp.contains !== undefined) expect(text).toContain(String(exp.contains));
        else expect(text).toMatch(new RegExp(String(exp.matches)));
      });
    }

    case 'schema': {
      return step.verify(s.name ?? 'Body matches the JSON Schema', async () => {
        const body = last().json;
        if (body === undefined) throw new Error(`The response is not JSON:\n${last().text.slice(0, 500)}`);
        const validate = ajv.compile((spec as { schema: object }).schema);
        if (!validate(body)) throw new Error(`The body does not match the schema:\n${(validate.errors ?? []).map((e) => `  ${e.instancePath || '$'} ${e.message}`).join('\n')}`);
      });
    }

    case 'time': {
      const below = Number((spec as { below: number }).below);
      return step.verify(s.name ?? `Response time below ${below} ms`, async () => {
        expect(last().timeMs, `response time (ms)`).toBeLessThan(below);
      });
    }

    case 'save': {
      const b = renderDeep(spec, ctx) as { path?: string; header?: string; as: string };
      return step.enter(s.name ?? `Save ${b.path ?? `header ${b.header}`} as ${b.as}`, async () => {
        let value: unknown;
        if (b.header) value = last().headers[b.header.toLowerCase()];
        else {
          const r = evaluate(last().json, b.path!);
          if (!r.found) throw new Error(`Save "${b.as}": ${b.path} not found in the response`);
          value = r.value;
        }
        if (value === undefined) throw new Error(`Save "${b.as}": no value`);
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        (ctx.vars ??= {})[b.as] = text;
        test.info().annotations.push({ type: 'runtime-value', description: `${b.as} = ${SECRET_HEADER.test(b.as) ? mask(text) : text}` });
      });
    }

    default:
      throw new Error(`Unknown API step "${s.action}"`);
  }
}
