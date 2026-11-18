// Global settings: report branding profiles, Git.
import { html, useState, useEffect } from '/vendor/preact-htm.js';
import { useStore, api, toast, loadGit, loadState, store } from './core.js';
import { Modal, Field, Empty } from './ui.js';

export function BrandingModal({ onClose }) {
  const [profiles, setProfiles] = useState(null);
  const [sel, setSel] = useState('default');
  useEffect(() => { api('/api/branding').then((p) => { setProfiles(p); setSel(Object.keys(p)[0]); }); }, []);
  if (!profiles) return html`<${Modal} title="Report branding" onClose=${onClose}><${Empty}><span class="spin"></span></${Empty}></${Modal}>`;
  const p = profiles[sel] ?? {};
  const set = (k, v) => setProfiles({ ...profiles, [sel]: { ...p, [k]: v } });
  const add = () => {
    const name = prompt('Profile name (e.g. Smart Minds × MOH):');
    if (!name) return;
    const key = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile';
    setProfiles({ ...profiles, [key]: { ...p, name, client: '' } });
    setSel(key);
  };
  const logo = (file) => {
    if (!file) return;
    if (file.size > 500_000) return toast('Logo must be under 500 KB');
    const fr = new FileReader();
    fr.onload = () => set('logo', fr.result);
    fr.readAsDataURL(file);
  };
  const save = async () => {
    try { await api('/api/branding', { method: 'PUT', body: { profiles } }); toast('Branding saved ✔ — applies to the next run'); if (store.route.app) loadState(); onClose(); }
    catch (e) { toast(e.message); }
  };
  return html`<${Modal} wide title="Report branding" onClose=${onClose}>
    <div class="muted small" style="margin-bottom:12px">One profile per client or delivery. Each project picks its profile in Settings → Project. Shown on every Smart Report.</div>
    <div class="grid2">
      <div>
        <div class="row start" style="margin-bottom:10px">${Object.entries(profiles).map(([k, v]) => html`<span class="chip ${k === sel ? 'on' : ''}" onClick=${() => setSel(k)}>${v.name}</span>`)}<button class="btn sm" onClick=${add}>＋ Profile</button></div>
        <${Field} label="Profile name"><input type="text" value=${p.name ?? ''} onInput=${(e) => set('name', e.target.value)} /></${Field}>
        <div class="row"><${Field} label="Company"><input type="text" value=${p.company ?? ''} onInput=${(e) => set('company', e.target.value)} placeholder="Smart Minds AI" /></${Field}>
          <${Field} label="Client"><input type="text" value=${p.client ?? ''} onInput=${(e) => set('client', e.target.value)} placeholder="Ministry of Health" /></${Field}></div>
        <${Field} label="Report title"><input type="text" value=${p.reportTitle ?? ''} onInput=${(e) => set('reportTitle', e.target.value)} placeholder="Automation Smart Report" /></${Field}>
        <div class="row"><${Field} label="Main color"><input type="color" value=${p.primaryColor ?? '#2a78d6'} onInput=${(e) => set('primaryColor', e.target.value)} /></${Field}>
          <${Field} label="Confidentiality label"><input type="text" value=${p.confidentiality ?? ''} onInput=${(e) => set('confidentiality', e.target.value)} placeholder="Confidential" /></${Field}></div>
        <${Field} label="Footer text"><input type="text" value=${p.footer ?? ''} onInput=${(e) => set('footer', e.target.value)} placeholder="Prepared by the QA team" /></${Field}>
        <${Field} label="Logo (PNG/SVG/JPG, under 500 KB)"><div class="row start">${p.logo && html`<img class="logo-prev" src=${p.logo} />`}
          <label class="btn sm">Upload<input type="file" accept="image/*" style="display:none" onChange=${(e) => logo(e.target.files[0])} /></label>
          ${p.logo && html`<button class="btn sm danger" onClick=${() => set('logo', '')}>Remove</button>`}</div></${Field}>
      </div>
      <div>
        <div class="small muted">Preview</div>
        <div class="brandprev">
          <div class="bar" style=${`background:${p.primaryColor ?? '#2a78d6'}`}></div>
          <div class="row start" style="align-items:center">${p.logo && html`<img src=${p.logo} style="max-height:44px;max-width:140px" />`}
            <div><div class="small sec"><b>${[p.company, p.client].filter(Boolean).join(' · ')}</b> ${p.confidentiality && html`<span class="badge" style=${`border:1px solid ${p.primaryColor}`}>${p.confidentiality}</span>`}</div>
              <div style="font-size:18px;font-weight:700">${p.reportTitle || 'Automation Smart Report'}</div></div></div>
          <div class="muted small" style=${`margin-top:40px;border-top:2px solid ${p.primaryColor ?? '#2a78d6'};padding-top:6px`}>${p.footer}</div>
        </div>
      </div>
    </div>
    <div class="row between" style="margin-top:14px">
      ${sel !== 'default' ? html`<button class="btn danger" style="flex:0" onClick=${() => { const n = { ...profiles }; delete n[sel]; setProfiles(n); setSel(Object.keys(n)[0]); }}>Delete profile</button>` : html`<span></span>`}
      <button class="btn primary" style="flex:0" onClick=${save}>Save branding</button></div>
  </${Modal}>`;
}

export function GitModal({ onClose }) {
  const s = useStore();
  const g = s.git;
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const act = async (fn) => { setBusy(true); try { await fn(); } catch (e) { toast(e.message); } setBusy(false); loadGit(); };
  return html`<${Modal} title="Git" onClose=${onClose}>
    ${!g?.repo ? html`<div class="info">This workspace is not a Git repository yet. Initialise it to track changes and connect it to GitHub later. Passwords (secrets.yml), sessions and reports are already excluded by .gitignore.</div>
        <button class="btn primary" disabled=${busy} onClick=${() => act(() => api('/api/git/init', { method: 'POST' }))}>Initialise Git repository</button>`
      : html`<div class="row between"><div><b>⎇ ${g.branch}</b> <span class="muted small">${g.remote || 'no remote yet — connect GitHub with: git remote add origin <url>'}</span></div></div>
        <h3 style="margin:14px 0 6px">Changes (${g.changes.length})</h3>
        <div style="max-height:260px;overflow:auto"><table>${g.changes.map((c) => html`<tr style=${c.commit ? '' : 'opacity:.6'} title=${c.reason ?? ''}>
          <td style="width:40px"><span class="badge">${c.status}</span></td>
          <td class="mono small">${c.file}</td>
          <td class="small" style="width:150px">${c.commit ? html`<span>Will be committed</span>` : c.blocked ? html`<span style="color:var(--critical);font-weight:600">Blocked</span>` : html`<span class="muted">Use your Git client</span>`}</td></tr>`)}</table></div>
        ${g.changes.some((c) => c.blocked) && html`<div class="info" style="margin-top:8px">${g.changes.filter((c) => c.blocked).map((c) => html`<div class="small"><span class="mono">${c.file}</span>: ${c.reason}</div>`)}</div>`}
        ${!g.changes.length && html`<div class="muted small">Nothing to commit.</div>`}
        ${g.changes.length > 0 && html`<div class="row" style="margin-top:12px"><${Field} label="Commit message" style="flex:3"><input type="text" value=${msg} onInput=${(e) => setMsg(e.target.value)} placeholder="Add patient form cases" /></${Field}>
          <div style="flex:0;margin-bottom:10px"><button class="btn primary" disabled=${busy || !msg.trim() || !g.changes.some((c) => c.commit) || g.changes.some((c) => c.blocked)} onClick=${() => act(async () => { const r = await api('/api/git/commit', { method: 'POST', body: { message: msg } }); setMsg(''); toast(r.left ? `Committed ${r.committed} file(s); ${r.left} left for your Git client` : `Committed ${r.committed} file(s) ✔`); })}>Commit</button></div></div>
          <div class="hint">The panel commits project files only (apps/, branding/). Files with passwords or keys are blocked. Code and settings changes, push / pull and branches: use your Git client.</div>`}`}
  </${Modal}>`;
}
