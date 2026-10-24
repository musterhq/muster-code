import assert from 'node:assert/strict';
import {chmod, mkdtemp, mkdir, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, test} from 'node:test';
import {readFile as readBody, writeFile as saveBody, searchContent} from '../src/runtime/files.ts';
import {spawnSync} from 'node:child_process';

let root = '';
afterEach(async () => { if (root) { await rm(root, {recursive: true, force: true}); root = ''; } });
const workspace = async () => root = await mkdtemp(join(tmpdir(), 'muster-main-ipc-files-'));

// Spec: MUS-SPEC-07-562A (docs/spec/clauses/07-files-editor-and-search.md#mus-spec-07-562a)
test('a valid UTF-8 file cut at the preview limit is not reported as having an encoding problem', async () => {
  const dir = await workspace();
  // 3-byte characters: 512 KiB is not a multiple of 3, so the cut lands inside a character.
  await writeFile(join(dir, 'long.txt'), '€'.repeat(200_000), 'utf8');
  const result = await readBody(dir, 'long.txt');
  assert.equal(result.truncated, true);
  assert.equal(result.encodingWarning, false);
  assert.equal(result.text.includes('�'), false);
});

// Spec: MUS-SPEC-07-562B (docs/spec/clauses/07-files-editor-and-search.md#mus-spec-07-562b)
test('saving a file keeps its permissions, so a script stays executable', { skip: process.platform === 'win32' }, async () => {
  const dir = await workspace();
  await writeFile(join(dir, 'run.sh'), '#!/bin/sh\necho 1\n', 'utf8');
  await chmod(join(dir, 'run.sh'), 0o755);
  const first = await readBody(dir, 'run.sh');
  const saved = await saveBody(dir, 'run.sh', '#!/bin/sh\necho 2\n', first.revision);
  assert.equal(saved.conflict, false);
  assert.equal((await stat(join(dir, 'run.sh'))).mode & 0o777, 0o755);
});

// Spec: MUS-SPEC-07-562C (docs/spec/clauses/07-files-editor-and-search.md#mus-spec-07-562c)
test('content search returns folder-relative paths whether or not ripgrep is installed', { skip: spawnSync('rg', ['--version']).status !== 0 }, async () => {
  const dir = await workspace();
  await mkdir(join(dir, 'sub'));
  await writeFile(join(dir, 'sub', 'a.txt'), 'needle here\n', 'utf8');
  const result = await searchContent(dir, '', 'needle');
  assert.deepEqual(result.matches.map(match => match.path), ['sub/a.txt']);
});

// Spec: MUS-SPEC-07-562D (docs/spec/clauses/07-files-editor-and-search.md#mus-spec-07-562d)
test('a folder registered at a filesystem root still resolves paths inside it', async () => {
  const {resolveInside} = await import('../src/runtime/paths.ts');
  const {parse} = await import('node:path');
  const top = parse(process.cwd()).root;
  const target = await resolveInside(top, 'usr');
  assert.equal(target, join(top, 'usr'));
});
