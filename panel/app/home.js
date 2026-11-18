// Step ① — Projects home: open an existing project, create one (guided wizard or blank), import / export.
import { html, useState } from '/vendor/preact-htm.js';
import { useStore, api, toast, go, loadProjects, store } from './core.js';
import { Modal, Field, Console } from './ui.js';

const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const ago = (iso) => {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleDateString();
};

export function Home() {
  const s = useStore();
  const [modal, setModal] = useState(null);
  const importZip = async (file) => {
    if (!file) return;
    const b64 = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(file); });
    try { const r = await api('/api/projects/import', { method: 'POST', body: { zip: b64 } }); toast(`Imported "${r.key}" ✔ — add passwords in Data & settings`); loadProjects(); }
    catch (e) { toast(e.message); }
  };
  return html`<main class="content" style="max-width:1300px;margin:0 auto">
    <div class="hero">
      <div><h1>Projects</h1><div class="muted">Pick a project to continue, or start a new one.</div></div>
      <div class="row start">
        <label class="btn">⬆ Import project (.zip)<input type="file" accept=".zip" style="display:none" onChange=${(e) => importZip(e.target.files[0])} /></label>
        <button class="btn" onClick=${() => setModal('blank')}>Blank project</button>
        <button class="btn primary" onClick=${() => setModal('wizard')}>＋ New project (guided)</button>
      </div>
    </div>
    <div class="projects">
      <div class="card newcard" onClick=${() => setModal('wizard')}>
        <div><div style="font-size:28px">＋</div><b>New project</b><div class="muted small">Website → login → pages → starter tests, in 3 steps</div></div>
      </div>
      ${s.projects.map((p) => {
        const run = p.lastRun, c = run?.counts;
        const rate = c ? Math.round(((c.passed + c.flaky) / Math.max(1, c.total - c.skipped)) * 100) : null;
        return html`<div class="card pcard">
          <div class="row between"><div><b style="font-size:15px">${p.name}</b><div class="muted small">${p.key} · ${p.baseURL ?? ''}</div></div>
            ${rate !== null ? html`<span class="badge ${c.failed ? 'bad' : 'ok'}">${rate}% · ${ago(run.started)}</span>` : html`<span class="badge">not run yet</span>`}</div>
          ${p.error ? html`<div class="err">${p.error}</div>` : html`<div class="stats">
            <span><b>${p.pages}</b>pages</span><span><b>${p.cases}</b>cases</span><span><b>${p.tests}</b>tests</span><span><b>${p.envs?.length}</b>envs</span><span><b>${p.users}</b>users</span></div>`}
          <div class="row start" style="margin-top:4px">
            <a class="btn primary sm" href=${`#/p/${p.key}/${p.pages ? 'builder' : 'pages'}`}>Open</a>
            <a class="btn sm" href=${`#/p/${p.key}/run`}>▶ Run & reports</a>
            <a class="btn sm" href=${`/api/projects/${p.key}/export-code`} title="Standalone Playwright + TypeScript project — runs without this tool">⬇ Code</a>
            <a class="btn sm" href=${`/api/projects/${p.key}/export`} title="Download the project for another copy of this tool (without passwords)">⬇ Project</a>
          </div></div>`;
      })}
    </div>
    ${modal === 'wizard' && html`<${Wizard} onClose=${() => { setModal(null); loadProjects(); }} />`}
    ${modal === 'blank' && html`<${BlankProject} onClose=${() => setModal(null)} />`}
  </main>`;
}

function BlankProject({ onClose }) {
  const [v, setV] = useState({ name: '', key: '', envName: 'uat', baseURL: '', testIdAttribute: 'data-testid', ar: false });
  const set = (k) => (e) => setV({ ...v, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value, ...(k === 'name' ? { key: slug(e.target.value) } : {}) });
  const create = async () => {
    try { const r = await api('/api/projects', { method: 'POST', body: { ...v, languages: v.ar ? ['en', 'ar'] : ['en'] } }); onClose(); go(`#/p/${r.key}/pages`); }
    catch (e) { toast(e.message); }
  };
  return html`<${Modal} title="Blank project" onClose=${onClose}>
    <p class="muted small">Creates an empty project. You collect pages and set users yourself — use the guided wizard to do it automatically.</p>
    <div class="row"><${Field} label="Project name"><input type="text" value=${v.name} onInput=${set('name')} placeholder="Clinic Portal" /></${Field}>
      <${Field} label="Key (folder)"><input type="text" value=${v.key} onInput=${set('key')} /></${Field}></div>
    <div class="row"><${Field} label="Environment"><input type="text" value=${v.envName} onInput=${set('envName')} /></${Field}>
      <${Field} label="Website address" style="flex:2"><input type="url" value=${v.baseURL} onInput=${set('baseURL')} placeholder="https://uat.example.com" /></${Field}></div>
    <div class="row"><${Field} label="Test-id attribute"><input type="text" value=${v.testIdAttribute} onInput=${set('testIdAttribute')} /></${Field}>
      <label class="check"><input type="checkbox" checked=${v.ar} onChange=${set('ar')} /> Arabic UI too</label></div>
    <div class="row between" style="margin-top:10px"><span></span><button class="btn primary" style="flex:0" onClick=${create}>Create project</button></div>
  </${Modal}>`;
}

// ------------------------------------------------------------------ guided wizard
function Wizard({ onClose }) {
  const [step, setStep] = useState(1);
  const [site, setSite] = useState({ name: '', key: '', envName: 'uat', baseURL: '', ignoreHTTPSErrors: false, baUser: '', baPass: '' });
  const [check, setCheck] = useState(null);
  const [testId, setTestId] = useState('data-testid');
  const [langs, setLangs] = useState({ en: true, ar: false });
  const [hasLogin, setHasLogin] = useState(true);
  const [loginPath, setLoginPath] = useState('/');
  const [analysis, setAnalysis] = useState(null);
  const [map, setMap] = useState({});
  const [users, setUsers] = useState([{ key: 'standard', username: '', password: '' }]);
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);
  const [created, setCreated] = useState(null);
  const siteBody = () => ({ baseURL: site.baseURL.trim(), ignoreHTTPSErrors: site.ignoreHTTPSErrors, httpCredentials: site.baUser ? { username: site.baUser, password: site.baPass } : undefined });
  const setS = (k) => (e) => setSite({ ...site, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value, ...(k === 'name' ? { key: slug(e.target.value) } : {}) });

  const doCheck = async () => {
    if (!/^https?:\/\//.test(site.baseURL)) return toast('Enter the full address, starting with http:// or https://');
    const host = new URL(site.baseURL).hostname;
    if (!site.name) setSite((x) => ({ ...x, name: host, key: slug(host.split('.')[0]) }));
    setBusy('check');
    const r = await api('/api/wizard/check', { method: 'POST', body: siteBody() }).catch((e) => ({ ok: false, error: e.message }));
    setBusy('');
    setCheck(r);
    if (r.ok) { setTestId(r.suggestedTestId); setLangs({ en: true, ar: !!r.arabic }); setLoginPath(r.loginPath || '/'); setHasLogin(!!r.hasPasswordField); }
  };
  const doAnalyze = async () => {
    setBusy('analyze');
    const r = await api('/api/wizard/analyzeLogin', { method: 'POST', body: { ...siteBody(), loginPath, testIdAttribute: testId } }).catch((e) => ({ ok: false, error: e.message }));
    setBusy('');
    setAnalysis(r);
    if (r.ok) setMap({ username: r.guess.username, password: r.guess.password, submit: r.guess.submit });
  };
  const doCreate = async () => {
    if (hasLogin && !analysis?.ok) return toast('Analyze the login page first');
    if (hasLogin && !users[0].username) return toast('Add at least one test user');
    store.set({ log: [] });
    setBusy('create'); setResult(null);
    const body = {
      key: site.key || slug(site.name), name: site.name, envName: site.envName || 'uat', ...siteBody(), testIdAttribute: testId,
      languages: Object.entries(langs).filter(([, on]) => on).map(([l]) => l), users: hasLogin ? users : [], overwrite: !!created,
      login: hasLogin ? { path: new URL(analysis.finalURL).pathname, elements: analysis.elements, mapping: map } : undefined,
    };
    try {
      const c = await api('/api/wizard/create', { method: 'POST', body });
      if (!c.ok) throw new Error(c.error);
      setCreated(c.key);
      const b = await api('/api/wizard/bootstrap', { method: 'POST', body: { key: c.key, envName: body.envName } });
      setResult(b);
    } catch (e) { setResult({ ok: false, error: e.message }); }
    setBusy('');
  };
  const inputs = (analysis?.elements ?? []).filter((e) => ['input', 'textarea'].includes(e.tag));
  const buttons = (analysis?.elements ?? []).filter((e) => e.role === 'button' || ['button', 'a'].includes(e.tag));
  const bar = ['Website', 'Login', 'Create & verify', 'Ready'];

  return html`<${Modal} wide title="New project" onClose=${onClose}>
    <div class="muted small">Point the tool at a web application — it prepares everything needed to start testing, no code.</div>
    <div class="steps-bar">${bar.map((t, i) => html`<div class=${i + 1 === step ? 'on' : i + 1 < step ? 'done' : ''}>${i + 1} · ${t}</div>`)}</div>

    ${step === 1 && html`<div class="grid2">
      <div>
        <${Field} label="Project name"><input type="text" value=${site.name} onInput=${setS('name')} placeholder="Clinic Portal" /></${Field}>
        <${Field} label="Key (folder name)"><input type="text" value=${site.key} onInput=${setS('key')} placeholder="clinic-portal" /></${Field}>
        <div class="row"><${Field} label="Environment"><input type="text" value=${site.envName} onInput=${setS('envName')} /></${Field}>
          <${Field} label="Website address" style="flex:2"><input type="url" value=${site.baseURL} onInput=${setS('baseURL')} placeholder="https://uat.example.com" /></${Field}></div>
        <details><summary class="small sec">Advanced (certificates, basic auth)</summary>
          <label class="check"><input type="checkbox" checked=${site.ignoreHTTPSErrors} onChange=${setS('ignoreHTTPSErrors')} /> Ignore HTTPS certificate errors</label>
          <div class="row"><${Field} label="Basic-auth user"><input type="text" value=${site.baUser} onInput=${setS('baUser')} /></${Field}>
            <${Field} label="Basic-auth password"><input type="password" value=${site.baPass} onInput=${setS('baPass')} /></${Field}></div>
        </details>
        <button class="btn primary" style="margin-top:12px" disabled=${busy} onClick=${doCheck}>${busy === 'check' ? html`<span class="spin"></span> Checking…` : 'Check website'}</button>
      </div>
      <div>${!check ? html`<div class="info">Press <b>Check website</b>: the tool opens the site and detects the language, the test-id attribute the developers use, and whether there is a login form.</div>`
        : !check.ok ? html`<div class="err">Could not open the website:\n${check.error}</div>`
        : html`<div class="okbox">✔ Reached <b>${check.title || check.finalURL}</b></div><img class="shot" src=${check.screenshot} />
          <${Field} label="Test-id attribute used by the developers" hint=${check.testIdCandidates.length ? 'Detected automatically.' : 'No test ids found — roles, labels and text will be used. Ask developers to add data-testid.'}>
            <select value=${testId} onChange=${(e) => setTestId(e.target.value)}>${[...new Set([...check.testIdCandidates.map((c) => c.attr), 'data-testid', 'data-test', 'data-qa', 'data-cy'])].map((a) => { const c = check.testIdCandidates.find((x) => x.attr === a); return html`<option value=${a}>${a}${c ? ` — ${c.count} element(s)` : ''}</option>`; })}</select></${Field}>
          <div class="row start"><label class="check"><input type="checkbox" checked=${langs.en} onChange=${(e) => setLangs({ ...langs, en: e.target.checked })} /> English</label>
            <label class="check"><input type="checkbox" checked=${langs.ar} onChange=${(e) => setLangs({ ...langs, ar: e.target.checked })} /> العربية</label></div>
          <div class="hint">${check.hasPasswordField ? '🔑 A login form was found on this page.' : 'No login form on the first page.'}</div>`}</div>
    </div>
    <div class="row between" style="margin-top:16px"><span></span><button class="btn primary" style="flex:0" disabled=${!check?.ok} onClick=${() => { setStep(2); if (!analysis && hasLogin) doAnalyze(); }}>Next →</button></div>`}

    ${step === 2 && html`<div>
      <div class="row start"><label class="check"><input type="radio" checked=${hasLogin} onChange=${() => { setHasLogin(true); if (!analysis) doAnalyze(); }} /> The site has a login page</label>
        <label class="check"><input type="radio" checked=${!hasLogin} onChange=${() => setHasLogin(false)} /> No login needed</label></div>
      ${hasLogin && html`<div class="grid2">
        <div>
          <div class="row"><${Field} label="Login page path" style="flex:2"><input type="text" value=${loginPath} onInput=${(e) => setLoginPath(e.target.value)} /></${Field}>
            <div style="flex:0;margin-bottom:10px"><button class="btn" disabled=${busy} onClick=${doAnalyze}>${busy === 'analyze' ? html`<span class="spin"></span>` : 'Analyze'}</button></div></div>
          ${analysis && (!analysis.ok ? html`<div class="err">${analysis.error}</div>` : html`
            <div class=${analysis.guess.password ? 'okbox' : 'err'}>${analysis.guess.password ? '✔ Login fields detected — check they are right:' : 'No password field found. Check the login path.'}</div>
            <div class="row">
              ${[['username', 'Username field', inputs], ['password', 'Password field', inputs], ['submit', 'Login button', buttons]].map(([k, l, list]) => html`<${Field} label=${l}>
                <select value=${map[k]} onChange=${(e) => setMap({ ...map, [k]: e.target.value })}>${list.map((e) => html`<option value=${e.name}>${e.name}${e.label ? ' — ' + e.label : ''}</option>`)}</select></${Field}>`)}
            </div>`)}
          <h3 style="margin:12px 0 6px">Test users</h3>
          <div class="hint" style="margin-top:0">Passwords are saved in secrets.yml (never committed).</div>
          <table><tr><th>Key</th><th>Username</th><th>Password</th><th></th></tr>
            ${users.map((u, i) => html`<tr>
              <td><input type="text" value=${u.key} style="width:110px" onInput=${(e) => setUsers(users.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} /></td>
              <td><input type="text" value=${u.username} onInput=${(e) => setUsers(users.map((x, j) => (j === i ? { ...x, username: e.target.value } : x)))} /></td>
              <td><input type="password" value=${u.password} onInput=${(e) => setUsers(users.map((x, j) => (j === i ? { ...x, password: e.target.value } : x)))} /></td>
              <td>${i > 0 && html`<button class="btn icon danger" onClick=${() => setUsers(users.filter((_, j) => j !== i))}>✕</button>`}</td></tr>`)}
          </table>
          <button class="btn sm" style="margin-top:6px" onClick=${() => setUsers([...users, { key: 'user' + (users.length + 1), username: '', password: '' }])}>＋ Add user</button>
        </div>
        <div>${analysis?.ok && html`<img class="shot" src=${analysis.screenshot} />`}</div>
      </div>`}
      <div class="row between" style="margin-top:16px"><button class="btn" style="flex:0" onClick=${() => setStep(1)}>← Back</button><button class="btn primary" style="flex:0" onClick=${() => setStep(3)}>Next →</button></div>
    </div>`}

    ${step === 3 && html`<div>
      <div class="info">The tool creates the project folder, logs in with the first user, saves the session, collects the home page with screenshots, and generates starter test cases (positive + negative).</div>
      <button class="btn primary" disabled=${busy} onClick=${doCreate}>${busy === 'create' ? html`<span class="spin"></span> Working…` : created ? 'Create again' : 'Create project & verify login'}</button>
      <div style="margin-top:12px"><${Console} mini /></div>
      ${result && (!result.ok ? html`<div class="err" style="margin-top:12px">${result.error}</div>${result.screenshot && html`<img class="shot" src=${result.screenshot} />`}<div class="hint">Go back, fix the user/password or the field mapping, and create again.</div>`
        : html`<div class="okbox" style="margin-top:12px">✔ ${result.loginOk ? html`Logged in — landed on <b>${result.landingURL}</b>` : 'Project created'} · home page has ${result.homeElements} element(s)</div>
          <div class="grid2">${result.screenshot && html`<div><div class="small muted">After login</div><img class="shot" src=${result.screenshot} /></div>`}<div><div class="small muted">Home page</div><img class="shot" src=${result.homeScreenshot} /></div></div>`)}
      <div class="row between" style="margin-top:16px"><button class="btn" style="flex:0" onClick=${() => setStep(2)}>← Back</button><button class="btn primary" style="flex:0" disabled=${!result?.ok} onClick=${() => setStep(4)}>Next →</button></div>
    </div>`}

    ${step === 4 && html`<div>
      <div class="okbox" style="font-size:15px">✔ <b>${site.name}</b> is ready.</div>
      <ul class="sec">
        <li>Project folder <span class="code">apps/${created}/</span> — environment <b>${site.envName}</b> → ${site.baseURL}</li>
        ${hasLogin ? html`<li>Login page mapped (username, password, submit) with ${users.length} test user(s)</li>` : html`<li>No login</li>`}
        <li>Home page with ${result.homeElements} elements${hasLogin ? ' — tests start logged in' : ''}</li>
        <li>Starter test cases: ${(result.cases || []).join(', ')}</li>
      </ul>
      <div class="row start" style="margin-top:14px">
        <button class="btn primary" onClick=${() => { onClose(); go(`#/p/${created}/pages`); }}>Review pages →</button>
        <button class="btn" onClick=${() => { onClose(); go(`#/p/${created}/builder`); }}>Open test builder</button>
        <button class="btn" onClick=${() => { onClose(); go(`#/p/${created}/run`); }}>Run the starter tests</button>
      </div>
    </div>`}
  </${Modal}>`;
}
