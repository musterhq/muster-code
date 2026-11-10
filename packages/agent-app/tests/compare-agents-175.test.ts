/** #175: send one prompt to several agents, each in its own worktree, compare the runs and merge the one picked. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter, ProviderInput} from '../src/runtime/provider.ts';

interface Behaviour {files: Record<string, string>; reply: string; test?: {command: string; exitCode: number}; tokens?: [number, number]; hold?: boolean}
const BEHAVIOURS: Record<string, Behaviour> = {
  fast: {files: {'answer.txt': 'fast\n'}, reply: 'Fast reply', test: {command: 'npm test', exitCode: 0}, tokens: [100, 20]},
  deep: {files: {'answer.txt': 'deep\n', 'notes.md': '# notes\n'}, reply: 'Deep reply', test: {command: 'pnpm test', exitCode: 1}, tokens: [200, 50]},
  wise: {files: {'a.txt': 'a\nwise\n'}, reply: 'Wise reply'},
  slow: {files: {'slow.txt': 'slow\n'}, reply: 'Slow reply', hold: true},
};
const models = (ids: string[]) => ids.map(id => ({id, name: id[0]!.toUpperCase() + id.slice(1)}));

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {cwd, encoding: 'utf8', env: {...process.env, GIT_TERMINAL_PROMPT: '0'}});
}

async function fixture(t: TestContext, options: {git?: boolean; dataDir?: string} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muster-175-')));
  const repo = join(root, 'repo'); await mkdir(repo);
  if (options.git !== false) {
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com'); git(repo, 'config', 'user.name', 'Muster Test'); git(repo, 'config', 'commit.gpgsign', 'false');
    await writeFile(join(repo, 'a.txt'), 'a\n'); await writeFile(join(repo, 'answer.txt'), 'start\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'first');
  } else await writeFile(join(repo, 'a.txt'), 'a\n');
  const runs: {chatId: string; cwd: string; prompt: string; model: string}[] = [];
  const held = new Map<string, () => void>();
  const provider: ProviderAdapter = {
    info: () => [
      {id: 'alpha', name: 'Alpha', available: true, identityMasked: 'Hidden', models: models(['fast', 'deep'])},
      {id: 'beta', name: 'Beta', available: true, identityMasked: 'Hidden', models: models(['wise', 'slow'])},
    ],
    async run(input: ProviderInput) {
      const behaviour = BEHAVIOURS[input.chat.model] ?? {files: {}, reply: 'ok'};
      runs.push({chatId: input.chat.id, cwd: input.cwd, prompt: input.prompt, model: input.chat.model});
      if (behaviour.hold) await new Promise<void>(resolve => held.set(input.chat.id, resolve));
      for (const [file, body] of Object.entries(behaviour.files)) await writeFile(join(input.cwd, file), body);
      const threadId = `thread-${input.chat.id}`;
      input.onThreadReady?.(threadId);
      if (behaviour.test) {
        const item = {id: `cmd-${input.chat.id}`, type: 'commandExecution', command: behaviour.test.command};
        input.onEvent('item/started', {threadId, item});
        input.onEvent('item/completed', {threadId, item: {...item, exitCode: behaviour.test.exitCode, status: behaviour.test.exitCode ? 'failed' : 'completed', aggregatedOutput: behaviour.test.exitCode ? '1 failing' : '3 passing'}});
      }
      if (behaviour.tokens) {
        const usage = {inputTokens: behaviour.tokens[0], outputTokens: behaviour.tokens[1]};
        input.onEvent('thread/tokenUsage/updated', {threadId, tokenUsage: {total: usage, last: usage}});
      }
      return {status: 'completed', finalMessage: behaviour.reply, threadId};
    },
    async stop(chatId) { held.get(chatId)?.(); return true; },
    dispose() {},
  };
  const dataDir = options.dataDir ?? join(root, 'state');
  let service = createAgentService({dataDir, provider, onEvent() {}});
  t.after(async () => { await service.dispose(); await rm(root, {recursive: true, force: true}); });
  const snapshot = () => service.invoke('app.snapshot', undefined);
  const chat = async (id: string) => (await snapshot()).chats.find(entry => entry.id === id);
  const settle = async (ids: string[]) => {
    for (let i = 0; i < 400; i++) {
      const chats = (await snapshot()).chats;
      if (ids.every(id => { const found = chats.find(entry => entry.id === id); return found && found.status !== 'running' && found.status !== 'stopping'; })) return;
      await delay(10);
    }
    throw new Error('The runs did not settle');
  };
  const restart = async () => { await service.dispose(); service = createAgentService({dataDir, provider, onEvent() {}}); };
  const folder = await service.invoke('folder.add', {path: repo});
  const source = await service.invoke('chat.create', {folderId: folder.id});
  return {root, repo, dataDir, runs, held, folder, source, chat, settle, snapshot, restart, get service() { return service; }};
}

const start = (f: Awaited<ReturnType<typeof fixture>>, targets: {providerId: string; model: string}[], extra: Record<string, unknown> = {}) =>
  f.service.invoke('compare.start', {chatId: f.source.id, text: 'Write the answer', requestId: randomUUID(), targets, ...extra});
const worktreeBranches = (repo: string) => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('branch ')).map(line => line.slice('branch refs/heads/'.length));
const hasBranch = (repo: string, name: string) => { try { git(repo, 'show-ref', '--verify', '--quiet', `refs/heads/${name}`); return true; } catch { return false; } };

// Spec: MUS-SPEC-08-175A (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-175a)
test('send to several makes one chat per model in its own worktree off the current branch, all sent the same prompt and files', async t => {
  const f = await fixture(t);
  const baseSha = git(f.repo, 'rev-parse', 'HEAD').trim();
  const file = await f.service.invoke('attachments.stage', {chatId: f.source.id, name: 'spec.txt', mime: 'text/plain', dataBase64: Buffer.from('the spec\n').toString('base64')});
  const targets = [{providerId: 'alpha', model: 'fast'}, {providerId: 'alpha', model: 'deep'}, {providerId: 'beta', model: 'wise'}];
  const comparison = await start(f, targets, {attachmentIds: [file.id]});
  assert.equal(comparison.runs.length, 3);
  assert.equal(comparison.baseBranch, 'main');
  assert.equal(comparison.baseSha, baseSha);
  await f.settle(comparison.runs.map(run => run.chatId));
  const branches = new Set<string>(), paths = new Set<string>();
  for (const [index, run] of comparison.runs.entries()) {
    const chat = await f.chat(run.chatId);
    assert.ok(chat, 'each run has its own chat');
    assert.notEqual(run.chatId, f.source.id);
    assert.equal(chat!.providerId, targets[index]!.providerId);
    assert.equal(chat!.model, targets[index]!.model);
    const folder = (await f.snapshot()).folders.find(entry => entry.id === chat!.folderId);
    assert.ok(folder && folder.path === run.worktreePath, 'the chat works in its worktree');
    assert.equal(git(run.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), run.branch);
    assert.equal(git(f.repo, 'merge-base', run.branch, 'main').trim(), baseSha, 'the branch starts at the current commit');
    branches.add(run.branch); paths.add(run.worktreePath);
    const sent = f.runs.find(entry => entry.chatId === run.chatId);
    assert.ok(sent, 'each run was sent');
    assert.equal(sent!.cwd, run.worktreePath);
    assert.match(sent!.prompt, /Write the answer/);
    assert.match(sent!.prompt, /spec\.txt/, 'the staged file goes to every run');
  }
  assert.equal(branches.size, 3); assert.equal(paths.size, 3);
  assert.deepEqual(worktreeBranches(f.repo).sort(), ['main', ...branches].sort());
  assert.equal(git(f.repo, 'status', '--porcelain').trim(), '', 'the original checkout is untouched');
  assert.equal(await readFile(join(f.repo, 'answer.txt'), 'utf8'), 'start\n');
  const listed = await f.service.invoke('compare.list', undefined);
  assert.deepEqual(listed.map(entry => entry.id), [comparison.id]);

  const before = (await f.snapshot()).chats.length;
  await assert.rejects(start(f, [{providerId: 'alpha', model: 'fast'}]), /two to four/i);
  await assert.rejects(start(f, [...targets, {providerId: 'beta', model: 'slow'}, {providerId: 'alpha', model: 'fast'}]), /two to four/i);
  await assert.rejects(start(f, [{providerId: 'alpha', model: 'fast'}, {providerId: 'alpha', model: 'fast'}]), /twice/i);
  assert.equal((await f.snapshot()).chats.length, before, 'a refused send makes no chat');
});

// Spec: MUS-SPEC-08-175B (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-175b)
test('a folder that is not a Git repository is refused and nothing is created', async t => {
  const f = await fixture(t, {git: false});
  const before = (await f.snapshot()).chats.length;
  await assert.rejects(start(f, [{providerId: 'alpha', model: 'fast'}, {providerId: 'alpha', model: 'deep'}]), /not a Git repository.*own copy|own copy.*Git repository/is);
  assert.equal((await f.snapshot()).chats.length, before);
  assert.equal(f.runs.length, 0);
  assert.equal(existsSync(join(f.dataDir, 'worktrees')), false);
  assert.deepEqual(await f.service.invoke('compare.list', undefined), []);
});

// Spec: MUS-SPEC-08-175C (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-175c)
test('the comparison lists each run with its status, time, tokens, reply, changed files and test result', async t => {
  const f = await fixture(t);
  const comparison = await start(f, [{providerId: 'alpha', model: 'fast'}, {providerId: 'alpha', model: 'deep'}]);
  await f.settle(comparison.runs.map(run => run.chatId));
  const detail = await f.service.invoke('compare.get', {id: comparison.id});
  assert.equal(detail.comparison.state, 'ready', 'every run has finished');
  const [fast, deep] = detail.runs;
  assert.equal(fast!.model, 'fast'); assert.equal(deep!.model, 'deep');
  for (const run of detail.runs) {
    assert.equal(run.status, 'completed');
    assert.equal(typeof run.durationMs, 'number');
    assert.ok(run.durationMs! >= 0);
  }
  assert.equal(fast!.tokens, 120); assert.equal(deep!.tokens, 250);
  assert.equal(fast!.reply, 'Fast reply'); assert.equal(deep!.reply, 'Deep reply');
  assert.deepEqual(fast!.files.map(file => [file.path, file.adds, file.dels]), [['answer.txt', 1, 1]]);
  assert.deepEqual(deep!.files.map(file => [file.path, file.adds, file.dels]).sort(), [['answer.txt', 1, 1], ['notes.md', 1, 0]]);
  assert.deepEqual([fast!.adds, fast!.dels, deep!.adds, deep!.dels], [1, 1, 2, 1]);
  assert.deepEqual(fast!.tests.map(run => [run.command, run.status, run.exitCode]), [['npm test', 'passed', 0]]);
  assert.deepEqual(deep!.tests.map(run => [run.command, run.status, run.exitCode]), [['pnpm test', 'failed', 1]]);
  for (const [run, text] of [[fast!, 'fast\n'], [deep!, 'deep\n']] as const) {
    const diff = await f.service.invoke('compare.fileDiff', {id: comparison.id, chatId: run.chatId, path: 'answer.txt'});
    assert.equal(diff.before, 'start\n', 'every run is compared with the same start commit');
    assert.equal(diff.after, text);
  }
});

// Spec: MUS-SPEC-08-175D (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-175d)
test('use this one merges the winner into the original branch, archives the others and removes their worktrees, keeping the branches the user keeps', async t => {
  const f = await fixture(t);
  const comparison = await start(f, [{providerId: 'alpha', model: 'fast'}, {providerId: 'alpha', model: 'deep'}, {providerId: 'beta', model: 'wise'}]);
  const [fast, deep, wise] = comparison.runs;
  await f.settle(comparison.runs.map(run => run.chatId));
  const result = await f.service.invoke('compare.pick', {id: comparison.id, chatId: fast!.chatId, others: {[deep!.chatId]: 'keep', [wise!.chatId]: 'discard'}});
  assert.equal(result.status, 'merged');
  assert.equal(result.comparison.state, 'merged');
  assert.equal(result.comparison.winnerChatId, fast!.chatId);
  assert.equal(git(f.repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
  assert.equal(await readFile(join(f.repo, 'answer.txt'), 'utf8'), 'fast\n', 'the winner\'s uncommitted work is merged');
  assert.equal(git(f.repo, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ').length, 3, 'a merge commit');
  assert.equal(git(f.repo, 'status', '--porcelain').trim(), '');
  const winner = await f.chat(fast!.chatId);
  assert.equal(winner!.folderId, f.folder.id, 'the winner moves to the original folder');
  assert.equal(winner!.archived, false);
  assert.equal((await f.chat(deep!.chatId))!.archived, true);
  assert.equal((await f.chat(wise!.chatId))!.archived, true);
  assert.deepEqual(worktreeBranches(f.repo), ['main'], 'every worktree is removed');
  for (const run of comparison.runs) assert.equal(existsSync(run.worktreePath), false);
  assert.equal(hasBranch(f.repo, deep!.branch), true, 'the kept branch stays');
  assert.equal(git(f.repo, 'show', `${deep!.branch}:notes.md`), '# notes\n', 'with the run\'s work committed on it');
  assert.equal(hasBranch(f.repo, wise!.branch), false, 'the discarded branch is gone');
  const folders = (await f.snapshot()).folders.map(folder => folder.path);
  for (const run of comparison.runs) assert.equal(folders.includes(run.worktreePath), false, 'removed worktrees leave the folder list');
  const listed = (await f.service.invoke('compare.list', undefined)).find(entry => entry.id === comparison.id);
  assert.equal(listed?.state, 'merged');
});

// Spec: MUS-SPEC-08-175E (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-175e)
test('unmerged work is never removed without a keep or discard choice, and nothing is merged while a run is still working', async t => {
  const f = await fixture(t);
  const head = git(f.repo, 'rev-parse', 'HEAD').trim();
  const comparison = await start(f, [{providerId: 'alpha', model: 'fast'}, {providerId: 'beta', model: 'slow'}]);
  const [fast, slow] = comparison.runs;
  await f.settle([fast!.chatId]);
  for (let i = 0; i < 200 && !f.held.has(slow!.chatId); i++) await delay(10);
  await assert.rejects(f.service.invoke('compare.pick', {id: comparison.id, chatId: fast!.chatId, others: {[slow!.chatId]: 'discard'}}), /still working/i);
  f.held.get(slow!.chatId)!();
  await f.settle([slow!.chatId]);
  await assert.rejects(f.service.invoke('compare.pick', {id: comparison.id, chatId: fast!.chatId, others: {}}), /keep or discard/i);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD').trim(), head, 'nothing is merged');
  assert.equal(worktreeBranches(f.repo).length, 3, 'every worktree is still there');
  for (const run of comparison.runs) { assert.equal(existsSync(join(run.worktreePath, run === fast ? 'answer.txt' : 'slow.txt')), true); assert.equal(hasBranch(f.repo, run.branch), true); assert.equal((await f.chat(run.chatId))!.archived, false); }
  assert.equal((await f.service.invoke('compare.get', {id: comparison.id})).comparison.state, 'ready');
});

// Spec: MUS-SPEC-08-175F (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-175f)
test('a merge conflict is left for the conflict view and the pick finishes once it is resolved', async t => {
  const f = await fixture(t);
  const comparison = await start(f, [{providerId: 'alpha', model: 'fast'}, {providerId: 'alpha', model: 'deep'}]);
  const [fast, deep] = comparison.runs;
  await f.settle(comparison.runs.map(run => run.chatId));
  await writeFile(join(f.repo, 'answer.txt'), 'changed on main\n'); git(f.repo, 'commit', '-qam', 'main moved');
  const first = await f.service.invoke('compare.pick', {id: comparison.id, chatId: fast!.chatId, others: {[deep!.chatId]: 'keep'}});
  assert.equal(first.status, 'conflicts');
  assert.deepEqual(first.status === 'conflicts' ? first.files : [], ['answer.txt']);
  assert.equal(first.comparison.state, 'merging');
  const conflicts = await f.service.invoke('git.conflicts', {folderId: f.folder.id});
  assert.equal(conflicts.operation, 'merge');
  assert.equal(worktreeBranches(f.repo).length, 3, 'worktrees stay while the merge is open');
  assert.equal((await f.chat(deep!.chatId))!.archived, false);
  await writeFile(join(f.repo, 'answer.txt'), 'fast and main\n');
  await f.service.invoke('git.conflictMarkResolved', {folderId: f.folder.id, paths: ['answer.txt']});
  await f.service.invoke('git.conflictContinue', {folderId: f.folder.id, action: 'continue'});
  const second = await f.service.invoke('compare.pick', {id: comparison.id, chatId: fast!.chatId, others: {[deep!.chatId]: 'keep'}});
  assert.equal(second.status, 'merged');
  assert.equal(await readFile(join(f.repo, 'answer.txt'), 'utf8'), 'fast and main\n');
  assert.deepEqual(worktreeBranches(f.repo), ['main']);
  assert.equal((await f.chat(deep!.chatId))!.archived, true);
  assert.equal(hasBranch(f.repo, deep!.branch), true);
});

// Spec: MUS-SPEC-08-175G (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-175g)
test('a comparison and its runs survive a restart', async t => {
  const f = await fixture(t);
  const comparison = await start(f, [{providerId: 'alpha', model: 'fast'}, {providerId: 'alpha', model: 'deep'}]);
  await f.settle(comparison.runs.map(run => run.chatId));
  const before = await f.service.invoke('compare.get', {id: comparison.id});
  await f.restart();
  const listed = await f.service.invoke('compare.list', undefined);
  assert.equal(listed.length, 1);
  const again = listed[0]!;
  assert.equal(again.id, comparison.id);
  assert.equal(again.baseSha, comparison.baseSha);
  assert.equal(again.baseBranch, 'main');
  assert.equal(again.state, 'ready');
  assert.deepEqual(again.runs.map(run => [run.chatId, run.branch, run.worktreePath, run.model]), comparison.runs.map(run => [run.chatId, run.branch, run.worktreePath, run.model]));
  const after = await f.service.invoke('compare.get', {id: comparison.id});
  assert.deepEqual(after.runs.map(run => run.durationMs), before.runs.map(run => run.durationMs), 'times are kept');
  assert.deepEqual(after.runs.map(run => run.files.map(file => file.path).sort()), [['answer.txt'], ['answer.txt', 'notes.md']]);
});
