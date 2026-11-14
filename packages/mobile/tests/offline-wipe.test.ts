import {Computers} from '../src/connection/computers';
import {createComputerStore, memorySecureStore} from '../src/connection/store';
import {OfflineCache} from '../src/offline/cache';
import type {MobileConnection, PairedRecord} from '../src/shared';
import {fakeConnection} from './fake-connection';
import {nodeSqlite} from './sqlite';

const record = (name: string, route: string): PairedRecord => ({relayUrl: 'wss://relay.example', route, desktopKey: `k-${name}`, desktopName: name, deviceId: `d-${name}`, publicKey: `p-${name}`, privateKey: `s-${name}`});
const TABLES = ['lists', 'chat_items', 'outbox'];

// Spec: MUS-SPEC-23-20C (docs/spec/clauses/23-mobile.md#mus-spec-23-20c)
test('a revoked computer’s cached chats, items, needs and outbox are wiped and another computer’s stay', async () => {
  const db = nodeSqlite();
  const cache = new OfflineCache(db);
  const count = (computer: string) => TABLES.map(table => db.all<{n: number}>(`SELECT COUNT(*) AS n FROM ${table} WHERE computer = ?`, computer)[0]!.n);
  const studio = record('Studio Mac', 'a'.repeat(32)), build = record('Build box', 'b'.repeat(32));
  for (const id of [studio.route, build.route]) {
    cache.saveList(id, 'chats', [{id: 'c1', title: 'Secret plan', status: 'idle', updatedAt: '2026-11-14T10:00:00Z', place: null, needsYou: 0}], 1);
    cache.saveList(id, 'needs', [], 1);
    cache.saveChat(id, {id: 'c1', title: 'Secret plan', status: 'idle', updatedAt: '2026-11-14T10:00:00Z', place: null, needsYou: 0}, [{id: 'm1', kind: 'assistant', text: 'the plan', createdAt: '2026-11-14T10:00:00Z'}], 1);
    cache.enqueue(id, 'c1', 'queued words');
  }
  const store = createComputerStore(memorySecureStore());
  await store.save(studio); await store.save(build);
  const closers = new Map<string, (reason: string) => void>();
  const connect = async (entry: PairedRecord): Promise<MobileConnection> => {
    const connection = fakeConnection({'chat.send': () => new Promise(() => undefined)});
    return Object.assign(connection, {onClose(listener: (reason: string) => void) { closers.set(entry.route, listener); return () => undefined; }});
  };
  const computers = new Computers({store, cache, connect, heartbeat: false});
  await computers.load();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(computers.views().map(view => view.path)).toEqual(['relay', 'relay']);
  expect(count(studio.route)).toEqual([3, 1, 1]);
  // Studio Mac revokes this phone: everything cached from it goes, Build box's stays.
  closers.get(studio.route)!('revoked');
  expect(computers.views().find(view => view.id === studio.route)!.path).toBe('revoked');
  expect(count(studio.route)).toEqual([0, 0, 0]);
  expect(count(build.route)).toEqual([3, 1, 1]);
  // Unpairing Build box on the phone wipes it too, and forgets its keys.
  await computers.remove(build.route);
  expect(count(build.route)).toEqual([0, 0, 0]);
  expect((await store.list()).map(entry => entry.route)).toEqual([studio.route]);
  computers.dispose();
});
