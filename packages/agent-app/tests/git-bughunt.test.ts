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

test('branch list names a branch correctly when a tag has the same name', async () => {
  const dir = repo();
  g(dir, 'tag', 'release'); g(dir, 'branch', 'release'); g(dir, 'switch', '-q', 'release');
  const branches = await listBranches(dir);
  assert.equal(branches.current, 'release');
  assert.ok(branches.local.some(b => b.name === 'release'), JSON.stringify(branches.local));
  assert.equal((await gitInfo(dir)).branch, 'release');
});

test('blame accepts a file whose name starts with a dash', async () => {
  const dir = repo();
  writeFileSync(join(dir, '-dash.txt'), 'x\n'); g(dir, 'add', '--', '-dash.txt'); g(dir, 'commit', '-q', '-m', 'dash');
  const blame = await blameFile(dir, '-dash.txt');
  assert.equal(blame.lines.length, 1);
});

test('markResolved accepts a dash-named conflicted file', async () => {
  const dir = repo();
  writeFileSync(join(dir, '-c.txt'), 'base\n'); g(dir, 'add', '--', '-c.txt'); g(dir, 'commit', '-q', '-m', 'c');
  g(dir, 'switch', '-q', '-c', 'o'); writeFileSync(join(dir, '-c.txt'), 'o\n'); g(dir, 'commit', '-qam', 'o');
  g(dir, 'switch', '-q', 'main'); writeFileSync(join(dir, '-c.txt'), 'm\n'); g(dir, 'commit', '-qam', 'm');
  try { g(dir, 'merge', 'o'); } catch { /* conflict */ }
  writeFileSync(join(dir, '-c.txt'), 'done\n');
  const state = await markResolved(dir, ['-c.txt']);
  assert.equal(state.files.length, 0);
});

test('GitHub remotes are recognised whatever the case of the host name', () => {
  assert.equal(githubWebUrl('https://GitHub.com/o/r.git'), 'https://github.com/o/r');
  assert.equal(githubWebUrl('git@GITHUB.COM:o/r.git'), 'https://github.com/o/r');
});

test('ref diff shows a submodule pointer as a Subproject commit line', async () => {
  const dir = repo(), sub = repo();
  g(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sm');
  g(dir, 'commit', '-q', '-m', 'add submodule');
  const pinned = g(dir, 'rev-parse', 'HEAD:sm').trim();
  const diff = await refDiff(dir, {base: 'HEAD~1', head: 'HEAD', path: 'sm'});
  assert.equal(diff.before, '');
  assert.equal(diff.after, `Subproject commit ${pinned}\n`);
});
