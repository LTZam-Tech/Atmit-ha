/**
 * The bundled demo application (demo-app/server.js) for environments with startDemoApp: the agent starts it once
 * and shares it between the jobs that need it — runs side by side (ATIMTHA_AGENT_SLOTS) and explore jobs, which open
 * pages without the test runner. Playwright reuses it (ATIMTHA_DEMO_SHARED=1 in playwright.config.ts). It stops when
 * the last job using it ends. Only local addresses are served this way.
 */
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { ROOT } from '../src/core/app';

let child: ChildProcess | undefined;
let users = 0;
let starting: Promise<void> | undefined;

const up = async (url: string) => {
  try { return (await fetch(url, { signal: AbortSignal.timeout(2000) })).status < 500; } catch { return false; }
};

export function isLocal(url: string): boolean {
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname); } catch { return false; }
}

/** the demo app is running at baseURL when this resolves; pair every call with releaseDemo() */
export async function acquireDemo(baseURL: string): Promise<void> {
  users++;
  try { await start(baseURL); }
  catch (e) { users = Math.max(0, users - 1); throw e; }
}

function start(baseURL: string): Promise<void> {
  if (starting) return starting;
  if (child && child.exitCode === null) return Promise.resolve();
  starting = (async () => {
    if (await up(baseURL)) return; // already running (another agent, or started by hand): used as it is
    const port = new URL(baseURL).port || '80';
    child = spawn(process.execPath, [path.join(ROOT, 'demo-app/server.js')], {
      cwd: ROOT, env: { PATH: process.env.PATH, DEMO_PORT: port }, stdio: ['ignore', 'ignore', 'inherit'],
    });
    for (let i = 0; i < 30; i++) {
      if (await up(baseURL)) return;
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`The demo app did not start on ${baseURL}`);
  })().finally(() => { starting = undefined; });
  return starting;
}

export function releaseDemo(): void {
  users = Math.max(0, users - 1);
  if (users === 0 && child) {
    child.kill('SIGTERM');
    child = undefined;
  }
}
