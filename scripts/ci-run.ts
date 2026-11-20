/**
 * Run an Atimtha project from a CI pipeline and fail the build when tests fail.
 *
 *   ATIMTHA_PLATFORM_URL=https://atimtha.client.local ATIMTHA_CI_TOKEN=ctk_… \
 *     npx tsx scripts/ci-run.ts <project> [--env staging] [--suite smoke] [--tags @smoke,@api] [--engine api] [--flows order-journey]
 *                                         [--junit results/atimtha.xml] [--timeout 60]
 *
 * Starts the run, waits for it (polling every 10 s), writes JUnit XML for the CI server's test report, and exits
 * 0 when the run passed, 1 when it failed, 2 on a usage or platform error, 3 when it did not finish in time.
 */
import fs from 'node:fs';
import path from 'node:path';

const platform = (process.env.ATIMTHA_PLATFORM_URL ?? '').replace(/\/+$/, '');
const token = process.env.ATIMTHA_CI_TOKEN ?? '';

function args(argv: string[]) {
  const [project, ...rest] = argv;
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) continue;
    opts[rest[i].slice(2)] = rest[i + 1] ?? '';
    i++;
  }
  return { project, opts };
}

async function call<T>(method: 'GET' | 'POST', route: string, body?: unknown, accept = 'application/json'): Promise<{ status: number; data: T; text: string }> {
  const res = await fetch(`${platform}/api/ci/v1${route}`, {
    method,
    headers: { Authorization: `AtimthaCI ${token}`, Accept: accept, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = undefined as T;
  if (accept === 'application/json' && text) { try { data = JSON.parse(text) as T; } catch { /* problem text below */ } }
  return { status: res.status, data, text };
}

interface Run { id: string; status: string; finished: boolean; passed: boolean; counts?: Record<string, number> | null; error?: string | null; url?: string | null }

async function main() {
  const { project, opts } = args(process.argv.slice(2));
  if (!project || !/^https?:\/\//.test(platform) || !token.startsWith('ctk_')) {
    console.error('Usage: ATIMTHA_PLATFORM_URL=… ATIMTHA_CI_TOKEN=ctk_… npx tsx scripts/ci-run.ts <project> [--env e] [--suite s] [--tags a,b] [--engine web|api] [--junit file] [--timeout minutes]');
    return 2;
  }
  const list = (v?: string) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
  const started = await call<Run>('POST', `/projects/${encodeURIComponent(project)}/runs`, {
    environment: opts.env || undefined, suite: opts.suite || undefined, tags: list(opts.tags), cases: list(opts.cases), flows: list(opts.flows), engine: opts.engine || undefined,
  });
  if (started.status !== 201) { console.error(`Could not start the run: HTTP ${started.status} ${started.text.slice(0, 500)}`); return 2; }
  const id = started.data.id;
  console.log(`Run ${id} queued${started.data.url ? ` · ${started.data.url}` : ''}`);

  const deadline = Date.now() + Number(opts.timeout || 60) * 60_000;
  let run = started.data;
  let last = '';
  while (!run.finished) {
    if (Date.now() > deadline) { console.error(`The run did not finish within ${opts.timeout || 60} minutes (status ${run.status}).`); return 3; }
    await new Promise((r) => setTimeout(r, 10_000));
    const res = await call<Run>('GET', `/runs/${id}`);
    if (res.status !== 200) { console.error(`Could not read the run: HTTP ${res.status}`); continue; }
    run = res.data;
    if (run.status !== last) { console.log(`… ${run.status}`); last = run.status; }
  }

  const c = run.counts ?? {};
  console.log(`Run ${run.status}: ${c.passed ?? 0}/${c.total ?? 0} passed, ${c.failed ?? 0} failed, ${c.flaky ?? 0} flaky, ${c.healed ?? 0} healed`);
  if (run.error) console.log(run.error);

  if (opts.junit) {
    const xml = await call<string>('GET', `/runs/${id}/junit`, undefined, 'application/xml');
    if (xml.status === 200) {
      fs.mkdirSync(path.dirname(path.resolve(opts.junit)), { recursive: true });
      fs.writeFileSync(opts.junit, xml.text);
      console.log(`JUnit results → ${opts.junit}`);
    } else console.error(`Could not download the JUnit results: HTTP ${xml.status}`);
  }
  return run.passed ? 0 : 1;
}

main().then((code) => process.exit(code), (e) => { console.error((e as Error).message); process.exit(2); });
