/**
 * Durable agent state on node:sqlite (WAL). Every mutation is transactional;
 * the send receipt is persisted BEFORE any model call so a crashed process
 * never double-dispatches a requestId.
 */
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Chat, ChatRecovery, ChatStatus, ContextTelemetry, Folder, Project, Snapshot, TimelineItem } from '../shared/protocol.ts';

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
`;

interface ChatRow {
  id: string; folder_id: string | null; project_id: string | null; title: string;
  pinned: number; pin_order: number | null; archived: number; draft: string; status: string; updated_at: string;
  provider_id: string; provider_binding_id: string | null; provider_thread_provider_id: string | null; provider_thread_binding_id: string | null; provider_thread_id: string | null; provider_turn_id: string | null; recovery: string | null; model: string; mode: string; permission_mode: string | null; error: string | null;
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
  };
}

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

const now = (): string => new Date().toISOString();

export class AgentStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, 'muster-agent.sqlite'));
    chmodSync(join(dataDir, 'muster-agent.sqlite'), 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
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
    for (const column of ['provider_binding_id','provider_thread_provider_id','provider_thread_binding_id']) if (!chatColumns.some(c=>c.name===column)) this.db.exec(`ALTER TABLE chats ADD COLUMN ${column} TEXT`);
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
    const folders = (this.db.prepare('SELECT * FROM folders ORDER BY created_at').all() as unknown as { id: string; path: string; name: string }[])
      .map(({ id, path, name }) => ({ id, path, name }));
    const chats = (this.db.prepare('SELECT * FROM chats ORDER BY updated_at DESC').all() as unknown as ChatRow[]).map(rowToChat);
    const projects = (this.db.prepare('SELECT * FROM projects').all() as unknown as { id: string; name: string; goal: string; folder_ids: string }[])
      .map(({ id, name, goal, folder_ids }) => ({ id, name, goal, folderIds: JSON.parse(folder_ids) as string[] }));
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

  folder(id: string): Folder | undefined {
    const row = this.db.prepare('SELECT id, path, name FROM folders WHERE id = ?').get(id) as Folder | undefined;
    return row ? { id: row.id, path: row.path, name: row.name } : undefined;
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
        'INSERT INTO chats (id, folder_id, project_id, title, updated_at, model, mode, permission_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(id, input.folderId ?? null, input.projectId ?? null, 'New chat', now(), input.model, input.mode, input.permissionMode ?? null);
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('activeChatId', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(id);
      this.bumpVersion();
      return this.chat(id)!;
    });
  }

  chat(id: string): Chat | undefined {
    const row = this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as ChatRow | undefined;
    return row ? rowToChat(row) : undefined;
  }

  updateChat(id: string, patch: Partial<Pick<Chat, 'title' | 'pinned' | 'archived' | 'draft' | 'model' | 'mode' | 'permissionMode' | 'status' | 'providerId' | 'providerBindingId'>> & {providerThreadId?:string|null; providerThreadProviderId?:string|null; providerThreadBindingId?:string|null; providerTurnId?: string | null; recovery?: ChatRecovery | null; error?: string | null}): Chat {
    return this.tx(() => {
      const current = this.chat(id);
      if (!current) throw new Error(`Unknown chat: ${id}`);
      const sets: string[] = ['updated_at = ?'];
      const values: (string | number | null)[] = [now()];
      const map: Record<string, string> = {
        title: 'title', draft: 'draft', model: 'model', mode: 'mode', permissionMode: 'permission_mode', status: 'status', error: 'error', providerId:'provider_id', providerBindingId:'provider_binding_id', providerThreadProviderId:'provider_thread_provider_id', providerThreadBindingId:'provider_thread_binding_id', providerThreadId: 'provider_thread_id', providerTurnId: 'provider_turn_id',
      };
      for (const [key, column] of Object.entries(map)) {
        const value = (patch as Record<string, unknown>)[key];
        if (value !== undefined) { sets.push(`${column} = ?`); values.push(value as string | null); }
      }
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
      this.db.prepare(`UPDATE chats SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
      this.bumpVersion();
      return this.chat(id)!;
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

  /** Persist the latest reliable telemetry for a chat (upsert, additive migration-safe). */
  setContextTelemetry(chatId: string, t: ContextTelemetry): void {
    this.db.prepare(
      'INSERT INTO context_telemetry (chat_id, used_tokens, window_tokens, source, compacted, updated_at) VALUES (?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT(chat_id) DO UPDATE SET used_tokens = excluded.used_tokens, window_tokens = excluded.window_tokens, source = excluded.source, compacted = excluded.compacted, updated_at = excluded.updated_at',
    ).run(chatId, t.usedTokens, t.windowTokens, t.source, t.compacted ? 1 : 0, t.updatedAt);
  }

  /**
   * Last persisted telemetry, restored as source 'restored'. Rows written by
   * a corrupted or future schema degrade to Unavailable, never to zero.
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
      source: used !== null || window !== null || row.compacted === 1 ? 'restored' : null,
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
  recordSend(chatId: string, requestId: string, text: string): { runId: string; replay: boolean } {
    return this.tx(() => {
      const existing = this.receipt(requestId);
      if (existing) {
        if (existing.chatId !== chatId || existing.fingerprint !== createHash('sha256').update(text).digest('hex')) throw new Error('requestId conflicts with the original request.');
        return { runId: existing.runId, replay: true };
      }
      const chat = this.chat(chatId);
      if (!chat) throw new Error(`Unknown chat: ${chatId}`);
      if (chat.recovery?.kind === 'recovery-needed') throw new Error('This chat needs its provider status checked before another message can be sent.');
      if (chat.status === 'running' || chat.status === 'stopping') throw new Error('Chat is already running; stop it first.');
      const runId = randomUUID();
      this.db.prepare('INSERT INTO receipts (request_id, chat_id, run_id, created_at, fingerprint) VALUES (?, ?, ?, ?, ?)').run(requestId, chatId, runId, now(), createHash('sha256').update(text).digest('hex'));
      this.appendItem(chatId, 'user', text);
      const sets: Record<string, unknown> = { status: 'running', draft: '', error: null, providerTurnId: null, recovery: null };
      if (chat.title === 'New chat') sets.title = text.split('\n')[0]!.slice(0, 60).trim() || 'New chat';
      this.updateChatRaw(chatId, sets);
      this.bumpVersion();
      return { runId, replay: false };
    });
  }

  private updateChatRaw(id: string, sets: Record<string, unknown>): void {
    const columns: Record<string, string> = { status: 'status', draft: 'draft', error: 'error', title: 'title', providerTurnId:'provider_turn_id', recovery:'recovery' };
    const clauses: string[] = ['updated_at = ?'];
    const values: (string | null)[] = [now()];
    for (const [key, column] of Object.entries(columns)) {
      if (key in sets) { clauses.push(`${column} = ?`); values.push(sets[key] as string | null); }
    }
    this.db.prepare(`UPDATE chats SET ${clauses.join(', ')} WHERE id = ?`).run(...values, id);
  }

  /** Crash recovery: any chat still running/stopping was orphaned by a dead process. */
  recoverOrphanedRuns(): string[] {
    return this.tx(() => {
      const rows = this.db.prepare("SELECT id FROM chats WHERE status IN ('running', 'stopping')").all() as unknown as { id: string }[];
      for (const { id } of rows) {
        const recovery: ChatRecovery = {kind:'recovery-needed',retryable:false,reason:'Muster restarted before this attempt settled. The provider may still be working; check its saved turn before sending another message.'};
        this.updateChatRaw(id, { status: 'failed', error: recovery.reason, recovery:JSON.stringify(recovery) });
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
