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
