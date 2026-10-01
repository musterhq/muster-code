import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AuditLog } from '../src/audit.ts';
import { Accounts } from '../src/auth/accounts.ts';
import { CONNECTOR_TYPES } from '../src/connectors/catalog.ts';
import { ConnectorRegistry, framed, type TurnRunner } from '../src/connectors/registry.ts';
import { matches, parseMatch, route } from '../src/connectors/router.ts';
import type { AdapterContext, InboundMessage, OutboundMessage } from '../src/connectors/types.ts';
import { createSecretBox, ServerSecrets } from '../src/secret-box.ts';
import { SqliteServerStore } from '../src/store/sqlite.ts';
import type { ConnectorRecord } from '../src/store/types.ts';
import { randomBytes } from 'node:crypto';

const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({ connectorId: 'c', messageId: 'm1', externalUserId: 'U1', userName: 'Ana', text: 'please fix the build',
  conversation: { kind: 'channel', id: 'C1', name: '#support', threadId: 'm1' }, mentioned: true, guest: false, audience: { members: 12, guests: 1 }, ...over });
const connector = (config: Record<string, unknown> = {}): ConnectorRecord => ({ id: 'c', type: 'test', name: 'n', ownerUserId: 'u', scope: 'org', projectId: null, enabled: true, mode: 'x', secretRefs: {}, config, webhookPublicId: 'w', createdAt: '', updatedAt: '' });

test('routing: first match by priority, channel names or ids, guests never reach internal or default routes', () => {
  assert.equal(matches({ channel: '#support' }, msg()), true);
  assert.equal(matches({ channel: 'C1' }, msg()), true);
  assert.equal(matches({ channel: '#eng' }, msg()), false);
  assert.equal(matches({ dm: true }, msg()), false);
  assert.equal(matches({ keyword: 'BUILD' }, msg()), true);
  assert.equal(matches({}, msg({ guest: true })), false, 'default senderRole is internal');
  assert.equal(matches({ senderRole: 'any' }, msg({ guest: true })), true);
  const rules = [
    { id: 'r2', connectorId: 'c', priority: 20, match: {}, action: { projectId: 'p-general', mode: 'reply' as const }, createdAt: '2' },
    { id: 'r1', connectorId: 'c', priority: 10, match: { channel: '#support' }, action: { projectId: 'p-support', mode: 'task' as const }, createdAt: '1' },
  ];
  assert.equal(route(connector(), rules, msg())?.action.projectId, 'p-support');
  assert.equal(route(connector(), rules, msg({ conversation: { kind: 'channel', id: 'C2', name: '#eng', threadId: 'x' } }))?.ruleId, 'r2');
  assert.equal(route(connector({ defaultProjectId: 'p-def' }), [], msg())?.action.projectId, 'p-def');
  assert.equal(route(connector({ defaultProjectId: 'p-def' }), [], msg({ guest: true })), null);
  assert.deepEqual(parseMatch('channel=#support, mention=true, sender=any'), { channel: '#support', mention: true, senderRole: 'any' });
  assert.throws(() => parseMatch('color=red'), /Unknown match key/);
  assert.throws(() => parseMatch('dm=maybe'), /true or false/);
});

test('the agent is told who asked and that the whole channel reads the reply', () => {
  const text = framed(connector(), msg(), null);
  assert.match(text, /Everyone in this channel reads the reply \(12 members, including 1 guest\)/);
  assert.match(text, /not linked to a Muster account/);
  assert.match(framed(connector(), msg({ conversation: { kind: 'dm', id: 'D1' } }), null), /Only the sender reads the reply/);
});

async function harness() {
  const store = new SqliteServerStore(':memory:');
  const audit = new AuditLog(store);
  const accounts = new Accounts(store, audit);
  const owner = await accounts.initOwner({ username: 'olivia', password: 'correct horse battery' });
  const secrets = new ServerSecrets(store, createSecretBox(randomBytes(32)));
  const sent: OutboundMessage[] = [];
  const contexts: AdapterContext[] = [];
  CONNECTOR_TYPES.fake = { type: 'fake', label: 'Fake', status: 'available', modes: ['socket'], secrets: () => ['botToken'], configKeys: ['defaultProjectId', 'guestPolicy', 'requireLink', 'defaultMode'],
    create: ctx => { contexts.push(ctx); return { start: async () => ctx.health('ok'), stop: async () => undefined, test: async () => ({ ok: true, detail: 'fake ok', latencyMs: 1 }), send: async m => { sent.push(m); } }; } };
  const turns: Array<{ kind: string; chatId: string | null; text: string; actor: string; projectId: string }> = [];
  let n = 0;
  const runner: TurnRunner = {
    reply: async i => { turns.push({ kind: 'reply', chatId: i.chatId, text: i.text, actor: i.actor, projectId: i.projectId }); return { chatId: i.chatId ?? `chat-${++n}`, runId: `run-${n}` }; },
    task: async i => { turns.push({ kind: 'task', chatId: null, text: i.text, actor: i.actor, projectId: i.projectId }); return { chatId: `task-chat-${++n}`, runId: `run-${n}`, taskId: `task-${n}` }; },
    wait: async () => ({ ok: true, text: 'Done: the build is green.' }),
    projectExists: async id => ['p-support', 'p-general'].includes(id),
    chatProject: async id => id.startsWith('task-chat') ? 'p-support' : 'p-general',
  };
  const registry = new ConnectorRegistry({ store, secrets, audit, runner, publicUrl: () => null, log: () => undefined });
  return { store, audit, accounts, owner, secrets, registry, sent, contexts, turns };
}

test('registry: many instances per type, secrets encrypted by reference, config rejects secrets, health tracked', async () => {
  const h = await harness();
  const a = await h.registry.add(h.owner, { type: 'fake', name: 'acme', secrets: { botToken: 'xoxb-AAA' } });
  const b = await h.registry.add(h.owner, { type: 'fake', name: 'globex', secrets: { botToken: 'xoxb-BBB' } });
  assert.notEqual(a.id, b.id);
  assert.deepEqual(a.secrets, { botToken: true });
  const raw = await h.store.connector(a.id);
  assert.equal(JSON.stringify(raw).includes('xoxb-AAA'), false, 'no plaintext secret in the connector row');
  assert.equal(await h.contexts[0]!.secret('botToken'), 'xoxb-AAA');
  assert.equal(await h.contexts[1]!.secret('botToken'), 'xoxb-BBB');
  await assert.rejects(h.registry.add(h.owner, { type: 'fake', name: 'acme' }), /already exists/);
  await assert.rejects(h.registry.add(h.owner, { type: 'fake', name: 'x', config: { botToken: 'leak' } as never }), /Unknown config key|looks like a secret/);
  await assert.rejects(h.registry.add(h.owner, { type: 'nope', name: 'x' }), /Unknown connector type/);
  const missing = await h.registry.add(h.owner, { type: 'fake', name: 'nokey' });
  assert.equal(missing.health?.state, 'unauth');
  assert.equal((await h.registry.list()).find(c => c.name === 'acme')?.health?.state, 'ok');
  const soon = await h.registry.add(h.owner, { type: 'discord', name: 'disc' });
  assert.equal(soon.health?.state, 'unsupported', 'coming-soon types never report success');
  assert.equal((await h.registry.test('disc')).ok, false);
  await h.registry.remove(h.owner, 'globex');
  assert.equal(await h.store.secret(`connector:${b.id}:botToken`), null, 'removing a connector deletes its secrets');
  await h.registry.stopAll();
});

test('inbound: routed to a task, reply posted to the same thread, events and attribution recorded; follow-ups continue the chat', async () => {
  const h = await harness();
  const c = await h.registry.add(h.owner, { type: 'fake', name: 'acme', secrets: { botToken: 't' } });
  await h.registry.addRule(h.owner, 'acme', { match: { channel: '#support' }, action: { projectId: 'p-support', mode: 'task' } });
  await h.registry.inbound(c.id, msg());
  assert.equal(h.turns[0]?.kind, 'task');
  assert.equal(h.turns[0]?.actor, `connector:${c.id}`, 'unlinked senders are attributed to the connector');
  assert.deepEqual(h.sent.map(s => [s.conversation.threadId, s.text]), [['m1', 'Done: the build is green.']]);
  await h.registry.inbound(c.id, msg({ messageId: 'm2', text: 'and the docs?', mentioned: false }));
  assert.equal(h.turns[1]?.kind, 'reply');
  assert.equal(h.turns[1]?.chatId, 'task-chat-1', 'a reply in the thread continues the same Muster chat');
  const events = await h.store.connectorEvents(c.id, 50);
  assert.ok(events.some(e => e.status === 'routed' && e.chatId === 'task-chat-1'));
  assert.ok(events.some(e => e.direction === 'out' && e.status === 'replied'));
  await h.registry.stopAll();
});

test('refusals are posted back, never silent: guests, unrouted channels, unlinked senders, viewers, unmentioned noise ignored', async () => {
  const h = await harness();
  const c = await h.registry.add(h.owner, { type: 'fake', name: 'acme', secrets: { botToken: 't' }, config: { requireLink: true } });
  await h.registry.inbound(c.id, msg({ guest: true }));
  assert.match(h.sent.at(-1)!.text, /guest accounts/);
  await h.registry.inbound(c.id, msg({ messageId: 'm3' }));
  assert.match(h.sent.at(-1)!.text, /only answers linked Muster accounts/);
  const { token } = await h.accounts.createInvite(h.owner, { role: 'viewer' });
  const vic = await h.accounts.acceptInvite(token, { username: 'vic', password: 'correct horse battery' });
  await h.registry.link(h.owner, 'acme', 'U1', 'vic');
  await h.registry.inbound(c.id, msg({ messageId: 'm4' }));
  assert.match(h.sent.at(-1)!.text, /No Muster project is routed/);
  await h.registry.addRule(h.owner, 'acme', { match: {}, action: { projectId: 'p-general', mode: 'reply' } });
  await h.registry.inbound(c.id, msg({ messageId: 'm5' }));
  assert.match(h.sent.at(-1)!.text, /read-only/);
  await h.accounts.revokeUser(h.owner, vic.id);
  await h.registry.inbound(c.id, msg({ messageId: 'm6' }));
  assert.match(h.sent.at(-1)!.text, /access was revoked/);
  const before = h.sent.length;
  await h.registry.inbound(c.id, msg({ messageId: 'm7', mentioned: false, conversation: { kind: 'channel', id: 'C9', threadId: 'm7' } }));
  assert.equal(h.sent.length, before, 'channel chatter without a mention is ignored');
  assert.equal(h.turns.length, 0, 'no refused message started a turn');
  assert.ok((await h.store.iterateAudit()).filter(a => a.action === 'connector.refused').length >= 5);
  await h.registry.stopAll();
});

test('linked members need write access to the routed project; admins and project editors get through', async () => {
  const h = await harness();
  const c = await h.registry.add(h.owner, { type: 'fake', name: 'acme', secrets: { botToken: 't' } });
  await h.registry.addRule(h.owner, 'acme', { match: {}, action: { projectId: 'p-general', mode: 'reply' } });
  const { token } = await h.accounts.createInvite(h.owner, { role: 'member' });
  const mel = await h.accounts.acceptInvite(token, { username: 'mel', password: 'correct horse battery' });
  await h.registry.link(h.owner, 'acme', 'U1', 'mel');
  await h.registry.inbound(c.id, msg());
  assert.match(h.sent.at(-1)!.text, /do not have write access/);
  await h.store.setProjectAccess({ projectId: 'p-general', userId: mel.id, role: 'editor', memberId: null, grantedBy: h.owner.id, createdAt: '' });
  await h.registry.inbound(c.id, msg({ messageId: 'm9', conversation: { kind: 'channel', id: 'C1', name: '#support', threadId: 'm9' } }));
  assert.equal(h.turns.at(-1)?.actor, mel.id, 'a linked sender’s turn is attributed to their Muster account');
  await assert.rejects(h.registry.addRule(h.owner, 'acme', { match: {}, action: { projectId: 'p-missing', mode: 'reply' } }), /No project/);
  await h.registry.stopAll();
});

test('gateway.json import: one connector per configured channel, secrets moved into the encrypted store', async () => {
  const h = await harness();
  const dir = mkdtempSync(join(tmpdir(), 'gw-'));
  try {
    const file = join(dir, 'gateway.json');
    writeFileSync(file, JSON.stringify({ token: 'gateway-bearer', telegram: { botToken: '123:abc', secretToken: 'tg-secret' }, slack: { botToken: 'xoxb-1', appToken: 'xapp-1', mode: 'socket' }, discord: { botToken: 'disc' } }));
    const dry = await h.registry.importGateway(h.owner, file, { dryRun: true });
    assert.equal(dry.length, 3);
    assert.equal((await h.store.listConnectors()).length, 0, 'dry run writes nothing');
    const result = await h.registry.importGateway(h.owner, file);
    assert.deepEqual(result.map(r => [r.type, r.name, r.status]), [['telegram', 'default-telegram', 'imported'], ['slack', 'default-slack', 'imported'], ['discord', 'default-discord', 'coming-soon']]);
    const list = await h.store.listConnectors();
    assert.equal(list.find(c => c.type === 'telegram')?.mode, 'webhook');
    assert.equal(JSON.stringify(list).includes('xoxb-1'), false);
    const again = await h.registry.importGateway(h.owner, file);
    assert.equal(again[0]!.name, 'default-telegram-2', 'importing twice never overwrites');
  } finally { await h.registry.stopAll(); rmSync(dir, { recursive: true, force: true }); }
});
