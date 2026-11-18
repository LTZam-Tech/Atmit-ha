/**
 * Export a project as a standalone Playwright project:
 *   npx tsx scripts/export-code.ts <app> [outDir]      (default exports/<app>-playwright)
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, currentApp } from '../src/core/app';
import { generateProject } from '../src/core/export/codegen';

const app = process.argv[2] ?? currentApp();
const out = path.resolve(process.argv[3] ?? path.join(ROOT, 'exports', `${app}-playwright`));
const { files, warnings } = generateProject(app);
for (const [rel, content] of files) {
  const f = path.join(out, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}
console.log(`✔ ${files.size} files → ${out}`);
for (const w of warnings) console.log(`⚠ ${w}`);
