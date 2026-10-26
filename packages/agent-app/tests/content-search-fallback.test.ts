import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, symlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// An empty PATH makes `rg` unfindable, so searchContent takes its JS walk. The ripgrep probe is cached per process and
// node:test runs each file in its own process, so this file always exercises the fallback.
const emptyBin = await mkdtemp(join(tmpdir(), 'muster-no-rg-'));
process.env.PATH = emptyBin;
const {cancelContentSearch, searchContent} = await import('../src/runtime/files.ts');

async function folder(t: {after: (fn: () => Promise<void>) => void}, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => { await rm(root, {recursive: true, force: true}); });
  return root;
}

// Spec: MUS-SPEC-07-33D (docs/spec/clauses/07-files-editor-and-search.md#mus-spec-07-33d)
test('content search without ripgrep walks the folder for matches, case modes and regular expressions', async t => {
  t.after(async () => { await rm(emptyBin, {recursive: true, force: true}); });
  const root = await folder(t, 'muster-js-find-');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'a.txt'), 'first line\nhello Needle here\nlast\n');
  await writeFile(join(root, 'src', 'b.txt'), 'needle at the top\nnothing\nNEEDLE x\n');
  await writeFile(join(root, 'src', 'c.txt'), 'ne+dle is literal text\n');

  const insensitive = await searchContent(root, '', 'needle');
  assert.equal(insensitive.truncated, false);
  assert.deepEqual(insensitive.matches.map(match => `${match.path}:${match.line}:${match.text}`).sort(), ['src/a.txt:2:hello Needle here', 'src/b.txt:1:needle at the top', 'src/b.txt:3:NEEDLE x']);

  // Match case on a plain search is not asserted here: the walk ignores it today (reported separately).
  const sensitiveRegex = await searchContent(root, '', 'needle', {regex: true, caseSensitive: true});
  assert.deepEqual(sensitiveRegex.matches.map(match => `${match.path}:${match.line}`), ['src/b.txt:1'], 'Match case drops the other capitalisations in a regular expression search');

  assert.deepEqual((await searchContent(root, '', 'ne+dle')).matches.map(match => match.path), ['src/c.txt'], 'a plain search treats + as text');
  assert.deepEqual((await searchContent(root, '', 'ne+dle', {regex: true})).matches.map(match => match.path).sort(), ['src/a.txt', 'src/b.txt', 'src/b.txt'], 'a regular expression search treats + as a repeat');
  await assert.rejects(searchContent(root, '', '(', {regex: true}), /Invalid regular expression/);
  assert.deepEqual((await searchContent(root, '', 'absent-text')).matches, [], 'no match is an empty, complete result');
  assert.deepEqual((await searchContent(root, 'src', 'needle at')).matches.map(match => `${match.path}:${match.line}`), ['b.txt:1'], 'a sub-folder is searched relative to itself');
});

// Spec: MUS-SPEC-07-33E (docs/spec/clauses/07-files-editor-and-search.md#mus-spec-07-33e)
test('content search skips build folders and binary files, and stays inside the folder', async t => {
  const root = await folder(t, 'muster-js-skip-');
  const outside = await folder(t, 'muster-js-outside-');
  for (const dir of ['node_modules/pkg', '.git', 'dist', 'build', 'src']) await mkdir(join(root, dir), {recursive: true});
  for (const file of ['node_modules/pkg/x.js', '.git/config', 'dist/out.js', 'build/out.js']) await writeFile(join(root, file), 'needle\n');
  await writeFile(join(root, 'src', 'ok.txt'), 'needle\n');
  await writeFile(join(root, 'src', 'image.bin'), Buffer.from('needle\0\0\0binary'));
  await writeFile(join(outside, 'secret.txt'), 'needle\n');
  await symlink(outside, join(root, 'linked'));
  const found = await searchContent(root, '', 'needle');
  assert.deepEqual(found.matches.map(match => match.path), ['src/ok.txt'], 'node_modules, .git, dist, build, binary files and links that leave the folder are not searched');
  await assert.rejects(searchContent(root, '..', 'needle'), /escape/);
  await assert.rejects(searchContent(root, '', ''), /1–512 characters/);
  await assert.rejects(searchContent(root, '', 'x'.repeat(513)), /1–512 characters/);
});

// Spec: MUS-SPEC-07-33F (docs/spec/clauses/07-files-editor-and-search.md#mus-spec-07-33f)
test('content search without ripgrep stops at 500 matches, reports truncation and clips long lines', async t => {
  const root = await folder(t, 'muster-js-bounds-');
  const body = Array.from({length: 30}, (_, i) => `hit ${i}`).join('\n') + '\n';
  await Promise.all(Array.from({length: 30}, (_, i) => writeFile(join(root, `f${i}.txt`), body)));
  const capped = await searchContent(root, '', 'hit ');
  assert.equal(capped.matches.length, 500, '900 matching lines come back as the first 500');
  assert.equal(capped.truncated, true, 'and the result says it is partial');

  const under = await folder(t, 'muster-js-under-');
  await writeFile(join(under, 'long.txt'), `needle ${'x'.repeat(900)}\n`);
  const clipped = await searchContent(under, '', 'needle');
  assert.equal(clipped.matches.length, 1);
  assert.equal(clipped.matches[0].text.length, 500, 'a long line is clipped to 500 characters');
  assert.equal(clipped.truncated, false, 'a small result is not marked partial');
});

// Spec: MUS-SPEC-07-33G (docs/spec/clauses/07-files-editor-and-search.md#mus-spec-07-33g)
test('cancelling a content search without ripgrep stops the walk early as truncated and frees the request id', async t => {
  const root = await folder(t, 'muster-js-cancel-');
  // 200 folders each holding a matching file: the walk reads one folder at a time, so a cancel has many chances to land.
  await Promise.all(Array.from({length: 200}, async (_, i) => { await mkdir(join(root, `d${i}`)); await writeFile(join(root, `d${i}`, 'f.txt'), 'needle\n'); }));
  const full = await searchContent(root, '', 'needle');
  assert.equal(full.matches.length, 200, 'uncancelled, every file is found');
  assert.equal(full.truncated, false);

  const pending = searchContent(root, '', 'needle', {requestId: 'req-js'});
  // The request id is registered only after the folder resolves, which the test cannot observe, so cancel on every
  // event-loop turn until the search settles.
  let settled = false;
  const cancelling = (async () => { while (!settled) { cancelContentSearch('req-js'); await new Promise(resolve => setImmediate(resolve)); } })();
  const cancelled = await pending.finally(() => { settled = true; });
  await cancelling;
  assert.equal(cancelled.truncated, true, 'a cancelled search is reported as partial');
  assert.ok(cancelled.matches.length < 200, `cancel stopped the walk early (${cancelled.matches.length} of 200 matches)`);

  cancelContentSearch('req-js'); // an id that already finished is a harmless no-op
  const again = await searchContent(root, '', 'needle', {requestId: 'req-js'});
  assert.equal(again.matches.length, 200, 'the same id works again once the first search is over');
  assert.equal(again.truncated, false);
});
