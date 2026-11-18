/**
 * Minimal JSONPath for API checks: $ · .name · ['name'] · [0] · [-1] · [*] · .length
 *   $.data.items[0].id     → one value
 *   $.items[*].sku         → array of values (a wildcard always yields an array)
 * Returns { found, value }; a missing step means found = false (never throws on missing data).
 */
export interface PathResult { found: boolean; value: unknown }

type Token = { kind: 'key'; name: string } | { kind: 'index'; index: number } | { kind: 'all' };

export function tokenize(path: string): Token[] {
  if (!path.startsWith('$')) throw new Error(`JSON path must start with $: ${path}`);
  const tokens: Token[] = [];
  let i = 1;
  while (i < path.length) {
    const c = path[i];
    if (c === '.') {
      const m = /^\.([A-Za-z_$][\w$-]*)/.exec(path.slice(i));
      if (!m) throw new Error(`Invalid JSON path near "${path.slice(i)}"`);
      tokens.push({ kind: 'key', name: m[1] });
      i += m[0].length;
    } else if (c === '[') {
      const rest = path.slice(i);
      const all = /^\[\*\]/.exec(rest);
      const idx = /^\[(-?\d+)\]/.exec(rest);
      const quoted = /^\[(['"])(.*?)\1\]/.exec(rest);
      if (all) { tokens.push({ kind: 'all' }); i += all[0].length; }
      else if (idx) { tokens.push({ kind: 'index', index: Number(idx[1]) }); i += idx[0].length; }
      else if (quoted) { tokens.push({ kind: 'key', name: quoted[2] }); i += quoted[0].length; }
      else throw new Error(`Invalid JSON path near "${rest}"`);
    } else throw new Error(`Invalid JSON path near "${path.slice(i)}"`);
  }
  return tokens;
}

export function evaluate(root: unknown, path: string): PathResult {
  let current: unknown[] = [root];
  let wildcard = false;
  for (const t of tokenize(path)) {
    const next: unknown[] = [];
    for (const v of current) {
      if (t.kind === 'all') {
        if (Array.isArray(v)) next.push(...v);
        else if (v && typeof v === 'object') next.push(...Object.values(v));
        wildcard = true;
      } else if (t.kind === 'index') {
        if (Array.isArray(v)) {
          const i = t.index < 0 ? v.length + t.index : t.index;
          if (i >= 0 && i < v.length) next.push(v[i]);
        }
      } else if (t.name === 'length' && (Array.isArray(v) || typeof v === 'string')) {
        next.push(v.length);
      } else if (v && typeof v === 'object' && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, t.name)) {
        next.push((v as Record<string, unknown>)[t.name]);
      }
    }
    current = next;
    if (!current.length && !wildcard) return { found: false, value: undefined };
  }
  if (wildcard) return { found: true, value: current };
  return current.length ? { found: true, value: current[0] } : { found: false, value: undefined };
}

/** JSON type name of a value, as JSON Schema names it */
export function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}
