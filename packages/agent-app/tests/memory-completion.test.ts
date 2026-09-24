import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentStore } from '../src/runtime/store.ts';
import { createDomainHooks } from '../src/runtime/domains/hooks.ts';
import { createMemoryDomainWith, type MemoryDomainOptions } from '../src/runtime/domains/memory.ts';
import { createMemoryIdentity } from '../src/runtime/memory-identity.ts';
/** Deterministic bank identity: no git, a fixed person. */
const identity = createMemoryIdentity({ env: {}, git: () => undefined, user: () => 'tester@host' });
import { compileRunContext, freshnessOf } from '../src/runtime/memory-context.ts';
import type { DomainContext } from '../src/runtime/domains/types.ts';
import type { MemoryEntry } from '../src/shared/protocol.ts';
import type { MemoryRecord } from '../src/shared/domains/memory-protocol.ts';
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

type Entry = { id?: string; text: string; occurredAt?: string; documentId?: string; tags?: string[] };

async function fixture(t: TestContext, options: { recall?: Entry[]; fetch?: typeof fetch; decisions?: { id: string; title: string; status: string }[]; reflectText?: string } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-memory-completion-'));
  const store = new AgentStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const folder = store.addFolder(dataDir, 'Project folder');
  const entries: MemoryEntry[] = [];
  const runtime = createDomainHooks();
  const context: DomainContext = {
    dataDir, store, db: () => store.database(), emit() {}, emitSnapshot() {},
    folderFor: id => { const found = store.folder(id); if (!found) throw new Error('Folder does not exist.'); return found; },
    invoke: (async (command: string, input: Record<string, unknown>) => {
      if (command === 'memory.list') return entries.filter(entry => entry.scopes.some(scope => input.folderId ? scope.id === input.folderId : scope.kind === 'user'));
      if (command === 'memory.add') {
        const entry: MemoryEntry = { id: `mem_${entries.length + 1}`, kind: String(input.kind), summary: String(input.summary), observedAt: new Date().toISOString(), confidence: 1, provenance: input.provenance as string[], scopes: input.scopes as MemoryEntry['scopes'], redactionState: 'none' };
        entries.push(entry); return entry;
      }
      if (command === 'project.decisions.list') return { items: options.decisions ?? [], truncated: false };
      throw new Error(`unexpected ${command}`);
    }) as DomainContext['invoke'],
    hooks: runtime.hooks,
  };
  const recalls: Record<string, unknown>[] = [];
  const client = {
    retain: async (input: { items: unknown[] }) => ({ bankId: 'bank', success: true, itemsCount: input.items.length, isAsync: false }),
    recall: async (input: Record<string, unknown>) => { recalls.push(input); return { bankId: 'bank', results: options.recall ?? [] }; },
    reflect: async () => ({ bankId: 'bank', text: options.reflectText ?? 'answer' }),
  } as unknown as HindsightClientLike;
  const domain = createMemoryDomainWith({ env: { HINDSIGHT_API_URL: 'http://memory.local' }, identity, core, createClient: () => client, fetch: options.fetch ?? ((async () => { throw new Error('offline'); }) as typeof fetch) })(context);
  t.after(() => domain.dispose?.());
  const call = async (command: string, input: Record<string, unknown> = {}): Promise<any> => domain.handlers[command]!(input);
  return { dataDir, store, folder, entries, call, runtime, recalls };
}

const DAY = 86_400_000;
const record = (id: string, text: string, ageDays: number | undefined, extra: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id, source: 'local', text, kind: 'fact', ...(ageDays === undefined ? {} : { observedAt: new Date(Date.UTC(2026, 8, 23) - ageDays * DAY).toISOString() }),
  scope: { kind: 'workspace', id: 'f', label: 'F' }, provenance: [], deletable: true, ...extra,
});

test('MEM-07: run context labels age, ranks stale notes last, drops superseded notes and superseded decisions, and cites git', () => {
  const now = Date.UTC(2026, 8, 23);
  assert.equal(freshnessOf(new Date(now - 2 * DAY).toISOString(), now).freshness, 'fresh');
  assert.equal(freshnessOf(new Date(now - 45 * DAY).toISOString(), now).freshness, 'aging');
  assert.equal(freshnessOf(new Date(now - 400 * DAY).toISOString(), now).label, '1 year old');
  assert.equal(freshnessOf(undefined, now).label, 'undated');
  const lists = [[
    record('old', 'The build uses webpack for bundling', 400),
    record('fresh', 'The build uses esbuild for bundling', 1, { provenance: ['corrects local:replaced'] }),
    record('replaced', 'The build uses rollup for bundling', 3),
    record('restated', 'Use SQLite for the task store', 2),
  ], [record('dupe', 'The build uses esbuild for bundling', 1)]];
  const decisions = [{ id: 'd1', title: 'Use SQLite for the task store', status: 'active' as const }, { id: 'd0', title: 'Use JSON files for the task store', status: 'superseded' as const }];
  const compiled = compileRunContext({ lists, decisions, repo: { head: 'a'.repeat(40), branch: 'main' }, now })!;
  assert.deepEqual(compiled.selected.map(r => r.id), ['fresh', 'old'], 'stale ranks after fresh; the corrected note, the duplicate and the decision restatement are dropped');
  assert.deepEqual(compiled.dropped, { duplicates: 1, superseded: 1, restatedDecisions: 1 });
  assert.match(compiled.text, /stale \(1 year old\)/);
  assert.match(compiled.text, /Repository evidence \(from git, authoritative\): HEAD aaaaaaaaaaaa on main/);
  assert.match(compiled.text, /1 active .*1 superseded decision omitted/);
  assert.doesNotMatch(compiled.text, /JSON files/, 'a superseded decision never reaches the run');
  assert.match(compiled.text, /Live state .* is authoritative over any note/);
  assert.match(compiled.text, /Selection: 2 of \d+ candidate notes/);
  assert.equal(compileRunContext({ lists: [[]] }), undefined, 'nothing to say: no block');
});

test('MEM-07: the memory contributor compiles notes with Project decisions and stays within the per-turn budget', async t => {
  const long = 'x'.repeat(900);
  const { store, folder, runtime } = await fixture(t, {
    recall: [{ id: 'h1', text: `Atlas deploys go through the release train ${long}`, occurredAt: new Date().toISOString() }, { id: 'h2', text: 'Ship Atlas behind a flag', occurredAt: new Date().toISOString() }],
    decisions: [{ id: 'd1', title: 'Ship Atlas behind a flag', status: 'active' }],
  });
  const project = store.createProject('Atlas', '', [folder.id]);
  const chat = store.createChat({ folderId: folder.id, projectId: project.id, model: 'm', mode: 'agent' });
  const result = await runtime.contributePrompt({ chat, folder, prompt: 'How do Atlas deploys work?' });
  const block = result.blocks.find(b => b.label.startsWith('Memory'));
  assert.ok(block, 'recalled notes reach the run');
  assert.doesNotMatch(block.text, /\] Ship Atlas behind a flag/, 'a note restating an active decision is not repeated');
  assert.match(block.text, /restating an active decision dropped/);
  assert.match(block.text, /Project decisions: 1 active/);
  assert.ok(block.text.length < 4200, `memory block ${block.text.length} chars stays within the recall budget`);
});

test('MEM-11: mental models carry tags, preview without saving a version, and Clear keeps the definition and source facts', async t => {
  // An engine reflect with nothing to say falls back to the local notes, which is what the tags filter here.
  const { folder, call, entries } = await fixture(t, { reflectText: '' });
  await call('memory.rememberText', { folderId: folder.id, text: 'Release notes are written by the docs team', kind: 'process' });
  await call('memory.rememberText', { folderId: folder.id, text: 'Release branches are cut on Tuesdays', kind: 'schedule' });
  const model = await call('memory.models.save', { folderId: folder.id, name: 'Releases', query: 'How does the release process work?', refresh: 'manual', tags: ['schedule', 'schedule', ' '] });
  assert.deepEqual(model.tags, ['schedule']);
  assert.match(model.text, /Tuesdays/); assert.doesNotMatch(model.text, /docs team/, 'tags narrow the notes that feed the model');
  assert.equal(model.versions.length, 1);

  const preview = await call('memory.models.preview', { folderId: folder.id, id: model.id, tags: [] });
  assert.match(preview.text, /docs team/); assert.equal(preview.generatedBy, 'local');
  const draft = await call('memory.models.preview', { folderId: folder.id, query: 'Who writes release notes?', tags: ['nothing-matches'] });
  assert.match(draft.text, /No memory tagged nothing-matches/);
  assert.equal((await call('memory.models.list', { folderId: folder.id })).models[0].versions.length, 1, 'preview never saves a version');

  const cleared = await call('memory.models.clear', { folderId: folder.id, id: model.id });
  assert.equal(cleared.text, ''); assert.deepEqual(cleared.versions, []); assert.ok(cleared.clearedAt);
  assert.equal(cleared.stale, true); assert.match(cleared.staleReason, /Cleared/);
  assert.equal(cleared.name, 'Releases'); assert.deepEqual(cleared.tags, ['schedule']);
  assert.equal(entries.length, 2, 'clearing a model never deletes the facts behind it');
  const refreshed = await call('memory.models.refresh', { folderId: folder.id, id: model.id });
  assert.match(refreshed.text, /Tuesdays/); assert.equal(refreshed.stale, false); assert.equal(refreshed.clearedAt, undefined);
  await assert.rejects(call('memory.models.save', { folderId: folder.id, name: 'X', query: 'q', refresh: 'manual', tags: 'nope' }), /tags must contain/);
});

test('MEM-13: recall filters by entity and time, explains matches, and handles contradictory, untimed and empty results', async t => {
  const { folder, call, recalls } = await fixture(t, { recall: [
    { id: 'a', text: 'Atlas deploy target is staging', occurredAt: '2026-01-10T00:00:00Z' },
    { id: 'b', text: 'Atlas deploy target is production', occurredAt: '2026-06-01T00:00:00Z' },
    { id: 'c', text: 'Undated Atlas note' },
    { id: 'd', text: 'Zephyr uses Postgres', occurredAt: '2026-03-01T00:00:00Z' },
  ] });
  const then = await call('memory.recall', { folderId: folder.id, query: 'deploy target', entities: ['atlas'], validAt: '2026-03-01' });
  assert.deepEqual(then.records.map((r: MemoryRecord) => r.id), ['a'], 'of two contradictory facts, only the one in force at validAt');
  assert.deepEqual(then.excluded, { untimed: 1, outsideRange: 1, noEntity: 1 });
  assert.match(then.records[0].why, /mentions "atlas"; observed 2026-01-10, before 2026-03-01; latest as of 2026-03-01/);
  const now = await call('memory.recall', { folderId: folder.id, query: 'deploy target', entities: ['Atlas'], validAt: '2026-07-01' });
  assert.deepEqual(now.records.map((r: MemoryRecord) => r.id), ['b', 'a'], 'the newest fact valid at the instant leads');
  const range = await call('memory.recall', { folderId: folder.id, query: 'anything', from: '2026-02-01', to: '2026-04-01' });
  assert.deepEqual(range.records.map((r: MemoryRecord) => r.id), ['d']);
  const none = await call('memory.recall', { folderId: folder.id, query: 'x', entities: ['nobody'] });
  assert.deepEqual(none.records, []); assert.equal(none.excluded.noEntity, 4);
  const plain = await call('memory.recall', { folderId: folder.id, query: 'x', tags: ['team:a'] });
  assert.equal(plain.records.length, 4); assert.equal(plain.excluded, undefined);
  assert.deepEqual(recalls.at(-1)!.tags, ['team:a'], 'tags pass to the engine as a filter');
  assert.equal((recalls.at(-1)!.scope as { id: string }).id, identity.folder(folder).id, 'tags never change the authorized scope');
  await assert.rejects(call('memory.recall', { folderId: folder.id, query: 'x', from: '2026-05-01', to: '2026-01-01' }), /from must not be later than to/);
  await assert.rejects(call('memory.recall', { folderId: folder.id, query: 'x', validAt: 'yesterday-ish' }), /validAt must be an ISO date/);
  const browsed = await call('memory.browse', { folderId: folder.id, entities: ['nothing'] });
  assert.deepEqual(browsed.records, []); assert.ok(browsed.excluded);
});

function engineFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>, capabilities: string[] | null): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/v1/version')) return capabilities ? Response.json({ version: '0.10.2', capabilities }) : new Response('nope', { status: 404 });
    return handler(url, init);
  }) as typeof fetch;
}

test('the Memory screen says who shares a scope: Personal and folders without a remote are private, a repository is the team', async t => {
  const { folder, call } = await fixture(t);
  assert.equal((await call('memory.status', {})).sharing, 'personal');
  assert.equal((await call('memory.status', { folderId: folder.id })).sharing, 'private', 'no git remote in this fixture: private to you');
});

test('MEM-14: document deletion suppresses recall at once and reconciles with the engine when it supports deletion', async t => {
  const deletes: string[] = [];
  const { folder, call } = await fixture(t, {
    recall: [{ id: 'x1', text: 'From the deleted document', documentId: 'doc-1' }, { id: 'x2', text: 'From another document', documentId: 'doc-2' }],
    fetch: engineFetch((url, init) => { deletes.push(`${init?.method} ${url}`); return new Response(null, { status: 204 }); }, ['documents']),
  });
  const result = await call('memory.document.delete', { folderId: folder.id, documentId: 'doc-1' });
  assert.equal(result.engine, 'deleted'); assert.equal(result.pending, undefined);
  assert.deepEqual(deletes, [`DELETE http://memory.local/v1/default/banks/bank-workspace-${identity.folder(folder).id}/documents/doc-1`]);
  const recalled = await call('memory.recall', { folderId: folder.id, query: 'document' });
  assert.deepEqual(recalled.records.map((r: MemoryRecord) => r.id), ['x2']);
  const again = await call('memory.document.delete', { folderId: folder.id, documentId: 'doc-1' });
  assert.equal(again.engine, 'deleted'); assert.equal(deletes.length, 1, 'an already-reconciled delete is not re-sent');
  const jobs = (await call('memory.jobs', { folderId: folder.id })).jobs.filter((job: { kind: string }) => job.kind === 'delete');
  assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'completed'); assert.equal(jobs[0].operationId, 'document:doc-1');
});

test('MEM-14: a failed or unsupported engine delete becomes a durable retry queue with one deduped job', async t => {
  let engineUp = false; const attempts: string[] = [];
  const { folder, call } = await fixture(t, {
    recall: [{ id: 'x1', text: 'Secret plan', documentId: 'doc-9' }],
    fetch: engineFetch(url => { attempts.push(url); return new Response(null, { status: engineUp ? 200 : 503 }); }, ['documents']),
  });
  const first = await call('memory.document.delete', { folderId: folder.id, documentId: 'doc-9' });
  assert.equal(first.engine, 'queued'); assert.equal(first.pending.engine, 'failed'); assert.equal(first.pending.attempts, 1);
  assert.match(first.pending.lastError, /HTTP 503/); assert.ok(first.pending.nextAttemptAt);
  assert.deepEqual((await call('memory.recall', { folderId: folder.id, query: 'plan' })).records, [], 'suppressed in Muster while the engine still has it');
  assert.equal((await call('memory.deletes.list', { folderId: folder.id })).deletes.length, 1);
  await call('memory.jobs', { folderId: folder.id });
  assert.equal(attempts.length, 1, 'a poll before the backoff elapses does not hammer the engine');
  engineUp = true;
  const retried = await call('memory.deletes.retry', { folderId: folder.id });
  assert.deepEqual({ attempted: retried.attempted, deleted: retried.deleted, left: retried.deletes.length }, { attempted: 1, deleted: 1, left: 0 });
  const jobs = (await call('memory.jobs', { folderId: folder.id })).jobs.filter((job: { kind: string }) => job.kind === 'delete');
  assert.equal(jobs.length, 1, 'retries reuse the job and its dedupe key'); assert.equal(jobs[0].status, 'completed'); assert.equal(jobs[0].error, undefined);
});

test('MEM-14: an engine without document deletion leaves the delete queued and says so', async t => {
  const { folder, call } = await fixture(t, { fetch: engineFetch(() => new Response(null, { status: 500 }), null) });
  const result = await call('memory.document.delete', { folderId: folder.id, documentId: 'doc-3' });
  assert.equal(result.engine, 'unsupported'); assert.equal(result.pending.engine, 'pending'); assert.equal(result.pending.attempts, 0);
  assert.match(result.pending.lastError, /Hindsight|version|support/);
});
