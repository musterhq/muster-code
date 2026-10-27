import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const root = resolve(import.meta.dirname, '..');
const guard = join(root, 'scripts/check-test-coverage.mjs');
const check = (cwd: string) => spawnSync(process.execPath, [guard, cwd], {encoding: 'utf8'});

test('every app test file belongs to a runner or a documented support role', () => {
  const result = check(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('the ownership guard rejects orphan files in both test directories and nested folders', t => {
  const dir = mkdtempSync(join(tmpdir(), 'muster-test-coverage-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({scripts: {test: "node --test 'tests/*.test.ts'"}}));
  for (const folder of ['tests', 'test', 'tests/nested']) mkdirSync(join(dir, folder), {recursive: true});
  writeFileSync(join(dir, 'tests/covered.test.ts'), '');
  writeFileSync(join(dir, 'tests/new-renderer.tsx'), '');
  writeFileSync(join(dir, 'tests/run-new.mjs'), '');
  assert.equal(check(dir).status, 0, 'new node, renderer and run-*.mjs entries are automatically covered');
  for (const file of ['tests/forgotten.cjs', 'test/forgotten.test.ts', 'tests/nested/forgotten.test.ts']) {
    writeFileSync(join(dir, file), '');
    const result = check(dir);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`${file} belongs to no test runner`), result.stderr);
    rmSync(join(dir, file));
  }
  assert.equal(check(dir).status, 0, 'removing the orphan restores the check');
});

test('renderer discovery picks up new tsx and run scripts without editing a list', t => {
  // Keep the fixture under the app so the real runner resolves its existing esbuild dependency.
  const fixtures = join(root, 'dist');
  mkdirSync(fixtures, {recursive: true});
  const dir = mkdtempSync(join(fixtures, 'renderer-discovery-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  mkdirSync(join(dir, 'tests'));
  mkdirSync(join(dir, 'scripts'));
  for (const script of ['renderer-suites.mjs', 'test-renderer.mjs']) cpSync(join(root, 'scripts', script), join(dir, 'scripts', script));
  writeFileSync(join(dir, 'tests/new-renderer.tsx'), "console.log('NEW TSX SUITE RAN');");
  writeFileSync(join(dir, 'tests/run-new.mjs'), "console.log('NEW SCRIPT DRIVER RAN');");
  writeFileSync(join(dir, 'tests/device-noun-dom-body.tsx'), "throw new Error('shared body must not run on its own');");
  const result = spawnSync(process.execPath, [join(dir, 'scripts/test-renderer.mjs')], {cwd: dir, encoding: 'utf8', timeout: 30_000});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /NEW TSX SUITE RAN/);
  assert.match(result.stdout, /NEW SCRIPT DRIVER RAN/);
});
