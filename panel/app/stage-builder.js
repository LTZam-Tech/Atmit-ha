// Step ④ — Test builder: no-code cases = steps + expected outcomes + data table (one row = one test).
// Smart, rule-based help: actions that fit each element, the page's own options as values,
// valid values from each field's meaning, and generated negative / boundary rows.
import { html, useState, useEffect } from '/vendor/preact-htm.js';
import { useStore, store, api, toast, loadState, startRun, byTitles } from './core.js';
import { Field, NextStep, Empty, Modal } from './ui.js';
import { suggestedActions, validValue, fieldCases, stepsFromPage, toCSV, parseCSV } from './datagen.js';
import { proposeCases, proposeJourney, fileOf, KIND_ICON } from './casegen.js';

const RESERVED = ['id', 'title', 'type', 'outcome', 'tags', 'skip'];
let focused = null; // { el, apply(value) } — last focused text input, for the { } value helper

function splitRef(ref) {
  const m = /^(\w+\.\w+)(?:\((.*)\))?$/.exec(ref || '');
  if (!m) return { base: ref || '', params: {} };
  const params = {};
  (m[2] || '').split(',').forEach((p) => { const i = p.indexOf('='); if (i > 0) params[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  return { base: m[1], params };
}
const joinRef = (base, params) => (base ? base + (Object.keys(params).length ? `(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(', ')})` : '') : '');
/** OR element definition for "page.element" */
export function elementDef(S, base) {
  const [pg, el] = (base || '').split('.');
  return S.pages.find((p) => p.page === pg)?.elements.find((e) => e.name === el);
}

export function TextIn({ value, onChange, placeholder, style, dir }) {
  return html`<input type="text" value=${value ?? ''} placeholder=${placeholder} style=${style} dir=${dir}
    onInput=${(e) => onChange(e.target.value)} onFocus=${(e) => (focused = { el: e.target, apply: onChange })} />`;
}

/** value picker that offers the options read from the page, plus a custom / {{…}} value */
function OptionValue({ value, options, multi, onChange }) {
  const v = value ?? '';
  const list = v.split(/\s*[,،]\s*/).filter(Boolean);
  const isOpt = (x) => options.some((o) => o.toLowerCase() === x.toLowerCase());
  const [custom, setCustom] = useState(v !== '' && (v.includes('{{') || !list.every(isOpt)));
  if (custom) return html`<div class="valcell"><${TextIn} value=${v} onChange=${onChange} placeholder="value or {{…}}" /><button class="btn icon" title="Pick from the page's options" onClick=${() => { setCustom(false); onChange(multi ? '' : options[0]); }}>▾</button></div>`;
  if (multi) return html`<div class="chips" style="align-items:center">${options.map((o) => {
      const on = list.some((x) => x.toLowerCase() === o.toLowerCase());
      return html`<span class="chip ${on ? 'on' : ''}" onClick=${() => onChange((on ? list.filter((x) => x.toLowerCase() !== o.toLowerCase()) : [...list, o]).join(', '))}>${on ? '☑' : '☐'} ${o}</span>`;
    })}<button class="btn icon" title="Custom value or {{data.…}}" onClick=${() => setCustom(true)}>✎</button></div>`;
  return html`<select value=${isOpt(v) ? options.find((o) => o.toLowerCase() === v.toLowerCase()) : ''} onChange=${(e) => (e.target.value === '__custom' ? setCustom(true) : onChange(e.target.value))}>
    ${!isOpt(v) && html`<option value="">— choose —</option>`}
    ${options.map((o) => html`<option value=${o}>${o}</option>`)}
    <option value="__custom">✎ custom value or {{data.…}}</option></select>`;
}

export function StageBuilder() {
  const s = useStore();
  const S = s.S;
  const [cur, setCur] = useState(null);
  const [issues, setIssues] = useState([]);
  const [pop, setPop] = useState(null);
  const [modal, setModal] = useState(null);
  const [flow, setFlow] = useState(null); // workflow being edited (instead of a case)
  useEffect(() => { const close = (e) => !e.target.closest('.pop') && !e.target.closest('.tokBtn') && setPop(null); document.addEventListener('click', close); return () => document.removeEventListener('click', close); }, []);
  useEffect(() => { if (store.openCase) { const f = store.openCase; store.openCase = null; open(f); } }, [S.cases.length]);
  useEffect(() => { if (store.newCase) create(); if (store.editProposal) { const pr = store.editProposal; store.editProposal = null; editProposal(pr); } }, []);

  const open = async (file) => {
    setFlow(null);
    try {
      const d = await api(`/api/cases/${encodeURIComponent(file)}?app=${S.app}`);
      const clean = (list) => list.filter((x) => !x.error);
      setCur({ file: d.file, isNew: false, case: d.case, description: d.description, page: d.page, tags: (d.tags || []).join(', '),
        module: d.module || '', type: d.type || '', user: d.user || '', url: d.url || '', dependsOn: d.dependsOn || [], continueFrom: d.continueFrom || null,
        steps: clean(d.steps), outcomes: Object.entries(d.outcomes).map(([name, steps]) => ({ name, steps: clean(steps) })), data: d.data.map((r) => ({ ...r })), extra: [] });
      setIssues(S.caseIssues.filter((i) => i.file === file).map((i) => i.message));
    } catch (e) { toast(e.message); }
  };
  const create = () => {
    setFlow(null);
    const start = S.pages.find((p) => p.page === 'home')?.page || S.pages[0]?.page || '';
    const seed = store.newCase; store.newCase = null; // e.g. "continue from this test" (Run & reports)
    setCur({ file: '', isNew: true, case: '', description: '', page: seed?.continueFrom ? '' : start, tags: '', steps: [], extra: [],
      module: seed?.module || '', type: 'positive', user: '', url: '', dependsOn: [], continueFrom: seed?.continueFrom || null,
      outcomes: [{ name: 'success', steps: [] }, { name: 'error', steps: [] }],
      data: [{ id: 'TC-001', title: '' }] });
    setIssues([]);
  };
  /** opens a generated proposal in the editor, not saved yet */
  const editProposal = (p) => {
    const c = p.case;
    setCur({ file: fileOf(c.case).replace(/\.case\.yml$/, ''), isNew: true, case: c.case, description: '', page: c.page, tags: c.tags.join(', '), module: c.module, type: c.type || '', user: '', url: '', dependsOn: [], continueFrom: null,
      steps: c.steps, extra: [], outcomes: [{ name: 'success', steps: c.outcomes.success ?? [] }, { name: 'error', steps: c.outcomes.error ?? [] }], data: c.data.map((r) => ({ ...r })) });
    setIssues([]);
    toast('Review the case, then 💾 Save');
  };
  const save = async () => {
    if (!cur.case.trim()) { toast('Give the test case a name'); return null; }
    const filled = completeRows(S, cur);
    const c = filled.n ? { ...cur, data: filled.data } : cur; // rows created before a field existed get a valid value
    const file = c.isNew ? (c.file || c.case).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.case.yml' : c.file;
    try {
      const r = await api(`/api/cases/${encodeURIComponent(file)}`, { method: 'PUT', body: { app: S.app, case: c.case, description: c.description, page: c.continueFrom ? '' : c.page, module: c.module.trim(), type: c.type || '', user: c.continueFrom ? '' : c.user, url: c.continueFrom ? '' : c.url.trim(), dependsOn: c.dependsOn, continueFrom: c.continueFrom,
        tags: c.tags.split(',').map((t) => t.trim()).filter(Boolean), steps: c.steps, outcomes: Object.fromEntries(c.outcomes.filter((o) => o.name).map((o) => [o.name, o.steps])), data: c.data } });
      setCur({ ...c, file: r.file, isNew: false });
      setIssues(r.issues.map((i) => i.message));
      toast((r.issues.length ? `Saved with ${r.issues.length} issue(s) to fix` : 'Saved ✔') + (filled.n ? ` · ${filled.n} missing value(s) filled` : ''));
      loadState();
      return r;
    } catch (e) { toast(e.message); return null; }
  };
  const run = async () => {
    const r = await save();
    if (!r) return;
    if (r.issues.length) return toast('Fix the issues first');
    const depTitles = [];
    const addDeps = (ids) => ids.forEach((id) => { const c = S.cases.find((x) => x.id === id); if (c) { depTitles.push(...c.rowTitles); addDeps(c.dependsOn); } });
    addDeps(cur.dependsOn);
    startRun({ ...byTitles([...depTitles, ...(cur.data.length ? cur.data : [{}]).map((row) => (row.id ? row.id + ' · ' : '') + (row.title || cur.case))]), label: `case "${cur.case}"${depTitles.length ? ' (with the cases it depends on)' : ''}` });
  };
  const del = async () => {
    if (!confirm(`Delete test case "${cur.case}"?`)) return;
    await api(`/api/cases/${encodeURIComponent(cur.file)}?app=${S.app}`, { method: 'DELETE' });
    setCur(null); loadState();
  };
  const issuesBy = {};
  S.caseIssues.forEach((i) => (issuesBy[i.file] ||= []).push(i.message));

  return html`
    <div class="page-title"><h1>Tests</h1><span class="sub">Build tests from the pages — no code</span></div>
    ${!S.pages.length && html`<div class="warnbox">Collect pages first — steps pick their elements from the pages.</div>`}
    ${S.cases.length > 0 && !S.caseIssues.length && html`<${NextStep} text="Cases ready. Next: run them and look at the report." to=${`#/p/${S.app}/run`} label="Runs" />`}
    <div class="cases">
      <div class="clist">
        <button class="btn primary" style="width:100%;margin-bottom:8px" disabled=${!S.pages.length} onClick=${() => setModal('generate')} title="Proposes complete test cases from the collected pages — you review them before saving">✨ Generate test cases</button>
        <button class="btn" style="width:100%;margin-bottom:10px" onClick=${create}>＋ New test case</button>
        ${modulesOf(S.cases).map(([mod, list]) => html`<div class="small sec" style="margin:12px 0 4px">📁 ${mod || 'No module'} <span class="muted">(${list.length})</span></div>
          ${list.map((c) => html`<div class="ci ${cur?.file === c.file ? 'on' : ''}" onClick=${() => open(c.file)}>
          <b>${c.case}</b> ${issuesBy[c.file] && html`<span class="badge bad">${issuesBy[c.file].length} issue(s)</span>`}
          <div class="muted small">${c.steps} step(s) · ${c.rows} test(s)${c.continueFrom ? ` · ↪ after ${caseName(S, c.continueFrom.case)}` : c.page ? ' · starts on ' + c.page : ''}${c.dependsOn.length ? ` · ⛓ after ${c.dependsOn.map((d) => caseName(S, d)).join(', ')}` : ''}</div></div>`)}`)}
        ${Object.keys(issuesBy).filter((f) => !S.cases.some((c) => c.file === f)).map((f) => html`<div class="ci" onClick=${() => open(f)}><b>${f}</b> <span class="badge bad">cannot load</span></div>`)}
        <a class="btn" style="width:100%;margin:14px 0 0;text-align:center" href=${`#/p/${S.app}/explore`} title="Walk through the application from its address: pages are scanned and saved, next steps are suggested, the journey becomes a workflow">🧭 Explore & build a workflow</a>
        <div class="row between" style="margin:16px 0 4px"><span class="small sec">🔗 Workflows <span class="muted">(${S.flows.length})</span></span>
          <button class="btn sm" style="flex:0 0 auto" disabled=${!S.cases.length} onClick=${() => { setCur(null); setFlow({ file: '', isNew: true, flow: '', description: '', module: '', tags: '', steps: [] }); }} title="Chain test cases in one browser session">＋ Workflow</button></div>
        ${S.flows.map((f) => { const n = S.flowIssues.filter((i) => i.file === f.file).length;
          return html`<div class="ci ${flow?.file === f.file ? 'on' : ''}" onClick=${() => { setCur(null); setFlow({ ...f, isNew: false, tags: f.tags.join(', ') }); }}>
          <b>${f.flow}</b> ${n > 0 && html`<span class="badge bad">${n} issue(s)</span>`}<div class="muted small">${f.steps.length} case(s) in one session${f.module ? ' · ' + f.module : ''}</div></div>`; })}
        <div class="card" style="margin-top:14px;opacity:.8"><b class="small">Tips</b><div class="muted small">⚡ <b>Steps from a page</b> builds a form test in one click. ⚙ <b>Generate test data</b> adds negative and boundary rows from the field rules. 🎬 Record a journey from Pages.</div></div>
      </div>
      <div>${flow && !cur ? html`<${FlowEditor} flow=${flow} setFlow=${setFlow} />` : cur ? html`<${Editor} cur=${cur} setCur=${setCur} issues=${issues} onSave=${save} onRun=${run} onDelete=${del} setPop=${setPop} setModal=${setModal} />`
        : html`<div class="card"><${Empty}>Pick a test case on the left, or create a new one.<br /><br />A test case = steps (Open → Type → Click → Verify) + expected outcomes + a data table where every row is one test (positive or negative).</${Empty}></div>`}</div>
    </div>
    ${pop && html`<${TokenPop} at=${pop} cur=${cur} setCur=${setCur} close=${() => setPop(null)} />`}
    ${modal === 'gen' && cur && html`<${GenerateModal} cur=${cur} setCur=${setCur} close=${() => setModal(null)} />`}
    ${modal === 'page' && cur && html`<${FromPageModal} cur=${cur} setCur=${setCur} close=${() => setModal(null)} />`}
    ${modal === 'generate' && html`<${GenerateCasesModal} close=${() => setModal(null)} onEdit=${(p) => { setModal(null); editProposal(p); }} />`}`;
}

const modulesOf = (cases) => {
  const m = new Map();
  for (const c of cases) m.set(c.module || '', [...(m.get(c.module || '') ?? []), c]);
  return [...m.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
};
const caseName = (S, id) => S.cases.find((c) => c.id === id)?.case ?? id;
const DEFAULT_OUTCOMES = ['success', 'error'];
/** runtime values a case can use from the start: saved by the cases it depends on / continues from */
export function inheritedVars(S, cur) {
  const out = new Set(), seen = new Set();
  const walk = (id) => { if (seen.has(id)) return; seen.add(id); const c = S.cases.find((x) => x.id === id); if (!c) return; c.saves.forEach((v) => out.add(v)); c.dependsOn.forEach(walk); if (c.continueFrom) walk(c.continueFrom.case); };
  (cur.dependsOn || []).forEach(walk);
  if (cur.continueFrom) walk(cur.continueFrom.case);
  return [...out];
}

/** the row that holds the "normal" valid data: TC-001 / "valid data" / a positive row that is not a boundary row */
function baseRow(cur) {
  return cur.data.find((r) => r.id === 'TC-001' || /valid data/i.test(r.title || ''))
    ?? cur.data.find((r) => r.type !== 'negative' && !/-(BVA|NEG|SEC)-/.test(r.id || ''))
    ?? {};
}
/** a valid value for every data field (from the base row, else from the field's meaning and rules) */
function validValues(S, cur) {
  const binds = fieldBindings(S, cur), base = baseRow(cur);
  return Object.fromEntries(dataFields(cur).map((f) => [f,
    base[f] !== undefined && base[f] !== '' ? base[f] : binds[f] && binds[f].def.control !== 'checkbox' ? validValue(binds[f].def) : '']));
}
/** rows created before a field existed get a valid value for it (never overwrites a value, '' stays '') */
export function completeRows(S, cur) {
  const valid = validValues(S, cur);
  let n = 0;
  const data = cur.data.map((r) => {
    const out = { ...r };
    for (const [f, v] of Object.entries(valid)) if (out[f] === undefined) { out[f] = v; n++; }
    return out;
  });
  return { data, n };
}
/** next free id like TC-NEG-013 (numbers never repeat, even after rows were deleted) */
function nextIds(cur) {
  let max = Math.max(0, ...cur.data.map((r) => Number(/(\d+)$/.exec(r.id || '')?.[1] ?? 0)));
  return (prefix) => `TC-${prefix ? prefix + '-' : ''}${String(++max).padStart(3, '0')}`;
}

function dataFields(cur) {
  const used = new Set();
  for (const m of JSON.stringify([cur.steps, cur.outcomes]).matchAll(/\{\{\s*data\.(\w+)\s*\}\}/g)) used.add(m[1]);
  for (const r of cur.data) for (const k of Object.keys(r)) if (!RESERVED.includes(k)) used.add(k);
  (cur.extra || []).forEach((f) => used.add(f));
  return [...used];
}

/** data field → { def, action } of the step that types / picks it */
function fieldBindings(S, cur) {
  const map = {};
  for (const st of [...cur.steps, ...cur.outcomes.flatMap((o) => o.steps)]) {
    for (const m of JSON.stringify([st.value, st.expected]).matchAll(/\{\{\s*data\.(\w+)\s*\}\}/g)) {
      if (map[m[1]]) continue;
      const e = elementDef(S, splitRef(st.element).base);
      if (e) map[m[1]] = { def: e.def, action: st.action, element: st.element };
    }
  }
  return map;
}
const ruleChip = (def) => [def.semantic, def.rules?.required && 'required', def.rules?.maxlength && `max ${def.rules.maxlength}`, def.rules?.minlength && `min ${def.rules.minlength}`,
  def.rules?.min !== undefined && `≥ ${def.rules.min}`, def.rules?.max !== undefined && `≤ ${def.rules.max}`, def.options?.length && `${def.options.length} options`].filter(Boolean).join(' · ');

function Editor({ cur, setCur, issues, onSave, onRun, onDelete, setPop, setModal }) {
  const s = useStore();
  const S = s.S;
  const fields = dataFields(cur);
  const binds = fieldBindings(S, cur);
  const outcomeNames = cur.outcomes.map((o) => o.name).filter(Boolean);
  const typed = cur.type === 'positive' || cur.type === 'negative';
  const rowType = (r) => (typed ? cur.type : r.type);
  const otherRows = typed ? cur.data.filter((r) => r.type && r.type !== cur.type) : [];
  const mixed = !typed && cur.data.some((r) => r.type === 'negative') && cur.data.some((r) => r.type !== 'negative');
  const showResult = outcomeNames.some((n) => !DEFAULT_OUTCOMES.includes(n)) || cur.data.some((r) => r.outcome && !(r.outcome === 'success' && r.type !== 'negative') && !(r.outcome === 'error' && r.type === 'negative'));
  const setSteps = (which, steps) => (which === 'main' ? setCur({ ...cur, steps }) : setCur({ ...cur, outcomes: cur.outcomes.map((o, i) => (i === which ? { ...o, steps } : o)) }));
  const setRow = (i, k, v) => setCur({ ...cur, data: cur.data.map((r, j) => (j === i ? { ...r, [k]: v } : r)) });
  const fillValid = () => {
    // every row: fields it does not have yet; positive rows: empty cells too
    const valid = validValues(S, cur);
    let n = 0;
    const data = cur.data.map((r) => {
      const out = { ...r };
      for (const [f, v] of Object.entries(valid)) if (out[f] === undefined || (out[f] === '' && r.type !== 'negative' && v !== '')) { out[f] = v; n++; }
      return out;
    });
    setCur({ ...cur, data });
    toast(n ? `${n} value(s) filled with valid data` : 'Nothing to fill — every row has its values');
  };
  const pos = (cur.data.length ? cur.data : [{}]).some((r) => rowType(r) !== 'negative' && !r.outcome), neg = (cur.data.length ? cur.data : [{}]).some((r) => rowType(r) === 'negative' && !r.outcome);
  const okSteps = cur.outcomes.find((o) => o.name === 'success')?.steps.length, errSteps = cur.outcomes.find((o) => o.name === 'error')?.steps.length;
  const VERIFY = ['visible', 'hidden', 'enabled', 'disabled', 'text', 'value', 'count', 'url', 'title', 'waitFor'];
  const stepsCheck = cur.steps.some((st) => VERIFY.includes(st.action)); // checks written inside the steps count too
  const missingChecks = stepsCheck ? [] : [pos && !okSteps && (typed ? 'the expected result' : '✔ When it works (positive rows)'), neg && !errSteps && (typed ? 'the expected result' : '✖ When it is rejected (negative rows)')].filter(Boolean);
  const exportCSV = () => {
    const blob = new Blob([toCSV(cur.data, fields)], { type: 'text/csv;charset=utf-8' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${(cur.file || cur.case || 'case').replace(/\.case\.yml$/, '')}.csv` });
    a.click(); URL.revokeObjectURL(a.href);
  };
  const importCSV = async (file) => {
    if (!file) return;
    const rows = parseCSV(await file.text());
    if (!rows.length) return toast('The file has no rows');
    const replace = confirm(`Import ${rows.length} row(s).\n\nOK = replace the current rows\nCancel = add them after the current rows`);
    const extra = [...new Set([...(cur.extra || []), ...Object.keys(rows[0]).filter((k) => !RESERVED.includes(k))])];
    setCur({ ...cur, extra, data: replace ? rows : [...cur.data, ...rows] });
    toast(`${rows.length} row(s) imported — press Save`);
  };
  return html`<div class="card">
    ${issues.length > 0 && html`<div class="err"><b>Fix before running:</b>\n• ${issues.join('\n• ')}${issues.some((i) => /missing value for/.test(i)) ? html`\n\n<button class="btn sm" onClick=${fillValid}>⚡ Fill the missing values</button>` : ''}</div>`}
    ${missingChecks.length > 0 && cur.steps.length > 0 && html`<div class="warnbox">Nothing is checked after the steps for: <b>${missingChecks.join(' · ')}</b>. Without a check these tests pass even when the application is wrong — add e.g. "Is visible: success message" or "Text: error message" in 2 · Expected result.</div>`}
    <div class="row">
      <${Field} label="Test case name" style="flex:2"><input type="text" value=${cur.case} onInput=${(e) => setCur({ ...cur, case: e.target.value })} placeholder="Create patient" /></${Field}>
      <${Field} label="Module"><input type="text" list="modules" value=${cur.module} onInput=${(e) => setCur({ ...cur, module: e.target.value })} placeholder="Registration" />
        <datalist id="modules">${[...new Set(S.cases.map((c) => c.module).filter(Boolean))].map((m) => html`<option value=${m} />`)}</datalist></${Field}>
      <${Field} label="Scenario"><select value=${cur.type || ''} onChange=${(e) => setCur({ ...cur, type: e.target.value })}>
        <option value="positive">✔ Positive — must succeed</option><option value="negative">✖ Negative — must be rejected</option><option value="">Mixed rows (old style)</option></select></${Field}>
      <${Field} label="Tags"><input type="text" value=${cur.tags} onInput=${(e) => setCur({ ...cur, tags: e.target.value })} placeholder="@smoke, @regression" /></${Field}>
    </div>
    ${(mixed || otherRows.length > 0) && html`<div class="warnbox">${mixed
      ? html`This case mixes positive and negative rows. One test case should be one scenario with one expected result.`
      : html`${otherRows.length} row(s) are ${otherRows[0].type} but the case is ${cur.type}.`}
      <button class="btn sm" style="margin-left:8px" onClick=${() => splitCase(S, cur, setCur, typed ? otherRows : null)}>✂ Split into a positive and a negative case</button></div>`}
    <${StartAndOrder} cur=${cur} setCur=${setCur} />
    ${cur.isNew ? html`<${Field} label="File name" hint="Saved in apps/${S.app}/cases/"><input type="text" value=${cur.file} onInput=${(e) => setCur({ ...cur, file: e.target.value })} placeholder="create-patient" /></${Field}>`
      : html`<div class="hint" style="margin-top:-4px">apps/${S.app}/cases/${cur.file}</div>`}
    <${Field} label="Description"><input type="text" value=${cur.description} onInput=${(e) => setCur({ ...cur, description: e.target.value })} /></${Field}>

    <div class="section"><h3>1 · Steps</h3><span class="muted small">pick the element first — the right action and the page's options follow</span><span style="flex:1"></span>
      <button class="btn sm" onClick=${() => setModal('page')}>⚡ Steps from a page</button></div>
    <${Steps} steps=${cur.steps} onChange=${(st) => setSteps('main', st)} setPop=${setPop} defAction="fill" />

    <div class="section"><h3>2 · Expected result</h3><span class="muted small">${typed ? (cur.type === 'positive' ? 'what proves the scenario succeeded — checked for every row' : 'what proves the input was rejected — checked for every row') : 'positive rows are checked with "when it works", negative rows with "when it is rejected"'}</span></div>
    ${ensureDefaults(cur.outcomes).filter((o) => !typed || o.name === (cur.type === 'positive' ? 'success' : 'error') || !DEFAULT_OUTCOMES.includes(o.name)).map((o) => { const oi = cur.outcomes.indexOf(o); const std = DEFAULT_OUTCOMES.includes(o.name);
      const setO = (steps) => (oi < 0 ? setCur({ ...cur, outcomes: [...cur.outcomes, { name: o.name, steps }] }) : setSteps(oi, steps));
      return html`<div class="outcome">
      <div class="row between" style="margin-bottom:8px">${std
        ? html`<b class="small">${o.name === 'success' ? '✔ When it works' : '✖ When it is rejected'}${typed ? '' : html` <span class="muted" style="font-weight:400">— ${o.name === 'success' ? 'positive' : 'negative'} rows</span>`}</b>`
        : html`<div class="row start"><b class="small sec">Other result</b><input type="text" style="width:220px" value=${o.name} onInput=${(e) => setCur({ ...cur, outcomes: cur.outcomes.map((x, i) => (i === oi ? { ...x, name: e.target.value } : x)) })} placeholder="e.g. warning" /><span class="muted small">rows pick it in the Result column</span></div>
          <button class="btn sm danger" onClick=${() => setCur({ ...cur, outcomes: cur.outcomes.filter((_, i) => i !== oi), data: cur.data.map((r) => (r.outcome === o.name ? { ...r, outcome: undefined } : r)) })}>Remove</button>`}</div>
      <${Steps} steps=${o.steps} onChange=${setO} setPop=${setPop} defAction="visible" verify /></div>`; })}
    <button class="btn sm" onClick=${() => setCur({ ...cur, outcomes: [...cur.outcomes, { name: '', steps: [] }] })} title="For rows that end differently (e.g. a warning). Most cases need only the two above.">＋ Other result (advanced)</button>

    <div class="section"><h3>3 · Test data</h3><span class="muted small">one row = one test</span><span style="flex:1"></span>
      <div class="row start">
        <button class="btn sm" onClick=${fillValid} title="Fill empty cells of positive rows with valid values (from each field's meaning and rules)">⚡ Fill valid values</button>
        <button class="btn sm primary" onClick=${() => setModal('gen')} title="Negative and boundary rows from the field rules (EP, BVA, required, format, security)">⚙ Generate test data…</button>
        <button class="btn sm" onClick=${exportCSV}>⬇ CSV</button>
        <label class="btn sm">⬆ CSV<input type="file" accept=".csv,text/csv" style="display:none" onChange=${(e) => { importCSV(e.target.files[0]); e.target.value = ''; }} /></label>
        <button class="btn sm" onClick=${() => { const f = prompt('New data field (e.g. email):'); if (f && /^\w+$/.test(f)) setCur({ ...cur, extra: [...(cur.extra || []), f] }); }}>＋ Field</button>
      </div></div>
    <div class="dtable"><table>
      <tr><th>ID</th><th>Title</th>${!typed && html`<th>Type</th>`}${showResult && html`<th>Result</th>`}${fields.map((f) => html`<th>${f}${binds[f] && html`<div class="muted" style="font-weight:400;font-size:10px">${ruleChip(binds[f].def)}</div>`}</th>`)}<th></th></tr>
      ${cur.data.map((r, ri) => html`<tr>
        <td><${TextIn} value=${r.id} onChange=${(v) => setRow(ri, 'id', v)} style="min-width:100px" /></td>
        <td><${TextIn} value=${r.title} onChange=${(v) => setRow(ri, 'title', v)} style="min-width:180px" /></td>
        ${!typed && html`<td><select value=${r.type ?? ''} onChange=${(e) => setRow(ri, 'type', e.target.value)}><option value="">—</option><option value="positive">positive</option><option value="negative">negative</option></select></td>`}
        ${showResult && html`<td><select value=${r.outcome ?? ''} onChange=${(e) => setRow(ri, 'outcome', e.target.value || undefined)}><option value="">by type</option>${outcomeNames.map((o) => html`<option value=${o}>${o}</option>`)}</select></td>`}
        ${fields.map((f) => {
          const b = binds[f];
          return html`<td>${b?.def.options?.length && ['select', 'choose', 'check', 'uncheck', 'value'].includes(b.action)
            ? html`<${OptionValue} key=${f + ri} value=${r[f]} options=${b.def.options} multi=${b.def.control === 'checkgroup'} onChange=${(v) => setRow(ri, f, v)} />`
            : html`<${TextIn} value=${r[f]} onChange=${(v) => setRow(ri, f, v)} placeholder=${r[f] === undefined ? '(not set)' : ''} />`}</td>`;
        })}
        <td style="white-space:nowrap"><button class="btn icon tokBtn" title="Insert a value" onClick=${(e) => setPop(e.currentTarget.getBoundingClientRect())}>{ }</button>
          <button class="btn icon" title="Duplicate" onClick=${() => setCur({ ...cur, data: [...cur.data.slice(0, ri + 1), { ...r, id: (r.id || 'TC') + '-copy' }, ...cur.data.slice(ri + 1)] })}>⧉</button>
          <button class="btn icon danger" onClick=${() => setCur({ ...cur, data: cur.data.filter((_, j) => j !== ri) })}>✕</button></td></tr>`)}
    </table></div>
    <button class="btn sm" style="margin-top:6px" onClick=${() => setCur({ ...cur, data: [...cur.data, { id: nextIds(cur)(''), title: '', ...(typed ? {} : { type: 'positive' }), ...validValues(S, cur) }] })}>＋ Add row</button>

    <div class="row start" style="margin-top:20px">
      <button class="btn primary" onClick=${onSave}>💾 Save</button>
      <button class="btn" disabled=${s.running} onClick=${onRun}>▶ Save & run this case</button>
      <span style="flex:1"></span>
      ${!cur.isNew && html`<button class="btn danger" onClick=${onDelete}>Delete case</button>`}
    </div>
  </div>`;
}

export function Steps({ steps, onChange, setPop = () => {}, defAction, verify }) {
  const s = useStore();
  const S = s.S;
  const actions = S.actions;
  const upd = (i, patch) => onChange(steps.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const move = (i, d) => { const a = [...steps]; const j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; onChange(a); };
  /** picking an element switches to an action that fits it and binds a data field */
  const pickElement = (i, st, base) => {
    const e = elementDef(S, base);
    const fits = suggestedActions(e?.def.control).filter((a) => !verify || actions[a]?.kind === 'Verify');
    const action = !e || fits.includes(st.action) ? st.action : fits[0] ?? st.action;
    const patch = { element: joinRef(base, {}), action };
    const spec = actions[action];
    if (e && !st.value && (spec.value || spec.valueOptional)) {
      if (e.def.control === 'checkgroup') patch.value = e.def.options?.[0] ?? '';
      else if (spec.value && action !== 'press') patch.value = `{{data.${e.name}}}`;
    }
    if (e && spec.match && st.expected === undefined && action === 'value' && e.def.control === 'checkbox') patch.expected = 'checked';
    upd(i, patch);
  };
  return html`<div class="steps">
    ${steps.length ? steps.map((st, i) => {
      const spec = actions[st.action] ?? {};
      const ref = splitRef(st.element);
      const needsEl = spec.target === 'element' || spec.target === 'element?';
      const e = needsEl ? elementDef(S, ref.base) : null;
      const params = e?.params ?? [];
      const fits = e ? suggestedActions(e.def.control) : [];
      const opts = e?.def.options?.length ? e.def.options : null;
      const groups = {};
      for (const [k, v] of Object.entries(actions)) if (!fits.includes(k)) (groups[v.kind] ||= []).push([k, v]);
      return html`<div class="srow kind-${(spec.kind || '').split(' ')[0]}">
        <span class="num">${i + 1}</span>
        <select value=${st.action} onChange=${(ev) => upd(i, { action: ev.target.value })}>
          ${fits.length > 0 && html`<optgroup label=${`Fits ${e.def.control ?? 'this element'}`}>${fits.map((k) => html`<option value=${k}>${actions[k].label}</option>`)}</optgroup>`}
          ${Object.entries(groups).map(([g, list]) => html`<optgroup label=${fits.length ? `Other — ${g}` : g}>${list.map(([k, v]) => html`<option value=${k}>${v.label}</option>`)}</optgroup>`)}
        </select>
        <div>
          ${spec.target === 'page' && html`<select value=${st.page ?? ''} onChange=${(ev) => upd(i, { page: ev.target.value })}><option value="">— page —</option>${S.pages.map((p) => html`<option value=${p.page}>${p.page}</option>`)}</select>`}
          ${spec.target === 'url' && html`<${TextIn} value=${st.url} onChange=${(v) => upd(i, { url: v })} placeholder="/path" />`}
          ${needsEl && html`<select value=${ref.base} onChange=${(ev) => pickElement(i, st, ev.target.value)}><option value="">${spec.save ? '— page URL —' : spec.target === 'element?' ? '— whole page —' : '— element —'}</option>
            ${S.pages.map((p) => html`<optgroup label=${p.page}>${p.elements.map((x) => html`<option value=${p.page + '.' + x.name}>${p.page}.${x.name}${x.def.control ? ` · ${x.def.control}` : ''}${x.def.semantic ? ` (${x.def.semantic})` : ''}</option>`)}</optgroup>`)}</select>
            ${params.length > 0 && html`<div class="params">${params.map((pn) => html`<${TextIn} value=${ref.params[pn]} placeholder=${pn + ' ='} onChange=${(v) => upd(i, { element: joinRef(ref.base, { ...ref.params, [pn]: v }) })} />`)}</div>`}`}
          ${spec.target === 'none' && html`<span class="muted small">the current page</span>`}
        </div>
        <div>
          ${spec.save ? html`<div class="valcell"><${TextIn} value=${st.as} onChange=${(v) => upd(i, { as: v.replace(/\W/g, '') })} placeholder="save as (name)" /><${TextIn} value=${st.pattern} onChange=${(v) => upd(i, { pattern: v })} placeholder="regex (optional)" /></div>`
            : spec.match ? html`<div class="valcell"><select value=${st.matcher || 'equals'} onChange=${(ev) => upd(i, { matcher: ev.target.value })}>${S.matchers.map((m) => html`<option value=${m}>${m}</option>`)}</select>
                ${opts && st.action === 'value' ? html`<${OptionValue} key=${'x' + i + ref.base} value=${st.expected} options=${opts} multi=${e.def.control === 'checkgroup'} onChange=${(v) => upd(i, { expected: v })} />`
                  : e?.def.control === 'checkbox' && st.action === 'value' ? html`<select value=${st.expected || 'checked'} onChange=${(ev) => upd(i, { expected: ev.target.value })}><option value="checked">checked</option><option value="unchecked">unchecked</option></select>`
                  : html`<${TextIn} value=${st.expected} onChange=${(v) => upd(i, { expected: v })} placeholder="expected" />`}</div>`
            : (spec.value || spec.valueOptional) && opts && ['select', 'choose', 'check', 'uncheck'].includes(st.action)
              ? html`<${OptionValue} key=${'v' + i + ref.base} value=${st.value} options=${opts} multi=${e.def.control === 'checkgroup'} onChange=${(v) => upd(i, { value: v })} />`
            : spec.value ? html`<${TextIn} value=${st.value} onChange=${(v) => upd(i, { value: v })} placeholder=${st.action === 'press' ? 'Enter, Tab, Escape…' : 'value or {{…}}'} />`
            : spec.valueOptional ? html`<span class="muted small">${e?.def.control === 'checkgroup' ? 'pick options' : 'this checkbox'}</span>` : ''}
        </div>
        <div style="white-space:nowrap"><button class="btn icon tokBtn" title="Insert a value" onClick=${(ev) => setPop(ev.currentTarget.getBoundingClientRect())}>{ }</button>
          <button class="btn icon" onClick=${() => move(i, -1)}>↑</button><button class="btn icon" onClick=${() => move(i, 1)}>↓</button>
          <button class="btn icon danger" onClick=${() => onChange(steps.filter((_, j) => j !== i))}>✕</button></div>
      </div>`;
    }) : html`<div class="empty" style="padding:14px">No steps yet.</div>`}
  </div>
  <button class="btn sm" onClick=${() => onChange([...steps, { action: defAction }])}>＋ Add step</button>`;
}

// ------------------------------------------------------------------ ⚡ steps from a page
function FromPageModal({ cur, setCur, close }) {
  const s = useStore();
  const S = s.S;
  const forms = S.pages.filter((p) => p.elements.some((e) => ['textbox', 'textarea', 'select', 'radiogroup', 'checkgroup', 'checkbox', 'password'].includes(e.def.control)));
  const [page, setPage] = useState(cur.page && forms.some((p) => p.page === cur.page) ? cur.page : forms[0]?.page ?? '');
  const pg = S.pages.find((p) => p.page === page);
  const gen = pg ? stepsFromPage(pg) : null;
  const use = () => {
    const keepOutcome = (name, steps) => { const o = cur.outcomes.find((x) => x.name === name); return o?.steps.length ? o : { name, steps }; };
    const outcomes = [...gen.outcomes.map((o) => keepOutcome(o.name, o.steps)), ...cur.outcomes.filter((o) => !gen.outcomes.some((g) => g.name === o.name))];
    const emptyRows = cur.data.every((r) => Object.keys(r).every((k) => RESERVED.includes(k)) && !r.title);
    setCur({ ...cur, page: cur.steps.length ? cur.page || page : page, case: cur.case || `${page} form`, steps: [...cur.steps, ...gen.steps], outcomes, data: emptyRows ? [gen.row] : [...cur.data, gen.row] });
    toast(`${gen.steps.length} step(s) added — now ⚙ Generate test data for negative rows`);
    close();
  };
  return html`<${Modal} title="⚡ Steps from a page" onClose=${close}>
    <div class="info">Builds a form test from the fields of a page: one step per field (type, choose, select, tick) in page order, the submit button, outcomes from the page's messages, and one row of valid data from each field's meaning.</div>
    ${!forms.length ? html`<div class="warnbox">No page with input fields yet — collect one in Pages.</div>` : html`
      <${Field} label="Page"><select value=${page} onChange=${(e) => setPage(e.target.value)}>${forms.map((p) => html`<option value=${p.page}>${p.page}</option>`)}</select></${Field}>
      <div class="small sec" style="margin:8px 0 4px">Preview</div>
      <table>${gen.steps.map((st, i) => html`<tr><td class="muted small">${i + 1}</td><td><b>${S.actions[st.action].label}</b></td><td class="mono small">${st.element}</td><td class="small">${st.value ?? ''}${st.value?.startsWith('{{data.') ? html` <span class="muted">= ${gen.row[st.value.slice(7, -2)]}</span>` : ''}</td></tr>`)}</table>
      <div class="small muted" style="margin-top:6px">Outcomes: ${gen.outcomes.map((o) => `${o.name} (${o.steps.map((x) => `${x.action} ${x.element}`).join(', ') || 'set it yourself'})`).join(' · ')}</div>
      <div class="row between" style="margin-top:12px"><span></span><button class="btn primary" style="flex:0" onClick=${use}>Add these steps</button></div>`}
  </${Modal}>`;
}

// ------------------------------------------------------------------ ⚙ generate test data
function GenerateModal({ cur, setCur, close }) {
  const s = useStore();
  const S = s.S;
  const binds = fieldBindings(S, cur);
  const names = cur.outcomes.map((o) => o.name).filter(Boolean);
  const base = baseRow(cur);
  const [posOut, setPosOut] = useState(names.find((n) => /success|ok|pass/i.test(n)) ?? names[0] ?? '');
  const [negOut, setNegOut] = useState(names.find((n) => /error|fail|invalid|reject/i.test(n)) ?? names[1] ?? names[0] ?? '');
  const existing = new Set(cur.data.map((r) => r.title));
  const typed = cur.type === 'positive' || cur.type === 'negative';
  const [cands, setCands] = useState(() => Object.entries(binds).filter(([, b]) => b.action !== 'value').flatMap(([f, b]) => fieldCases(f, b.def)).filter((c) => !existing.has(c.why) && (!typed || c.type === cur.type)));
  const toggle = (i) => setCands(cands.map((c, j) => (j === i ? { ...c, checked: !c.checked } : c)));
  const add = () => {
    const pick = cands.filter((c) => c.checked);
    if (!pick.length) return toast('Tick at least one row');
    const fields = dataFields(cur);
    const valid = Object.fromEntries(fields.map((f) => [f, base[f] !== undefined && base[f] !== '' ? base[f] : binds[f] && binds[f].def.control !== 'checkbox' ? validValue(binds[f].def) : '']));
    const next = nextIds(cur);
    const rows = pick.map((c) => ({
      id: next(c.type === 'positive' ? 'BVA' : c.technique === 'Security' ? 'SEC' : 'NEG'),
      title: c.why, ...(typed ? {} : { type: c.type }), ...((c.type === 'positive' ? posOut : negOut) !== (c.type === 'positive' ? 'success' : 'error') ? { outcome: c.type === 'positive' ? posOut : negOut } : {}), ...valid, [c.field]: c.value,
    }));
    setCur({ ...cur, data: [...cur.data, ...rows] });
    toast(`${rows.length} row(s) added — review them, then Save`);
    close();
  };
  const byField = {};
  cands.forEach((c, i) => (byField[c.field] ||= []).push([c, i]));
  return html`<${Modal} wide title="⚙ Generate test data" onClose=${close}>
    <div class="info">Rows built from the rules of each field (read from the page): <b>Required</b> · <b>BVA</b> boundary values (min/max length, min/max value) · <b>EP</b> invalid formats and each option · <b>Security</b> (SQL injection, script). Other fields keep the valid values of the first positive row. Rows not ticked by default depend on the requirement — tick them if the application must reject (or accept) them.</div>
    ${typed && html`<div class="hint" style="margin:-4px 0 8px">Only <b>${cur.type}</b> rows are offered — this case is a ${cur.type} scenario. ${cur.type === 'positive' ? 'Rejected inputs belong in a negative case (✨ Generate test cases makes them).' : ''}</div>`}
    ${!Object.keys(binds).length ? html`<div class="warnbox">No step uses {{data.…}} yet. Use ⚡ Steps from a page, or set step values to {{data.&lt;field&gt;}}.</div>` : html`
      <div class="row">
        <${Field} label="Positive rows use outcome"><select value=${posOut} onChange=${(e) => setPosOut(e.target.value)}>${names.map((n) => html`<option value=${n}>${n}</option>`)}</select></${Field}>
        <${Field} label="Negative rows use outcome"><select value=${negOut} onChange=${(e) => setNegOut(e.target.value)}>${names.map((n) => html`<option value=${n}>${n}</option>`)}</select></${Field}>
        <div style="flex:0;margin-bottom:10px" class="row start"><button class="btn sm" onClick=${() => setCands(cands.map((c) => ({ ...c, checked: true })))}>Tick all</button><button class="btn sm" onClick=${() => setCands(cands.map((c) => ({ ...c, checked: false })))}>None</button></div>
      </div>
      <div style="max-height:52vh;overflow:auto">
        ${Object.entries(byField).map(([f, list]) => html`<div class="small" style="margin:10px 0 4px"><b>${f}</b> <span class="muted">${ruleChip(binds[f].def)}</span></div>
          <table>${list.map(([c, i]) => html`<tr class="clickable" onClick=${() => toggle(i)}><td style="width:28px"><input type="checkbox" checked=${c.checked} /></td>
            <td style="width:80px"><span class="badge ${c.type === 'negative' ? 'warn' : 'ok'}">${c.type}</span></td><td style="width:80px"><span class="tag">${c.technique}</span></td>
            <td>${c.why}</td><td class="mono small" style="max-width:220px;overflow-wrap:anywhere">${c.value === '' ? '(empty)' : c.value}</td></tr>`)}</table>`)}
        ${!cands.length && html`<div class="muted small">No more rows to suggest — the fields have no rules, or the rows already exist.</div>`}
      </div>
      <div class="row between" style="margin-top:12px"><span class="muted small">${cands.filter((c) => c.checked).length} row(s) selected</span><button class="btn primary" style="flex:0" onClick=${add}>Add selected rows</button></div>`}
  </${Modal}>`;
}

function TokenPop({ at, cur, setCur, close }) {
  const s = useStore();
  const S = s.S;
  const fields = cur ? dataFields(cur) : [];
  const fakers = [['person.firstName', 'first name'], ['person.lastName', 'last name'], ['person.fullName', 'full name'], ['internet.email', 'email'], ['internet.username', 'username'],
    ['internet.password', 'password'], ['phone.number', 'phone'], ['string.numeric(10)', '10 digits'], ['string.alpha(8)', '8 letters'], ['location.city', 'city'], ['company.name', 'company'], ['lorem.sentence', 'sentence'], ['string.uuid', 'uuid']];
  const insert = (tok) => {
    close();
    if (!focused || !document.body.contains(focused.el)) { navigator.clipboard?.writeText(tok); toast('Copied — click a field first to insert directly'); return; }
    const el = focused.el, a = el.selectionStart ?? el.value.length, b = el.selectionEnd ?? el.value.length;
    focused.apply(el.value.slice(0, a) + tok + el.value.slice(b));
    setTimeout(() => { el.focus(); el.setSelectionRange(a + tok.length, a + tok.length); }, 0);
  };
  const sec = (title, items) => items.length > 0 && html`<h4>${title}</h4>${items.map(([tok, note]) => html`<button onClick=${() => insert(tok)}>${tok}<span>${note || ''}</span></button>`)}`;
  const top = Math.min(window.innerHeight - 390, at.bottom + 4), left = Math.max(8, Math.min(window.innerWidth - 360, at.left - 300));
  return html`<div class="pop" style=${`top:${top}px;left:${left}px`}>
    ${sec('Data row fields', fields.map((f) => [`{{data.${f}}}`, '']))}
    ${sec('Runtime values (saved by earlier steps)', [...new Set(cur ? [...cur.steps, ...cur.outcomes.flatMap((o) => o.steps)].filter((x) => x.action === 'save' && x.as).map((x) => x.as) : [])].map((v) => [`{{var.${v}}}`, '']))}
    ${sec('Values from the cases this one runs after', cur ? inheritedVars(S, cur).map((v) => [`{{var.${v}}}`, 'saved earlier']) : [])}
    ${sec('Users', S.users.flatMap((u) => [[`{{user.${u}.username}}`, ''], [`{{user.${u}.password}}`, '']]))}
    ${sec('Expected messages (global values)', S.messages.map((k) => [`{{msg.${k}}}`, '']))}
    ${sec('Generated data', fakers.map(([p, n]) => [`{{faker.${p}}}`, n]))}
    ${sec('Negative values', S.negative.map((k) => [`{{negative.${k}}}`, '']))}
    ${sec('Dates', [['{{date.today}}', 'dd/MM/yyyy'], ['{{date.iso}}', 'yyyy-MM-dd'], ['{{date.hijri}}', 'Hijri'], ['{{date.plusDays(7)}}', '']])}
    <h4>New data field</h4><button onClick=${() => { const f = prompt('Field name (e.g. email):'); if (f && /^\w+$/.test(f)) { setCur({ ...cur, extra: [...(cur.extra || []), f] }); insert(`{{data.${f}}}`); } }}>＋ {{data.<name>}} <span>adds a column</span></button>
  </div>`;
}

/** the two standard results always shown (kept even when empty), then any custom ones */
function ensureDefaults(outcomes) {
  const out = DEFAULT_OUTCOMES.map((n) => outcomes.find((o) => o.name === n) ?? { name: n, steps: [] });
  return [...out, ...outcomes.filter((o) => !DEFAULT_OUTCOMES.includes(o.name))];
}

/** how the case starts (a page, or right after another case) and which cases must run before it */
function StartAndOrder({ cur, setCur }) {
  const s = useStore();
  const S = s.S;
  const me = cur.file.replace(/\.case\.yml$/, '');
  const others = S.cases.filter((c) => c.id !== me);
  const mode = cur.continueFrom ? 'continue' : 'page';
  const src = cur.continueFrom && S.cases.find((c) => c.id === cur.continueFrom.case);
  const curPage = S.pages.find((p) => p.page === cur.page);
  const pageAuth = curPage && curPage.auth !== 'none' ? curPage.auth : '';
  return html`<div class="row" style="align-items:flex-start">
    <${Field} label="How it starts" style="flex:2">
      <div class="row start" style="gap:6px">
        <select style="flex:0 0 215px" value=${mode} onChange=${(e) => setCur(e.target.value === 'page' ? { ...cur, continueFrom: null } : { ...cur, continueFrom: { case: others[0]?.id ?? '', row: '' }, page: '' })}>
          <option value="page">Opens a page</option><option value="continue" disabled=${!others.length}>Continues after a case</option></select>
        ${mode === 'page'
          ? html`<select value=${cur.page} onChange=${(e) => setCur({ ...cur, page: e.target.value })}><option value="">— none —</option>${S.pages.map((p) => html`<option value=${p.page}>${p.page}</option>`)}</select>
            <select title="Which user's saved login the case starts with" value=${cur.user || ''} onChange=${(e) => setCur({ ...cur, user: e.target.value })}>
              <option value="">${pageAuth ? `as ${pageAuth} (page setting)` : 'logged out (page setting)'}</option>
              ${S.users.map((u) => html`<option value=${u}>as ${u}</option>`)}<option value="none">logged out</option></select>`
          : html`<select value=${cur.continueFrom.case} onChange=${(e) => setCur({ ...cur, continueFrom: { case: e.target.value, row: '' } })}>${others.map((c) => html`<option value=${c.id}>${c.case}</option>`)}</select>
            <select value=${cur.continueFrom.row || ''} onChange=${(e) => setCur({ ...cur, continueFrom: { ...cur.continueFrom, row: e.target.value } })}><option value="">first row</option>${(src?.rowIds ?? []).map((r) => html`<option value=${r}>${r}</option>`)}</select>`}
      </div>
      ${mode === 'continue' && html`<div class="hint">Replays that case with the chosen row, then these steps continue on the page it ended on.</div>`}
      ${mode === 'page' && html`<input type="text" style="margin-top:6px" value=${cur.url || ''} onInput=${(e) => setCur({ ...cur, url: e.target.value })} placeholder=${`Start at another address (optional) — e.g. ${curPage?.url && curPage.url !== '/' ? curPage.url + '?tab=2' : '/patients/new?type=walk-in'}`} />
        ${cur.url && html`<div class="hint">Opens ${cur.url} (on the environment's address)${cur.page ? `, then waits for the ${cur.page} page to be ready` : ''}. {{var.…}} and {{data.…}} work here.</div>`}`}
    </${Field}>
    <${Field} label="Runs after (depends on)" style="flex:2" hint="Runs after these cases, in the same order, and can use the values they saved. If one fails, this case is skipped.">
      <div class="chips">${others.length ? others.map((c) => { const on = cur.dependsOn.includes(c.id);
        return html`<span class="chip ${on ? 'on' : ''}" onClick=${() => setCur({ ...cur, dependsOn: on ? cur.dependsOn.filter((x) => x !== c.id) : [...cur.dependsOn, c.id] })}>${on ? '⛓' : '＋'} ${c.case}</span>`; })
        : html`<span class="muted small">no other cases yet</span>`}</div>
    </${Field}>
  </div>`;
}

// ------------------------------------------------------------------ ✨ generate test cases (reviewed before saving)
function stepText(S, st) {
  const a = S.actions[st.action]?.label ?? st.action;
  const tail = st.value !== undefined && st.value !== '' ? ` = ${st.value}` : st.expected !== undefined ? ` ${st.matcher} "${st.expected}"` : '';
  return html`<b>${a}</b> <span class="mono small">${st.element ?? st.page ?? ''}</span><span class="small">${tail}</span>`;
}

export function GenerateCasesModal({ close, onEdit, initialPages }) {
  const s = useStore();
  const S = s.S;
  const [pages, setPages] = useState(() => initialPages ?? S.pages.map((p) => p.page));
  const [moduleMode, setModuleMode] = useState('page');
  const [moduleName, setModuleName] = useState('');
  const [security, setSecurity] = useState(false);
  const [edits, setEdits] = useState({}); // id → { selected?, title? }
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const proposals = S.pages.filter((p) => pages.includes(p.page))
    .flatMap((p) => proposeCases(p, S, { security, module: moduleMode === 'one' ? moduleName.trim() || undefined : undefined }))
    .map((p) => { const e = edits[p.id] ?? {}; const title = e.title ?? p.title; const exists = S.cases.some((x) => x.file === fileOf(title));
      return { ...p, title, exists, selected: e.selected ?? (p.selected || (e.title !== undefined && !exists)), case: { ...p.case, case: title } }; });
  const sel = proposals.filter((p) => p.selected);
  const journey = proposeJourney(proposals, S);
  const [withJourney, setWithJourney] = useState(true);
  const setE = (id, patch) => setEdits({ ...edits, [id]: { ...(edits[id] ?? {}), ...patch } });
  const saveAll = async () => {
    const dup = sel.filter((p) => p.exists);
    if (dup.length) return toast(`Rename first: ${dup.map((p) => p.title).join(', ')} already exist`);
    setBusy(true);
    let issues = 0;
    for (const p of sel) {
      try { const r = await api(`/api/cases/${encodeURIComponent(fileOf(p.title))}`, { method: 'PUT', body: { app: S.app, ...p.case } }); issues += r.issues.length; }
      catch (e) { toast(`${p.title}: ${e.message}`); }
    }
    let flowNote = '';
    if (journey && withJourney) {
      try {
        const name = S.flows.some((f) => f.flow === journey.flow) ? `${journey.flow} ${new Date().toISOString().slice(0, 10)}` : journey.flow;
        await api(`/api/flows/${encodeURIComponent(fileOf(name).replace('.case.yml', '.flow.yml'))}`, { method: 'PUT', body: { app: S.app, flow: name, module: journey.module, tags: ['@e2e', '@generated'], steps: journey.steps.map(({ title, ...st }) => st) } });
        flowNote = ' + 1 workflow';
      } catch (e) { toast(`Workflow: ${e.message}`); }
    }
    setBusy(false);
    await loadState();
    toast(`${sel.length} test case(s)${flowNote} saved${issues ? ` · ${issues} issue(s) to review` : ''} ✔`);
    close();
  };
  const byPage = {};
  proposals.forEach((p) => (byPage[p.case.page] ||= []).push(p));
  return html`<${Modal} wide title="✨ Generate test cases" onClose=${close}>
    <div class="info">Complete test cases proposed from what the tool knows about each page: its elements (kind, meaning, rules, options), the navigation map and the login settings. Nothing is saved until you press <b>Save</b>. Untick what you don't need, rename, or open a case in the editor to change it first.</div>
    <div class="small sec" style="margin:6px 0 4px">Pages</div>
    <div class="chips">${S.pages.map((p) => { const on = pages.includes(p.page);
      return html`<span class="chip ${on ? 'on' : ''}" onClick=${() => setPages(on ? pages.filter((x) => x !== p.page) : [...pages, p.page])}>${on ? '☑' : '☐'} ${p.page}</span>`; })}
      <button class="btn sm" onClick=${() => setPages(pages.length === S.pages.length ? [] : S.pages.map((p) => p.page))}>${pages.length === S.pages.length ? 'None' : 'All'}</button></div>
    <div class="row start" style="margin-top:8px;gap:16px">
      <label class="check"><input type="radio" checked=${moduleMode === 'page'} onChange=${() => setModuleMode('page')} /> Module = page name</label>
      <label class="check"><input type="radio" checked=${moduleMode === 'one'} onChange=${() => setModuleMode('one')} /> One module:</label>
      <input type="text" style="width:180px" placeholder="Registration" value=${moduleName} disabled=${moduleMode !== 'one'} onInput=${(e) => setModuleName(e.target.value)} />
      <label class="check" title="Tick only if the requirement says the application must reject these values"><input type="checkbox" checked=${security} onChange=${(e) => setSecurity(e.target.checked)} /> Add security rows (SQL injection, script) — the app must reject them</label>
    </div>
    <div style="max-height:52vh;overflow:auto;margin-top:10px">
      ${Object.entries(byPage).map(([pg, list]) => html`<div class="small sec" style="margin:12px 0 6px">📄 ${pg}</div>
        ${list.map((p) => html`<div class="outcome" style="padding:10px 12px">
          <div class="row start" style="gap:8px">
            <input type="checkbox" style="flex:0 0 auto;width:auto" checked=${p.selected} onChange=${(e) => setE(p.id, { selected: e.target.checked })} />
            <span style="flex:0 0 auto" title=${p.kind}>${KIND_ICON[p.kind]}</span>
            <input type="text" style="max-width:320px" value=${p.title} onInput=${(e) => setE(p.id, { title: e.target.value })} />
            <span class="muted small" style="flex:1">${p.why}</span>
            <span class="badge" style="flex:0 0 auto">${p.case.steps.length} step(s)${p.case.data.length ? ` · ${p.case.data.length} test(s)` : ''}</span>
            <button class="btn sm" style="flex:0 0 auto" onClick=${() => setOpen(open === p.id ? null : p.id)}>${open === p.id ? '▾ Hide' : '▸ Preview'}</button>
            <button class="btn sm" style="flex:0 0 auto" onClick=${() => onEdit(p)} title="Open it in the editor (not saved yet)">✎ Edit</button>
          </div>
          ${p.exists && html`<div class="warnbox small" style="margin:6px 0 0">A case named "${p.title}" already exists — rename this one to keep both.</div>`}
          ${p.warnings.filter((w) => !/already exists/.test(w)).map((w) => html`<div class="warnbox small" style="margin:6px 0 0">${w}</div>`)}
          ${open === p.id && html`<div style="margin-top:8px">
            <table>${p.case.steps.map((st, i) => html`<tr><td class="muted small" style="width:24px">${i + 1}</td><td>${stepText(S, st)}</td></tr>`)}</table>
            ${Object.entries(p.case.outcomes).map(([k, list]) => html`<div class="small" style="margin-top:6px"><b>${k === 'success' ? '✔ When it works' : k === 'error' ? '✖ When it is rejected' : k}:</b> ${list.length ? list.map((st) => html`<span style="margin-right:10px">${stepText(S, st)}</span>`) : html`<span class="muted">nothing checked yet</span>`}</div>`)}
            ${p.case.data.length > 0 && html`<div class="small" style="margin-top:6px"><b>Tests:</b> ${p.case.data.map((r) => html`<span class="tag" style="margin:2px">${r.type === 'negative' ? '✖' : '✔'} ${r.title}</span>`)}</div>`}
          </div>`}
        </div>`)}`)}
      ${!proposals.length && html`<div class="muted small">Pick at least one page.</div>`}
      ${journey && html`<div class="small sec" style="margin:14px 0 6px">🔗 Workflow</div>
        <div class="outcome" style="padding:10px 12px"><div class="row start" style="gap:8px">
          <input type="checkbox" style="flex:0 0 auto;width:auto" checked=${withJourney} onChange=${(e) => setWithJourney(e.target.checked)} />
          <b style="flex:0 0 auto">${journey.flow}</b>
          <span class="muted small">one session, each step continues where the previous one ended:</span></div>
          <div class="small" style="margin:6px 0 0 28px">${journey.steps.map((st, i) => html`${i ? ' → ' : ''}<span class="tag">${st.title}</span>`)}</div></div>`}
    </div>
    <div class="row between" style="margin-top:12px"><span class="muted small">${sel.length} case(s) · ${sel.reduce((n, p) => n + Math.max(1, p.case.data.length), 0)} test(s) selected</span>
      <button class="btn primary" style="flex:0 0 auto" disabled=${!sel.length || busy} onClick=${saveAll}>${busy ? 'Saving…' : `💾 Save ${sel.length} case(s)`}</button></div>
  </${Modal}>`;
}

/** one scenario = one expected result: moves the negative rows of a mixed case into a new negative case */
async function splitCase(S, cur, setCur, onlyRows) {
  const neg = onlyRows ?? cur.data.filter((r) => r.type === 'negative');
  const negType = onlyRows ? onlyRows[0].type : 'negative';
  const keepType = negType === 'negative' ? 'positive' : 'negative';
  const name = `${cur.case} — ${negType === 'negative' ? 'rejected inputs' : 'accepted inputs'}`;
  if (!confirm(`Move ${neg.length} ${negType} row(s) to a new case "${name}" (same steps)?\n\nThis case keeps the ${keepType} rows.`)) return;
  const strip = (r) => { const { type, outcome, ...rest } = r; return rest; };
  const errName = negType === 'negative' ? 'error' : 'success';
  try {
    await api(`/api/cases/${encodeURIComponent(fileOf(name))}`, { method: 'PUT', body: { app: S.app, case: name, description: cur.description, page: cur.continueFrom ? '' : cur.page, module: cur.module, type: negType,
      tags: cur.tags.split(',').map((t) => t.trim()).filter(Boolean), dependsOn: cur.dependsOn, continueFrom: cur.continueFrom, steps: cur.steps,
      outcomes: { [errName]: cur.outcomes.find((o) => o.name === errName)?.steps ?? [] }, data: neg.map(strip) } });
    setCur({ ...cur, type: keepType, data: cur.data.filter((r) => !neg.includes(r)).map(strip) });
    toast(`"${name}" created — press 💾 Save to keep this case's changes`);
    loadState();
  } catch (e) { toast(e.message); }
}

// ------------------------------------------------------------------ 🔗 workflows: cases chained in one browser session
function FlowEditor({ flow, setFlow }) {
  const s = useStore();
  const S = s.S;
  const issues = S.flowIssues.filter((i) => i.file === flow.file).map((i) => i.message);
  const byId = Object.fromEntries(S.cases.map((c) => [c.id, c]));
  const upd = (i, patch) => setFlow({ ...flow, steps: flow.steps.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const move = (i, d) => { const a = [...flow.steps]; const j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; setFlow({ ...flow, steps: a }); };
  /** page a case ends on: seen in the latest run, else (no run yet) unknown */
  const endsOn = (id) => S.endsOn[byId[id]?.file];
  const startsOn = (c) => { let x = c; while (x?.continueFrom) x = byId[x.continueFrom.case]; return x?.page; };
  const last = flow.steps.at(-1);
  const prevEnd = last ? endsOn(last.case) : undefined;
  const suggestions = prevEnd ? S.cases.filter((c) => startsOn(c) === prevEnd && !c.continueFrom && c.id !== last?.case) : [];
  const continuing = last ? S.cases.filter((c) => c.continueFrom?.case === last.case) : [];
  const add = (id) => id && setFlow({ ...flow, steps: [...flow.steps, { case: id, row: '', as: '', start: '' }] });
  const save = async () => {
    if (!flow.flow.trim()) return toast('Give the workflow a name'), null;
    const file = flow.isNew ? fileOf(flow.flow).replace('.case.yml', '.flow.yml') : flow.file;
    try {
      const r = await api(`/api/flows/${encodeURIComponent(file)}`, { method: 'PUT', body: { app: S.app, flow: flow.flow, description: flow.description, module: flow.module.trim(),
        tags: flow.tags.split(',').map((t) => t.trim()).filter(Boolean), steps: flow.steps } });
      setFlow({ ...flow, file: r.file, isNew: false });
      toast(r.issues.length ? `Saved with ${r.issues.length} issue(s)` : 'Saved ✔');
      await loadState();
      return r;
    } catch (e) { toast(e.message); return null; }
  };
  const run = async () => { const r = await save(); if (r && !r.issues.length) startRun({ ...byTitles([flow.flow]), label: `workflow "${flow.flow}"` }); };
  const del = async () => { if (!confirm(`Delete workflow "${flow.flow}"?`)) return; await api(`/api/flows/${encodeURIComponent(flow.file)}?app=${S.app}`, { method: 'DELETE' }); setFlow(null); loadState(); };
  return html`<div class="card">
    ${issues.length > 0 && html`<div class="err"><b>Fix before running:</b>\n• ${issues.join('\n• ')}</div>`}
    <div class="info">A workflow runs its test cases <b>one after another as one test, in the same browser session</b>: each case continues on the page the previous one ended on, and saved values ({{var.…}}) carry on. A step <b>as another user</b> opens that user's own window (its saved login); going back to a user returns to its window.</div>
    <div class="row">
      <${Field} label="Workflow name" style="flex:2"><input type="text" value=${flow.flow} onInput=${(e) => setFlow({ ...flow, flow: e.target.value })} placeholder="Patient visit — registration to diagnosis" /></${Field}>
      <${Field} label="Module"><input type="text" list="modules" value=${flow.module} onInput=${(e) => setFlow({ ...flow, module: e.target.value })} /></${Field}>
      <${Field} label="Tags"><input type="text" value=${flow.tags} onInput=${(e) => setFlow({ ...flow, tags: e.target.value })} placeholder="@e2e" /></${Field}>
    </div>
    <${Field} label="Description"><input type="text" value=${flow.description} onInput=${(e) => setFlow({ ...flow, description: e.target.value })} /></${Field}>
    <div class="section"><h3>Steps</h3><span class="muted small">each step is a test case; it runs with one of its data rows</span></div>
    ${flow.steps.map((st, i) => { const c = byId[st.case]; const fresh = i === 0 || (st.as && st.as !== flow.steps.slice(0, i).map((x) => x.as).filter(Boolean).at(-1) && !flow.steps.slice(0, i).some((x) => x.as === st.as));
      return html`<div class="outcome" style="padding:10px 12px">
      <div class="row start flowrow" style="gap:6px;flex-wrap:nowrap">
        <b style="flex:0 0 24px">${i + 1}</b>
        <select style="flex:3 1 260px" value=${st.case} onChange=${(e) => upd(i, { case: e.target.value, row: '' })}>${!c && html`<option value=${st.case}>${st.case} (missing)</option>`}${S.cases.map((x) => html`<option value=${x.id}>${x.module ? x.module + ' · ' : ''}${x.case}</option>`)}</select>
        <select title="Data row" value=${st.row} onChange=${(e) => upd(i, { row: e.target.value })}><option value="">first row</option>${(c?.rowIds ?? []).map((r) => html`<option value=${r}>${r}</option>`)}</select>
        <select title="User" value=${st.as} onChange=${(e) => upd(i, { as: e.target.value })}><option value="">${i === 0 ? 'user: case / page setting' : 'same user as before'}</option>${S.users.map((u) => html`<option value=${u}>as ${u}</option>`)}<option value="none">no saved login (new window)</option></select>
        <select title="Where it starts" value=${st.start} onChange=${(e) => upd(i, { start: e.target.value })} disabled=${i === 0}>
          <option value="">${i === 0 ? 'opens its start page' : 'continues here'}</option><option value="open">opens its start page</option>${i > 0 && html`<option value="continue">continues here</option>`}</select>
        <button class="btn icon" style="flex:0 0 auto" onClick=${() => move(i, -1)}>↑</button><button class="btn icon" style="flex:0 0 auto" onClick=${() => move(i, 1)}>↓</button>
        <button class="btn icon danger" style="flex:0 0 auto" onClick=${() => setFlow({ ...flow, steps: flow.steps.filter((_, j) => j !== i) })}>✕</button>
      </div>
      <div class="muted small" style="margin:4px 0 0 30px">${c ? html`${c.steps} step(s)${startsOn(c) ? ` · starts on ${startsOn(c)}` : ''}${endsOn(c.id) ? ` · last run ended on ${endsOn(c.id)}` : ''}${st.as && i > 0 ? ' · switches user' : ''}${fresh && i > 0 && st.as ? ' (new window)' : ''}` : 'this case does not exist (or has problems)'}</div>
    </div>`; })}
    <div class="row start" style="gap:8px;flex-wrap:wrap;margin-top:6px">
      <select style="max-width:360px" value="" onChange=${(e) => { add(e.target.value); e.target.value = ''; }}>
        <option value="">＋ Add a test case…</option>
        ${continuing.length > 0 && html`<optgroup label="Continues from the last step">${continuing.map((c) => html`<option value=${c.id}>↪ ${c.case}</option>`)}</optgroup>`}
        ${suggestions.length > 0 && html`<optgroup label=${`Starts on ${prevEnd} (where the last step ends)`}>${suggestions.map((c) => html`<option value=${c.id}>✓ ${c.case}</option>`)}</optgroup>`}
        <optgroup label="All test cases">${S.cases.map((c) => html`<option value=${c.id}>${c.module ? c.module + ' · ' : ''}${c.case}</option>`)}</optgroup>
      </select>
      ${suggestions.slice(0, 3).map((c) => html`<button class="btn sm" onClick=${() => add(c.id)} title="Starts on the page where the last step ends">✓ ${c.case}</button>`)}
      ${last && !prevEnd && html`<span class="muted small">Run the workflow once — then cases that start where the last step ends are suggested here.</span>`}
    </div>
    <div class="row start" style="margin-top:20px">
      <button class="btn primary" onClick=${save}>💾 Save</button>
      <button class="btn" disabled=${s.running || !flow.steps.length} onClick=${run}>▶ Save & run this workflow</button>
      <span style="flex:1"></span>
      ${!flow.isNew && html`<button class="btn danger" onClick=${del}>Delete workflow</button>`}
    </div>
  </div>`;
}
