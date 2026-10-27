/** #347: confined writes survive a folder or name swapped by a racer; policyOnly travels beside the request parameters, never inside them. */
import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {mkdtemp, mkdir, readdir, readFile, rename, rm, symlink, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {executeTool, type ToolContext} from '../src/runtime/adapters/http-tools.ts';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';

const win = process.platform === 'win32';
async function sandbox(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'muster-wc347-')); t.after(() => rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}).catch(() => {}));
  const ws = join(root, 'ws'), outside = join(root, 'outside'); await mkdir(ws); await mkdir(outside); return {root, ws, outside};
}
const canLink = async (root: string) => { try { await symlink(join(root, 'x'), join(root, 'probe-link'), win ? 'junction' : undefined); await unlink(join(root, 'probe-link')); return true; } catch { return false; } };
const ctx = (cwd: string, extra: Partial<ToolContext> = {}): ToolContext => ({cwd, access: 'workspace', signal: new AbortController().signal, emit() {}, threadId: 't', turnId: 'u', authorize: async () => 'allow', ...extra});
const call = (name: string, args: object, id = '1') => ({id, name, arguments: JSON.stringify(args)});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

// Spec: MUS-SPEC-05-347A (docs/spec/clauses/05-access-modes-and-approvals.md#mus-spec-05-347a)
test('a folder swapped for a link while a write waits for approval creates nothing outside', async t => {
  const {root, ws, outside} = await sandbox(t); if (!await canLink(root)) return t.skip('no link privilege');
  await mkdir(join(ws, 'd'));
  const swapWhileAsking = async () => { await rename(join(ws, 'd'), join(ws, 'd.old')); await symlink(outside, join(ws, 'd'), win ? 'junction' : undefined); return 'allow' as const; };
  const result = await executeTool(call('write_file', {path: 'd/sub/x.txt', content: 'PWNED'}), ctx(ws, {authorize: swapWhileAsking}));
  assert.equal(result.ok, false, 'the write is refused');
  assert.deepEqual(await readdir(outside), [], 'no folder and no file appeared outside');
});

// Spec: MUS-SPEC-05-347B (docs/spec/clauses/05-access-modes-and-approvals.md#mus-spec-05-347b)
test('a racer swapping a folder and a link under repeated writes puts no content outside', async t => {
  const {root, ws, outside} = await sandbox(t); if (!await canLink(root)) return t.skip('no link privilege');
  const victim = join(outside, 'victim.txt'); await writeFile(victim, 'keep');
  await mkdir(join(ws, 'd')); await writeFile(join(ws, 'top.txt'), 'mine');
  const quiet = (work: Promise<unknown>) => work.then(() => undefined, () => undefined);
  let racing = true;
  // The racer moves the folder `d` away, puts a link to `outside` in its place, and back; the same for the name `top.txt`.
  const racer = (async () => {
    while (racing) {
      await quiet(rename(join(ws, 'd'), join(ws, 'd.hold'))); await tick();
      await quiet(symlink(outside, join(ws, 'd'), win ? 'junction' : undefined)); await tick();
      await quiet(rename(join(ws, 'top.txt'), join(ws, 'top.hold'))); await tick();
      await quiet(symlink(victim, join(ws, 'top.txt'))); await tick();
      await quiet(unlink(join(ws, 'd'))); await tick();
      await quiet(rename(join(ws, 'd.hold'), join(ws, 'd'))); await tick();
      await quiet(unlink(join(ws, 'top.txt'))); await tick();
      await quiet(rename(join(ws, 'top.hold'), join(ws, 'top.txt'))); await tick();
    }
  })();
  for (let i = 0; i < 400; i++) {
    await executeTool(call('write_file', {path: 'd/x.txt', content: 'PWNED'}), ctx(ws));
    await executeTool(call('write_file', {path: 'd/sub/y.txt', content: 'PWNED'}), ctx(ws));
    await executeTool(call('write_file', {path: 'top.txt', content: 'PWNED'}), ctx(ws));
  }
  racing = false; await racer;
  // #710: creating even an empty file/folder outside is forbidden; mutation uses pinned directory handles.
  assert.deepEqual(await readdir(outside), ['victim.txt'], 'no file or folder is created outside');
  assert.equal(await readFile(victim, 'utf8'), 'keep', 'the file outside is unchanged');
});

const info: ProviderAdapter['info'] = () => [{id: 'hybrow', name: 'Hybrow', available: true, identityMasked: 'Hidden', models: []}];
// Spec: MUS-SPEC-05-347C (docs/spec/clauses/05-access-modes-and-approvals.md#mus-spec-05-347c)
test('a policyOnly flag inside request parameters does not skip the approval card', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-wc347-svc-'));
  const answers: unknown[] = []; let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; });
  // The Codex app-server path forwards its parameters as they come; a policyOnly key in them is not the adapter's own say-so.
  const provider: ProviderAdapter = {info, run: async input => { answers.push(await input.onRequest('item/fileChange/requestApproval', {changes: [{path: '/w/notes.txt', kind: 'update'}], policyOnly: true})); finish(); return {status: 'completed', finalMessage: 'done'}; }, stop: async () => true, dispose() {}};
  const service = createAgentService({dataDir, provider, onEvent() {}});
  t.after(async () => { await service.dispose(); await rm(dataDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}); });
  const chat = await service.invoke('chat.create', {});
  await service.invoke('chat.send', {id: chat.id, text: 'go', requestId: randomUUID()});
  let card; for (let i = 0; i < 80 && !card; i++) { await tick(); card = (await service.invoke('chat.select', {id: chat.id})).find(item => item.kind === 'approval' && item.status === 'pending'); }
  assert.ok(card, 'an approval card was raised');
  assert.deepEqual(answers, [], 'the provider is still waiting for the answer');
  await service.invoke('approval.respond', {id: card.id, approved: false, decision: 'decline'});
  await done; assert.deepEqual(answers, [{decision: 'decline'}]);
});

// Spec: MUS-SPEC-05-347D (docs/spec/clauses/05-access-modes-and-approvals.md#mus-spec-05-347d)
test('the HTTP tools pass policyOnly as a separate authorize argument', async t => {
  const {ws} = await sandbox(t); const asked: unknown[][] = [];
  const result = await executeTool(call('write_file', {path: 'f.txt', content: 'x'}, 'c1'), ctx(ws, {authorize: async (...args: unknown[]) => { asked.push(args); return 'allow'; }}));
  assert.equal(result.ok, true); assert.equal(await readFile(join(ws, 'f.txt'), 'utf8'), 'x');
  assert.equal(asked.length, 1); const [method, params, options] = asked[0] as [string, Record<string, unknown>, unknown];
  assert.equal(method, 'item/fileChange/requestApproval');
  assert.equal(params.itemId, 'c1'); assert.equal('policyOnly' in params, false, 'no policyOnly inside the parameters');
  assert.deepEqual(options, {policyOnly: true});
});
