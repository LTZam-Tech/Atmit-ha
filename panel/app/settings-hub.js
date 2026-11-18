// Settings — one place for language & display, the project and its environments, users & data, branding and Git.
import { html, useState } from '/vendor/preact-htm.js';
import { useStore } from './core.js';
import { StageProject } from './stage-project.js';
import { StageData } from './stage-data.js';
import { BrandingModal, GitModal } from './settings.js';
import { t, currentLang, setLang, LANGS } from './i18n.js';

const TABS = [['display', 'Language & display'], ['project', 'Project & environments'], ['data', 'Users & data'], ['brand', 'Branding & Git']];

export function StageSettings({ tab: initial }) {
  const [tab, setTab] = useState(initial || 'display');
  return html`
    <div class="page-title"><h1>${t('Settings')}</h1><span class="sub">${t('Saved on this computer')}</span></div>
    <div class="setlayout">
      <nav class="subnav card" aria-label=${t('Settings')}>
        ${TABS.map(([k, l]) => html`<button class=${tab === k ? 'on' : ''} aria-current=${tab === k ? 'true' : undefined} onClick=${() => setTab(k)}>${t(l)}</button>`)}
      </nav>
      <div class="setbody">
        ${tab === 'display' && html`<${Display} />`}
        ${tab === 'project' && html`<${StageProject} />`}
        ${tab === 'data' && html`<${StageData} />`}
        ${tab === 'brand' && html`<${BrandGit} />`}
      </div>
    </div>`;
}

function Display() {
  const cur = currentLang();
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || 'system');
  const applyTheme = (v) => { setTheme(v); if (v === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = v; try { localStorage.setItem('atimtha-theme', v); } catch { /* ignore */ } };
  return html`<section class="card">
    <h2>${t('Language & display')}</h2>
    <p class="muted" style="margin-top:-6px">${t('The whole studio switches, including direction, menus and messages.')}</p>
    <fieldset class="langpick"><legend class="lbl">${t('Interface language')}</legend>
      ${Object.entries(LANGS).map(([k, v]) => html`<label class=${cur === k ? 'on' : ''} lang=${k}>
        <input type="radio" name="uilang" checked=${cur === k} onChange=${() => setLang(k)} />
        <span><b data-noi18n>${v.name}</b><span class="muted small">${t(v.dir === 'rtl' ? 'Right to left' : 'Left to right')}</span></span>
        <span class="glyph" aria-hidden="true" data-noi18n>${k === 'ar' ? 'أب' : 'Aa'}</span></label>`)}
    </fieldset>
    <fieldset class="langpick"><legend class="lbl">${t('Appearance')}</legend>
      ${[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => html`<label class=${theme === k ? 'on' : ''}><input type="radio" name="theme" checked=${theme === k} onChange=${() => applyTheme(k)} /><span><b>${t(l)}</b></span></label>`)}
    </fieldset>
  </section>`;
}

function BrandGit() {
  const s = useStore();
  const [modal, setModal] = useState(null);
  return html`<div class="grid2">
    <section class="card"><h2>${t('Report branding')}</h2><p class="muted">${t('Logo, company, client and colors on the Smart Report.')}</p>
      <button class="btn primary" onClick=${() => setModal('brand')}>${t('Edit report branding')}</button></section>
    <section class="card"><h2>Git</h2><p class="muted">${t('Track changes to the project files.')}</p>
      <div class="small muted" data-noi18n>${s.git?.repo ? `⎇ ${s.git.branch} · ${s.git.changes.length}` : '—'}</div>
      <button class="btn" style="margin-top:10px" onClick=${() => setModal('git')}>${t('Open Git')}</button></section>
    ${modal === 'brand' && html`<${BrandingModal} onClose=${() => setModal(null)} />`}
    ${modal === 'git' && html`<${GitModal} onClose=${() => setModal(null)} />`}
  </div>`;
}
