import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, test} from 'node:test';
import {githubWebUrl, redactGitText, gitInfo, gitStatus, listBranches, listWorktrees, removeWorktree, createWorktree, mutateGit} from '../src/runtime/git-local.ts';
import {blameFile, refDiff} from '../src/runtime/git-history.ts';
import {markResolved} from '../src/runtime/git-conflicts.ts';
import {reviewChanges, reviewFileDiff, undoFile} from '../src/runtime/review.ts';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, {recursive: true, force: true}); });
const g = (cwd: string, ...args: string[]) => execFileSync('git', args, {cwd, encoding: 'utf8', env: {...process.env, GIT_EDITOR: 'true'}});
function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bh-git-'))); roots.push(dir);
  g(dir, 'init', '-q', '-b', 'main'); g(dir, 'config', 'user.email', 't@e.x'); g(dir, 'config', 'user.name', 'T'); g(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'one\n'); g(dir, 'add', '.'); g(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

test('review changes flags a renamed binary file as binary', async () => {
  const dir = repo();
  writeFileSync(join(dir, 'b.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 0, 9, 9, 9])); g(dir, 'add', '.'); g(dir, 'commit', '-q', '-m', 'bin');
  g(dir, 'mv', 'b.bin', 'c.bin');
  const changes = await reviewChanges(dir, 'head');
  const file = changes.files.find(f => f.path === 'c.bin');
  assert.ok(file, JSON.stringify(changes.files));
  assert.equal(file.binary, true);
});

test('undoing a deleted symlink restores a symlink', async () => {
  const dir = repo();
  symlinkSync('a.txt', join(dir, 'link')); g(dir, 'add', '.'); g(dir, 'commit', '-q', '-m', 'link');
  rmSync(join(dir, 'link'));
  const changes = await reviewChanges(dir, 'head');
  const file = changes.files.find(f => f.path === 'link')!;
  await undoFile(dir, {path: 'link', baseline: 'head', expectedAfterHash: file.afterHash});
  assert.equal(g(dir, 'status', '--porcelain').trim(), '');
});

test('a binary file whose extension is constructor has no image preview', async () => {
  const dir = repo();
  writeFileSync(join(dir, 'blob.constructor'), Buffer.from([0, 1, 2, 3, 0, 255]));
  const diff = await reviewFileDiff(dir, 'blob.constructor', 'head');
  assert.equal(diff.binary, true);
  assert.equal(diff.image, undefined);
});

test('credential redaction masks a password that contains an @', () => {
  const masked = redactGitText('fatal: unable to access https://user:p@ssw0rd@github.com/o/r.git/');
  assert.ok(!masked.includes('ssw0rd'), masked);
  assert.ok(masked.includes('@github.com/o/r.git'), masked);
  assert.equal(redactGitText('see https://example.com/page?email=a@b.c'), 'see https://example.com/page?email=a@b.c');
});

test('undoing a staged symlink change keeps the index entry a symlink', async () => {
  const dir = repo();
  symlinkSync('a.txt', join(dir, 'link')); g(dir, 'add', '.'); g(dir, 'commit', '-q', '-m', 'link');
  rmSync(join(dir, 'link')); symlinkSync('missing.txt', join(dir, 'link')); g(dir, 'add', 'link');
  const changes = await reviewChanges(dir, 'staged');
  const file = changes.files.find(f => f.path === 'link')!;
  assert.ok(file, JSON.stringify(changes.files));
  await undoFile(dir, {path: 'link', baseline: 'staged', expectedAfterHash: file.afterHash});
  assert.match(g(dir, 'ls-files', '-s', 'link'), /^120000 /);
  assert.equal(g(dir, 'diff', '--cached', '--name-only').trim(), '');
});
