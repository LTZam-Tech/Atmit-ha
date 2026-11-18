// Overview — the project at a glance: last run, what the project holds, what needs attention, coverage by module.
import { html } from '/vendor/preact-htm.js';
import { useStore, startRun, runSettings, store } from './core.js';
import { t, currentLang } from './i18n.js';

const rateOf = (c) => Math.round(((c.passed + c.flaky) / Math.max(1, c.total - c.skipped)) * 100);
const dur = (ms) => { const [m, sec] = currentLang() === 'ar' ? ['د', 'ث'] : ['m', 's']; return ms < 60000 ? `${Math.round(ms / 1000)} ${sec}` : `${Math.floor(ms / 60000)} ${m} ${Math.round((ms % 60000) / 1000)} ${sec}`; };
const when = (iso) => {
  const d = new Date(iso), now = new Date();
  const loc = currentLang() === 'ar' ? 'ar-JO-u-nu-latn' : undefined;
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(loc, { month: 'short', day: 'numeric' });
};
const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };
const ok = html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>`;
const bad = html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

export function StageOverview() {
  const s = useStore();
  const S = s.S;
  const app = S.app;
  const last = s.history[0];
  const env = runSettings().env || S.settings?.defaultEnv || S.envs[0];
  const tests = S.cases.reduce((n, c) => n + (c.rows || 1), 0);
  const modules = {};   // lower-case key -> { name, tests }
  for (const c of S.cases) { const m = c.module || c.page || t('no module'); const k = m.toLowerCase(); modules[k] ??= { name: m, tests: 0 }; modules[k].tests += c.rows || 1; }
  const lastByModule = {};
  for (const x of last?.tests ?? []) {
    const k = (x.module || '').toLowerCase();
    if (!modules[k]) continue;
    lastByModule[k] ??= { ok: 0, all: 0 };
    lastByModule[k].all++;
    if (['passed', 'flaky'].includes(x.status)) lastByModule[k].ok++;
  }
  const missingPwd = S.usersDetail.filter((u) => !u.hasPassword);
  const attention = [
    S.drafts.length && { kind: 'warn', title: t('Pages changed or waiting for review'), body: `${S.drafts.length} draft(s) to review`, href: `#/p/${app}/pages`, link: t('Review drafts') },
    S.caseIssues.length && { kind: 'bad', title: t('Test cases with problems'), body: S.caseIssues.slice(0, 2).map((i) => i.message).join(' · '), href: `#/p/${app}/builder`, link: t('Fix the cases') },
    missingPwd.length && { kind: 'warn', title: t('Users without a password'), body: missingPwd.map((u) => u.key).join(', ') + ' — ' + t('Add the password in Settings → Users & data.'), href: `#/p/${app}/data`, link: t('Users & data') },
    (() => {
      const fresh = new Set();
      for (const t of last?.tests ?? []) for (const v of t.discoveries?.visits ?? []) if (!v.page) { try { fresh.add(new URL(v.url).pathname); } catch { /* skip */ } }
      const msgs = new Set((last?.tests ?? []).flatMap((t) => (t.discoveries?.messages ?? []).map((m) => m.text)));
      if (!fresh.size && !msgs.size) return null;
      return { kind: 'info', title: t('What the last run found'), body: [fresh.size ? `${fresh.size} new page(s): ${[...fresh].slice(0, 3).join(', ')}` : '', msgs.size ? `${msgs.size} message(s) popped up` : ''].filter(Boolean).join(' · '),
        href: `#/p/${app}/run`, link: t('See what the run found'), onClick: () => store.set({ runTab: 'history', viewRun: last.id }) };
    })(),
  ].filter(Boolean);
  const empty = !S.pages.length && !S.cases.length;

  return html`<div class="ov">
    <header class="ovhead">
      <div>
        <div class="muted">${S.appName} · <span data-noi18n>${env}</span></div>
        <h1>${t(greeting())}</h1>
        <p class="muted">${!last ? t('No runs yet — run the tests to see results here.') : last.counts.failed ? t('Some tests failed in the last run.') : t('Everything passed in the last run.')}</p>
      </div>
      <div class="row start">
        <a class="btn big" href=${`#/p/${app}/explore`}>${t('Explore a page')}</a>
        <button class="btn primary big" disabled=${s.running || !tests} onClick=${() => startRun({ label: 'all tests' })}>▶ ${t('Run all tests')}</button>
      </div>
    </header>

    ${empty && html`<section class="card getstarted">
      <h2>${t('Get started')}</h2>
      <ol>
        <li><a href=${`#/p/${app}/explore`}>${t('Collect the first pages of your application')}</a></li>
        <li><a href=${`#/p/${app}/builder`}>${t('Build test cases from them')}</a></li>
        <li><a href=${`#/p/${app}/run`}>${t('Run them and read the report')}</a></li>
      </ol>
    </section>`}

    <section class="kpis4" aria-label=${t('Overview')}>
      <div class="kpi dark">
        <span class="l">${t('Last full run')}${last ? html` · <span data-noi18n>${when(last.started)}</span>` : ''}</span>
        ${last ? html`<div class="big"><span dir="ltr">${last.counts.passed + last.counts.flaky} / ${last.counts.total - last.counts.skipped}</span>
            <span class=${last.counts.failed ? 'badtxt' : 'oktxt'}>${last.counts.failed ? `${last.counts.failed} ${t('failed')}` : t('all passed')}</span></div>
          <div class="meter" role="img" aria-label=${`${rateOf(last.counts)}%`}><span style=${`width:${rateOf(last.counts)}%`}></span></div>
          <span class="l">${dur(last.duration)} · <span data-noi18n>${last.env}</span></span>
          <a class="small" href=${`#/p/${app}/run`} onClick=${() => store.set({ runTab: 'history', viewRun: last.id })}>${t('Open the report')}</a>`
        : html`<div class="big">—</div><span class="l">${t('not run yet')}</span>`}
      </div>
      <a class="kpi" href=${`#/p/${app}/pages`}><span class="l">${t('Pages in Smart OR')}</span><span class="v">${S.pages.length}</span>
        <span class=${S.drafts.length ? 'warntxt small' : 'muted small'}>${S.drafts.length ? `${S.drafts.length} ${t('need review')}` : ' '}</span></a>
      <a class="kpi" href=${`#/p/${app}/builder`}><span class="l">${t('Test cases')}</span><span class="v">${S.cases.length}</span>
        <span class="muted small">${tests} ${t('tests')} · ${Object.keys(modules).length} ${t('modules')}</span></a>
      <a class="kpi" href=${`#/p/${app}/builder`}><span class="l">${t('Workflows')}</span><span class="v">${(S.flows ?? []).length}</span>
        <span class="muted small">${t('multi-user, one session')}</span></a>
    </section>

    <section class="ovgrid">
      <div class="card">
        <h2>${t('Recent runs')}<span class="grow"></span><a class="small" href=${`#/p/${app}/run`} onClick=${() => store.set({ runTab: 'history' })}>${t('All runs')}</a></h2>
        ${!s.history.length ? html`<div class="muted">${t('No runs yet — run the tests to see results here.')}</div>` : html`<div class="tscroll"><table>
          <thead><tr><th>${t('Environment')}</th><th>${t('Result')}</th><th>${t('Duration')}</th><th style="text-align:end">${t('When')}</th></tr></thead>
          <tbody>${s.history.slice(0, 5).map((r) => html`<tr class="clickable" onClick=${() => { store.set({ runTab: 'history', viewRun: r.id }); location.hash = `#/p/${app}/run`; }}>
            <td data-noi18n>${r.env}${r.locale ? ` · ${r.locale}` : ''}</td>
            <td>${r.counts.failed ? html`<span class="res bad">${bad} ${r.counts.failed} ${t('failed')} · ${r.counts.passed} ${t('passed')}</span>` : html`<span class="res ok">${ok} ${r.counts.passed + r.counts.flaky} ${t('passed')}</span>`}</td>
            <td class="muted">${dur(r.duration)}</td><td class="muted" style="text-align:end">${when(r.started)}</td></tr>`)}</tbody></table></div>`}
      </div>
      <div class="card">
        <h2>${t('Needs your attention')}</h2>
        ${!attention.length ? html`<div class="okbox">${t('Nothing needs your attention right now.')}</div>`
          : attention.map((a) => html`<div class="att ${a.kind}"><b>${a.title}</b><span class="muted small">${a.body}</span><a class="small" href=${a.href} onClick=${a.onClick}>${a.link}</a></div>`)}
      </div>
    </section>

    ${Object.keys(modules).length > 0 && html`<section class="card">
      <h2>${t('Coverage by module')}</h2>
      <div class="mods">${Object.entries(modules).map(([k, { name: m, tests: n }]) => {
        const r = lastByModule[k];
        const pct = r ? Math.round((r.ok / r.all) * 100) : 0;
        return html`<div class="mod"><div class="row between"><b data-noi18n>${m}</b><span class="muted small">${n} ${t('tests')}${r ? ` · ${pct}%` : ''}</span></div>
          <div class="meter light"><span class=${r && pct < 100 ? 'part' : ''} style=${`width:${r ? pct : 0}%`}></span></div></div>`;
      })}</div>
    </section>`}
  </div>`;
}
