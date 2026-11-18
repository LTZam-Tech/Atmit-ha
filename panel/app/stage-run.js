// Step ⑤ — Run & reports: run settings, pick tests, live console, run history with trend and compare.
import { html, useState, useEffect } from '/vendor/preact-htm.js';
import { useStore, store, api, toast, loadState, startRun, byTitles, runSettings, saveRunSettings, reEsc, runBody, go } from './core.js';
import { Field, Console, Empty, Modal } from './ui.js';
import { currentLang } from './i18n.js';
import { GenerateCasesModal } from './stage-builder.js';

const TARGET_HINTS = {
  local: 'This computer. Offline machines: BROWSER_CHANNEL=msedge or PLAYWRIGHT_BROWSERS_PATH.',
  grid: 'Internal Playwright Grid — GRID_WS_URL (default ws://localhost:3000/).',
  browserstack: 'Needs BROWSERSTACK_USERNAME / BROWSERSTACK_ACCESS_KEY.',
  lambdatest: 'Needs LT_USERNAME / LT_ACCESS_KEY.',
};
const rateOf = (c) => Math.round(((c.passed + c.flaky) / Math.max(1, c.total - c.skipped)) * 100);
const fmtDate = (iso) => new Date(iso).toLocaleString(currentLang() === 'ar' ? 'ar-JO-u-nu-latn' : [], { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dur = (ms) => (ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} m ${Math.round((ms % 60000) / 1000)} s`);

export function StageRun() {
  const s = useStore();
  const S = s.S;
  const tab = s.runTab ?? (s.history.length ? 'history' : 'tests');
  const setTab = (t) => store.set({ runTab: t });
  return html`
    <div class="page-title"><h1>Runs</h1><span class="sub">Run the tests and follow the results over time</span></div>
    <div class="run-layout">
      <${Settings} />
      <div class="card" style="margin:0">
        <div class="tabs">
          ${[['tests', 'Tests'], ['console', 'Console'], ['history', `Reports & history`]].map(([k, l]) => html`<button class="tab ${tab === k ? 'active' : ''}" onClick=${() => setTab(k)}>${l}${k === 'history' ? html`<span class="n">${s.history.length}</span>` : ''}${k === 'console' && s.running ? html` <span class="spin"></span>` : ''}</button>`)}
        </div>
        ${tab === 'tests' && html`<${Tests} />`}
        ${tab === 'console' && html`<div class="row between" style="margin-bottom:8px"><b>${s.jobLabel ?? 'No job yet'}</b><button class="btn sm" style="flex:0" onClick=${() => store.set({ log: [] })}>Clear</button></div><${Console} />`}
        ${tab === 'history' && html`<${History} />`}
      </div>
    </div>`;
}

function Settings() {
  const s = useStore();
  const S = s.S;
  const [v, setV] = useState(() => runSettings());
  const [suites, setSuites] = useState(false);
  const set = (k, val) => { const n = { ...v, [k]: val }; setV(n); saveRunSettings(n); };
  const env = v.env || S.settings?.defaultEnv || S.envs[0];
  return html`<div>
    <div class="card">
      <button class="btn primary big" style="width:100%" disabled=${s.running} onClick=${() => startRun({ label: 'all tests' })}>▶ Run all tests</button>
      <div class="row between" style="margin-top:12px"><b class="small sec">Run suites</b><button class="btn sm" style="flex:0 0 auto" onClick=${() => setSuites(true)}>⚙ Suites</button></div>
      <div class="row start" style="flex-wrap:wrap;gap:6px;margin-top:6px">
        ${S.suites.map((x) => html`<button class="btn" title=${x.description || ''} disabled=${s.running} onClick=${() => startRun({ suite: x.name, label: `suite "${x.name}"` })}>▶ ${x.name}</button>`)}
        <button class="btn" disabled=${s.running} onClick=${() => startRun({ grep: '@negative(?: |$)', label: 'negative tests' })}>▶ Negative</button>
      </div>
      ${!S.suites.length && html`<div class="hint">No suites yet — ⚙ Suites groups cases by module or tag (Smoke, Regression…).</div>`}
    </div>
    ${suites && html`<${SuitesModal} close=${() => setSuites(false)} />`}
    <div class="card">
      <h2>Run settings</h2>
      <${Field} label="Environment" hint=${S.baseURLs[env]}><select value=${env} onChange=${(e) => set('env', e.target.value)}>${S.envs.map((x) => html`<option value=${x}>${x}</option>`)}</select></${Field}>
      <div class="row">
        <${Field} label="Language"><select value=${v.locale} onChange=${(e) => set('locale', e.target.value)}>${S.languages.map((l) => html`<option value=${l}>${l === 'ar' ? 'العربية' : 'English'}</option>`)}</select></${Field}>
        <${Field} label="Browser"><select value=${v.project} onChange=${(e) => set('project', e.target.value)}>${S.projects.map((p) => html`<option value=${p}>${p}</option>`)}</select></${Field}>
      </div>
      <${Field} label="Where the browser runs" hint=${TARGET_HINTS[v.target]}><select value=${v.target} onChange=${(e) => set('target', e.target.value)}>${S.targets.map((t) => html`<option value=${t}>${t}</option>`)}</select></${Field}>
      <label class="check"><input type="checkbox" checked=${v.headed} onChange=${(e) => set('headed', e.target.checked)} /> Show the browser while running</label>
      <${Field} label=${`Slow motion: ${v.slowmo} ms`}><input type="range" min="0" max="2000" step="100" value=${v.slowmo} onInput=${(e) => set('slowmo', Number(e.target.value))} /></${Field}>
      <label class="check"><input type="checkbox" checked=${v.video} onChange=${(e) => set('video', e.target.checked)} /> Record video for every test</label>
      <div class="row">
        <${Field} label="Browsers at once" hint=${v.headed && !v.workers ? 'Visible browser → 1 at a time' : `Project default: ${S.settings?.run?.workers ?? 2}`}><input type="number" min="1" max="16" placeholder=${String(v.headed ? 1 : S.settings?.run?.workers ?? 2)} value=${v.workers} onInput=${(e) => set('workers', e.target.value)} /></${Field}>
        <${Field} label="Retries"><input type="number" min="0" max="3" placeholder="0" value=${v.retries} onInput=${(e) => set('retries', e.target.value)} /></${Field}>
      </div>
      <${Field} label="Data seed (repeat a run)"><input type="text" placeholder="random" value=${v.seed} onInput=${(e) => set('seed', e.target.value)} /></${Field}>
    </div>
  </div>`;
}

function Tests() {
  const s = useStore();
  const S = s.S;
  const [tests, setTests] = useState(null);
  const [err, setErr] = useState('');
  const [tag, setTag] = useState('');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(new Set());
  const load = async () => {
    setTests(null); setErr('');
    const v = runSettings();
    try { setTests(await api(`/api/tests?app=${S.app}&env=${encodeURIComponent(v.env || '')}&locale=${v.locale}`)); } catch (e) { setErr(e.message); setTests([]); }
  };
  useEffect(() => { load(); }, [S.app, S.cases.length]);
  if (tests === null) return html`<${Empty}><span class="spin"></span> Loading tests…</${Empty}>`;
  const key = (t) => `${t.file}:${t.line}:${t.title}`;
  const tags = [...new Set(tests.flatMap((t) => t.tags))].filter((t) => !/^@TC-/.test(t)).sort();
  const list = tests.filter((t) => (!tag || t.tags.includes(tag)) && (!q || (t.title + ' ' + t.tags.join(' ') + ' ' + t.module).toLowerCase().includes(q.toLowerCase())));
  const groups = {};
  list.forEach((t) => (groups[t.module] ||= []).push(t));
  const toggle = (k, on) => { const n = new Set(sel); on ? n.add(k) : n.delete(k); setSel(n); };
  return html`<div>
    ${err && html`<div class="err">${err}</div>`}
    <div class="row" style="margin-bottom:10px;align-items:center">
      <div class="chips" style="flex:2">${['', ...tags].map((t) => html`<span class="chip ${t === tag ? 'on' : ''}" onClick=${() => setTag(t)}>${t || 'All'}</span>`)}</div>
      <input type="text" placeholder="Search title, tag, TC id…" value=${q} onInput=${(e) => setQ(e.target.value)} />
      <button class="btn sm" style="flex:0" onClick=${load}>↻</button>
    </div>
    <div class="row start" style="margin-bottom:10px">
      <button class="btn primary" disabled=${!sel.size || s.running} onClick=${() => startRun({ ...byTitles(tests.filter((t) => sel.has(key(t))).map((t) => t.title)), label: `${sel.size} selected test(s)` })}>▶ Run selected (${sel.size})</button>
      <button class="btn" disabled=${s.running} onClick=${() => (list.length === tests.length ? startRun({ label: 'all tests' }) : startRun({ ...byTitles(list.map((t) => t.title)), label: `${list.length} test(s)` }))}>▶ Run what is shown</button>
      <span class="muted small">${list.length} of ${tests.length} shown</span>
    </div>
    ${Object.entries(groups).map(([mod, arr]) => html`<div class="module">
      <div class="mh"><input type="checkbox" checked=${arr.every((t) => sel.has(key(t)))} onChange=${(e) => { const n = new Set(sel); arr.forEach((t) => (e.target.checked ? n.add(key(t)) : n.delete(key(t)))); setSel(n); }} />
        <b>${mod}</b><span class="badge">${arr[0].source === 'no-code' ? 'no-code case' : 'code test'}</span><span class="muted small">${arr.length}</span>
        <button class="btn sm" disabled=${s.running} onClick=${() => startRun({ ...byTitles(arr.map((t) => t.title)), label: mod })}>▶ Run</button></div>
      ${arr.map((t) => html`<div class="trow"><input type="checkbox" checked=${sel.has(key(t))} onChange=${(e) => toggle(key(t), e.target.checked)} />
        <div><div>${t.title}</div><div>${t.tags.filter((x) => !/^@TC-/.test(x)).map((x) => html`<span class="tag ${x === '@positive' ? 'pos' : x === '@negative' ? 'neg' : ''}">${x}</span>`)}</div></div>
        <button class="btn sm" disabled=${s.running} onClick=${() => startRun({ ...byTitles([t.title]), label: t.title })}>▶</button></div>`)}
    </div>`)}
    ${!tests.length && !err && html`<${Empty}>No tests yet — build one in Tests.</${Empty}>`}
  </div>`;
}

function History() {
  const s = useStore();
  const S = s.S;
  const H = s.history;
  const [view, setView] = useState(s.viewRun ?? H[0]?.id);
  const [cmp, setCmp] = useState([]);
  useEffect(() => { if (s.viewRun) { setView(s.viewRun); store.viewRun = undefined; } }, [s.viewRun]);
  if (!H.length) return html`<${Empty}>No runs yet. Press <b>▶ Run all tests</b> — every run is saved here with its date, environment and full report.</${Empty}>`;
  const cur = H.find((r) => r.id === view) ?? H[0];
  const c = cur.counts;
  const last20 = H.slice(0, 20).reverse();
  const del = async (id) => { if (!confirm('Delete this run from history?')) return; await api(`/api/history/${S.app}/${id}`, { method: 'DELETE' }); loadState(); };
  const toggleCmp = (id) => setCmp(cmp.includes(id) ? cmp.filter((x) => x !== id) : [...cmp.slice(-1), id]);
  return html`<div>
    <div class="kpis">
      ${[[`${rateOf(c)}%`, 'Pass rate'], [c.total, 'Tests'], [c.passed, 'Passed', 'var(--good)'], [c.failed, 'Failed', 'var(--critical)'], [c.flaky, 'Flaky', 'var(--warning)'], [dur(cur.duration), 'Duration']]
        .map(([v, l, col]) => html`<div class="kpi"><div class="v">${v}</div><div class="l">${col && html`<span class="dot" style=${`background:${col}`}></span>`}${l}</div></div>`)}
    </div>
    <div class="card">
      <h2>Pass rate over the last ${last20.length} run(s)<span class="grow"></span><span class="muted small">click a bar to open that run</span></h2>
      <div class="trend">${last20.map((r) => { const rt = rateOf(r.counts); return html`<div class="bar ${r.id === cur.id ? 'sel' : ''}" onClick=${() => setView(r.id)}
        title=${`${fmtDate(r.started)} · ${r.env} · ${rt}% (${r.counts.passed + r.counts.flaky}/${r.counts.total - r.counts.skipped})`}
        style=${`height:${Math.max(3, rt)}%;background:${r.counts.failed ? 'var(--critical)' : 'var(--good)'}`}></div>`; })}</div>
      <div class="row between small muted" style="margin-top:4px"><span>${fmtDate(last20[0].started)}</span><span>${fmtDate(last20.at(-1).started)}</span></div>
    </div>
    <div class="card">
      <h2>Runs <span class="grow"></span>${cmp.length === 2 ? html`<span class="badge ok">comparing 2 runs ↓</span>` : html`<span class="muted small">tick two runs to compare</span>`}</h2>
      <table><tr><th></th><th>Date</th><th>Environment</th><th>Language</th><th>Tests</th><th>Result</th><th>Duration</th><th></th></tr>
        ${H.map((r) => html`<tr class="clickable ${r.id === cur.id ? 'sel' : ''}" onClick=${() => setView(r.id)}>
          <td onClick=${(e) => e.stopPropagation()}><input type="checkbox" checked=${cmp.includes(r.id)} onChange=${() => toggleCmp(r.id)} /></td>
          <td>${fmtDate(r.started)}</td><td>${r.env}</td><td>${r.locale}</td><td>${r.counts.total}</td>
          <td class="res ${r.counts.failed ? 'bad' : 'ok'}">${r.counts.failed ? `✖ ${r.counts.failed} failed` : '✔ passed'} · ${rateOf(r.counts)}%</td>
          <td>${dur(r.duration)}</td>
          <td style="white-space:nowrap" onClick=${(e) => e.stopPropagation()}><a class="btn icon" href=${`/history/${S.app}/${r.id}/index.html`} target="_blank">Open ↗</a> <button class="btn icon danger" onClick=${() => del(r.id)}>✕</button></td></tr>`)}
      </table>
    </div>
    ${cmp.length === 2 && html`<${Compare} a=${H.find((r) => r.id === cmp[0])} b=${H.find((r) => r.id === cmp[1])} />`}
    <${Discoveries} run=${cur} />
    <div class="card">
      <h2>Report — ${fmtDate(cur.started)} · ${cur.env}<span class="grow"></span><a class="btn sm" href=${`/history/${S.app}/${cur.id}/index.html`} target="_blank">Open in new tab ↗</a></h2>
      <iframe class="report" src=${`/history/${S.app}/${cur.id}/index.html`} title="Smart report"></iframe>
    </div>
  </div>`;
}

function Compare({ a, b }) {
  if (!a || !b) return null;
  const [older, newer] = a.started < b.started ? [a, b] : [b, a];
  const map = (r) => new Map(r.tests.map((t) => [t.title, t]));
  const o = map(older), n = map(newer);
  const bad = (t) => ['failed', 'timedOut', 'interrupted'].includes(t?.status);
  const newlyFailed = [...n.values()].filter((t) => bad(t) && o.has(t.title) && !bad(o.get(t.title)));
  const fixed = [...n.values()].filter((t) => !bad(t) && bad(o.get(t.title)));
  const still = [...n.values()].filter((t) => bad(t) && bad(o.get(t.title)));
  const added = [...n.values()].filter((t) => !o.has(t.title));
  const removed = [...o.values()].filter((t) => !n.has(t.title));
  const slower = [...n.values()].filter((t) => o.has(t.title) && t.duration > o.get(t.title).duration * 1.5 && t.duration - o.get(t.title).duration > 1000);
  const block = (title, list, cls, extra = () => '') => html`<div><h3>${title} <span class="badge ${cls}">${list.length}</span></h3>${list.length ? html`<ul>${list.map((t) => html`<li>${t.title}${extra(t)}</li>`)}</ul>` : html`<div class="muted small">none</div>`}</div>`;
  return html`<div class="card cmp">
    <h2>Compare: ${fmtDate(older.started)} → ${fmtDate(newer.started)}</h2>
    <div class="muted small">Pass rate ${rateOf(older.counts)}% → <b>${rateOf(newer.counts)}%</b> · tests ${older.counts.total} → ${newer.counts.total} · duration ${dur(older.duration)} → ${dur(newer.duration)}</div>
    <div class="grid3">
      ${block('🔴 Newly failing', newlyFailed, 'bad')}
      ${block('🟢 Fixed', fixed, 'ok')}
      ${block('Still failing', still, 'bad')}
      ${block('Only in the newer run', added, '')}
      ${block('Only in the older run', removed, '')}
      ${block('Much slower', slower, 'warn', (t) => ` (${dur(o.get(t.title).duration)} → ${dur(t.duration)})`)}
    </div>
  </div>`;
}

// ------------------------------------------------------------------ where the tests ended → detect & continue
const keyFromUrl = (url) => {
  const parts = new URL(url).pathname.replace(/\.(html?|aspx?|php|jsp)$/i, '').split(/[\/_.-]+/).filter((p) => p && !/^\d+$/.test(p));
  const k = parts.map((p, i) => (i ? p[0].toUpperCase() + p.slice(1) : p.toLowerCase())).join('').replace(/[^\w]/g, '') || 'home';
  return /^[a-z]/.test(k) ? k : 'page' + k;
};

/** What the run found: pages the tests reached (redirects included) and messages that popped up — grow the tests from there */
export function Discoveries({ run }) {
  const s = useStore();
  const S = s.S;
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState('');
  const [gen, setGen] = useState(null);
  const load = () => api(`/api/discoveries?app=${S.app}&run=${run.id}`).then(setD).catch(() => setD({ pages: [], messages: [] }));
  useEffect(() => { load(); }, [run.id]);
  if (!d || (!d.pages.length && !d.messages.length && !d.fixes?.length)) return null;
  const applyFix = async (f) => {
    try { await api('/api/pages/ready', { method: 'POST', body: { app: S.app, page: f.page, ...(f.kind === 'ready' ? { readyWhen: f.to } : { open: 'navigate' }) } }); toast(`${f.page} updated`); await loadState(); await load(); }
    catch (e) { toast(e.message); }
  };
  const caseOf = (r) => r && !r.flow && r.caseId ? { case: r.caseId, ...(r.tcId ? { row: r.tcId } : {}) } : undefined;
  const explore = (p) => {
    const from = p.endsHere.find((r) => caseOf(r)) ?? p.endsHere[0] ?? p.reachedBy[0];
    store.exploreFrom = { url: p.url, user: from?.user, after: caseOf(p.endsHere.find((r) => caseOf(r))), label: from?.title };
    go(`#/p/${S.app}/explore`);
  };
  const addPage = async (p) => {
    setBusy(p.url);
    try {
      const from = p.endsHere[0] ?? p.reachedBy[0];
      const r = await api('/api/discoveries/add-page', { method: 'POST', body: { app: S.app, url: p.url, user: from?.user } });
      await loadState(); await load();
      toast(`Page "${r.page}" added to the Smart OR`);
      if (r.page) setGen([r.page]);
    } catch (e) { toast(e.message); }
    setBusy('');
  };
  const cont = (r) => {
    const c = S.cases.find((x) => x.file === r.caseFile);
    store.newCase = { continueFrom: { case: r.caseFile.replace(/\.case\.yml$/, ''), row: r.tcId ?? '' }, module: c?.module };
    go(`#/p/${S.app}/builder`);
  };
  const saveMsg = async (m, t) => {
    setBusy(m.text + (t?.title ?? ''));
    try {
      const r = await api('/api/discoveries/message', { method: 'POST', body: { app: S.app, page: m.page, message: m, addTo: t?.caseFile, outcome: t ? (m.tone === 'success' ? 'success' : 'error') : undefined, rows: t?.rows } });
      await loadState(); await load();
      toast(t ? (r.added ? `Added to "${t.title}" as its expected result` : 'That check is already in the case') : 'Saved in the Smart OR');
    } catch (e) { toast(e.message); }
    setBusy('');
  };
  const fits = (m, t) => t.caseFile && !t.flow && !t.checks && (m.tone === 'success' ? t.type !== 'negative' && t.kind !== 'negative' : m.tone === 'error' ? t.type === 'negative' || t.kind === 'negative' : false);
  const newPages = d.pages.filter((p) => !p.page).length;
  return html`<div class="card disc">
    <h2>What the run found<span class="grow"></span>${newPages ? html`<span class="badge warn">${newPages} new page(s)</span>` : ''}</h2>
    <div class="muted small" style="margin-top:-6px;margin-bottom:12px">Pages the tests reached and messages that popped up. Add them and grow the tests from here — each page you explore from continues the test that reached it, as one workflow.</div>
    ${d.fixes?.length > 0 && html`<h3 class="dsec">Self-healing during the run</h3>
      ${d.fixes.map((f) => html`<div class="drow">
        <div class="dmain"><div><span class="badge warn">${f.kind === 'ready' ? 'Ready element' : 'Opened another way'}</span> <b data-noi18n>${f.page}</b></div>
          <div class="small muted">${f.kind === 'ready' ? html`“<span class="mono">${f.from}</span>” was not on the page — the run recognised it by <span class="mono">${f.to}</span>` : html`its address did not show the page — the run reached it through <span data-noi18n>${f.via}</span>`} · ${f.tests.length} test(s)</div></div>
        <div class="dact"><button class="btn sm primary" onClick=${() => applyFix(f)}>${f.kind === 'ready' ? html`Use <span class="mono">${f.to}</span> as ready element` : 'Open it through navigation'}</button></div></div>`)}`}
    <h3 class="dsec">Pages reached</h3>
    ${d.pages.map((p) => { const ends = p.endsHere.filter((r) => r.caseFile && !r.flow); return html`<div class="drow">
      <div class="dmain">
        <div>${p.page ? html`<b data-noi18n>${p.page}</b>` : html`<span class="badge warn">new page</span>`} <span class="mono small muted">${p.path}</span></div>
        <div class="small muted">${p.endsHere.length ? html`Tests ended here: <span data-noi18n>${p.endsHere.slice(0, 2).map((r) => r.title).join(' · ')}</span>${p.endsHere.length > 2 ? ` +${p.endsHere.length - 2}` : ''}` : html`Reached by: <span data-noi18n>${p.reachedBy.slice(0, 2).map((r) => r.title).join(' · ')}</span>`}
          ${p.page ? html` · ${p.cases} case(s) on this page` : ''}</div>
      </div>
      <div class="dact">
        ${!p.page && html`<button class="btn sm primary" disabled=${s.running || busy} onClick=${() => explore(p)}>🧭 Explore from here</button>
          <button class="btn sm" disabled=${s.running || busy} onClick=${() => addPage(p)}>${busy === p.url ? html`<span class="spin"></span>` : '＋'} Add page & suggest tests</button>`}
        ${p.page && html`<button class="btn sm ${p.cases ? '' : 'primary'}" onClick=${() => setGen([p.page])}>✨ Suggest test cases</button>
          <button class="btn sm" disabled=${s.running} onClick=${() => explore(p)}>🧭 Explore from here</button>`}
        ${ends.length > 0 && html`<button class="btn sm" title=${`New case that first replays "${ends[0].title}"`} onClick=${() => cont(ends[0])}>↪ Continue</button>`}
      </div></div>`; })}
    ${d.messages.length > 0 && html`<h3 class="dsec">Messages that appeared</h3>
      ${d.messages.map((m) => html`<div class="drow">
        <div class="dmain">
          <div><span class="badge ${m.tone === 'error' ? 'bad' : m.tone === 'success' ? 'ok' : ''}">${m.kind === 'dialog' ? 'Dialog' : 'Message'}${m.tone !== 'info' ? ` · ${m.tone}` : ''}</span> <bdi data-noi18n>“${m.text}”</bdi></div>
          <div class="small muted">${m.page ? html`on <b data-noi18n>${m.page}</b>` : 'on a page not in the Smart OR'} · ${m.element ? html`in the Smart OR as <span class="mono">${m.element}</span>` : html`not in the Smart OR yet`} · seen in ${m.tests.length} test(s)</div>
        </div>
        <div class="dact">
          ${!m.element && m.page && html`<button class="btn sm" disabled=${busy} onClick=${() => saveMsg(m)}>Save to Smart OR</button>`}
          ${m.page && m.tests.filter((t) => fits(m, t)).slice(0, 3).map((t) => html`<button class="btn sm primary" disabled=${busy} onClick=${() => saveMsg(m, t)}>＋ Expected result of <span data-noi18n>“${t.title.slice(0, 32)}”</span></button>`)}
        </div></div>`)}`}
    ${gen && html`<${GenerateCasesModal} initialPages=${gen} close=${() => { setGen(null); loadState(); }} onEdit=${(pr) => { setGen(null); store.editProposal = pr; go(`#/p/${S.app}/builder`); }} />`}
  </div>`;
}

// ------------------------------------------------------------------ suites
function SuitesModal({ close }) {
  const s = useStore();
  const S = s.S;
  const [list, setList] = useState(() => S.suites.map((x) => ({ ...x, modules: x.modules ?? [], tags: x.tags ?? [], cases: x.cases ?? [] })));
  const modules = [...new Set(S.cases.map((c) => c.module).filter(Boolean))];
  const tags = [...new Set(['@smoke', '@regression', '@positive', '@negative', ...S.cases.flatMap((c) => c.tags)])];
  const upd = (i, patch) => setList(list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const toggle = (i, k, v) => upd(i, { [k]: list[i][k].includes(v) ? list[i][k].filter((x) => x !== v) : [...list[i][k], v] });
  const count = (x) => S.cases.filter((c) => x.cases.includes(c.id) || (c.module && x.modules.includes(c.module)) || c.tags.some((t) => x.tags.includes(t))).length;
  const save = async () => {
    try { await api('/api/suites', { method: 'PUT', body: { app: S.app, suites: list.filter((x) => x.name) } }); toast('Suites saved ✔'); loadState(); close(); }
    catch (e) { toast(e.message); }
  };
  const chips = (i, k, items, label) => html`<div class="small sec" style="margin:8px 0 4px">${label}</div><div class="chips">${items.length ? items.map((v) => { const on = list[i][k].includes(v.id ?? v);
    return html`<span class="chip ${on ? 'on' : ''}" onClick=${() => toggle(i, k, v.id ?? v)}>${on ? '☑' : '☐'} ${v.case ?? v}</span>`; }) : html`<span class="muted small">none yet</span>`}</div>`;
  return html`<${Modal} wide title="⚙ Run suites" onClose=${close}>
    <div class="info">A suite picks test cases by <b>module</b>, <b>tag</b> (also row tags, e.g. @smoke on some rows) or by <b>name</b>. Cases a selected case depends on are added automatically.</div>
    <div style="max-height:60vh;overflow:auto">${list.map((x, i) => html`<div class="outcome">
      <div class="row">
        <${Field} label="Suite name"><input type="text" value=${x.name} placeholder="smoke" onInput=${(e) => upd(i, { name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} /></${Field}>
        <${Field} label="Description" style="flex:2"><input type="text" value=${x.description ?? ''} onInput=${(e) => upd(i, { description: e.target.value })} /></${Field}>
        <div style="flex:0;margin-bottom:10px"><button class="btn sm danger" onClick=${() => setList(list.filter((_, j) => j !== i))}>Remove</button></div>
      </div>
      ${chips(i, 'modules', modules, 'Modules')}${chips(i, 'tags', tags, 'Tags')}${chips(i, 'cases', S.cases, 'Cases')}
      <div class="muted small" style="margin-top:6px">${count(x)} case(s) match (rows by tag counted at run time)</div></div>`)}</div>
    <div class="row between" style="margin-top:12px"><button class="btn" style="flex:0 0 auto" onClick=${() => setList([...list, { name: '', description: '', modules: [], tags: [], cases: [] }])}>＋ New suite</button>
      <button class="btn primary" style="flex:0 0 auto" onClick=${save}>Save suites</button></div>
  </${Modal}>`;
}
