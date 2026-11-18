/** File helpers for upload/download scenarios. */
import fs from 'node:fs';
import path from 'node:path';
import { test, type Download } from '@playwright/test';

/** Creates a temporary file inside the test's output folder (cleaned automatically). */
export function tempFile(name: string, content: string | Buffer): string {
  const file = test.info().outputPath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** Saves a download into the test output folder and returns its path. */
export async function saveDownload(download: Download): Promise<string> {
  const file = test.info().outputPath(download.suggestedFilename());
  await download.saveAs(file);
  return file;
}
