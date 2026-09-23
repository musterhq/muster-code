import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {listFiles} from '../src/runtime/files.ts';
import {gitBadgeFor, gitBadgeMap} from '../src/renderer/fileTreePrefs.ts';

test('WRK-06: .git is hidden by default and listed when "Show hidden files" is on', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muster-hidden-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, '.git'));
  await writeFile(join(root, '.env.example'), 'X=1');
  await writeFile(join(root, 'a.ts'), '');
  assert.deepEqual((await listFiles(root, '')).map(entry => entry.name), ['.env.example', 'a.ts']);
  assert.deepEqual((await listFiles(root, '', {showHidden: true})).map(entry => entry.name), ['.git', '.env.example', 'a.ts']);
});

test('WRK-06: git badges come from the loaded Changes list, with folder dots for nested changes', () => {
  const map = gitBadgeMap([
    {path: 'src/app.ts', status: 'modified'},
    {path: 'src/new/one.ts', status: 'untracked'},
    {path: 'README.md', status: 'added'},
    {path: 'old.txt', status: 'deleted'},
    {path: 'src/merge.ts', status: 'conflicted'},
    {path: 'weird.bin', status: 'unchanged'},
  ]);
  assert.equal(map.get('src/app.ts')?.letter, 'M');
  assert.equal(map.get('src/new/one.ts')?.letter, 'U');
  assert.equal(map.get('README.md')?.letter, 'A');
  assert.equal(map.get('old.txt')?.letter, 'D');
  assert.equal(map.get('dir:src')?.tone, 'conflict', 'a conflict inside a folder outranks other changes');
  assert.equal(map.get('dir:src/new')?.tone, 'modified');
  assert.equal(map.has('weird.bin'), false);
  assert.equal(gitBadgeFor('renamed')?.letter, 'R');
  assert.equal(gitBadgeMap(undefined).size, 0);
});

test('WRK-06: only VCS internals and OS litter are hidden by default; ordinary dotfiles always show', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muster-hidden-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, '.git'));
  await mkdir(join(root, '.github'));
  await writeFile(join(root, '.DS_Store'), '');
  await writeFile(join(root, '.env'), 'X=1');
  await writeFile(join(root, 'a.ts'), '');
  assert.deepEqual((await listFiles(root, '')).map(entry => entry.name), ['.github', '.env', 'a.ts']);
  assert.deepEqual((await listFiles(root, '', {showHidden: true})).map(entry => entry.name), ['.git', '.github', '.DS_Store', '.env', 'a.ts']);
});
