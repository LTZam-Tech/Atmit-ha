// Step ③ — Data & settings: test users, how to log in, shared (global) values.
import { html, useState } from '/vendor/preact-htm.js';
import { useStore, api, toast, loadState, startRun } from './core.js';
import { Field, NextStep } from './ui.js';

export function StageData() {
  const s = useStore();
  const S = s.S;
  return html`
    <div class="page-title"><h1>Users & data</h1><span class="sub">Users, login and values shared by all tests</span></div>
    ${S.cases.length === 0 && S.usersDetail.length > 0 && html`<${NextStep} text="Next: build test cases from the pages and this data." to=${`#/p/${S.app}/builder`} label="Tests" />`}
    <div class="grid2">
      <${Users} />
      <${Login} />
    </div>
    <${Messages} />
    <div class="card" style="opacity:.75">
      <h2>Data sheets & value scopes <span class="badge">Phase 3</span></h2>
      <div class="muted small">Excel-like data tables per form (generated from the page fields, import/export .xlsx/.csv), and values in four scopes:
        <b>Global</b> (this page) → <b>Environment</b> → <b>Local</b> (per test / row) → <b>Runtime</b> (captured while the test runs, e.g. a new order number).</div>
    </div>`;
}

function Users() {
  const s = useStore();
  const S = s.S;
  const [rows, setRows] = useState(() => S.usersDetail.map((u) => ({ ...u, password: '' })));
  const upd = (i, k, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const save = async () => {
    try { await api(`/api/projects/${S.app}/users`, { method: 'PUT', body: { users: rows } }); toast('Users saved ✔ — passwords stored in secrets.yml'); loadState(); }
    catch (e) { toast(e.message); }
  };
  return html`<div class="card">
    <h2>Test users <span class="grow"></span><button class="btn sm" onClick=${() => setRows([...rows, { key: '', username: '', password: '', description: '', hasPassword: false }])}>＋ Add</button></h2>
    <table><tr><th>Key</th><th>Username</th><th>Password</th><th>Role / note</th><th></th></tr>
      ${rows.map((u, i) => html`<tr>
        <td><input type="text" value=${u.key} style="width:100px" onInput=${(e) => upd(i, 'key', e.target.value)} /></td>
        <td><input type="text" value=${u.username} onInput=${(e) => upd(i, 'username', e.target.value)} /></td>
        <td><input type="password" value=${u.password} placeholder=${u.hasPassword ? '•••••• saved' : 'not set'} onInput=${(e) => upd(i, 'password', e.target.value)} /></td>
        <td><input type="text" value=${u.description} onInput=${(e) => upd(i, 'description', e.target.value)} placeholder="admin, nurse…" /></td>
        <td><button class="btn icon danger" onClick=${() => setRows(rows.filter((_, j) => j !== i))}>✕</button></td></tr>`)}
    </table>
    ${!rows.length && html`<div class="muted small" style="padding:10px 0">No users yet.</div>`}
    <div class="hint">Use them in tests as {{user.&lt;key&gt;.username}} / {{user.&lt;key&gt;.password}}. Leave the password empty to keep the saved one.</div>
    <div class="row between" style="margin-top:10px"><span></span><button class="btn primary" style="flex:0" onClick=${save}>Save users</button></div>
  </div>`;
}

function Login() {
  const s = useStore();
  const S = s.S;
  const L = S.login;
  const [v, setV] = useState({ page: L?.page ?? '', username: L?.fields.username ?? '', password: L?.fields.password ?? '', submit: L?.fields.submit ?? '',
    successType: L?.success?.urlContains ? 'url' : 'element', successElement: L?.success?.element ?? '', successUrl: L?.success?.urlContains ?? '' });
  const page = S.pages.find((p) => p.page === v.page);
  const els = page?.elements ?? [];
  const guess = (pg) => {
    const e = S.pages.find((p) => p.page === pg)?.elements ?? [];
    const find = (f) => e.find(f)?.name ?? '';
    return {
      username: find((x) => x.def.semantic === 'username' || x.def.semantic === 'email') || find((x) => x.def.control === 'textbox'),
      password: find((x) => x.def.control === 'password'),
      submit: find((x) => x.def.control === 'button' && /log|sign|submit|دخول/i.test(x.name)) || find((x) => x.def.control === 'button'),
    };
  };
  const needs = S.pages.filter((p) => p.auth && p.auth !== 'none').map((p) => p.page);
  const save = async (andTest) => {
    const login = v.page ? { page: v.page, fields: { username: v.username, password: v.password, submit: v.submit },
      success: v.successType === 'url' ? { urlContains: v.successUrl } : v.successElement ? { element: v.successElement } : undefined } : null;
    try {
      await api(`/api/projects/${S.app}/login`, { method: 'PUT', body: { login } });
      toast('Login saved ✔'); await loadState();
      if (andTest) startRun({ project: 'setup', label: 'login check (setup)' });
    } catch (e) { toast(e.message); }
  };
  return html`<div class="card">
    <h2>How to log in</h2>
    <div class="muted small" style="margin-bottom:10px">Used once per run to save a session for every user that a page starts with${needs.length ? html` (needed by: <b>${needs.join(', ')}</b>)` : ''}.</div>
    <${Field} label="Login page"><select value=${v.page} onChange=${(e) => setV({ ...v, page: e.target.value, ...guess(e.target.value) })}><option value="">— no login —</option>${S.pages.map((p) => html`<option value=${p.page}>${p.page}</option>`)}</select></${Field}>
    ${v.page && html`<div class="row">
      ${[['username', 'Username field'], ['password', 'Password field'], ['submit', 'Login button']].map(([k, l]) => html`<${Field} label=${l}>
        <select value=${v[k]} onChange=${(e) => setV({ ...v, [k]: e.target.value })}><option value="">—</option>${els.map((e) => html`<option value=${e.name}>${e.name}</option>`)}</select></${Field}>`)}
    </div>
    <${Field} label="Login worked when…">
      <div class="row start"><label class="check"><input type="radio" checked=${v.successType === 'element'} onChange=${() => setV({ ...v, successType: 'element' })} /> an element is visible</label>
        <label class="check"><input type="radio" checked=${v.successType === 'url'} onChange=${() => setV({ ...v, successType: 'url' })} /> the URL contains</label></div></${Field}>
    ${v.successType === 'element'
      ? html`<select value=${v.successElement} onChange=${(e) => setV({ ...v, successElement: e.target.value })}><option value="">— the login form disappears —</option>
          ${S.pages.filter((p) => p.page !== v.page).map((p) => html`<optgroup label=${p.page}>${p.elements.map((e) => html`<option value=${p.page + '.' + e.name}>${p.page}.${e.name}</option>`)}</optgroup>`)}</select>`
      : html`<input type="text" value=${v.successUrl} onInput=${(e) => setV({ ...v, successUrl: e.target.value })} placeholder="/dashboard" />`}`}
    <div class="row between" style="margin-top:12px"><span></span><div class="row start">
      <button class="btn" disabled=${!v.page || s.running} onClick=${() => save(true)}>Save & test login</button>
      <button class="btn primary" onClick=${() => save(false)}>Save login</button></div></div>
  </div>`;
}

function Messages() {
  const s = useStore();
  const S = s.S;
  const ar = S.languages.includes('ar');
  const [rows, setRows] = useState(() => S.messagesDetail.map((m) => ({ ...m })));
  const upd = (i, k, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const save = async () => {
    try { await api(`/api/projects/${S.app}/messages`, { method: 'PUT', body: { messages: rows } }); toast('Values saved ✔'); loadState(); }
    catch (e) { toast(e.message); }
  };
  return html`<div class="card">
    <h2>Global values — expected messages <span class="grow"></span><button class="btn sm" onClick=${() => setRows([...rows, { key: '', en: '', ar: '' }])}>＋ Add</button></h2>
    <div class="muted small" style="margin-bottom:8px">Texts the application shows (errors, confirmations…). Use in tests as {{msg.&lt;key&gt;}} — the run language picks the column.</div>
    <table><tr><th style="width:200px">Key</th><th>English</th>${ar && html`<th>العربية</th>`}<th></th></tr>
      ${rows.map((r, i) => html`<tr>
        <td><input type="text" value=${r.key} onInput=${(e) => upd(i, 'key', e.target.value)} placeholder="invalidCredentials" /></td>
        <td><input type="text" value=${r.en} onInput=${(e) => upd(i, 'en', e.target.value)} /></td>
        ${ar && html`<td><input type="text" dir="rtl" value=${r.ar} onInput=${(e) => upd(i, 'ar', e.target.value)} /></td>`}
        <td><button class="btn icon danger" onClick=${() => setRows(rows.filter((_, j) => j !== i))}>✕</button></td></tr>`)}
    </table>
    <div class="row between" style="margin-top:10px"><span></span><button class="btn primary" style="flex:0" onClick=${save}>Save values</button></div>
  </div>`;
}
