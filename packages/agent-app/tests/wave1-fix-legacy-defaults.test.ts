/** Review fix: projects that existed before the update keep the old run behaviour; new ones start with the stronger policy. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { looksLikePlan } from '../src/runtime/governance/liveness.ts';
import { createAgentService } from '../src/runtime/service.ts';
import type { ProviderAdapter } from '../src/runtime/provider.ts';
import { DEFAULT_GOVERNANCE, LEGACY_GOVERNANCE } from '../src/shared/domains/project-governance-protocol.ts';
import { wave1 } from './wave1-harness.ts';

test('a message that asks you something is not a plan', () => {
  assert.equal(looksLikePlan('I will need your API key to continue. Which key should I use?'), false);
  assert.equal(looksLikePlan('I\'ll start once you confirm: should I use Postgres?'), false);
  assert.equal(looksLikePlan('Could you tell me which branch to use'), false);
  assert.equal(looksLikePlan('Plan: first I will read the code, then I will add the note file.'), true);
});

test('after an update, an existing project has no comment backstop, continuations, retries or budget stop; a project created afterwards has all of them', async t => {
  const h = await wave1(t);
  const old = h.project.id;
  await h.s.invoke('project.team.settings', { projectId: old }); // the projects domain is in use
  await h.s.dispose();
  // Simulate 0.2.x data: no governance file, no "seeded" marker.
  for (const f of ['muster-project-governance.sqlite', 'muster-project-governance.sqlite-wal', 'muster-project-governance.sqlite-shm']) rmSync(join(h.dataDir, f), { force: true });
  const app = new DatabaseSync(join(h.dataDir, 'muster-agent.sqlite')); app.prepare("DELETE FROM meta WHERE key = 'governance_seeded'").run(); app.close();
  const provider: ProviderAdapter = { info: () => [{ id: 'scripted', name: 'S', available: true, identityMasked: 'configured', models: [{ id: 'scripted-model', name: 'S' }] }], stop: async () => true, dispose() {}, async run() { return { status: 'completed', finalMessage: '', dispatchState: 'dispatched' }; } };
  const s2 = createAgentService({ dataDir: h.dataDir, provider, onEvent() {} });
  t.after(() => s2.dispose());
  const legacy = await s2.invoke('project.gov.state', { projectId: old });
  assert.deepEqual(legacy.settings, LEGACY_GOVERNANCE);
  const folder = (await s2.invoke('app.snapshot', undefined)).folders[0]!;
  const fresh = await s2.invoke('project.create', { name: 'Brand new', goal: '', folderIds: [folder.id] });
  assert.deepEqual((await s2.invoke('project.gov.state', { projectId: fresh.id })).settings, DEFAULT_GOVERNANCE);
  // An empty-reply run in the old project is left alone: no continuation, no comment request.
  const task = await s2.invoke('project.tasks.add', { projectId: old, title: 'Empty reply', acceptance: '', dependencies: [] });
  const run = await s2.invoke('project.tasks.dispatch', { projectId: old, id: task.id, revision: task.revision });
  await new Promise(r => setTimeout(r, 600));
  const timeline = (await s2.invoke('chat.timeline', { id: run.chatId })).items.filter(i => i.kind === 'user');
  assert.equal(timeline.length, 1, 'one prompt only: nothing was asked a second time');
});
