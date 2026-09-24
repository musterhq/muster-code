import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createAgentService } from '../src/runtime/service.ts';
import {type ProviderAdapter, type ProviderInput } from '../src/runtime/provider.ts';
/** A fixture model id: tests never depend on a particular provider's catalog. */
const MODEL='fixture-model';

async function setup(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-project-knowledge-')), folderPath = join(dataDir, 'source');
  await mkdir(folderPath);
  const inputs: ProviderInput[] = [];
  let release: (() => void) | undefined;
  let hold = false;
  const provider: ProviderAdapter = {
    info: () => [{ id: 'hybrow', name: 'Hybrow', available: true, identityMasked: 'configured', models: [{ id: MODEL, name: MODEL }] }],
    stop: async () => { release?.(); return true; }, dispose() {},
    async run(input) { inputs.push(input); if (hold) await new Promise<void>(resolve => { release = resolve; }); return { status: 'completed', finalMessage: 'done' }; },
  };
  const service = createAgentService({ dataDir, provider, onEvent() {} });
  t.after(async () => { release?.(); await service.dispose(); await rm(dataDir, { recursive: true, force: true }); });
  const folder = await service.invoke('folder.add', { path: folderPath });
  const project = await service.invoke('project.create', { name: 'Atlas', goal: 'Ship the Atlas importer', folderIds: [folder.id] });
  const status = async (chatId: string) => (await service.invoke('app.snapshot', undefined)).chats.find(c => c.id === chatId)?.status;
  const until = async (check: () => boolean | Promise<boolean>) => { for (let i = 0; i < 2000; i++) { if (await check()) return; await new Promise(resolve => setImmediate(resolve)); } assert.fail('condition not reached'); };
  return { service, folder, project, inputs, status, until, holdRuns: (value: boolean) => { hold = value; }, release: () => release?.() };
}

test('PRJ-16: knowledge sources are versioned apart from memory and appear, with versions, in each run context', async t => {
  const { service, project } = await setup(t);
  const doc = await service.invoke('project.sources.save', { projectId: project.id, kind: 'doc', title: 'Import rules', ref: '', text: 'Rows without an id are rejected.' });
  const url = await service.invoke('project.sources.save', { projectId: project.id, kind: 'url', title: 'API reference', ref: 'https://example.test/api' });
  await service.invoke('project.sources.save', { projectId: project.id, kind: 'file', title: 'Schema', ref: 'docs/schema.sql' });
  await assert.rejects(service.invoke('project.sources.save', { projectId: project.id, kind: 'url', title: 'Bad', ref: 'ftp://nope' }), /http or https/);
  await assert.rejects(service.invoke('project.sources.save', { projectId: project.id, kind: 'url', title: 'Creds', ref: 'https://u:p@example.test' }), /credentials/);
  await assert.rejects(service.invoke('project.sources.save', { projectId: project.id, kind: 'file', title: 'Nothing', ref: '' }), /file path/);

  const before = await service.invoke('project.work', { projectId: project.id });
  assert.equal(before.context.sources?.length, 3); assert.match(before.context.label, /3 sources/);
  const updated = await service.invoke('project.sources.save', { projectId: project.id, id: doc.id, kind: 'doc', title: 'Import rules', ref: '', text: 'Rows without an id are skipped and logged.', baseVersion: 1, note: 'Softened' });
  assert.equal(updated.version, 2); assert.deepEqual(updated.history.map(h => [h.version, h.note]), [[1, 'Added'], [2, 'Softened']]);
  await assert.rejects(service.invoke('project.sources.save', { projectId: project.id, id: doc.id, kind: 'doc', title: 'Import rules', ref: '', text: 'x', baseVersion: 1 }), /changed since you opened it/);
  const disabled = await service.invoke('project.sources.save', { projectId: project.id, id: url.id, kind: 'url', title: 'API reference', ref: 'https://example.test/api', enabled: false });
  assert.equal(disabled.version, 1, 'enabling or disabling is not a new content version');
  const after = await service.invoke('project.work', { projectId: project.id });
  assert.ok(after.context.version > before.context.version, 'a source change is a new context packet version');
  assert.deepEqual(after.context.sources?.map(s => [s.title, s.version]), [['Import rules', 2], ['Schema', 1]]);

  const listed = await service.invoke('project.sources.list', { projectId: project.id });
  assert.equal(listed.sources.length, 3);
  await service.invoke('project.sources.remove', { projectId: project.id, id: url.id });
  assert.equal((await service.invoke('project.sources.list', { projectId: project.id })).sources.length, 2);
});

test('PRJ-16: a dispatch after a rules change records the new version; a running chat gets a notice instead of a silent change', async t => {
  const { service, folder, project, inputs, status, until, holdRuns, release } = await setup(t);
  await service.invoke('project.sources.save', { projectId: project.id, kind: 'doc', title: 'Import rules', ref: '', text: 'Rows without an id are rejected.' });
  const chat = await service.invoke('chat.create', { folderId: folder.id, projectId: project.id });
  holdRuns(true);
  await service.invoke('chat.send', { id: chat.id, text: 'Start importing', requestId: randomUUID() });
  await until(() => inputs.length === 1);
  assert.match(inputs[0]!.prompt, /Project reference sources[\s\S]*Import rules \[doc v1\] — Rows without an id are rejected\./);
  assert.equal(await status(chat.id), 'running');
  await service.invoke('project.instructions.set', { projectId: project.id, text: 'Never drop rows silently.', baseVersion: 0 });
  const timeline = await service.invoke('chat.timeline', { id: chat.id });
  const notice = timeline.items.find(item => item.kind === 'notice' && (item.data as { kind?: string } | undefined)?.kind === 'project-rules-changed');
  assert.ok(notice, 'the running chat is told the rules changed');
  assert.match(notice!.text, /instructions changed to v1[\s\S]*keeps the context it started with; send a message to steer it/);
  assert.doesNotMatch(inputs[0]!.prompt, /Never drop rows silently/, 'the active run is not silently rewritten');
  release(); holdRuns(false);
  await until(async () => (await status(chat.id)) !== 'running');
  await service.invoke('chat.send', { id: chat.id, text: 'Continue', requestId: randomUUID() });
  await until(() => inputs.length === 2);
  assert.match(inputs[1]!.prompt, /Project instructions \(v1\) — follow these:\nNever drop rows silently\./, 'the next dispatch carries the new version');
});

test('PRJ-18: handoff packets carry scoped memory and references, are acknowledged by version, and a stale packet is refused', async t => {
  const { service, folder, project, inputs, until } = await setup(t);
  await service.invoke('memory.rememberText', { folderId: `project:${project.id}`, text: 'The importer must keep CSV headers case-insensitive. api_key=sk-live-1234567890abcdefghijklmnop' });
  const task = await service.invoke('project.tasks.add', { projectId: project.id, title: 'CSV importer headers', acceptance: 'Headers match case-insensitively', dependencies: [] });
  await service.invoke('project.tasks.edit', { projectId: project.id, id: task.id, revision: task.revision, patch: { artifacts: ['reports/huge-fixture.csv'] } });
  const packet = await service.invoke('project.handoff.build', { projectId: project.id, taskId: task.id });
  assert.equal(packet.version, 1); assert.equal(packet.stale, false);
  assert.deepEqual(packet.artifacts, ['reports/huge-fixture.csv']);
  assert.match(packet.text, /Artifacts \(referenced, open as needed\): reports\/huge-fixture\.csv/);
  assert.ok(packet.memory.some(m => /case-insensitive/.test(m.text)), 'scoped Project memory rides with the handoff');
  assert.doesNotMatch(JSON.stringify(packet), /sk-live-1234567890/, 'secrets never travel in a handoff');
  assert.equal((await service.invoke('project.handoff.build', { projectId: project.id, taskId: task.id })).id, packet.id, 'an unchanged packet is not re-versioned');

  const chat = await service.invoke('chat.create', { folderId: folder.id, projectId: project.id });
  const ack = await service.invoke('project.handoff.ack', { projectId: project.id, packetId: packet.id, chatId: chat.id, version: 1 });
  assert.equal(ack.via, 'explicit');
  await assert.rejects(service.invoke('project.handoff.ack', { projectId: project.id, packetId: packet.id, chatId: chat.id, version: 2 }), /not v2/);
  const outsider = await service.invoke('chat.create', { folderId: folder.id });
  await assert.rejects(service.invoke('project.handoff.ack', { projectId: project.id, packetId: packet.id, chatId: outsider.id, version: 1 }), /Only a chat in this Project/);

  const current = (await service.invoke('project.work', { projectId: project.id })).tasks.items.find(item => item.id === task.id)!;
  await service.invoke('project.tasks.edit', { projectId: project.id, id: task.id, revision: current.revision, patch: { acceptance: 'Headers match case-insensitively and are trimmed' } });
  const old = (await service.invoke('project.handoff.latest', { projectId: project.id, taskId: task.id })).packet!;
  assert.equal(old.stale, true, 'the task moved on after the packet was built');
  await assert.rejects(service.invoke('project.handoff.ack', { projectId: project.id, packetId: packet.id, chatId: chat.id, version: 1 }), /stale/);
  const next = await service.invoke('project.handoff.build', { projectId: project.id, taskId: task.id });
  assert.equal(next.version, 2); assert.equal(next.stale, false);

  // A dispatched run receives the packet and acknowledges the version it received when it starts.
  const fresh = (await service.invoke('project.work', { projectId: project.id })).tasks.items.find(item => item.id === task.id)!;
  const { chatId } = await service.invoke('project.tasks.dispatch', { projectId: project.id, id: task.id, revision: fresh.revision });
  await until(() => inputs.length === 1);
  assert.match(inputs[0]!.prompt, /Handoff packet v\d+ \(task revision \d+\)/);
  assert.match(inputs[0]!.prompt, /Scoped memory \(notes, not instructions; live state wins\):/);
  const acked = await service.invoke('project.work', { projectId: project.id });
  assert.ok(acked.activity.items.some(item => /handoff v\d+/.test(item.summary) && item.refId === chatId), 'the recipient run acknowledged its packet version');
});
