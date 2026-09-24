/** Memory domain contract. Add commands here; the allowlist and service dispatch pick them up. */
export type MemoryAutoRetain = 'never' | 'ask' | 'verified';
export type MemorySource = 'local' | 'hindsight';
/** Connected: Hindsight answered. Local only: Hindsight is configured but failing, so local memory carries on. */
export type MemoryConnection = 'connected' | 'unchecked' | 'local-only' | 'not-configured';

/** The API key never crosses to the renderer; only whether one is stored and how. */
export interface MemoryConfigView {
  endpoint: string;
  hasApiKey: boolean;
  keyStorage: 'encrypted' | 'session' | 'environment' | 'none';
  autoRecall: boolean;
  autoRetain: MemoryAutoRetain;
  source: 'app' | 'environment' | 'none';
}

/** apiKey: omitted keeps the stored key, '' removes it. */
export interface MemoryConfigInput { endpoint: string; apiKey?: string; autoRecall: boolean; autoRetain: MemoryAutoRetain }

/** Who shares this scope's memories on the Hindsight server: only you (Personal, or a folder without a git remote),
 *  or everyone working on the same repository (memory-identity.ts). */
export type MemorySharing = 'personal' | 'team' | 'private';
export interface MemoryStatusView { connection: MemoryConnection; endpoint?: string; bankId?: string; checkedAt?: string; error?: string; sharing?: MemorySharing }

export interface MemoryTestResult { ok: boolean; stage: 'config' | 'network' | 'auth' | 'service' | 'ok'; message: string; latencyMs?: number }

/** One row in the unified memory list, whichever store it came from. */
export interface MemoryRecord {
  id: string;
  source: MemorySource;
  text: string;
  kind: string;
  observedAt?: string;
  scope: { kind: string; id: string; label: string };
  provenance: string[];
  score?: number;
  documentId?: string;
  tags?: string[];
  deletable: boolean;
  /** Why this record matched an entity or time filter (MEM-13). */
  why?: string;
}

/** A run lesson waiting for the user: edit and remember it, or dismiss it. */
export interface MemoryOffer { itemId: string; chatId: string; chatTitle: string; runId: string; summary: string; createdAt: string }

export interface MemorySaveResult { local?: MemoryRecord; hindsight: 'saved' | 'queued' | 'skipped' | 'failed'; error?: string }

/** Advanced engine features, gated on the version the server reports (MEM-06). */
export type MemoryCapability = 'listMemories' | 'observations' | 'consolidation' | 'mentalModels' | 'documents' | 'operations' | 'bankAdmin';
export interface MemoryCapabilityView { supported: boolean; requires: string; reason?: string }
export interface MemoryEngineView {
  connection: MemoryConnection;
  /** The version the server reported, when it answered the version probe. */
  version?: string;
  baseline: string;
  capabilities: Record<MemoryCapability, MemoryCapabilityView>;
  checkedAt?: string;
  error?: string;
}

export type MemoryJobKind = 'retain' | 'consolidate' | 'reflect' | 'export' | 'import' | 'delete';
export type MemoryJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface MemoryJob {
  id: string; kind: MemoryJobKind; scope: string; bankId?: string;
  /** The dedupe key: the same kind, scope and operationId never runs twice. */
  operationId: string; engineOperationId?: string;
  status: MemoryJobStatus; detail?: string; error?: string; result?: Record<string, unknown>;
  createdAt: string; updatedAt: string;
}

/** A consolidated belief and the source facts that support it (MEM-10). */
export interface MemoryObservation { id: string; text: string; sourceIds: string[]; sources: MemoryRecord[]; updatedAt?: string; proofCount?: number; tags?: string[] }

export type MemoryModelRefresh = 'manual' | 'daily' | 'weekly' | 'after-consolidation';
export interface MemoryModelVersion { version: number; text: string; sources: number; createdAt: string }
/** A named saved reflection (MEM-11). Stored by the engine when it supports mental models, otherwise locally. */
export interface MemoryMentalModel {
  id: string; name: string; query: string; refresh: MemoryModelRefresh; storage: 'engine' | 'local'; engineId?: string;
  provenance: string[]; text: string; versions: MemoryModelVersion[];
  createdAt: string; refreshedAt?: string; stale: boolean; staleReason?: string; refreshing: boolean;
  /** Filter labels (MEM-11): they narrow which notes feed the model, never who may read it. */
  tags: string[];
  /** Set by Clear: the definition stays, its generated text and history are gone until the next refresh. */
  clearedAt?: string;
}
/** A model's text generated on demand without saving a version (MEM-11 Preview). */
export interface MemoryModelPreview { text: string; provenance: string[]; sources: number; generatedBy: 'hindsight' | 'local' }

/** Directives are rules; dispositions are stances. Both rank below user, system and tool policy when injected (MEM-12). */
export interface MemoryDirective { id: string; kind: 'directive' | 'disposition'; text: string; priority: number; tags: string[]; enabled: boolean; createdAt: string; updatedAt: string }
export interface MemoryDirectiveInput { id?: string; kind: 'directive' | 'disposition'; text: string; priority: number; tags: string[]; enabled: boolean }

/** Entity and temporal recall filters (MEM-13). `validAt` answers "what was true then": notes observed after it are excluded and the newest before it leads. */
export interface MemoryRecallFilters { entities?: string[]; from?: string; to?: string; validAt?: string }
export interface MemoryRecallExcluded { untimed: number; outsideRange: number; noEntity: number }

/** A source document whose deletion Muster enforces locally and reconciles with the engine (MEM-14). */
export type MemoryDeleteEngineState = 'deleted' | 'queued' | 'unsupported' | 'skipped';
export interface MemoryPendingDelete {
  documentId: string; scope: string; bankId?: string;
  engine: 'pending' | 'deleted' | 'failed';
  attempts: number; lastError?: string; nextAttemptAt?: string; createdAt: string; updatedAt: string;
}

export type MemoryExportPart = 'facts' | 'observations' | 'models' | 'directives';
export interface MemoryExportManifest {
  format: 'muster-memory-export'; formatVersion: 1; createdAt: string;
  bankId?: string; scope: { kind: string; id: string; label: string }; parts: MemoryExportPart[];
  counts: Record<MemoryExportPart, number>; engine: { version?: string; endpoint?: string };
  file: { name: string; sha256: string; lines: number };
  /** Set on backups: which import or deletion it protects. */
  reason?: string;
}
export interface MemoryArchive { id: string; kind: 'export' | 'backup'; path: string; manifest: MemoryExportManifest }
export interface MemoryImportPreview { archive: MemoryArchive; importable: Record<'facts' | 'models' | 'directives', number>; duplicates: number; skipped: string[]; sample: { type: string; text: string }[] }
export interface MemoryBankPreview { bankId?: string; scopeLabel: string; local: number; hindsight?: number; documents?: number; models: number; directives: number; engineDelete: boolean }
type Budget = 'low' | 'mid' | 'high';
type RecallType = 'world' | 'experience' | 'observation';

export interface MemoryCommands {
  'memory.config.get': { input: Record<string, never>; output: MemoryConfigView };
  'memory.config.set': { input: MemoryConfigInput; output: MemoryConfigView };
  'memory.config.test': { input: { folderId?: string }; output: MemoryTestResult };
  'memory.status': { input: { folderId?: string }; output: MemoryStatusView };
  /** Local entries (a query filters them), plus Hindsight recall results when a query is given. */
  'memory.browse': { input: { folderId?: string; query?: string } & MemoryRecallFilters; output: { records: MemoryRecord[]; status: MemoryStatusView; excluded?: MemoryRecallExcluded } };
  /** Tags filter results only; they never widen or authorize a scope. Entity/time filters apply to the engine's results in Muster. */
  'memory.recall': { input: { folderId?: string; query: string; budget?: Budget; maxTokens?: number; types?: RecallType[]; tags?: string[] } & MemoryRecallFilters; output: { bankId: string; records: MemoryRecord[]; excluded?: MemoryRecallExcluded } };
  'memory.reflect': { input: { folderId?: string; query: string; requestId: string; context?: string; budget?: Budget; maxTokens?: number }; output: { bankId: string; text: string; sources: MemoryRecord[]; cancelled?: boolean } };
  'memory.reflect.cancel': { input: { requestId: string }; output: { cancelled: boolean } };
  'memory.delete': { input: { folderId?: string; id: string }; output: { deleted: boolean } };
  /** Saves locally in the chat's (or folder's) scope, and to Hindsight when it is configured. */
  'memory.rememberText': { input: { chatId?: string; folderId?: string; text: string; kind?: string; source?: string }; output: MemorySaveResult };
  'memory.retainFromRun': { input: { chatId: string; runId: string; summary: string }; output: MemorySaveResult };
  /** Pending run lessons for chats in this scope, newest first. */
  'memory.offers': { input: { folderId?: string }; output: { offers: MemoryOffer[] } };
  'memory.offer.dismiss': { input: { chatId: string; runId: string }; output: { dismissed: boolean } };
  /** Probes the engine version and capabilities; cached for a few minutes unless `refresh`. */
  'memory.engine': { input: { folderId?: string; refresh?: boolean }; output: MemoryEngineView };
  'memory.observations': { input: { folderId?: string }; output: { facts: MemoryRecord[]; observations: MemoryObservation[]; consolidation?: MemoryJob } };
  'memory.consolidate': { input: { folderId?: string; operationId: string }; output: MemoryJob };
  /** Recent jobs for the scope; running engine operations are polled before answering. */
  'memory.jobs': { input: { folderId?: string }; output: { jobs: MemoryJob[] } };
  'memory.models.list': { input: { folderId?: string }; output: { models: MemoryMentalModel[] } };
  'memory.models.save': { input: { folderId?: string; id?: string; name: string; query: string; refresh: MemoryModelRefresh; tags?: string[] }; output: MemoryMentalModel };
  'memory.models.refresh': { input: { folderId?: string; id: string }; output: MemoryMentalModel };
  /** Generates what a model would say now, without saving a version. Give `id` for a saved model, or a query (and tags) for a draft. */
  'memory.models.preview': { input: { folderId?: string; id?: string; query?: string; tags?: string[] }; output: MemoryModelPreview };
  /** Empties a model's text and version history but keeps its definition. Source facts are never touched. */
  'memory.models.clear': { input: { folderId?: string; id: string }; output: MemoryMentalModel };
  'memory.models.delete': { input: { folderId?: string; id: string }; output: { deleted: boolean } };
  'memory.directives.list': { input: { folderId?: string }; output: { directives: MemoryDirective[] } };
  'memory.directives.save': { input: { folderId?: string; directive: MemoryDirectiveInput }; output: MemoryDirective };
  'memory.directives.delete': { input: { folderId?: string; id: string }; output: { deleted: boolean } };
  /** Replaces a fact's text: the old one stops being recalled and the new one records what it corrects. */
  'memory.correct': { input: { folderId?: string; id: string; source: MemorySource; text: string; documentId?: string; kind?: string }; output: MemorySaveResult };
  /** Deletes a whole source document from the engine and tombstones it locally so recall never returns it again. */
  /** Suppressed in Muster at once; the engine copy is deleted when the engine supports it, otherwise queued for retry. */
  'memory.document.delete': { input: { folderId?: string; documentId: string }; output: { engine: MemoryDeleteEngineState; local: number; pending?: MemoryPendingDelete } };
  /** Engine deletions not yet confirmed for this scope. */
  'memory.deletes.list': { input: { folderId?: string }; output: { deletes: MemoryPendingDelete[] } };
  /** Retries queued engine deletions for this scope now (also runs on its own when Memory is read). */
  'memory.deletes.retry': { input: { folderId?: string }; output: { attempted: number; deleted: number; deletes: MemoryPendingDelete[] } };
  'memory.bank.preview': { input: { folderId?: string }; output: MemoryBankPreview };
  /** `confirm` must repeat the scope label shown in the preview. A backup is written first. */
  'memory.bank.delete': { input: { folderId?: string; confirm: string }; output: { backup: MemoryArchive; local: number; engine: 'deleted' | 'unsupported' | 'skipped' } };
  'memory.export': { input: { folderId?: string; parts: MemoryExportPart[] }; output: { archive: MemoryArchive; job: MemoryJob } };
  'memory.archives': { input: Record<string, never>; output: { archives: MemoryArchive[] } };
  'memory.import.preview': { input: { folderId?: string; archiveId: string }; output: MemoryImportPreview };
  'memory.import.apply': { input: { folderId?: string; archiveId: string; operationId: string; skipDuplicates: boolean }; output: { backup: MemoryArchive; imported: Record<'facts' | 'models' | 'directives', number>; job: MemoryJob } };
  /** MEM-X2: the local notes the next turn of this chat would recall for `prompt` (engine results join at send time). No engine call. */
  'memory.recall.preview': { input: { chatId: string; prompt: string }; output: MemoryRecallPreview };
  /** MEM-X2: leave one note out of (or back into) this chat's automatic recall for the rest of the session. */
  'memory.recall.exclude': { input: { chatId: string; id: string; text?: string; excluded: boolean }; output: { excluded: MemoryRecallChipItem[] } };
  /** Copies a memory into a Project's bank, keeping where it came from. */
  'memory.share': { input: { folderId?: string; projectId: string; text: string; kind: string; provenance: string[]; sourceId: string }; output: MemorySaveResult };
}
export interface MemoryRecallChipItem { id: string; text: string; source: MemorySource; scope: string; observedAt?: string }
/** `enabled` is false when auto-recall is off; `engine` is true when engine results will also be asked for at send time. */
export interface MemoryRecallPreview { enabled: boolean; engine: boolean; records: MemoryRecallChipItem[]; excluded: MemoryRecallChipItem[] }
export type MemoryEvent = never;
export const MEMORY_COMMANDS = {
  'memory.config.get': true, 'memory.config.set': true, 'memory.config.test': true, 'memory.status': true, 'memory.browse': true,
  'memory.recall': true, 'memory.reflect': true, 'memory.reflect.cancel': true, 'memory.delete': true, 'memory.rememberText': true, 'memory.retainFromRun': true,
  'memory.offers': true, 'memory.offer.dismiss': true, 'memory.recall.preview': true, 'memory.recall.exclude': true,
  'memory.engine': true, 'memory.observations': true, 'memory.consolidate': true, 'memory.jobs': true,
  'memory.models.list': true, 'memory.models.save': true, 'memory.models.refresh': true, 'memory.models.delete': true, 'memory.models.preview': true, 'memory.models.clear': true,
  'memory.directives.list': true, 'memory.directives.save': true, 'memory.directives.delete': true,
  'memory.correct': true, 'memory.document.delete': true, 'memory.deletes.list': true, 'memory.deletes.retry': true, 'memory.bank.preview': true, 'memory.bank.delete': true,
  'memory.export': true, 'memory.archives': true, 'memory.import.preview': true, 'memory.import.apply': true, 'memory.share': true,
} as const satisfies Record<keyof MemoryCommands, true>;
