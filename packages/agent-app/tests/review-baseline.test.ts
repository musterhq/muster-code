import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {captureBaseline, ReviewBaselineStore, snapshotTree} from '../src/runtime/review-baseline.ts';
import {parseBaseline, reviewChanges, reviewFileDiff, stageAll, stageHunk, undoFile, undoHunk} from '../src/runtime/review.ts';
import {computeHunks} from '../src/shared/review-hunks.ts';

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'muster-review-'));
  const run = (...args: string[]) => execFileSync('git', ['-C', root, ...args], {stdio: 'pipe'});
  run('init', '-q'); run('config', 'user.email', 't@example.com'); run('config', 'user.name', 'T'); run('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n');
  writeFileSync(join(root, 'tool.sh'), '#!/bin/sh\necho hi\n'); chmodSync(join(root, 'tool.sh'), 0o755);
  run('add', '-A'); run('commit', '-q', '-m', 'init');
  return root;
}
const gitOut = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], {encoding: 'utf8'});

test('a run baseline snapshots tracked and untracked files without touching the index', async () => {
  const root = repo();
  try {
    writeFileSync(join(root, 'a.txt'), 'one\ntwo (user)\nthree\nfour\nfive\nsix\nseven\neight\n');
    writeFileSync(join(root, 'notes.md'), 'draft\n');
    const statusBefore = gitOut(root, 'status', '--porcelain');
    const store = new ReviewBaselineStore(new DatabaseSync(':memory:'));
    const info = await captureBaseline(store, {runId: 'run-1', chatId: 'chat-1', folderId: 'f', cwd: root});
    assert.match(info.treeSha ?? '', /^[0-9a-f]{40}$/);
    assert.equal(gitOut(root, 'status', '--porcelain'), statusBefore, 'the real index is untouched');
    assert.equal(gitOut(root, 'stash', 'list'), '');
    assert.equal(store.list('chat-1').at(-1)?.runId, 'run-1');

    // The agent edits after the snapshot: only its edits show against the turn baseline.
    writeFileSync(join(root, 'a.txt'), 'one\ntwo (user)\nthree\nfour\nfive\nSIX\nseven\neight\n');
    writeFileSync(join(root, 'new.ts'), 'export const x = 1;\n');
    const turn = await reviewChanges(root, {runId: 'run-1'}, info.treeSha);
    assert.deepEqual(turn.files.map(file => `${file.status}:${file.path}`).sort(), ['added:new.ts', 'modified:a.txt']);
    const head = await reviewChanges(root, 'head');
    assert.deepEqual(head.files.map(file => `${file.status}:${file.path}`).sort(), ['modified:a.txt', 'untracked:new.ts', 'untracked:notes.md']);

    const diff = await reviewFileDiff(root, 'a.txt', {runId: 'run-1'}, info.treeSha);
    assert.equal(diff.before.split('\n')[1], 'two (user)', 'the baseline keeps the user’s pre-run edit');
    const hunks = computeHunks(diff.before, diff.after)!;
    assert.equal(hunks.length, 1);

    // Undo is refused when the file changed since the diff was read, and reports the current text.
    writeFileSync(join(root, 'a.txt'), 'zero\none\ntwo (user)\nthree\nfour\nfive\nSIX\nseven\neight\n');
    const stale = await undoHunk(root, {path: 'a.txt', baseline: {runId: 'run-1'}, hunkId: hunks[0].id, expectedAfterHash: diff.afterHash}, info.treeSha);
    assert.equal(stale.stale, true);
    assert.ok(stale.stale && stale.current.startsWith('zero\n') && stale.relocatable, 'a unique match can still be relocated');
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8').includes('SIX'), true, 'nothing was written');
    const relocated = await undoHunk(root, {path: 'a.txt', baseline: {runId: 'run-1'}, hunkId: hunks[0].id, expectedAfterHash: diff.afterHash, relocate: true}, info.treeSha);
    assert.equal(relocated.stale, false);
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'zero\none\ntwo (user)\nthree\nfour\nfive\nsix\nseven\neight\n');

    // Undo with a matching hash reverse-applies exactly; undoing an added file removes it.
    const added = await reviewFileDiff(root, 'new.ts', {runId: 'run-1'}, info.treeSha);
    const [addedHunk] = computeHunks(added.before, added.after)!;
    assert.equal((await undoHunk(root, {path: 'new.ts', baseline: {runId: 'run-1'}, hunkId: addedHunk.id, expectedAfterHash: added.afterHash}, info.treeSha)).stale, false);
    assert.equal(existsSync(join(root, 'new.ts')), false);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('binary files and mode changes are metadata, and whole-file undo restores them', async () => {
  const root = repo();
  try {
    writeFileSync(join(root, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    execFileSync('git', ['-C', root, 'add', 'img.png']); execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'img']);
    writeFileSync(join(root, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9]));
    chmodSync(join(root, 'tool.sh'), 0o644);
    const image = await reviewFileDiff(root, 'img.png', 'head');
    assert.equal(image.binary, true);
    assert.match(image.image?.before ?? '', /^data:image\/png;base64,/);
    assert.deepEqual(image.size, {before: 8, after: 7});
    const mode = await reviewFileDiff(root, 'tool.sh', 'head');
    assert.deepEqual(mode.mode, {old: '100755', new: '100644'});
    await assert.rejects(undoHunk(root, {path: 'img.png', baseline: 'head', hunkId: 'x', expectedAfterHash: image.afterHash}), /whole file/);
    assert.equal((await undoFile(root, {path: 'img.png', baseline: 'head', expectedAfterHash: image.afterHash})).stale, false);
    assert.deepEqual([...readFileSync(join(root, 'img.png'))], [0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    assert.equal((await undoFile(root, {path: 'tool.sh', baseline: 'head', expectedAfterHash: mode.afterHash})).stale, false);
    assert.equal(statSync(join(root, 'tool.sh')).mode & 0o777, 0o755);
    assert.equal((await undoFile(root, {path: 'tool.sh', baseline: 'head', expectedAfterHash: 'f'.repeat(40)})).stale, true, 'a wrong hash never writes');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('hunks stage and unstage through the index, and the staged baseline shows them', async () => {
  const root = repo();
  try {
    writeFileSync(join(root, 'a.txt'), 'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\nEIGHT\n');
    const unstaged = await reviewFileDiff(root, 'a.txt', 'unstaged');
    const hunks = computeHunks(unstaged.before, unstaged.after)!;
    assert.equal(hunks.length, 2);
    assert.equal((await stageHunk(root, {path: 'a.txt', hunkId: hunks[0].id, expectedBeforeHash: unstaged.beforeHash, expectedAfterHash: unstaged.afterHash})).stale, false);
    assert.equal(gitOut(root, 'show', ':a.txt'), 'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n', 'only the first hunk is staged');
    const staged = await reviewChanges(root, 'staged');
    assert.deepEqual(staged.files.map(file => [file.path, file.adds, file.dels]), [['a.txt', 1, 1]]);
    const stagedDiff = await reviewFileDiff(root, 'a.txt', 'staged');
    const [stagedHunk] = computeHunks(stagedDiff.before, stagedDiff.after)!;
    assert.equal((await stageHunk(root, {path: 'a.txt', hunkId: stagedHunk.id, expectedBeforeHash: stagedDiff.beforeHash, expectedAfterHash: stagedDiff.afterHash, unstage: true})).stale, false);
    assert.equal((await reviewChanges(root, 'staged')).files.length, 0);
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8').startsWith('ONE'), true, 'unstaging never touches the working tree');
    const stale = await stageHunk(root, {path: 'a.txt', hunkId: hunks[1].id, expectedBeforeHash: 'f'.repeat(40), expectedAfterHash: unstaged.afterHash});
    assert.equal(stale.stale, true);
    await stageAll(root);
    assert.equal((await reviewChanges(root, 'unstaged')).files.length, 0);
    assert.match(await snapshotTree(root), /^[0-9a-f]{40}$/);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('non-Git folders record that they have no baseline, and marks persist per run', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'muster-review-plain-'));
  try {
    const store = new ReviewBaselineStore(new DatabaseSync(':memory:'));
    const info = await captureBaseline(store, {runId: 'r', chatId: 'c', folderId: null, cwd: folder});
    assert.equal(info.treeSha, null);
    assert.match(info.reason ?? '', /not a Git repository/);
    store.mark('r', 'a.txt', ['h1', 'h2'], 'kept');
    store.mark('r', 'a.txt', ['h2'], 'undone');
    assert.deepEqual(store.marks('r').map(mark => `${mark.hunkId}:${mark.state}`).sort(), ['h1:kept', 'h2:undone']);
  } finally { rmSync(folder, {recursive: true, force: true}); }
});

test('a folder inside a larger repository reviews and undoes with folder-relative paths', async () => {
  const root = repo();
  try {
    execFileSync('mkdir', ['-p', join(root, 'pkg')]);
    writeFileSync(join(root, 'pkg', 'b.txt'), 'b1\nb2\n');
    execFileSync('git', ['-C', root, 'add', '-A']); execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'pkg']);
    const folder = join(root, 'pkg');
    writeFileSync(join(folder, 'b.txt'), 'b1\nB2\n');
    writeFileSync(join(root, 'a.txt'), 'outside\n');
    const changes = await reviewChanges(folder, 'head');
    assert.deepEqual(changes.files.map(file => file.path), ['b.txt'], 'changes outside the folder are excluded');
    const diff = await reviewFileDiff(folder, 'b.txt', 'unstaged');
    const [hunk] = computeHunks(diff.before, diff.after)!;
    assert.equal((await stageHunk(folder, {path: 'b.txt', hunkId: hunk.id, expectedBeforeHash: diff.beforeHash, expectedAfterHash: diff.afterHash})).stale, false);
    assert.equal(gitOut(root, 'show', ':pkg/b.txt'), 'b1\nB2\n');
    assert.equal((await undoFile(folder, {path: 'b.txt', baseline: 'head', expectedAfterHash: diff.afterHash})).stale, false);
    assert.equal(readFileSync(join(folder, 'b.txt'), 'utf8'), 'b1\nb2\n');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('DIF-05: a branch or commit baseline compares the working tree against that ref', async () => {
  const root = repo();
  try {
    const run = (...args: string[]) => execFileSync('git', ['-C', root, ...args], {stdio: 'pipe'});
    const base = gitOut(root, 'rev-parse', 'HEAD').trim();
    run('branch', '-M', 'main'); run('checkout', '-q', '-b', 'feature');
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\nFOUR\nfive\nsix\nseven\neight\n');
    writeFileSync(join(root, 'lib.ts'), 'export {};\n');
    run('add', '-A'); run('commit', '-q', '-m', 'feature work');
    writeFileSync(join(root, 'wip.md'), 'wip\n');
    // HEAD sees only the uncommitted file; "vs main" sees the whole branch plus the working tree.
    assert.deepEqual((await reviewChanges(root, 'head')).files.map(file => file.path), ['wip.md']);
    const vsMain = await reviewChanges(root, {ref: 'main'});
    assert.equal(vsMain.label, 'main');
    assert.deepEqual(vsMain.files.map(file => file.path).sort(), ['a.txt', 'lib.ts', 'wip.md']);
    const vsCommit = await reviewChanges(root, {ref: base.slice(0, 10)});
    assert.deepEqual(vsCommit.files.map(file => file.path).sort(), ['a.txt', 'lib.ts', 'wip.md']);
    const diff = await reviewFileDiff(root, 'a.txt', {ref: 'main'});
    assert.equal(diff.before.split('\n')[3], 'four');
    assert.equal(diff.after.split('\n')[3], 'FOUR');
    await assert.rejects(reviewChanges(root, {ref: 'no-such-branch'}), /no branch, tag or commit named no-such-branch/);
    assert.throws(() => parseBaseline({ref: '--output=/tmp/x'}), /branch, tag or commit/);
    assert.deepEqual(parseBaseline({ref: ' main '}), {ref: 'main'});
  } finally { rmSync(root, {recursive: true, force: true}); }
});
