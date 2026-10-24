import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cancelContentSearch, searchContent} from '../src/runtime/files.ts';

// These cases run the real `rg` binary. Without it the real path cannot be exercised (the JS fallback has its own file).
const hasRg = spawnSync('rg', ['--version'], {stdio: 'ignore'}).status === 0;
const skip = hasRg ? false : 'ripgrep (rg) is not installed on this machine';
// ripgrep prints paths as "./src/a.txt" while the JS fallback prints "src/a.txt"; compare the folder-relative part.
const bare = (path: string) => path.replace(/^\.\//, '');

async function folder(t: {after: (fn: () => Promise<void>) => void}, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => { await rm(root, {recursive: true, force: true}); });
  return root;
}

// Spec: MUS-SPEC-07-33A (docs/spec/clauses/07-files-editor-and-search.md#mus-spec-07-33a)
test('ripgrep content search returns path, line and text, honouring case and literal or regex modes', {skip}, async t => {
  const root = await folder(t, 'muster-rg-find-');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'a.txt'), 'first line\nhello Needle here\nlast\n');
  await writeFile(join(root, 'src', 'b.txt'), 'needle at the top\nnothing\nNEEDLE x\n');
  await writeFile(join(root, 'src', 'c.txt'), 'ne+dle is literal text\n');

  const insensitive = await searchContent(root, '', 'needle');
  assert.equal(insensitive.truncated, false);
  const rows = insensitive.matches.map(match => `${bare(match.path)}:${match.line}:${match.text}`).sort();
  assert.deepEqual(rows, ['src/a.txt:2:hello Needle here', 'src/b.txt:1:needle at the top', 'src/b.txt:3:NEEDLE x']);

  const sensitive = await searchContent(root, '', 'needle', {caseSensitive: true});
  assert.deepEqual(sensitive.matches.map(match => `${bare(match.path)}:${match.line}`), ['src/b.txt:1'], 'Match case drops the other capitalisations');

  const literal = await searchContent(root, '', 'ne+dle');
  assert.deepEqual(literal.matches.map(match => bare(match.path)), ['src/c.txt'], 'a plain search treats + as text');
  const pattern = await searchContent(root, '', 'ne+dle', {regex: true});
  assert.deepEqual(pattern.matches.map(match => bare(match.path)).sort(), ['src/a.txt', 'src/b.txt', 'src/b.txt'], 'a regular expression search treats + as a repeat');

  assert.deepEqual((await searchContent(root, '', 'absent-text')).matches, [], 'no match is an empty, complete result');
  assert.deepEqual((await searchContent(root, 'src', 'needle at')).matches.map(match => `${bare(match.path)}:${match.line}`), ['b.txt:1'], 'a sub-folder is searched relative to itself');
});

// Spec: MUS-SPEC-07-33B (docs/spec/clauses/07-files-editor-and-search.md#mus-spec-07-33b)
test('ripgrep content search stops at 500 matches, reports truncation and clips long lines', {skip}, async t => {
  const root = await folder(t, 'muster-rg-bounds-');
  const body = Array.from({length: 30}, (_, i) => `hit ${i}`).join('\n') + '\n';
  await Promise.all(Array.from({length: 30}, (_, i) => writeFile(join(root, `f${i}.txt`), body)));
  const capped = await searchContent(root, '', 'hit ');
  assert.equal(capped.matches.length, 500, '900 matching lines come back as the first 500');
  assert.equal(capped.truncated, true, 'and the result says it is partial');

  const under = await mkdtemp(join(tmpdir(), 'muster-rg-under-'));
  t.after(async () => { await rm(under, {recursive: true, force: true}); });
  await writeFile(join(under, 'long.txt'), `needle ${'x'.repeat(900)}\n`);
  const clipped = await searchContent(under, '', 'needle');
  assert.equal(clipped.matches.length, 1);
  assert.equal(clipped.matches[0].text.length, 500, 'a long line is clipped to 500 characters');
  assert.equal(clipped.truncated, false, 'a small result is not marked partial');
});

// Spec: MUS-SPEC-07-33C (docs/spec/clauses/07-files-editor-and-search.md#mus-spec-07-33c)
test('cancelling a ripgrep content search ends it early as truncated and frees the request id', {skip}, async t => {
  const root = await folder(t, 'muster-rg-cancel-');
  // 3000 files, every tenth one matching: big enough that ripgrep is still walking when the cancel arrives.
  await Promise.all(Array.from({length: 3000}, (_, i) => writeFile(join(root, `f${i}.txt`), i % 10 === 0 ? 'needle\n' : 'other\n')));
  const full = await searchContent(root, '', 'needle');
  assert.equal(full.matches.length, 300, 'uncancelled, every matching file is found');
  assert.equal(full.truncated, false);

  const pending = searchContent(root, '', 'needle', {requestId: 'req-1'});
  // The request id is registered only after the folder resolves, which the test cannot observe, so cancel on every
  // event-loop turn until the search settles. A cancel that lands before ripgrep starts or while it runs both end it as partial.
  let settled = false;
  const cancelling = (async () => { while (!settled) { cancelContentSearch('req-1'); await new Promise(resolve => setImmediate(resolve)); } })();
  const cancelled = await pending.finally(() => { settled = true; });
  await cancelling;
  assert.equal(cancelled.truncated, true, 'a cancelled search is reported as partial');
  assert.ok(cancelled.matches.length < 300, `cancel stopped it early (${cancelled.matches.length} of 300 matches)`);

  cancelContentSearch('req-1'); // an id that already finished is a harmless no-op
  const again = await searchContent(root, '', 'needle', {requestId: 'req-1'});
  assert.equal(again.matches.length, 300, 'the same id works again once the first search is over');
  assert.equal(again.truncated, false);
});
