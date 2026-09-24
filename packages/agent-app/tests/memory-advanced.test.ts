import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AgentStore } from '../src/runtime/store.ts';
import { createDomainHooks } from '../src/runtime/domains/hooks.ts';
import { createMemoryDomainWith, type MemoryDomainOptions } from '../src/runtime/domains/memory.ts';
import type { DomainContext } from '../src/runtime/domains/types.ts';
import type { AgentEvent, MemoryEntry } from '../src/shared/protocol.ts';
import type { HindsightClientLike } from '../src/runtime/hindsight-service.ts';

const core = {
  HindsightClient: class { constructor(_config: unknown) {} },
  HindsightConfigError: class extends Error {},
  resolveHindsightConfig: (env: Record<string, string | undefined> = {}) => {
    const baseUrl = env.HINDSIGHT_API_URL?.replace(/\/+$/, '');
    if (!baseUrl) throw new Error('Hindsight is not configured.');
    return { baseUrl, apiKey: env.HINDSIGHT_API_KEY, timeoutMs: 1_000, maxResponseBytes: 1_000_000, maxRequestBytes: 1_000_000 };
  },
  hindsightBankId: (scope: { kind: string; id: string }) => `bank-${scope.kind}-${scope.id}`,
} as unknown as NonNullable<MemoryDomainOptions['core']>;

async function fixture(t: TestContext, options: { client?: Partial<HindsightClientLike>; env?: Record<string, string | undefined>; fetch?: typeof fetch } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-memory-advanced-'));
  const store = new AgentStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const folder = store.addFolder(dataDir, 'Project folder');
  const entries: MemoryEntry[] = [];
  const events: AgentEvent[] = [];
  const runtime = createDomainHooks();
  const context: DomainContext = {
    dataDir, store, db: () => store.database(), emit: event => { events.push(event); }, emitSnapshot() {},
    folderFor: id => { const found = store.folder(id); if (!found) throw new Error('Folder does not exist.'); return found; },
    invoke: (async (command: string, input: Record<string, unknown>) => {
      if (command === 'memory.list') return entries.filter(entry => entry.scopes.some(scope => input.folderId ? scope.id === input.folderId : scope.kind === 'user'));
      if (command === 'memory.add') {
        const entry: MemoryEntry = { id: `mem_${entries.length + 1}`, kind: String(input.kind), summary: String(input.summary), observedAt: new Date().toISOString(), confidence: 1, provenance: input.provenance as string[], scopes: input.scopes as MemoryEntry['scopes'], redactionState: 'none' };
        entries.push(entry); return entry;
      }
      throw new Error(`unexpected ${command}`);
    }) as DomainContext['invoke'],
    hooks: runtime.hooks,
  };
  const client: HindsightClientLike = {
    retain: async input => ({ bankId: 'bank', success: true, itemsCount: input.items.length, isAsync: false }),
    recall: async () => ({ bankId: 'bank', results: [] }),
    reflect: async () => ({ bankId: 'bank', text: 'answer' }),
    ...options.client,
  } as HindsightClientLike;
  const domain = createMemoryDomainWith({ env: options.env ?? { HINDSIGHT_API_URL: 'http://memory.local' }, core, createClient: () => client, fetch: options.fetch })(context);
  t.after(() => domain.dispose?.());
  const call = async (command: string, input: Record<string, unknown> = {}): Promise<any> => domain.handlers[command]!(input);
  return { dataDir, store, folder, entries, call };
}

test('MEM-06: capability negotiation gates advanced features on the reported engine version', async t => {
  // No version endpoint at all: every advanced capability is unsupported, with a "requires" hint.
  const unreachable = await fixture(t, { fetch: (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch });
  const noVersion = await unreachable.call('memory.engine', {});
  assert.equal(noVersion.baseline, '0.10.0');
  assert.equal(noVersion.capabilities.mentalModels.supported, false);
  assert.match(noVersion.capabilities.mentalModels.requires, /0\.10\.0/);

  // An old engine below the baseline: still unsupported, with an explicit reason naming the version gap.
  const old = await fixture(t, { fetch: (async () => new Response(JSON.stringify({ version: '0.9.2' }), { status: 200 })) as typeof fetch });
  const oldView = await old.call('memory.engine', {});
  assert.equal(oldView.version, '0.9.2');
  assert.equal(oldView.capabilities.observations.supported, false);
  assert.match(oldView.error ?? '', /0\.9\.2/);

  // At or above the baseline: every advanced capability opens up.
  const modern = await fixture(t, { fetch: (async () => new Response(JSON.stringify({ version: '0.11.0' }), { status: 200 })) as typeof fetch });
  const modernView = await modern.call('memory.engine', {});
  assert.equal(modernView.capabilities.observations.supported, true);
  assert.equal(modernView.capabilities.bankAdmin.supported, true);
  assert.equal(modernView.error, undefined);

  // A server that names its own capability list wins over the version comparison.
  const partial = await fixture(t, { fetch: (async () => new Response(JSON.stringify({ version: '0.11.0', capabilities: ['observations'] }), { status: 200 })) as typeof fetch });
  const partialView = await partial.call('memory.engine', {});
  assert.equal(partialView.capabilities.observations.supported, true);
  assert.equal(partialView.capabilities.mentalModels.supported, false);
});

test('MEM-15: export writes a manifest with the scope, part counts and file hash, and archives list it', async t => {
  const f = await fixture(t, { env: {} }); // Hindsight not configured: export stays purely local.
  await f.call('memory.rememberText', { folderId: f.folder.id, text: 'Ship on Tuesdays', kind: 'preference' });
  await f.call('memory.rememberText', { folderId: f.folder.id, text: 'Staging needs a feature flag', kind: 'fact' });
  await f.call('memory.directives.save', { folderId: f.folder.id, directive: { kind: 'directive', text: 'Always run tests before merging', priority: 5, tags: ['ci'], enabled: true } });

  const exported = await f.call('memory.export', { folderId: f.folder.id, parts: ['facts', 'directives'] });
  assert.equal(exported.job.status, 'completed');
  const manifest = exported.archive.manifest;
  assert.equal(manifest.format, 'muster-memory-export');
  assert.deepEqual(manifest.parts, ['facts', 'directives']);
  assert.equal(manifest.counts.facts, 2);
  assert.equal(manifest.counts.directives, 1);
  assert.equal(manifest.counts.observations, 0);
  assert.deepEqual(manifest.scope, { kind: 'workspace', id: f.folder.id, label: 'Project folder' });

  const { readFileSync } = await import('node:fs');
  const jsonl = readFileSync(exported.archive.path, 'utf8');
  assert.equal(createHash('sha256').update(jsonl).digest('hex'), manifest.file.sha256);
  assert.equal(manifest.file.lines, jsonl.split('\n').filter(Boolean).length);

  const archives = await f.call('memory.archives', {});
  assert.ok(archives.archives.some((archive: { id: string }) => archive.id === exported.archive.id));

  const preview = await f.call('memory.import.preview', { folderId: f.folder.id, archiveId: exported.archive.id });
  assert.equal(preview.duplicates, 3, 'the 2 facts and 1 directive already in this scope come back as duplicates');
  assert.equal(preview.importable.facts, 0);
  assert.equal(preview.importable.directives, 0);
});

test('MEM-14: consolidate is a durable job keyed by operationId, and a resubmit does not re-run it', async t => {
  const f = await fixture(t, { env: {} });
  await f.call('memory.rememberText', { folderId: f.folder.id, text: 'Uses PostgreSQL 16', kind: 'fact' });
  await f.call('memory.rememberText', { folderId: f.folder.id, text: 'Runs on Fly.io', kind: 'fact' });
  const first = await f.call('memory.consolidate', { folderId: f.folder.id, operationId: 'op-1' });
  assert.equal(first.status, 'completed');
  assert.equal(first.result.made, 1);
  const second = await f.call('memory.consolidate', { folderId: f.folder.id, operationId: 'op-1' });
  assert.equal(second.id, first.id, 'the same operationId returns the recorded job instead of consolidating twice');
  const { observations, facts } = await f.call('memory.observations', { folderId: f.folder.id });
  assert.equal(observations.length, 1);
  assert.equal(facts.length, 2);
  assert.equal(observations[0].sources.length, 2);
});

test('MEM-11: an after-consolidation mental model goes stale only once a newer consolidation has run', async t => {
  const f = await fixture(t, { env: {} });
  await f.call('memory.rememberText', { folderId: f.folder.id, text: 'Uses PostgreSQL 16', kind: 'fact' });
  await f.call('memory.rememberText', { folderId: f.folder.id, text: 'Runs on Fly.io', kind: 'fact' });
  const model = await f.call('memory.models.save', { folderId: f.folder.id, name: 'Stack', query: 'What does this run on?', refresh: 'after-consolidation' });
  assert.equal(model.stale, false, 'nothing has consolidated yet, so a fresh model is not stale');
  await f.call('memory.consolidate', { folderId: f.folder.id, operationId: 'op-1' });
  const { models } = await f.call('memory.models.list', { folderId: f.folder.id });
  assert.equal(models[0].stale, true, 'a consolidation ran after the model was last refreshed');
  const refreshed = await f.call('memory.models.refresh', { folderId: f.folder.id, id: model.id });
  assert.equal(refreshed.stale, false, 'refreshing catches it back up to the latest consolidation');
});

test('MEM-15: exported observations are named in the import preview instead of silently vanishing', async t => {
  const f = await fixture(t, { env: {} });
  await f.call('memory.rememberText', { folderId: f.folder.id, text: 'Uses PostgreSQL 16', kind: 'fact' });
  await f.call('memory.rememberText', { folderId: f.folder.id, text: 'Runs on Fly.io', kind: 'fact' });
  await f.call('memory.consolidate', { folderId: f.folder.id, operationId: 'op-1' });
  const exported = await f.call('memory.export', { folderId: f.folder.id, parts: ['observations'] });
  assert.equal(exported.archive.manifest.counts.observations, 1);
  const preview = await f.call('memory.import.preview', { folderId: f.folder.id, archiveId: exported.archive.id });
  assert.deepEqual(preview.importable, { facts: 0, models: 0, directives: 0 }, 'observations are derived, not re-importable as their own kind');
  assert.equal(preview.duplicates, 0);
  assert.ok(preview.skipped.some((line: string) => line.includes('1 observation')), 'the preview says the observation will not be imported rather than staying silent');
});

test('MEM-14: correcting a local fact tombstones the old copy and records a new one with provenance', async t => {
  const f = await fixture(t, { env: {} });
  const saved = await f.call('memory.rememberText', { folderId: f.folder.id, text: 'Uses Node 18', kind: 'fact' });
  const oldId = saved.local.id;
  const corrected = await f.call('memory.correct', { folderId: f.folder.id, id: oldId, source: 'local', text: 'Uses Node 20', kind: 'fact' });
  assert.equal(corrected.local.text, 'Uses Node 20');
  assert.notEqual(corrected.local.id, oldId, 'a correction is a new record, not an in-place edit');
  assert.match(corrected.local.provenance.join(' '), new RegExp(`corrects local:${oldId}`));
  const browsed = await f.call('memory.browse', { folderId: f.folder.id });
  assert.ok(!browsed.records.some((record: { id: string }) => record.id === oldId), 'the corrected fact stops being recalled');
  assert.ok(browsed.records.some((record: { text: string }) => record.text === 'Uses Node 20'));
  await assert.rejects(f.call('memory.correct', { folderId: f.folder.id, id: oldId, source: 'local', text: 'x' }), /already deleted/);
});

test('PRJ-X5: sharing a memory to a Project makes it recallable from the Project bank', async t => {
  const f = await fixture(t, { env: {} });
  const project = f.store.createProject('Rollout', 'Ship the new pricing page', [f.folder.id]);
  const result = await f.call('memory.share', { projectId: project.id, text: 'Pricing page ships behind a flag', kind: 'fact', provenance: ['design review'], sourceId: 'mem_1' });
  assert.equal(result.local.scope.kind, 'project');
  assert.equal(result.local.scope.id, project.id);
  const browsed = await f.call('memory.browse', { folderId: `project:${project.id}` });
  assert.equal(browsed.records.length, 1);
  assert.match(browsed.records[0].provenance.join(' '), /shared:mem_1/);
  await assert.rejects(f.call('memory.share', { projectId: 'missing', text: 'x', kind: 'fact', provenance: [], sourceId: 's' }), /Project does not exist/);
});

test('MEM-08/MEM-15: secrets are masked before local memory, Hindsight retain and export', async t => {
  const retained: string[] = [];
  const f = await fixture(t, { client: { retain: async input => { retained.push(...input.items.map(item => item.content)); return { bankId: 'bank', success: true, itemsCount: input.items.length, isAsync: false }; } } });
  const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  await f.call('memory.rememberText', { folderId: f.folder.id, text: `Deploy uses ${token} and commit 58375eb`, kind: 'fact' });
  assert.ok(!f.entries[0]!.summary.includes(token), 'local memory never stores the token');
  assert.match(f.entries[0]!.summary, /commit 58375eb/, 'ordinary text survives');
  assert.ok(retained.length === 1 && !retained[0]!.includes(token), 'Hindsight retain gets the masked text');

  // A note saved before redaction existed is still masked on export.
  f.entries.push({ ...f.entries[0]!, id: 'legacy', summary: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' });
  const exported = await f.call('memory.export', { folderId: f.folder.id, parts: ['facts'] });
  const { readFileSync } = await import('node:fs');
  const jsonl = readFileSync(exported.archive.path, 'utf8');
  assert.ok(!jsonl.includes('wJalrXUtnFEMI') && !jsonl.includes(token));
  assert.match(jsonl, /AWS_SECRET_ACCESS_KEY=\[redacted\]/);
});

test('MEM-15: import duplicate checks compare secret-masked text on both sides', async t => {
  const f = await fixture(t, { env: {} });
  const token = 'ghp_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2';
  // A legacy local note holding the raw token; its export is masked, so the archive and the store differ byte-wise.
  f.entries.push({ id: 'legacy', kind: 'fact', summary: `Deploy uses ${token}`, observedAt: new Date().toISOString(), confidence: 1, provenance: [], scopes: [{ kind: 'workspace', id: f.folder.id }], redactionState: 'none' });
  const exported = await f.call('memory.export', { folderId: f.folder.id, parts: ['facts'] });
  const preview = await f.call('memory.import.preview', { folderId: f.folder.id, archiveId: exported.archive.id });
  assert.equal(preview.duplicates, 1, 'the masked archive line matches the raw note once both are masked');
  const applied = await f.call('memory.import.apply', { folderId: f.folder.id, archiveId: exported.archive.id, operationId: 'op-1', skipDuplicates: true });
  assert.equal(applied.imported.facts, 0);
});
