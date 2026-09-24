// R3: main-process exception guard — logs redacted, notifies once per distinct fault, keeps the app alive,
// and shuts down cleanly only on an unrecoverable error or a fault storm.
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {describeFault, installProcessGuard, isFatalFault} from '../src/main/process-guard.ts';

function harness(overrides: {stormLimit?: number} = {}) {
  const proc = new EventEmitter();
  const logs: string[] = [], notices: string[] = [], fatals: string[] = [];
  let clock = 1_000;
  const guard = installProcessGuard(proc as never, {log: line => logs.push(line), notify: message => notices.push(message), onFatal: reason => fatals.push(reason), now: () => clock, home: '/Users/alice', ...overrides});
  return {proc, logs, notices, fatals, guard, tick: (ms: number) => { clock += ms; }};
}

test('an uncaught exception or unhandled rejection is logged redacted, surfaced once and survived', () => {
  const h = harness();
  h.proc.emit('uncaughtException', new Error('boom with sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345 in /Users/alice/repo'));
  h.proc.emit('unhandledRejection', new Error('boom with sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345 in /Users/alice/repo'));
  h.proc.emit('unhandledRejection', 'plain reason');
  assert.equal(h.logs.length, 3);
  assert.ok(h.logs.every(line => !line.includes('sk-ant-api03') && !line.includes('/Users/alice')));
  assert.match(h.logs[0]!, /uncaughtException/);
  assert.match(h.logs[1]!, /unhandledRejection/);
  assert.equal(h.notices.length, 2, 'the same fault is announced once per interval');
  assert.match(h.notices[0]!, /internal error and kept running/);
  assert.deepEqual(h.fatals, []);
  assert.equal(h.guard.faults(), 3);
  h.tick(61_000);
  h.proc.emit('uncaughtException', new Error('boom with sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345 in /Users/alice/repo'));
  assert.equal(h.notices.length, 3, 'announced again after the interval');
});

test('out-of-memory and fault storms ask for a clean shutdown exactly once', () => {
  const oom = harness();
  oom.proc.emit('uncaughtException', Object.assign(new Error('heap'), {code: 'ERR_OUT_OF_MEMORY'}));
  oom.proc.emit('uncaughtException', new Error('again'));
  assert.deepEqual(oom.fatals, ['unrecoverable error']);
  const storm = harness({stormLimit: 3});
  for (let i = 0; i < 6; i++) storm.proc.emit('uncaughtException', new Error(`fault ${i}`));
  assert.deepEqual(storm.fatals, ['repeated internal errors']);
  const spaced = harness({stormLimit: 3});
  for (let i = 0; i < 6; i++) { spaced.proc.emit('uncaughtException', new Error(`fault ${i}`)); spaced.tick(5_000); }
  assert.deepEqual(spaced.fatals, [], 'faults spread out are survived');
});

test('dispose removes the listeners; helpers classify and describe', () => {
  const h = harness();
  h.guard.dispose();
  assert.equal(h.proc.listenerCount('uncaughtException'), 0);
  assert.equal(h.proc.listenerCount('unhandledRejection'), 0);
  assert.equal(isFatalFault(new Error('Reached heap limit Allocation failed')), true);
  assert.equal(isFatalFault(new TypeError('x is undefined')), false);
  assert.match(describeFault({code: 42}, '/Users/alice'), /"code":42/);
});
