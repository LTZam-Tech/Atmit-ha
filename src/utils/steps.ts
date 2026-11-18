/**
 * Typed test steps. Every action in a Page Object goes through one of these, so the
 * Smart Report shows the scenario as:  Navigate → Data entry → Click → Verify
 */
import { test, type Page } from '@playwright/test';

export type StepKind = 'Navigate' | 'Data entry' | 'Click' | 'Verify' | 'Setup' | 'API';

const SCREENSHOT_STEPS = (process.env.SCREENSHOT_STEPS ?? 'verify') as 'all' | 'verify' | 'none';

async function run<T>(kind: StepKind, title: string, body: () => Promise<T>, page?: Page): Promise<T> {
  return test.step(`[${kind}] ${title}`, async () => {
    const result = await body();
    const wantShot = page && (SCREENSHOT_STEPS === 'all' || (SCREENSHOT_STEPS === 'verify' && kind === 'Verify'));
    if (wantShot) {
      const shot = await page.screenshot({ fullPage: false }).catch(() => undefined);
      if (shot) await test.info().attach(`step: ${title}`, { body: shot, contentType: 'image/png' });
    }
    return result;
  });
}

export const step = {
  navigate: <T>(title: string, body: () => Promise<T>, page?: Page) => run('Navigate', title, body, page),
  enter: <T>(title: string, body: () => Promise<T>, page?: Page) => run('Data entry', title, body, page),
  click: <T>(title: string, body: () => Promise<T>, page?: Page) => run('Click', title, body, page),
  verify: <T>(title: string, body: () => Promise<T>, page?: Page) => run('Verify', title, body, page),
  setup: <T>(title: string, body: () => Promise<T>) => run('Setup', title, body),
  api: <T>(title: string, body: () => Promise<T>) => run('API', title, body),
};

/** Mask secrets before they reach the report */
export const mask = (value: string) => (value ? '•'.repeat(Math.min(value.length, 8)) : '(empty)');
