// 🧭 Explore — start from the application's address; every page is scanned (and saved to the Smart OR when new),
// next steps are suggested from its elements, each step runs in the same browser session, and the journey
// is drawn as a chain of pages. Save it as a workflow, or generate test cases for any page on the way.
import { html, useState, useEffect, useRef } from '/vendor/preact-htm.js';
import { useStore, store, api, toast, loadState, go, runSettings } from './core.js';
import { Field, Empty } from './ui.js';
import { GenerateCasesModal } from './stage-builder.js';

const KIND = { login: '🔑', form: '📝', click: '👉', probe: '🧪', pick: '📅' };

export function StageExplore() {
  const s = useStore();
  const S = s.S;
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const lastError = useRef('');
  useEffect(() => {
    // "Explore from here" (Runs → What the run found): start at that page, continuing the test that reached it
    if (store.exploreFrom) {
      const f = store.exploreFrom; store.exploreFrom = null;
      setSt({ running: false });
      call('start', { url: f.url, user: f.user, after: f.after, env: runSettings().env || undefined }, 'start').then((r) => { if (!r) setErr(lastError.current); });
      return;
    }
    api('/api/explore').then(setSt).catch(() => setSt({ running: false }));
  }, []);
  const call = async (path, body, label) => {
    setBusy(label);
    try { const r = await api(`/api/explore/${path}`, { method: 'POST', body: { app: S.app, ...body } }); setSt(r); loadState(); return r; }
    catch (e) { lastError.current = e.message; if (path !== 'start') toast(e.message); return null; }
    finally { setBusy(''); }
  };
  const live = st?.running && st.app === S.app;
  return html`
    <div class="page-title"><h1>Explore</h1><span class="sub">Walk through the application — the tool learns each page and suggests the next step</span>
      <span style="flex:1"></span>${live && html`<button class="btn" onClick=${() => call('stop', {}, 'stop')}>■ Stop</button>`}</div>
    ${!st ? html`<${Empty}><span class="spin"></span></${Empty}>` : !live ? html`<${Start} busy=${busy} error=${err} onStart=${async (b) => { setErr(''); const r = await call('start', b, 'start'); if (!r) setErr(lastError.current); }} />` : html`<${Live} st=${st} busy=${busy} call=${call} />`}`;
}

function Start({ busy, onStart, error }) {
  const s = useStore();
  const S = s.S;
  const run = runSettings();
  const firstEnv = S.envs.includes(run.env) ? run.env : S.settings?.defaultEnv || S.envs[0];
  const [env, setEnv] = useState(firstEnv);
  const [url, setUrl] = useState(S.baseURLs[firstEnv] ?? '');
  const [login, setLogin] = useState('');
  const [headed, setHeaded] = useState(false);
  const saved = S.savedLogins ?? [];
  const pickEnv = (e) => { setEnv(e); setUrl(S.baseURLs[e] ?? ''); };
  const step = (n, title, body) => html`<div class="xstep"><div class="xnum">${n}</div><div style="flex:1"><div class="xtitle">${title}</div>${body}</div></div>`;
  return html`<div class="card" style="max-width:820px">
    <h2>Build tests by walking through the application</h2>
    <div class="xhow">
      <div><b>1</b> The tool opens the page and finds everything on it (fields, buttons, links).</div>
      <div><b>2</b> It suggests what to do next — log in, fill the form, open a link — and you pick one.</div>
      <div><b>3</b> It does it, moves to the next page and repeats. New pages are saved automatically.</div>
      <div><b>4</b> At the end you save the journey as a workflow (ready-to-run test cases).</div>
    </div>

    ${step(1, 'Which page should it open first?', html`
      <div class="row start" style="gap:8px">
        ${S.envs.length > 1 && html`<select style="flex:0 0 150px" value=${env} onChange=${(e) => pickEnv(e.target.value)} title="Environment">${S.envs.map((x) => html`<option value=${x}>${x}</option>`)}</select>`}
        <input type="url" value=${url} onInput=${(e) => setUrl(e.target.value)} placeholder="https://…" />
      </div>
      <div class="hint">Usually the application's first page (the login page, or the home page). This is the address of the <b>${env}</b> environment — change it to start from another page.</div>`)}

    ${step(2, 'Are you already logged in?', html`
      <label class="check"><input type="radio" name="xlogin" checked=${login === ''} onChange=${() => setLogin('')} /> No — start logged out <span class="muted small">(the tool will offer to log in when it sees the login form)</span></label>
      ${S.users.map((u) => html`<label class="check" style=${saved.includes(u) ? '' : 'opacity:.55'}><input type="radio" name="xlogin" disabled=${!saved.includes(u)} checked=${login === u} onChange=${() => setLogin(u)} />
        Yes, as <b data-noi18n>${u}</b> ${saved.includes(u) ? html`<span class="muted small">(saved login)</span>` : html`<span class="muted small">— no saved login yet: start logged out and log in as ${u} while exploring</span>`}</label>`)}
      ${!S.users.length && html`<div class="hint">No test users yet — add them in Settings → Users & data if the application needs a login.</div>`}`)}

    ${step(3, 'Watch it happen? (optional)', html`
      <label class="check"><input type="checkbox" checked=${headed} onChange=${(e) => setHeaded(e.target.checked)} /> Also open a real browser window on this computer</label>`)}

    ${error && html`<div class="err" style="margin-top:10px"><b>Could not open the page:</b> ${error}</div>`}
    <div class="row between" style="margin-top:14px"><span class="muted small">Nothing is changed in the application — only what you choose is done.</span>
      <button class="btn primary big" style="flex:0 0 auto" disabled=${!!busy || !url.trim()} onClick=${() => onStart({ env, url: url.trim() === (S.baseURLs[env] ?? '') ? '' : url.trim(), user: login, headed })}>${busy ? html`<span class="spin"></span> Opening the page…` : '▶ Open the page and scan it'}</button></div>
  </div>`;
}

function Live({ st, busy, call }) {
  const s = useStore();
  const S = s.S;
  const pg = st.page;
  const [gen, setGen] = useState(false);
  const [tab, setTab] = useState('next');
  const [hot, setHot] = useState(-1);
  const [boxes, setBoxes] = useState(true);
  const [name, setName] = useState(pg.key);
  useEffect(() => setName(pg.key), [pg.key]);
  const save = async () => {
    const n = prompt('Name of the workflow:', st.journey.length ? `${st.journey[0].from} → ${st.journey.at(-1).to}` : 'Explored journey');
    if (!n) return;
    try {
      const r = await api('/api/explore/save', { method: 'POST', body: { app: S.app, name: n } });
      toast(`Workflow saved with ${r.cases.length} case(s) ✔`);
      await loadState();
      go(`#/p/${S.app}/builder`);
    } catch (e) { toast(e.message); }
  };
  const working = !!busy || st.busy;
  const tip = !st.journey.length
    ? html`👉 <b>What now?</b> Pick a step under <b>Next step</b> on the right — or click a numbered box on the picture. The tool does it and moves on.`
    : html`✔ ${st.journey.length} step(s) done. Keep going, or press <b>💾 Save as workflow</b> when the journey is complete. <b>✨ Generate tests</b> makes test cases for the page you are on.`;
  return html`
    ${st.after && html`<div class="okbox" style="margin-bottom:10px">↪ Continuing after the test <b data-noi18n>${st.after.case}${st.after.row ? ` · ${st.after.row}` : ''}</b> — when you save, the workflow starts with that test, then goes on with the steps you do here.</div>`}
    <div class="info" style="margin-bottom:10px">${tip}</div>
    <${Journey} st=${st} />
    <div class="explore">
      <div class="card" style="margin:0">
        <h2>${pg.title || pg.key}<span class="grow"></span><label class="check small" style="margin:0 10px 0 0"><input type="checkbox" checked=${boxes} onChange=${(e) => setBoxes(e.target.checked)} /> Numbers on the picture</label><span class="muted small mono">${pg.url}</span></h2>
        <${Shot} pg=${pg} disabled=${working} hot=${hot} boxes=${boxes} onHover=${setHot} onClick=${(el) => { setTab('elements'); setHot(pg.elements.findIndex((e) => e.name === el)); }} />
      </div>
      <div>
        <div class="card">
          <div class="row between"><b>Page</b>${pg.isNew ? html`<span class="badge ok">✚ new — saved to the Smart OR</span>` : html`<span class="badge">known page</span>`}</div>
          ${pg.canRename ? html`<div class="row start" style="margin-top:8px;gap:6px"><input type="text" value=${name} onInput=${(e) => setName(e.target.value)} />
            <button class="btn sm" style="flex:0 0 auto" disabled=${name === pg.key || working} onClick=${() => call('rename', { from: pg.key, to: name }, 'rename')}>Rename</button></div>`
            : html`<div class="mono" style="margin-top:6px">${pg.key}</div>`}
          <div class="muted small" style="margin-top:6px">${pg.elements.length} element(s) detected · ${pg.elements.filter((e) => e.inOR).length} in the Smart OR${st.user ? ` · logged in as ${st.user}` : ' · logged out'}</div>
          <div class="row start" style="margin-top:10px;gap:6px;flex-wrap:wrap">
            <button class="btn sm" disabled=${working} onClick=${() => setGen(true)}>✨ Generate tests for this page</button>
            <button class="btn sm" disabled=${working || !st.journey.length} onClick=${() => call('undo', {}, 'undo')}>↶ Undo last step</button>
          </div>
        </div>
        ${st.found?.length > 0 && html`<div class="card found">
          <h2>Messages found after the last step</h2>
          ${st.found.map((f) => html`<div class="att ${f.tone === 'success' ? 'ok' : f.tone === 'error' ? 'bad' : ''}">
            <b>${f.kind === 'dialog' ? 'Dialog' : 'Message'}${f.tone === 'error' ? ' · error' : f.tone === 'success' ? ' · success' : ''}</b>
            <bdi data-noi18n>“${f.text}”</bdi>
            <span class="muted small">Saved in the Smart OR as <span class="mono">${f.element}</span>${f.close ? html` · closed with <span class="mono">${f.close}</span>` : ''}</span></div>`)}
          <div class="hint">Saved as a check in the test case of this step. Dialogs are closed automatically so the journey can go on.</div>
        </div>`}
        <div role="tablist" class="xtabs">
          <button role="tab" aria-selected=${tab === 'next'} class=${tab === 'next' ? 'on' : ''} onClick=${() => setTab('next')}>Next step</button>
          <button role="tab" aria-selected=${tab === 'elements'} class=${tab === 'elements' ? 'on' : ''} onClick=${() => setTab('elements')}>Elements on this page · ${pg.elements.length}</button>
        </div>
        ${tab === 'elements' && html`<${ElementMap} pg=${pg} working=${working} hot=${hot} setHot=${setHot} call=${call} error=${st.error} />`}
        <div class="card" style=${tab === 'next' ? '' : 'display:none'}>
          <h2>Next step${working && html` <span class="spin"></span>`}</h2>
          ${st.error && html`<div class="err small">${st.error}</div>`}
          ${!pg.suggestions.length && html`<div class="muted small">No obvious next step on this page — click any box on the screenshot.</div>`}
          <div class="suggest">${pg.suggestions.map((x) => html`<button class="sg ${x.kind}" disabled=${working} onClick=${() => call('act', { id: x.id }, x.id)}>
            <span>${KIND[x.kind]}</span><span style="flex:1;text-align:start"><b>${x.label}</b>${x.detail ? html`<div class="muted small">${x.detail}</div>` : ''}</span>${x.goesTo ? html`<span class="badge">→ ${x.goesTo}</span>` : ''}</button>`)}</div>
          <div class="hint">Or click a box on the screenshot (blue = in the Smart OR, dashed = detected, added when used).</div>
        </div>
        <div class="card">
          <b>Journey</b> <span class="muted small">${st.journey.length} step(s) · routes are added to the navigation map</span>
          <div class="row start" style="margin-top:10px"><button class="btn primary" style="flex:0 0 auto" disabled=${!st.journey.length || working} onClick=${save}>💾 Save as workflow</button></div>
          <div class="hint">Each step becomes a small test case (start page, user, steps, check that the next page opened, valid data for forms), chained in one workflow.</div>
        </div>
      </div>
    </div>
    ${gen && html`<${GenerateCasesModal} initialPages=${[pg.key]} close=${() => setGen(false)} onEdit=${() => { setGen(false); go(`#/p/${S.app}/builder`); }} />`}`;
}

/** the journey as a chain of pages */
function Journey({ st }) {
  const nodes = st.journey.length ? [st.journey[0].from, ...st.journey.map((j) => j.to)] : [st.page.key];
  return html`<div class="journey">${nodes.map((n, i) => html`
    ${i > 0 && html`<div class="jarrow"><span>${KIND[st.journey[i - 1].kind]} ${st.journey[i - 1].label}</span></div>`}
    <div class="jnode ${i === nodes.length - 1 ? 'on' : ''}">${n}</div>`)}</div>`;
}

function Shot({ pg, onClick, disabled, hot = -1, boxes = true, onHover }) {
  const img = useRef(null);
  const [scale, setScale] = useState(0);
  const fit = () => img.current && setScale(img.current.clientWidth / pg.size.width);
  useEffect(() => { window.addEventListener('resize', fit); return () => window.removeEventListener('resize', fit); }, [pg.shot]);
  return html`<div class="vis">
    <img ref=${img} src=${pg.shot} onLoad=${fit} alt="page" />
    ${scale > 0 && pg.elements.map((e, i) => e.box && (boxes || i === hot) && html`<div class="bx ${e.inOR ? '' : 'new'} click ${i === hot ? 'hot' : hot >= 0 ? 'dim' : ''}" title=${`${i + 1}. ${e.name}${e.control ? ' · ' + e.control : ''} — shows it in the list`}
      ref=${(el) => { if (el && i === hot) { const v = el.parentElement; if (el.offsetTop < v.scrollTop || el.offsetTop > v.scrollTop + v.clientHeight - 40) v.scrollTop = el.offsetTop - v.clientHeight / 3; } }}
      onMouseEnter=${() => onHover?.(i)} onMouseLeave=${() => onHover?.(-1)}
      onClick=${() => !disabled && onClick(e.name)}
      style=${`left:${e.box.x * scale}px;top:${e.box.y * scale}px;width:${Math.max(6, e.box.w * scale)}px;height:${Math.max(6, e.box.h * scale)}px`}><span>${i + 1}</span></div>`)}
  </div>`;
}

/**
 * Elements on this page — the numbers of the picture as a list: what each one is, and what you can do with it.
 * Overlapping boxes on a busy page are hard to click; here every element has its own row and its own action.
 */
function ElementMap({ pg, working, hot, setHot, call, error }) {
  const [q, setQ] = useState('');
  const [vals, setVals] = useState({});
  const KIND = { button: 'Button', link: 'Link', tab: 'Tab', picker: 'Choices', option: 'Option', textbox: 'Text field', textarea: 'Text area', password: 'Password', select: 'Drop-down', datepicker: 'Date', checkbox: 'Checkbox', checkgroup: 'Checkboxes', radiogroup: 'Options', heading: 'Heading', alert: 'Message', dialog: 'Dialog' };
  const input = (c) => ['textbox', 'textarea', 'password', 'datepicker'].includes(c);
  const rows = pg.elements.map((e, i) => ({ e, i })).filter(({ e }) => !q || `${e.name} ${e.label} ${e.control ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  const act = (e, body, label) => call('act', { element: e.name, ...body }, label);
  return html`<div class="card emap">
    ${error && html`<div class="err small">${error}</div>`}
    <div class="row start" style="gap:8px;margin-bottom:8px">
      <label for="emq" class="sr">Search elements</label>
      <input id="emq" type="text" placeholder="Search by name, text or kind" value=${q} onInput=${(ev) => setQ(ev.target.value)} />
    </div>
    <div class="hint" style="margin:0 0 8px">Hover a row to see it on the picture. Each row has its own action, so overlapping boxes don't matter.</div>
    <div class="elist2">${rows.map(({ e, i }) => html`<div class="erow ${i === hot ? 'hot' : ''}" onMouseEnter=${() => setHot(i)} onMouseLeave=${() => setHot(-1)}
        ref=${(el) => { if (el && i === hot && !el.matches(':hover')) { const l = el.parentElement; if (el.offsetTop < l.scrollTop || el.offsetTop > l.scrollTop + l.clientHeight - 60) l.scrollTop = el.offsetTop - l.offsetTop - 20; } }}>
      <span class="enum ${e.inOR ? '' : 'new'}">${i + 1}</span>
      <div class="emain">
        <div><b class="mono">${e.name}</b> <span class="badge">${KIND[e.control] ?? e.control ?? 'Element'}</span>${e.inOR ? '' : html` <span class="badge warn" title="Added to the Smart OR when you use it">new</span>`}${e.box ? '' : html` <span class="muted small">not on the picture</span>`}</div>
        <div class="small muted elabel" data-noi18n>${e.label}</div>
        ${e.control === 'picker' && e.options?.length ? html`<div class="row start" style="gap:6px;margin-top:6px">
            <select aria-label=${`Choice for ${e.name}`} value=${vals[e.name] ?? e.options[0]} onChange=${(ev) => setVals({ ...vals, [e.name]: ev.target.value })} style="width:auto;min-width:140px" data-noi18n>${e.options.map((o) => html`<option value=${o}>${o}</option>`)}</select>
            <button class="btn sm primary" disabled=${working} onClick=${() => act(e, { option: vals[e.name] ?? e.options[0] }, e.name)}>Pick</button></div>`
        : input(e.control) ? html`<div class="row start" style="gap:6px;margin-top:6px">
            <input type=${e.control === 'password' ? 'password' : 'text'} aria-label=${`Value for ${e.name}`} placeholder="value or {{faker…}}" value=${vals[e.name] ?? ''} onInput=${(ev) => setVals({ ...vals, [e.name]: ev.target.value })} />
            <button class="btn sm primary" style="flex:0 0 auto" disabled=${working} onClick=${() => act(e, { value: vals[e.name] ?? '' }, e.name)}>Type</button></div>`
        : html`<div style="margin-top:6px"><button class=${`btn sm ${e.clickable ? '' : 'ghost'}`} disabled=${working} title=${e.clickable ? '' : 'Not a button or link — click it anyway if the page reacts to it'} onClick=${() => act(e, {}, e.name)}>Click</button></div>`}
      </div></div>`)}</div>
  </div>`;
}
