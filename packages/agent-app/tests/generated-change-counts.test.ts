import assert from 'node:assert/strict';
import {test} from 'node:test';
import {generatedNote, isGeneratedFile, isLockFile, splitChangeTotals} from '../src/renderer/changeCounts.ts';

test('F59: lockfiles are counted apart from authored changes, with one wording for every pill', () => {
  const totals = splitChangeTotals([
    {path: 'package-lock.json', adds: 4274, dels: 0},
    {path: 'apps/api/src/server.ts', adds: 1200, dels: 10},
    {path: 'README.md', adds: 376, dels: 0},
  ]);
  assert.equal(totals.files, 3, 'the lockfile is still one of the changed files');
  assert.equal(totals.adds, 1576, 'the headline is authored lines only');
  assert.equal(totals.dels, 10);
  assert.equal(totals.generated.adds, 4274);
  assert.deepEqual(generatedNote(totals.generated), {label: '1 lockfile', stats: '+4,274', title: 'package-lock.json: +4,274. Lockfiles and generated files are counted separately from your code changes.'});
});

test('lockfile and generated detection covers the common ecosystems but not real sources', () => {
  for (const path of ['package-lock.json', 'apps/web/pnpm-lock.yaml', 'yarn.lock', 'Cargo.lock', 'poetry.lock', 'go.sum', 'bun.lock']) assert.equal(isLockFile(path), true, path);
  for (const path of ['dist/app.min.js', 'build/app.js.map', 'tsconfig.tsbuildinfo', 'src/__snapshots__/a.test.ts.snap']) assert.equal(isGeneratedFile(path), true, path);
  for (const path of ['package.json', 'src/lock.ts', 'docs/unlock.md', 'src/map.ts']) assert.equal(isGeneratedFile(path), false, path);
  const mixed = splitChangeTotals([{path: 'yarn.lock', adds: 10, dels: 2}, {path: 'dist/a.min.js', adds: 1, dels: 0}]);
  assert.equal(generatedNote(mixed.generated)?.label, '2 generated', 'a mix of lockfiles and build output is "generated"');
  assert.equal(generatedNote(splitChangeTotals([{path: 'src/a.ts', adds: 1, dels: 0}]).generated), undefined, 'no note without generated files');
});
