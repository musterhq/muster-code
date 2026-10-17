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

test('a valid UTF-8 file cut at the preview limit is not reported as having an encoding problem', async () => {
  const dir = await workspace();
  // 3-byte characters: 512 KiB is not a multiple of 3, so the cut lands inside a character.
  await writeFile(join(dir, 'long.txt'), '€'.repeat(200_000), 'utf8');
  const result = await readBody(dir, 'long.txt');
  assert.equal(result.truncated, true);
  assert.equal(result.encodingWarning, false);
  assert.equal(result.text.includes('�'), false);
});
