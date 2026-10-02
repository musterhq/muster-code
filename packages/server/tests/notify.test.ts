/** Wave 4: G27 read-only notifications. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotificationBridge } from '../src/connectors/notify.ts';
import { SqliteServerStore } from '../src/store/sqlite.ts';
import type { ConnectorRecord } from '../src/store/types.ts';

async function setup(config: Record<string, unknown> = { notifyChannel: 'C1', notifyProject: 'p1' }) {
  const store = new SqliteServerStore(':memory:'), sent: { id: string; text: string; key: string | null }[] = [];
  const rec = (id: string, c: Record<string, unknown>): ConnectorRecord => ({ id, type: 'slack', name: id, ownerUserId: 'u', scope: 'org', projectId: null, enabled: true, mode: 'socket', secretRefs: {}, config: c, webhookPublicId: id, createdAt: '', updatedAt: '' });
  await store.createConnector(rec('c1', config)); await store.createConnector(rec('c2', { defaultMode: 'reply' }));
  let items = [{ id: 'ask:1', title: 'CTO has a question: DB?', why: 'Which engine? sk-abcdefghijklmnopqrstuvwx1234' }], approvals: any[] = [], cards: any[] = [{ id: 's1', title: 'Status', rev: 1, text: 'On track.' }];
  const runtime = { running: true, snapshot: async () => ({ projects: [{ id: 'p1', name: 'Support' }] }), invoke: async (cmd: string) => cmd === 'project.gov.summary' ? { items } : cmd === 'project.approvals.list' ? { items: approvals } : { cards } };
  const bridge = new NotificationBridge({ store, registry: () => ({ notify: async (id: string, text: string, key: string | null) => { sent.push({ id, text, key }); } }) as never, runtime: () => runtime as never, publicUrl: () => 'https://muster.example.com', log: () => undefined, debounceMs: 20 });
  return { store, bridge, sent, set: (a: { items?: any[]; approvals?: any[]; cards?: any[] }) => { if (a.items) items = a.items; if (a.approvals) approvals = a.approvals; if (a.cards) cards = a.cards; } };
}

test('G27: the first run records what exists without flooding the channel; later changes post once, redacted, with a link', async () => {
  const { bridge, sent, set } = await setup();
  assert.equal(await bridge.flush('p1'), 0, 'backlog is recorded, not posted'); assert.equal(sent.length, 0);
  set({ items: [{ id: 'ask:1', title: 'CTO has a question: DB?', why: 'Which engine? sk-abcdefghijklmnopqrstuvwx1234' }, { id: 'ask:2', title: 'Deploy to production?', why: 'Version 1.2.0' }], cards: [{ id: 's1', title: 'Status', rev: 2, text: 'Blocked on the DB choice.' }], approvals: [{ id: 'a1', kind: 'hire', title: 'Add Dana as Designer', requestedBy: 'CTO', state: 'pending' }, { id: 'a2', kind: 'secret', title: 'x', requestedBy: 'y', state: 'pending' }] });
  assert.equal(await bridge.flush('p1'), 3);
  const text = sent.map(s => s.text).join('\n---\n');
  assert.match(text, /Needs you in Support: Deploy to production\?/); assert.match(text, /Approval in Support: Add Dana as Designer \(asked by CTO\)/); assert.match(text, /Status \(Support, revision 2\)\nBlocked on the DB choice/);
  assert.match(text, /Open: https:\/\/muster\.example\.com\/\?project=p1/); assert.ok(!/ask:1|sk-abc/.test(text));
  assert.equal(await bridge.flush('p1'), 0, 'nothing is posted twice'); assert.equal(sent.every(s => s.id === 'c1'), true, 'only the connector that notifies');
});

test('G27: events debounce into one flush; projects nobody notifies for do nothing; failures are recorded not thrown', async () => {
  const { bridge, sent, set, store } = await setup({ notifyChannel: 'C1', notifyProject: 'p1', notifyBacklog: true });
  for (let i = 0; i < 20; i++) bridge.touch({ type: 'projectChanged', projectId: 'p1' });
  bridge.touch({ type: 'projectChanged', projectId: 'other' }); bridge.touch({ type: 'chatStatus', projectId: 'p1' });
  await new Promise(r => setTimeout(r, 200));
  assert.equal(sent.filter(s => /Needs you/.test(s.text)).length, 1, 'backlog on request, once');
  set({ items: [{ id: 'ask:9', title: 'New', why: '' }] });
  const failing = new NotificationBridge({ store, registry: () => ({ notify: async () => { throw new Error('channel_not_found'); } }) as never, runtime: () => ({ running: true, snapshot: async () => ({ projects: [{ id: 'p1', name: 'S' }] }), invoke: async (c: string) => c === 'project.gov.summary' ? { items: [{ id: 'z', title: 't', why: '' }] } : c === 'project.approvals.list' ? { items: [] } : { cards: [] } }) as never, publicUrl: () => null, log: () => undefined, debounceMs: 10 });
  assert.equal(await failing.flush('p1'), 0);
  assert.ok((await store.connectorEvents('c1', 20)).some(e => e.status === 'notify-failed' && /channel_not_found/.test(e.detail ?? '')));
  bridge.dispose(); failing.dispose();
});
