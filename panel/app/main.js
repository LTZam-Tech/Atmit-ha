// atimtha · Automation Studio — Control Panel entry: sidebar navigation by task, routing, language.
import { html, render, useState, useEffect } from '/vendor/preact-htm.js';
import { store, useStore, api, loadForRoute, go } from './core.js';
import { Toast } from './ui.js';
import { Home } from './home.js';
import { StagePages } from './stage-pages.js';
import { StageBuilder } from './stage-builder.js';
import { StageRun } from './stage-run.js';
import { StageExplore } from './explore.js';
import { StageOverview } from './overview.js';
import { StageSettings } from './settings-hub.js';
import { BrandingModal, GitModal } from './settings.js';
import { t, setLang, currentLang, startTranslator, onLang, LANGS } from './i18n.js';

const I = (d) => html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const ICONS = {
  overview: I(html`<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>`),
  explore: I(html`<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>`),
  pages: I(html`<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>`),
  builder: I(html`<path class="flipx" d="M10 6h10M10 12h10M10 18h10M3.5 6l1.3 1.3L7.5 4.6M3.5 12l1.3 1.3 2.7-2.7M3.5 18l1.3 1.3 2.7-2.7"/>`),
  run: I(html`<circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l6-3.5z"/>`),
  settings: I(html`<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>`),
  back: I(html`<path class="flipx" d="M15 6l-6 6 6 6"/>`),
};

/** the six task sections; legacy stage ids map onto them */
export const NAV = [
  { id: 'overview', title: 'Overview' },
  { id: 'explore', title: 'Explore' },
  { id: 'pages', title: 'Pages' },
  { id: 'builder', title: 'Tests' },
  { id: 'run', title: 'Runs' },
  { id: 'settings', title: 'Settings' },
];
const SECTION_OF = { project: 'settings', data: 'settings' };

function counts(S) {
  if (!S) return {};
  return { pages: S.drafts.length ? `${S.drafts.length}•` : S.pages.length, builder: S.caseIssues.length ? `${S.caseIssues.length}!` : S.cases.reduce((n, c) => n + (c.rows || 1), 0) || '' };
}

function LangSwitch() {
  const l = currentLang();
  return html`<div class="langsw" role="group" aria-label=${t('Language')} data-noi18n>
    ${Object.entries(LANGS).map(([k, v]) => html`<button aria-pressed=${l === k} lang=${k} class=${l === k ? 'on' : ''} onClick=${() => setLang(k)}>${v.name}</button>`)}
  </div>`;
}

function Sidebar() {
  const s = useStore();
  const inProject = s.route.view === 'project';
  const app = s.route.app;
  const sec = SECTION_OF[s.route.stage] ?? s.route.stage;
  const c = counts(s.S && s.S.app === app ? s.S : null);
  const projects = s.projects ?? [];
  return html`<nav class="side" aria-label=${t('Main')}>
    <a class="brand" href="#/" title="atimtha · أتمتها — You imagine. We automate.">
      <img src="/vendor/brand/atimtha-mark.svg" alt="" width="32" height="32" />
      <span class="bt"><span class="bname" data-noi18n>${currentLang() === 'ar' ? 'أتمتها' : 'atimtha'}</span><span class="bsub" dir="ltr" data-noi18n>${currentLang() === 'ar' ? 'atimtha · STUDIO' : 'AUTOMATION STUDIO'}</span></span>
    </a>
    ${inProject && html`<label class="plbl" for="projsel">${t('Project')}</label>
      <select id="projsel" class="projsel" value=${app} onChange=${(e) => (e.target.value === '' ? go('#/') : go(`#/p/${e.target.value}/${s.route.stage}`))}>
        ${(projects.length ? projects : [{ key: app, name: s.S?.appName ?? app }]).map((p) => html`<option value=${p.key}>${p.name}</option>`)}
        <option value="">${t('All projects')}…</option>
      </select>`}
    ${inProject ? NAV.map((x) => html`<a class="navi ${sec === x.id ? 'on' : ''}" aria-current=${sec === x.id ? 'page' : undefined} href=${`#/p/${app}/${x.id}`}>
        ${ICONS[x.id]}<span>${t(x.title)}</span>${c[x.id] !== undefined && c[x.id] !== '' && html`<span class="cnt">${c[x.id]}</span>`}</a>`)
      : html`<a class="navi on" aria-current="page" href="#/">${ICONS.overview}<span>${t('Projects')}</span></a>`}
    <div class="sidefoot">
      <${LangSwitch} />
      <span class="small muted">${t('Local')} · <span dir="ltr">${location.host}</span></span>
    </div>
  </nav>`;
}

function TopBar() {
  const s = useStore();
  const [modal, setModal] = useState(null);
  const g = s.git;
  // the modals sit next to the bar, not inside it: the bar's backdrop-filter would trap their fixed position in 52 px
  return html`<div class="topbar">
    <span class="status ${s.running ? 'running' : ''}"><span class="led"></span>${s.running ? s.running.label : t('Idle')}</span>
    ${s.running && html`<button class="btn danger sm" onClick=${() => api('/api/stop', { method: 'POST' })}>■ ${t('Stop')}</button>`}
    <span class="grow"></span>
    ${g && html`<button class="chipbtn" title="Git" onClick=${() => setModal('git')} data-noi18n>${g.repo ? `⎇ ${g.branch} · ${g.changes.length}` : '⎇ —'}</button>`}
    <button class="chipbtn iconbtn" title=${t('Theme')} aria-label=${t('Theme')} onClick=${() => { const c = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); document.documentElement.dataset.theme = c === 'dark' ? 'light' : 'dark'; }}>${I(html`<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 010 16z" fill="currentColor"/>`)}</button>
  </div>
  ${modal === 'brand' && html`<${BrandingModal} onClose=${() => setModal(null)} />`}
  ${modal === 'git' && html`<${GitModal} onClose=${() => setModal(null)} />`}`;
}

function ProjectView() {
  const s = useStore();
  const { app, stage } = s.route;
  if (!s.S || s.S.app !== app) return html`<div class="empty"><span class="spin"></span> ${t('Loading project…')}</div>`;
  const sec = SECTION_OF[stage] ?? stage;
  const Stage = { overview: StageOverview, pages: StagePages, builder: StageBuilder, run: StageRun, explore: StageExplore, settings: StageSettings }[sec] ?? StageOverview;
  return html`${s.S.appError && html`<div class="err">${s.S.appError}</div>`}<${Stage} key=${app + sec} tab=${stage === 'data' ? 'data' : stage === 'project' ? 'project' : undefined} />`;
}

function App() {
  const s = useStore();
  const [, force] = useState(0);
  useEffect(() => { loadForRoute(); if (!store.projects?.length) api('/api/projects').then((p) => store.set({ projects: p })).catch(() => {}); return onLang(() => force((x) => x + 1)); }, []);
  return html`<div class="app">
    <${Sidebar} />
    <div class="mainwrap"><${TopBar} /><main class="content">${s.route.view === 'home' ? html`<${Home} />` : html`<${ProjectView} />`}</main></div>
  </div><${Toast} />`;
}

startTranslator();
render(html`<${App} />`, document.getElementById('root'));
export { go, store };
