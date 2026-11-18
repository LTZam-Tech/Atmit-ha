<p><img src="panel/vendor/brand/atimtha-logo.svg" alt="atimtha · أتمتها — Automation Studio" height="64"></p>

# atimtha · أتمتها — Automation Studio
**You imagine. We automate.** — built on Playwright

A Playwright + TypeScript automation tool for the whole QA team:

- **Testers without automation experience** set up a web application and build tests from the
  **Control Panel** — no code.
- **Automation engineers** get a full framework underneath: Smart Object Repository, Page Objects,
  seeded data generators, local / grid / cloud / offline execution and a Smart HTML Report.

---

## دليل سريع لفريق الجودة

1. التثبيت لأول مرة: `npm install` ثم `npx playwright install chromium`
2. التشغيل: `npm run panel`، وبتفتح على http://localhost:4400
3. **شاشة المشاريع**: افتح مشروع موجود، أو «＋ New project (guided)»، أو استورد مشروع من ملف zip.
4. كل مشروع بيمشي على **5 مراحل** على الجنب، وكل مرحلة بتبين حالتها:
   - **① Project**: البيئات والروابط، واللغات، والـ test-id، وهوية التقارير.
   - **② Pages**: «Collect pages» لصفحة وحدة أو عدة صفحات. بتراجع كل صفحة على الـ screenshot بمربعات مرقمة، وبتسمّي العناصر، وبتحدد نوع كل حقل ومعناه وقيوده (مطلوب، أقصى طول…). بعدها بتضغط «Add page».
   - **③ Data & settings**: المستخدمين وكلمات المرور (بتنحفظ بـ secrets.yml)، وطريقة الدخول، والقيم العامة (رسائل التطبيق المتوقعة).
   - **④ Test builder**: الخطوات بتنختار من القوائم، والنتائج المتوقعة، وجدول الداتا (كل صف تست، positive أو negative).
   - **⑤ Run & reports**: التشغيل، وسجل التشغيلات بالتاريخ، ومنحنى نسبة النجاح، ومقارنة تشغيلين، وفتح أي ريبورت قديم.
5. **🎬 تسجيل رحلة** من مرحلة ② Pages: بيفتح متصفح على جهازك وبتشتغل على النظام عادي. فوقه شريط صغير فيه: ✓ أضف تحقق، 💾 احفظ قيمة، 🏷 سمّي الصفحة، ■ إيقاف. بعد الإيقاف بيطلع تست جاهز، والصفحات الجديدة مع عناصرها وصورها، وطرق التنقل على خريطة 🗺.
6. **البناء الذكي بمرحلة ④**: بتختار العنصر، فالأداة بتختار الـ action المناسب إله. والقيم بتنختار من خيارات الصفحة نفسها: الـ dropdown، ومجموعات الـ radio، ومجموعات الـ checkbox.
   - **⚡ Steps from a page**: بيبني تست form كامل بكبسة وحدة.
   - **⚙ Generate test data**: بيولّد صفوف سلبية وحدّية من قيود الحقول (required، BVA، الصيغة، الحالات الأمنية).
   - **⚡ Fill valid values**: بيعبّي قيم صحيحة حسب معنى كل حقل.
   - **⬇⬆ CSV**: تصدير واستيراد، والملف بيفتح بالـ Excel.
7. **🗺 خريطة التنقل**: الصفحة اللي ما بتفتح من الرابط بتحددها «navigating from another page» من Start setup، والأداة بتوصلها لحالها بأقصر طريق.
8. **🎨 Report branding** من الأعلى: لوغو واسم الشركة والعميل وألوان الريبورت، والإعدادات بتنحفظ كـ profile لكل عميل.
9. **⎇ Git** من الأعلى: تهيئة repo وعمل commit، والملفات السرية بتنمنع تلقائياً.

---

## Quick start

```bash
npm install
npx playwright install chromium   # first time only (offline machines: see Targets)
npm run panel                     # Control Panel → http://localhost:4400
npm test                          # or run from the command line (report opens automatically)
```

| Command | What it does |
|---|---|
| `npm run panel` | Control Panel — projects home + 5-stage workflow (Project · Pages · Data & settings · Test builder · Run & reports) |
| `npm run page:capture -- <page>` | Refresh a page's screenshot and element boxes (visual review) |
| `npm test` | Validate → generate OR types → run the current app's tests |
| `npm run test:positive` / `test:negative` / `test:smoke` / `test:ar` | Run by tag / in Arabic |
| `npm run test:headed` / `test:ui` / `test:debug` / `test:video` | Watch the browser, Playwright UI mode, step debugger, video for every test |
| `npm run validate` | Check every app's OR and test cases (CI gate) |
| `npm run or:harvest -- <path> <page> [--auth <user>]` | Collect a page's elements into a draft |
| `npm run page:open -- <page>` | Open a page in its start state with the Inspector |
| `npm run record -- "<journey>" [--start /path] [--auth user]` | Record a journey (also from Control Panel → Pages → 🎬) |
| `npm run report` / `report:debug` | Open the Smart Report / Playwright's trace report |

The current app is chosen in the panel (saved in `apps/.current`) or with `APP=<app>`.
The environment comes from `ENV=<env>` (default: the first one in `app.yml`).

---

## Applications — `apps/<app>/`

```
apps/<app>/
  app.yml          name, environments (baseURL…), test-id attribute, languages, login, users
  secrets.yml      passwords, basic-auth           (git-ignored — never committed)
  messages.yml     expected UI messages per language  → {{msg.key}}
  or/              Smart OR — one YAML per page (+ or.types.gen.ts, generated)
  cases/           no-code test cases (YAML)
  tests/           optional code tests (TypeScript)
  pages/ fixtures.ts   optional Page Objects for code tests
```

```yaml
# apps/demo/app.yml
name: QA Demo Shop
testIdAttribute: data-test
languages: [en, ar]
environments:
  demo: { baseURL: http://localhost:4173, startDemoApp: true }
login:
  page: login
  fields: { username: username, password: password, submit: submit }
  success: { element: inventory.title }
users:
  standard: { username: standard_user }       # password in secrets.yml or ${ENV_VAR}
```

Any value may use `${VAR}` — on CI, passwords come from pipeline secrets.

### Setup Wizard (Projects → ＋ New project (guided))

1. **Website**: opens the site; detects the test-id attribute (`data-testid`, `data-test`, `data-qa`…), the language/RTL and a login form.
2. **Login**: collects the login page and maps username / password / button automatically. You add the test users.
3. **Create & verify**: writes `apps/<key>/`, logs in for real, saves the session, collects the home page, sets `login.success`, and generates starter cases (valid login + wrong password + empty password + SQL injection, and a home page check).
4. **Ready**: run the starter tests straight away.

---

## No-code test cases — `apps/<app>/cases/*.case.yml`

Built in the **Case Builder** (or by hand). One case = steps shared by every row + outcomes + a data table. **Each row is one test.**

```yaml
case: Login
page: login                       # start page — its `auth` decides the session
tags: ['@smoke']
steps:
  - fill: { element: login.username, value: "{{data.username}}" }
  - fill: { element: login.password, value: "{{data.password}}" }
  - click: login.submit
outcomes:
  success: [ { visible: inventory.title } ]
  error:   [ { text: { element: login.errorMessage, equals: "{{data.message}}" } } ]
data:
  - { id: TC-001, title: valid user, type: positive, outcome: success,
      username: "{{user.standard.username}}", password: "{{user.standard.password}}" }
  - { id: TC-101, title: wrong password, type: negative, outcome: error,
      username: "{{user.standard.username}}", password: "{{faker.internet.password}}",
      message: "{{msg.invalidCredentials}}" }
```

| Group | Actions |
|---|---|
| Navigate | `open: page` · `goto: /url` |
| Data entry | `fill` · `clear` · `select` (multi: `A, B`) · `choose` (radio group) · `check` / `uncheck` (checkbox, or group options `value: "A, B"`) |
| Click | `click` · `dblclick` · `hover` · `press` |
| Verify | `visible` · `hidden` · `enabled` · `disabled` · `text` · `value` · `count` · `url` · `title` (`equals` / `contains`) · `waitFor` |
| Runtime | `save` (element text/value or page URL, optional `pattern`) → `{{var.name}}` |

Elements are `page.element`, with parameters when needed: `inventory.addToCart(sku={{data.sku}})`.

Values: `{{data.x}}` · `{{var.x}}` (runtime) · `{{user.<key>.username|password}}` · `{{msg.<key>}}` · `{{faker.internet.email}}` (seeded) · `{{negative.sqlInjection}}` · `{{date.today}}` / `{{date.today(MM/dd/yyyy)}}` / `{{date.hijri}}` / `{{date.plusDays(7, yyyy-MM-dd)}}` · `{{env.baseURL}}`.

Cases are validated before the run (unknown element, missing parameter, missing data value, unknown user/message, unknown outcome…). Problems show in the Case Builder and as clear failing tests.

`hidden` and `count` use the primary locator only, so a backup locator can never hide a bug.

---

## Journey recorder (Phase 2)

Control Panel → ② Pages → **🎬 Record a journey** (or `npm run record -- "Create patient" --start /login`).
A real browser opens on the tester's computer with a floating toolbar — **✓ Check** (click an element to verify its text), **💾 Save value** (capture e.g. a new order number as `{{var.<name>}}`), **🏷 Name page**, **■ Stop**. When stopped:

- every visited page that is not in the OR yet is collected (elements, classification, screenshot); new elements on known pages are added (backup kept);
- every move between pages becomes a **navigation route** (`navigation.yml`), including the inputs typed on the page (e.g. a login form);
- a **test case** is written with the steps and one positive data row — typed values become data fields; a typed username/password of a known user becomes `{{user.<key>.username|password}}`, never plain text.

## Navigation map — `apps/<app>/navigation.yml`

```yaml
edges:
  - from: inventory
    to: cart
    steps:
      - click: inventory.cartLink
```

A page with `open: navigate` is never opened by URL: the runner takes the shortest route from a page that opens by URL and replays it (shown in the report as *Reach cart via inventory → cart*). Edit routes visually in ② Pages → 🗺 Navigation map; `npm run validate` fails if a navigation-only page has no route.

## Smart builder & test data generation (rule-based, offline)

**Options from the page** — the collector reads dropdown options, and turns radios / checkboxes that share a `name` into one element with `options` (`control: radiogroup | checkgroup`). In the builder:

| Element kind | Action chosen for you | Value |
|---|---|---|
| textbox / textarea / password | Type into | `{{data.<field>}}` |
| select | Select from dropdown | one of the page's options (or `{{data…}}`; `A, B` for multi-select) |
| radiogroup | Choose radio option | one of the options |
| checkgroup | Tick / Untick checkbox(es) | option chips — `Music, Reading` |
| checkbox | Tick / Untick | — |
| button / link | Click | — |
| heading / alert | Is visible / Text | expected text |

`value` checks work on groups too (`Music, Reading`, `Female`, `checked`). Literal option values are validated against the page's options.

**⚡ Steps from a page** — one step per field in page order, the submit button (never logout/cancel), outcomes from the page's success / error messages, and one valid data row.

**⚡ Fill valid values** — empty cells of positive rows get a value from the field's meaning and rules (email → `{{faker.internet.email}}`, phone → `05{{faker.string.numeric(8)}}`, age 18–99 → `59`, dropdown → first option…).

**⚙ Generate test data** — candidate rows per field, tick the ones you want:

| Technique | Rows |
|---|---|
| Required | field left empty → negative |
| BVA | exactly max / min length, min / max value → positive; max+1 typed (browser keeps max) → positive; min−1 length, below min, above max → negative |
| EP | invalid formats (email without @, letters in phone, impossible date…), each dropdown / radio option |
| Security (not ticked by default) | SQL injection, script (XSS), special characters, Arabic text |

**CSV** — export / import the data table (UTF-8 with BOM, opens in Excel with Arabic intact).

## Runtime values

```yaml
- save: { element: cart.orderNumber, as: orderNo }            # text or field value
- save: { as: patientId, pattern: "patients/(\\d+)" }          # from the URL, first regex group
- fill: { element: search.query, value: "{{var.orderNo}}" }
```

Values live for the current test only; using `{{var.x}}` before it is saved is reported by validation. Saved values are listed in the report under each test.

## 🧭 Explore — start from the address, the tool builds as you walk

② Pages → **🧭 Explore** (or Test builder → 🧭 Explore & build a workflow). Pick the environment, the start address and the user.
1. The page is opened and **scanned**: a screenshot with numbered boxes for every detected element (blue = in the Smart OR, dashed = detected).
2. A **new page is saved to the Smart OR** right away (rename it there); a known page is recognised by its address.
3. **Next steps are suggested** from the elements: 🔑 *Log in as <user>* (known users) · 📝 *Fill the form with valid data and submit* (values from each field's meaning and rules) · 👉 *Click* a link / button (logout and delete are never suggested). Or click any box.
4. The step runs **in the same session**; the next page is scanned; a click or login that leads to another page is **added to the navigation map**. The first successful login also fills the project's **login settings** and saves that user's session.
5. Any time: **✨ Generate tests for this page**, **↶ Undo last step**.
6. **💾 Save as workflow**: every step becomes a small case (start page, user, steps, check that the next page opened — or the success message for a form) and a workflow chains them in one session.

### Messages, dialogs and toasts
Error and success messages often appear only **after** an action (a "Failure" dialog, a red toast that disappears after 2 seconds, an inline field error). While exploring, every step records each message container that appears, **even when it is already gone**, and saves it in the Smart OR of that page:
- `control: dialog` or `control: alert`. It is found by its kind (test id, id, or classes such as `.modal:visible` / `.toast.toast-error:visible`), never by its text.
- `messages:` the texts that were seen.
- `<name>Close`: the dialog's Close / OK button.

Explore also offers two **probe** steps. **Try a wrong login** types an unknown user and a wrong password; nothing real is typed. **Submit the form empty** presses submit with nothing filled in. Each probe becomes a **negative** case: it checks the toast, then the dialog and its text, then closes the dialog so the journey can go on. A dialog left open after any step is closed automatically. The generated login and form cases use these elements as their expected error.

### Links
The collector stores every link's target (`href`: a path on the site, or the full address) and whether it opens a new tab (`newTab`). **Generate test cases** adds one case per page: *links lead to the right pages*.
- **Links on the same site** are clicked. The case checks that the address is right and that the target page's "ready when" element is visible.
- **Links to other sites or a new tab** use the new step **Link works** (`link: { element, contains: /contact }`). It checks that the link points to the expected address and that the address answers with no 4xx or 5xx error. The exported Playwright project has the same check (`checkLink`).

## Explore — the element list
Next to the picture, the **Elements on this page** tab lists every numbered element: its name, its kind, its text, and its own action.
- **Click** for buttons and links.
- **Type** with a value for fields.
- **Pick** with the choices of a calendar, time slots or a custom list.

Hovering a row highlights its box and dims the others; clicking a box selects its row. **Numbers on the picture** turns the boxes off. On busy pages, where boxes overlap, every element can still be reached from the list. The picture stays in view while you scroll the list.

**Searchable lists** (country codes, cities…). Type in the list's search field (**Type** in the element list); the matching options then appear as their own elements: `role=option`, menu items, or anything the mouse turns into a hand over. Each one has **Choose "…"** in Next step and **Click** in the list, and every row also has **Click** as a last resort. The steps are saved as: click the list → type `jo` → click `phoneCountryOptionJo`.

Pickers check their own selector when collected: if the container selector does not find the first choice, a page-wide one (visible items only) is used, and it is also kept as the fallback.

## Pickers (calendars, time slots, custom dropdowns) and addresses with a query
**Pickers.** Booking widgets and modern forms draw their choices with buttons, table cells or divs. Examples: a guests list, a calendar that opens by itself after the guests are chosen, time slots. The collector finds repeated clickable items in one container and saves them as **one element with a parameter**, located by text:
```yaml
calendarDay: { css: 'table td:text-is("{day}"):not([disabled]) >> nth=0', control: picker, options: ["5", "6", …] }
timeSlot:    { css: 'div.time-slots button:text-is("{time}") … >> nth=0', control: picker }
```
Steps use it as `click: widget.calendarDay(day=14)`.
- Explore suggests **Pick "…" in calendarDay**. A day is saved as `{{date.plusDays(n, d)}}` so the test keeps picking a future day.
- Steps that stay on the same page (guests → day → time → continue) are saved as **one case**, because each needs the one before.

**Loading spinners.** Before a page is collected (Explore, Collect pages, the New project wizard, Check pages), the tool waits for the network to calm down, for spinners, loaders and skeletons to disappear, and for the content to stop changing. Tests opening a page also wait for spinners before checking that it is ready.

**Addresses with a query.** The New project wizard opens the address exactly as given, query included, and saves the home page with it. Apps that need `?venue=abc` (a tenant, a venue, a language) keep it:
- Pages are saved with their query, without tracking values (`utm_*`, `fbclid`…).
- A page is recognised only when those values match.
- The environment's own query (`baseURL: https://site/widget.html?venue=abc`) is added to every address of the same site that does not set those values itself: opening pages, `goto` steps, start addresses, Check pages, and the exported project.

## Pages with transitions — and 🩺 Check pages
Many sites change the address at once and swap the content a moment later (page transitions, single-page apps). Explore now handles this:
- **It waits until the page stops changing** (address, number of elements, main heading).
- **It checks the content really changed.** If the address changed but what is on screen is still the previous page, it waits and looks again.
- **It verifies the "ready when" element.** A new page's "ready when" element is one that is not shared with the previous page (never the menu or header). It is checked by opening the page's **address in a second tab**: the first element that shows there is kept. If nothing shows (the address redirects, or the page only exists after a click), the page is marked `open: navigate` and tests reach it through the navigation map.

**Self-healing while tests run.** Pages that were saved wrong keep running, and the run says how it went on:
- **"Ready when" element missing.** The page is still recognised if two of its own elements show (headings and fields first; menu links prove nothing). The test goes on.
- **The address does not show the page.** If the navigation map reaches the page, the test goes there through the map instead.

Each heal is noted in the report. **Runs → What the run found → Self-healing during the run** offers the matching fix in one click: **Use "…" as ready element**, or **Open it through navigation**.

**Healing policy** (`app.yml` → `run: { healing: pass | flag | off }`, or `HEALING=flag npm test` for one run):
- `pass` (default): heals let actions and navigation go on, but a **check** (visible, text, value…, or a saved value) that only passes because a backup locator found a substitute element **fails** — it could be hiding a real defect.
- `flag`: the test still runs to the end, then fails if it needed any healing. Use it for release gates.
- `off`: no healing; the original failure stops the test.

Every heal keeps the **original failure** (for example "primary locator matched no element") in the report. Run summaries count `healed` tests separately from `flaky` ones (passed after a retry). See ADR-0011.

**Pages → 🩺 Check pages** opens every page by its address, with the session it starts with, and reports what it finds:
- *Ready.*
- *Another element shows*, with a one-click **Use "…"** that sets a new "ready when" element.
- *Most elements are missing.* The page was collected while the previous page was still showing: **collect it again**.
- *The address redirects.* The page needs a login, or opens only through a click.

When a test fails because a page is not ready, the error says the same.

## After a run — what the run found (grow the tests from there)
Every test records what it meets on the way: each **page it reaches**, redirects included, and each **message that pops up** (toasts, alert boxes, dialogs), even the ones that disappear. It is saved in the run history and turned off with `DISCOVER=0`. In **Runs → Reports & history** the card **What the run found** lists:
- **Pages reached.**
  - A *new page* (not in the Smart OR) has **🧭 Explore from here**. The exploration starts on that page as the user of the test that reached it; it logs in by itself with the project's login settings when there is no saved session yet. When you save, the workflow **starts with that test** and goes on with what you explored. Example: *valid login → My account → empty form is rejected → valid data is saved*, all in one session.
  - **＋ Add page & suggest tests** registers the page and opens the generator for it.
  - A known page has **✨ Suggest test cases**, **🧭 Explore from here**, and **↪ Continue**, which starts a new case that first replays the test.
- **Messages that appeared.**
  - **Save to Smart OR** adds the message.
  - **＋ Expected result of "<case>"** adds the checks to the case that triggered the message: an error message goes to a negative case, a success message to a positive one. It checks the text when the case has one row; toasts are checked first; dialogs are checked, then closed.

The Overview shows the same findings under **Needs your attention**.

## ✨ Generate test cases (rule-based, reviewed before saving)

Test builder → **✨ Generate test cases** proposes complete cases for the chosen pages from what the tool already knows:
| Kind | What it builds |
|---|---|
| 👁 Page opens | the page's ready element + key headings, inputs and buttons are visible (`@smoke`) |
| 📝 Form | one **positive** case (valid data, in-range boundaries, each option) and separate **negative** cases: required fields · invalid formats · out-of-range values · security (optional) |
| 🧭 Navigation | every recorded route leaving the page → the target page opened |
| 🔑 Login | *valid user* (positive) and *rejected* (negative: wrong password, unknown user, empty fields) |
Expected results come from the page: a success message (saved / placed / confirm…), an error/alert element, or the page the submit button leads to. When none is known the proposal says so. Untick, rename, **✎ Edit** a proposal in the editor, or save the selection. Generated cases are tagged `@generated`.

## Start of each case: address & user · Workflows (one session)

**Master URL** = the project environment (`ENV` / ① Project). Each case can start differently:
```yaml
case: Doctor opens the lab tab
page: patientFile               # optional — waits for this page to be ready
url: /patients/{{var.patientId}}?tab=lab   # optional — its own address (on the environment)
user: doctor                    # optional — its own saved login ('none' = logged out); default: the page's auth
```
**Workflows** — `apps/<app>/flows/*.flow.yml` (Test builder → 🔗 Workflows): cases chained as **one test in one session**.
Each case continues on the page the previous one ended on; `{{var.…}}` values carry on. A step `as: <user>` runs in that user's own window
(its saved login); going back to a user returns to its window. `start: open` opens the case's start page instead of continuing.
```yaml
flow: Patient visit
steps:
  - case: register-patient        # receptionist (from the case / page setting)
  - case: book-appointment        # continues here
  - case: open-patient-file
    as: doctor                    # doctor's window
```
The workflow editor suggests the next case: cases that continue from the last step, and cases that start on the page where it ended (from the last run).
✨ Generate test cases also proposes a **Happy path journey** workflow (login → navigation → form). Exported as `tests/workflows/*.flow.spec.ts`.

## Modules, suites, dependencies, continuations

```yaml
case: Place an order
module: Cart                          # groups cases in the builder, in reports, and in exported folders
dependsOn: [cart]                     # runs after "cart" (same worker, in order) and can use {{var.…}} it saved
continueFrom: { case: go-to-checkout, row: TC-001 }   # replays that case first, then continues on its last page
```
- **Expected result by row type**: rows without `outcome` use `success` checks when positive and `error` checks when negative.
- **Run suites** — `apps/<app>/suites.yml` (Control Panel → Run → ⚙ Suites): pick cases by module, tag (also row tags) or name. `SUITE=smoke npx playwright test`. Cases a selected case depends on are added.
- **Chains**: cases linked by `dependsOn` run in one serial group; if one fails, the rest are reported as *did not run*.
- **Where the tests ended** (Run → Reports & history): every test records its last page. A page that is not in the OR gets **🔎 Detect** (replays the test and collects the page as a draft); **↪ Continue** opens a new case with `continueFrom` set.

## Export as a standalone Playwright project

Control Panel → Project → **⬇ Export Playwright code**, or `npx tsx scripts/export-code.ts <app> [outDir]`.
The zip is a plain Playwright + TypeScript project that runs without this tool:
`pages/` Page Objects (locators with `.or()` backups) · `tests/<module>/` one spec per case (dependency chains in one `.chain.spec.ts`) ·
`data/<module>/` rows with faker/dates as real code · `tests/auth.setup.ts` sessions · `support/` helpers · `.env.example` for passwords ·
`npm run suite:<name>` per suite.

## Smart OR — `apps/<app>/or/*.page.yml`

```yaml
page: inventory
url: /inventory.html
readyWhen: title
auth: standard              # tests on this page start logged in as this user ('none' = logged out)
tags: ['@inventory']
settings: { timeout: 8000, defaultStrategy: testid }
elements:
  title:
    testid: title
    fallback: [ { text: { en: Products, ar: المنتجات } } ]
  logout: logout                                  # shorthand → defaultStrategy
  item: { css: "[data-sku='{sku}']" }             # parameter
  addToCart: { role: button, within: item }       # search inside another element
```

Strategies: `testid, role(+name, exact), label, placeholder, text, alt, title, id, css, xpath`. Modifiers: `within, frame, nth, hasText, fallback`.
Validated on every run, typed for code tests, with self-healing fallbacks reported under *Object Repository health*.
In the panel, every element can be **checked on the live page** (highlighted screenshot), **renamed** (cases and `app.yml` follow automatically) or removed (blocked while in use).

**Sessions:** the setup project logs in once per user any page needs (`auth: <user>`), using `login` from `app.yml`, and saves `.auth/<app>/<user>.json`. Tests get the session automatically from their page tag.

---

## Code tests (automation engineers)

```ts
// apps/demo/tests/inventory.spec.ts
import { test, expect } from '../fixtures';
test('TC-INV-001 · add two products', { tag: ['@positive', '@inventory'] }, async ({ inventoryPage }) => {
  await inventoryPage.open();
  await inventoryPage.addToCart('backpack');
  await expect(await inventoryPage.el('cartBadge')).toHaveText('1');
});
```

Page Objects extend `BasePage<ORRegistry, 'page'>` (typed from the YAML). Generic fixtures: `ui` (any OR page), `data` (seeded builders), `api` (API setup/cleanup). Rules: no locators outside the OR, actions in pages, assertions in tests, `strict()` for negative checks.

---

## Targets (where the browser runs)

| `TARGET` | |
|---|---|
| `local` (default) | This machine. Offline: `BROWSER_CHANNEL=msedge` (installed browser) or `PLAYWRIGHT_BROWSERS_PATH` (copied browsers) |
| `grid` | Internal Playwright grid — `docker compose -f docker/grid.compose.yml up -d`, `GRID_WS_URL=ws://host:3000/` |
| `browserstack` | `BROWSERSTACK_USERNAME`, `BROWSERSTACK_ACCESS_KEY` |
| `lambdatest` | `LT_USERNAME`, `LT_ACCESS_KEY` |

Cloud browsers cannot reach `localhost`; for an internal UAT use the vendor tunnel or the grid.

## Control Panel — navigation by task · English / العربية

The sidebar has six sections. The language switch at the bottom (and Settings → Language & display) turns the whole studio to Arabic (right-to-left) or English. The choice is remembered on this computer.

| Section | What the tester does | Files |
|---|---|---|
| Projects | open · guided wizard · blank · import/export (.zip, passwords excluded) | `apps/<app>/` |
| Overview | last run, pages / cases / workflows at a glance, what needs attention, coverage by module, run everything | — |
| Explore | walk the application from its address; pages are learned and saved, next steps suggested, the journey saved as a workflow | `or/`, `cases/`, `flows/` |
| Pages | collect one or several pages → **visual review** (numbered boxes on the screenshot) → add; element kind / meaning / rules, rename, start setup, navigation map | `or/*.page.yml`, `or/.visual/` |
| Tests | test cases (steps, expected result, data table), generated cases, workflows | `cases/*.case.yml`, `flows/*.flow.yml` |
| Runs | run settings, suites, live console, **history**, trend, **compare two runs**, any past report | `reports/history/<app>/<run>/` |
| Settings | language & display · project & environments · users & data (passwords → `secrets.yml`) · report branding & Git | `app.yml`, `secrets.yml`, `messages.yml` |

**Translations** — `panel/app/i18n-ar.js` holds the Arabic text (keys are the English text). New screens call `t('English text')`; older screens are translated on the page, so anything missing simply stays in English. Element keys, case names, values typed by the tester and code are never translated. In the browser console, `window.__missing` lists texts that have no Arabic yet.

**Element classification** (written by the collector, editable): `control` (textbox, password, select, checkbox, button, link, heading, alert…), `semantic` (email, phone, date, nationalId, username, amount…) and `rules` (required, minlength, maxlength, min, max, pattern) — the base for generated data and negative cases (Phase 3–4).

**Report branding** — `branding/profiles.yml`: company, client, logo, main color, title, footer, confidentiality label; a project picks one with `branding: <profile>`.

**History** — every run is kept in `reports/history/<app>/<yyyyMMdd-HHmmss>/` (report + `summary.json`), last 50 per project (`REPORT_HISTORY_KEEP`).

**Git** — init, change list and commit from the panel; `secrets.yml`, `.env*` and sessions are blocked from commits. Push/pull and branches: Phase 5.

## Smart HTML Report

`reports/smart-report/index.html`: a single file (videos and traces in `assets/`). It opens automatically after CLI runs (`open: always | on-failure | never` or `REPORT_OPEN`) and inside the panel.
It shows KPIs, positive vs negative results, results per module, failure classification, OR health, and per test: typed steps, screenshots, error, data seed, video and trace.

## Layout

```
apps/            applications under test (demo included)
config/          environment.ts (APP/ENV/LOCALE/SEED) · targets.ts
src/core/        app registry · Smart OR (loader, resolver) · cases (model, loader, template, runner) · harvest · page sessions
src/pages/       BasePage          src/fixtures/   generic fixtures (ui, data, api, sessions)
src/data/        builders, seeded faker, negative values        src/utils/  steps, api client, dates (Hijri), files
tests/setup/     health check + sessions (generic)              tests/cases.spec.ts  no-code runner (generic)
panel/           Control Panel (server.ts, index.html, app/*.js — Preact + htm, offline)
scripts/         wizard, harvester, capture-page, open-page, check-element, types
branding/        report branding profiles
reporters/       Smart Report      demo-app/  bundled bilingual demo      docker/  internal grid
```

### Running on a laptop — browsers at once & timeouts
Control Panel → ① Project → **Running tests on this computer** (saved in `app.yml → run:`):
`workers` (browsers at the same time, default **2**), `testTimeout` (s, default 60), `waitTimeout` (s, default 10 — raise for slow UAT), `retries`.
Too many parallel browsers on a laptop or against a slow server cause timeouts. A visible-browser run uses 1 browser.
One run can override: `WORKERS=1`, `RETRIES=1`, `TEST_TIMEOUT=120`, `WAIT_TIMEOUT=20` (also in the exported project).

### Scenario type — one case, one expected result
`type: positive` (must succeed) or `type: negative` (must be rejected) on a case: every row inherits it and only that expected result is checked. Rows are variations of the same scenario. Older mixed cases still run; the builder offers **✂ Split into a positive and a negative case**.

### Date pickers & read-only fields
- After a picker field is filled its calendar is closed (Escape + jQuery UI / bootstrap / flatpickr close), so it never covers the next fields.
- `<input type=date|month|time|datetime-local>`: any common date (31/10/2026, 10/31/2026, 2026-10-31) is entered in the browser's format; text like "abc" can't be entered and is not generated.
- Collecting a page marks calendar fields (jQuery UI `hasDatepicker`, bootstrap/flatpickr, `<input type=date>`) as **datepicker** and reads the date format the page expects (`format: MM/dd/yyyy`).
- `fill` on a read-only field sets the value directly and fires `input` + `change` (what the calendar does). The report notes it as *readonly-fill*.
- Generated data uses the field's format: `{{date.today(MM/dd/yyyy)}}`. Format tokens: `yyyy yy MM M dd d`.
