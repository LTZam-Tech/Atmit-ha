/**
 * Smart HTML Reporter — one self-contained index.html (+ assets/ for videos & traces).
 * Opens without a server; can be zipped and e-mailed.
 *
 * Shows: KPIs, Positive vs Negative, per module, failure classification, OR healing warnings,
 * and per test the typed steps (Navigate / Data entry / Click / Verify) with screenshots,
 * error, data seed and links to video/trace.
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult, TestStep } from '@playwright/test/reporter';
import { currentApp, loadApp, ROOT } from '../src/core/app';
import { profileFor } from '../src/core/branding';
import { healsOf, type HealEvent } from '../src/core/healing';
import { runConfig } from '../config/environment';

const HISTORY_KEEP = Number(process.env.REPORT_HISTORY_KEEP ?? 50);

type OpenMode = 'always' | 'on-failure' | 'never';
interface Options { outputFolder?: string; title?: string; open?: OpenMode; history?: boolean }

type Kind = 'positive' | 'negative' | 'other';
type Category = 'Application defect' | 'Locator / OR' | 'Self-healing' | 'Environment' | 'Timeout' | 'Script error';

interface StepRow { title: string; kind: string; duration: number; error?: string; depth: number }
interface TestRow {
  id: string; title: string; tcId?: string; module: string; file: string; project: string;
  kind: Kind; tags: string[]; status: string; flaky: boolean; retries: number; duration: number;
  steps: StepRow[]; error?: string; category?: Category; seed?: string;
  healed: string[]; healing: HealEvent[]; xpath: string[]; vars: string[]; screenshots: { name: string; src: string }[];
  video?: string; trace?: string;
  lastPage?: { url: string; title: string; page: string | null }; caseFile?: string; detected?: string;
  discoveries?: { visits: unknown[]; messages: unknown[] }; user?: string;
}

export default class SmartReporter implements Reporter {
  private readonly out: string;
  private readonly title: string;
  private readonly open: OpenMode;
  private readonly history: boolean;
  private config!: FullConfig;
  private start = new Date();
  private rows = new Map<string, TestRow>();

  constructor(opts: Options = {}) {
    this.out = path.resolve(opts.outputFolder ?? 'reports/smart-report');
    this.title = opts.title ?? 'Automation Smart Report';
    // REPORT_OPEN env wins over config; never auto-open on CI
    this.open = process.env.CI ? 'never' : ((process.env.REPORT_OPEN as OpenMode) ?? opts.open ?? 'always');
    this.history = opts.history !== false && !process.env.DETECT_LAST; // detection re-runs are not real runs
  }

  printsToStdio() { return false; }

  onBegin(config: FullConfig, _suite: Suite) {
    this.config = config;
    this.start = new Date();
    fs.rmSync(this.out, { recursive: true, force: true });
    fs.mkdirSync(path.join(this.out, 'assets'), { recursive: true });
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const project = test.parent.project()?.name ?? '';
    const tags = test.tags;
    const kind: Kind = tags.includes('@positive') ? 'positive' : tags.includes('@negative') ? 'negative' : 'other';
    const tcId = tags.find((t) => /^@TC-/.test(t))?.slice(1);
    const describe = test.titlePath().slice(3, -1).join(' › '); // [root, project, file, ...describes, title]
    const folder = path.basename(path.dirname(test.location.file));
    const module = describe || folder.charAt(0).toUpperCase() + folder.slice(1);
    const ann = (type: string) => test.annotations.filter((a) => a.type === type).map((a) => a.description ?? '');
    const errorText = result.errors.map((e) => strip(e.message ?? e.value ?? '')).join('\n\n') || undefined;
    const id = test.id;

    const row: TestRow = {
      id, title: test.title, tcId, module, project, kind, tags,
      file: `${path.relative(process.cwd(), test.location.file)}:${test.location.line}`,
      status: result.status, retries: result.retry, duration: result.duration,
      flaky: result.status === 'passed' && result.retry > 0,
      steps: flattenSteps(result.steps, result.status !== 'passed' && result.status !== 'skipped'),
      error: errorText, category: errorText ? classify(errorText) : undefined,
      seed: ann('data-seed')[0], healed: ann('or-healed'), healing: healsOf(test.annotations), xpath: ann('or-xpath'), vars: ann('runtime-value'),
      screenshots: [],
      lastPage: (() => { try { return JSON.parse(ann('last-page').at(-1) ?? ''); } catch { return undefined; } })(),
      caseFile: ann('case-file')[0]?.replace(/^cases\//, ''), detected: ann('detected')[0],
      discoveries: (() => { try { return JSON.parse(ann('discoveries').at(-1) ?? ''); } catch { return undefined; } })(),
      user: tags.find((t) => t.startsWith('@as-'))?.slice(4),
    };

    for (const a of result.attachments) {
      if (a.contentType === 'image/png') {
        const body = a.body ?? (a.path && fs.existsSync(a.path) ? fs.readFileSync(a.path) : undefined);
        if (body) row.screenshots.push({ name: a.name, src: `data:image/png;base64,${body.toString('base64')}` });
      } else if ((a.name === 'video' || a.name === 'trace') && a.path && fs.existsSync(a.path)) {
        const name = `${id}-${result.retry}-${path.basename(a.path)}`;
        fs.copyFileSync(a.path, path.join(this.out, 'assets', name));
        row[a.name] = `assets/${name}`;
      }
    }
    this.rows.set(id, row); // last retry wins
  }

  onEnd(result: FullResult) {
    const tests = [...this.rows.values()].filter((t) => t.project !== 'setup');
    const setup = [...this.rows.values()].filter((t) => t.project === 'setup');
    const meta = (this.config.metadata ?? {}) as Record<string, unknown>;
    const app = (meta.app as string) ?? currentApp();
    let brandingKey: string | undefined, appName = app;
    try { const cfg = loadApp(app); brandingKey = cfg.branding; appName = cfg.name; } catch { /* report anyway */ }
    const brand = profileFor(brandingKey);
    const payload = {
      title: brand.reportTitle && brand.reportTitle !== 'Automation Smart Report' ? brand.reportTitle : this.title,
      brand,
      appName,
      started: this.start.toISOString(),
      duration: result.duration,
      overall: result.status,
      version: this.config.version,
      meta,
      setup,
      tests,
    };
    const file = path.join(this.out, 'index.html');
    fs.writeFileSync(file, html(payload));
    console.log(`\n  Smart report → ${path.relative(process.cwd(), file)}\n`);
    if (this.history && tests.length) {
      try { saveHistory(this.out, this.start, app, appName, meta, result, tests); } catch (e) { console.log(`  (history not saved: ${(e as Error).message})`); }
    }
    if (this.open === 'always' || (this.open === 'on-failure' && result.status !== 'passed')) openInBrowser(file);
  }
}

// ------------------------------------------------------------------ helpers

export interface RunSummary {
  id: string; app: string; appName: string; env: string; locale: string; target: string; started: string; duration: number; status: string;
  /**
   * passed = passed on the first try (as in 0.1.0, so pass-rate trends stay comparable); flaky = passed after a retry;
   * healed = passed tests (first try or retry) that needed self-healing; healingFailed = failed by the healing policy
   */
  counts: { total: number; passed: number; failed: number; flaky: number; skipped: number; positive: number; negative: number; healed: number; healingFailed: number };
  healingPolicy?: string;
  tests: { title: string; module: string; kind: string; status: string; duration: number; tcId?: string; category?: string; lastPage?: TestRow['lastPage']; caseFile?: string }[];
}

/** Copies the report into reports/history/<app>/<yyyyMMdd-HHmmss>/ with a summary.json; keeps the last HISTORY_KEEP runs */
function saveHistory(out: string, start: Date, app: string, appName: string, meta: Record<string, unknown>, result: FullResult, tests: TestRow[]) {
  const pad = (n: number) => String(n).padStart(2, '0');
  const d = start;
  const id = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const dir = path.join(ROOT, 'reports', 'history', app, id);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.cpSync(out, dir, { recursive: true });
  const failed = (t: TestRow) => ['failed', 'timedOut', 'interrupted'].includes(t.status);
  const summary: RunSummary = {
    id, app, appName, env: String(meta.env ?? ''), locale: String(meta.locale ?? ''), target: String(meta.target ?? ''),
    started: d.toISOString(), duration: result.duration, status: result.status,
    counts: {
      total: tests.length, passed: tests.filter((t) => t.status === 'passed' && !t.flaky).length, failed: tests.filter(failed).length,
      flaky: tests.filter((t) => t.flaky).length, skipped: tests.filter((t) => t.status === 'skipped').length,
      positive: tests.filter((t) => t.kind === 'positive').length, negative: tests.filter((t) => t.kind === 'negative').length,
      healed: tests.filter((t) => t.status === 'passed' && t.healing.length).length,
      healingFailed: tests.filter((t) => t.category === 'Self-healing').length,
    },
    healingPolicy: runConfig.healing,
    tests: tests.map((t) => ({ title: t.title, module: t.module, kind: t.kind, status: t.flaky ? 'flaky' : t.status, duration: t.duration, tcId: t.tcId, category: t.category, lastPage: t.lastPage, caseFile: t.caseFile, discoveries: t.discoveries, user: t.user, healed: t.healed.length ? t.healed : undefined, healing: t.healing.length ? t.healing : undefined })),
  };
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 1));
  // retention
  const runs = fs.readdirSync(path.dirname(dir)).filter((x) => /^\d{8}-\d{6}/.test(x)).sort();
  for (const old of runs.slice(0, Math.max(0, runs.length - HISTORY_KEEP))) fs.rmSync(path.join(path.dirname(dir), old), { recursive: true, force: true });
  console.log(`  Saved to history → reports/history/${app}/${id}\n`);
}

function openInBrowser(file: string) {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', file]] :
    process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]];
  try {
    const child = spawn(cmd, args as string[], { detached: true, stdio: 'ignore' });
    child.on('error', () => console.log('  (could not open the browser automatically — open the file above)'));
    child.unref();
  } catch {
    /* headless machine */
  }
}

function flattenSteps(steps: TestStep[], showInternal: boolean, depth = 0, out: StepRow[] = []): StepRow[] {
  for (const s of steps) {
    if (s.category !== 'test.step') {
      // failed tests only: keep failing expect/pw:api calls so the failing line is visible
      if (showInternal && s.error && (s.category === 'expect' || s.category === 'pw:api')) {
        out.push({ title: s.title, kind: s.category === 'expect' ? 'Assert' : 'Action', duration: s.duration, error: strip(s.error.message ?? ''), depth });
      }
      continue;
    }
    const m = /^\[(.+?)\]\s*(.*)$/.exec(s.title);
    out.push({ title: m ? m[2] : s.title, kind: m ? m[1] : 'Step', duration: s.duration, error: s.error ? strip(s.error.message ?? '') : undefined, depth });
    flattenSteps(s.steps, showInternal, depth + 1, out);
  }
  return out;
}

function classify(msg: string): Category {
  if (msg.includes('[Healing]')) return 'Self-healing';
  if (msg.includes('[Smart OR]')) return 'Locator / OR';
  if (/net::ERR|ECONNREFUSED|ENOTFOUND|browserType\.connect|Target page, context or browser has been closed/i.test(msg)) return 'Environment';
  if (/Test timeout of|exceeded while/i.test(msg) && !/expect\(/.test(msg)) return 'Timeout';
  if (/expect\(|toHave|toBe/.test(msg)) return 'Application defect';
  return 'Script error';
}

const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

function html(data: unknown): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${(data as { title: string }).title}</title>
<style>${CSS}</style>
</head>
<body>
<div class="viz-root" id="app"></div>
<script>window.__REPORT__ = ${json};</script>
<script>${JS}</script>
</body>
</html>`;
}

const CSS = String.raw`
.viz-root{color-scheme:light;
  --surface-0:#f4f4f2;--surface-1:#fcfcfb;--border:#e4e3df;
  --text-primary:#0b0b0b;--text-secondary:#52514e;--text-muted:#7a7974;
  --series-1:#2a78d6;--series-2:#eb6834;--series-gray:#a3a29d;
  --good:#0ca30c;--warning:#fab219;--serious:#ec835a;--critical:#d03b3b;--good-ink:#006300;--critical-ink:#b42323;
  --chip:#efeeea;--code:#f6f5f2}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;
  --surface-0:#121211;--surface-1:#1a1a19;--border:#2e2e2b;--text-primary:#f0efec;--text-secondary:#c3c2b7;--text-muted:#8f8e86;
  --series-1:#3987e5;--series-2:#d95926;--series-gray:#6b6a65;--good-ink:#4cc94c;--critical-ink:#f08080;--chip:#262624;--code:#222220}}
:root[data-theme="dark"] .viz-root{color-scheme:dark;
  --surface-0:#121211;--surface-1:#1a1a19;--border:#2e2e2b;--text-primary:#f0efec;--text-secondary:#c3c2b7;--text-muted:#8f8e86;
  --series-1:#3987e5;--series-2:#d95926;--series-gray:#6b6a65;--good-ink:#4cc94c;--critical-ink:#f08080;--chip:#262624;--code:#222220}
*{box-sizing:border-box}
body{margin:0;background:#f4f4f2}
:root[data-theme="dark"] body{background:#121211}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) body{background:#121211}}
.brandbar{height:5px;background:var(--brand,#2a78d6);border-radius:3px;margin-bottom:16px}
.brandhead{display:flex;gap:14px;align-items:center}
.brandhead .logo{max-height:52px;max-width:160px;object-fit:contain}
.who{font-size:12px;color:var(--text-secondary);font-weight:600;margin-bottom:2px}
.conf{font-size:11px;border:1px solid var(--brand,#2a78d6);color:var(--text-primary);border-radius:4px;padding:0 6px;margin-inline-start:6px;font-weight:600;text-transform:uppercase;letter-spacing:.3px}
.brandfoot{margin-top:24px;padding-top:12px;border-top:2px solid var(--brand,#2a78d6);font-size:12px;color:var(--text-secondary)}
.viz-root{font:14px/1.45 system-ui,"Segoe UI",Tahoma,sans-serif;color:var(--text-primary);background:var(--surface-0);min-height:100vh;padding:24px;max-width:1280px;margin:0 auto}
h1{font-size:22px;margin:0}h2{font-size:15px;margin:0 0 12px;color:var(--text-primary)}
.muted{color:var(--text-muted)}.sec{color:var(--text-secondary)}
header.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:20px;flex-wrap:wrap}
.meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.pill{background:var(--chip);border-radius:999px;padding:2px 10px;font-size:12px;color:var(--text-secondary)}
.btn{background:var(--surface-1);border:1px solid var(--border);color:var(--text-primary);border-radius:8px;padding:6px 12px;cursor:pointer;font:inherit}
.grid{display:grid;gap:16px}
.kpis{grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:16px}
.card{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;padding:16px}
.kpi .v{font-size:30px;font-weight:650;letter-spacing:-.5px}.kpi .l{color:var(--text-secondary);font-size:12px;display:flex;align-items:center;gap:6px}
.dot{width:10px;height:10px;border-radius:3px;display:inline-block;flex:none}
.two{grid-template-columns:1.2fr 1fr;margin-bottom:16px}@media(max-width:900px){.two{grid-template-columns:1fr}}
.barrow{display:grid;grid-template-columns:110px 1fr 70px;gap:10px;align-items:center;margin:10px 0}
.bar{display:flex;gap:2px;height:16px}
.bar span{display:block;height:100%;border-radius:4px;min-width:3px;position:relative}
.bar span:hover{outline:2px solid var(--text-primary);outline-offset:1px}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--text-secondary);margin-top:6px}
.legend i{display:inline-flex;align-items:center;gap:6px;font-style:normal}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:start;color:var(--text-muted);font-weight:500;padding:6px 8px;border-bottom:1px solid var(--border)}
td{padding:6px 8px;border-bottom:1px solid var(--border)}
td.n{text-align:end;font-variant-numeric:tabular-nums}
.warnbox{border-inline-start:4px solid var(--warning)}
.warnbox li{margin:4px 0}
.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:20px 0 12px}
.filters select,.filters input{background:var(--surface-1);border:1px solid var(--border);color:var(--text-primary);border-radius:8px;padding:6px 10px;font:inherit}
.filters input{flex:1;min-width:200px}
.status{display:inline-flex;align-items:center;gap:6px;font-weight:600;font-size:12px;white-space:nowrap}
.status.passed{color:var(--good-ink)}.status.failed,.status.timedOut,.status.interrupted{color:var(--critical-ink)}.status.skipped{color:var(--text-muted)}.status.flaky{color:var(--text-primary)}
.test{background:var(--surface-1);border:1px solid var(--border);border-radius:10px;margin-bottom:8px;overflow:hidden}
.test>summary{display:grid;grid-template-columns:110px 1fr auto auto;gap:12px;align-items:center;padding:10px 14px;cursor:pointer;list-style:none}
.test>summary::-webkit-details-marker{display:none}
.test[open]>summary{border-bottom:1px solid var(--border)}
.tag{font-size:11px;border-radius:6px;padding:1px 7px;background:var(--chip);color:var(--text-secondary);margin-inline-end:4px}
.tag.positive{box-shadow:inset 3px 0 0 var(--series-1)}.tag.negative{box-shadow:inset 3px 0 0 var(--series-2)}
.body{padding:14px;display:grid;gap:14px}
.steps{border-inline-start:2px solid var(--border);padding-inline-start:12px}
.step{display:grid;grid-template-columns:86px 1fr auto;gap:10px;padding:3px 0;align-items:baseline}
.kind{font-size:11px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.3px}
.step.err .t{color:var(--critical-ink)}
pre{background:var(--code);border-radius:8px;padding:10px;overflow:auto;font-size:12px;margin:0;white-space:pre-wrap;max-height:320px}
.shots{display:flex;gap:10px;flex-wrap:wrap}
.shots figure{margin:0;width:260px}.shots img{width:100%;border:1px solid var(--border);border-radius:6px;cursor:zoom-in}
.shots figcaption{font-size:11px;color:var(--text-muted)}
.links a{color:var(--series-1);margin-inline-end:14px}
.healed{background:color-mix(in srgb,var(--warning) 14%,transparent);border-radius:8px;padding:8px 10px;font-size:12px}
.cat{font-size:12px;font-weight:600}
dialog{border:0;padding:0;background:transparent;max-width:95vw}dialog img{max-width:95vw;max-height:90vh;border-radius:8px}
dialog::backdrop{background:#000a}
`;

const JS = String.raw`
const R = window.__REPORT__;
const $ = (s, el=document) => el.querySelector(s);
const esc = (s='') => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const ms = (n) => n < 1000 ? n + ' ms' : (n/1000).toFixed(1) + ' s';
const ST = {
  passed:{label:'Passed',icon:'✔',color:'var(--good)'},
  failed:{label:'Failed',icon:'✖',color:'var(--critical)'},
  timedOut:{label:'Timed out',icon:'⏱',color:'var(--critical)'},
  interrupted:{label:'Interrupted',icon:'⏹',color:'var(--serious)'},
  flaky:{label:'Flaky',icon:'⚠',color:'var(--warning)'},
  skipped:{label:'Skipped',icon:'⤼',color:'var(--series-gray)'},
};
const st = t => t.flaky ? 'flaky' : t.status;
const failed = t => ['failed','timedOut','interrupted'].includes(t.status);
const T = R.tests;
const count = (arr, s) => arr.filter(t => st(t) === s || (s==='failed' && failed(t) && !t.flaky)).length;

function kpis() {
  const total = T.length, pass = count(T,'passed'), fail = T.filter(failed).length, flaky = count(T,'flaky'), skip = count(T,'skipped');
  const executed = total - skip;
  const rate = executed ? Math.round(((pass + flaky) / executed) * 1000) / 10 : 0;
  const tile = (v, l, s) => '<div class="card kpi"><div class="v">' + v + '</div><div class="l">' + (s ? '<span class="dot" style="background:'+ST[s].color+'"></span>' + ST[s].icon + ' ' : '') + l + '</div></div>';
  return '<div class="grid kpis">' + tile(rate + '%', 'Pass rate (executed)') + tile(total, 'Total tests') + tile(pass, 'Passed', 'passed') +
    tile(fail, 'Failed', 'failed') + tile(flaky, 'Flaky (passed on retry)', 'flaky') + tile(skip, 'Skipped', 'skipped') + tile(ms(R.duration), 'Duration') + '</div>';
}

function stacked(label, arr) {
  const order = ['passed','flaky','failed','skipped'];
  const n = arr.length || 1;
  const segs = order.map(s => {
    const c = s === 'failed' ? arr.filter(t => failed(t)).length : count(arr, s);
    if (!c) return '';
    return '<span style="flex:' + c + ';background:' + ST[s].color + '" title="' + label + ' — ' + ST[s].label + ': ' + c + ' of ' + arr.length + ' (' + Math.round(c/n*100) + '%)"></span>';
  }).join('');
  const passN = arr.filter(t => t.status === 'passed').length;
  return '<div class="barrow"><div class="sec">' + esc(label) + '</div><div class="bar">' + (segs || '<span style="flex:1;background:var(--border)"></span>') + '</div><div class="n muted" style="text-align:end">' + passN + ' / ' + arr.length + '</div></div>';
}

function legend() {
  return '<div class="legend">' + ['passed','flaky','failed','skipped'].map(s => '<i><span class="dot" style="background:'+ST[s].color+'"></span>'+ST[s].icon+' '+ST[s].label+'</i>').join('') + '</div>';
}

function byKind() {
  const pos = T.filter(t => t.kind==='positive'), neg = T.filter(t => t.kind==='negative'), oth = T.filter(t => t.kind==='other');
  return '<div class="card"><h2>Results by scenario type</h2>' + stacked('Positive', pos) + stacked('Negative', neg) + (oth.length ? stacked('Untagged', oth) : '') + legend() + '</div>';
}

function failureCats() {
  const f = T.filter(failed);
  const cats = {};
  f.forEach(t => cats[t.category] = (cats[t.category] || 0) + 1);
  const hint = {'Application defect':'Assertion failed — likely a real bug','Locator / OR':'Element not found / ambiguous — update or/*.page.yml','Environment':'App or browser unreachable','Timeout':'Slow page or stuck step','Script error':'Problem in test code'};
  const rows = Object.entries(cats).sort((a,b)=>b[1]-a[1]).map(([c,n]) => '<tr><td class="cat">' + esc(c) + '</td><td class="muted">' + esc(hint[c]||'') + '</td><td class="n">' + n + '</td></tr>').join('');
  return '<div class="card"><h2>Failure analysis</h2>' + (f.length ? '<table><tr><th>Category</th><th>Meaning</th><th style="text-align:end">Tests</th></tr>' + rows + '</table>' : '<p class="muted">No failures 🎉</p>') + '</div>';
}

function modules() {
  const m = {};
  T.forEach(t => (m[t.module] ||= []).push(t));
  const rows = Object.entries(m).map(([name, arr]) => {
    const p = arr.filter(t=>t.status==='passed').length, f = arr.filter(failed).length;
    const pos = arr.filter(t=>t.kind==='positive').length, neg = arr.filter(t=>t.kind==='negative').length;
    return '<tr><td>' + esc(name) + '</td><td class="n">' + arr.length + '</td><td class="n">' + pos + '</td><td class="n">' + neg + '</td><td class="n">' + p + '</td><td class="n">' + f + '</td><td class="n">' + ms(arr.reduce((a,t)=>a+t.duration,0)) + '</td></tr>';
  }).join('');
  return '<div class="card"><h2>By module</h2><table><tr><th>Module</th><th style="text-align:end">Tests</th><th style="text-align:end">Positive</th><th style="text-align:end">Negative</th><th style="text-align:end">Passed</th><th style="text-align:end">Failed</th><th style="text-align:end">Time</th></tr>' + rows + '</table></div>';
}

function orHealth() {
  const healed = [...new Set(T.flatMap(t => t.healed))], xp = [...new Set(T.flatMap(t => t.xpath))];
  if (!healed.length && !xp.length) return '<div class="card"><h2>Object Repository health</h2><p class="muted">All elements resolved by their primary locator.</p></div>';
  const nHealed = T.filter(t => t.status === 'passed' && t.healing && t.healing.length).length;
  return '<div class="card warnbox"><h2>⚠ Object Repository health</h2><p class="sec">' + (nHealed ? nHealed + ' test(s) passed only with self-healing. ' : '') + 'These elements were found by a fallback or by XPath, or a page was reached another way. Update the OR before they break.</p><ul>' +
    healed.map(h => '<li>' + esc(h) + '</li>').join('') + xp.map(h => '<li>' + esc(h) + '</li>').join('') + '</ul></div>';
}

function testCard(t) {
  const s = ST[st(t)];
  const tags = t.tags.filter(x => !/^@TC-/.test(x)).map(x => '<span class="tag ' + (x==='@positive'?'positive':x==='@negative'?'negative':'') + '">' + esc(x) + '</span>').join('');
  const steps = t.steps.map(x => '<div class="step' + (x.error?' err':'') + '" style="padding-inline-start:' + (x.depth*16) + 'px"><span class="kind">' + esc(x.kind) + '</span><span class="t">' + (x.error?'✖ ':'') + esc(x.title) + '</span><span class="muted">' + ms(x.duration) + '</span></div>').join('');
  const shots = t.screenshots.map(x => '<figure><img src="' + x.src + '" alt="' + esc(x.name) + '" loading="lazy"><figcaption>' + esc(x.name) + '</figcaption></figure>').join('');
  const links = [t.video && '<a href="' + t.video + '" target="_blank">▶ Video</a>', t.trace && '<a href="' + t.trace + '" download>⬇ Trace</a> <span class="muted">open with: npx playwright show-trace ' + esc(t.trace) + '</span>'].filter(Boolean).join('');
  return '<details class="test" data-status="' + st(t) + '" data-kind="' + t.kind + '" data-module="' + esc(t.module) + '" data-search="' + esc((t.title + ' ' + t.tags.join(' ') + ' ' + t.module).toLowerCase()) + '">' +
    '<summary><span class="status ' + st(t) + '">' + s.icon + ' ' + s.label + '</span><span><b>' + esc(t.title) + '</b><br><span class="muted" style="font-size:12px">' + esc(t.module) + ' · ' + esc(t.project) + '</span> ' + tags + '</span>' +
    '<span class="muted">' + (t.retries ? 'retry ' + t.retries + ' · ' : '') + ms(t.duration) + '</span><span class="muted">▾</span></summary>' +
    '<div class="body">' +
      (t.error ? '<div><div class="cat" style="color:var(--critical-ink);margin-bottom:6px">✖ ' + esc(t.category) + '</div><pre>' + esc(t.error) + '</pre></div>' : '') +
      (t.healing && t.healing.length
        ? '<div class="healed"><b>⚠ Self-healed</b>' + t.healing.map(h => '<div style="margin-top:4px"><b>' + esc(h.target) + '</b> · ' + esc(h.kind) + (h.purpose === 'check' ? ' · <b>during a check</b>' : '') +
            '<br><span class="muted">Original failure:</span> ' + esc(h.original) + '<br><span class="muted">Healed by:</span> ' + esc(h.healedBy) + ' · ' + esc(h.fix) + '</div>').join('') + '</div>'
        : t.healed.length ? '<div class="healed">⚠ ' + t.healed.map(esc).join('<br>⚠ ') + '</div>' : '') +
      (t.lastPage ? '<div class="muted" style="font-size:12px;margin:6px 0">Ended on ' + (t.lastPage.page ? '<b>' + esc(t.lastPage.page) + '</b> page' : '<b>a page not in the Object Repository yet</b> — use <i>Detect &amp; continue</i> in the Control Panel') + ' · ' + esc(t.lastPage.url) + '</div>' : '') +
      (t.detected ? '<div class="muted" style="font-size:12px">🔎 Detected: ' + esc(t.detected) + '</div>' : '') +
      (t.vars && t.vars.length ? '<div class="muted" style="font-size:12px">Runtime values: ' + t.vars.map(v => '<code>' + esc(v) + '</code>').join(' · ') + '</div>' : '') +
      '<div><h2>Steps</h2><div class="steps">' + (steps || '<span class="muted">No steps recorded</span>') + '</div></div>' +
      (shots ? '<div><h2>Screenshots</h2><div class="shots">' + shots + '</div></div>' : '') +
      '<div class="muted" style="font-size:12px">' + esc(t.file) + (t.seed ? ' · data seed ' + esc(t.seed) : '') + (t.tcId ? ' · ' + esc(t.tcId) : '') + '</div>' +
      (links ? '<div class="links">' + links + '</div>' : '') +
    '</div></details>';
}

function render() {
  const m = R.meta || {};
  const started = new Date(R.started);
  const setupFail = R.setup.filter(failed);
  const mods = [...new Set(T.map(t => t.module))];
  const B = R.brand || {};
  if (B.primaryColor) document.querySelector('.viz-root').style.setProperty('--brand', B.primaryColor);
  const who = [B.company, B.client].filter(Boolean).join(' · ');
  $('#app').innerHTML =
    '<div class="brandbar"></div>' +
    '<header class="top"><div class="brandhead">' + (B.logo ? '<img class="logo" src="' + B.logo + '" alt="">' : '') + '<div>' +
      (who ? '<div class="who">' + esc(who) + (B.confidentiality ? ' <span class="conf">' + esc(B.confidentiality) + '</span>' : '') + '</div>' : (B.confidentiality ? '<span class="conf">' + esc(B.confidentiality) + '</span>' : '')) +
      '<h1>' + esc(R.title) + '</h1><div class="meta">' +
      ['Project: ' + (R.appName ?? m.app ?? '-'), 'Env: ' + (m.env ?? '-'), 'Target: ' + (m.target ?? '-'), 'Locale: ' + (m.locale ?? '-'), 'Seed: ' + (m.seed ?? '-'), 'Playwright ' + R.version, started.toLocaleString()].map(x => '<span class="pill">' + esc(x) + '</span>').join('') +
    '</div></div></div><button class="btn" id="theme">◐ Theme</button></header>' +
    (setupFail.length ? '<div class="card" style="border-inline-start:4px solid var(--critical);margin-bottom:16px"><b>✖ Setup failed</b> — dependent tests did not run.<pre>' + esc(setupFail[0].error) + '</pre></div>' : '') +
    kpis() +
    '<div class="grid two">' + byKind() + failureCats() + '</div>' +
    '<div class="grid two">' + modules() + orHealth() + '</div>' +
    '<div class="filters"><select id="fs"><option value="">All statuses</option>' + Object.keys(ST).map(k => '<option value="'+k+'">'+ST[k].label+'</option>').join('') + '</select>' +
      '<select id="fk"><option value="">Positive + Negative</option><option value="positive">Positive</option><option value="negative">Negative</option><option value="other">Untagged</option></select>' +
      '<select id="fm"><option value="">All modules</option>' + mods.map(x => '<option>' + esc(x) + '</option>').join('') + '</select>' +
      '<input id="fq" placeholder="Search title, tag or TC id…"><button class="btn" id="fx">Expand failures</button></div>' +
    '<div id="list">' + [...T].sort((a,b) => (failed(b)-failed(a)) || a.title.localeCompare(b.title)).map(testCard).join('') + '</div>' +
    '<p class="muted" id="cnt"></p>' +
    (B.footer || B.confidentiality ? '<footer class="brandfoot">' + esc(B.footer || '') + (B.confidentiality ? ' <span class="conf">' + esc(B.confidentiality) + '</span>' : '') + '</footer>' : '') +
    '<dialog id="zoom"><img></dialog>';

  const apply = () => {
    const s = $('#fs').value, k = $('#fk').value, mo = $('#fm').value, q = $('#fq').value.toLowerCase();
    let n = 0;
    document.querySelectorAll('.test').forEach(el => {
      const ok = (!s || el.dataset.status === s) && (!k || el.dataset.kind === k) && (!mo || el.dataset.module === mo) && (!q || el.dataset.search.includes(q));
      el.style.display = ok ? '' : 'none'; if (ok) n++;
    });
    $('#cnt').textContent = n + ' of ' + T.length + ' tests shown';
  };
  ['#fs','#fk','#fm'].forEach(id => $(id).onchange = apply);
  $('#fq').oninput = apply;
  $('#fx').onclick = () => document.querySelectorAll('.test').forEach(el => el.open = ['failed','timedOut','interrupted'].includes(el.dataset.status));
  $('#theme').onclick = () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = cur === 'dark' ? 'light' : 'dark';
  };
  $('#list').onclick = e => { if (e.target.tagName === 'IMG') { const d = $('#zoom'); d.querySelector('img').src = e.target.src; d.showModal(); } };
  $('#zoom').onclick = () => $('#zoom').close();
  apply();
}
render();
`;
