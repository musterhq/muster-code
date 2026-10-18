import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync} from 'node:fs';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {removeTmp} from './fixtures/tmp-dir.ts';

test('removeTmp succeeds while a straggler process is still writing into the directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'muster-tmp-race-'));
  await mkdir(join(dir, '.codex'));
  let writing = true;
  const writer = (async () => {
    for (let i = 0; writing; i++) { await writeFile(join(dir, '.codex', `f${i % 3}`), 'x').catch(() => {}); await new Promise((r) => setImmediate(r)); }
  })();
  setTimeout(() => { writing = false; }, 300);
  await removeTmp(dir);
  writing = false; await writer;
  if (existsSync(dir)) await removeTmp(dir);
  assert.equal(existsSync(dir), false);
});
