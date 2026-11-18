// Rule-based test case generator — no AI, no network.
// From what the tool already knows about a page (elements, their kind / meaning / rules / options,
// the navigation map, the login settings) it proposes complete test cases; the tester reviews them
// before anything is saved.
//
// One test case = one scenario with ONE expected result (positive: must succeed, negative: must be rejected);
// the data rows of a case are variations of that same scenario.
//   smoke        the page opens and its key elements are there                          (positive)
//   form         valid data is accepted (incl. in-range boundaries, each option)       (positive)
//                required fields · invalid formats · out-of-range values · security    (negative, one case each)
//   navigation   every recorded route leaving the page reaches its target page         (positive)
//   login        valid user logs in (positive) · rejected logins (negative)
//   links        every link: internal → clicked, the right page opens · other sites / new tab → address answers
import { isInput, validValue, fieldCases, stepsFromPage, errorElement, errorChecks } from './datagen.js';

const SKIP_BUTTON = /log\s?out|sign\s?out|خروج/i;
const label = (e) => `${e.name} ${JSON.stringify(e.def.name ?? e.def.text ?? '')}`;
const ref = (page, e) => `${page.page}.${e.name}`;
export const fileOf = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.case.yml';
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** proposals for one page: [{ id, kind, title, why, selected, warnings, case: { case, page, module, tags, steps, outcomes, data } }] */
export function proposeCases(page, S, opts = {}) {
  const all = page.elements.filter((e) => !e.params.length);
  // messages / dialogs and their close buttons only show up after an action — never part of "the page opens"
  const transient = (e) => ['alert', 'dialog'].includes(e.def.control) || all.some((d) => d.def.control === 'dialog' && e.name === `${d.name}Close`);
  const els = all;
  const steady = all.filter((e) => !transient(e));
  const module = opts.module ?? cap(page.page);
  const out = [];
  const add = (kind, title, why, c, warnings = [], selected = true) => {
    const exists = S.cases.some((x) => x.file === fileOf(title));
    out.push({ id: `${page.page}:${kind}:${title}`, kind, title, why, warnings: exists ? [...warnings, 'A case with this name already exists — rename it to keep both'] : warnings,
      selected: selected && !exists, case: { case: title, type: c.type ?? 'positive', page: c.page ?? page.page, module, tags: c.tags ?? [], steps: c.steps, outcomes: c.outcomes ?? {}, data: c.data ?? [] } });
  };

  // ---------- smoke: page opens with its key elements
  const ready = steady.find((e) => e.name === page.readyWhen);
  const key = [
    ...(ready ? [ready] : []),
    ...steady.filter((e) => e !== ready && (e.def.role === 'heading' || /title|header|heading/i.test(e.name))).slice(0, 1),
    ...steady.filter((e) => isInput(e.def.control)).slice(0, 3),
    ...steady.filter((e) => e.def.control === 'button' && !SKIP_BUTTON.test(label(e))).slice(0, 2),
  ].filter((e, i, a) => a.indexOf(e) === i).slice(0, 6);
  if (key.length) {
    add('smoke', `${cap(page.page)} page opens`, `Opens the page and checks ${key.length} key element(s) are visible`,
      { tags: ['@smoke', '@generated'], steps: key.map((e) => ({ action: 'visible', element: ref(page, e) })) },
      page.auth !== 'none' ? [] : []);
  }

  // ---------- login page
  const isLogin = S.login?.page === page.page;
  if (isLogin && S.usersDetail.length) {
    const L = S.login, f = L.fields;
    const user = S.usersDetail.find((u) => u.hasPassword) ?? S.usersDetail[0];
    const errEl = errorElement(els);
    const success = L.success?.element ? [{ action: 'visible', element: L.success.element }] : L.success?.urlContains ? [{ action: 'url', matcher: 'contains', expected: L.success.urlContains }] : [{ action: 'hidden', element: `${page.page}.${f.password}` }];
    const error = errEl ? errorChecks(page, els, errEl) : [{ action: 'visible', element: `${page.page}.${f.submit}` }];
    const warnings = [];
    if (!user.hasPassword) warnings.push(`User "${user.key}" has no password yet — add it in Settings → Users & data`);
    if (!errEl) warnings.push('No error message is known on the login page — rejected logins only check that the login button is still there. In 🧭 Explore, use "Try a wrong login" to capture the message.');
    const steps = [
      { action: 'fill', element: `${page.page}.${f.username}`, value: '{{data.username}}' },
      { action: 'fill', element: `${page.page}.${f.password}`, value: '{{data.password}}' },
      { action: 'click', element: `${page.page}.${f.submit}` },
    ];
    add('login', 'Login — valid user', 'A valid user logs in', { type: 'positive', tags: ['@smoke', '@generated'], steps, outcomes: { success },
      data: [{ id: 'TC-001', title: 'valid user logs in', username: `{{user.${user.key}.username}}`, password: `{{user.${user.key}.password}}` }] }, warnings.filter((w) => !/error message/.test(w)));
    add('login', 'Login — rejected', 'Wrong password, unknown user and empty fields are rejected', { type: 'negative', tags: ['@generated'], steps, outcomes: { error },
      data: [
        { id: 'TC-NEG-001', title: 'wrong password', username: `{{user.${user.key}.username}}`, password: '{{faker.internet.password}}' },
        { id: 'TC-NEG-002', title: 'unknown user', username: '{{faker.internet.username}}', password: '{{faker.internet.password}}' },
        { id: 'TC-NEG-003', title: 'empty username', username: '', password: `{{user.${user.key}.password}}` },
        { id: 'TC-NEG-004', title: 'empty password', username: `{{user.${user.key}.username}}`, password: '' },
      ] }, warnings.filter((w) => !/no password/.test(w)));
  }

  // ---------- form: every field, submit, expected result, valid + negative / boundary rows
  const inputs = els.filter((e) => isInput(e.def.control));
  if (inputs.length) {
    const gen = stepsFromPage(page);
    const hasSubmit = gen.steps.some((s) => s.action === 'click');
    // the submit button leads to another page (recorded route) → success = that page opened
    const submitRef = gen.steps.find((s) => s.action === 'click')?.element;
    const route = submitRef && S.routes.find((r) => r.from === page.page && r.steps.some((st) => st.action === 'click' && st.element === submitRef));
    const dest = route && S.pages.find((p) => p.page === route.to);
    if (dest?.readyWhen && (!gen.outcomes[0].steps.length || gen.outcomes[0].steps[0].action === 'hidden')) gen.outcomes[0].steps = [{ action: 'visible', element: `${dest.page}.${dest.readyWhen}` }];
    const valid = { ...gen.row };
    delete valid.id; delete valid.title; delete valid.type;
    const cands = inputs.filter((e) => e.name in valid).flatMap((e) => fieldCases(e.name, e.def).map((c) => ({ ...c, field: e.name })));
    const rowsOf = (list, prefix) => list.map((c, i) => ({ id: `TC-${prefix}-${String(i + 1).padStart(3, '0')}`, title: c.why, ...valid, [c.field]: c.value }));
    // no error message known, but a success one is → a rejected input must NOT show the success
    if (!gen.outcomes[1].steps.length && gen.outcomes[0].steps[0]?.action === 'visible') gen.outcomes[1].steps = [{ action: 'hidden', element: gen.outcomes[0].steps[0].element }];
    const okSteps = gen.outcomes[0].steps, errSteps = gen.outcomes[1].steps;
    const common = [];
    if (!hasSubmit) common.push('No submit button found — not ticked. Add the click step yourself if this is a real form.');
    const okWarn = [...common], errWarn = [...common];
    if (!okSteps.length) okWarn.push('No success message is known on this page — the expected result is empty. Run it once and use 🔎 Detect on the page it ends on.');
    else if (okSteps[0].action === 'hidden') okWarn.push('Success is only checked as "no error shown" — add a real success check if the page shows one.');
    if (!errSteps.length) errWarn.push('No error message is known on this page — the expected result is empty. In 🧭 Explore, use "Submit the form empty" to capture the messages.');
    else if (errSteps[0].action === 'hidden') errWarn.push('No error message is known — this checks that the success message does not appear. Add the real error check if the page shows one.');
    const tick = !isLogin && hasSubmit;
    const P = cap(page.page);
    // positive: valid data + in-range boundaries + every option
    const posRows = [{ id: 'TC-001', title: 'valid data', ...valid },
      ...rowsOf(cands.filter((c) => c.type === 'positive' && (c.checked || /each option/.test(c.why))), 'POS').map((r, i) => ({ ...r, id: `TC-POS-${String(i + 2).padStart(3, '0')}` }))];
    add('form', `${P} — valid data is accepted`, `${gen.steps.length} step(s) · ${posRows.length} row(s): valid data, in-range boundaries and each option`,
      { type: 'positive', tags: ['@regression', '@generated'], steps: gen.steps, outcomes: { success: okSteps }, data: posRows }, okWarn, tick);
    // negative scenarios — one case per kind of rejection
    const negGroups = [
      ['required fields are rejected when empty', 'REQ', (c) => c.technique === 'Required'],
      ['invalid formats are rejected', 'FMT', (c) => c.technique === 'EP' && c.type === 'negative' && c.checked],
      ['out-of-range values are rejected', 'BVA', (c) => c.technique === 'BVA' && c.type === 'negative'],
      ...(opts.security ? [['security inputs are rejected', 'SEC', (c) => c.technique === 'Security']] : []),
    ];
    for (const [title, prefix, pick] of negGroups) {
      const list = cands.filter(pick);
      if (!list.length) continue;
      add('form', `${P} — ${title}`, `${list.length} row(s): ${[...new Set(list.map((c) => c.field))].join(', ')}`,
        { type: 'negative', tags: ['@regression', '@negative', '@generated'], steps: gen.steps, outcomes: { error: errSteps }, data: rowsOf(list, prefix) }, errWarn, tick);
    }
  }

  // ---------- links: every link goes where it says (internal: click → right page; other sites / new tab: address answers)
  const seenHref = new Set();
  const links = els.filter((e) => e.def.href && !SKIP_BUTTON.test(label(e)) && !seenHref.has(e.def.href) && seenHref.add(e.def.href)).slice(0, 12);
  if (links.length) {
    const internal = links.filter((e) => e.def.href.startsWith('/') && !e.def.newTab);
    const outside = links.filter((e) => !internal.includes(e));
    const steps = outside.map((e) => ({ action: 'link', element: ref(page, e), matcher: 'contains', expected: e.def.href }));
    internal.forEach((e, i) => {
      if (i > 0 || outside.length) steps.push({ action: 'open', page: page.page });
      steps.push({ action: 'click', element: ref(page, e) });
      const path = e.def.href.split('#')[0] || '/';
      steps.push({ action: 'url', matcher: path === '/' ? 'equals' : 'contains', expected: path });
      const target = S.pages.find((p) => p.url && p.url !== '/' && path.split('?')[0].replace(/\/$/, '') === p.url.split('?')[0].replace(/\/$/, ''));
      if (target?.readyWhen) steps.push({ action: 'visible', element: `${target.page}.${target.readyWhen}` });
    });
    const warn = links.length === 12 ? ['Only the first 12 links are checked — split the page into more cases for the rest'] : [];
    add('links', `${cap(page.page)} — links lead to the right pages`, `${internal.length} link(s) clicked and the page they open is checked${outside.length ? ` · ${outside.length} link(s) to other sites / new tabs: address checked and it answers` : ''}`,
      { tags: ['@navigation', '@links', '@generated'], steps }, warn);
  }

  // ---------- navigation: every recorded route that leaves this page
  for (const r of S.routes.filter((x) => x.from === page.page)) {
    const target = S.pages.find((p) => p.page === r.to);
    if (!target) continue;
    const checks = target.readyWhen ? [{ action: 'visible', element: `${target.page}.${target.readyWhen}` }] : [];
    if (target.url && target.url !== '/') checks.push({ action: 'url', matcher: 'contains', expected: target.url });
    add('navigation', `${cap(page.page)} to ${r.to}`, `Follows the recorded route and checks the ${r.to} page opened`,
      { tags: ['@navigation', '@generated'], steps: [...r.steps, ...checks] }, checks.length ? [] : [`The ${r.to} page has no "ready when" element or URL to check`]);
    out.at(-1).route = r.to;
  }
  return out;
}

export const KIND_ICON = { smoke: '👁', form: '📝', navigation: '🧭', login: '🔑', links: '🔗' };
export { validValue };

/**
 * A "happy path" workflow from the chosen proposals: log in (when there is a login), then follow the
 * navigation map page by page — the navigation case into a page, then its valid-data form case —
 * all in one session, each step starting where the previous one ended.
 */
export function proposeJourney(proposals, S) {
  const chosen = proposals.filter((p) => p.selected);
  const id = (p) => fileOf(p.title).replace(/\.case\.yml$/, '');
  const steps = [];
  let here;
  const login = chosen.find((p) => p.kind === 'login' && p.case.type === 'positive');
  if (login) {
    steps.push({ case: id(login), title: login.title });
    const succ = S.login?.success?.element?.split('.')[0];
    here = succ;
  }
  const formOf = (page) => chosen.find((p) => p.kind === 'form' && p.case.type === 'positive' && p.case.page === page);
  const visited = new Set(here ? [here] : []);
  if (!here) {
    const first = chosen.find((p) => p.kind === 'navigation');
    if (!first) return null;
    here = first.case.page;
    visited.add(here);
  }
  if (formOf(here)) steps.push({ case: id(formOf(here)), title: formOf(here).title });
  for (let guard = 0; guard < 20; guard++) {
    const nav = chosen.find((p) => p.kind === 'navigation' && p.case.page === here && !visited.has(p.route));
    if (!nav) break;
    steps.push({ case: id(nav), title: nav.title, start: steps.length ? undefined : 'open' });
    here = nav.route;
    visited.add(here);
    const form = formOf(here);
    if (form) { steps.push({ case: id(form), title: form.title }); break; } // a submitted form usually leaves the page — stop there
  }
  if (steps.length < 2) return null;
  return { flow: 'Happy path journey', module: chosen[0]?.case.module ?? '', steps };
}
