/** Starts the bundled demo app when the current ENV needs it (used by scripts outside the test runner). */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { environment } from '../../config/environment';

export async function ensureApp(): Promise<ChildProcess | undefined> {
  if (!environment.startDemoApp || (await reachable(environment.baseURL))) return undefined;
  const proc = spawn(process.execPath, [path.resolve(import.meta.dirname, '../../demo-app/server.js')], { stdio: 'ignore' });
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    if (await reachable(environment.baseURL)) return proc;
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill();
  throw new Error(`App not reachable at ${environment.baseURL}`);
}

export async function reachable(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

/** Returns the saved session file for a user, running the setup project once if it is missing. */
export async function ensureSession(user?: string): Promise<string | undefined> {
  if (!user || user === 'none') return undefined;
  const { authFile } = await import('../core/pages-setup');
  const fs = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const file = authFile(user);
  if (!fs.existsSync(file)) {
    console.log(`→ No saved session for "${user}" — running setup…`);
    spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../../node_modules/@playwright/test/cli.js'), 'test', '--project=setup', '--reporter=line'], {
      stdio: 'inherit', env: { ...process.env, REPORT_OPEN: 'never' }, cwd: path.resolve(import.meta.dirname, '../..'),
    });
  }
  return fs.existsSync(file) ? file : undefined;
}
