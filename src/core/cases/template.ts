/**
 * {{ ... }} values in cases:
 *   {{data.username}}               value from the current data row
 *   {{user.standard.username}}      user from app.yml / secrets.yml  (.password too)
 *   {{msg.invalidCredentials}}      expected message in the run language (messages.yml)
 *   {{faker.internet.email}}        generated data (seeded) — any faker path, e.g. {{faker.string.alpha(10)}}
 *   {{negative.sqlInjection}}       negative value library — {{negative.longText(300)}}
 *   {{date.today}} {{date.iso}} {{date.hijri}} {{date.plusDays(7)}}
 *   {{date.today(MM/dd/yyyy)}} {{date.plusDays(7, yyyy-MM-dd)}}   any format: yyyy yy MM M dd d
 *   {{env.baseURL}} {{env.name}} {{env.app}} {{env.locale}}
 *   {{var.orderId}}                 runtime value captured earlier in the same test by a "save" step
 */
import type { Faker } from '@faker-js/faker';
import { appConfig, environment } from '../../../config/environment';
import { msg } from '../../data';
import { Negative } from '../../data/negative/values';
import { addDays, formatDate, hijri, isoDate } from '../../utils/dates';

export interface TemplateContext { data: Record<string, unknown>; faker: Faker; vars?: Record<string, string> }

const TOKEN = /\{\{\s*([^}]+?)\s*\}\}/g;

export function render(value: string | undefined, ctx: TemplateContext): string {
  if (value === undefined) return '';
  return value.replace(TOKEN, (_, expr: string) => String(evaluate(expr, ctx)));
}

function evaluate(expr: string, ctx: TemplateContext): unknown {
  const call = /^(.*?)\((.*)\)$/.exec(expr);
  const pathPart = call ? call[1] : expr;
  const args = call ? parseArgs(call[2]) : [];
  const [root, ...rest] = pathPart.split('.');

  switch (root) {
    case 'data': {
      const v = ctx.data[rest[0]];
      if (v === undefined) throw new Error(`{{${expr}}}: data row has no "${rest[0]}"`);
      return v;
    }
    case 'user': {
      const u = appConfig.users[rest[0]];
      if (!u) throw new Error(`{{${expr}}}: user "${rest[0]}" not in app.yml`);
      const field = (rest[1] ?? 'username') as 'username' | 'password';
      if (field === 'password' && !u.password) throw new Error(`{{${expr}}}: no password for "${rest[0]}" — add it to secrets.yml`);
      return u[field] ?? '';
    }
    case 'msg':
      return msg(rest[0]);
    case 'var': {
      const v = ctx.vars?.[rest[0]];
      if (v === undefined) throw new Error(`{{${expr}}}: no value saved yet — add a "Save value" step named "${rest[0]}" before this step`);
      return v;
    }
    case 'faker': {
      let target: unknown = ctx.faker;
      for (const k of rest) target = (target as Record<string, unknown>)?.[k];
      if (typeof target !== 'function') throw new Error(`{{${expr}}}: not a faker function (e.g. faker.internet.email)`);
      // bind to the faker module so `this` works
      const owner = rest.slice(0, -1).reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], ctx.faker);
      return (target as (...a: unknown[]) => unknown).apply(owner, args);
    }
    case 'negative': {
      const v = (Negative as Record<string, unknown>)[rest[0]];
      if (v === undefined) throw new Error(`{{${expr}}}: unknown negative value. Use: ${Object.keys(Negative).join(', ')}`);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown)(...(args.length ? args : [256])) : v;
    }
    case 'date': {
      const d = new Date();
      if (rest[0] === 'today') return formatDate(d, (args[0] as string) || undefined);
      if (rest[0] === 'iso') return isoDate(d);
      if (rest[0] === 'hijri') return hijri(d);
      if (rest[0] === 'plusDays') return formatDate(addDays(d, Number(args[0] ?? 0)), (args[1] as string) || undefined);
      throw new Error(`{{${expr}}}: use date.today(format?) | date.iso | date.hijri | date.plusDays(n, format?)`);
    }
    case 'env':
      return ({ baseURL: environment.baseURL, name: environment.name, app: environment.app, locale: environment.locale } as Record<string, string>)[rest[0]] ?? '';
    default:
      throw new Error(`{{${expr}}}: unknown source "${root}" — use data, user, msg, var, faker, negative, date or env`);
  }
}

function parseArgs(s: string): unknown[] {
  if (!s.trim()) return [];
  return s.split(',').map((a) => {
    const t = a.trim();
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    if (t === 'true' || t === 'false') return t === 'true';
    return t.replace(/^['"]|['"]$/g, '');
  });
}

/** Resolve every string field of a data row once per test (so faker values stay consistent) */
export function resolveRow(row: Record<string, unknown>, faker: Faker): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const ctx: TemplateContext = { data: out, faker };
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'string' ? render(v, ctx) : v;
  return out;
}
