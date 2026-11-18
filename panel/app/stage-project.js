// Step ① — Project settings: name, environments, languages, test-id attribute, report branding.
import { html, useState } from '/vendor/preact-htm.js';
import { useStore, api, toast, loadState } from './core.js';
import { Field, NextStep } from './ui.js';

export function StageProject() {
  const s = useStore();
  const S = s.S;
  const [v, setV] = useState(() => ({ run: {}, ...JSON.parse(JSON.stringify(S.settings)) }));
  const setRun = (k, val) => setV({ ...v, run: { ...v.run, [k]: val === '' ? undefined : Number(val) } });
  const rec = Math.max(1, Math.min(4, Math.floor(S.cpus / 4) || 1));
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value });
  const setEnv = (i, k, val) => setV({ ...v, environments: v.environments.map((e, j) => (j === i ? { ...e, [k]: val } : e)) });
  const toggleLang = (l, on) => setV({ ...v, languages: on ? [...new Set([...v.languages, l])] : v.languages.filter((x) => x !== l) });
  const save = async () => {
    try { await api(`/api/projects/${S.app}/settings`, { method: 'PUT', body: v }); toast('Project saved ✔'); loadState(); }
    catch (e) { toast(e.message); }
  };
  return html`
    <div class="page-title"><h1>Project & environments</h1><span class="sub">Where the application lives and how it should be tested</span></div>
    ${!S.pages.length && html`<${NextStep} text="Next: collect the pages of the application." to=${`#/p/${S.app}/pages`} label="Collect pages" />`}
    <div class="grid2">
      <div class="card">
        <h2>General</h2>
        <${Field} label="Project name"><input type="text" value=${v.name} onInput=${set('name')} /></${Field}>
        <${Field} label="Description"><input type="text" value=${v.description} onInput=${set('description')} /></${Field}>
        <div class="row">
          <${Field} label="Test-id attribute" hint="The attribute developers add for tests (data-testid, data-test, data-qa…)"><input type="text" value=${v.testIdAttribute} onInput=${set('testIdAttribute')} /></${Field}>
          <${Field} label="Languages">
            <div class="row start"><label class="check"><input type="checkbox" checked=${v.languages.includes('en')} onChange=${(e) => toggleLang('en', e.target.checked)} /> English</label>
              <label class="check"><input type="checkbox" checked=${v.languages.includes('ar')} onChange=${(e) => toggleLang('ar', e.target.checked)} /> العربية</label></div></${Field}>
        </div>
        <${Field} label="Report branding" hint="Logo, company, client and colors on the reports — edit profiles from Settings → Branding & Git.">
          <select value=${v.branding} onChange=${set('branding')}>${S.brandingProfiles.map((b) => html`<option value=${b.key}>${b.name}</option>`)}</select></${Field}>
      </div>
      <div class="card">
        <h2>Environments <span class="grow"></span><button class="btn sm" onClick=${() => setV({ ...v, environments: [...v.environments, { name: '', baseURL: 'https://', ignoreHTTPSErrors: false }] })}>＋ Add</button></h2>
        <table><tr><th>Name</th><th>Website address</th><th title="Ignore HTTPS certificate errors">Ignore cert</th><th>Default</th><th></th></tr>
          ${v.environments.map((e, i) => html`<tr>
            <td><input type="text" value=${e.name} style="width:100px" onInput=${(x) => setEnv(i, 'name', x.target.value)} /></td>
            <td><input type="url" value=${e.baseURL} onInput=${(x) => setEnv(i, 'baseURL', x.target.value)} /></td>
            <td><input type="checkbox" checked=${e.ignoreHTTPSErrors} onChange=${(x) => setEnv(i, 'ignoreHTTPSErrors', x.target.checked)} /></td>
            <td><input type="radio" name="defenv" checked=${(v.defaultEnv || v.environments[0]?.name) === e.name} onChange=${() => setV({ ...v, defaultEnv: e.name })} /></td>
            <td>${v.environments.length > 1 && html`<button class="btn icon danger" onClick=${() => setV({ ...v, environments: v.environments.filter((_, j) => j !== i) })}>✕</button>`}</td></tr>`)}
        </table>
        <div class="hint">Passwords and basic-auth go to secrets.yml (Settings → Users & data) — never in this file.</div>
      </div>
    </div>
    <div class="card">
      <h2>Running tests on this computer</h2>
      <div class="muted small" style="margin-bottom:10px">Every parallel browser uses memory and CPU, and hits the test server at the same time. Too many on a laptop — or against a slow UAT server — makes tests time out. This computer has <b>${S.cpus}</b> CPU core(s); <b>${rec}</b> browser(s) at a time is a safe start.</div>
      <div class="row">
        <${Field} label="Browsers at the same time" hint="1 = one after another (slowest, most stable). Default 2.">
          <select value=${v.run.workers ?? ''} onChange=${(e) => setRun('workers', e.target.value)}>
            <option value="">Default (2)</option>${Array.from({ length: Math.min(8, Math.max(2, S.cpus)) }, (_, i) => i + 1).map((n) => html`<option value=${n}>${n}${n === rec ? ' — recommended' : n === 1 ? ' — one at a time' : ''}</option>`)}</select></${Field}>
        <${Field} label="Max time per test (s)" hint="Default 60. Raise it for long journeys."><input type="number" min="5" max="900" placeholder="60" value=${v.run.testTimeout ?? ''} onInput=${(e) => setRun('testTimeout', e.target.value)} /></${Field}>
        <${Field} label="Wait for an element (s)" hint="Default 10. Raise it for slow environments."><input type="number" min="1" max="120" placeholder="10" value=${v.run.waitTimeout ?? ''} onInput=${(e) => setRun('waitTimeout', e.target.value)} /></${Field}>
        <${Field} label="Retries" hint="Re-run a failed test (marked flaky if it then passes)."><input type="number" min="0" max="3" placeholder="0" value=${v.run.retries ?? ''} onInput=${(e) => setRun('retries', e.target.value)} /></${Field}>
      </div>
      <div class="hint">Saved for the whole project (app.yml → run). A single run can still override browsers and retries in Runs → Run settings.</div>
    </div>
    <div class="row between"><div class="row start"><a class="btn primary" href=${`/api/projects/${S.app}/export-code`} title="A standalone Playwright + TypeScript project (Page Objects, specs, data) that runs without this tool">⬇ Export Playwright code</a><a class="btn" href=${`/api/projects/${S.app}/export`} title="The project files, to open in another copy of this tool">⬇ Export project (.zip, no passwords)</a></div><button class="btn primary" style="flex:0 0 auto" onClick=${save}>Save project</button></div>`;
}
