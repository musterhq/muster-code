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
