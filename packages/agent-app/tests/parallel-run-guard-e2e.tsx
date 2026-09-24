/**
 * CHAT-06 end to end: the real runtime and the real renderer store. A second run in a checkout where another
 * chat is working asks first; queue waits for the other run, cancel sends nothing, run anyway sends now, and
 * "Run in a worktree" moves an empty chat onto its own branch and checkout before sending.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service';
import type {ProviderAdapter, ProviderResult} from '../src/runtime/provider';
import type {AgentEvent} from '../src/shared/protocol';

const root = await realpath(await mkdtemp(join(tmpdir(), 'muster-parallel-e2e-')));
const repo = join(root, 'repo'); await mkdir(repo);
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {cwd: repo});
git('init', '-q'); await writeFile(join(repo, 'a.ts'), 'a\n'); git('add', '.'); git('commit', '-qm', 'init');
const listeners = new Set<(event: AgentEvent) => void>();
const gates = new Map<string, (result: ProviderResult) => void>();
const dispatched: string[] = [];
const provider: ProviderAdapter = {
  info: () => [{id: 'hybrow', name: 'Hybrow', available: true, identityMasked: 'Hidden', bindingId: 'gateway', models: [{id: 'claude/claude-fable-5', name: 'Fable'}]}],
  dispose() {},
  async stop(id) { gates.get(id)?.({status: 'failed', finalMessage: '', recovery: {kind: 'cancelled', retryable: false, reason: 'Stopped.'}}); return true; },
  run(input) { dispatched.push(input.chat.id); return new Promise(resolve => gates.set(input.chat.id, resolve)); },
};
const service = createAgentService({dataDir: join(root, 'state'), provider, onEvent: event => { for (const listener of listeners) listener(event); }});
const saved = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value), removeItem: (key: string) => void saved.delete(key)},
  window: {setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, innerWidth: 1400, muster: {
    subscribe(listener: (event: AgentEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    invoke: (command: string, input: unknown) => (service.invoke as (c: string, i: unknown) => Promise<unknown>)(command, input),
  }},
});
const until = async (label: string, check: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error(`timed out: ${label}`); await sleep(10); } };
let failed = false;
try {
  const folder = await service.invoke('folder.add', {path: repo});
  const store = await import('../src/renderer/store');
  const guard = await import('../src/renderer/components/ParallelRunGuard');
  await store.boot();
  const status = (id: string) => store.getState().snapshot?.chats.find(chat => chat.id === id)?.status;
  const settle = async (id: string) => { await until(`run ${id} dispatched`, () => gates.has(id)); gates.get(id)!({status: 'completed', finalMessage: 'done'}); gates.delete(id); };
  const a = await service.invoke('chat.create', {folderId: folder.id});
  const b = await service.invoke('chat.create', {folderId: folder.id});
  const other = await service.invoke('chat.create', {});

  // No sibling running → no question, straight send.
  assert.equal(await guard.sendWithCheckoutGuard(a.id, {hasAttachments: false}, target => store.sendMessage(target, 'first run')), true);
  await until('A is running', () => status(a.id) === 'running');
  assert.equal(guard.pendingParallelRun(), null, 'the first run in a checkout never asks');
  // A chat without a folder never collides.
  assert.equal(await guard.sendWithCheckoutGuard(other.id, {hasAttachments: false}, target => store.sendMessage(target, 'no folder')), true);
  await settle(other.id);

  // Cancel: nothing starts.
  let result = guard.sendWithCheckoutGuard(b.id, {hasAttachments: false}, target => store.sendMessage(target, 'cancelled'));
  await until('B is asked', () => guard.pendingParallelRun()?.chatId === b.id);
  assert.deepEqual(guard.pendingParallelRun()!.siblingIds, [a.id], 'the question names the chat working here');
  guard.answerParallelRun('cancel');
  assert.equal(await result, false);
  assert.equal(dispatched.includes(b.id), false, 'cancel sends nothing');

  // Queue: waits for A, then starts by itself.
  result = guard.sendWithCheckoutGuard(b.id, {hasAttachments: false}, target => store.sendMessage(target, 'queued run'));
  await until('B is asked again', () => guard.pendingParallelRun()?.chatId === b.id);
  guard.answerParallelRun('queue');
  await until('B is queued', () => guard.isCheckoutQueued(b.id));
  await sleep(50);
  assert.equal(dispatched.includes(b.id), false, 'a queued run does not start while A works');
  await settle(a.id);
  assert.equal(await result, true, 'A finishing releases the queue');
  assert.equal(guard.isCheckoutQueued(b.id), false);
  await until('B dispatched', () => dispatched.includes(b.id));

  // Run anyway: B is now the running sibling; A sends immediately.
  await until('B running', () => status(b.id) === 'running');
  result = guard.sendWithCheckoutGuard(a.id, {hasAttachments: false}, target => store.sendMessage(target, 'run anyway'));
  await until('A is asked', () => guard.pendingParallelRun()?.chatId === a.id);
  guard.answerParallelRun('run');
  assert.equal(await result, true);
  await until('A dispatched again', () => dispatched.filter(id => id === a.id).length === 2);

  // Run in a worktree: an empty chat moves to a new branch/checkout, then sends there.
  const c = await service.invoke('chat.create', {folderId: folder.id});
  await until('C in snapshot', () => !!status(c.id));
  result = guard.sendWithCheckoutGuard(c.id, {hasAttachments: false}, target => store.sendMessage(target, 'isolated run'));
  await until('C is asked', () => guard.pendingParallelRun()?.chatId === c.id);
  guard.answerParallelRun('worktree');
  assert.equal(await result, true, (store.getState().notices ?? []).map((n: {message: string}) => n.message).join(' | '));
  const moved = (await service.invoke('app.snapshot', undefined)).chats.find(chat => chat.id === c.id)!;
  assert.notEqual(moved.folderId, folder.id, 'C left the shared checkout');
  const worktreeFolder = (await service.invoke('app.snapshot', undefined)).folders.find(f => f.id === moved.folderId)!;
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {cwd: worktreeFolder.path}).toString().trim();
  assert.match(branch, /^muster\/chat-\d{4}-\d{4}$|^muster\/[a-z0-9-]+-\d{4}-\d{4}$/, `worktree branch ${branch}`);
  await until('C dispatched in its worktree', () => dispatched.includes(c.id));
  for (const id of [...gates.keys()]) await settle(id);
  console.log('PASS: same-checkout runs ask first; cancel, queue, run anyway and worktree each behave');
} catch (error) {
  failed = true; console.error(error instanceof Error ? error.stack : error);
} finally {
  for (const resolve of gates.values()) resolve({status: 'completed', finalMessage: ''});
  await service.dispose(); await rm(root, {recursive: true, force: true});
}
process.exit(failed ? 1 : 0);
