import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

// Force the built-in search (no ripgrep) before the module probes for it.
process.env.PATH = '/nonexistent';
const {searchContent} = await import('../src/runtime/files.ts');

// Spec: MUS-SPEC-07-563C (docs/spec/clauses/07-files-editor-and-search.md#mus-spec-07-563c)
test('a catastrophic regular expression is cut off at the search deadline', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'muster-regex-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  await writeFile(join(dir, 'a.txt'), `${'a'.repeat(34)}!\n`);
  const started = Date.now();
  const result = await searchContent(dir, '', '^(a+)+$', {regex: true});
  assert.ok(Date.now() - started < 8_000, `took ${Date.now() - started} ms`);
  assert.equal(result.truncated, true);
});
