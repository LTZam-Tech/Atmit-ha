/**
 * Visual page map — a full-page screenshot + the box of every OR element, used by the
 * Control Panel's visual review (numbered boxes over the screenshot).
 *
 *   apps/<app>/or/.visual/<page>.png | .json        (pages)
 *   apps/<app>/or/drafts/<page>.visual.png | .json  (drafts, before review)
 * Regenerable → git-ignored.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import type { Box } from './harvest';

export interface VisualMap { url: string; width: number; height: number; captured: string; boxes: Record<string, Box | null> }

export const visualDir = (orDir: string) => path.join(orDir, '.visual');

export function saveVisual(dir: string, base: string, png: Buffer, map: VisualMap) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${base}.png`), png);
  fs.writeFileSync(path.join(dir, `${base}.json`), JSON.stringify(map, null, 1));
}

export async function pageSize(page: Page): Promise<{ width: number; height: number }> {
  return page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
}

/** Box of a locator in page coordinates (null when not found / not visible) */
export async function boxOf(locator: import('@playwright/test').Locator): Promise<Box | null> {
  const b = await locator.evaluate((n) => { const r = n.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; }).catch(() => null);
  if (!b || (b.w === 0 && b.h === 0)) return null;
  return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) };
}
