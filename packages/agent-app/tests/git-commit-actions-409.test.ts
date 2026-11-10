// #409: commit actions from the history graph (checkout, create branch here, cherry-pick, revert) against real temp repositories.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, test} from 'node:test';
import {commitAction} from '../src/runtime/git-commit-actions.ts';
import {gitStatus} from '../src/runtime/git-local.ts';
import {conflictState} from '../src/runtime/git-conflicts.ts';
import {createGitDomain} from '../src/runtime/domains/git.ts';
import type {DomainContext} from '../src/runtime/domains/types.ts';
import type {Chat, Folder} from '../src/shared/protocol.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))); });

function run(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {cwd, env: {...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true'}}, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(' ')}: ${String(stderr)}`)); else resolve(String(stdout));
    });
  });
}
async function repo(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'muster-409-')));
  roots.push(dir);
  await run(dir, ['init', '-q', '-b', 'main']);
  await run(dir, ['config', 'user.email', 'test@example.com']);
  await run(dir, ['config', 'user.name', 'Muster Test']);
  await run(dir, ['config', 'commit.gpgsign', 'false']);
  await commit(dir, 'a.txt', 'one\n', 'first');
  return dir;
}
async function commit(dir: string, file: string, content: string, message: string): Promise<string> {
  await writeFile(join(dir, file), content);
  await run(dir, ['add', '-A']);
  await run(dir, ['commit', '-q', '-m', message]);
  return (await run(dir, ['rev-parse', 'HEAD'])).trim();
}
const head = async (dir: string) => (await run(dir, ['rev-parse', 'HEAD'])).trim();
const branchTip = async (dir: string, name: string) => (await run(dir, ['rev-parse', `refs/heads/${name}`])).trim();
const revision = async (dir: string) => (await gitStatus(dir)).revision;

// Spec: MUS-SPEC-08-409A (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-409a)
test('checking out a commit detaches HEAD at it and leaves the branch where it was', async () => {
  const dir = await repo();
  const middle = await commit(dir, 'a.txt', 'two\n', 'second');
  const tip = await commit(dir, 'a.txt', 'three\n', 'third');
  await assert.rejects(commitAction(dir, {action: 'checkout', sha: middle, revision: 'stale'}), /changed/i);
  assert.equal(await head(dir), tip, 'a stale revision does not move HEAD');
  const result = await commitAction(dir, {action: 'checkout', sha: middle, revision: await revision(dir)});
  assert.equal(result.status.detached, true);
  assert.equal(await head(dir), middle);
  assert.equal(await branchTip(dir, 'main'), tip, 'main stays on its tip');
  assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'two\n');
});

// Spec: MUS-SPEC-08-409B (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-409b)
test('create branch here makes the branch at that commit and switches only when asked', async () => {
  const dir = await repo();
  const first = await head(dir);
  const tip = await commit(dir, 'a.txt', 'two\n', 'second');
  const made = await commitAction(dir, {action: 'branch', sha: first, branch: 'fix', revision: await revision(dir)});
  assert.equal(made.branch, 'fix');
  assert.equal(await branchTip(dir, 'fix'), first);
  assert.equal(made.status.branch, 'main', 'HEAD stays on main');
  assert.equal(await head(dir), tip);
  const switched = await commitAction(dir, {action: 'branch', sha: first, branch: 'fix2', checkout: true, revision: await revision(dir)});
  assert.equal(switched.status.branch, 'fix2');
  assert.equal(await head(dir), first);
  await assert.rejects(commitAction(dir, {action: 'branch', sha: tip, branch: 'fix', revision: await revision(dir)}), /already exists/);
});

// Spec: MUS-SPEC-08-409C (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-409c)
test('cherry-pick copies a commit from another branch onto the current branch and refuses one that is already there', async () => {
  const dir = await repo();
  const first = await head(dir);
  await run(dir, ['switch', '-q', '-c', 'topic']);
  const picked = await commit(dir, 'b.txt', 'topic file\n', 'add b on topic');
  await run(dir, ['switch', '-q', 'main']);
  const before = await head(dir);
  const result = await commitAction(dir, {action: 'cherry-pick', sha: picked, revision: await revision(dir)});
  assert.equal(result.conflicts, undefined);
  assert.equal(result.status.branch, 'main');
  const after = await head(dir);
  assert.notEqual(after, before);
  assert.equal((await run(dir, ['rev-parse', 'HEAD^'])).trim(), before, 'one new commit on main');
  assert.equal((await run(dir, ['log', '-1', '--format=%s'])).trim(), 'add b on topic');
  assert.equal(await readFile(join(dir, 'b.txt'), 'utf8'), 'topic file\n');
  await assert.rejects(commitAction(dir, {action: 'cherry-pick', sha: first, revision: await revision(dir)}), /already on main/);
  assert.equal((await conflictState(dir)).operation, null, 'nothing is left mid-pick');
  assert.equal(await head(dir), after);
});

// Spec: MUS-SPEC-08-409D (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-409d)
test('revert adds a commit that undoes the chosen commit and refuses one that is not on the branch', async () => {
  const dir = await repo();
  const target = await commit(dir, 'b.txt', 'b\n', 'add b');
  await commit(dir, 'a.txt', 'one\ntwo\n', 'extend a');
  await run(dir, ['switch', '-q', '-c', 'topic']);
  const elsewhere = await commit(dir, 'c.txt', 'c\n', 'add c on topic');
  await run(dir, ['switch', '-q', 'main']);
  const before = await head(dir);
  const result = await commitAction(dir, {action: 'revert', sha: target, revision: await revision(dir)});
  assert.equal(result.conflicts, undefined);
  assert.equal((await run(dir, ['rev-parse', 'HEAD^'])).trim(), before);
  assert.equal((await run(dir, ['log', '-1', '--format=%s'])).trim(), 'Revert "add b"');
  await assert.rejects(readFile(join(dir, 'b.txt'), 'utf8'), /ENOENT/);
  assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'one\ntwo\n', 'later work is kept');
  assert.match(await run(dir, ['log', '--format=%H']), new RegExp(target), 'the original stays in history');
  await assert.rejects(commitAction(dir, {action: 'revert', sha: elsewhere, revision: await revision(dir)}), /not on main/);
});

// Spec: MUS-SPEC-08-409E (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-409e)
test('uncommitted changes block checkout, cherry-pick and revert, and nothing is touched', async () => {
  const dir = await repo();
  const first = await head(dir);
  await run(dir, ['switch', '-q', '-c', 'topic']);
  const picked = await commit(dir, 'b.txt', 'b\n', 'add b on topic');
  await run(dir, ['switch', '-q', 'main']);
  const tip = await commit(dir, 'c.txt', 'c\n', 'add c');
  await writeFile(join(dir, 'a.txt'), 'local edit\n');
  await writeFile(join(dir, 'scratch.txt'), 'untracked\n');
  for (const input of [{action: 'checkout' as const, sha: first}, {action: 'cherry-pick' as const, sha: picked}, {action: 'revert' as const, sha: tip}, {action: 'branch' as const, sha: first, branch: 'x', checkout: true}]) {
    await assert.rejects(commitAction(dir, {...input, revision: await revision(dir)}), (error: Error) => /a\.txt/.test(error.message) && /commit or stash/i.test(error.message), `${input.action} is refused naming a.txt`);
    assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'local edit\n');
    assert.equal(await head(dir), tip);
  }
  const made = await commitAction(dir, {action: 'branch', sha: first, branch: 'plain', revision: await revision(dir)});
  assert.equal(made.branch, 'plain', 'creating a branch without switching does not touch the tree');
  assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'local edit\n');
});

// Spec: MUS-SPEC-08-409F (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-409f)
test('a conflicting cherry-pick or revert stops in git’s normal conflict state and reports the files', async () => {
  const dir = await repo();
  await run(dir, ['switch', '-q', '-c', 'topic']);
  const theirs = await commit(dir, 'a.txt', 'topic line\n', 'topic edit');
  await run(dir, ['switch', '-q', 'main']);
  const old = await commit(dir, 'a.txt', 'main line\n', 'main edit');
  const picked = await commitAction(dir, {action: 'cherry-pick', sha: theirs, revision: await revision(dir)});
  assert.deepEqual(picked.conflicts, ['a.txt']);
  let state = await conflictState(dir);
  assert.equal(state.operation, 'cherry-pick');
  assert.deepEqual(state.files.map(file => file.path), ['a.txt']);
  await run(dir, ['cherry-pick', '--abort']);
  await commit(dir, 'a.txt', 'rewritten\n', 'rewrite a');
  const reverted = await commitAction(dir, {action: 'revert', sha: old, revision: await revision(dir)});
  assert.deepEqual(reverted.conflicts, ['a.txt']);
  state = await conflictState(dir);
  assert.equal(state.operation, 'revert');
  assert.deepEqual(state.files.map(file => file.path), ['a.txt']);
});

// Spec: MUS-SPEC-08-409G (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-409g)
test('a running chat in the folder blocks HEAD changes unless the person confirmed the warning', async () => {
  const dir = await repo();
  const first = await head(dir);
  await commit(dir, 'a.txt', 'two\n', 'second');
  const folders: Folder[] = [{id: 'f1', path: dir, name: 'repo'} as Folder];
  const chats: Partial<Chat>[] = [{id: 'c', title: 'Refactor parser', folderId: 'f1', status: 'running'}];
  const events: unknown[] = [];
  const context = {
    dataDir: dir, emit: (event: unknown) => events.push(event),
    store: {snapshot: () => ({folders, chats, projects: [], version: 1})},
    folderFor: (id: string) => { const found = folders.find(folder => folder.id === id); if (!found) throw new Error('Unknown folder.'); return found; },
    hooks: {},
  } as unknown as DomainContext;
  const {handlers} = createGitDomain(context);
  const action = handlers['git.commitAction'] as (input: Record<string, unknown>) => Promise<{status: {detached: boolean}}>;
  await assert.rejects(Promise.resolve().then(async () => action({folderId: 'f1', action: 'checkout', sha: first, revision: await revision(dir)})), /running/);
  assert.equal(events.length, 0);
  const made = await action({folderId: 'f1', action: 'branch', sha: first, branch: 'side', revision: await revision(dir)});
  assert.equal((made as unknown as {branch: string}).branch, 'side', 'branch creation without switching is not blocked');
  const result = await action({folderId: 'f1', action: 'checkout', sha: first, revision: await revision(dir), allowRunning: true});
  assert.equal(result.status.detached, true);
  assert.deepEqual(events, [{type: 'workspaceChanged', folderId: 'f1'}, {type: 'workspaceChanged', folderId: 'f1'}]);
});
