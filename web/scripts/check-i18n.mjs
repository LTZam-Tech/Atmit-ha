// Lists English texts used with the `t` pipe or i18n.t() that have no Arabic in src/app/core/i18n-ar.ts.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../src/app');
const dict = fs.readFileSync(path.join(root, 'core/i18n-ar.ts'), 'utf8');
const known = new Set([...dict.matchAll(/^\s*'((?:[^'\\]|\\.)*)':/gm)].map((m) => m[1].replace(/\\'/g, "'")));

const files = [];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.ts') && files.push(path.join(d, e.name))));
walk(root);

const missing = new Map();
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const texts = [...src.matchAll(/'((?:[^'\\]|\\.)+)'\s*\|\s*t\b/g), ...src.matchAll(/\.t\('((?:[^'\\]|\\.)+)'/g), ...src.matchAll(/label: '((?:[^'\\]|\\.)+)'/g), ...src.matchAll(/<at-(?:empty|loading) text="([^"]+)"/g)].map((m) => m[1]);
  for (const t of texts) if (!known.has(t)) missing.set(t, path.relative(root, f));
}
for (const [t, f] of missing) console.log(`${f}: "${t}"`);
if (missing.size) { console.log(`\n${missing.size} text(s) without Arabic`); process.exit(1); }
console.log('Every text has Arabic.');
