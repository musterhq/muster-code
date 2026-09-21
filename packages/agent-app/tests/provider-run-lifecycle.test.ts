import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getEventListeners} from 'node:events';
import {createProviderAdapter, ProviderPreDispatchError, type CoreClient, type ProviderInput, type ProviderResult} from '../src/runtime/provider.ts';
import {admissionRetryDelayMs, coreBudgetOptions, classifyProviderFailure, MAX_ADMISSION_RETRIES, requestWhileOwned, shouldRetryAdmission} from '../src/runtime/provider-run-lifecycle.ts';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return {promise, resolve, reject};
};
const input = (id: string): ProviderInput => ({chat: {id, mode: 'agent'} as ProviderInput['chat'], cwd: '/unused', prompt: 'test', onDelta() {}, onReasoning() {}, onEvent() {}, async onRequest() {return undefined;}});
function fixture(lifecycle = false) {
  const runs: {args: Record<string, unknown>; result: ReturnType<typeof deferred<ProviderResult>>}[] = [];
  const cleared: string[] = [];
  const interrupted: string[] = [];
  const core: CoreClient = {
    ...(lifecycle ? {CODEX_RUN_LIFECYCLE_VERSION: 1} : {}),
    runCodexAppServer(args) { const result = deferred<ProviderResult>(); runs.push({args, result}); return result.promise; },
    async callCodexConversation() { return {}; },
    async interruptActiveCodexTurn(owner) { interrupted.push(owner); return false; },
    clearCodexAppServerSessions(owner) { cleared.push(owner); },
  };
  const adapter = createProviderAdapter({core, available: () => true, command: '/unused'});
  return {adapter, runs, cleared, interrupted};
}
const complete: ProviderResult = {status: 'completed', finalMessage: 'done', dispatchState: 'dispatched', threadId: 'thread', turnId: 'turn'};

test('defaults stay untouched; only the actual legacy idle budget is supported', () => {
  assert.deepEqual(coreBudgetOptions(), {});
  assert.deepEqual(coreBudgetOptions({idleMs: 1234}), {timeoutMs: 1234});
  for (const value of [0, -1, NaN, Infinity, 0.5, 2_147_483_648]) assert.throws(() => coreBudgetOptions({idleMs: value}));
  for (const name of ['requestMs', 'turnMs', 'taskMs']) assert.throws(() => coreBudgetOptions({[name]: 1000}), /unsupported/);
});

test('503 is admission-retryable only with explicit no-dispatch evidence', () => {
  const base = {status: 'failed' as const, errorMessage: '503 Chat admission capacity is temporarily unavailable.'};
  const evidence = {activity: false, terminal: false, cancelled: false};
  assert.equal(classifyProviderFailure({...base, dispatchState: 'not-dispatched'}, evidence)?.kind, 'admission-rejected');
  for (const dispatchState of ['unknown', 'dispatched', undefined] as const) {
    assert.equal(classifyProviderFailure({...base, dispatchState}, evidence)?.kind, 'recovery-needed');
    assert.equal(classifyProviderFailure({...base, dispatchState}, evidence)?.retryable, false);
  }
  assert.equal(classifyProviderFailure({...base, dispatchState: 'not-dispatched'}, {...evidence, activity: true})?.retryable, false);
});

test('bounded admission retry never applies after provider acceptance', () => {
  const safe = {status:'failed' as const, dispatchState:'not-dispatched' as const, recovery:{kind:'admission-rejected' as const, retryable:true, reason:'capacity'}};
  assert.equal(shouldRetryAdmission(safe), true);
  assert.equal(MAX_ADMISSION_RETRIES, 2);
  assert.equal(admissionRetryDelayMs(1), 250);
  assert.equal(admissionRetryDelayMs(2, 10_000), 4_000);
  assert.equal(shouldRetryAdmission({...safe, dispatchState:'unknown'}), false);
  assert.equal(shouldRetryAdmission({...safe, turnId:'turn'}), false);
  assert.equal(shouldRetryAdmission({...safe, recovery:{...safe.recovery, retryable:false}}), false);
});

test('stopping one chat preserves another; duplicate attempts stay rejected until real settlement', async () => {
  const f = fixture();
  const a = f.adapter.run(input('a'));
  const b = f.adapter.run(input('b'));
  assert.notEqual(f.runs[0]!.args.transportOwner, f.runs[1]!.args.transportOwner);
  assert.equal('timeoutMs' in f.runs[0]!.args, false);
  await assert.rejects(f.adapter.run(input('a')), /already owns/);
  const stopped = f.adapter.stop('a');
  const again = f.adapter.stop('a');
  await Promise.resolve();
  assert.equal(f.interrupted.length, 1);
  assert.ok(f.cleared.every(owner => owner === f.runs[0]!.args.transportOwner));
  await assert.rejects(f.adapter.run(input('a')), /already owns/);
  f.runs[0]!.result.resolve({...complete, status: 'failed', errorMessage: 'closed'});
  assert.equal((await a).recovery?.kind, 'recovery-needed');
  assert.equal(await stopped, true);
  assert.equal(await again, true);
  f.runs[1]!.result.resolve(complete);
  assert.equal((await b).status, 'completed');
  assert.equal(f.runs.length, 2); // Never replay either prompt.
  f.adapter.dispose();
});

test('late startup activity after stop is closed, hidden callbacks cannot authorize work', async () => {
  const f = fixture(); let emitted = 0;
  const run = f.adapter.run({...input('a'), onDelta() {emitted++;}, async onRequest() { throw new Error('must not ask after stop'); }});
  const stopped = f.adapter.stop('a');
  await Promise.resolve();
  const args = f.runs[0]!.args;
  const clears = f.cleared.length;
  (args.onDelta as (text: string) => void)('late');
  assert.equal(emitted, 0);
  assert.ok(f.cleared.length > clears);
  assert.equal(await (args.onRequest as ProviderInput['onRequest'])('approval', {}), undefined);
  f.runs[0]!.result.resolve({...complete, status: 'failed', errorMessage: 'closed'});
  assert.equal((await run).recovery?.retryable, false);
  await stopped;
  f.adapter.dispose();
});

test('approval cancellation removes listeners and rejects a late approval', async () => {
  const controller = new AbortController();
  const answer = deferred<Record<string, unknown>>();
  const pending = requestWhileOwned(controller.signal, () => answer.promise);
  await Promise.resolve();
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort();
  assert.equal(await pending, undefined);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  answer.resolve({decision: 'accept'});
  const clean = new AbortController();
  assert.equal(await requestWhileOwned(clean.signal, async () => 'ok'), 'ok');
  assert.equal(getEventListeners(clean.signal, 'abort').length, 0);
});

test('superseded warm callbacks cannot close the next same-chat attempt', async () => {
  const f = fixture();
  const first = f.adapter.run(input('a'));
  f.runs[0]!.result.resolve(complete); await first;
  const second = f.adapter.run(input('a'));
  (f.runs[0]!.args.onDelta as (text: string) => void)('stale');
  assert.equal(f.cleared.length, 0);
  assert.equal(f.runs[0]!.args.transportOwner, f.runs[1]!.args.transportOwner);
  f.runs[1]!.result.resolve(complete); await second;
  f.adapter.dispose();
});

test('dispose is terminal and late startup cannot escape adapter ownership', async () => {
  const f = fixture();
  const run = f.adapter.run(input('a'));
  f.adapter.dispose(); f.adapter.dispose();
  assert.equal(f.interrupted.length, 1);
  await assert.rejects(f.adapter.run(input('b')), /disposed/);
  (f.runs[0]!.args.onEvent as ProviderInput['onEvent'])('turn/started', {threadId: 'thread', turn: {id: 'turn'}});
  f.runs[0]!.result.resolve({...complete, status: 'failed', errorMessage: 'closed'});
  assert.equal((await run).recovery?.kind, 'recovery-needed');
  await f.adapter.stop('a');
  assert.equal(f.adapter.info()[0]!.available, false);
});

test('child terminal event cannot make uncertain parent failure safe to replay', async () => {
  const f = fixture(); const run = f.adapter.run(input('a'));
  (f.runs[0]!.args.onEvent as ProviderInput['onEvent'])('turn/completed', {threadId: 'child', turn: {id: 'child-turn'}});
  f.runs[0]!.result.resolve({...complete, status: 'failed', errorMessage: '503'});
  assert.equal((await run).recovery?.kind, 'recovery-needed');
  f.adapter.dispose();
});

test('unsupported budgets never enter core and explicit idle preserves permission policy', async () => {
  const f = fixture();
  await assert.rejects(f.adapter.run({...input('a'), budgets: {turnMs: 60_000}}), /unsupported/);
  assert.equal(f.runs.length, 0);
  const run = f.adapter.run({...input('a'), chat: {...input('a').chat, mode: 'ask'}, budgets: {idleMs: 180_000}});
  assert.equal(f.runs[0]!.args.timeoutMs, 180_000);
  assert.equal(f.runs[0]!.args.sandbox, 'read-only');
  assert.match(String(f.runs[0]!.args.developerInstructions), /Do not modify files/);
  f.runs[0]!.result.resolve(complete); await run;
  f.adapter.dispose();
});

test('bounded session retention retires idle sessions, leaving known child work observed', async () => {
  const f = fixture();
  for (let n = 0; n < 65; n++) {
    const run = f.adapter.run(input(String(n)));
    if (n === 0) (f.runs[0]!.args.onEvent as ProviderInput['onEvent'])('turn/started', {threadId: 'child', turn: {id: 'child-turn'}});
    f.runs[n]!.result.resolve(complete); await run;
  }
  assert.equal(f.cleared.includes(String(f.runs[0]!.args.transportOwner)), false);
  assert.equal(f.cleared.includes(String(f.runs[1]!.args.transportOwner)), true);
  f.adapter.dispose();
});


test('thrown errors retain only identified parent thread and matching parent turn', async () => {
  const f = fixture(); const run = f.adapter.run(input('a'));
  const event = f.runs[0]!.args.onEvent as ProviderInput['onEvent'];
  event('thread/started', {thread: {id: 'child', source: {subAgent: {spawn: {parentThreadId: 'parent'}}}}});
  event('turn/started', {threadId: 'child', turn: {id: 'child-turn'}});
  event('thread/started', {thread: {id: 'parent', source: 'appServer'}});
  event('turn/started', {threadId: 'parent', turn: {id: 'parent-turn'}});
  event('turn/started', {threadId: 'child', turn: {id: 'other-child-turn'}});
  f.runs[0]!.result.reject(new Error('transport disconnected'));
  const result = await run;
  assert.equal(result.threadId, 'parent');
  assert.equal(result.turnId, 'parent-turn');
  assert.equal(result.recovery?.kind, 'recovery-needed');
  f.adapter.dispose();
});

test('ambiguous source cannot replace missing parent identity with a child', async () => {
  const f = fixture(); const run = f.adapter.run(input('a'));
  const event = f.runs[0]!.args.onEvent as ProviderInput['onEvent'];
  event('thread/started', {thread: {id: 'ambiguous'}});
  event('turn/started', {threadId: 'ambiguous', turn: {id: 'unknown-turn'}});
  f.runs[0]!.result.reject(new Error('transport disconnected'));
  const result = await run;
  assert.equal(result.threadId, undefined);
  assert.equal(result.turnId, undefined);
  assert.equal(result.recovery?.kind, 'recovery-needed');
  f.adapter.dispose();
});


test('opt-in core receives independent budgets, cancellation and real identity hooks', async () => {
  const f = fixture(true); const seen: unknown[] = [];
  const run = f.adapter.run({...input('a'), budgets:{idleMs:180_000,turnMs:3_600_000,requestMs:10_000},onThreadReady:id=>seen.push(id),onTurnAccepted:value=>seen.push(value)});
  const args = f.runs[0]!.args;
  assert.deepEqual(args.budgets,{idleMs:180_000,turnMs:3_600_000,requestMs:10_000});
  assert.equal('timeoutMs' in args,false);
  (args.onThreadReady as NonNullable<ProviderInput['onThreadReady']>)('real-thread');
  (args.onTurnAccepted as NonNullable<ProviderInput['onTurnAccepted']>)({threadId:'real-thread',turnId:'real-turn',dispatchState:'dispatched'});
  assert.equal(seen.length,2);
  const stopped = f.adapter.stop('a');
  assert.equal((args.signal as AbortSignal).aborted,true);
  assert.equal(f.interrupted.length,0); // Core signal owns the native interruption.
  f.runs[0]!.result.reject(new Error('closed'));
  const result = await run;
  assert.equal(result.threadId,'real-thread'); assert.equal(result.turnId,'real-turn');
  assert.equal(result.recovery?.kind,'recovery-needed');
  await stopped; f.adapter.dispose();
});

test('preflight errors are tagged with definite no-dispatch evidence', async () => {
  const f = fixture(true);
  await assert.rejects(f.adapter.run({...input('a'),budgets:{taskMs:1000}}), error=>error instanceof ProviderPreDispatchError && error.dispatchState==='not-dispatched');
  assert.equal(f.runs.length,0);
  f.adapter.dispose();
});


test('Agent Mode opts into a finite four-hour turn while legacy core defaults stay untouched', async () => {
  assert.deepEqual(coreBudgetOptions(undefined,true),{budgets:{idleMs:180_000,requestMs:30_000,turnMs:14_400_000}});
  assert.deepEqual(coreBudgetOptions({idleMs:2000,turnMs:undefined},true),{budgets:{idleMs:2000,requestMs:30_000,turnMs:14_400_000}});
  assert.deepEqual(coreBudgetOptions(),{});
  const f = fixture(true); const run = f.adapter.run(input('a'));
  assert.deepEqual(f.runs[0]!.args.budgets,{idleMs:180_000,requestMs:30_000,turnMs:14_400_000});
  assert.equal('timeoutMs' in f.runs[0]!.args,false);
  f.runs[0]!.result.resolve(complete); await run; f.adapter.dispose();
});

test('provider dispatch uses selected access and still clamps Full in Ask/Plan', async () => {
  for (const [mode,permissionMode,sandbox,approvalPolicy,networkAccess] of [
    ['agent','workspace','workspace-write','on-request',false],
    ['agent','read-only','read-only','never',false],
    ['agent','full','danger-full-access','never',true],
    ['ask','full','read-only','never',false],
    ['plan','full','read-only','never',false],
  ] as const) {
    const f=fixture(true);
    const run=f.adapter.run({...input('a'),chat:{...input('a').chat,mode,permissionMode}});
    assert.equal(f.runs[0]!.args.sandbox,sandbox);
    assert.equal(f.runs[0]!.args.approvalPolicy,approvalPolicy);
    assert.equal(f.runs[0]!.args.networkAccess,networkAccess);
    assert.ok((f.runs[0]!.args.configOverrides as string[]).includes(`sandbox_workspace_write.network_access=${networkAccess}`));
    f.runs[0]!.result.resolve(complete); await run; f.adapter.dispose();
  }
});
