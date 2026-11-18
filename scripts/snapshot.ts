/**
 * Project snapshots (ADR-0014) from the command line:
 *   npx tsx scripts/snapshot.ts export <app> [file.json]     apps/<app> → JSON (no passwords); stdout when no file
 *   npx tsx scripts/snapshot.ts import <file.json> [--as key] [--overwrite]   JSON → apps/<key>/
 * Upload an exported snapshot to the platform: POST /api/v1/workspaces/{workspace}/projects/import
 */
import fs from 'node:fs';
import { APPS_DIR } from '../src/core/app';
import { toSnapshot, writeSnapshot, type ProjectSnapshot } from '../src/core/snapshot';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest.splice(i, 2)[1] : undefined; };
const has = (name: string) => { const i = rest.indexOf(name); if (i >= 0) rest.splice(i, 1); return i >= 0; };

if (cmd === 'export' && rest[0]) {
  const json = JSON.stringify(toSnapshot(rest[0]), null, 1);
  if (rest[1]) { fs.writeFileSync(rest[1], json); console.log(`snapshot of ${rest[0]} → ${rest[1]}`); }
  else process.stdout.write(json);
} else if (cmd === 'import' && rest[0]) {
  const as = flag('--as');
  const overwrite = has('--overwrite');
  const snap = JSON.parse(fs.readFileSync(rest[0], 'utf8')) as ProjectSnapshot;
  const dir = writeSnapshot(snap, APPS_DIR, { as, overwrite });
  console.log(`snapshot ${snap.key} → ${dir} (add passwords to secrets.yml)`);
} else {
  console.error('usage: snapshot.ts export <app> [file.json] | import <file.json> [--as key] [--overwrite]');
  process.exit(2);
}
