import {startHeartbeat, HEARTBEAT_MS, PING_TIMEOUT_MS} from '../src/connection/heartbeat';
import {MobileError} from '../src/shared';
import {fakeConnection} from './fake-connection';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
const pass = async (ms: number) => { await jest.advanceTimersByTimeAsync(ms); };

// Spec: MUS-SPEC-23-17A (docs/spec/clauses/23-mobile.md#mus-spec-23-17a)
test('the heartbeat reports a silent link dead once, counts any answer as alive, and checks at once on demand', async () => {
  expect([HEARTBEAT_MS, PING_TIMEOUT_MS]).toEqual([15_000, 5_000]);
  let silent = false;
  const connection = fakeConnection({ping: () => silent ? new Promise(() => undefined) : {}});
  const dead = jest.fn();
  const beat = startHeartbeat(connection, {onDead: dead});
  await pass(15_000);
  expect(connection.calls.filter(call => call.method === 'ping')).toHaveLength(1);
  expect(dead).not.toHaveBeenCalled();
  silent = true;
  await pass(15_000);
  expect(dead).not.toHaveBeenCalled();
  await pass(5_000);
  expect(dead).toHaveBeenCalledTimes(1);
  await pass(60_000);
  expect(dead).toHaveBeenCalledTimes(1);
  beat.stop();

  const onDemand = jest.fn();
  const quiet = startHeartbeat(fakeConnection({ping: () => new Promise(() => undefined)}), {onDead: onDemand});
  await pass(1_000);
  quiet.check();
  await pass(4_900);
  expect(onDemand).not.toHaveBeenCalled();
  await pass(200);
  expect(onDemand).toHaveBeenCalledTimes(1);
  quiet.stop();

  const old = jest.fn();
  const older = fakeConnection({ping: () => Promise.reject(new MobileError('bad-request', 'Unknown request.'))});
  const oldBeat = startHeartbeat(older, {onDead: old});
  await pass(15_000);
  expect(older.calls.filter(call => call.method === 'ping')).toHaveLength(1);
  expect(old).not.toHaveBeenCalled();
  oldBeat.stop();
  await pass(60_000);
  expect(older.calls.filter(call => call.method === 'ping')).toHaveLength(1);
});
