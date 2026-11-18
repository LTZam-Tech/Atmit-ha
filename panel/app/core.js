// Shared store, API helpers and live events for the Control Panel.
import { html, useState, useEffect } from '/vendor/preact-htm.js';

export { html };

export const esc = (s) => String(s ?? '');
export const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function api(url, opts = {}) {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

// ------------------------------------------------------------------ store
export const store = {
  route: parseRoute(),
  projects: [],
  S: null,          // current project state (/api/state)
  history: [],
  running: null,
  log: [],
  git: null,
  toastMsg: '',
  listeners: new Set(),
  set(patch) { Object.assign(this, patch); this.emit(); },
  emit() { this.listeners.forEach((f) => f()); },
};

export function useStore() {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((x) => x + 1);
    store.listeners.add(f);
    return () => store.listeners.delete(f);
  }, []);
  return store;
}

export function toast(msg) {
  store.set({ toastMsg: msg });
  clearTimeout(toast._h);
  toast._h = setTimeout(() => store.set({ toastMsg: '' }), 4200);
}

// ------------------------------------------------------------------ routing: #/  ·  #/p/<app>/<stage>
export function parseRoute() {
  const m = location.hash.match(/^#\/p\/([a-z][a-z0-9-]*)\/?(\w+)?/);
  return m ? { view: 'project', app: m[1], stage: m[2] || 'overview' } : { view: 'home' };
}
export function go(hash) { location.hash = hash; }
window.addEventListener('hashchange', () => { store.set({ route: parseRoute() }); loadForRoute(); });

export async function loadProjects() {
  store.set({ projects: await api('/api/projects') });
}
export async function loadState(app = store.route.app) {
  if (!app) return;
  const [S, history] = await Promise.all([api('/api/state?app=' + encodeURIComponent(app)), api('/api/history?app=' + encodeURIComponent(app))]);
  store.set({ S, history, running: S.running });
}
export async function loadGit() {
  try { store.set({ git: await api('/api/git') }); } catch { /* ignore */ }
}
export async function loadForRoute() {
  const r = store.route;
  if (r.view === 'home') await loadProjects();
  else {
    await api('/api/apps/select', { method: 'POST', body: { app: r.app } }).catch(() => {});
    await loadState(r.app);
  }
  loadGit();
}

// ------------------------------------------------------------------ settings (per project, remembered)
const DEFAULT_RUN = { env: '', locale: 'en', project: 'chromium', target: 'local', headed: false, slowmo: 0, video: false, workers: '', retries: '', seed: '' };
export function runSettings(app = store.route.app) {
  try { return { ...DEFAULT_RUN, ...JSON.parse(localStorage.getItem('run-' + app) || '{}') }; } catch { return { ...DEFAULT_RUN }; }
}
export function saveRunSettings(s, app = store.route.app) {
  try { localStorage.setItem('run-' + app, JSON.stringify(s)); } catch { /* storage unavailable */ }
}
export function runBody(extra = {}) {
  const s = runSettings();
  return {
    app: store.route.app, env: s.env && store.S?.envs?.includes(s.env) ? s.env : undefined, locale: s.locale, project: s.project, target: s.target, headed: s.headed, video: s.video,
    slowmo: Number(s.slowmo) || 0, workers: Number(s.workers) || undefined, retries: s.retries === '' ? undefined : Number(s.retries), seed: s.seed || undefined,
    ...extra,
  };
}
export async function startRun(extra) {
  try {
    store.set({ log: [] });
    await api('/api/run', { method: 'POST', body: runBody(extra) });
    go(`#/p/${store.route.app}/run`);
    store.set({ runTab: 'console' });
  } catch (e) { toast(e.message); }
}
export const byTitles = (titles) => ({ grep: titles.map((t) => reEsc(t) + '(?: |$)').join('|') });

// ------------------------------------------------------------------ live events
const doneHandlers = new Set();
export function onJobDone(fn) { doneHandlers.add(fn); return () => doneHandlers.delete(fn); }
let pending = [];
let flushTimer = null;
const es = new EventSource('/api/events');
es.addEventListener('start', (e) => { const d = JSON.parse(e.data); store.set({ running: d, jobLabel: d.label }); });
es.addEventListener('log', (e) => {
  pending.push(JSON.parse(e.data).line);
  if (!flushTimer) flushTimer = setTimeout(() => { store.log = store.log.concat(pending).slice(-3000); pending = []; flushTimer = null; store.emit(); }, 120);
});
es.addEventListener('done', async (e) => {
  const d = JSON.parse(e.data);
  store.log = store.log.concat(pending, [d.code === 0 ? '✔ Finished' : d.code === null ? '■ Stopped' : `✖ Finished with exit code ${d.code}`]);
  pending = [];
  store.set({ running: null });
  if (!['wizard', 'check'].includes(d.kind) && store.route.app) await loadState();
  if (d.kind === 'record') store.set({ lastRecord: d.result ?? { ok: d.code === 0 } });
  if (d.kind === 'test') {
    store.set({ runTab: 'history', viewRun: store.history[0]?.id });
    toast(d.code === 0 ? 'All tests passed ✔' : 'Run finished with failures — see the report');
  }
  loadGit();
  doneHandlers.forEach((f) => f(d));
});

export function waitForJob() {
  return new Promise((resolve) => { const off = onJobDone((d) => { off(); resolve(d); }); });
}
