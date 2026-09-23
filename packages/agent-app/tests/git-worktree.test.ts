import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {afterEach, test} from 'node:test';
import {commitGit, createWorktree, gitInfo, gitStatus, listBranches, listWorktrees, removeWorktree, switchBranch} from '../src/runtime/git-local.ts';
import {createGitDomain} from '../src/runtime/domains/git.ts';
import type {DomainContext} from '../src/runtime/domains/types.ts';
import type {Chat, Folder} from '../src/shared/protocol.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))); });

function run(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {cwd, env: {...process.env, GIT_TERMINAL_PROMPT: '0'}}, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(' ')}: ${String(stderr)}`)); else resolve(String(stdout));
    });
  });
}
async function temp(label: string) { const dir = await realpath(await mkdtemp(join(tmpdir(), `muster-wt-${label}-`))); roots.push(dir); return dir; }
async function repo(): Promise<string> {
  const dir = await temp('repo');
  await run(dir, ['init', '-q', '-b', 'main']);
  await run(dir, ['config', 'user.email', 'test@example.com']);
  await run(dir, ['config', 'user.name', 'Muster Test']);
  await run(dir, ['config', 'commit.gpgsign', 'false']);
  await writeFile(join(dir, 'a.txt'), 'a\n');
  await run(dir, ['add', '--', 'a.txt']);
  await run(dir, ['commit', '-q', '-m', 'first']);
  return dir;
}

test('worktree create, list, dirty refusal and remove', async () => {
  const main = await repo(), data = await temp('data');
  const created = await createWorktree(main, data, {branch: 'feature/one'});
  assert.equal(created.branch, 'feature/one');
  assert.ok(created.path.startsWith(join(data, 'worktrees')), created.path);
  assert.ok(created.path.endsWith('feature-one'), created.path);
  assert.equal((await gitStatus(created.path)).branch, 'feature/one');

  const info = await gitInfo(created.path);
  assert.equal(info.worktree?.mainPath, main);
  assert.equal(info.fetchedAt, null);
  assert.equal((await gitInfo(main)).worktree, null);

  let list = await listWorktrees(main, true);
  assert.deepEqual(list.map(entry => [entry.branch, entry.main, entry.current]), [['main', true, true], ['feature/one', false, false]]);
  assert.ok((list[1].diskBytes ?? 0) > 0);
  assert.equal(list[0].diskBytes, undefined, 'the primary checkout is never walked');

  await assert.rejects(createWorktree(main, data, {branch: 'feature/one'}), /already checked out/);
  await assert.rejects(createWorktree(main, data, {branch: '-x'}), /valid branch name/);
  await assert.rejects(createWorktree(main, data, {branch: 'bad..name'}), /not a valid branch name/);

  await writeFile(join(created.path, 'scratch.txt'), 'untracked\n');
  list = await listWorktrees(main);
  assert.equal(list[1].dirty, true);
  await assert.rejects(removeWorktree(main, created.path), /uncommitted or untracked/);
  await assert.rejects(removeWorktree(main, main), /main checkout/);
  await assert.rejects(removeWorktree(main, join(data, 'nope')), /not a worktree/);

  await rm(join(created.path, 'scratch.txt'));
  await removeWorktree(main, created.path);
  assert.equal((await listWorktrees(main)).length, 1);
  await assert.rejects(stat(created.path));
  assert.ok((await listBranches(main)).local.some(branch => branch.name === 'feature/one'), 'removal keeps the branch');
});

test('an existing branch gets its own worktree; a taken name gets a numbered directory', async () => {
  const main = await repo(), data = await temp('data');
  await run(main, ['branch', 'topic']);
  const first = await createWorktree(main, data, {branch: 'topic'});
  assert.equal((await gitStatus(first.path)).branch, 'topic');
  await removeWorktree(main, first.path);
  const again = await createWorktree(main, data, {branch: 'topic'});
  assert.equal(again.path, first.path, 'a freed directory is reused');
  await mkdir(join(dirname(first.path), 'busy'));
  const other = await createWorktree(main, data, {branch: 'busy', base: 'main'});
  assert.ok(other.path.endsWith('busy-2'), other.path);
});

test('branches, switching with local changes, and create', async () => {
  const dir = await repo();
  await run(dir, ['branch', 'dev']);
  let status = await gitStatus(dir);
  let result = await switchBranch(dir, {branch: 'dev', revision: status.revision});
  assert.equal(result.blocked, false);
  assert.equal((await gitStatus(dir)).branch, 'dev');

  await writeFile(join(dir, 'a.txt'), 'edited\n');
  status = await gitStatus(dir);
  result = await switchBranch(dir, {branch: 'main', revision: status.revision});
  assert.deepEqual(result, {blocked: true, files: ['a.txt'], total: 1});
  assert.equal((await gitStatus(dir)).branch, 'dev', 'held back until confirmed');
  result = await switchBranch(dir, {branch: 'main', revision: status.revision, carry: true});
  assert.equal(result.blocked, false);
  status = await gitStatus(dir);
  assert.equal(status.branch, 'main');
  assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'edited\n', 'changes came along');

  await assert.rejects(switchBranch(dir, {branch: 'dev', revision: 'stale'}), /repository changed/);
  await assert.rejects(switchBranch(dir, {branch: 'dev', create: true, revision: status.revision, carry: true}), /already exists/);
  await assert.rejects(switchBranch(dir, {branch: 'ghost', revision: status.revision, carry: true}), /no local branch/);
  result = await switchBranch(dir, {branch: 'feat/new', create: true, base: 'main', revision: status.revision, carry: true});
  assert.equal(result.blocked, false);
  const branches = await listBranches(dir);
  assert.equal(branches.current, 'feat/new');
  assert.deepEqual(branches.local.map(branch => branch.name).sort(), ['dev', 'feat/new', 'main']);
  assert.deepEqual(branches.recent.slice(0, 2), ['main', 'dev']);
});

test('commit supports amend and refuses to amend a pushed commit', async () => {
  const dir = await repo(), bare = await temp('bare');
  await run(bare, ['init', '-q', '--bare', '-b', 'main']);
  await writeFile(join(dir, 'b.txt'), 'b\n');
  await run(dir, ['add', 'b.txt']);
  let status = await gitStatus(dir);
  let result = await commitGit(dir, {revision: status.revision, message: 'add b'});
  assert.equal(result.pushed, false);
  result = await commitGit(dir, {revision: result.status.revision, message: 'add b (reworded)', amend: true});
  assert.equal((await run(dir, ['log', '-1', '--format=%s'])).trim(), 'add b (reworded)');
  assert.equal((await run(dir, ['rev-list', '--count', 'HEAD'])).trim(), '2');
  await assert.rejects(commitGit(dir, {revision: result.status.revision, message: 'x'}), /Stage changes/);

  await run(dir, ['remote', 'add', 'origin', bare]);
  await writeFile(join(dir, 'c.txt'), 'c\n');
  await run(dir, ['add', 'c.txt']);
  status = await gitStatus(dir);
  result = await commitGit(dir, {revision: status.revision, message: 'add c', push: true});
  assert.equal(result.pushed, true, result.pushError ?? '');
  assert.equal(result.status.upstream, 'origin/main');
  await assert.rejects(commitGit(dir, {revision: result.status.revision, message: 'rewrite', amend: true}), /already on origin\/main/);
});

test('domain refuses branch switches and worktree removal while a chat runs there', async () => {
  const main = await repo(), data = await temp('data');
  const folders: Folder[] = [{id: 'f1', path: main, name: 'repo'}];
  const chats: Partial<Chat>[] = [];
  const context = {
    dataDir: data, emit() {},
    store: {snapshot: () => ({folders, chats, projects: [], version: 1})},
    folderFor: (id: string) => { const found = folders.find(folder => folder.id === id); if (!found) throw new Error('Unknown folder.'); return found; },
    invoke: async (_command: string, input: {path: string}) => { const folder = {id: `f${folders.length + 1}`, path: input.path, name: 'wt'}; folders.push(folder); return folder; },
  } as unknown as DomainContext;
  const {handlers} = createGitDomain(context);
  const created = await handlers['git.worktree.create']({folderId: 'f1', branch: 'side'}) as {folder: Folder; path: string};
  assert.equal(created.folder.path, created.path);
  const list = await handlers['git.worktree.list']({folderId: 'f1'}) as Array<{folderId?: string}>;
  assert.equal(list[1].folderId, created.folder.id);

  chats.push({id: 'c', folderId: created.folder.id, status: 'running'});
  await assert.rejects(Promise.resolve(handlers['git.worktree.remove']({folderId: 'f1', path: created.path})), /chat is running in this worktree/);
  chats.push({id: 'd', folderId: 'f1', status: 'stopping'});
  const status = await gitStatus(main);
  await assert.rejects(Promise.resolve(handlers['git.switch']({folderId: 'f1', branch: 'side', revision: status.revision})), /Stop it before switching/);
  chats.length = 0;
  const remaining = await handlers['git.worktree.remove']({folderId: 'f1', path: created.path}) as unknown[];
  assert.equal(remaining.length, 1);
});

test('GIT-06: a carried change that conflicts with the target branch reports its files and shows up as conflict state', async () => {
  const dir = await repo();
  await run(dir, ['switch', '-q', '-c', 'dev']);
  await writeFile(join(dir, 'a.txt'), 'dev version\n');
  await run(dir, ['commit', '-q', '-am', 'dev edit']);
  await run(dir, ['switch', '-q', 'main']);
  await writeFile(join(dir, 'a.txt'), 'local edit\n');
  const status = await gitStatus(dir);
  const result = await switchBranch(dir, {branch: 'dev', revision: status.revision, carry: true});
  assert.equal(result.blocked, false);
  assert.ok(!result.blocked && result.conflicts);
  assert.deepEqual(!result.blocked && result.conflicts, ['a.txt']);
  assert.equal((await gitStatus(dir)).branch, 'dev');
  const {conflictState} = await import('../src/runtime/git-conflicts.ts');
  const state = await conflictState(dir);
  assert.equal(state.operation, null);
  assert.deepEqual(state.files.map(file => file.path), ['a.txt']);
  assert.equal(state.incomingLabel, 'your carried changes');
});
