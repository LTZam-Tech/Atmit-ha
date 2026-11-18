/**
 * Execution targets — WHERE the browser lives. Tests never know about this.
 *
 *   TARGET=local        Browser on this machine (default)
 *   TARGET=grid         Internal Playwright Grid (docker/grid.compose.yml) — default for CI
 *   TARGET=browserstack Cloud — needs BROWSERSTACK_USERNAME / BROWSERSTACK_ACCESS_KEY
 *   TARGET=lambdatest   Cloud — needs LT_USERNAME / LT_ACCESS_KEY
 *
 * Offline / air-gapped machines (still TARGET=local):
 *   BROWSER_CHANNEL=msedge | chrome   → use the browser already installed on the machine
 *   PLAYWRIGHT_BROWSERS_PATH=<dir>    → use browsers copied from a connected machine
 *                                       (run `npx playwright install` there, copy the folder)
 */
import type { PlaywrightTestConfig } from '@playwright/test';
import { createRequire } from 'node:module';

type ConnectOptions = NonNullable<NonNullable<PlaywrightTestConfig['use']>['connectOptions']>;

export type Target = 'local' | 'grid' | 'browserstack' | 'lambdatest';
export const TARGET = (process.env.TARGET ?? 'local') as Target;

// Cloud vendors must run the SAME Playwright version as the client.
const PW_VERSION: string = createRequire(import.meta.url)('@playwright/test/package.json').version;

export interface TargetSettings {
  connectOptions?: ConnectOptions;
  channel?: string;
  /** cloud/grid browsers cannot reach localhost on this machine */
  isRemote: boolean;
}

export function resolveTarget(): TargetSettings {
  switch (TARGET) {
    case 'local':
      return { isRemote: false, channel: process.env.BROWSER_CHANNEL || undefined };

    case 'grid':
      return {
        isRemote: true,
        connectOptions: {
          wsEndpoint: env('GRID_WS_URL', 'ws://localhost:3000/'),
          timeout: 30_000,
          // lets the remote browser reach a localhost app through this machine
          exposeNetwork: '<loopback>',
        },
      };

    case 'browserstack': {
      const caps = {
        browser: process.env.CLOUD_BROWSER ?? 'chrome',
        os: process.env.CLOUD_OS ?? 'Windows',
        os_version: process.env.CLOUD_OS_VERSION ?? '11',
        name: process.env.CLOUD_RUN_NAME ?? 'Playwright run',
        build: process.env.CLOUD_BUILD ?? `build-${new Date().toISOString().slice(0, 10)}`,
        'browserstack.username': env('BROWSERSTACK_USERNAME'),
        'browserstack.accessKey': env('BROWSERSTACK_ACCESS_KEY'),
        'client.playwrightVersion': PW_VERSION,
      };
      return {
        isRemote: true,
        connectOptions: {
          wsEndpoint: `wss://cdp.browserstack.com/playwright?caps=${encodeURIComponent(JSON.stringify(caps))}`,
        },
      };
    }

    case 'lambdatest': {
      const caps = {
        browserName: process.env.CLOUD_BROWSER ?? 'Chrome',
        browserVersion: 'latest',
        'LT:Options': {
          platform: process.env.CLOUD_OS ?? 'Windows 11',
          build: process.env.CLOUD_BUILD ?? `build-${new Date().toISOString().slice(0, 10)}`,
          name: process.env.CLOUD_RUN_NAME ?? 'Playwright run',
          user: env('LT_USERNAME'),
          accessKey: env('LT_ACCESS_KEY'),
          playwrightClientVersion: PW_VERSION,
        },
      };
      return {
        isRemote: true,
        connectOptions: {
          wsEndpoint: `wss://cdp.lambdatest.com/playwright?capabilities=${encodeURIComponent(JSON.stringify(caps))}`,
        },
      };
    }

    default:
      throw new Error(`[targets] Unknown TARGET "${TARGET}". Use local | grid | browserstack | lambdatest`);
  }
}

function env(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (!v) throw new Error(`[targets] TARGET=${TARGET} requires ${key}`);
  return v;
}
