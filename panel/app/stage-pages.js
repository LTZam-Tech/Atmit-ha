// Step ② — Pages: collect elements (one page or many), then review them visually on the screenshot.
import { html, useState, useEffect, useRef } from '/vendor/preact-htm.js';
import { useStore, api, toast, loadState, runBody, startRun, reEsc, waitForJob, store, go } from './core.js';
import { Field, Modal, NextStep, Empty, Console } from './ui.js';
import { Steps } from './stage-builder.js';

const STRATS = ['testid', 'role', 'label', 'placeholder', 'text', 'alt', 'title', 'id', 'css', 'xpath'];
export function locSummary(def) {
  const k = STRATS.find((x) => x in def);
  if (!k) return '';
  const val = (v) => (typeof v === 'object' ? v.en + (v.ar ? ' / ' + v.ar : '') : v);
  return `${k}: ${val(def[k])}${k === 'role' && def.name ? ` "${val(def.name)}"` : ''}`;
}
const rulesText = (r) => (r ? Object.entries(r).map(([k, v]) => (v === true ? k : `${k} ${v}`)).join(', ') : '');

export function StagePages() {
  const s = useStore();
  const S = s.S;
  const [sel, setSel] = useState(() => (S.drafts[0] ? { kind: 'draft', key: S.drafts[0].file } : S.pages[0] ? { kind: 'page', key: S.pages[0].page } : null));
  const [collect, setCollect] = useState(false);
  const [record, setRecord] = useState(false);
  const seenDrafts = useRef(new Set(S.drafts.map((d) => d.file)));
  useEffect(() => {
    const fresh = S.drafts.find((d) => !seenDrafts.current.has(d.file));
    S.drafts.forEach((d) => seenDrafts.current.add(d.file));
    if (fresh) return setSel({ kind: 'draft', key: fresh.file }); // jump to what was just collected
    if (sel?.kind === 'draft' && !S.drafts.some((d) => d.file === sel.key)) setSel(S.drafts[0] ? { kind: 'draft', key: S.drafts[0].file } : S.pages[0] ? { kind: 'page', key: S.pages.at(-1).page } : null);
    if (sel?.kind === 'map') return;
    if (sel?.kind === 'page' && !S.pages.some((p) => p.page === sel.key)) setSel(S.pages[0] ? { kind: 'page', key: S.pages[0].page } : null);
    if (!sel && (S.drafts[0] || S.pages[0])) setSel(S.drafts[0] ? { kind: 'draft', key: S.drafts[0].file } : { kind: 'page', key: S.pages[0].page });
  }, [S]);
  const [check, setCheck] = useState(false);
  const page = sel?.kind === 'page' ? S.pages.find((p) => p.page === sel.key) : null;
  const draft = sel?.kind === 'draft' ? S.drafts.find((d) => d.file === sel.key) : null;

  return html`
    <div class="page-title"><h1>Pages</h1><span class="sub">Collect the elements of each page, then review them on the screenshot</span><span style="flex:1"></span>
      <div class="row start"><a class="btn primary" href=${`#/p/${S.app}/explore`} title="Start from the application's address: pages are scanned and saved as you go, next steps are suggested">🧭 Explore</a><button class="btn" onClick=${() => setCollect(true)}>＋ Collect pages</button>
      <button class="btn" onClick=${() => setRecord(true)}>🎬 Record a journey</button>
      <button class="btn" disabled=${!S.pages.length} onClick=${() => setCheck(true)} title="Open every page by its address and check it becomes ready">🩺 Check pages</button></div></div>
    ${check && html`<${CheckPages} close=${() => setCheck(false)} select=${(k) => { setCheck(false); setSel({ kind: 'page', key: k }); }} />`}
    ${S.drafts.length ? html`<div class="warnbox">${S.drafts.length} collected page(s) waiting for review — check the elements, then <b>Add page</b>.</div>`
      : S.pages.length ? html`<${NextStep} text="Pages ready. Next: set test users, login and shared values." to=${`#/p/${S.app}/data`} label="Data & settings" />` : ''}
    ${S.orError && html`<div class="err">${S.orError}</div>`}
    <div class="pages-layout">
      <div class="plist">
        <div class="pi ${sel?.kind === 'map' ? 'on' : ''}" onClick=${() => setSel({ kind: 'map' })}><b>🗺 Navigation map</b>
          <div class="muted small">${S.routes.length} route(s)${S.navIssues.length ? ' · ⚠ ' + S.navIssues.length + ' issue(s)' : ''}</div></div>
        ${S.drafts.length > 0 && html`<div class="small muted" style="margin:0 0 6px">To review</div>
          ${S.drafts.map((d) => html`<div class="pi ${sel?.key === d.file ? 'on' : ''}" onClick=${() => setSel({ kind: 'draft', key: d.file })}>
            <b>${d.page}</b> <span class="badge warn">draft</span><div class="muted small">${d.url} · ${d.elements.length} elements</div></div>`)}
          <div class="small muted" style="margin:12px 0 6px">Pages</div>`}
        ${S.pages.map((p) => html`<div class="pi ${sel?.key === p.page ? 'on' : ''}" onClick=${() => setSel({ kind: 'page', key: p.page })}>
          <b>${p.page}</b> <span class="badge ${p.auth !== 'none' ? 'auth' : ''}">${p.auth === 'none' ? 'logged out' : p.auth}</span>
          <div class="muted small">${p.url} · ${p.elements.length} elements</div></div>`)}
        ${!S.pages.length && !S.drafts.length && html`<${Empty}>No pages yet.<br /><br /><button class="btn primary sm" onClick=${() => setCollect(true)}>Collect the first page</button></${Empty}>`}
      </div>
      <div>
        ${page && html`<${PageView} key=${'p' + page.page} page=${page} />`}
        ${draft && html`<${DraftView} key=${'d' + draft.file} draft=${draft} />`}
        ${sel?.kind === 'map' && html`<${MapView} />`}
      </div>
    </div>
    ${collect && html`<${CollectModal} onClose=${() => setCollect(false)} />`}
    ${record && html`<${RecordModal} onClose=${(open) => { setRecord(false); if (open) setSel({ kind: 'page', key: open }); }} />`}`;
}

// ------------------------------------------------------------------ collect
function CollectModal({ onClose }) {
  const s = useStore();
  const S = s.S;
  const [mode, setMode] = useState('one');
  const [one, setOne] = useState({ page: '', path: '/', auth: S.users[0] ?? 'none' });
  const [many, setMany] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState([]);
  const camel = (x) => x.replace(/[^a-zA-Z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : '')).replace(/^[A-Z]/, (c) => c.toLowerCase());
  const run = async (list) => {
    setBusy(true); setProgress([]);
    for (const it of list) {
      if (!/^[a-z][a-zA-Z0-9]*$/.test(it.page)) { toast(`"${it.page}" — page names are camelCase, e.g. patientForm`); break; }
      setProgress((p) => [...p, `⏳ ${it.page} ← ${it.path}`]);
      try {
        const done = waitForJob();
        await api('/api/harvest', { method: 'POST', body: runBody({ page: it.page, path: it.path, auth: it.auth }) });
        const d = await done;
        setProgress((p) => [...p.slice(0, -1), `${d.code === 0 ? '✔' : '✖'} ${it.page} ← ${it.path}`]);
      } catch (e) { setProgress((p) => [...p.slice(0, -1), `✖ ${it.page}: ${e.message}`]); }
    }
    setBusy(false);
    await loadState();
  };
  const parseMany = () => many.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [a, b] = l.split(/\s+/);
    return b ? { page: camel(a), path: b, auth: one.auth } : { page: camel(a.replace(/^https?:\/\/[^/]+/, '').replace(/\//g, ' ').trim() || 'home'), path: a, auth: one.auth };
  });
  return html`<${Modal} title="Collect pages" onClose=${onClose}>
    <div class="tabs"><button class="tab ${mode === 'one' ? 'active' : ''}" onClick=${() => setMode('one')}>One page</button><button class="tab ${mode === 'many' ? 'active' : ''}" onClick=${() => setMode('many')}>Several pages</button><button class="tab" disabled title="Phase 2">🎬 Record a journey <span class="n">soon</span></button></div>
    <div class="info">The tool opens each page, collects every field, button, link and message with the best locator, detects what each field means (email, phone, date…) and its rules (required, max length…), and takes a screenshot.</div>
    ${mode === 'one' ? html`<div class="row">
        <${Field} label="Page name (camelCase)"><input type="text" value=${one.page} onInput=${(e) => setOne({ ...one, page: e.target.value })} placeholder="patientForm" /></${Field}>
        <${Field} label="Path or full URL" style="flex:2"><input type="text" value=${one.path} onInput=${(e) => setOne({ ...one, path: e.target.value })} placeholder="/patients/new" /></${Field}></div>`
      : html`<${Field} label="One page per line:  name  /path   (or just the path)" hint="Example:  patientList /patients    ·    patientForm /patients/new">
        <textarea rows="6" value=${many} onInput=${(e) => setMany(e.target.value)} placeholder="patientList /patients\npatientForm /patients/new"></textarea></${Field}>`}
    <${Field} label="Open the page(s) as"><select value=${one.auth} onChange=${(e) => setOne({ ...one, auth: e.target.value })}>
      <option value="none">logged out</option>${S.users.map((u) => html`<option value=${u}>logged in as ${u}</option>`)}</select></${Field}>
    ${progress.length > 0 && html`<pre class="console mini">${progress.join('\n')}</pre>`}
    <div class="row between" style="margin-top:12px"><span class="muted small">${busy ? 'Collecting… this takes a few seconds per page' : ''}</span>
      <button class="btn primary" style="flex:0" disabled=${busy || store.running} onClick=${() => run(mode === 'one' ? [one] : parseMany())}>${busy ? html`<span class="spin"></span>` : 'Collect'}</button></div>
    ${!busy && progress.length > 0 && html`<div class="row between"><span></span><button class="btn" style="flex:0" onClick=${onClose}>Review collected pages →</button></div>`}
  </${Modal}>`;
}

// ------------------------------------------------------------------ visual
function Visual({ src, map, names, hot, onPick }) {
  const img = useRef(null);
  const [scale, setScale] = useState(0);
  const fit = () => img.current && map && setScale(img.current.clientWidth / map.width);
  useEffect(() => { window.addEventListener('resize', fit); return () => window.removeEventListener('resize', fit); }, [map]);
  useEffect(() => {
    if (!hot || !scale) return;
    const el = img.current?.parentElement?.querySelector('.bx.hot');
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [hot, scale]);
  if (!map) return html`<div class="vis"><${Empty}>No screenshot yet — press <b>Refresh screenshot</b>.</${Empty}></div>`;
  return html`<div class="vis">
    <img ref=${img} src=${src} onLoad=${fit} alt="page screenshot" />
    ${scale > 0 && names.map((n, i) => {
      const b = map.boxes[n];
      if (!b) return null;
      return html`<div class="bx ${hot === n ? 'hot' : ''}" title=${n} onClick=${() => onPick(n)}
        style=${`left:${b.x * scale}px;top:${b.y * scale}px;width:${Math.max(6, b.w * scale)}px;height:${Math.max(6, b.h * scale)}px`}><span>${i + 1}</span></div>`;
    })}
  </div>`;
}

function useVisual(url) {
  const [map, setMap] = useState(null);
  const [v, setV] = useState(Date.now());
  useEffect(() => { fetch(url + '.json?t=' + v).then((r) => (r.ok ? r.json() : null)).then(setMap).catch(() => setMap(null)); }, [url, v]);
  return [map, url + '.png?t=' + v, () => setV(Date.now())];
}

function PageView({ page }) {
  const s = useStore();
  const S = s.S;
  const [map, src, reload] = useVisual(`/visual/${S.app}/${page.page}`);
  const [hot, setHot] = useState(null);
  const [setup, setSetup] = useState(false);
  const [check, setCheck] = useState(null);
  const names = page.elements.map((e) => e.name);
  const el = page.elements.find((e) => e.name === hot);

  const capture = async () => {
    try { const done = waitForJob(); await api(`/api/pages/${page.page}/capture`, { method: 'POST', body: runBody() }); await done; reload(); }
    catch (e) { toast(e.message); }
  };
  const recollect = async () => {
    try { const done = waitForJob(); await api('/api/harvest', { method: 'POST', body: runBody({ page: page.page, path: page.url, auth: page.auth }) }); await done; await loadState(); toast('Collected again — review the draft, then Add page (the old version is kept as a backup)'); }
    catch (e) { toast(e.message); }
  };
  const doCheck = async (name) => {
    setCheck({ name, loading: true });
    try { setCheck({ name, ...(await api(`/api/pages/${page.page}/elements/${name}/check`, { method: 'POST', body: runBody() })) }); }
    catch (e) { setCheck({ name, ok: false, error: e.message }); }
  };
  const rename = async (name) => {
    const to = prompt(`New name for "${name}" (camelCase). Test cases using it are updated automatically.`, name);
    if (!to || to === name) return;
    try { const r = await api(`/api/pages/${page.page}/elements/${name}`, { method: 'PATCH', body: { app: S.app, to } }); toast(`Renamed ✔ — ${r.casesUpdated} case file(s) updated`); setHot(to); await loadState(); reload(); }
    catch (e) { toast(e.message); }
  };
  const remove = async (name) => {
    if (!confirm(`Remove "${name}" from ${page.page}?`)) return;
    try { await api(`/api/pages/${page.page}/elements/${name}?app=${S.app}`, { method: 'DELETE' }); toast('Removed'); setHot(null); loadState(); }
    catch (e) { toast(e.message); }
  };

  return html`<div>
    <div class="card" style="padding:12px 16px">
      <div class="row between">
        <div><b style="font-size:16px">${page.page}</b> <span class="muted small">${page.url} · ${page.elements.length} elements · ${page.auth === 'none' ? 'starts logged out' : 'starts as ' + page.auth}${page.readyWhen ? ' · ready when ' + page.readyWhen : ''}${page.open === 'navigate' ? ' · opened by navigation' : ''}</span></div>
        <div class="row start">
          <button class="btn sm" disabled=${s.running} onClick=${() => api(`/api/pages/${page.page}/open`, { method: 'POST', body: runBody() }).then(() => toast('Opening the browser on your computer…')).catch((e) => toast(e.message))}>🌐 Open in browser</button>
          <button class="btn sm" disabled=${s.running} onClick=${capture}>${s.running?.label?.includes('screenshot') ? html`<span class="spin"></span>` : '📷'} Refresh screenshot</button>
          <button class="btn sm" disabled=${s.running} onClick=${recollect}>↻ Collect again</button>
          <button class="btn sm" onClick=${() => setSetup(!setup)}>⚙ Start setup</button>
          <button class="btn sm" disabled=${s.running} onClick=${() => startRun({ grep: page.tags.map((t) => reEsc(t) + '(?: |$)').join('|'), label: `page ${page.page}` })}>▶ Run page tests</button>
        </div>
      </div>
      ${setup && html`<${PageSetup} page=${page} onDone=${() => setSetup(false)} />`}
    </div>
    <div class="review">
      <${Visual} src=${src} map=${map} names=${names} hot=${hot} onPick=${setHot} />
      <div class="card elist" style="margin:0">
        <table><tr><th>#</th><th>Element</th><th>Kind</th><th></th></tr>
          ${page.elements.map((e, i) => html`<tr class="clickable ${hot === e.name ? 'sel' : ''}" onClick=${() => setHot(e.name)}>
            <td><span class="n">${i + 1}</span></td>
            <td><b>${e.name}</b>${e.params.length ? html` <span class="badge">needs ${e.params.join(', ')}</span>` : ''}${map && !map.boxes[e.name] && !e.params.length ? html` <span class="badge" title="Not visible on the screenshot">hidden</span>` : ''}
              <div class="small muted mono" style="overflow-wrap:anywhere">${locSummary(e.def)}${e.def.fallback?.length ? ` · +${e.def.fallback.length} backup` : ''}</div></td>
            <td class="small">${e.def.control ?? ''}${e.def.semantic ? html` · <b>${e.def.semantic}</b>` : ''}${e.def.rules ? html`<div class="muted">${rulesText(e.def.rules)}</div>` : ''}</td>
            <td style="white-space:nowrap"><button class="btn icon" disabled=${e.params.length || s.running} onClick=${(x) => { x.stopPropagation(); doCheck(e.name); }}>Check</button></td></tr>`)}
        </table>
        ${el && html`<${ElementEditor} key=${el.name} page=${page} el=${el} onRename=${() => rename(el.name)} onRemove=${() => remove(el.name)} />`}
      </div>
    </div>
    ${check && html`<${Modal} title=${`Check ${page.page}.${check.name}`} onClose=${() => setCheck(null)}>
      ${check.loading ? html`<${Empty}><span class="spin"></span> Opening the page…</${Empty}>` : html`
        ${check.found ? html`<div class="okbox">✔ Found${check.visible ? ' and visible' : ' (not visible)'}${check.healed ? html` — <b>by a backup locator</b>; the main one matched ${check.primaryCount} element(s). Collect the page again.` : ''}. Highlighted in red.</div>`
          : html`<div class="err">✖ ${check.error || 'Not found'}</div>`}
        ${check.screenshot && html`<img class="shot" src=${check.screenshot} />`}`}
    </${Modal}>`}
  </div>`;
}

function ElementEditor({ page, el, onRename, onRemove }) {
  const s = useStore();
  const S = s.S;
  const [m, setM] = useState({ control: el.def.control ?? '', semantic: el.def.semantic ?? '', format: el.def.format ?? '', rules: { ...(el.def.rules ?? {}) } });
  const setRule = (k, v) => setM({ ...m, rules: { ...m.rules, [k]: v } });
  const save = async () => {
    const rules = { ...m.rules };
    for (const k of ['maxlength', 'minlength']) if (rules[k] !== undefined && rules[k] !== '') rules[k] = Number(rules[k]);
    try { await api(`/api/pages/${page.page}/elements/${el.name}`, { method: 'PATCH', body: { app: S.app, meta: { ...m, rules } } }); toast('Saved ✔'); loadState(); }
    catch (e) { toast(e.message); }
  };
  const isInput = ['textbox', 'textarea', 'password', 'datepicker', 'select', ''].includes(m.control);
  return html`<div class="meta-edit">
    <div class="row between"><b>${el.name}</b><div class="row start"><button class="btn sm" onClick=${onRename}>Rename</button><button class="btn sm danger" onClick=${onRemove}>Remove</button></div></div>
    <div class="small muted" style="margin:4px 0 8px">Found by <code>${locSummary(el.def)}</code>${(el.def.fallback ?? []).map((f) => html` · backup <code>${locSummary(f)}</code>`)}${el.def.within ? html` · inside <b>${el.def.within}</b>` : ''}</div>
    <div class="row">
      <${Field} label="Kind"><select value=${m.control} onChange=${(e) => setM({ ...m, control: e.target.value })}><option value="">—</option>${S.controls.map((c) => html`<option value=${c}>${c}</option>`)}</select></${Field}>
      ${isInput && html`<${Field} label="Meaning" hint="Drives generated data and negative cases"><select value=${m.semantic} onChange=${(e) => setM({ ...m, semantic: e.target.value })}><option value="">—</option>${S.semantics.map((c) => html`<option value=${c}>${c}</option>`)}</select></${Field}>`}
    </div>
    ${isInput && html`<div class="row">
      <label class="check" style="flex:0 0 auto"><input type="checkbox" checked=${!!m.rules.required} onChange=${(e) => setRule('required', e.target.checked)} /> Required</label>
      <${Field} label="Min length"><input type="number" value=${m.rules.minlength ?? ''} onInput=${(e) => setRule('minlength', e.target.value)} /></${Field}>
      <${Field} label="Max length"><input type="number" value=${m.rules.maxlength ?? ''} onInput=${(e) => setRule('maxlength', e.target.value)} /></${Field}>
      <${Field} label="Min"><input type="text" value=${m.rules.min ?? ''} onInput=${(e) => setRule('min', e.target.value)} /></${Field}>
      <${Field} label="Max"><input type="text" value=${m.rules.max ?? ''} onInput=${(e) => setRule('max', e.target.value)} /></${Field}>
    </div>
    ${(m.control === 'datepicker' || m.semantic === 'date') && html`<div class="row">
      <${Field} label="Date format" hint="How the page writes dates: dd/MM/yyyy, MM/dd/yyyy, yyyy-MM-dd…"><input type="text" placeholder="dd/MM/yyyy" value=${m.format} onInput=${(e) => setM({ ...m, format: e.target.value })} /></${Field}>
      <label class="check" style="flex:0 0 auto"><input type="checkbox" checked=${!!m.rules.readonly} onChange=${(e) => setRule('readonly', e.target.checked)} /> Read-only (pick from calendar)</label></div>`}
    <${Field} label="Pattern (regex)"><input type="text" value=${m.rules.pattern ?? ''} onInput=${(e) => setRule('pattern', e.target.value)} /></${Field}>`}
    <button class="btn primary sm" onClick=${save}>Save element</button>
  </div>`;
}

function PageSetup({ page, onDone }) {
  const s = useStore();
  const S = s.S;
  const [v, setV] = useState({ url: page.url, auth: page.auth, readyWhen: page.readyWhen, tags: page.tags.join(', '), description: page.description, open: page.open });
  const route = v.open === 'navigate' ? findRoute(page.page, S.routes, S.pages) : null;
  const save = async () => {
    try { await api('/api/pages/' + page.page, { method: 'PUT', body: { app: S.app, ...v, tags: v.tags.split(',').map((x) => x.trim()).filter(Boolean) } }); toast('Saved ✔'); await loadState(); onDone(); }
    catch (e) { toast(e.message); }
  };
  return html`<div class="meta-edit">
    <div class="row">
      <${Field} label="Start URL"><input type="text" value=${v.url} onInput=${(e) => setV({ ...v, url: e.target.value })} /></${Field}>
      <${Field} label="Tests on this page start"><select value=${v.auth} onChange=${(e) => setV({ ...v, auth: e.target.value })}><option value="none">logged out</option>${S.users.map((u) => html`<option value=${u}>logged in as ${u}</option>`)}</select></${Field}>
      <${Field} label="Page is ready when visible"><select value=${v.readyWhen} onChange=${(e) => setV({ ...v, readyWhen: e.target.value })}><option value="">—</option>${page.elements.map((e) => html`<option value=${e.name}>${e.name}</option>`)}</select></${Field}>
    </div>
    <div class="row">
      <${Field} label="Tests reach this page by"><select value=${v.open} onChange=${(e) => setV({ ...v, open: e.target.value })}>
        <option value="url">opening its URL directly</option><option value="navigate">navigating from another page (menus, buttons)</option></select></${Field}>
      <div style="flex:2;margin-bottom:10px">${v.open === 'navigate' && (route ? html`<div class="okbox" style="margin:0">Route: <b>${[route.start, ...route.edges.map((e) => e.to)].join(' → ')}</b></div>`
        : html`<div class="warnbox" style="margin:0">No route reaches this page yet — add one in 🗺 Navigation map or record a journey.</div>`)}</div>
    </div>
    <div class="row"><${Field} label="Tags"><input type="text" value=${v.tags} onInput=${(e) => setV({ ...v, tags: e.target.value })} /></${Field}>
      <${Field} label="Description" style="flex:2"><input type="text" value=${v.description} onInput=${(e) => setV({ ...v, description: e.target.value })} /></${Field}></div>
    <button class="btn primary sm" onClick=${save}>Save start setup</button>
  </div>`;
}

function DraftView({ draft }) {
  const s = useStore();
  const S = s.S;
  const base = draft.file.replace(/\.page\.yml$/, '');
  const [map, src] = useVisual(`/visual/${S.app}/drafts/${base}.visual`);
  const [hot, setHot] = useState(null);
  const exists = S.pages.some((p) => p.page === draft.page);
  const add = async () => {
    try { await api('/api/drafts/promote', { method: 'POST', body: { app: S.app, file: draft.file } }); toast(`Page "${draft.page}" added ✔`); loadState(); }
    catch (e) { toast(e.message); }
  };
  const discard = async () => { await api(`/api/drafts?app=${S.app}&file=${encodeURIComponent(draft.file)}`, { method: 'DELETE' }); loadState(); };
  const entries = Object.entries(draft.defs);
  return html`<div>
    <div class="card" style="padding:12px 16px">
      <div class="row between">
        <div><b style="font-size:16px">${draft.page}</b> <span class="badge warn">draft</span> <span class="muted small">${draft.url} · ${entries.length} elements collected</span></div>
        <div class="row start"><button class="btn danger sm" onClick=${discard}>Discard</button><button class="btn primary sm" onClick=${add}>${exists ? 'Replace page (keeps a backup)' : 'Add page'}</button></div>
      </div>
      <div class="hint">Check the boxes on the screenshot. Rename and fine-tune elements after adding the page.</div>
    </div>
    <div class="review">
      <${Visual} src=${src} map=${map} names=${entries.map(([n]) => n)} hot=${hot} onPick=${setHot} />
      <div class="card elist" style="margin:0"><table><tr><th>#</th><th>Element</th><th>Kind</th></tr>
        ${entries.map(([n, d], i) => html`<tr class="clickable ${hot === n ? 'sel' : ''}" onClick=${() => setHot(n)}>
          <td><span class="n">${i + 1}</span></td><td><b>${n}</b><div class="small muted mono" style="overflow-wrap:anywhere">${locSummary(d)}</div></td>
          <td class="small">${d.control ?? ''}${d.semantic ? html` · <b>${d.semantic}</b>` : ''}${d.rules ? html`<div class="muted">${rulesText(d.rules)}</div>` : ''}</td></tr>`)}
      </table></div>
    </div>
  </div>`;
}


// ------------------------------------------------------------------ navigation helpers
export function findRoute(target, routes, pages) {
  const starts = pages.filter((p) => p.open !== 'navigate').map((p) => p.page);
  const queue = starts.map((p) => ({ page: p, path: [] }));
  const seen = new Set(starts);
  while (queue.length) {
    const { page, path } = queue.shift();
    for (const e of routes.filter((x) => x.from === page)) {
      if (e.to === target) return { start: (path[0] ?? e).from, edges: [...path, e] };
      if (!seen.has(e.to)) { seen.add(e.to); queue.push({ page: e.to, path: [...path, e] }); }
    }
  }
  return null;
}
const stepText = (st) => {
  const t = st.element ?? st.page ?? st.url ?? '';
  return `${st.action} ${t}${st.value !== undefined && st.action !== 'press' ? ` = "${String(st.value).replace(/\{\{user\.\w+\.password\}\}/, '••••')}"` : st.value ? ` ${st.value}` : ''}`;
};

// ------------------------------------------------------------------ record a journey
function RecordModal({ onClose }) {
  const s = useStore();
  const S = s.S;
  const firstLogin = S.login?.page ? S.pages.find((p) => p.page === S.login.page) : null;
  const [v, setV] = useState({ name: '', start: firstLogin?.url ?? S.pages[0]?.url ?? '/', auth: 'none', locale: S.languages[0] ?? 'en' });
  const [phase, setPhase] = useState('form');
  useEffect(() => { if (phase === 'recording' && s.lastRecord) setPhase('done'); }, [s.lastRecord, phase]);
  const start = async () => {
    if (!v.name.trim()) return toast('Give the journey a name, e.g. "Create a patient"');
    store.set({ log: [], lastRecord: null });
    try { await api('/api/record', { method: 'POST', body: { ...runBody(), ...v } }); setPhase('recording'); }
    catch (e) { toast(e.message); }
  };
  const r = s.lastRecord;
  return html`<${Modal} wide title="🎬 Record a journey" onClose=${() => phase !== 'recording' && onClose()}>
    ${phase === 'form' && html`<div>
      <div class="info">A real browser opens on <b>your computer</b>. Use the application normally — every page you visit is collected with its elements and screenshot, every click and typed value becomes a step, and the moves between pages become navigation routes.
        A small toolbar in the browser lets you <b>✓ add a check</b>, <b>💾 save a value</b> (e.g. a new order number) and <b>🏷 name the page</b>. Press <b>■ Stop</b> when you are done.</div>
      <div class="row"><${Field} label="Journey name" style="flex:2"><input type="text" value=${v.name} onInput=${(e) => setV({ ...v, name: e.target.value })} placeholder="Create a patient" /></${Field}>
        <${Field} label="Start at (path)"><input type="text" value=${v.start} onInput=${(e) => setV({ ...v, start: e.target.value })} /></${Field}></div>
      <div class="row"><${Field} label="Start as"><select value=${v.auth} onChange=${(e) => setV({ ...v, auth: e.target.value })}><option value="none">logged out (record the login too)</option>${S.users.map((u) => html`<option value=${u}>logged in as ${u}</option>`)}</select></${Field}>
        <${Field} label="Language"><select value=${v.locale} onChange=${(e) => setV({ ...v, locale: e.target.value })}>${S.languages.map((l) => html`<option value=${l}>${l === 'ar' ? 'العربية' : 'English'}</option>`)}</select></${Field}></div>
      <div class="row between" style="margin-top:8px"><span class="muted small">Typed passwords that match a test user are saved as {{user.&lt;key&gt;.password}}, never as text.</span>
        <button class="btn primary" style="flex:0" disabled=${!!s.running} onClick=${start}>● Start recording</button></div>
    </div>`}
    ${phase === 'recording' && html`<div>
      <div class="warnbox">● Recording — use the browser window that opened. Steps appear below as you work.</div>
      <${Console} mini />
      <div class="row between" style="margin-top:10px"><span class="muted small">You can also press ■ Stop in the browser toolbar, or close the browser.</span>
        <button class="btn danger" style="flex:0" onClick=${() => api('/api/record/stop', { method: 'POST' })}>■ Stop & save</button></div>
    </div>`}
    ${phase === 'done' && html`<div>
      ${r?.ok ? html`<div class="okbox" style="font-size:14px">✔ Journey "<b>${r.journey}</b>" saved — ${r.steps} step(s)</div>
        <ul class="sec">
          ${r.caseFile && html`<li>Test case <span class="code">cases/${r.caseFile}</span> with one positive data row</li>`}
          ${r.newPages?.length > 0 && html`<li>New page(s): <b>${r.newPages.join(', ')}</b> — with elements and screenshots</li>`}
          ${r.updatedPages?.length > 0 && html`<li>New elements added to: ${r.updatedPages.join(', ')}</li>`}
          ${r.routes > 0 && html`<li>${r.routes} navigation route(s) added to the map</li>`}
        </ul>
        <div class="row start" style="margin-top:12px">
          ${r.caseFile && html`<button class="btn primary" onClick=${() => { store.openCase = r.caseFile; onClose(); go(`#/p/${S.app}/builder`); }}>Open the test case →</button>`}
          ${r.newPages?.length > 0 && html`<button class="btn" onClick=${() => onClose(r.newPages[0])}>Review new pages</button>`}
          <button class="btn" onClick=${() => onClose()}>Close</button>
        </div>` : html`<div class="err">${r?.error ?? 'Recording failed — see the log.'}</div><${Console} mini /><button class="btn" onClick=${() => onClose()}>Close</button>`}
    </div>`}
  </${Modal}>`;
}

// ------------------------------------------------------------------ navigation map
function MapView() {
  const s = useStore();
  const S = s.S;
  const [routes, setRoutes] = useState(() => JSON.parse(JSON.stringify(S.routes)));
  const [selE, setSelE] = useState(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (!dirty) setRoutes(JSON.parse(JSON.stringify(S.routes))); }, [S.routes]);
  const pages = S.pages.map((p) => p.page);
  // layout: columns by distance from pages that nothing points to
  const incoming = new Set(routes.map((e) => e.to));
  const level = {};
  const roots = pages.filter((p) => !incoming.has(p));
  const queue = (roots.length ? roots : pages.slice(0, 1)).map((p) => { level[p] = 0; return p; });
  while (queue.length) { const p = queue.shift(); for (const e of routes.filter((x) => x.from === p)) if (level[e.to] === undefined) { level[e.to] = level[p] + 1; queue.push(e.to); } }
  pages.forEach((p) => { if (level[p] === undefined) level[p] = 0; });
  const cols = {};
  pages.forEach((p) => (cols[level[p]] ||= []).push(p));
  const W = 160, H = 46, GX = 110, GY = 34, PAD = 20;
  const pos = {};
  Object.entries(cols).forEach(([l, list]) => list.forEach((p, i) => (pos[p] = { x: PAD + Number(l) * (W + GX), y: PAD + i * (H + GY) })));
  const width = PAD * 2 + (Math.max(...Object.keys(cols).map(Number), 0) + 1) * (W + GX) - GX;
  const height = PAD * 2 + Math.max(...Object.values(cols).map((l) => l.length), 1) * (H + GY) - GY;
  const pageOf = (k) => S.pages.find((p) => p.page === k);
  const save = async () => {
    try { const r = await api('/api/navigation', { method: 'PUT', body: { app: S.app, edges: routes } }); setDirty(false); toast(r.issues.length ? `Saved with ${r.issues.length} issue(s)` : 'Navigation map saved ✔'); loadState(); }
    catch (e) { toast(e.message); }
  };
  const edit = (i, patch) => { setRoutes(routes.map((e, j) => (j === i ? { ...e, ...patch } : e))); setDirty(true); };
  return html`<div>
    <div class="card">
      <h2>🗺 Navigation map <span class="grow"></span><span class="muted small">How tests move between pages. Pages marked ↪ open only through navigation.</span></h2>
      ${S.navIssues.length > 0 && html`<div class="err">${S.navIssues.join('\n')}</div>`}
      <div style="overflow:auto;border:1px solid var(--border);border-radius:10px;background:var(--chip)">
        <svg width=${Math.max(width, 300)} height=${Math.max(height, 120)} style="display:block">
          <defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--sec)" /></marker></defs>
          ${routes.map((e, i) => {
            const a = pos[e.from], b = pos[e.to];
            if (!a || !b) return null;
            const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
            const back = x2 <= x1;
            const d = back ? `M${a.x + W / 2},${a.y + H} C${a.x + W / 2},${a.y + H + 40} ${b.x + W / 2},${b.y + H + 40} ${b.x + W / 2},${b.y + H}`
              : `M${x1},${y1} C${x1 + GX / 2},${y1} ${x2 - GX / 2},${y2} ${x2},${y2}`;
            return html`<g style="cursor:pointer" onClick=${() => setSelE(i)}>
              <path d=${d} fill="none" stroke=${selE === i ? 'var(--accent)' : 'var(--sec)'} stroke-width=${selE === i ? 2.5 : 1.5} marker-end="url(#arr)" />
              <path d=${d} fill="none" stroke="transparent" stroke-width="14"><title>${e.steps.map(stepText).join('\n')}</title></path></g>`;
          })}
          ${pages.map((p) => { const pg = pageOf(p), q = pos[p]; return html`<g>
            <rect x=${q.x} y=${q.y} width=${W} height=${H} rx="9" fill="var(--card)" stroke=${pg.open === 'navigate' ? 'var(--accent)' : 'var(--border)'} stroke-width="1.5" />
            <text x=${q.x + 12} y=${q.y + 20} font-size="13" font-weight="700" fill="var(--text)">${pg.open === 'navigate' ? '↪ ' : ''}${p}</text>
            <text x=${q.x + 12} y=${q.y + 36} font-size="11" fill="var(--muted)">${pg.url.length > 22 ? pg.url.slice(0, 21) + '…' : pg.url}</text></g>`; })}
        </svg>
      </div>
    </div>
    <div class="card">
      <h2>Routes <span class="grow"></span><button class="btn sm" onClick=${() => { setRoutes([...routes, { from: pages[0], to: pages[1] ?? pages[0], steps: [{ action: 'click' }] }]); setSelE(routes.length); setDirty(true); }}>＋ Add route</button>
        <button class="btn primary sm" disabled=${!dirty} onClick=${save}>Save map</button></h2>
      <table><tr><th>From</th><th>To</th><th>Steps</th><th></th></tr>
        ${routes.map((e, i) => html`<tr class="clickable ${selE === i ? 'sel' : ''}" onClick=${() => setSelE(i)}>
          <td><b>${e.from}</b></td><td><b>${e.to}</b></td><td class="small mono">${e.steps.map(stepText).join(' → ')}</td>
          <td><button class="btn icon danger" onClick=${(x) => { x.stopPropagation(); setRoutes(routes.filter((_, j) => j !== i)); setSelE(null); setDirty(true); }}>✕</button></td></tr>`)}
      </table>
      ${!routes.length && html`<div class="muted small" style="padding:10px 0">No routes yet — record a journey or add one.</div>`}
      ${selE !== null && routes[selE] && html`<div class="meta-edit">
        <div class="row"><${Field} label="From page"><select value=${routes[selE].from} onChange=${(e) => edit(selE, { from: e.target.value })}>${pages.map((p) => html`<option value=${p}>${p}</option>`)}</select></${Field}>
          <${Field} label="To page"><select value=${routes[selE].to} onChange=${(e) => edit(selE, { to: e.target.value })}>${pages.map((p) => html`<option value=${p}>${p}</option>`)}</select></${Field}></div>
        <div class="small sec" style="margin-bottom:6px">Steps done on "${routes[selE].from}" that lead to "${routes[selE].to}"</div>
        <${Steps} steps=${routes[selE].steps} onChange=${(st) => edit(selE, { steps: st })} defAction="click" />
      </div>`}
    </div>
  </div>`;
}

/** 🩺 every page opened by its address: does it become ready? */
function CheckPages({ close, select }) {
  const s = useStore();
  const S = s.S;
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const run = () => { setRes(null); setErr(''); api('/api/pages/check', { method: 'POST', body: { app: S.app, env: runBody().env } }).then((r) => setRes(r.results)).catch((e) => setErr(e.message)); };
  useEffect(run, []);
  const useReady = async (r) => {
    try { await api('/api/pages/ready', { method: 'POST', body: { app: S.app, page: r.page, readyWhen: r.fix } }); toast(`${r.page}: ready when "${r.fix}" is visible`); loadState(); run(); }
    catch (e) { toast(e.message); }
  };
  return html`<${Modal} wide title="🩺 Check pages" onClose=${close}>
    <div class="muted small" style="margin-bottom:10px">Each page is opened by its address, with the session it starts with, and must show its "ready when" element. Tests open pages this way.</div>
    ${err && html`<div class="err">${err}</div>`}
    ${!res && !err ? html`<${Empty}><span class="spin"></span> Opening ${S.pages.length} page(s)…</${Empty}>` : res && html`<table>
      <tr><th>Page</th><th>Address</th><th>Result</th><th></th></tr>
      ${res.map((r) => html`<tr>
        <td><b data-noi18n>${r.page}</b></td><td class="mono small">${r.url}</td>
        <td>${r.ok === true ? html`<span class="res ok">✔ ready</span>` : r.ok === null ? html`<span class="muted small">${r.reason}</span>` : html`<span class="res bad">✖ not ready</span><div class="small">${r.reason}</div>`}</td>
        <td style="white-space:nowrap">${r.fix && html`<button class="btn sm primary" onClick=${() => useReady(r)}>Use <span data-noi18n>“${r.fix}”</span></button> `}${r.ok === false && html`<button class="btn sm" onClick=${() => select(r.page)}>Open page</button>`}</td></tr>`)}
    </table>`}
    <div class="row between" style="margin-top:12px"><span class="muted small">${res ? `${res.filter((r) => r.ok === true).length}/${res.length} ready` : ''}</span><button class="btn" style="flex:0 0 auto" disabled=${!res} onClick=${run}>Check again</button></div>
  </${Modal}>`;
}
