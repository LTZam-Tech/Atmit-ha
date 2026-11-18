/**
 * Regression guard for 0.1.0 compatibility: every bundled sample project must keep loading,
 * validating and exporting. These projects are also the fixtures for the future YAML → database migration.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listApps, loadApp, orDir } from '../../src/core/app';
import { readRepository } from '../../src/core/or/loader';
import { readCases } from '../../src/core/cases/loader';
import { readFlows } from '../../src/core/cases/flows';
import { readNavigation } from '../../src/core/navigation';
import { generateProject } from '../../src/core/export/codegen';

const apps = listApps();

test('the four sample projects are present', () => {
  for (const a of ['demo', 'portal', 'txdemo', 'widget']) assert.ok(apps.includes(a), `missing sample project ${a}`);
});

for (const app of apps) {
  test(`${app}: app.yml, Smart OR, cases, workflows and navigation load without issues`, () => {
    const cfg = loadApp(app);
    assert.ok(cfg.name, 'project name');
    assert.ok(Object.keys(cfg.environments).length >= 1, 'at least one environment');
    const pages = readRepository(orDir(app));
    const { cases, issues } = readCases(app);
    assert.deepEqual(issues, [], 'case issues');
    assert.deepEqual(readFlows(cases, app).issues, [], 'workflow issues');
    assert.deepEqual(readNavigation(app, pages).issues, [], 'navigation issues');
  });

  test(`${app}: exports a standalone Playwright project`, () => {
    const { files } = generateProject(app);
    const names = [...files.keys()];
    for (const required of ['package.json', 'playwright.config.ts', 'tests/auth.setup.ts', '.env.example']) {
      assert.ok(names.includes(required), `${required} missing from export`);
    }
    assert.ok(names.some((n) => n.startsWith('pages/') && n.endsWith('Page.ts')), 'no Page Objects exported');
    for (const [name, content] of files) {
      assert.ok(!/password:\s*['"][^'"$]+['"]/i.test(content) || name === '.env.example', `${name} may contain a plain password`);
    }
  });
}
