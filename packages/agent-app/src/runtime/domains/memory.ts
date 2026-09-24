import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryEntry } from '../../shared/protocol.ts';
import type {
  MemoryArchive, MemoryBankPreview, MemoryDeleteEngineState, MemoryModelPreview, MemoryPendingDelete, MemoryRecallExcluded, MemoryCapability, MemoryCapabilityView, MemoryConfigInput, MemoryDirective, MemoryDirectiveInput,
  MemoryEngineView, MemoryExportManifest, MemoryExportPart, MemoryImportPreview, MemoryJob, MemoryMentalModel, MemoryModelRefresh,
  MemoryModelVersion, MemoryObservation, MemoryOffer, MemoryRecallChipItem, MemoryRecord, MemorySaveResult, MemorySource, MemoryStatusView, MemoryTestResult,
} from '../../shared/domains/memory-protocol.ts';
import { HindsightService, type HindsightServiceOptions } from '../hindsight-service.ts';
import { redactSecrets } from '../secret-redaction.ts';
import { applyRecallFilters, compileRunContext, validateRecallFilters, type RunContextDecision, type RunContextRepo } from '../memory-context.ts';
import { MemoryConfigStore, MemoryTombstones, electronSecretBox, isDuplicateOffer, localMemoryExists, matchesQuery, rankLocal, recordOffer, suggestRunSummary, OFFER_DEDUPE_WINDOW_MS, type OfferRecord, type SecretBox } from '../memory-context.ts';
import { MemoryJobs } from '../memory-jobs.ts';
import { createMemoryIdentity, type MemoryIdentity } from '../memory-identity.ts';
import type { DomainContext, DomainFactory, DomainModule, PromptContributor } from './types.ts';

const ENGINE_BASELINE = '0.10.0';
const ADVANCED_CAPABILITIES: readonly MemoryCapability[] = ['listMemories', 'observations', 'consolidation', 'mentalModels', 'documents', 'operations', 'bankAdmin'];
const ENGINE_CACHE_MS = 120_000;
const MODEL_REFRESH: readonly MemoryModelRefresh[] = ['manual', 'daily', 'weekly', 'after-consolidation'];
const EXPORT_PARTS: readonly MemoryExportPart[] = ['facts', 'observations', 'models', 'directives'];
type Scope = { kind: string; id: string; label: string };

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(part => Number.parseInt(part, 10) || 0), pb = b.split('.').map(part => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < 3; index++) { const diff = (pa[index] ?? 0) - (pb[index] ?? 0); if (diff !== 0) return diff; }
  return 0;
}

export const RECALL_TIMEOUT_MS = 1_800;
const TEST_TIMEOUT_MS = 5_000;
type HindsightEntry = { id?: string; text: string; type?: string; score?: number; occurredAt?: string; mentionedAt?: string; documentId?: string; context?: string; tags?: readonly string[] };

export interface MemoryDomainOptions {
  env?: Record<string, string | undefined>;
  secretBox?: () => SecretBox | undefined;
  fetch?: typeof fetch;
  recallTimeoutMs?: number;
  /** Test seams passed to HindsightService. */
  core?: HindsightServiceOptions['core'];
  createClient?: HindsightServiceOptions['createClient'];
  /** Which Hindsight bank each scope maps to (memory-identity.ts); tests inject one without git. */
  identity?: MemoryIdentity;
}

const str = (value: unknown, field: string, max: number, required = true): string => {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max || (required && !value.trim())) throw new Error(`${field} must be a non-empty string of at most ${max} characters.`);
  return value;
};
const optionalId = (value: unknown): string | undefined => value === undefined || value === null || value === '' ? undefined : str(value, 'folderId', 128);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Settles with the work's value, or undefined after `ms` (aborting it) or when `outer` aborts. */
function within<T>(ms: number, outer: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
  const controller = new AbortController();
  const signal = outer ? AbortSignal.any([outer, controller.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(undefined); }, ms); });
  return Promise.race([work(signal).catch(() => undefined), timeout]).finally(() => clearTimeout(timer));
}

export function createMemoryDomainWith(options: MemoryDomainOptions = {}): DomainFactory {
  return context => memoryDomain(context, options);
}

/** Import duplicate key: trimmed, secret-masked like saved text, case-folded. */
const duplicateKey = (text: string): string => redactSecrets(text.trim()).trim().toLowerCase();

/** Memory domain. Handlers are keyed by the command names in shared/domains/memory-protocol.ts. */
export function createMemoryDomain(context: DomainContext): DomainModule { return memoryDomain(context, {}); }

function memoryDomain(context: DomainContext, options: MemoryDomainOptions): DomainModule {
  const env = options.env ?? process.env;
  let box: SecretBox | undefined | null = null;
  const secretBox = options.secretBox ?? (() => box === null ? box = electronSecretBox() : box);
  const config = new MemoryConfigStore(context.dataDir, secretBox, env);
  const tombstones = new MemoryTombstones(context.dataDir);
  const reflections = new Map<string, AbortController>();
  const recallTimeoutMs = options.recallTimeoutMs ?? RECALL_TIMEOUT_MS;
  const jobs = new MemoryJobs(context.db());
  const db = context.db();
  db.exec('CREATE TABLE IF NOT EXISTS memory_observations (id TEXT PRIMARY KEY, scope TEXT NOT NULL, text TEXT NOT NULL, source_ids TEXT NOT NULL, tags TEXT, updated_at TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS memory_models (id TEXT PRIMARY KEY, scope TEXT NOT NULL, name TEXT NOT NULL, query TEXT NOT NULL, refresh TEXT NOT NULL, storage TEXT NOT NULL, engine_id TEXT, provenance TEXT NOT NULL, text TEXT NOT NULL, versions TEXT NOT NULL, created_at TEXT NOT NULL, refreshed_at TEXT)');
  db.exec('CREATE TABLE IF NOT EXISTS memory_directives (id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, priority INTEGER NOT NULL, tags TEXT NOT NULL, enabled INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS memory_archives (id TEXT PRIMARY KEY, kind TEXT NOT NULL, path TEXT NOT NULL, manifest TEXT NOT NULL, created_at TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS memory_shared (id TEXT PRIMARY KEY, scope TEXT NOT NULL, text TEXT NOT NULL, kind TEXT NOT NULL, observed_at TEXT NOT NULL, provenance TEXT NOT NULL, deletable INTEGER NOT NULL DEFAULT 1)');
  db.exec('CREATE INDEX IF NOT EXISTS memory_observations_scope ON memory_observations (scope)');
  db.exec('CREATE INDEX IF NOT EXISTS memory_models_scope ON memory_models (scope)');
  db.exec('CREATE INDEX IF NOT EXISTS memory_directives_scope ON memory_directives (scope)');
  db.exec('CREATE INDEX IF NOT EXISTS memory_shared_scope ON memory_shared (scope)');
  // MEM-11: model tags and Clear; added to tables created before them.
  { const columns = new Set((db.prepare("SELECT name FROM pragma_table_info('memory_models')").all() as { name: string }[]).map(column => column.name));
    if (!columns.has('tags')) db.exec("ALTER TABLE memory_models ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
    if (!columns.has('cleared_at')) db.exec('ALTER TABLE memory_models ADD COLUMN cleared_at TEXT'); }
  // MEM-14: deleted source documents. A row suppresses the document in Muster immediately; `engine` tracks reconciliation.
  db.exec('CREATE TABLE IF NOT EXISTS memory_deleted_documents (document_id TEXT NOT NULL, scope TEXT NOT NULL, bank_id TEXT, engine TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, next_at TEXT, job_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (scope, document_id))');
  db.exec('CREATE TABLE IF NOT EXISTS memory_offer_history (chat_id TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL)');
  db.exec('CREATE INDEX IF NOT EXISTS memory_offer_history_chat ON memory_offer_history (chat_id)');
  /** Recent run-summary offers per chat, so an active session iterating on the same task doesn't
   *  re-suggest remembering it after every turn. Kept in a small table so a restart doesn't re-offer what
   *  was just offered; rows past the dedupe window, beyond the per-chat cap, or for deleted chats are pruned. */
  const offerHistory = {
    get(chatId: string): OfferRecord[] {
      return (db.prepare('SELECT text, at FROM memory_offer_history WHERE chat_id = ? ORDER BY at').all(chatId) as { text: string; at: number }[]).map(row => ({ text: row.text, at: Number(row.at) }));
    },
    set(chatId: string, history: readonly OfferRecord[]): void {
      db.prepare('DELETE FROM memory_offer_history WHERE chat_id = ?').run(chatId);
      const insert = db.prepare('INSERT INTO memory_offer_history (chat_id, text, at) VALUES (?, ?, ?)');
      for (const entry of history) insert.run(chatId, entry.text, entry.at);
    },
    prune(now = Date.now()): void {
      db.prepare('DELETE FROM memory_offer_history WHERE at < ?').run(now - OFFER_DEDUPE_WINDOW_MS);
      const chats = db.prepare('SELECT DISTINCT chat_id FROM memory_offer_history').all() as { chat_id: string }[];
      for (const { chat_id } of chats) if (!context.store.chat(chat_id)) db.prepare('DELETE FROM memory_offer_history WHERE chat_id = ?').run(chat_id);
    },
  };
  const archiveDir = join(context.dataDir, 'memory-archives');

  /** The Hindsight bank for a scope (memory-identity.ts): Personal per person, a git folder per repository (shared by the
   *  team), a Project per repository and name; folders without a remote stay private. Local memory keeps its own scopes.
   *  `project:<id>` is a Project's own bank (PRJ-X5); anything else is a workspace folder, or Personal when omitted. */
  const identity = options.identity ?? createMemoryIdentity({ env: env as NodeJS.ProcessEnv });
  const resolveScope = (folderId: string): { kind: string; id: string } | undefined => {
    if (folderId === 'personal') return identity.personal();
    if (folderId.startsWith('project:')) {
      const project = context.store.project(folderId.slice(8)) as { id: string; name?: string; primaryFolderId?: string | null; folderIds?: string[] } | undefined;
      if (!project) return undefined;
      const primaryId = project.primaryFolderId ?? project.folderIds?.[0];
      let primary: { id: string; path: string } | undefined;
      try { primary = primaryId ? context.folderFor(primaryId) : undefined; } catch { primary = undefined; }
      return identity.project({ id: project.id, name: project.name ?? project.id }, primary);
    }
    try { return identity.folder(context.folderFor(folderId)); } catch { return undefined; }
  };
  let hindsight: HindsightService | undefined, unavailable = false;
  const service = (): HindsightService | undefined => {
    if (hindsight || unavailable) return hindsight;
    try {
      return hindsight = new HindsightService({ env, readConfig: () => config.hindsight(), core: options.core, createClient: options.createClient, resolveFolderScope: resolveScope });
    } catch { unavailable = true; return undefined; }
  };
  /** Configured and not failing its last request: worth waiting on inside a run. */
  const hindsightReady = (folderId?: string) => { const status = service()?.status(folderId ?? 'personal'); return Boolean(status?.configured && !status.error); };

  const scopeOf = (folderId?: string): Scope => {
    if (!folderId) return { kind: 'user', id: 'local', label: 'Personal' };
    if (folderId.startsWith('project:')) {
      const project = context.store.project(folderId.slice(8));
      if (!project) throw new Error('Project does not exist.');
      return { kind: 'project', id: project.id, label: project.name };
    }
    const folder = context.folderFor(folderId);
    return { kind: 'workspace', id: folder.id, label: folder.name };
  };
  const scopeKey = (scope: { kind: string; id: string }) => `${scope.kind}:${scope.id}`;
  /** The folderId a Scope round-trips through commands as: the inverse of scopeOf/resolveScope. */
  const folderIdOf = (scope: Scope): string | undefined => scope.kind === 'user' ? undefined : scope.kind === 'project' ? `project:${scope.id}` : scope.id;
  const labelFor = (scope: { kind: string; id: string }) => scope.kind === 'user' ? 'Personal' : context.store.folder(scope.id)?.name ?? scope.kind;
  const fromLocal = (entry: MemoryEntry): MemoryRecord => ({
    id: entry.id, source: 'local', text: entry.summary, kind: entry.kind, observedAt: entry.observedAt,
    scope: { ...(entry.scopes[0] ?? { kind: 'user', id: 'local' }), label: labelFor(entry.scopes[0] ?? { kind: 'user', id: 'local' }) },
    provenance: [...entry.provenance], deletable: true,
  });
  const fromHindsight = (entry: HindsightEntry, scope: MemoryRecord['scope'], index: number): MemoryRecord => ({
    id: entry.id ?? `hindsight-${index}`, source: 'hindsight', text: entry.text, kind: entry.type ?? 'memory',
    ...(entry.occurredAt ?? entry.mentionedAt ? { observedAt: entry.occurredAt ?? entry.mentionedAt } : {}),
    scope, provenance: [entry.context, entry.documentId ? `document ${entry.documentId}` : undefined].filter((value): value is string => Boolean(value)),
    ...(entry.score === undefined ? {} : { score: entry.score }), ...(entry.documentId ? { documentId: entry.documentId } : {}),
    ...(entry.tags?.length ? { tags: [...entry.tags] } : {}), deletable: false,
  });
  /** MEM-14: a deleted source document never comes back from recall, whatever the engine has reconciled so far. */
  const deletedDocuments = (scope: { kind: string; id: string }): Set<string> =>
    new Set((db.prepare('SELECT document_id FROM memory_deleted_documents WHERE scope = ?').all(scopeKey(scope)) as { document_id: string }[]).map(row => row.document_id));
  const suppressedEntry = (scope: { kind: string; id: string }, entry: HindsightEntry, deleted = deletedDocuments(scope)): boolean =>
    Boolean((entry.documentId && deleted.has(entry.documentId)) || (entry.id && (deleted.has(entry.id) || tombstones.has(entry.id))));
  const visibleEntries = (scope: { kind: string; id: string }, entries: readonly HindsightEntry[]): HindsightEntry[] => {
    const deleted = deletedDocuments(scope);
    return entries.filter(entry => !suppressedEntry(scope, entry, deleted));
  };
  const localEntries = async (folderId?: string): Promise<MemoryEntry[]> => tombstones.filter(await context.invoke('memory.list', folderId ? { folderId } : {}));
  /** Local records for any scope, including a Project's own bank (which the legacy folder-only local store cannot hold). */
  const localRecordsFor = async (folderId?: string): Promise<MemoryRecord[]> => folderId?.startsWith('project:') ? sharedEntries(scopeOf(folderId)) : (await localEntries(folderId)).map(fromLocal);
  const rankedLocalFor = async (folderId: string | undefined, query: string): Promise<MemoryRecord[]> =>
    folderId?.startsWith('project:') ? sharedEntries(scopeOf(folderId)).filter(record => matchesQuery(record.text, query)).slice(0, 6) : rankLocal(await localEntries(folderId), query).map(fromLocal);

  // --- Project shares (PRJ-X5): the legacy local memory store only understands folder scopes, so a note shared to
  // a Project's bank is kept here instead, alongside whatever Hindsight also accepted for that bank. ---
  interface SharedRow { id: string; scope: string; text: string; kind: string; observed_at: string; provenance: string; deletable: number }
  const sharedFromRow = (row: SharedRow, scope: Scope): MemoryRecord => ({ id: row.id, source: 'local', text: row.text, kind: row.kind, observedAt: row.observed_at, scope, provenance: JSON.parse(row.provenance) as string[], deletable: row.deletable === 1 });
  const sharedEntries = (scope: Scope): MemoryRecord[] => (db.prepare('SELECT * FROM memory_shared WHERE scope = ? ORDER BY observed_at DESC').all(scopeKey(scope)) as unknown as SharedRow[]).map(row => sharedFromRow(row, scope));
  const addShared = (scope: Scope, text: string, kind: string, provenance: string[]): MemoryRecord => {
    const row: SharedRow = { id: randomUUID(), scope: scopeKey(scope), text, kind, observed_at: new Date().toISOString(), provenance: JSON.stringify(provenance), deletable: 1 };
    db.prepare('INSERT INTO memory_shared (id, scope, text, kind, observed_at, provenance, deletable) VALUES (?, ?, ?, ?, ?, ?, ?)').run(row.id, row.scope, row.text, row.kind, row.observed_at, row.provenance, row.deletable);
    return sharedFromRow(row, scope);
  };

  // --- Engine capability negotiation (MEM-06): probes the version endpoint directly (not the retain/recall/reflect
  // client, which stays available at every version) and gates the advanced surfaces on it. Cached briefly per scope. ---
  const engineCache = new Map<string, { view: MemoryEngineView; at: number }>();
  const capabilitiesFor = (supported: boolean, reported?: ReadonlySet<string>): Record<MemoryCapability, MemoryCapabilityView> => {
    const out = {} as Record<MemoryCapability, MemoryCapabilityView>;
    for (const capability of ADVANCED_CAPABILITIES) {
      const on = reported ? reported.has(capability) : supported;
      out[capability] = on ? { supported: true, requires: `Hindsight ≥ ${ENGINE_BASELINE}` } : { supported: false, requires: `Hindsight ≥ ${ENGINE_BASELINE}`, reason: 'This memory engine does not support that yet; update it to enable.' };
    }
    return out;
  };
  const engineView = async (folderId: string | undefined, refresh: boolean): Promise<MemoryEngineView> => {
    const key = folderId ?? 'personal';
    const cached = engineCache.get(key);
    if (!refresh && cached && Date.now() - cached.at < ENGINE_CACHE_MS) return cached.view;
    const remember = (view: MemoryEngineView) => { engineCache.set(key, { view, at: Date.now() }); return view; };
    const { endpoint, apiKey } = config.effective();
    if (!endpoint) return remember({ connection: 'not-configured', baseline: ENGINE_BASELINE, capabilities: capabilitiesFor(false), error: 'The memory engine is not set up. Add its endpoint in Memory settings.' });
    let url: URL;
    try { url = new URL(endpoint); if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) throw new Error(); }
    catch { return remember({ connection: 'not-configured', baseline: ENGINE_BASELINE, capabilities: capabilitiesFor(false), error: 'The memory engine endpoint is not a valid http(s) URL.' }); }
    const base = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
    let response: Response;
    try { response = await (options.fetch ?? fetch)(`${base}/v1/version`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) }); }
    catch { return remember({ connection: 'local-only', baseline: ENGINE_BASELINE, capabilities: capabilitiesFor(false), checkedAt: new Date().toISOString(), error: `Could not reach ${url.host} to check its version.` }); }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return remember({
        connection: response.status === 401 || response.status === 403 ? 'local-only' : 'unchecked', baseline: ENGINE_BASELINE, capabilities: capabilitiesFor(false), checkedAt: new Date().toISOString(),
        error: response.status === 404 ? `${url.host} does not report its version, so advanced memory stays local.` : `The memory engine answered with HTTP ${response.status}.`,
      });
    }
    let body: { version?: unknown; capabilities?: unknown } = {};
    try { body = await response.json() as typeof body; } catch { /* no body */ }
    const version = typeof body.version === 'string' ? body.version.slice(0, 64) : undefined;
    const reported = Array.isArray(body.capabilities) ? new Set(body.capabilities.filter((value): value is string => typeof value === 'string')) : undefined;
    const supported = version !== undefined && compareVersions(version, ENGINE_BASELINE) >= 0;
    return remember({
      connection: 'connected', ...(version ? { version } : {}), baseline: ENGINE_BASELINE, capabilities: capabilitiesFor(supported, reported), checkedAt: new Date().toISOString(),
      ...(supported || reported ? {} : { error: version ? `Memory engine ${version} is older than the required ${ENGINE_BASELINE}.` : 'The memory engine did not report a version.' }),
    });
  };

  // --- Deletion reconciliation (MEM-14): the local row suppresses retrieval at once; the engine copy is deleted when the
  // engine negotiates document support, otherwise (or when the call fails) the row stays queued and is retried with backoff.
  // One durable job per (scope, document) carries the dedupe key, so retries never create a second job. ---
  interface DeletedRow { document_id: string; scope: string; bank_id: string | null; engine: string; attempts: number; last_error: string | null; next_at: string | null; job_id: string | null; created_at: string; updated_at: string }
  const pendingFromRow = (row: DeletedRow): MemoryPendingDelete => ({
    documentId: row.document_id, scope: row.scope, ...(row.bank_id ? { bankId: row.bank_id } : {}), engine: row.engine as MemoryPendingDelete['engine'],
    attempts: row.attempts, ...(row.last_error ? { lastError: row.last_error } : {}), ...(row.next_at ? { nextAttemptAt: row.next_at } : {}), createdAt: row.created_at, updatedAt: row.updated_at,
  });
  const deletedRow = (scope: Scope, documentId: string) => db.prepare('SELECT * FROM memory_deleted_documents WHERE scope = ? AND document_id = ?').get(scopeKey(scope), documentId) as DeletedRow | undefined;
  const RETRY_BASE_MS = 30_000, RETRY_MAX_MS = 6 * 3_600_000;
  /** One engine delete attempt. 'unsupported' leaves the row queued without counting a failure: the engine cannot do it yet. */
  const attemptEngineDelete = async (folderId: string | undefined, scope: Scope, documentId: string): Promise<'deleted' | 'queued' | 'unsupported'> => {
    const row = deletedRow(scope, documentId);
    if (!row || row.engine === 'deleted') return 'deleted';
    const now = new Date();
    const later = (error: string, counted: boolean) => {
      const attempts = row.attempts + (counted ? 1 : 0);
      const next = new Date(now.getTime() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempts, 10))).toISOString();
      db.prepare("UPDATE memory_deleted_documents SET engine = ?, attempts = ?, last_error = ?, next_at = ?, updated_at = ? WHERE scope = ? AND document_id = ?")
        .run(counted ? 'failed' : 'pending', attempts, error, next, now.toISOString(), row.scope, documentId);
      if (row.job_id && jobs.get(row.job_id)) jobs.retrying(row.job_id, error, `Engine deletion of ${documentId} queued for retry`);
    };
    const engine = await engineView(folderId, false);
    if (!engine.capabilities.documents.supported) { later(engine.capabilities.documents.reason ?? 'The engine does not support document deletion yet.', false); return 'unsupported'; }
    const bankId = row.bank_id ?? service()?.status(folderId ?? 'personal').bankId;
    const { endpoint, apiKey } = config.effective();
    if (!bankId || !endpoint) { later('Hindsight is not configured for this scope.', false); return 'unsupported'; }
    const url = new URL(endpoint), base = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
    if (row.job_id) { const job = jobs.get(row.job_id); if (job && job.status !== 'running') jobs.running(job.id, `Deleting ${documentId} from the engine`); }
    try {
      const response = await (options.fetch ?? fetch)(`${base}/v1/default/banks/${encodeURIComponent(bankId)}/documents/${encodeURIComponent(documentId)}`, { method: 'DELETE', headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
      void response.body?.cancel().catch(() => {});
      // 404: the engine no longer has it, which is the state we wanted.
      if (!response.ok && response.status !== 404) { later(`Hindsight answered HTTP ${response.status}.`, true); return 'queued'; }
    } catch (error) { later(`Could not reach Hindsight: ${message(error)}`, true); return 'queued'; }
    db.prepare("UPDATE memory_deleted_documents SET engine = 'deleted', last_error = NULL, next_at = NULL, updated_at = ? WHERE scope = ? AND document_id = ?").run(new Date().toISOString(), row.scope, documentId);
    if (row.job_id && jobs.get(row.job_id)) jobs.completed(row.job_id, { documentId, engine: 'deleted' }, `Deleted ${documentId} from the engine`);
    return 'deleted';
  };
  const listPendingDeletes = (scope: Scope): MemoryPendingDelete[] =>
    (db.prepare("SELECT * FROM memory_deleted_documents WHERE scope = ? AND engine != 'deleted' ORDER BY created_at DESC LIMIT 200").all(scopeKey(scope)) as unknown as DeletedRow[]).map(pendingFromRow);
  /** Retries due deletions (all of them when `force`). Only scopes with a configured engine are attempted. */
  const retryDeletes = async (folderId: string | undefined, scope: Scope, force: boolean): Promise<{ attempted: number; deleted: number }> => {
    if (!service()?.status(folderId ?? 'personal').configured) return { attempted: 0, deleted: 0 };
    const now = new Date().toISOString();
    const due = (db.prepare("SELECT document_id FROM memory_deleted_documents WHERE scope = ? AND engine != 'deleted' AND (? OR next_at IS NULL OR next_at <= ?) LIMIT 20").all(scopeKey(scope), force ? 1 : 0, now) as { document_id: string }[]);
    let deleted = 0;
    for (const { document_id } of due) if (await attemptEngineDelete(folderId, scope, document_id) === 'deleted') deleted++;
    return { attempted: due.length, deleted };
  };

  // --- Observations (MEM-10): deterministic local consolidation of facts sharing a kind, kept separate from the facts themselves. ---
  interface ObservationRow { id: string; scope: string; text: string; source_ids: string; tags: string | null; updated_at: string }
  const observationFromRow = (row: ObservationRow, sources: MemoryRecord[]): MemoryObservation => ({ id: row.id, text: row.text, sourceIds: JSON.parse(row.source_ids) as string[], sources, updatedAt: row.updated_at, proofCount: sources.length, ...(row.tags ? { tags: JSON.parse(row.tags) as string[] } : {}) });
  const listObservations = (scope: Scope, facts: MemoryRecord[]): MemoryObservation[] => {
    const byId = new Map(facts.map(fact => [fact.id, fact]));
    return (db.prepare('SELECT * FROM memory_observations WHERE scope = ? ORDER BY updated_at DESC').all(scopeKey(scope)) as unknown as ObservationRow[])
      .map(row => observationFromRow(row, (JSON.parse(row.source_ids) as string[]).map(id => byId.get(id)).filter((fact): fact is MemoryRecord => Boolean(fact))));
  };
  const consolidate = (scope: Scope, facts: MemoryRecord[]): { made: number } => {
    const groups = new Map<string, MemoryRecord[]>();
    for (const fact of facts) { const list = groups.get(fact.kind) ?? []; list.push(fact); groups.set(fact.kind, list); }
    let made = 0;
    for (const [kind, group] of groups) {
      if (group.length < 2) continue;
      const id = createHash('sha256').update(`${scopeKey(scope)}:${kind}`).digest('hex').slice(0, 24);
      const text = `Consolidated ${group.length} ${kind} notes: ${group.slice(0, 12).map(fact => fact.text.replace(/\s+/g, ' ').trim().slice(0, 160)).join('; ')}`;
      const now = new Date().toISOString();
      db.prepare('INSERT INTO memory_observations (id, scope, text, source_ids, tags, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET text = excluded.text, source_ids = excluded.source_ids, updated_at = excluded.updated_at')
        .run(id, scopeKey(scope), text, JSON.stringify(group.map(fact => fact.id)), JSON.stringify([kind]), now);
      made++;
    }
    return { made };
  };

  // --- Mental models (MEM-11): named saved reflections. Stored through the engine only once mentalModels is
  // negotiated as supported; until then (every build today) they live locally with their provenance. ---
  interface ModelRow { id: string; scope: string; name: string; query: string; refresh: string; storage: string; engine_id: string | null; provenance: string; text: string; versions: string; created_at: string; refreshed_at: string | null; tags?: string | null; cleared_at?: string | null }
  const STALE_MS: Record<MemoryModelRefresh, number> = { manual: Infinity, 'after-consolidation': Infinity, daily: 86_400_000, weekly: 7 * 86_400_000 };
  /** The most recent completed consolidation for a scope, or undefined if none has run yet. */
  const latestConsolidateAt = (scope: Scope): string | undefined => (db.prepare("SELECT updated_at FROM memory_jobs WHERE scope = ? AND kind = 'consolidate' AND status = 'completed' ORDER BY updated_at DESC LIMIT 1").get(scopeKey(scope)) as { updated_at: string } | undefined)?.updated_at;
  const parseTags = (raw: string | null | undefined): string[] => { try { const value = JSON.parse(raw ?? '[]') as unknown; return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === 'string') : []; } catch { return []; } };
  const modelFromRow = (row: ModelRow, consolidatedAt?: string): MemoryMentalModel => {
    const refreshedAt = row.refreshed_at ?? undefined, clearedAt = row.cleared_at ?? undefined;
    const refresh = row.refresh as MemoryModelRefresh;
    // 'after-consolidation' goes stale the moment a newer consolidation has run; the other policies are time-based. A cleared model is stale until refreshed.
    const stale = clearedAt !== undefined || (refresh === 'after-consolidation'
      ? consolidatedAt !== undefined && (refreshedAt === undefined || Date.parse(consolidatedAt) >= Date.parse(refreshedAt))
      : (refreshedAt ? Date.now() - Date.parse(refreshedAt) : Infinity) > (STALE_MS[refresh] ?? Infinity));
    const staleReason = clearedAt !== undefined ? 'Cleared. Refresh to generate it again.' : refresh === 'after-consolidation' ? `A newer consolidation has run since this was ${refreshedAt ? 'last refreshed' : 'created'}.` : `Not refreshed since ${refreshedAt ? new Date(refreshedAt).toLocaleDateString() : 'creation'}; refresh policy is ${refresh}.`;
    return {
      id: row.id, name: row.name, query: row.query, refresh, storage: row.storage as 'engine' | 'local', ...(row.engine_id ? { engineId: row.engine_id } : {}),
      provenance: JSON.parse(row.provenance) as string[], text: row.text, versions: JSON.parse(row.versions) as MemoryModelVersion[], createdAt: row.created_at,
      ...(refreshedAt ? { refreshedAt } : {}), stale, ...(stale ? { staleReason } : {}), refreshing: false,
      tags: parseTags(row.tags), ...(clearedAt ? { clearedAt } : {}),
    };
  };
  const listModels = (scope: Scope): MemoryMentalModel[] => {
    const consolidatedAt = latestConsolidateAt(scope);
    return (db.prepare('SELECT * FROM memory_models WHERE scope = ? ORDER BY created_at DESC').all(scopeKey(scope)) as unknown as ModelRow[]).map(row => modelFromRow(row, consolidatedAt));
  };
  const modelTags = (value: unknown): string[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > 16) throw new Error('tags must contain at most 16 entries.');
    return [...new Set(value.map(tag => str(tag, 'tag', 64, false).trim()).filter(Boolean))];
  };
  /** Tags narrow which notes feed a model (a tag matches a note's kind, text or provenance); they never grant access to another scope. */
  const matchesTags = (entry: MemoryEntry, tags: readonly string[]): boolean => {
    if (!tags.length) return true;
    const haystack = [entry.kind, entry.summary, ...entry.provenance].join('\n').toLowerCase();
    return tags.some(tag => haystack.includes(tag.toLowerCase()));
  };
  /** Generates a model's text: Hindsight reflect when ready, otherwise the best-ranked local facts for the query. */
  const generateModelText = async (folderId: string | undefined, scope: Scope, query: string, tags: readonly string[] = []): Promise<{ text: string; provenance: string[]; generatedBy: 'hindsight' | 'local' }> => {
    if (hindsightReady(folderId)) {
      try {
        const result = await service()!.reflect({ folderId: folderId ?? 'personal', query, budget: 'mid', maxTokens: 2048, ...(tags.length ? { context: `Only consider memories about: ${tags.join(', ')}.` } : {}) });
        const basedOn = (result.basedOn ?? []).filter(entry => !suppressedEntry(scope, entry));
        if (result.text.trim()) return { text: result.text.trim(), provenance: basedOn.map((entry, index) => entry.id ?? `hindsight-${index}`), generatedBy: 'hindsight' };
      } catch { /* fall through to local */ }
    }
    const facts = folderId?.startsWith('project:')
      ? sharedEntries(scope).map(record => ({ id: record.id, kind: record.kind, summary: record.text, observedAt: record.observedAt ?? '', confidence: 1, provenance: record.provenance, scopes: [], redactionState: 'none' }) as MemoryEntry)
      : await localEntries(folderId ?? undefined);
    const ranked = rankLocal(facts.filter(entry => matchesTags(entry, tags)), query, 8);
    if (!ranked.length) return { text: tags.length ? `No memory tagged ${tags.join(', ')} matched this question yet.` : 'No memory matched this question yet.', provenance: [], generatedBy: 'local' };
    return { text: ranked.map(entry => `- ${entry.summary.replace(/\s+/g, ' ').trim()}`).join('\n'), provenance: ranked.map(entry => entry.id), generatedBy: 'local' };
  };
  const saveModel = async (folderId: string | undefined, scope: Scope, capabilities: Record<MemoryCapability, MemoryCapabilityView>, input: { id?: string; name: string; query: string; refresh: MemoryModelRefresh; tags?: readonly string[] }): Promise<MemoryMentalModel> => {
    const existing = input.id ? (db.prepare('SELECT * FROM memory_models WHERE id = ? AND scope = ?').get(input.id, scopeKey(scope)) as ModelRow | undefined) : undefined;
    const tags = input.tags ? [...input.tags] : parseTags(existing?.tags);
    const { text, provenance } = await generateModelText(folderId, scope, input.query, tags);
    const now = new Date().toISOString();
    const previous = existing ? JSON.parse(existing.versions) as MemoryModelVersion[] : [];
    const versions: MemoryModelVersion[] = [...previous, { version: (previous.at(-1)?.version ?? 0) + 1, text, sources: provenance.length, createdAt: now }].slice(-10);
    const id = existing?.id ?? randomUUID();
    const storage: 'engine' | 'local' = capabilities.mentalModels.supported ? 'engine' : 'local';
    const row: ModelRow = { id, scope: scopeKey(scope), name: input.name, query: input.query, refresh: input.refresh, storage, engine_id: null, provenance: JSON.stringify(provenance), text, versions: JSON.stringify(versions), created_at: existing?.created_at ?? now, refreshed_at: now, tags: JSON.stringify(tags), cleared_at: null };
    db.prepare('INSERT INTO memory_models (id, scope, name, query, refresh, storage, engine_id, provenance, text, versions, created_at, refreshed_at, tags, cleared_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(id) DO UPDATE SET name = excluded.name, query = excluded.query, refresh = excluded.refresh, storage = excluded.storage, provenance = excluded.provenance, text = excluded.text, versions = excluded.versions, refreshed_at = excluded.refreshed_at, tags = excluded.tags, cleared_at = NULL')
      .run(row.id, row.scope, row.name, row.query, row.refresh, row.storage, row.engine_id, row.provenance, row.text, row.versions, row.created_at, row.refreshed_at, row.tags ?? '[]');
    return modelFromRow(row);
  };

  // --- Directives and dispositions (MEM-12) ---
  interface DirectiveRow { id: string; scope: string; kind: string; text: string; priority: number; tags: string; enabled: number; created_at: string; updated_at: string }
  const directiveFromRow = (row: DirectiveRow): MemoryDirective => ({ id: row.id, kind: row.kind as 'directive' | 'disposition', text: row.text, priority: row.priority, tags: JSON.parse(row.tags) as string[], enabled: row.enabled === 1, createdAt: row.created_at, updatedAt: row.updated_at });
  const listDirectives = (scope: Scope): MemoryDirective[] => (db.prepare('SELECT * FROM memory_directives WHERE scope = ? ORDER BY priority DESC, created_at ASC').all(scopeKey(scope)) as unknown as DirectiveRow[]).map(directiveFromRow);
  /** Ranked below user, system and tool policy: the wording travels with the block whenever it is injected. */
  const directivesBlock = (directives: readonly MemoryDirective[]): string | undefined => {
    const active = directives.filter(directive => directive.enabled).sort((a, b) => b.priority - a.priority);
    if (!active.length) return undefined;
    const lines = active.map(directive => `- [${directive.kind}, priority ${directive.priority}] ${directive.text}`);
    return `The following are the user's saved directives and dispositions from Memory. They rank below explicit user instructions, system prompts and tool policy in this session; follow them only where they do not conflict.\n${lines.join('\n')}`;
  };

  // --- Export, import and backup (MEM-15) ---
  const exportData = (scope: Scope, facts: MemoryRecord[], observations: MemoryObservation[], models: MemoryMentalModel[], directives: MemoryDirective[], parts: readonly MemoryExportPart[]) => {
    // Exports and backups mask secret-looking strings (MEM-15), including notes saved before redaction existed.
    const r = (text: string) => redactSecrets(text);
    const lines: Record<string, unknown>[] = [];
    const counts: Record<MemoryExportPart, number> = { facts: 0, observations: 0, models: 0, directives: 0 };
    if (parts.includes('facts')) for (const fact of facts) { lines.push({ type: 'fact', id: fact.id, text: r(fact.text), kind: fact.kind, observedAt: fact.observedAt, provenance: fact.provenance.map(r) }); counts.facts++; }
    if (parts.includes('observations')) for (const observation of observations) { lines.push({ type: 'observation', id: observation.id, text: r(observation.text), sourceIds: observation.sourceIds, updatedAt: observation.updatedAt }); counts.observations++; }
    if (parts.includes('models')) for (const model of models) { lines.push({ type: 'model', id: model.id, name: model.name, query: r(model.query), refresh: model.refresh, text: r(model.text) }); counts.models++; }
    if (parts.includes('directives')) for (const directive of directives) { lines.push({ type: 'directive', id: directive.id, kind: directive.kind, text: r(directive.text), priority: directive.priority, tags: directive.tags, enabled: directive.enabled }); counts.directives++; }
    return { lines, counts };
  };
  const writeArchive = (kind: 'export' | 'backup', scope: Scope, lines: Record<string, unknown>[], counts: Record<MemoryExportPart, number>, parts: readonly MemoryExportPart[], reason?: string): MemoryArchive => {
    mkdirSync(archiveDir, { recursive: true });
    const id = randomUUID();
    const jsonl = lines.map(line => JSON.stringify(line)).join('\n') + (lines.length ? '\n' : '');
    const path = join(archiveDir, `${id}.jsonl`);
    writeFileSync(path, jsonl, { mode: 0o600 });
    const sha256 = createHash('sha256').update(jsonl).digest('hex');
    const manifest: MemoryExportManifest = {
      format: 'muster-memory-export', formatVersion: 1, createdAt: new Date().toISOString(), bankId: service()?.status(folderIdOf(scope) ?? 'personal').bankId,
      scope, parts: [...parts], counts, engine: { version: undefined, endpoint: config.effective().endpoint || undefined },
      file: { name: `${id}.jsonl`, sha256, lines: lines.length }, ...(reason ? { reason } : {}),
    };
    db.prepare('INSERT INTO memory_archives (id, kind, path, manifest, created_at) VALUES (?, ?, ?, ?, ?)').run(id, kind, path, JSON.stringify(manifest), manifest.createdAt);
    return { id, kind, path, manifest };
  };
  const listArchives = (): MemoryArchive[] => (db.prepare('SELECT * FROM memory_archives ORDER BY created_at DESC LIMIT 50').all() as { id: string; kind: string; path: string; manifest: string }[])
    .map(row => ({ id: row.id, kind: row.kind as 'export' | 'backup', path: row.path, manifest: JSON.parse(row.manifest) as MemoryExportManifest }));
  const getArchive = (id: string): MemoryArchive => {
    const row = db.prepare('SELECT * FROM memory_archives WHERE id = ?').get(id) as { id: string; kind: string; path: string; manifest: string } | undefined;
    if (!row) throw new Error('That archive does not exist.');
    return { id: row.id, kind: row.kind as 'export' | 'backup', path: row.path, manifest: JSON.parse(row.manifest) as MemoryExportManifest };
  };
  const readArchiveLines = (archive: MemoryArchive): Record<string, unknown>[] => {
    if (!existsSync(archive.path)) throw new Error('That archive’s file is missing on disk.');
    return readFileSync(archive.path, 'utf8').split('\n').filter(line => line.trim()).map(line => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return { type: 'invalid' }; } });
  };
  const backupBefore = (scope: Scope, facts: MemoryRecord[], observations: MemoryObservation[], models: MemoryMentalModel[], directives: MemoryDirective[], reason: string): MemoryArchive => {
    const { lines, counts } = exportData(scope, facts, observations, models, directives, EXPORT_PARTS);
    return writeArchive('backup', scope, lines, counts, EXPORT_PARTS, reason);
  };

  const sharingOf = (folderId?: string): MemoryStatusView['sharing'] => {
    try {
      if (!folderId || folderId === 'personal') return 'personal';
      if (folderId.startsWith('project:')) { const scope = resolveScope(folderId); return scope?.id.startsWith('repo-') ? 'team' : 'private'; }
      return identity.describe(context.folderFor(folderId));
    } catch { return undefined; }
  };
  const status = (folderId?: string): MemoryStatusView => {
    const current = service();
    if (!current) return { connection: 'not-configured', error: 'Hindsight is unavailable in this build. Local memory still works.' };
    const value = current.status(folderId ?? 'personal');
    if (!value.configured) return { connection: 'not-configured', ...(value.error ? { error: value.error } : {}) };
    return {
      connection: value.connection === 'failed' ? 'local-only' : value.connection === 'verified' ? 'connected' : 'unchecked',
      ...(value.endpoint ? { endpoint: value.endpoint } : {}), ...(value.bankId ? { bankId: value.bankId } : {}),
      ...(value.checkedAt ? { checkedAt: value.checkedAt } : {}),
      ...(value.connectionError ?? value.error ? { error: value.connectionError ?? value.error } : {}),
      ...(sharingOf(folderId) ? { sharing: sharingOf(folderId)! } : {}),
    };
  };
  const view = () => { service()?.refresh(); return config.view(service()?.configSource() ?? (config.hindsight() ? 'app' : env.HINDSIGHT_API_URL?.trim() ? 'environment' : 'none')); };

  /** Publishes rows the domain appended, continuing from the replica's last revision. */
  const revision = (chatId: string) => (context.db().prepare('SELECT revision FROM timeline_cursors WHERE chat_id = ?').get(chatId) as { revision: number } | undefined)?.revision ?? 0;
  const publish = (chatId: string, before: number) => {
    const patch = context.store.timelineChanges(chatId, before);
    if (patch.revision > before) context.emit({ type: 'timelinePatch', chatId, patch: { ...patch, after: before } });
  };

  /** Only the latest turn's rows: settling a run never reparses a long chat's whole timeline. */
  const latestTurn = (chatId: string) => {
    const db = context.db();
    const start = (db.prepare("SELECT MAX(seq) AS seq FROM timeline WHERE chat_id = ? AND kind = 'user'").get(chatId) as { seq: number | null } | undefined)?.seq;
    if (start === null || start === undefined) return [];
    // `data` carries the tool type (fileChange, fileRead, commandExecution…): without it every tool call looks
    // alike and suggestRunSummary cannot tell an edit from a lookup.
    const rows = db.prepare('SELECT kind, text, data FROM timeline WHERE chat_id = ? AND seq >= ? ORDER BY seq').all(chatId, start) as unknown as { kind: string; text: string; data: string | null }[];
    return rows.map(row => {
      let data: Record<string, unknown> | undefined;
      try { const parsed = row.data ? JSON.parse(row.data) as unknown : undefined; if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>; } catch { data = undefined; }
      return { kind: row.kind, text: row.text, ...(data ? { data } : {}) };
    });
  };
  const OFFER_ROWS = "SELECT t.id, t.chat_id, t.status, t.data, t.created_at, c.title FROM timeline t JOIN chats c ON c.id = t.chat_id WHERE t.kind = 'notice' AND t.data LIKE '%\"memory-offer\"%'";
  type OfferRow = { id: string; chat_id: string; status: string | null; data: string | null; created_at: string; title: string };
  const offerData = (row: OfferRow) => { try { const data = JSON.parse(row.data ?? '{}') as Record<string, unknown>; return data.kind === 'memory-offer' ? data : undefined; } catch { return undefined; } };
  const findOffer = (chatId: string, runId: string) => (context.db().prepare(`${OFFER_ROWS} AND t.chat_id = ? ORDER BY t.seq DESC`).all(chatId) as unknown as OfferRow[])
    .map(row => ({ row, data: offerData(row) })).find(entry => entry.data?.runId === runId);

  /** Per-turn recall budget: a handful of the most relevant notes (~800 tokens), not the contributor's 8KB ceiling. */
  const RECALL_MAX_RECORDS = 6, RECALL_MAX_CHARS = 3200;
  // Repository evidence (MEM-07): HEAD and branch from git, cached briefly so a burst of turns never waits on git twice.
  const repoCache = new Map<string, { at: number; value: Promise<RunContextRepo | null> }>();
  const git = (cwd: string, args: string[]) => new Promise<string | null>(resolve => execFile('git', args, { cwd, timeout: 1_500, windowsHide: true }, (error, out) => resolve(error ? null : String(out).trim() || null)));
  const repoEvidence = (path: string | undefined): Promise<RunContextRepo | null> => {
    if (!path) return Promise.resolve(null);
    const hit = repoCache.get(path);
    if (hit && Date.now() - hit.at < 5_000) return hit.value;
    const value = Promise.all([git(path, ['rev-parse', 'HEAD']), git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])])
      .then(([head, branch]) => head && /^[0-9a-f]{40,64}$/.test(head) ? { head, ...(branch && branch !== 'HEAD' ? { branch } : {}) } : null);
    repoCache.set(path, { at: Date.now(), value });
    return value;
  };
  /** Project decisions for freshness rules: superseded ones are never included, restatements of active ones are dropped. */
  const projectDecisions = async (projectId: string | undefined): Promise<RunContextDecision[]> => {
    if (!projectId) return [];
    try {
      const result = await context.invoke('project.decisions.list', { projectId });
      return (result?.items ?? []).map(decision => ({ id: decision.id, title: decision.title, status: decision.status === 'active' ? 'active' : 'superseded' }));
    } catch { return []; }
  };
  // MEM-X2: notes the user removed from a chat's recall (composer chip), kept for this session only; bounded.
  const recallExclusions = new Map<string, Map<string, MemoryRecallChipItem>>();
  const excludedFor = (chatId: string) => recallExclusions.get(chatId);
  const chipItem = (record: MemoryRecord): MemoryRecallChipItem => ({ id: record.id, text: redactSecrets(record.text).slice(0, 280), source: record.source, scope: record.scope.label.slice(0, 120), ...(record.observedAt ? { observedAt: record.observedAt } : {}) });
  const withoutExcluded = (chatId: string, lists: MemoryRecord[][]) => { const skip = excludedFor(chatId); return skip?.size ? lists.map(list => list.filter(record => !skip.has(record.id))) : lists; };
  // Recall joins runs only when it has something to offer; otherwise runs keep dispatching in the same tick.
  let removeContributor: (() => void) | undefined;
  const contributor: PromptContributor = async ({ chat, folder, prompt, signal }) => {
    const query = prompt.trim().slice(0, 4000);
    const folderId = chat.folderId && context.store.folder(chat.folderId) ? chat.folderId : undefined;
    // A Project chat recalls from its own folder bank and its Project's shared bank together (PRJ-X5).
    const projectFolderId = chat.projectId && context.store.project(chat.projectId) ? `project:${chat.projectId}` : undefined;
    const directives = config.settings().autoRecall ? [...listDirectives(scopeOf(folderId)), ...(projectFolderId ? listDirectives(scopeOf(projectFolderId)) : [])] : [];
    const directiveText = directivesBlock(directives);
    const directiveLabel = `${directives.filter(d => d.enabled).length} directive${directives.filter(d => d.enabled).length === 1 ? '' : 's'}`;
    if (!config.settings().autoRecall || !query) return directiveText ? { label: directiveLabel, text: directiveText } : null;
    const scopes = [folderId, ...(projectFolderId ? [projectFolderId] : [])];
    const [localByScope, remoteByScope] = await Promise.all([
      Promise.all(scopes.map(id => rankedLocalFor(id, query).catch(() => [] as MemoryRecord[]))),
      Promise.all(scopes.map(id => hindsightReady(id)
        ? within(recallTimeoutMs, signal, inner => service()!.recall({ folderId: id ?? 'personal', query, budget: 'low', maxTokens: 1200, signal: inner })).then(result => visibleEntries(scopeOf(id), result?.results ?? []))
        : Promise.resolve([]))),
    ]);
    // Each list is relevance-ranked; compileRunContext takes them round-robin (folder and Project, local and Hindsight) so no
    // source starves another, applies freshness rules and stops at a small per-turn budget instead of the 8KB contributor ceiling.
    const lists = withoutExcluded(chat.id, scopes.flatMap((scope, index) => [localByScope[index]!, remoteByScope[index]!.slice(0, 8).map((entry, entryIndex) => fromHindsight(entry, scopeOf(scope), entryIndex))]));
    // Decisions and repository evidence only ride along when memory has notes to anchor; a turn without notes costs nothing extra.
    const anyNotes = lists.some(list => list.length > 0);
    const [decisions, repo] = anyNotes ? await Promise.all([projectDecisions(projectFolderId ? chat.projectId : undefined), repoEvidence(folder?.path ?? (folderId ? context.store.folder(folderId)?.path : undefined))]) : [[], null];
    const compiled = anyNotes ? compileRunContext({ lists, decisions, repo, maxRecords: RECALL_MAX_RECORDS, maxChars: RECALL_MAX_CHARS }) : undefined;
    const memoryText = compiled?.selected.length ? compiled.text : undefined;
    if (!memoryText && !directiveText) return null;
    return { label: [memoryText ? compiled!.label : null, directiveText ? directiveLabel : null].filter(Boolean).join(' + '), text: [memoryText, directiveText].filter(Boolean).join('\n\n') };
  };
  const syncContributor = () => {
    const wanted = config.settings().autoRecall && (localMemoryExists(context.dataDir) || Boolean(config.effective().endpoint));
    if (wanted && !removeContributor) removeContributor = context.hooks.addPromptContributor(contributor);
    else if (!wanted && removeContributor) { removeContributor(); removeContributor = undefined; }
  };
  syncContributor();

  /** One save path: the local store always (browsable, deletable), plus Hindsight when configured, with scope, tags and time.
   * A retain is tracked in the job table; an explicit operationId (MEM-14) makes a resubmit a no-op instead of a duplicate. */
  const save = async (input: { folderId?: string; text: string; kind: string; provenance: string[]; chatId?: string; runId?: string; operationId?: string }): Promise<MemorySaveResult> => {
    // Secrets never reach local memory or Hindsight (MEM-08): mask before either write.
    input = { ...input, text: redactSecrets(input.text), provenance: input.provenance.map(entry => redactSecrets(entry)) };
    const scope = scopeOf(input.folderId);
    const localRecord: MemoryRecord = scope.kind === 'project'
      ? addShared(scope, input.text, input.kind, input.provenance)
      : fromLocal(await context.invoke('memory.add', { ...(input.folderId ? { folderId: input.folderId } : {}), summary: input.text, kind: input.kind, provenance: input.provenance, scopes: [{ kind: scope.kind, id: scope.id }] }));
    syncContributor();
    const result: MemorySaveResult = { local: localRecord, hindsight: 'skipped' };
    const current = service();
    const folderId = input.folderId ?? 'personal';
    if (!current?.status(folderId).configured) return result;
    const tags = [input.folderId ? `folder:${input.folderId}` : 'personal', ...(input.chatId ? [`chat:${input.chatId}`] : [])];
    const operationId = input.operationId ?? randomUUID();
    try {
      const job = await jobs.run({ kind: 'retain', scope: scopeKey(scope), operationId, detail: input.text.slice(0, 120) }, async () => {
        const retained = await current.retain({
          folderId, async: false, provenance: input.provenance.slice(0, 16), operationId,
          items: [{ content: input.text, timestamp: localRecord.observedAt, documentId: input.runId ?? localRecord.id, context: input.provenance[0], tags,
            metadata: { kind: input.kind, local_id: localRecord.id, scope: scope.label.slice(0, 512), ...(input.chatId ? { chat_id: input.chatId } : {}), ...(input.runId ? { run_id: input.runId } : {}) } }],
        });
        if (!retained.success) throw new Error('Hindsight did not confirm the save.');
        return { success: retained.success, isAsync: retained.isAsync };
      });
      result.hindsight = (job.result as { isAsync?: boolean } | undefined)?.isAsync ? 'queued' : 'saved';
    } catch (error) { result.hindsight = 'failed'; result.error = `${message(error)} The note is kept in local memory.`; }
    return result;
  };

  const removeSettled = context.hooks.onRunSettled(async ({ chat, runId, status: runStatus }) => {
    const { autoRetain } = config.settings();
    if (runStatus !== 'completed' || autoRetain === 'never') return;
    const summary = suggestRunSummary(latestTurn(chat.id));
    if (!summary) return;
    offerHistory.prune();
    const history = offerHistory.get(chat.id);
    if (isDuplicateOffer(history, summary)) return;
    offerHistory.set(chat.id, recordOffer(history, summary));
    const folderId = chat.folderId && context.store.folder(chat.folderId) ? chat.folderId : undefined;
    if (autoRetain === 'ask') {
      const before = revision(chat.id);
      context.store.appendItem(chat.id, 'notice', 'Suggested a note about this run for memory. Review it in Memory to remember or dismiss it.', 'offer', { kind: 'memory-offer', chatId: chat.id, runId, summary });
      publish(chat.id, before);
      return;
    }
    const saved = await save({ ...(folderId ? { folderId } : {}), text: summary, kind: 'lesson', provenance: [`Run in "${chat.title.slice(0, 200)}"`, `run:${runId}`, `chat:${chat.id}`], chatId: chat.id, runId, operationId: `run:${runId}` }).catch(() => undefined);
    if (!saved) return;
    const before = revision(chat.id);
    context.store.appendItem(chat.id, 'notice', saved.hindsight === 'failed' ? 'Saved a note about this run to local memory. Hindsight did not accept it.' : 'Saved a note about this run to memory.', 'saved', { kind: 'memory-saved', chatId: chat.id, runId, ...(saved.local ? { memoryId: saved.local.id } : {}) });
    publish(chat.id, before);
  });

  const handlers: DomainModule['handlers'] = {
    'memory.config.get': () => view(),
    'memory.config.set': input => { config.write(input as unknown as MemoryConfigInput); syncContributor(); return view(); },
    'memory.config.test': async (): Promise<MemoryTestResult> => {
      const { endpoint, apiKey } = config.effective();
      if (!endpoint) return { ok: false, stage: 'config', message: 'Add the Hindsight endpoint first.' };
      let url: URL;
      try { url = new URL(endpoint); if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) throw new Error(); }
      catch { return { ok: false, stage: 'config', message: 'The endpoint is not a valid http(s) URL without credentials, a query or a fragment.' }; }
      const base = `${url.origin}${url.pathname}`.replace(/\/+$/, ''), started = Date.now();
      let response: Response;
      try { response = await (options.fetch ?? fetch)(`${base}/v1/default/banks`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) }); }
      catch (error) {
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        return { ok: false, stage: 'network', message: timedOut ? `${url.host} did not answer within ${TEST_TIMEOUT_MS / 1000} seconds.` : `Could not reach ${url.host}. Check that Hindsight is running at this address.` };
      }
      void response.body?.cancel().catch(() => {});
      const latencyMs = Date.now() - started;
      if (response.status === 401 || response.status === 403) return { ok: false, stage: 'auth', latencyMs, message: apiKey ? 'Hindsight rejected the API key.' : 'This Hindsight server needs an API key.' };
      if (!response.ok) return { ok: false, stage: 'service', latencyMs, message: response.status === 404 ? `${url.host} answered, but not as a Hindsight API. Check the base URL.` : `Hindsight answered with HTTP ${response.status}.` };
      return { ok: true, stage: 'ok', latencyMs, message: `Connected to ${url.host} in ${latencyMs} ms.` };
    },
    'memory.status': input => status(optionalId(input.folderId)),
    'memory.browse': async input => {
      const folderId = optionalId(input.folderId), query = input.query === undefined ? '' : str(input.query, 'query', 2048, false).trim();
      const scope = scopeOf(folderId), filters = validateRecallFilters(input);
      const [local, remote] = await Promise.all([
        localRecordsFor(folderId),
        query && hindsightReady(folderId)
          ? service()!.recall({ folderId: folderId ?? 'personal', query, budget: 'mid', maxTokens: 2048 }).then(result => result.results).catch(() => [] as HindsightEntry[])
          : Promise.resolve([] as HindsightEntry[]),
      ]);
      const records = [
        ...local.filter(record => !query || matchesQuery(record.text, query)).sort((a, b) => (b.observedAt ?? '').localeCompare(a.observedAt ?? '')),
        ...visibleEntries(scope, remote).map((entry, index) => fromHindsight(entry, scope, index)),
      ];
      if (!filters.entities && !filters.from && !filters.to && !filters.validAt) return { records, status: status(folderId) };
      const filtered = applyRecallFilters(records, filters);
      return { records: filtered.records, status: status(folderId), excluded: filtered.excluded };
    },
    'memory.recall': async input => {
      const folderId = optionalId(input.folderId), current = service(), filters = validateRecallFilters(input);
      if (!current) throw new Error('Hindsight is unavailable in this build.');
      const result = await current.recall({ folderId: folderId ?? 'personal', query: str(input.query, 'query', 8192), budget: (input.budget as 'low' | 'mid' | 'high' | undefined) ?? 'low',
        maxTokens: typeof input.maxTokens === 'number' ? input.maxTokens : 2048, types: input.types as ('world' | 'experience' | 'observation')[] | undefined, tags: input.tags as string[] | undefined });
      const scope = scopeOf(folderId);
      const records = visibleEntries(scope, result.results).map((entry, index) => fromHindsight(entry, scope, index));
      if (!filters.entities && !filters.from && !filters.to && !filters.validAt) return { bankId: result.bankId, records };
      const filtered: { records: MemoryRecord[]; excluded: MemoryRecallExcluded } = applyRecallFilters(records, filters);
      return { bankId: result.bankId, records: filtered.records, excluded: filtered.excluded };
    },
    'memory.reflect': async input => {
      const folderId = optionalId(input.folderId), requestId = str(input.requestId, 'requestId', 128), current = service();
      if (!current) throw new Error('Hindsight is unavailable in this build.');
      if (reflections.has(requestId)) throw new Error('That reflection is already running.');
      const controller = new AbortController();
      reflections.set(requestId, controller);
      try {
        const result = await current.reflect({ folderId: folderId ?? 'personal', query: str(input.query, 'query', 8192), signal: controller.signal,
          context: input.context === undefined || input.context === '' ? undefined : str(input.context, 'context', 32768, false),
          budget: (input.budget as 'low' | 'mid' | 'high' | undefined) ?? 'low', maxTokens: typeof input.maxTokens === 'number' ? input.maxTokens : 2048 });
        const scope = scopeOf(folderId);
        return { bankId: result.bankId, text: result.text, sources: visibleEntries(scope, result.basedOn ?? []).map((entry, index) => fromHindsight(entry, scope, index)) };
      } catch (error) {
        if (controller.signal.aborted) return { bankId: '', text: '', sources: [], cancelled: true };
        throw error;
      } finally { reflections.delete(requestId); }
    },
    'memory.reflect.cancel': input => {
      const controller = reflections.get(str(input.requestId, 'requestId', 128));
      controller?.abort();
      return { cancelled: Boolean(controller) };
    },
    'memory.delete': async input => {
      const folderId = optionalId(input.folderId), id = str(input.id, 'id', 256);
      if (folderId?.startsWith('project:')) {
        const info = db.prepare('SELECT deletable FROM memory_shared WHERE id = ? AND scope = ?').get(id, scopeKey(scopeOf(folderId))) as { deletable: number } | undefined;
        if (!info) throw new Error('That memory is not in this scope, or it was already deleted.');
        db.prepare('DELETE FROM memory_shared WHERE id = ?').run(id);
        return { deleted: true };
      }
      if (!(await localEntries(folderId)).some(entry => entry.id === id)) throw new Error('That memory is not in this scope, or it was already deleted.');
      tombstones.add(id);
      return { deleted: true };
    },
    'memory.rememberText': async input => {
      const chat = input.chatId === undefined ? undefined : context.store.chat(str(input.chatId, 'chatId', 128));
      if (input.chatId !== undefined && !chat) throw new Error('Chat does not exist.');
      const folderId = chat ? (chat.folderId && context.store.folder(chat.folderId) ? chat.folderId : undefined) : optionalId(input.folderId);
      if (folderId) scopeOf(folderId); // validates the folder or project exists
      const kind = input.kind === undefined ? 'fact' : str(input.kind, 'kind', 64);
      const source = input.source === undefined || input.source === '' ? undefined : str(input.source, 'source', 256).trim();
      const provenance = [source ?? (chat ? `Chat "${chat.title.slice(0, 200)}"` : 'Manual entry'), ...(chat ? [`chat:${chat.id}`] : [])];
      return save({ ...(folderId ? { folderId } : {}), text: str(input.text, 'text', 8192).trim(), kind, provenance, ...(chat ? { chatId: chat.id } : {}) });
    },
    'memory.retainFromRun': async input => {
      const chatId = str(input.chatId, 'chatId', 128), runId = str(input.runId, 'runId', 128);
      const chat = context.store.chat(chatId);
      if (!chat) throw new Error('Chat does not exist.');
      if (findOffer(chatId, runId)?.data?.saved) throw new Error('This run is already remembered.');
      const folderId = chat.folderId && context.store.folder(chat.folderId) ? chat.folderId : undefined;
      const result = await save({ ...(folderId ? { folderId } : {}), text: str(input.summary, 'summary', 8192).trim(), kind: 'lesson', provenance: [`Run in "${chat.title.slice(0, 200)}"`, `run:${runId}`, `chat:${chatId}`], chatId, runId, operationId: `run:${runId}` });
      const offer = findOffer(chatId, runId);
      if (offer) {
        const before = revision(chatId);
        context.store.updateItem(offer.row.id, 'Saved a note about this run to memory.', 'saved', { ...offer.data, kind: 'memory-offer', saved: true, ...(result.local ? { memoryId: result.local.id } : {}) });
        publish(chatId, before);
      }
      return result;
    },
    'memory.recall.preview': async input => {
      const chat = context.store.chat(str(input.chatId, 'chatId', 128));
      if (!chat) throw new Error('Chat not found.');
      const excluded = [...(excludedFor(chat.id)?.values() ?? [])];
      const query = typeof input.prompt === 'string' ? input.prompt.trim().slice(0, 4000) : '';
      const folderId = chat.folderId && context.store.folder(chat.folderId) ? chat.folderId : undefined;
      const projectFolderId = chat.projectId && context.store.project(chat.projectId) ? `project:${chat.projectId}` : undefined;
      const scopes = [folderId, ...(projectFolderId ? [projectFolderId] : [])];
      const enabled = config.settings().autoRecall, engine = enabled && scopes.some(scope => hindsightReady(scope));
      if (!enabled || !query) return { enabled, engine, records: [], excluded };
      const lists = withoutExcluded(chat.id, await Promise.all(scopes.map(scope => rankedLocalFor(scope, query).catch(() => [] as MemoryRecord[]))));
      const compiled = lists.some(list => list.length) ? compileRunContext({ lists, maxRecords: RECALL_MAX_RECORDS, maxChars: RECALL_MAX_CHARS }) : undefined;
      return { enabled, engine, records: (compiled?.selected ?? []).map(chipItem), excluded };
    },
    'memory.recall.exclude': input => {
      const chat = context.store.chat(str(input.chatId, 'chatId', 128));
      if (!chat) throw new Error('Chat not found.');
      const noteId = str(input.id, 'id', 256);
      let skip = recallExclusions.get(chat.id);
      if (input.excluded === true) {
        if (!skip) { if (recallExclusions.size >= 200) recallExclusions.delete(recallExclusions.keys().next().value!); skip = new Map(); recallExclusions.set(chat.id, skip); }
        if (skip.size < 100) skip.set(noteId, { id: noteId, text: redactSecrets(typeof input.text === 'string' ? input.text : '').slice(0, 280), source: 'local', scope: '' });
      } else skip?.delete(noteId);
      return { excluded: [...(skip?.values() ?? [])] };
    },
    'memory.offers': input => {
      const folderId = optionalId(input.folderId);
      if (folderId) context.folderFor(folderId);
      // A chat whose folder is gone recalls from Personal, so its offers belong there too.
      const rows = context.db().prepare(`${OFFER_ROWS} AND t.status = 'offer' AND c.archived = 0 ORDER BY t.seq DESC LIMIT 200`).all() as unknown as OfferRow[];
      const offers: MemoryOffer[] = [];
      for (const row of rows) {
        const chat = context.store.chat(row.chat_id);
        const chatFolder = chat?.folderId && context.store.folder(chat.folderId) ? chat.folderId : undefined;
        const data = offerData(row);
        if (!chat || chatFolder !== folderId || !data || typeof data.runId !== 'string' || typeof data.summary !== 'string') continue;
        offers.push({ itemId: row.id, chatId: row.chat_id, chatTitle: row.title, runId: data.runId, summary: data.summary, createdAt: row.created_at });
        if (offers.length >= 20) break;
      }
      return { offers };
    },
    'memory.offer.dismiss': input => {
      const chatId = str(input.chatId, 'chatId', 128), runId = str(input.runId, 'runId', 128);
      const offer = findOffer(chatId, runId);
      if (!offer || offer.row.status !== 'offer') return { dismissed: false };
      const before = revision(chatId);
      context.store.updateItem(offer.row.id, 'Dismissed the suggested memory for this run.', 'dismissed', { ...offer.data, kind: 'memory-offer', dismissed: true });
      publish(chatId, before);
      return { dismissed: true };
    },

    // --- MEM-06: capability negotiation ---
    'memory.engine': async input => engineView(optionalId(input.folderId), Boolean(input.refresh)),

    // --- MEM-10: observations and consolidation ---
    'memory.observations': async input => {
      const folderId = optionalId(input.folderId), scope = scopeOf(folderId);
      const facts = (await localRecordsFor(folderId)).filter(record => record.kind !== 'observation');
      const observations = listObservations(scope, facts);
      const consolidation = jobs.list(scopeKey(scope)).find(job => job.kind === 'consolidate');
      return { facts, observations, ...(consolidation ? { consolidation } : {}) };
    },
    'memory.consolidate': async input => {
      const folderId = optionalId(input.folderId), operationId = str(input.operationId, 'operationId', 128), scope = scopeOf(folderId);
      const facts = (await localRecordsFor(folderId)).filter(record => record.kind !== 'observation');
      return jobs.run({ kind: 'consolidate', scope: scopeKey(scope), operationId, detail: `${facts.length} fact${facts.length === 1 ? '' : 's'}` }, async () => consolidate(scope, facts));
    },
    'memory.jobs': async input => {
      const folderId = optionalId(input.folderId), scope = scopeOf(folderId);
      // Polling the job list is also when due engine deletions are retried (MEM-14); a failure there never fails the read.
      await retryDeletes(folderId, scope, false).catch(() => undefined);
      return { jobs: jobs.list(scopeKey(scope)) };
    },

    // --- MEM-11: mental models ---
    'memory.models.list': input => ({ models: listModels(scopeOf(optionalId(input.folderId))) }),
    'memory.models.save': async input => {
      const folderId = optionalId(input.folderId), scope = scopeOf(folderId);
      const name = str(input.name, 'name', 200).trim();
      if (!name) throw new Error('Name the mental model first.');
      const query = str(input.query, 'query', 4096).trim();
      if (!query) throw new Error('Give the model a question to answer.');
      const refresh = input.refresh;
      if (!MODEL_REFRESH.includes(refresh as MemoryModelRefresh)) throw new Error('refresh must be manual, daily, weekly or after-consolidation.');
      const id = input.id === undefined ? undefined : str(input.id, 'id', 128);
      if (id && !db.prepare('SELECT 1 FROM memory_models WHERE id = ? AND scope = ?').get(id, scopeKey(scope))) throw new Error('That mental model does not exist in this scope.');
      const tags = modelTags(input.tags);
      const capabilities = (await engineView(folderId, false)).capabilities;
      return saveModel(folderId, scope, capabilities, { id, name, query, refresh: refresh as MemoryModelRefresh, ...(input.tags === undefined ? {} : { tags }) });
    },
    'memory.models.refresh': async input => {
      const folderId = optionalId(input.folderId), scope = scopeOf(folderId), id = str(input.id, 'id', 128);
      const row = db.prepare('SELECT * FROM memory_models WHERE id = ? AND scope = ?').get(id, scopeKey(scope)) as { name: string; query: string; refresh: string } | undefined;
      if (!row) throw new Error('That mental model does not exist in this scope.');
      const capabilities = (await engineView(folderId, false)).capabilities;
      return saveModel(folderId, scope, capabilities, { id, name: row.name, query: row.query, refresh: row.refresh as MemoryModelRefresh });
    },
    'memory.models.preview': async (input): Promise<MemoryModelPreview> => {
      const folderId = optionalId(input.folderId), scope = scopeOf(folderId);
      let query: string, tags: string[];
      if (input.id !== undefined) {
        const row = db.prepare('SELECT * FROM memory_models WHERE id = ? AND scope = ?').get(str(input.id, 'id', 128), scopeKey(scope)) as ModelRow | undefined;
        if (!row) throw new Error('That mental model does not exist in this scope.');
        query = row.query; tags = input.tags === undefined ? parseTags(row.tags) : modelTags(input.tags);
      } else {
        query = str(input.query, 'query', 4096).trim(); tags = modelTags(input.tags);
        if (!query) throw new Error('Give the model a question to answer.');
      }
      const { text, provenance, generatedBy } = await generateModelText(folderId, scope, query, tags);
      return { text, provenance, sources: provenance.length, generatedBy };
    },
    'memory.models.clear': input => {
      const scope = scopeOf(optionalId(input.folderId)), id = str(input.id, 'id', 128);
      const row = db.prepare('SELECT * FROM memory_models WHERE id = ? AND scope = ?').get(id, scopeKey(scope)) as ModelRow | undefined;
      if (!row) throw new Error('That mental model does not exist in this scope.');
      // Only the model's generated text and history go; the facts it was built from stay in memory.
      const clearedAt = new Date().toISOString();
      db.prepare("UPDATE memory_models SET text = '', versions = '[]', provenance = '[]', cleared_at = ? WHERE id = ?").run(clearedAt, id);
      return modelFromRow({ ...row, text: '', versions: '[]', provenance: '[]', cleared_at: clearedAt }, latestConsolidateAt(scope));
    },
    'memory.models.delete': input => {
      const scope = scopeOf(optionalId(input.folderId)), id = str(input.id, 'id', 128);
      if (!db.prepare('SELECT 1 FROM memory_models WHERE id = ? AND scope = ?').get(id, scopeKey(scope))) return { deleted: false };
      db.prepare('DELETE FROM memory_models WHERE id = ?').run(id);
      return { deleted: true };
    },

    // --- MEM-12: directives and dispositions ---
    'memory.directives.list': input => ({ directives: listDirectives(scopeOf(optionalId(input.folderId))) }),
    'memory.directives.save': input => {
      const scope = scopeOf(optionalId(input.folderId));
      const directive = input.directive as Partial<MemoryDirectiveInput> | undefined;
      if (!directive || typeof directive !== 'object') throw new Error('directive must be an object.');
      if (directive.kind !== 'directive' && directive.kind !== 'disposition') throw new Error('kind must be directive or disposition.');
      const text = redactSecrets(str(directive.text, 'text', 2000).trim());
      if (!text) throw new Error('Give the directive some text.');
      if (!Number.isSafeInteger(directive.priority) || directive.priority! < 0 || directive.priority! > 1000) throw new Error('priority must be an integer between 0 and 1000.');
      if (!Array.isArray(directive.tags) || directive.tags.length > 16) throw new Error('tags must contain at most 16 entries.');
      const tags = directive.tags.map(tag => str(tag, 'tag', 64));
      if (typeof directive.enabled !== 'boolean') throw new Error('enabled must be true or false.');
      const now = new Date().toISOString();
      const id = directive.id === undefined ? randomUUID() : str(directive.id, 'id', 128);
      const existing = db.prepare('SELECT created_at FROM memory_directives WHERE id = ? AND scope = ?').get(id, scopeKey(scope)) as { created_at: string } | undefined;
      const row: DirectiveRow = { id, scope: scopeKey(scope), kind: directive.kind, text, priority: directive.priority!, tags: JSON.stringify(tags), enabled: directive.enabled ? 1 : 0, created_at: existing?.created_at ?? now, updated_at: now };
      db.prepare('INSERT INTO memory_directives (id, scope, kind, text, priority, tags, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, text = excluded.text, priority = excluded.priority, tags = excluded.tags, enabled = excluded.enabled, updated_at = excluded.updated_at')
        .run(row.id, row.scope, row.kind, row.text, row.priority, row.tags, row.enabled, row.created_at, row.updated_at);
      return directiveFromRow(row);
    },
    'memory.directives.delete': input => {
      const scope = scopeOf(optionalId(input.folderId)), id = str(input.id, 'id', 128);
      if (!db.prepare('SELECT 1 FROM memory_directives WHERE id = ? AND scope = ?').get(id, scopeKey(scope))) return { deleted: false };
      db.prepare('DELETE FROM memory_directives WHERE id = ?').run(id);
      return { deleted: true };
    },

    // --- MEM-14: deletion semantics ---
    'memory.correct': async input => {
      const folderId = optionalId(input.folderId), id = str(input.id, 'id', 256), source = input.source as MemorySource;
      if (source !== 'local' && source !== 'hindsight') throw new Error('source must be local or hindsight.');
      const text = str(input.text, 'text', 8192).trim();
      if (!text) throw new Error('Give the corrected text.');
      const kind = input.kind === undefined ? undefined : str(input.kind, 'kind', 64);
      const scope = scopeOf(folderId);
      if (source === 'local') {
        if (folderId?.startsWith('project:')) {
          if (!db.prepare('SELECT 1 FROM memory_shared WHERE id = ? AND scope = ?').get(id, scopeKey(scope))) throw new Error('That memory is not in this scope, or it was already deleted.');
          db.prepare('DELETE FROM memory_shared WHERE id = ?').run(id);
        } else {
          if (!(await localEntries(folderId)).some(entry => entry.id === id)) throw new Error('That memory is not in this scope, or it was already deleted.');
          tombstones.add(id);
        }
      }
      // A Hindsight-origin fact cannot be edited in place; the correction is recorded as a new note that supersedes it.
      return save({ ...(folderId ? { folderId } : {}), text, kind: kind ?? 'fact', provenance: [`corrects ${source}:${id}`] });
    },
    'memory.document.delete': async input => {
      const folderId = optionalId(input.folderId), documentId = str(input.documentId, 'documentId', 256), scope = scopeOf(folderId);
      let local = 0;
      if (folderId?.startsWith('project:')) {
        for (const record of sharedEntries(scope)) if (record.id === documentId) { db.prepare('DELETE FROM memory_shared WHERE id = ?').run(record.id); local++; }
      } else {
        for (const entry of await localEntries(folderId)) {
          if (entry.id === documentId || entry.provenance.includes(`run:${documentId}`)) { tombstones.add(entry.id); local++; }
        }
      }
      // Suppress first: from this moment recall in Muster never returns the document, whatever the engine does next.
      const configured = Boolean(service()?.status(folderId ?? 'personal').configured);
      const now = new Date().toISOString();
      if (!configured) {
        db.prepare("INSERT INTO memory_deleted_documents (document_id, scope, bank_id, engine, attempts, created_at, updated_at) VALUES (?, ?, NULL, 'deleted', 0, ?, ?) ON CONFLICT(scope, document_id) DO NOTHING").run(documentId, scopeKey(scope), now, now);
        return { engine: 'skipped' satisfies MemoryDeleteEngineState, local };
      }
      const existing = deletedRow(scope, documentId);
      if (!existing) {
        const bankId = service()?.status(folderId ?? 'personal').bankId ?? null;
        const { job } = jobs.submit({ kind: 'delete', scope: scopeKey(scope), ...(bankId ? { bankId } : {}), operationId: `document:${documentId}`, detail: `Delete document ${documentId}` });
        db.prepare("INSERT INTO memory_deleted_documents (document_id, scope, bank_id, engine, attempts, job_id, created_at, updated_at) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)").run(documentId, scopeKey(scope), bankId, job.id, now, now);
      }
      const outcome = existing?.engine === 'deleted' ? 'deleted' : await attemptEngineDelete(folderId, scope, documentId);
      const row = deletedRow(scope, documentId);
      const engine: MemoryDeleteEngineState = outcome;
      return { engine, local, ...(row && row.engine !== 'deleted' ? { pending: pendingFromRow(row) } : {}) };
    },
    'memory.deletes.list': input => ({ deletes: listPendingDeletes(scopeOf(optionalId(input.folderId))) }),
    'memory.deletes.retry': async input => {
      const folderId = optionalId(input.folderId), scope = scopeOf(folderId);
      const { attempted, deleted } = await retryDeletes(folderId, scope, true);
      return { attempted, deleted, deletes: listPendingDeletes(scope) };
    },
    'memory.bank.preview': async input => {
      const folderId = optionalId(input.folderId), scope = scopeOf(folderId);
      const local = (await localRecordsFor(folderId)).length;
      const models = (db.prepare('SELECT COUNT(*) AS n FROM memory_models WHERE scope = ?').get(scopeKey(scope)) as { n: number }).n;
      const directives = (db.prepare('SELECT COUNT(*) AS n FROM memory_directives WHERE scope = ?').get(scopeKey(scope)) as { n: number }).n;
      const engineDelete = (await engineView(folderId, false)).capabilities.bankAdmin.supported;
      return { bankId: service()?.status(folderId ?? 'personal').bankId, scopeLabel: scope.label, local, models, directives, engineDelete };
    },
    'memory.bank.delete': async input => {
      const folderId = optionalId(input.folderId), scope = scopeOf(folderId), confirm = str(input.confirm, 'confirm', 200);
      if (confirm !== scope.label) throw new Error(`Type "${scope.label}" to confirm deleting this bank.`);
      const facts = await localRecordsFor(folderId);
      const backup = backupBefore(scope, facts, listObservations(scope, facts), listModels(scope), listDirectives(scope), `Before deleting the ${scope.label} bank`);
      for (const fact of facts) { if (folderId?.startsWith('project:')) db.prepare('DELETE FROM memory_shared WHERE id = ?').run(fact.id); else tombstones.add(fact.id); }
      db.prepare('DELETE FROM memory_observations WHERE scope = ?').run(scopeKey(scope));
      db.prepare('DELETE FROM memory_models WHERE scope = ?').run(scopeKey(scope));
      db.prepare('DELETE FROM memory_directives WHERE scope = ?').run(scopeKey(scope));
      return { backup, local: facts.length, engine: hindsightReady(folderId) ? 'unsupported' : 'skipped' };
    },

    // --- MEM-15: export, import and backup ---
    'memory.export': async input => {
      const folderId = optionalId(input.folderId), scope = scopeOf(folderId);
      const parts = input.parts;
      if (!Array.isArray(parts) || parts.length === 0 || parts.some(part => !EXPORT_PARTS.includes(part as MemoryExportPart))) throw new Error('parts must be a non-empty subset of facts, observations, models, directives.');
      const typedParts = parts as MemoryExportPart[];
      const facts = await localRecordsFor(folderId);
      const observations = listObservations(scope, facts), models = listModels(scope), directives = listDirectives(scope);
      let archive: MemoryArchive | undefined;
      const job = await jobs.run({ kind: 'export', scope: scopeKey(scope), operationId: `export-${randomUUID()}`, detail: typedParts.join(',') }, async () => {
        const { lines, counts } = exportData(scope, facts, observations, models, directives, typedParts);
        archive = writeArchive('export', scope, lines, counts, typedParts);
        return { archiveId: archive.id };
      });
      return { archive: archive ?? getArchive((job.result as { archiveId: string }).archiveId), job };
    },
    'memory.archives': () => ({ archives: listArchives() }),
    'memory.import.preview': async input => {
      const folderId = optionalId(input.folderId), scope = scopeOf(folderId);
      const archive = getArchive(str(input.archiveId, 'archiveId', 128));
      const lines = readArchiveLines(archive);
      const existingFacts = new Set((await localRecordsFor(folderId)).map(record => duplicateKey(record.text)));
      const existingModels = new Set(listModels(scope).map(model => model.name.toLowerCase()));
      const existingDirectives = new Set(listDirectives(scope).map(directive => duplicateKey(directive.text)));
      let duplicates = 0, factCount = 0, modelCount = 0, directiveCount = 0, observationCount = 0;
      const skipped: string[] = [];
      const sample: { type: string; text: string }[] = [];
      for (const line of lines) {
        const type = typeof line.type === 'string' ? line.type : 'invalid';
        const key = type === 'model' ? (typeof line.name === 'string' ? line.name : '') : typeof line.text === 'string' ? line.text : '';
        if (type === 'fact') { if (existingFacts.has(duplicateKey(key))) duplicates++; else factCount++; }
        else if (type === 'model') { if (existingModels.has(key.trim().toLowerCase())) duplicates++; else modelCount++; }
        else if (type === 'directive') { if (existingDirectives.has(duplicateKey(key.slice(0, 2000)))) duplicates++; else directiveCount++; }
        else if (type === 'observation') observationCount++;
        else skipped.push('An unrecognized line was skipped.');
        if (sample.length < 5 && (typeof line.text === 'string' || typeof line.name === 'string')) sample.push({ type, text: typeof line.text === 'string' ? line.text : String(line.name) });
      }
      // Observations are derived from facts, not stored data: they are not replayed on import, but the archive still names them so nothing looks silently lost.
      if (observationCount > 0) skipped.push(`${observationCount} observation${observationCount === 1 ? '' : 's'} will not be imported; consolidate again after importing facts.`);
      return { archive, importable: { facts: factCount, models: modelCount, directives: directiveCount }, duplicates, skipped, sample };
    },
    'memory.import.apply': async input => {
      const folderId = optionalId(input.folderId), scope = scopeOf(folderId);
      const archive = getArchive(str(input.archiveId, 'archiveId', 128));
      const operationId = str(input.operationId, 'operationId', 128);
      const skipDuplicates = Boolean(input.skipDuplicates);
      const facts = await localRecordsFor(folderId);
      const backup = backupBefore(scope, facts, listObservations(scope, facts), listModels(scope), listDirectives(scope), `Before importing archive ${archive.id}`);
      const job = await jobs.run({ kind: 'import', scope: scopeKey(scope), operationId, detail: archive.id }, async () => {
        const lines = readArchiveLines(archive);
        // Saved text is secret-masked (MEM-08), so an archive line is masked the same way before comparing:
        // a raw line holding a key would otherwise never match its stored, redacted twin.
        const existingFacts = new Set(facts.map(record => duplicateKey(record.text)));
        const existingDirectives = new Set(listDirectives(scope).map(directive => duplicateKey(directive.text)));
        let importedFacts = 0, importedModels = 0, importedDirectives = 0;
        for (const line of lines) {
          const type = typeof line.type === 'string' ? line.type : 'invalid';
          if (type === 'fact') {
            const text = typeof line.text === 'string' ? line.text.trim() : '';
            if (!text || (skipDuplicates && existingFacts.has(duplicateKey(text)))) continue;
            await save({ ...(folderId ? { folderId } : {}), text, kind: typeof line.kind === 'string' ? line.kind : 'fact', provenance: [`import:${archive.id}`] });
            existingFacts.add(duplicateKey(text)); importedFacts++;
          } else if (type === 'model') {
            const name = typeof line.name === 'string' ? line.name : undefined, query = typeof line.query === 'string' ? line.query : undefined;
            if (!name || !query) continue;
            const capabilities = (await engineView(folderId, false)).capabilities;
            await saveModel(folderId, scope, capabilities, { name, query, refresh: MODEL_REFRESH.includes(line.refresh as MemoryModelRefresh) ? line.refresh as MemoryModelRefresh : 'manual' });
            importedModels++;
          } else if (type === 'directive') {
            // An archive can come from anywhere: imported directives are masked like saved ones (MEM-08).
            const text = typeof line.text === 'string' ? redactSecrets(line.text.slice(0, 2000).trim()) : undefined;
            if (!text || (skipDuplicates && existingDirectives.has(duplicateKey(text)))) continue;
            existingDirectives.add(duplicateKey(text));
            const now = new Date().toISOString();
            const row: DirectiveRow = { id: randomUUID(), scope: scopeKey(scope), kind: line.kind === 'disposition' ? 'disposition' : 'directive', text, priority: typeof line.priority === 'number' ? line.priority : 0, tags: JSON.stringify(Array.isArray(line.tags) ? line.tags : []), enabled: line.enabled === false ? 0 : 1, created_at: now, updated_at: now };
            db.prepare('INSERT INTO memory_directives (id, scope, kind, text, priority, tags, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(row.id, row.scope, row.kind, row.text, row.priority, row.tags, row.enabled, row.created_at, row.updated_at);
            importedDirectives++;
          }
        }
        return { facts: importedFacts, models: importedModels, directives: importedDirectives };
      });
      const imported = (job.result as { facts: number; models: number; directives: number } | undefined) ?? { facts: 0, models: 0, directives: 0 };
      return { backup, imported, job };
    },

    // --- PRJ-X5: share a memory into a Project's bank ---
    'memory.share': async input => {
      const projectId = str(input.projectId, 'projectId', 128);
      if (!context.store.project(projectId)) throw new Error('Project does not exist.');
      const text = str(input.text, 'text', 8192).trim();
      if (!text) throw new Error('Give the text to share.');
      const kind = str(input.kind, 'kind', 64);
      const sourceId = str(input.sourceId, 'sourceId', 256);
      const provenance = Array.isArray(input.provenance) ? input.provenance.map(value => str(value, 'provenance', 256)) : [];
      return save({ folderId: `project:${projectId}`, text, kind, provenance: [...provenance, `shared:${sourceId}`] });
    },
  };
  return {
    handlers,
    dispose() {
      removeSettled(); removeContributor?.();
      for (const controller of reflections.values()) controller.abort();
      reflections.clear(); hindsight?.dispose();
    },
  };
}
