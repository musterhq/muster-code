/**
 * Durable agent state on node:sqlite (WAL). Every mutation is transactional;
 * the send receipt is persisted BEFORE any model call so a crashed process
 * never double-dispatches a requestId.
 */
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSchemaMigrations, type MigrationResult, type SchemaMigration } from './schema-migrations.ts';
import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_CHAT_TITLE, generateChatTitle } from './chat-title.ts';
import type { Chat, ChatRecovery, ChatTitleSource, ChatStatus, ContextTelemetry, Folder, Project, QueuedMessage, Snapshot, TimelineItem } from '../shared/protocol.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, goal TEXT NOT NULL, folder_ids TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY, folder_id TEXT, project_id TEXT, title TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0, pin_order INTEGER, archived INTEGER NOT NULL DEFAULT 0,
  draft TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'idle',
  updated_at TEXT NOT NULL, provider_thread_id TEXT, model TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'agent', error TEXT, provider_turn_id TEXT, recovery TEXT, permission_mode TEXT, provider_id TEXT NOT NULL DEFAULT 'hybrow', provider_binding_id TEXT, provider_thread_provider_id TEXT, provider_thread_binding_id TEXT);
CREATE TABLE IF NOT EXISTS timeline (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, chat_id TEXT NOT NULL,
  kind TEXT NOT NULL, text TEXT NOT NULL, status TEXT, created_at TEXT NOT NULL, data TEXT);
CREATE INDEX IF NOT EXISTS timeline_chat ON timeline (chat_id, seq);
CREATE TABLE IF NOT EXISTS timeline_cursors (
  chat_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS timeline_changes (
  chat_id TEXT NOT NULL, seq INTEGER NOT NULL, revision INTEGER NOT NULL,
  PRIMARY KEY (chat_id, seq));
CREATE INDEX IF NOT EXISTS timeline_changes_chat_revision ON timeline_changes (chat_id, revision);
CREATE TABLE IF NOT EXISTS receipts (
  request_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, run_id TEXT NOT NULL, created_at TEXT NOT NULL, fingerprint TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS context_telemetry (
  chat_id TEXT PRIMARY KEY, used_tokens INTEGER, window_tokens INTEGER,
  source TEXT, compacted INTEGER NOT NULL DEFAULT 0, updated_at TEXT);
CREATE TABLE IF NOT EXISTS chat_queue (
  chat_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, text TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE, attachment_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, id));
CREATE INDEX IF NOT EXISTS chat_queue_order ON chat_queue (chat_id, position);
`;

interface ChatRow {
  id: string; folder_id: string | null; project_id: string | null; title: string;
  pinned: number; pin_order: number | null; archived: number; draft: string; status: string; updated_at: string;
  provider_id: string; provider_binding_id: string | null; provider_thread_provider_id: string | null; provider_thread_binding_id: string | null; provider_thread_id: string | null; provider_turn_id: string | null; recovery: string | null; model: string; mode: string; permission_mode: string | null; error: string | null;
  unread?: number | null; last_viewed_at?: string | null;
  title_source?: string | null; origin_chat_id?: string | null; origin_item_id?: string | null;
  snoozed_until?: string | null; snooze_activity?: number | null;
}
interface TimelineRow {
  id: string; chat_id: string; kind: string; text: string; status: string | null;
  created_at: string; data: string | null;
}

function rowToChat(row: ChatRow): Chat {
  return {
    id: row.id,
    ...(row.folder_id ? { folderId: row.folder_id } : {}),
    ...(row.project_id ? { projectId: row.project_id } : {}),
    title: row.title,
    pinned: row.pinned === 1,
    ...(row.pin_order === null ? {} : { pinOrder: row.pin_order }),
    archived: row.archived === 1,
    draft: row.draft,
    status: row.status as ChatStatus,
    updatedAt: row.updated_at,
    providerId: row.provider_id ?? 'hybrow',
    ...(row.provider_binding_id ? {providerBindingId:row.provider_binding_id} : {}),
    ...(row.provider_thread_provider_id ? {providerThreadProviderId:row.provider_thread_provider_id} : {}),
    ...(row.provider_thread_binding_id ? {providerThreadBindingId:row.provider_thread_binding_id} : {}),
    ...(row.provider_thread_id ? { providerThreadId: row.provider_thread_id } : {}),
    ...(row.provider_turn_id ? { providerTurnId: row.provider_turn_id } : {}),
    ...(row.recovery ? { recovery: readRecovery(row.recovery) } : {}),
    model: row.model,
    mode: row.mode as Chat['mode'],
    ...(row.permission_mode ? {permissionMode: row.permission_mode as Chat['permissionMode']} : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.unread === 1 ? { unread: true } : {}),
    ...(row.last_viewed_at ? { lastViewedAt: row.last_viewed_at } : {}),
    titleSource: titleSource(row),
    ...(row.origin_chat_id ? { originChatId: row.origin_chat_id } : {}),
    ...(row.origin_item_id ? { originItemId: row.origin_item_id } : {}),
    ...(row.snoozed_until ? { snoozedUntil: row.snoozed_until } : {}),
    ...(row.snooze_activity === 1 ? { snoozeUntilActivity: true } : {}),
  };
}

/** Chats saved before titleSource existed: an untouched 'New chat' is still default; anything else keeps its name. */
function titleSource(row: ChatRow): ChatTitleSource {
  const value = row.title_source;
  return value === 'default' || value === 'generated' || value === 'user' ? value : row.title === DEFAULT_CHAT_TITLE ? 'default' : 'generated';
}
/** Copied history is read-only: nothing in it can still be running or waiting for an answer. */
const settledStatus = (status: string | null): string | null => status === 'running' ? 'interrupted' : status === 'pending' ? 'unavailable' : status;

function readRecovery(value: string): ChatRecovery {
  try {
    const parsed = JSON.parse(value) as ChatRecovery;
    if (parsed && ['admission-rejected','recovery-needed','failed','cancelled'].includes(parsed.kind) && typeof parsed.retryable === 'boolean' && typeof parsed.reason === 'string') return parsed;
  } catch { /* Unknown recovery state must not silently unlock dispatch. */ }
  return {kind:'recovery-needed',retryable:false,reason:'Saved provider recovery information is unavailable. Check the existing provider thread before continuing.'};
}

function rowToItem(row: TimelineRow): TimelineItem {
  return {
    id: row.id,
    chatId: row.chat_id,
    kind: row.kind as TimelineItem['kind'],
    text: row.text,
    ...(row.status ? { status: row.status } : {}),
    createdAt: row.created_at,
    ...(row.data ? { data: JSON.parse(row.data) as Record<string, unknown> } : {}),
  };
}

interface QueueRow { chat_id: string; id: string; text: string; request_id: string; attachment_ids: string; created_at: string }
function rowToQueued(row: QueueRow): QueuedMessage {
  let attachmentIds: string[] = [];
  try { const parsed: unknown = JSON.parse(row.attachment_ids); if (Array.isArray(parsed)) attachmentIds = parsed.filter((value): value is string => typeof value === 'string'); } catch { /* A corrupt list sends no attachments. */ }
  return { id: row.id, text: row.text, requestId: row.request_id, attachmentIds, createdAt: row.created_at };
}

/** PER-08: ordered, versioned schema steps. Additive column checks in the constructor stay idempotent for
 * pre-versioning databases; new schema changes go here so they get a backup, a transaction and a version. */
export const STORE_MIGRATIONS: readonly SchemaMigration[] = [
  {version: 1, name: 'adopt versioned schema', up: () => { /* Baseline: tables and columns as of 0.2.0 (created idempotently by SCHEMA). */ }},
];

const now = (): string => new Date().toISOString();
const PROJECT_CHAT_EXPORT_LIMIT = 201;

export class AgentStore {
  private readonly db: DatabaseSync;
  /** What opening this database migrated (and where the pre-upgrade backup is). */
  readonly schemaMigration: MigrationResult;

  /** Raw handle for runtime modules that keep their own tables in this database. */
  database(): DatabaseSync { return this.db; }

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, 'muster-agent.sqlite'));
    chmodSync(join(dataDir, 'muster-agent.sqlite'), 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
    // PER-08: versioned upgrades. An existing database is backed up before any pending step runs.
    this.schemaMigration = runSchemaMigrations(this.db, join(dataDir, 'muster-agent.sqlite'), STORE_MIGRATIONS);
    this.db.exec(SCHEMA);
    this.migrateTimelineChanges();
    this.ensureTimelineTriggers();
    // Existing timelines start at an empty delta baseline. Triggers above
    // govern all subsequent inserts/updates and roll back with their tx.
    this.db.exec("INSERT OR IGNORE INTO timeline_cursors (chat_id, revision) SELECT DISTINCT chat_id, 0 FROM timeline");
    // Additive migration for databases created before pin ordering existed.
    const chatColumns = this.db.prepare("SELECT name FROM pragma_table_info('chats')").all() as { name: string }[];
    if (!chatColumns.some((c) => c.name === 'pin_order')) this.db.exec('ALTER TABLE chats ADD COLUMN pin_order INTEGER');
    if (!chatColumns.some((c) => c.name === 'provider_turn_id')) this.db.exec('ALTER TABLE chats ADD COLUMN provider_turn_id TEXT');
    if (!chatColumns.some((c) => c.name === 'recovery')) this.db.exec('ALTER TABLE chats ADD COLUMN recovery TEXT');
    if (!chatColumns.some((c) => c.name === 'permission_mode')) this.db.exec('ALTER TABLE chats ADD COLUMN permission_mode TEXT');
    if (!chatColumns.some((c) => c.name === 'provider_id')) this.db.exec("ALTER TABLE chats ADD COLUMN provider_id TEXT NOT NULL DEFAULT 'hybrow'");
    for (const column of ['provider_binding_id','provider_thread_provider_id','provider_thread_binding_id','last_viewed_at']) if (!chatColumns.some(c=>c.name===column)) this.db.exec(`ALTER TABLE chats ADD COLUMN ${column} TEXT`);
    if (!chatColumns.some(c=>c.name==='unread')) this.db.exec('ALTER TABLE chats ADD COLUMN unread INTEGER NOT NULL DEFAULT 0');
    for (const column of ['title_source','origin_chat_id','origin_item_id']) if (!chatColumns.some(c=>c.name===column)) this.db.exec(`ALTER TABLE chats ADD COLUMN ${column} TEXT`);
    // 1 while the next send must seed a fresh provider conversation with the visible history (a fork, or an edit that replaced turns).
    if (!chatColumns.some(c=>c.name==='resume_digest')) this.db.exec('ALTER TABLE chats ADD COLUMN resume_digest INTEGER NOT NULL DEFAULT 0');
    // CHAT-15 snooze: an absolute wake instant and/or "until new activity".
    if (!chatColumns.some(c=>c.name==='snoozed_until')) this.db.exec('ALTER TABLE chats ADD COLUMN snoozed_until TEXT');
    if (!chatColumns.some(c=>c.name==='snooze_activity')) this.db.exec('ALTER TABLE chats ADD COLUMN snooze_activity INTEGER NOT NULL DEFAULT 0');
    // NAV-05: manual sidebar folder order (NULL = after every ordered folder, by creation).
    const folderColumns = this.db.prepare("SELECT name FROM pragma_table_info('folders')").all() as { name: string }[];
    if (!folderColumns.some(c=>c.name==='position')) this.db.exec('ALTER TABLE folders ADD COLUMN position INTEGER');
    // UR-SR-a: the Agent/Ask/Plan picker is gone, so a legacy 'ask' chat could never regain write access. It becomes an
    // Agent chat that keeps its read-only policy (unless one was already chosen); the access chip can raise it again.
    this.db.exec("UPDATE chats SET mode='agent', permission_mode=COALESCE(permission_mode,'read-only') WHERE mode='ask'");
  }

  /** Migrate the pre-release append-only journal to one row per timeline item. */
  private migrateTimelineChanges(): void {
    const columns = this.db.prepare("SELECT name, pk FROM pragma_table_info('timeline_changes')").all() as { name: string; pk: number }[];
    const oldShape = columns.some((column) => column.name === 'revision' && column.pk === 2) && columns.some((column) => column.name === 'seq' && column.pk === 0);
    if (!oldShape) return;
    this.tx(() => {
    this.db.exec('DROP TRIGGER IF EXISTS timeline_revision_insert; DROP TRIGGER IF EXISTS timeline_revision_update;');
    this.db.exec('DROP INDEX IF EXISTS timeline_changes_chat_revision;');
    this.db.exec('ALTER TABLE timeline_changes RENAME TO timeline_changes_legacy;');
    this.db.exec('CREATE TABLE timeline_changes (chat_id TEXT NOT NULL, seq INTEGER NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY (chat_id, seq));');
    this.db.exec('CREATE INDEX timeline_changes_chat_revision ON timeline_changes (chat_id, revision);');
    this.db.exec('INSERT INTO timeline_changes (chat_id, seq, revision) SELECT chat_id, seq, MAX(revision) FROM timeline_changes_legacy GROUP BY chat_id, seq;');
    this.db.exec('DROP TABLE timeline_changes_legacy;');
    });
  }

  private ensureTimelineTriggers(): void {
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS timeline_revision_insert AFTER INSERT ON timeline BEGIN
        INSERT INTO timeline_cursors (chat_id, revision) VALUES (NEW.chat_id, 1)
          ON CONFLICT(chat_id) DO UPDATE SET revision = revision + 1;
        INSERT INTO timeline_changes (chat_id, seq, revision)
          SELECT NEW.chat_id, NEW.seq, revision FROM timeline_cursors WHERE chat_id = NEW.chat_id
          ON CONFLICT(chat_id, seq) DO UPDATE SET revision = excluded.revision;
      END;
      CREATE TRIGGER IF NOT EXISTS timeline_revision_update AFTER UPDATE OF kind, text, status, data, created_at ON timeline BEGIN
        INSERT INTO timeline_cursors (chat_id, revision) VALUES (NEW.chat_id, 1)
          ON CONFLICT(chat_id) DO UPDATE SET revision = revision + 1;
        INSERT INTO timeline_changes (chat_id, seq, revision)
          SELECT NEW.chat_id, NEW.seq, revision FROM timeline_cursors WHERE chat_id = NEW.chat_id
          ON CONFLICT(chat_id, seq) DO UPDATE SET revision = excluded.revision;
      END;
    `);
  }

  /** Run `fn` inside a transaction; rolls back on throw. */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private bumpVersion(): void {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES ('version', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)")
      .run();
  }

  private getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  snapshot(): Snapshot {
    const folders = (this.db.prepare('SELECT * FROM folders ORDER BY position IS NULL, position, created_at').all() as unknown as { id: string; path: string; name: string }[])
      .map(({ id, path, name }) => ({ id, path, name }));
    const queues = new Map<string, QueuedMessage[]>();
    for (const row of this.db.prepare('SELECT * FROM chat_queue ORDER BY chat_id, position').all() as unknown as QueueRow[]) {
      const list = queues.get(row.chat_id) ?? []; list.push(rowToQueued(row)); queues.set(row.chat_id, list);
    }
    const chats = (this.db.prepare('SELECT * FROM chats ORDER BY updated_at DESC').all() as unknown as ChatRow[]).map(row => {
      const chat = rowToChat(row), queue = queues.get(chat.id);
      return queue ? {...chat, queue} : chat;
    });
    // primary_folder_id and archived are added lazily by the projects domain, so both stay optional.
    const projects = (this.db.prepare('SELECT * FROM projects').all() as unknown as { id: string; name: string; goal: string; folder_ids: string; primary_folder_id?: string | null; archived?: number | null }[])
      .map(({ id, name, goal, folder_ids, primary_folder_id, archived }) => ({ id, name, goal, folderIds: JSON.parse(folder_ids) as string[], ...(primary_folder_id ? { primaryFolderId: primary_folder_id } : {}), ...(archived ? { archived: true } : {}) }));
    const activeChatId = this.getMeta('activeChatId');
    return {
      folders,
      chats,
      projects,
      ...(activeChatId ? { activeChatId } : {}),
      version: Number(this.getMeta('version') ?? '0'),
    };
  }

  addFolder(path: string, name: string): Folder {
    return this.tx(() => {
      const existing = this.db.prepare('SELECT id, path, name FROM folders WHERE path = ?').get(path) as Folder | undefined;
      if (existing) return { id: existing.id, path: existing.path, name: existing.name };
      const folder: Folder = { id: randomUUID(), path, name };
      this.db.prepare('INSERT INTO folders (id, path, name, created_at) VALUES (?, ?, ?, ?)').run(folder.id, path, name, now());
      this.bumpVersion();
      return folder;
    });
  }

  /** Display label only; the path and every chat binding stay as they are. */
  renameFolder(id: string, name: string): Folder {
    return this.tx(() => {
      if (this.db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, id).changes === 0) throw new Error('Folder does not exist.');
      this.bumpVersion();
      return this.folder(id)!;
    });
  }

  /** Point an existing folder (and so its chats, projects and memory) at the folder's new location. */
  relinkFolder(id: string, path: string): Folder {
    return this.tx(() => {
      if (!this.folder(id)) throw new Error('Folder does not exist.');
      const other = this.db.prepare('SELECT id, name FROM folders WHERE path = ? AND id != ?').get(path, id) as { id: string; name: string } | undefined;
      if (other) throw new Error(`That location is already in the sidebar as “${other.name}”.`);
      this.db.prepare('UPDATE folders SET path = ? WHERE id = ?').run(path, id);
      this.bumpVersion();
      return this.folder(id)!;
    });
  }

  /** Remove a folder from the sidebar. Chats keep their (now stale) binding so a restored chat reports the missing folder
   *  instead of silently running elsewhere; `archiveChats` archives the live ones in the same transaction. */
  removeFolder(id: string, archiveChats: boolean): number {
    return this.tx(() => {
      if (!this.folder(id)) throw new Error('Folder does not exist.');
      const live = (this.db.prepare('SELECT COUNT(*) AS n FROM chats WHERE folder_id = ? AND archived = 0').get(id) as { n: number }).n;
      if (live && !archiveChats) throw new Error(`${live} chat${live === 1 ? ' uses' : 's use'} this folder. Archive ${live === 1 ? 'it' : 'them'} to remove the folder.`);
      if (live) this.db.prepare('UPDATE chats SET archived = 1, pinned = 0, pin_order = NULL WHERE folder_id = ? AND archived = 0').run(id);
      for (const row of this.db.prepare('SELECT id, folder_ids FROM projects').all() as { id: string; folder_ids: string }[]) {
        let folderIds: unknown; try { folderIds = JSON.parse(row.folder_ids); } catch { continue; }
        if (Array.isArray(folderIds) && folderIds.includes(id)) this.db.prepare('UPDATE projects SET folder_ids = ? WHERE id = ?').run(JSON.stringify(folderIds.filter(value => value !== id)), row.id);
      }
      this.db.prepare('DELETE FROM folders WHERE id = ?').run(id);
      this.bumpVersion();
      return live;
    });
  }

  folder(id: string): Folder | undefined {
    const row = this.db.prepare('SELECT id, path, name FROM folders WHERE id = ?').get(id) as Folder | undefined;
    return row ? { id: row.id, path: row.path, name: row.name } : undefined;
  }

  project(id: string): Project | undefined {
    const row = this.db.prepare('SELECT id, name, goal, folder_ids FROM projects WHERE id = ?').get(id) as
      | { id: string; name: string; goal: string; folder_ids: string }
      | undefined;
    if (!row) return undefined;
    let folderIds: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.folder_ids);
      if (Array.isArray(parsed) && parsed.every(value => typeof value === 'string')) folderIds = parsed;
    } catch { /* Corrupt legacy folder list degrades to an empty attachment set. */ }
    return { id: row.id, name: row.name, goal: row.goal, folderIds };
  }

  /** Read only the latest bounded chat references for one Project export. */
  projectChats(id: string): Chat[] {
    const rows = this.db.prepare('SELECT * FROM chats WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?').all(id, PROJECT_CHAT_EXPORT_LIMIT) as unknown as ChatRow[];
    return rows.map(rowToChat);
  }

  createProject(name: string, goal: string, folderIds: string[]): Project {
    return this.tx(() => {
      for (const folderId of folderIds) {
        if (!this.folder(folderId)) throw new Error(`Unknown folder: ${folderId}`);
      }
      const project: Project = { id: randomUUID(), name, goal, folderIds };
      this.db.prepare('INSERT INTO projects (id, name, goal, folder_ids) VALUES (?, ?, ?, ?)')
        .run(project.id, name, goal, JSON.stringify(folderIds));
      this.bumpVersion();
      return project;
    });
  }

  createChat(input: { folderId?: string; projectId?: string; model: string; mode: Chat['mode']; permissionMode?: Chat['permissionMode'] }): Chat {
    return this.tx(() => {
      if (input.folderId && !this.folder(input.folderId)) throw new Error(`Unknown folder: ${input.folderId}`);
      if (input.projectId) {
        const project = this.db.prepare('SELECT folder_ids FROM projects WHERE id = ?').get(input.projectId) as {folder_ids: string} | undefined;
        if (!project) throw new Error(`Unknown project: ${input.projectId}`);
        const folderIds: string[] = JSON.parse(project.folder_ids);
        if (input.folderId && !folderIds.includes(input.folderId)) {
          throw new Error('The selected folder is not attached to this Project.');
        }
        if (!input.folderId && folderIds.length === 1) input = {...input, folderId: folderIds[0]};
        if (!input.folderId && folderIds.length > 1) throw new Error('Choose a Project folder for this chat.');
      }
      const id = randomUUID();
      this.db.prepare(
        "INSERT INTO chats (id, folder_id, project_id, title, updated_at, model, mode, permission_mode, title_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'default')",
      ).run(id, input.folderId ?? null, input.projectId ?? null, DEFAULT_CHAT_TITLE, now(), input.model, input.mode, input.permissionMode ?? null);
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('activeChatId', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(id);
      this.bumpVersion();
      return this.chat(id)!;
    });
  }

  chat(id: string): Chat | undefined {
    const row = this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as ChatRow | undefined;
    return row ? rowToChat(row) : undefined;
  }

  updateChat(id: string, patch: Partial<Pick<Chat, 'title' | 'titleSource' | 'pinned' | 'archived' | 'draft' | 'model' | 'mode' | 'permissionMode' | 'status' | 'providerId' | 'providerBindingId'>> & {providerThreadId?:string|null; providerThreadProviderId?:string|null; providerThreadBindingId?:string|null; providerTurnId?: string | null; recovery?: ChatRecovery | null; error?: string | null}): Chat {
    return this.tx(() => {
      const current = this.chat(id);
      if (!current) throw new Error(`Unknown chat: ${id}`);
      // CHAT-16 stable ordering: updated_at is last *activity*. Metadata-only edits (rename, pin, archive, draft, model,
      // mode, access, provider choice) never move a chat in the Recent sort.
      const activity = ['status', 'error', 'providerThreadId', 'providerTurnId', 'recovery'].some(key => (patch as Record<string, unknown>)[key] !== undefined);
      const sets: string[] = activity ? ['updated_at = ?'] : [];
      const values: (string | number | null)[] = activity ? [now()] : [];
      const map: Record<string, string> = {
        title: 'title', draft: 'draft', model: 'model', mode: 'mode', permissionMode: 'permission_mode', status: 'status', error: 'error', providerId:'provider_id', providerBindingId:'provider_binding_id', providerThreadProviderId:'provider_thread_provider_id', providerThreadBindingId:'provider_thread_binding_id', providerThreadId: 'provider_thread_id', providerTurnId: 'provider_turn_id',
      };
      for (const [key, column] of Object.entries(map)) {
        const value = (patch as Record<string, unknown>)[key];
        if (value !== undefined) { sets.push(`${column} = ?`); values.push(value as string | null); }
      }
      // A title set through here is a rename: generated titles never replace it.
      if (patch.title !== undefined || patch.titleSource !== undefined) { sets.push('title_source = ?'); values.push(patch.titleSource ?? 'user'); }
      if (patch.recovery !== undefined) { sets.push('recovery = ?'); values.push(patch.recovery === null ? null : JSON.stringify(patch.recovery)); }
      for (const key of ['pinned', 'archived'] as const) {
        if (patch[key] !== undefined) { sets.push(`${key} = ?`); values.push(patch[key] ? 1 : 0); }
      }
      if (patch.pinned !== undefined && patch.pinned !== current.pinned) {
        // Pin appends to the end of the pinned list; unpin clears the slot.
        sets.push('pin_order = ?');
        if (patch.pinned) {
          const row = this.db.prepare('SELECT MAX(pin_order) AS m FROM chats WHERE pinned = 1').get() as { m: number | null };
          values.push((row.m ?? 0) + 1);
        } else {
          values.push(null);
        }
      }
      if (sets.length) this.db.prepare(`UPDATE chats SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
      this.bumpVersion();
      return this.chat(id)!;
    });
  }

  /** UX-12/UX-23: set the whole visible pinned order at once (drag reorder). `ids` must be exactly the pinned, unarchived,
   *  awake chats (the Pinned group); snoozed pins keep their relative order after them until they wake. */
  reorderPins(ids: readonly string[]): void {
    this.tx(() => {
      const rows = this.db.prepare('SELECT id, snoozed_until, snooze_activity FROM chats WHERE pinned = 1 AND archived = 0 ORDER BY pin_order IS NULL, pin_order, updated_at DESC').all() as { id: string; snoozed_until: string | null; snooze_activity: number }[];
      const pinned = rows.filter(row => !row.snoozed_until && row.snooze_activity !== 1).map(row => row.id);
      if (ids.length !== pinned.length || new Set(ids).size !== ids.length || !ids.every(id => pinned.includes(id))) throw new Error('The pinned list changed. Try the move again.');
      const set = this.db.prepare('UPDATE chats SET pin_order = ? WHERE id = ?');
      [...ids, ...rows.map(row => row.id).filter(id => !pinned.includes(id))].forEach((id, index) => set.run(index + 1, id));
      this.bumpVersion();
    });
  }

  /** NAV-05: full folder order (every folder id). Positions become dense 1..n. */
  reorderFolders(ids: readonly string[]): void {
    this.tx(() => {
      const all = (this.db.prepare('SELECT id FROM folders').all() as { id: string }[]).map(row => row.id);
      if (ids.length !== all.length || new Set(ids).size !== ids.length || !ids.every(id => all.includes(id))) throw new Error('The folder list changed. Try the move again.');
      const set = this.db.prepare('UPDATE folders SET position = ? WHERE id = ?');
      ids.forEach((id, index) => set.run(index + 1, id));
      this.bumpVersion();
    });
  }

  /** NAV-05 keyboard/menu equivalent of a drag: swap with the neighbour in the visible order. No-op at either end. */
  moveFolder(id: string, direction: 'up' | 'down'): void {
    const order = this.snapshot().folders.map(folder => folder.id);
    const index = order.indexOf(id);
    if (index < 0) throw new Error('Folder does not exist.');
    const other = direction === 'up' ? index - 1 : index + 1;
    if (other < 0 || other >= order.length) return;
    [order[index], order[other]] = [order[other]!, order[index]!];
    this.reorderFolders(order);
  }

  /** CHAT-15: sleep until `until` (ISO instant) and/or new activity. Never touches status, draft or updated_at. */
  snoozeChat(id: string, until: string | null, untilActivity: boolean): Chat {
    return this.tx(() => {
      if (this.db.prepare('UPDATE chats SET snoozed_until = ?, snooze_activity = ? WHERE id = ?').run(until, untilActivity ? 1 : 0, id).changes === 0) throw new Error(`Unknown chat: ${id}`);
      this.bumpVersion();
      return this.chat(id)!;
    });
  }

  /** CHAT-15: clear a snooze. Returns false when the chat was already awake, so a wake is one transition however it races
   *  (timer, activity, manual, restart). A timed or activity wake marks the chat unread; a manual wake does not. */
  wakeChat(id: string, markUnread: boolean): boolean {
    return this.tx(() => {
      const changed = this.db.prepare('UPDATE chats SET snoozed_until = NULL, snooze_activity = 0' + (markUnread ? ', unread = 1' : '') + ' WHERE id = ? AND (snoozed_until IS NOT NULL OR snooze_activity = 1)').run(id).changes > 0;
      if (changed) this.bumpVersion();
      return changed;
    });
  }

  /** Chats whose timed snooze is due at `at`, plus the next future wake instant (for the timer). */
  dueSnoozes(at: Date): { due: string[]; next?: string } {
    const iso = at.toISOString();
    const due = (this.db.prepare('SELECT id FROM chats WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?').all(iso) as { id: string }[]).map(row => row.id);
    const next = (this.db.prepare('SELECT MIN(snoozed_until) AS next FROM chats WHERE snoozed_until > ?').get(iso) as { next: string | null }).next;
    return { due, ...(next ? { next } : {}) };
  }

  /** CHAT-16: archive idle chats last active before `cutoff`. Pinned, snoozed, running, queued chats and `exclude`
   *  (needs-attention) are never touched; archiving is metadata, so updated_at stays. Returns the archived ids. */
  autoArchiveIdle(cutoff: string, exclude: ReadonlySet<string>): string[] {
    return this.tx(() => {
      const rows = this.db.prepare(
        "SELECT id FROM chats WHERE archived = 0 AND pinned = 0 AND status NOT IN ('running', 'stopping') AND snoozed_until IS NULL AND snooze_activity = 0 AND updated_at < ? AND NOT EXISTS (SELECT 1 FROM chat_queue q WHERE q.chat_id = chats.id)",
      ).all(cutoff) as { id: string }[];
      const ids = rows.map(row => row.id).filter(id => !exclude.has(id));
      const set = this.db.prepare('UPDATE chats SET archived = 1 WHERE id = ?');
      for (const id of ids) set.run(id);
      if (ids.length) this.bumpVersion();
      return ids;
    });
  }

  /** Swap a pinned chat with its neighbor in pin order. No-op at list edges. */
  movePin(id: string, direction: 'up' | 'down'): void {
    this.tx(() => {
      const chat = this.chat(id);
      if (!chat) throw new Error(`Unknown chat: ${id}`);
      if (!chat.pinned) throw new Error('Chat is not pinned.');
      if (chat.archived) throw new Error('Restore this chat before moving its pin.');
      const pinned = (this.db.prepare(
        'SELECT id, pin_order FROM chats WHERE pinned = 1 AND archived = 0 ORDER BY pin_order IS NULL, pin_order, updated_at DESC',
      ).all() as { id: string; pin_order: number | null }[]);
      const index = pinned.findIndex((r) => r.id === id);
      const other = direction === 'up' ? index - 1 : index + 1;
      if (other < 0 || other >= pinned.length) return;
      // Normalize to dense 1..n slots so legacy NULL orders become swappable.
      const set = this.db.prepare('UPDATE chats SET pin_order = ? WHERE id = ?');
      pinned.forEach((r, i) => set.run(i + 1, r.id));
      set.run(other + 1, pinned[index].id);
      set.run(index + 1, pinned[other].id);
      this.bumpVersion();
    });
  }

  setActiveChat(id: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('activeChatId', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(id);
  }

  activeChatId(): string | undefined { return this.getMeta('activeChatId'); }

  /** Unread state never touches updated_at, so marking a chat read or unread does not reorder the sidebar. */
  setUnread(id: string, unread: boolean): boolean {
    const row = this.db.prepare('SELECT unread FROM chats WHERE id = ?').get(id) as { unread: number } | undefined;
    if (!row) throw new Error(`Unknown chat: ${id}`);
    if (unread) this.db.prepare('UPDATE chats SET unread = 1 WHERE id = ?').run(id);
    else this.db.prepare('UPDATE chats SET unread = 0, last_viewed_at = ? WHERE id = ?').run(now(), id);
    const changed = (row.unread === 1) !== unread;
    if (changed) this.bumpVersion();
    return changed;
  }

  /** Point a chat at another folder or Project without touching its history. Clears the provider thread: the old one ran elsewhere. */
  rebindChat(id: string, patch: { folderId?: string | null; projectId?: string | null }): Chat {
    return this.tx(() => {
      // Attaching a folder or Project is metadata: the chat keeps its place in the Recent sort (CHAT-16).
      const sets: string[] = [], values: (string | null)[] = [];
      if (patch.folderId !== undefined) {
        if (patch.folderId && !this.folder(patch.folderId)) throw new Error('Folder does not exist.');
        sets.push('folder_id = ?', 'provider_thread_id = NULL', 'provider_turn_id = NULL', 'provider_thread_provider_id = NULL', 'provider_thread_binding_id = NULL'); values.push(patch.folderId);
      }
      if (patch.projectId !== undefined) { sets.push('project_id = ?'); values.push(patch.projectId); }
      if (!this.chat(id)) throw new Error(`Unknown chat: ${id}`);
      if (sets.length) this.db.prepare(`UPDATE chats SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
      this.bumpVersion();
      return this.chat(id)!;
    });
  }

  /** Permanently remove a chat and every row keyed to it, including tables other runtime modules keep in this database. */
  deleteChat(id: string): void {
    this.tx(() => {
      if (!this.chat(id)) throw new Error(`Unknown chat: ${id}`);
      const tables = (this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
        .filter(({ name }) => /^[A-Za-z0-9_]+$/.test(name) && (this.db.prepare(`SELECT 1 FROM pragma_table_info('${name}') WHERE name = 'chat_id'`).get()));
      for (const { name } of tables) this.db.prepare(`DELETE FROM ${name} WHERE chat_id = ?`).run(id);
      this.db.prepare('DELETE FROM chats WHERE id = ?').run(id);
      if (this.getMeta('activeChatId') === id) this.db.prepare("DELETE FROM meta WHERE key = 'activeChatId'").run();
      this.bumpVersion();
    });
  }

  /** Persist the latest reliable telemetry for a chat (upsert, additive migration-safe). */
  setContextTelemetry(chatId: string, t: ContextTelemetry): void {
    this.liveTelemetry.add(chatId);
    this.db.prepare(
      'INSERT INTO context_telemetry (chat_id, used_tokens, window_tokens, source, compacted, updated_at) VALUES (?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT(chat_id) DO UPDATE SET used_tokens = excluded.used_tokens, window_tokens = excluded.window_tokens, source = excluded.source, compacted = excluded.compacted, updated_at = excluded.updated_at',
    ).run(chatId, t.usedTokens, t.windowTokens, t.source, t.compacted ? 1 : 0, t.updatedAt);
  }

  /** Chats whose telemetry this process received from the provider: they read back as 'live', not 'restored'. */
  private readonly liveTelemetry = new Set<string>();
  /**
   * Last persisted telemetry. A row written by an earlier process (before an app restart) is source
   * 'restored'; one this process received from the provider stays 'live'. Rows written by a corrupted
   * or future schema degrade to Unavailable, never to zero.
   */
  contextTelemetry(chatId: string): ContextTelemetry {
    const row = this.db.prepare('SELECT * FROM context_telemetry WHERE chat_id = ?').get(chatId) as
      | { used_tokens: number | null; window_tokens: number | null; source: string | null; compacted: number; updated_at: string | null }
      | undefined;
    if (!row) return { usedTokens: null, windowTokens: null, source: null, compacted: false, updatedAt: null };
    const used = typeof row.used_tokens === 'number' && Number.isInteger(row.used_tokens) && row.used_tokens >= 0 && row.used_tokens <= 50_000_000 ? row.used_tokens : null;
    const window = typeof row.window_tokens === 'number' && Number.isInteger(row.window_tokens) && row.window_tokens > 0 && row.window_tokens <= 50_000_000 ? row.window_tokens : null;
    return {
      usedTokens: used,
      windowTokens: window,
      source: used !== null || window !== null || row.compacted === 1 ? (this.liveTelemetry.has(chatId) ? 'live' : 'restored') : null,
      compacted: row.compacted === 1,
      updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
    };
  }

  timeline(chatId: string): TimelineItem[] {
    return (this.db.prepare('SELECT * FROM timeline WHERE chat_id = ? ORDER BY seq').all(chatId) as unknown as TimelineRow[]).map(rowToItem);
  }

  /** Full ordered timeline plus its per-chat cursor, including empty chats. */
  timelineSnapshot(chatId: string): { items: TimelineItem[]; revision: number } {
    const items = this.timeline(chatId);
    const row = this.db.prepare('SELECT revision FROM timeline_cursors WHERE chat_id = ?').get(chatId) as { revision: number } | undefined;
    return { items, revision: row?.revision ?? 0 };
  }

  /** The per-chat timeline cursor alone (no rows): a cheap "did anything change?" probe for caches. */
  timelineRevision(chatId: string): number {
    const row = this.db.prepare('SELECT revision FROM timeline_cursors WHERE chat_id = ?').get(chatId) as { revision: number } | undefined;
    return row?.revision ?? 0;
  }

  /** Return each row changed after `since`, ordered by its original sequence. */
  timelineChanges(chatId: string, since: number): { items: TimelineItem[]; revision: number } {
    if (!Number.isSafeInteger(since) || since < 0) throw new Error('Invalid timeline revision cursor.');
    const cursor = this.db.prepare('SELECT revision FROM timeline_cursors WHERE chat_id = ?').get(chatId) as { revision: number } | undefined;
    const revision = cursor?.revision ?? 0;
    if (since > revision) throw new Error(`Timeline revision ${since} is ahead of current revision ${revision}.`);
    const rows = this.db.prepare(
      'SELECT t.* FROM timeline t JOIN timeline_changes c ON c.chat_id = t.chat_id AND c.seq = t.seq WHERE t.chat_id = ? AND c.revision > ? ORDER BY t.seq',
    ).all(chatId, since) as unknown as TimelineRow[];
    return { items: rows.map(rowToItem), revision };
  }

  appendItem(chatId: string, kind: TimelineItem['kind'], text: string, status?: string, data?: Record<string, unknown>): TimelineItem {
    const item: TimelineItem = {
      id: randomUUID(), chatId, kind, text, ...(status ? { status } : {}), createdAt: now(), ...(data ? { data } : {}),
    };
    this.db.prepare('INSERT INTO timeline (id, chat_id, kind, text, status, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(item.id, chatId, kind, text, status ?? null, item.createdAt, data ? JSON.stringify(data) : null);
    return item;
  }

  updateItem(id: string, text: string, status?: string, data?: Record<string, unknown>): void {
    this.db.prepare('UPDATE timeline SET text = ?, status = ?, data = COALESCE(?, data) WHERE id = ?').run(text, status ?? null, data ? JSON.stringify(data) : null, id);
  }

  item(id: string): TimelineItem | undefined {
    const row = this.db.prepare('SELECT * FROM timeline WHERE id = ?').get(id) as TimelineRow | undefined;
    return row ? rowToItem(row) : undefined;
  }

  receipt(requestId: string): { runId: string; chatId: string; fingerprint: string } | undefined {
    const row = this.db.prepare('SELECT run_id, chat_id, fingerprint FROM receipts WHERE request_id = ?').get(requestId) as { run_id: string; chat_id: string; fingerprint: string } | undefined;
    return row ? { runId: row.run_id, chatId: row.chat_id, fingerprint: row.fingerprint } : undefined;
  }

  /**
   * Idempotent send: persists the receipt + user message + running status in
   * one transaction. Returns the existing runId when the requestId was seen.
   */
  recordSend(chatId: string, requestId: string, text: string, fingerprint = createHash('sha256').update(text).digest('hex'), options: { userData?: Record<string, unknown>; within?: () => void; reuseUserItemId?: string } = {}): { runId: string; replay: boolean } {
    return this.tx(() => {
      const existing = this.receipt(requestId);
      if (existing) {
        if (existing.chatId !== chatId || existing.fingerprint !== fingerprint) throw new Error('requestId conflicts with the original request.');
        return { runId: existing.runId, replay: true };
      }
      const chat = this.chat(chatId);
      if (!chat) throw new Error(`Unknown chat: ${chatId}`);
      if (chat.recovery?.kind === 'recovery-needed') throw new Error('This chat needs its provider status checked before another message can be sent.');
      if (chat.status === 'running' || chat.status === 'stopping') throw new Error('Chat is already running; stop it first.');
      const runId = randomUUID();
      this.db.prepare('INSERT INTO receipts (request_id, chat_id, run_id, created_at, fingerprint) VALUES (?, ?, ?, ?, ?)').run(requestId, chatId, runId, now(), fingerprint);
      // F46: Retry re-runs the turn's own prompt; the transcript keeps that one user message instead of a copy.
      const reused = options.reuseUserItemId ? this.item(options.reuseUserItemId) : undefined;
      if (reused && (reused.chatId !== chatId || reused.kind !== 'user')) throw new Error('Retry can only re-run this chat’s own message.');
      if (!reused) this.appendItem(chatId, 'user', text, undefined, options.userData);
      options.within?.();
      const sets: Record<string, unknown> = { status: 'running', draft: '', error: null, providerTurnId: null, recovery: null };
      // Provisional name while the first turn runs; settleTitle() makes it final. Renamed chats keep their name, even 'New chat'.
      if (chat.titleSource === 'default') { const title = generateChatTitle(text); if (title) sets.title = title; }
      this.updateChatRaw(chatId, sets);
      this.bumpVersion();
      return { runId, replay: false };
    });
  }

  /** After a completed turn: a chat still on its default name gets a summary title from its first exchange. */
  settleTitle(chatId: string): boolean {
    return this.tx(() => {
      const chat = this.chat(chatId);
      if (!chat || chat.titleSource !== 'default') return false;
      const first = (kind: string) => (this.db.prepare("SELECT text FROM timeline WHERE chat_id = ? AND kind = ? AND (data IS NULL OR json_extract(data, '$.forked') IS NULL) ORDER BY seq LIMIT 1").get(chatId, kind) as { text: string } | undefined)?.text ?? '';
      const prompt = first('user');
      if (!prompt) return false;
      const title = generateChatTitle(prompt, first('assistant')) ?? chat.title;
      this.db.prepare("UPDATE chats SET title = ?, title_source = 'generated' WHERE id = ?").run(title, chatId);
      this.bumpVersion();
      return true;
    });
  }

  /** New chat with `originId`'s folder, project, model, mode, access and provider, and a read-only copy of its history
   *  through `fromItemId` (everything when absent). No provider thread: the first send carries a digest instead. */
  forkChat(originId: string, fromItemId?: string | null): Chat {
    return this.tx(() => {
      const origin = this.db.prepare('SELECT * FROM chats WHERE id = ?').get(originId) as ChatRow | undefined;
      if (!origin) throw new Error('Chat does not exist.');
      let through = fromItemId === null ? 0 : Number.MAX_SAFE_INTEGER;
      if (fromItemId) {
        const row = this.db.prepare('SELECT seq FROM timeline WHERE id = ? AND chat_id = ?').get(fromItemId, originId) as { seq: number } | undefined;
        if (!row) throw new Error('That message is no longer in this chat.');
        through = row.seq;
      }
      const id = randomUUID(), source = titleSource(origin);
      this.db.prepare(
        'INSERT INTO chats (id, folder_id, project_id, title, updated_at, model, mode, permission_mode, provider_id, title_source, origin_chat_id, origin_item_id, resume_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
      ).run(id, origin.folder_id, origin.project_id, origin.title, now(), origin.model, origin.mode, origin.permission_mode, origin.provider_id ?? 'hybrow', source, originId, fromItemId ?? null);
      const rows = this.db.prepare('SELECT * FROM timeline WHERE chat_id = ? AND seq <= ? ORDER BY seq').all(originId, through) as unknown as TimelineRow[];
      const insert = this.db.prepare('INSERT INTO timeline (id, chat_id, kind, text, status, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const row of rows) {
        let data: Record<string, unknown> = {};
        try { if (row.data) data = JSON.parse(row.data) as Record<string, unknown>; } catch { /* unreadable details are dropped from the copy */ }
        insert.run(randomUUID(), id, row.kind, row.text, settledStatus(row.status), row.created_at, JSON.stringify({ ...data, forked: true, originItemId: row.id }));
      }
      this.db.prepare("INSERT INTO timeline_cursors (chat_id, revision) VALUES (?, 0) ON CONFLICT(chat_id) DO NOTHING").run(id);
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('activeChatId', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(id);
      this.bumpVersion();
      return this.chat(id)!;
    });
  }

  /** Edit › Replace: drop `itemId` and everything after it, and start a fresh provider conversation seeded with what is left. */
  truncateFrom(chatId: string, itemId: string): void {
    this.tx(() => {
      const row = this.db.prepare('SELECT seq FROM timeline WHERE id = ? AND chat_id = ?').get(itemId, chatId) as { seq: number } | undefined;
      if (!row) throw new Error('That message is no longer in this chat.');
      this.db.prepare('DELETE FROM timeline_changes WHERE chat_id = ? AND seq >= ?').run(chatId, row.seq);
      this.db.prepare('DELETE FROM timeline WHERE chat_id = ? AND seq >= ?').run(chatId, row.seq);
      // Deletions never travel as patches; the bump makes every replica take the next snapshot.
      this.db.prepare('INSERT INTO timeline_cursors (chat_id, revision) VALUES (?, 1) ON CONFLICT(chat_id) DO UPDATE SET revision = revision + 1').run(chatId);
      this.db.prepare('UPDATE chats SET provider_thread_id = NULL, provider_turn_id = NULL, provider_thread_provider_id = NULL, provider_thread_binding_id = NULL, recovery = NULL, error = NULL, resume_digest = 1, updated_at = ? WHERE id = ?').run(now(), chatId);
      this.bumpVersion();
    });
  }

  /** True while the next send must carry the visible history (see resume_digest). */
  needsDigest(chatId: string): boolean {
    return (this.db.prepare('SELECT resume_digest FROM chats WHERE id = ?').get(chatId) as { resume_digest: number } | undefined)?.resume_digest === 1;
  }
  clearDigest(chatId: string): void { this.db.prepare('UPDATE chats SET resume_digest = 0 WHERE id = ?').run(chatId); }

  private updateChatRaw(id: string, sets: Record<string, unknown>): void {
    const columns: Record<string, string> = { status: 'status', draft: 'draft', error: 'error', title: 'title', providerTurnId:'provider_turn_id', recovery:'recovery' };
    const clauses: string[] = ['updated_at = ?'];
    const values: (string | null)[] = [now()];
    for (const [key, column] of Object.entries(columns)) {
      if (key in sets) { clauses.push(`${column} = ?`); values.push(sets[key] as string | null); }
    }
    this.db.prepare(`UPDATE chats SET ${clauses.join(', ')} WHERE id = ?`).run(...values, id);
  }

  queue(chatId: string): QueuedMessage[] {
    return (this.db.prepare('SELECT * FROM chat_queue WHERE chat_id = ? ORDER BY position').all(chatId) as unknown as QueueRow[]).map(rowToQueued);
  }

  queued(chatId: string, id: string): QueuedMessage | undefined {
    const row = this.db.prepare('SELECT * FROM chat_queue WHERE chat_id = ? AND id = ?').get(chatId, id) as QueueRow | undefined;
    return row ? rowToQueued(row) : undefined;
  }

  /** Append at the tail; 'head' puts a message whose dispatch failed back in front. */
  enqueue(chatId: string, item: QueuedMessage, limit: number, position: 'tail' | 'head' = 'tail'): QueuedMessage {
    return this.tx(() => {
      const row = this.db.prepare('SELECT COUNT(*) AS n, MIN(position) AS lo, MAX(position) AS hi FROM chat_queue WHERE chat_id = ?').get(chatId) as { n: number; lo: number | null; hi: number | null };
      if (row.n >= limit) throw new Error(`At most ${limit} messages can wait in the queue.`);
      if (this.db.prepare('SELECT 1 FROM chat_queue WHERE request_id = ?').get(item.requestId)) throw new Error('This message is already queued.');
      const slot = position === 'head' ? (row.lo ?? 1) - 1 : (row.hi ?? 0) + 1;
      this.db.prepare('INSERT INTO chat_queue (chat_id, id, position, text, request_id, attachment_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(chatId, item.id, slot, item.text, item.requestId, JSON.stringify(item.attachmentIds), item.createdAt);
      this.bumpVersion();
      return item;
    });
  }

  updateQueued(chatId: string, id: string, text: string): QueuedMessage {
    return this.tx(() => {
      if (this.db.prepare('UPDATE chat_queue SET text = ? WHERE chat_id = ? AND id = ?').run(text, chatId, id).changes === 0) throw new Error('This queued message was already sent or removed.');
      this.bumpVersion();
      return this.queued(chatId, id)!;
    });
  }

  removeQueued(chatId: string, id: string): QueuedMessage | undefined {
    return this.tx(() => {
      const item = this.queued(chatId, id);
      if (!item) return undefined;
      this.db.prepare('DELETE FROM chat_queue WHERE chat_id = ? AND id = ?').run(chatId, id);
      this.bumpVersion();
      return item;
    });
  }

  /** Swap with the neighbour; no-op at either end. */
  moveQueued(chatId: string, id: string, direction: 'up' | 'down'): void {
    this.tx(() => {
      const rows = this.db.prepare('SELECT id FROM chat_queue WHERE chat_id = ? ORDER BY position').all(chatId) as { id: string }[];
      const index = rows.findIndex(row => row.id === id);
      if (index < 0) throw new Error('This queued message was already sent or removed.');
      const other = direction === 'up' ? index - 1 : index + 1;
      if (other < 0 || other >= rows.length) return;
      [rows[index], rows[other]] = [rows[other]!, rows[index]!];
      const set = this.db.prepare('UPDATE chat_queue SET position = ? WHERE chat_id = ? AND id = ?');
      rows.forEach((row, i) => set.run(i + 1, chatId, row.id));
      this.bumpVersion();
    });
  }

  /** Crash recovery: any chat still running/stopping was orphaned by a dead process. */
  recoverOrphanedRuns(): string[] {
    return this.tx(() => {
      const rows = this.db.prepare("SELECT id FROM chats WHERE status IN ('running', 'stopping')").all() as unknown as { id: string }[];
      for (const { id } of rows) {
        const recovery: ChatRecovery = {kind:'recovery-needed',retryable:false,reason:'May still be running at the provider · Check status before sending another message.'};
        // Interrupted, not failed: the provider may still finish the turn; RecoveryNotice checks it.
        this.updateChatRaw(id, { status: 'interrupted', error: recovery.reason, recovery:JSON.stringify(recovery) });
        this.appendItem(id, 'notice', recovery.reason, 'recovery-needed', {recovery});
      }
      if (rows.length > 0) this.bumpVersion();
      return rows.map((row) => row.id);
    });
  }

  close(): void {
    this.db.close();
  }
}
