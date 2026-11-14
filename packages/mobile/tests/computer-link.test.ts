import {ComputerLink, OFFLINE_AFTER_MS, type LinkPath} from '../src/connection/link';
import {MobileError, type MobileConnection, type PairedRecord} from '../src/shared';
import {fakeConnection} from './fake-connection';

const record: PairedRecord = {relayUrl: 'wss://relay.example', route: 'a'.repeat(32), desktopKey: 'k', desktopName: 'Studio Mac', deviceId: 'd1', publicKey: 'p', privateKey: 's'};
/** A connection whose close the test triggers, with the reason the client would report. */
function closable(via: 'lan' | 'relay') {
  const connection = fakeConnection({ping: {}});
  let closeWith: (reason: string) => void = () => undefined;
  Object.assign(connection, {via, onClose(listener: (reason: string) => void) { closeWith = listener; return () => undefined; }});
  return {connection: connection as MobileConnection, close: (reason = 'closed') => closeWith(reason)};
}

beforeEach(() => jest.useFakeTimers({now: new Date('2026-11-14T14:00:00Z')}));
afterEach(() => jest.useRealTimers());

// Spec: MUS-SPEC-23-19B (docs/spec/clauses/23-mobile.md#mus-spec-23-19b)
test('a computer’s link reads LAN, Relay, Reconnecting and Offline, and turns Offline only after 3 seconds down', async () => {
  const lan = closable('lan'), relay = closable('relay');
  const attempts: Array<{resolve(c: MobileConnection): void; reject(e: unknown): void}> = [];
  const link = new ComputerLink(record, {connect: () => new Promise((resolve, reject) => attempts.push({resolve, reject})), heartbeat: false});
  const seen: LinkPath[] = [];
  link.subscribe(() => { if (seen[seen.length - 1] !== link.state.path) seen.push(link.state.path); });
  link.start();
  attempts[0]!.resolve(lan.connection);
  await jest.advanceTimersByTimeAsync(0);
  expect(link.state.path).toBe('lan');
  expect(link.state.connection).toBe(lan.connection);
  lan.close();
  expect(link.state.path).toBe('reconnecting');
  expect(link.state.connection).toBeNull();
  // The first retry (after 1 s) fails: still reconnecting at 2 s, and the pill never shows Offline for a blip under 3 s.
  await jest.advanceTimersByTimeAsync(1000);
  attempts[1]!.reject(new MobileError('offline', 'Your computer is offline.'));
  await jest.advanceTimersByTimeAsync(1000);
  expect(link.state.path).toBe('reconnecting');
  await jest.advanceTimersByTimeAsync(OFFLINE_AFTER_MS - 2000);
  expect(link.state.path).toBe('offline');
  expect(link.state.downSince).toBe(Date.parse('2026-11-14T14:00:00Z'));
  // The next attempt (2 s after the failure) gets through the relay.
  await jest.advanceTimersByTimeAsync(1000);
  attempts[2]!.resolve(relay.connection);
  await jest.advanceTimersByTimeAsync(0);
  expect(link.state.path).toBe('relay');
  relay.close('revoked');
  expect(link.state.path).toBe('revoked');
  await jest.advanceTimersByTimeAsync(60_000);
  expect(attempts).toHaveLength(3);
  expect(seen).toEqual(['connecting', 'lan', 'reconnecting', 'offline', 'relay', 'revoked']);
  link.stop();
});
