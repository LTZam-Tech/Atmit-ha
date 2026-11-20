/**
 * Performance test engine — model (backlog §9, ADR-0009 "1.1"). A case with `engine: performance` describes the
 * requests one virtual user makes (the API engine's request / status / save steps, plus think time), how much load
 * to put on them, and the limits the run must stay within. k6 runs it (src/core/performance-engine/k6.ts).
 *
 *   case: Product search under load
 *   engine: performance
 *   load: { vus: 20, duration: 2m, rampUp: 30s }
 *   thresholds: { p95: 800, errorRate: 0.01, minRps: 15 }
 *   steps:
 *     - request: { method: GET, url: "/api/products?q={{data.term}}" }
 *     - status: 200
 *     - think: 1000
 *
 * Safeguards: the load may only target the environment's own host, and the agent caps virtual users and duration
 * (ATIMTHA_MAX_VUS, from the organisation setting performance.maxVirtualUsers; ATIMTHA_MAX_LOAD_MINUTES).
 */
import type { Step } from '../cases/model';
import { normalizeApiStep } from '../api-engine/model';

export interface LoadProfile {
  vus: number;
  /** how long the load is held, e.g. 30s, 2m */
  duration?: string;
  /** optional ramp-up before the steady state, and ramp-down after it */
  rampUp?: string;
  rampDown?: string;
  /** instead of a duration: iterations per virtual user */
  iterations?: number;
}

export interface Thresholds {
  /** milliseconds */
  avg?: number; p90?: number; p95?: number; p99?: number; max?: number;
  /** share of failed requests, 0–1 */
  errorRate?: number;
  /** requests per second the system must sustain */
  minRps?: number;
}

export const PERF_ACTIONS = ['request', 'status', 'save', 'think'] as const;

/** "90s" | "2m" | "1h" → seconds */
export function seconds(d: string | undefined): number {
  if (!d) return 0;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(String(d).trim());
  if (!m) throw new Error(`"${d}" is not a duration: use e.g. 30s, 2m or 1h`);
  const n = Number(m[1]);
  return m[2] === 'ms' ? n / 1000 : m[2] === 's' ? n : m[2] === 'm' ? n * 60 : n * 3600;
}

export function normalizeLoad(raw: unknown, where: string): LoadProfile {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const vus = Number(o.vus);
  if (!Number.isInteger(vus) || vus < 1) throw new Error(`${where}: "load.vus" must be a whole number of virtual users (at least 1)`);
  const load: LoadProfile = { vus };
  for (const k of ['duration', 'rampUp', 'rampDown'] as const) if (o[k] !== undefined) { seconds(String(o[k])); load[k] = String(o[k]); }
  if (o.iterations !== undefined) {
    if (!Number.isInteger(Number(o.iterations)) || Number(o.iterations) < 1) throw new Error(`${where}: "load.iterations" must be at least 1`);
    load.iterations = Number(o.iterations);
  }
  if (!load.duration && !load.iterations) throw new Error(`${where}: "load" needs a duration (e.g. 2m) or iterations`);
  if (load.duration && load.iterations) throw new Error(`${where}: "load" takes a duration or iterations, not both`);
  return load;
}

export function normalizeThresholds(raw: unknown, where: string): Thresholds {
  if (raw === undefined) return {};
  const o = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null;
  if (!o) throw new Error(`${where}: "thresholds" must be a map such as { p95: 800, errorRate: 0.01 }`);
  const t: Thresholds = {};
  for (const [k, v] of Object.entries(o)) {
    const n = Number(v);
    if (!['avg', 'p90', 'p95', 'p99', 'max', 'errorRate', 'minRps'].includes(k)) throw new Error(`${where}: unknown threshold "${k}" (avg, p90, p95, p99, max, errorRate, minRps)`);
    if (!(n >= 0) || (k === 'errorRate' && n > 1)) throw new Error(`${where}: threshold "${k}" must be a number${k === 'errorRate' ? ' between 0 and 1' : ''}`);
    t[k as keyof Thresholds] = n;
  }
  return t;
}

/** YAML step of a performance case → Step (request/status/save as the API engine; think: milliseconds) */
export function normalizePerfStep(raw: Record<string, unknown>, where: string): Step {
  const keys = Object.keys(raw ?? {}).filter((k) => k !== 'name');
  if (keys.length === 1 && keys[0] === 'think') {
    const ms = Number(raw.think);
    if (!(ms >= 0)) throw new Error(`${where}: "think" is a pause in milliseconds`);
    return { action: 'think' as never, name: typeof raw.name === 'string' ? raw.name : undefined, api: { ms } };
  }
  if (keys.length === 1 && !(PERF_ACTIONS as readonly string[]).includes(keys[0])) {
    throw new Error(`${where}: a performance case uses ${PERF_ACTIONS.join(', ')} (checks of the body belong in an API case)`);
  }
  return normalizeApiStep(raw, where);
}
