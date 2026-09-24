import assert from 'node:assert/strict';
import {test} from 'node:test';
import {groupChanges, UNTRACKED_GROUP_THRESHOLD} from '../src/renderer/components/changeGrouping.ts';
import type {ChangedFile} from '../src/shared/protocol.ts';

const untracked = (path: string, untrackedRoot?: string): ChangedFile => ({path, status: 'untracked', adds: 1, dels: 0, ...(untrackedRoot ? {untrackedRoot} : {})});
const modified = (path: string): ChangedFile => ({path, status: 'modified', adds: 2, dels: 1});

test('a handful of loose untracked files stay listed individually', () => {
  const files = [modified('src/a.ts'), untracked('README.md'), untracked('notes.txt')];
  const rows = groupChanges(files);
  assert.deepEqual(rows, files.map(file => ({kind: 'file', file})));
});

test('an un-gitignored directory with many untracked files collapses to one row', () => {
  const files: ChangedFile[] = [
    modified('package.json'),
    ...Array.from({length: 470}, (_, i) => untracked(`node_modules/pkg-${i}/index.js`)),
    untracked('README.md'),
  ];
  const rows = groupChanges(files);
  assert.equal(rows.length, 3, `expected package.json + one node_modules group + README, got ${rows.length}`);
  assert.deepEqual(rows[0], {kind: 'file', file: files[0]});
  const group = rows[1];
  assert.equal(group.kind, 'group');
  if (group.kind === 'group') {
    assert.equal(group.dir, 'node_modules');
    assert.equal(group.files.length, 470);
  }
  assert.deepEqual(rows[2], {kind: 'file', file: files[files.length - 1]});
});

test('tracked (non-untracked) changes are never grouped, even in bulk', () => {
  const files = Array.from({length: 30}, (_, i) => modified(`dist/chunk-${i}.js`));
  const rows = groupChanges(files);
  assert.equal(rows.length, 30, 'modified files under one directory stay individually listed');
  assert.ok(rows.every(row => row.kind === 'file'));
});

test('the threshold is exact for a fully-untracked folder: one below it stays flat, one at it collapses', () => {
  const below = Array.from({length: UNTRACKED_GROUP_THRESHOLD - 1}, (_, i) => untracked(`src/feature/f${i}.ts`, 'src/feature/'));
  assert.equal(groupChanges(below).length, below.length);
  const atThreshold = Array.from({length: UNTRACKED_GROUP_THRESHOLD}, (_, i) => untracked(`src/feature/f${i}.ts`, 'src/feature/'));
  const rows = groupChanges(atThreshold);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'group');
  if (rows[0].kind === 'group') assert.equal(rows[0].dir, 'src/feature', 'groups at git\'s ?? dir/ root, not the top-level dir');
});

test('new files git reports individually are never hidden, however many share a top-level dir', () => {
  const files = Array.from({length: 12}, (_, i) => untracked(`src/new-${i}.ts`));
  const rows = groupChanges(files);
  assert.equal(rows.length, 12);
  assert.ok(rows.every(row => row.kind === 'file'));
});

test('noise directories collapse at any depth, separately from real new files next to them', () => {
  const files = [
    untracked('packages/x/node_modules/a/index.js', 'packages/x/'),
    untracked('packages/x/node_modules/b/index.js', 'packages/x/'),
    ...Array.from({length: 3}, (_, i) => untracked(`packages/x/src/f${i}.ts`, 'packages/x/')),
    untracked('dist/bundle.js', 'dist/'),
  ];
  const rows = groupChanges(files);
  assert.deepEqual(rows.map(row => row.kind === 'group' ? `group:${row.dir}:${row.files.length}` : `file:${row.file.path}`), [
    'group:packages/x/node_modules:2',
    'file:packages/x/src/f0.ts', 'file:packages/x/src/f1.ts', 'file:packages/x/src/f2.ts',
    'group:dist:1',
  ]);
});

test('a big fully-untracked folder groups under its own root while sibling roots stay independent', () => {
  const files = [
    ...Array.from({length: 9}, (_, i) => untracked(`src/a/f${i}.ts`, 'src/a/')),
    untracked('src/b/one.ts', 'src/b/'),
  ];
  const rows = groupChanges(files);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind === 'group' && rows[0].dir, 'src/a');
  assert.equal(rows[1].kind, 'file');
});

test('the review host tags untracked files with git\'s fully-untracked directory root', async () => {
  const {execFileSync} = await import('node:child_process');
  const {mkdtempSync, mkdirSync, writeFileSync, rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {AgentModeReviewHost} = await import('../src/runtime/review.ts');
  const root = mkdtempSync(join(tmpdir(), 'muster-group-'));
  try {
    const run = (...args: string[]) => execFileSync('git', args, {cwd: root, stdio: 'pipe'});
    run('init', '-q'); run('config', 'user.email', 't@t'); run('config', 'user.name', 't');
    mkdirSync(join(root, 'src/feature'), {recursive: true});
    writeFileSync(join(root, 'src/tracked.ts'), 'x\n'); run('add', '.'); run('commit', '-qm', 'init');
    writeFileSync(join(root, 'src/loose.ts'), 'y\n');
    writeFileSync(join(root, 'src/feature/a.ts'), 'a\n');
    const {files} = await new AgentModeReviewHost(() => root).listChanges();
    const byPath = new Map(files.map(file => [file.path, file]));
    assert.equal(byPath.get('src/loose.ts')?.untrackedRoot, undefined);
    assert.equal(byPath.get('src/feature/a.ts')?.untrackedRoot, 'src/feature/');
  } finally { rmSync(root, {recursive: true, force: true}); }
});
