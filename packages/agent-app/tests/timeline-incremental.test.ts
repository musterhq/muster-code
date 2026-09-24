import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {AgentStore} from '../src/runtime/store.ts';

async function fixture(t: {after(fn: () => void | Promise<void>): void}) {
  const dir = await mkdtemp(join(tmpdir(), 'muster-timeline-'));
  const store = new AgentStore(dir);
  t.after(() => { store.close(); return rm(dir, {recursive:true, force:true}); });
  return {dir, store};
}

test('10k history snapshot then tail update returns one changed row', async t => {
  const {store} = await fixture(t);
  const chat = store.createChat({model:'test', mode:'agent'});
  for (let i = 0; i < 10_000; i++) store.appendItem(chat.id, 'assistant', `row-${i}`, 'completed');
  const before = store.timelineSnapshot(chat.id);
  assert.equal(before.items.length, 10_000);
  store.updateItem(before.items.at(-1)!.id, 'tail-updated', 'completed');
  const delta = store.timelineChanges(chat.id, before.revision);
  assert.equal(delta.items.length, 1);
  assert.equal(delta.items[0]!.id, before.items.at(-1)!.id);
  assert.equal(delta.items[0]!.text, 'tail-updated');
  assert.equal(delta.revision, before.revision + 1);
});

test('empty baseline, rollback, same-text update, and invalid cursors are authoritative', async t => {
  const {store} = await fixture(t);
  const chat = store.createChat({model:'test', mode:'agent'});
  assert.deepEqual(store.timelineSnapshot(chat.id), {items:[], revision:0});
  assert.throws(() => store.tx(() => { store.appendItem(chat.id, 'notice', 'rolled back'); throw new Error('abort'); }), /abort/);
  assert.deepEqual(store.timelineSnapshot(chat.id), {items:[], revision:0});
  assert.deepEqual(store.timelineChanges(chat.id, 0), {items:[], revision:0});
  const item = store.appendItem(chat.id, 'assistant', 'same', 'completed');
  const first = store.timelineSnapshot(chat.id);
  store.updateItem(item.id, 'same', 'completed');
  const second = store.timelineChanges(chat.id, first.revision);
  assert.equal(second.items.length, 1);
  assert.equal(second.revision, first.revision + 1);
  assert.throws(() => store.timelineChanges(chat.id, -1), /Invalid timeline revision/);
  assert.throws(() => store.timelineChanges(chat.id, second.revision + 1), /ahead/);
});

test('revision and delta survive reopen', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'muster-timeline-reopen-'));
  const first = new AgentStore(dir);
  const chat = first.createChat({model:'test', mode:'agent'});
  const item = first.appendItem(chat.id, 'assistant', 'before', 'completed');
  const cursor = first.timelineSnapshot(chat.id).revision;
  first.close();
  const second = new AgentStore(dir);
  t.after(() => { second.close(); return rm(dir, {recursive:true, force:true}); });
  second.updateItem(item.id, 'after', 'completed');
  const delta = second.timelineChanges(chat.id, cursor);
  assert.equal(delta.items[0]!.text, 'after');
  assert.equal(delta.revision, cursor + 1);
});

test('tracking storage stays bounded to timeline rows across repeated updates', async t => {
  const {store} = await fixture(t);
  const chat = store.createChat({model:'test', mode:'agent'});
  const item = store.appendItem(chat.id, 'assistant', 'start', 'running');
  for (let i = 0; i < 1_000; i++) store.updateItem(item.id, `update-${i}`, 'running');
  const db = (store as unknown as {db: DatabaseSync}).db;
  const count = db.prepare('SELECT COUNT(*) AS count FROM timeline_changes WHERE chat_id = ?').get(chat.id) as {count:number};
  assert.equal(count.count, 1);
  const delta = store.timelineChanges(chat.id, 1);
  assert.equal(delta.items.length, 1);
  assert.equal(delta.items[0]!.text, 'update-999');
});

test('migrates the temporary append-only tracking schema and keeps its latest row revision', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'muster-timeline-migration-'));
  const db = new DatabaseSync(join(dir, 'muster-agent.sqlite'));
  db.exec(`CREATE TABLE timeline (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, chat_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, status TEXT, created_at TEXT NOT NULL, data TEXT);
    CREATE TABLE timeline_cursors (chat_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
    CREATE TABLE timeline_changes (chat_id TEXT NOT NULL, revision INTEGER NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(chat_id, revision));
    INSERT INTO timeline (id,chat_id,kind,text,status,created_at) VALUES ('item','chat','assistant','old','completed','now');
    INSERT INTO timeline_cursors VALUES ('chat',2);
    INSERT INTO timeline_changes VALUES ('chat',1,1),('chat',2,1);`);
  db.close();
  const store = new AgentStore(dir);
  t.after(() => { store.close(); return rm(dir, {recursive:true, force:true}); });
  const delta = store.timelineChanges('chat', 1);
  assert.equal(delta.revision, 2);
  assert.deepEqual(delta.items.map(item => item.id), ['item']);
});
