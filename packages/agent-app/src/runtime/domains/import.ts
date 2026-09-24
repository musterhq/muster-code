/**
 * Import domain (CHAT-01): discover Codex CLI/desktop, Claude Code, OpenCode and ChatGPT-export conversations
 * read-only, and bring the chosen ones into Muster as chats. Each import is keyed by the source
 * session id in `imported_chats`, so importing again updates the same chat instead of duplicating it.
 * Transcripts stream in bounded batches; every string is passed through the shared secret redactor.
 */
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactSecrets } from '../secret-redaction.ts';
import { IMPORT_PAGE_LIMIT, IMPORT_PREVIEW_CHARS, IMPORT_PREVIEW_MESSAGES, IMPORT_SOURCES, IMPORT_SOURCE_LABELS, MAX_IMPORT_BATCH, importTitle, type ImportListPage, type ImportPreview, type ImportRunResult, type ImportSessionSummary, type ImportSource, type ImportSourceState } from '../../shared/domains/import-protocol.ts';
import { MAX_ITEMS_PER_SESSION, MAX_MESSAGE_TEXT, MAX_REASONING_TEXT, MAX_TOOL_OUTPUT, chatGptEvents, clipText, createDiscoveryCache, discoverClaudeSessions, discoverCodexSessions, discoverOpenCodeSessions, openCodeDataDir, readChatGptExport, readClaudeTranscript, readCodexRollout, readOpenCodeSession, type ChatGptConversation, type DiscoveredSession, type ImportedEvent, type ImportedItem } from '../conversation-import.ts';
import type { Chat, Folder, ProviderInfo } from '../../shared/protocol.ts';
import type { DomainContext, DomainModule } from './types.ts';
import { plural } from '../../shared/wording.ts';

const SCHEMA = `CREATE TABLE IF NOT EXISTS imported_chats (
  source TEXT NOT NULL, session_id TEXT NOT NULL, chat_id TEXT NOT NULL, path TEXT NOT NULL,
  updated_at TEXT NOT NULL, imported_at TEXT NOT NULL, message_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source, session_id));`;
const LIST_TTL_MS = 30_000;
interface ImportedRow { source: string; session_id: string; chat_id: string; path: string; updated_at: string; imported_at: string; message_count: number }
interface Win { isDestroyed(): boolean }
interface ElectronApi { BrowserWindow: { getFocusedWindow(): Win | null; getAllWindows(): Win[] }; dialog: { showOpenDialog(win: Win | undefined, options: object): Promise<{ canceled: boolean; filePaths?: string[] }> }; app: { getPath(name: 'downloads'): string } }
function loadElectron(): ElectronApi | undefined {
  try {
    const mod = createRequire(typeof __filename === 'string' ? __filename : join(process.cwd(), 'index.js'))('electron') as unknown;
    return mod && typeof mod === 'object' && 'app' in mod && (mod as ElectronApi).app ? mod as ElectronApi : undefined;
  } catch { return undefined; }
}

const isSource = (value: unknown): value is ImportSource => typeof value === 'string' && (IMPORT_SOURCES as readonly string[]).includes(value);
const isDirectory = async (path: string) => { try { return (await fs.stat(path)).isDirectory(); } catch { return false; } };
/** Deepest sidebar folder that contains `cwd` (or is it). */
export function folderForCwd(folders: readonly Folder[], cwd: string | undefined): Folder | undefined {
  if (!cwd) return undefined;
  const target = cwd.replace(/[\\/]+$/, '');
  let best: Folder | undefined;
  for (const folder of folders) {
    const root = folder.path.replace(/[\\/]+$/, '');
    if (target === root || target.startsWith(root + sep)) { if (!best || root.length > best.path.replace(/[\\/]+$/, '').length) best = folder; }
  }
  return best;
}
/** Longest string kept inside tool data (a Write's whole file, an Edit's old/new text, a patch): the transcript row
 *  shows a preview, and the full text stays in the source. */
const MAX_DATA_STRING = 64 * 1024;
/** Clips first (with slack, so a secret cut at the edge is still whole when redacted), then redacts, then clips to `max`. */
function clipRedact(text: string, max: number, count: { value: number }): { text: string; truncated: boolean } {
  const head = text.length > max + 1024 ? text.slice(0, max + 1024) : text;
  const clipped = clipText(redactSecrets(head, count), max);
  return { text: clipped.text, truncated: clipped.truncated || head.length < text.length };
}
/** Redacts every string inside tool data (bounded depth and size), counting replacements. */
function redactDeep(value: unknown, count: { value: number }, depth = 0): unknown {
  if (typeof value === 'string') return clipRedact(value, MAX_DATA_STRING, count).text;
  if (depth > 6 || value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 512).map(entry => redactDeep(entry, count, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 128).map(([key, entry]) => [key, redactDeep(entry, count, depth + 1)]));
}
const sourceLabel = (source: ImportSource) => source === 'codex' ? 'Codex' : source === 'claude-code' ? 'Claude Code' : source === 'opencode' ? 'OpenCode' : 'ChatGPT';
const homeRelative = (path: string) => { const home = homedir(); return path === home ? '~' : path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path; };

export function createImportDomain(context: DomainContext): DomainModule {
  let ready = false;
  const db = () => { const database = context.db(); if (!ready) { database.exec(SCHEMA); ready = true; } return database; };
  const codexHome = () => process.env.CODEX_HOME || join(homedir(), '.codex');
  const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const openCodeDir = () => openCodeDataDir(process.env, homedir());
  const cache = createDiscoveryCache();
  const lists = new Map<ImportSource, { at: number; sessions: DiscoveredSession[] }>();
  const known = new Map<string, DiscoveredSession>();
  const exports = new Map<string, { mtimeMs: number; conversations: ChatGptConversation[] }>();
  /** Session cwd → its real path, so a cwd recorded through a symlink (macOS /var → /private/var) still meets its folder. */
  const realCwds = new Map<string, string>();
  const resolveCwd = async (cwd: string | undefined): Promise<string | undefined> => {
    if (!cwd) return undefined;
    const cached = realCwds.get(cwd); if (cached) return cached;
    const real = await fs.realpath(cwd).catch(() => cwd);
    if (realCwds.size > 4096) realCwds.clear();
    realCwds.set(cwd, real);
    return real;
  };
  const folderFor = async (folders: readonly Folder[], cwd: string | undefined): Promise<Folder | undefined> => folderForCwd(folders, cwd) ?? folderForCwd(folders, await resolveCwd(cwd));
  let running = false;

  const sourceState = async (source: ImportSource): Promise<ImportSourceState> => {
    if (source === 'codex') { const root = join(codexHome(), 'sessions'); const available = await isDirectory(root); return { id: source, label: IMPORT_SOURCE_LABELS[source], available, detail: available ? `Reads ${homeRelative(root)} read-only` : `No sessions found at ${homeRelative(root)}`, location: root }; }
    if (source === 'claude-code') { const root = join(claudeDir(), 'projects'); const available = await isDirectory(root); return { id: source, label: IMPORT_SOURCE_LABELS[source], available, detail: available ? `Reads ${homeRelative(root)} read-only` : `No transcripts found at ${homeRelative(root)}`, location: root }; }
    if (source === 'opencode') { const root = join(openCodeDir(), 'storage', 'session'); const available = await isDirectory(root); return { id: source, label: IMPORT_SOURCE_LABELS[source], available, detail: available ? `Reads ${homeRelative(root)} read-only` : `No sessions found at ${homeRelative(root)}`, location: root }; }
    return { id: source, label: IMPORT_SOURCE_LABELS[source], available: true, detail: 'Choose a data export (zip or conversations.json) from chatgpt.com › Settings › Data controls' };
  };
  const exportConversations = async (path: unknown): Promise<{ path: string; conversations: ChatGptConversation[] }> => {
    if (typeof path !== 'string' || !path.trim() || path.includes('\0')) throw new Error('Choose a ChatGPT export file.');
    if (!/\.(?:zip|json)$/i.test(path)) throw new Error('Choose the export zip or its conversations.json.');
    const stat = await fs.stat(path).catch(() => { throw new Error('That export file is no longer there.'); });
    const cached = exports.get(path);
    if (cached && cached.mtimeMs === stat.mtimeMs) return { path, conversations: cached.conversations };
    const conversations = await readChatGptExport(path);
    // One parsed export at a time: each can be hundreds of MB in memory, and the sheet only ever shows one.
    exports.clear();
    exports.set(path, { mtimeMs: stat.mtimeMs, conversations });
    return { path, conversations };
  };
  const discover = async (source: ImportSource, refresh: boolean, exportPath?: unknown): Promise<DiscoveredSession[]> => {
    if (source === 'chatgpt') {
      const { path, conversations } = await exportConversations(exportPath);
      return conversations.map(conversation => ({ source, sessionId: conversation.id, path, title: importTitle(conversation.title, 'ChatGPT conversation'), updatedAt: conversation.updatedAt, sizeBytes: 0, messageCount: conversation.messages.filter(message => message.role === 'user' || message.role === 'assistant').length }));
    }
    const cached = lists.get(source);
    if (cached && !refresh && Date.now() - cached.at < LIST_TTL_MS) return cached.sessions;
    const sessions = source === 'codex' ? await discoverCodexSessions(codexHome(), cache) : source === 'opencode' ? await discoverOpenCodeSessions(openCodeDir(), cache) : await discoverClaudeSessions(claudeDir(), cache);
    lists.set(source, { at: Date.now(), sessions });
    return sessions;
  };
  const importedRows = (): Map<string, ImportedRow> => {
    const rows = new Map<string, ImportedRow>();
    for (const row of db().prepare('SELECT i.* FROM imported_chats i JOIN chats c ON c.id = i.chat_id').all() as unknown as ImportedRow[]) rows.set(`${row.source}:${row.session_id}`, row);
    return rows;
  };
  /**
   * Provider threads Muster's own chats run (thread id → chat id). Muster's Codex and Claude Code turns write the same
   * session files the importer reads, so those sessions are already in Muster. Chats that came from an import are left
   * out: they are matched through `imported_chats` instead (a native continue binds them to the source thread id).
   */
  const ownThreads = (): Map<string, string> => {
    const importedChats = new Set((db().prepare('SELECT chat_id FROM imported_chats').all() as unknown as Array<{ chat_id: string }>).map(row => row.chat_id));
    const threads = new Map<string, string>();
    for (const chat of context.store.snapshot().chats) if (chat.providerThreadId && !importedChats.has(chat.id)) threads.set(chat.providerThreadId.toLowerCase(), chat.id);
    return threads;
  };
  const summarize = async (session: DiscoveredSession, folders: readonly Folder[], imported: Map<string, ImportedRow>, own: Map<string, string>): Promise<ImportSessionSummary> => {
    const id = `${session.source}:${session.sessionId}`, folder = await folderFor(folders, session.cwd), row = imported.get(id);
    const musterChatId = session.source === 'chatgpt' ? undefined : own.get(session.sessionId.toLowerCase());
    return { id, source: session.source, sessionId: session.sessionId, title: session.title, ...(session.cwd ? { cwd: session.cwd } : {}), path: session.path, updatedAt: session.updatedAt, messageCount: row ? row.message_count : session.messageCount, ...(folder ? { folderId: folder.id } : {}), ...(row ? { importedChatId: row.chat_id } : {}), ...(musterChatId ? { musterChatId } : {}), ...(session.originator === 'muster' ? { startedInMuster: true } : {}), ...(session.archived ? { archived: true } : {}), ...(session.model ? { model: session.model } : {}), ...(session.sizeBytes ? { sizeBytes: session.sizeBytes } : {}) };
  };

  /** Provider that can resume the source thread natively, when the user has one signed in. */
  const nativeProvider = (source: ImportSource): ProviderInfo | undefined => {
    const providers = context.modelCatalog?.().providers ?? [];
    if (source === 'codex') {
      const home = codexHome();
      return providers.find(provider => provider.driver === 'codex-app-server' && provider.available && (provider.source ? provider.source === `Codex account at ${home}` : home === (process.env.CODEX_HOME || join(homedir(), '.codex'))));
    }
    if (source === 'claude-code') return providers.find(provider => provider.driver === 'claude-code-cli' && provider.available);
    // `opencode run --session <id>` resumes a session from the same store the importer read.
    if (source === 'opencode') return providers.find(provider => provider.driver === 'opencode-cli' && provider.available);
    return undefined;
  };

  /** The listed session behind `id` and a fresh stream of its events (`exported` caches a parsed ChatGPT export across ids). */
  const sessionEvents = async (id: string, path: unknown, exported?: { map?: Map<string, ChatGptConversation> }): Promise<{ session: DiscoveredSession; events: AsyncIterable<ImportedEvent> | Iterable<ImportedEvent> }> => {
    const separator = id.indexOf(':');
    const source = id.slice(0, separator), sessionId = id.slice(separator + 1);
    if (separator < 0 || !isSource(source) || !sessionId) throw new Error('Unknown conversation.');
    if (source === 'chatgpt') {
      const cache = exported ?? {};
      if (!cache.map) { const { conversations } = await exportConversations(path); cache.map = new Map(conversations.map(conversation => [conversation.id, conversation])); }
      const conversation = cache.map.get(sessionId); if (!conversation) throw new Error('This conversation is not in the chosen export.');
      return { session: { source, sessionId, path: typeof path === 'string' ? path : '', title: conversation.title, updatedAt: conversation.updatedAt, sizeBytes: 0, messageCount: conversation.messages.length }, events: chatGptEvents(conversation) };
    }
    let session = known.get(id);
    if (!session) { for (const found of await discover(source, true)) known.set(`${found.source}:${found.sessionId}`, found); session = known.get(id); }
    if (!session) throw new Error('This session is no longer available.');
    return { session, events: source === 'codex' ? readCodexRollout(session.path) : source === 'opencode' ? readOpenCodeSession(session.path, openCodeDir()) : readClaudeTranscript(session.path) };
  };

  /** Streams one session into a chat: creates it (or clears the earlier import's rows) and writes bounded batches. */
  const importSession = async (session: DiscoveredSession, events: AsyncIterable<ImportedEvent> | Iterable<ImportedEvent>, options: { addFolders: boolean; continueInMuster: boolean }, result: ImportRunResult): Promise<void> => {
    const store = context.store, database = db();
    const id = `${session.source}:${session.sessionId}`;
    const existing = (database.prepare('SELECT * FROM imported_chats WHERE source = ? AND session_id = ?').get(session.source, session.sessionId) as ImportedRow | undefined);
    let chat: Chat | undefined = existing ? store.chat(existing.chat_id) : undefined;
    let folder = await folderFor(store.snapshot().folders, session.cwd);
    if (!folder && options.addFolders && session.cwd && await isDirectory(session.cwd)) {
      try { folder = await context.invoke('folder.add', { path: session.cwd }); result.foldersAdded.push(folder.path); } catch { folder = undefined; }
    }
    const previousActive = store.activeChatId();
    const created = !chat;
    if (!chat) {
      const defaults = await context.invoke('chat.defaults', { ...(folder ? { folderId: folder.id } : {}) }).catch(() => undefined);
      const builtin = context.modelCatalog?.().builtin;
      const model = defaults?.model || builtin?.model || 'default', providerId = defaults?.providerId || builtin?.providerId || '';
      const provider = context.modelCatalog?.().providers.find(entry => entry.id === providerId);
      chat = store.createChat({ ...(folder ? { folderId: folder.id } : {}), model, mode: 'agent' });
      // No ready provider on this machine: the imported chat stays unbound and asks for a model when continued.
      if (providerId) chat = store.updateChat(chat.id, { providerId, providerBindingId: provider?.bindingId ?? providerId });
      if (previousActive) store.setActiveChat(previousActive);
    } else {
      if (chat.status === 'running' || chat.status === 'stopping') throw new Error('This chat is working; wait for it to finish before importing again.');
      // Re-import replaces the transcript. Anything written after the last import is the user's own work in Muster
      // (a continued conversation); replacing the rows would delete it.
      const continued = database.prepare('SELECT 1 FROM timeline WHERE chat_id = ? AND created_at > ? LIMIT 1').get(chat.id, existing!.imported_at);
      if (continued) throw new Error('This chat was continued in Muster after it was imported; importing again would replace those messages.');
      if (!chat.folderId && folder) chat = store.rebindChat(chat.id, { folderId: folder.id });
      // Re-import owns the transcript: replace the earlier rows in one transaction (deletions never travel as patches).
      store.tx(() => {
        database.prepare('DELETE FROM timeline_changes WHERE chat_id = ?').run(chat!.id);
        database.prepare('DELETE FROM timeline WHERE chat_id = ?').run(chat!.id);
        database.prepare('INSERT INTO timeline_cursors (chat_id, revision) VALUES (?, 1) ON CONFLICT(chat_id) DO UPDATE SET revision = revision + 1').run(chat!.id);
      });
    }
    const chatId = chat.id;
    const insert = database.prepare('INSERT INTO timeline (id, chat_id, kind, text, status, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const update = database.prepare('UPDATE timeline SET text = ?, status = ?, data = ? WHERE id = ?');
    const redacted = { value: 0 };
    const pending = new Map<string, { id: string; name: string; data: Record<string, unknown> }>();
    let batch: Array<() => void> = [], items = 0, messages = 0, truncated = false, meta: { cwd?: string; model?: string; title?: string } = {};
    const flush = () => { if (!batch.length) return; const work = batch; batch = []; store.tx(() => { for (const step of work) step(); }); };
    const importedAt = new Date().toISOString();
    const noticeId = randomUUID();
    const noticeData = () => ({ kind: 'imported', source: session.source, sessionId: session.sessionId, path: session.path, ...(session.cwd ? { cwd: session.cwd } : {}), importedAt, messageCount: messages, redacted: redacted.value, ...(meta.model ? { model: meta.model } : {}), ...(truncated ? { truncated: true } : {}) });
    const noticeText = () => `Imported from ${sourceLabel(session.source)} · ${plural(messages, 'message')}${session.cwd ? ` · originally in ${homeRelative(session.cwd)}` : ''}${redacted.value ? ` · ${plural(redacted.value, 'secret')} redacted` : ''}${truncated ? ' · stopped at the import limit' : ''}`;
    batch.push(() => insert.run(noticeId, chatId, 'notice', noticeText(), 'completed', importedAt, JSON.stringify(noticeData())));
    const write = (item: ImportedItem) => {
      if (items >= MAX_ITEMS_PER_SESSION) { truncated = true; return false; }
      items++;
      const rowId = randomUUID();
      let data = item.data ? redactDeep(item.data, redacted) as Record<string, unknown> : undefined, text: string;
      if (item.kind === 'user' || item.kind === 'assistant') { messages++; const clipped = clipRedact(item.text, MAX_MESSAGE_TEXT, redacted); text = clipped.text; if (clipped.truncated) data = { ...data, truncated: true }; }
      else text = clipRedact(item.text, item.kind === 'reasoning' ? MAX_REASONING_TEXT : MAX_DATA_STRING, redacted).text;
      if (item.kind === 'tool' && item.ref) pending.set(item.ref, { id: rowId, name: text, data: data ?? {} });
      const payload = data ? JSON.stringify(data) : null;
      batch.push(() => insert.run(rowId, chatId, item.kind, text, item.status ?? null, item.createdAt, payload));
      return true;
    };
    const settle = (ref: string, output: string, status: string | undefined, extra: Record<string, unknown> | undefined) => {
      const row = pending.get(ref); if (!row) return; pending.delete(ref);
      const clipped = clipRedact(output, MAX_TOOL_OUTPUT, redacted);
      const data = { ...row.data, ...(extra ? redactDeep(extra, redacted) as Record<string, unknown> : {}), output: clipped.text, outputTruncated: clipped.truncated };
      const text = row.name + (clipped.text ? '\n' + clipped.text : '');
      batch.push(() => update.run(text, status ?? 'completed', JSON.stringify(data), row.id));
    };
    for await (const event of events) {
      if (event.type === 'meta') { meta = { ...meta, ...(event.meta.cwd ? { cwd: event.meta.cwd } : {}), ...(event.meta.model ? { model: event.meta.model } : {}), ...(event.meta.title ? { title: event.meta.title } : {}) }; continue; }
      if (event.type === 'item') { if (!write(event.item)) break; }
      else settle(event.ref, event.output, event.status, event.data);
      if (batch.length >= MAX_IMPORT_BATCH) flush();
    }
    // Calls that never got a result (the session was cut off) settle as interrupted rather than staying "running".
    for (const row of pending.values()) batch.push(() => update.run(row.name, 'interrupted', JSON.stringify(row.data), row.id));
    pending.clear();
    if (truncated) batch.push(() => insert.run(randomUUID(), chatId, 'notice', `Import stopped after ${MAX_ITEMS_PER_SESSION.toLocaleString()} items; the rest of this session stays in ${sourceLabel(session.source)}.`, 'completed', importedAt, JSON.stringify({ kind: 'import-truncated' })));
    batch.push(() => update.run(noticeText(), 'completed', JSON.stringify(noticeData()), noticeId));
    flush();

    const title = importTitle(session.title || meta.title || '', `${sourceLabel(session.source)} session`);
    const current = store.chat(chatId)!;
    if (current.titleSource !== 'user' || created) store.updateChat(chatId, { title, titleSource: 'generated' });
    // Sidebar recency follows the session's own last activity, so a bulk import does not bury today's chats.
    database.prepare('UPDATE chats SET updated_at = ?, status = ?, error = NULL, recovery = NULL WHERE id = ?').run(session.updatedAt, 'idle', chatId);
    let continued: 'native' | 'digest' = 'digest';
    const provider = options.continueInMuster ? nativeProvider(session.source) : undefined;
    if (provider) {
      const bindingId = provider.bindingId ?? provider.id;
      const model = meta.model && provider.models.some(entry => entry.id === meta.model) ? meta.model : undefined;
      store.updateChat(chatId, { providerId: provider.id, providerBindingId: bindingId, providerThreadId: session.sessionId, providerThreadProviderId: provider.id, providerThreadBindingId: bindingId, providerTurnId: null, ...(model ? { model } : {}) });
      database.prepare('UPDATE chats SET resume_digest = 0 WHERE id = ?').run(chatId);
      continued = 'native';
    } else {
      // No native thread to resume: the first send seeds a fresh provider conversation with a bounded digest of what was imported.
      database.prepare('UPDATE chats SET provider_thread_id = NULL, provider_turn_id = NULL, provider_thread_provider_id = NULL, provider_thread_binding_id = NULL, resume_digest = 1 WHERE id = ?').run(chatId);
    }
    database.prepare('INSERT INTO imported_chats (source, session_id, chat_id, path, updated_at, imported_at, message_count) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source, session_id) DO UPDATE SET chat_id = excluded.chat_id, path = excluded.path, updated_at = excluded.updated_at, imported_at = excluded.imported_at, message_count = excluded.message_count')
      .run(session.source, session.sessionId, chatId, session.path, session.updatedAt, importedAt, messages);
    result.redacted += redacted.value;
    if (created) result.created++; else result.updated++;
    const finalFolder = store.chat(chatId)?.folderId;
    result.chats.push({ id, chatId, source: session.source, title, ...(finalFolder ? { folderId: finalFolder } : {}), created, messageCount: messages, continued });
  };

  return { handlers: {
    'import.sources': async () => ({ sources: await Promise.all(IMPORT_SOURCES.map(sourceState)) }),

    'import.list': async (input): Promise<ImportListPage> => {
      if (!isSource(input.source)) throw new Error('Choose a source to import from.');
      const source = input.source;
      const limit = typeof input.limit === 'number' && Number.isInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, IMPORT_PAGE_LIMIT) : 50;
      const offset = typeof input.offset === 'number' && Number.isInteger(input.offset) && input.offset >= 0 ? input.offset : 0;
      const query = typeof input.query === 'string' ? input.query.trim().toLocaleLowerCase() : '';
      const state = await sourceState(source);
      if (!state.available) return { items: [], total: 0, offset, limit, source: state };
      const sessions = await discover(source, input.refresh === true, input.path);
      for (const session of sessions) known.set(`${session.source}:${session.sessionId}`, session);
      const folders = context.store.snapshot().folders, imported = importedRows(), own = ownThreads();
      const rows = (await Promise.all(sessions.map(session => summarize(session, folders, imported, own))))
        .filter(row => !query || `${row.title}\n${row.cwd ?? ''}\n${row.sessionId}\n${row.path}`.toLocaleLowerCase().includes(query))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title));
      return { items: rows.slice(offset, offset + limit), total: rows.length, offset, limit, source: state };
    },

    'import.pickExport': async () => {
      const api = loadElectron();
      if (!api) return { path: null };
      const win = api.BrowserWindow.getFocusedWindow() ?? api.BrowserWindow.getAllWindows().find(entry => !entry.isDestroyed());
      let downloads: string | undefined; try { downloads = api.app.getPath('downloads'); } catch { downloads = undefined; }
      const result = await api.dialog.showOpenDialog(win, { title: 'Choose a ChatGPT data export', properties: ['openFile'], ...(downloads ? { defaultPath: downloads } : {}), filters: [{ name: 'ChatGPT export', extensions: ['zip', 'json'] }] });
      return { path: result.canceled || !result.filePaths?.[0] ? null : result.filePaths[0] };
    },

    'import.preview': async (input): Promise<ImportPreview> => {
      if (typeof input.id !== 'string' || input.id.length > 400) throw new Error('Choose a conversation to preview.');
      const { session, events } = await sessionEvents(input.id, input.path);
      const redacted = { value: 0 }, messages: ImportPreview['messages'] = [];
      let more = false;
      // Stops reading at the first message past the preview, so a huge session is never read whole.
      for await (const event of events) {
        if (event.type !== 'item' || (event.item.kind !== 'user' && event.item.kind !== 'assistant')) continue;
        if (messages.length >= IMPORT_PREVIEW_MESSAGES) { more = true; break; }
        const text = clipRedact(event.item.text.replace(/\n{3,}/g, '\n\n').trim(), IMPORT_PREVIEW_CHARS, redacted).text;
        messages.push({ role: event.item.kind, text, createdAt: event.item.createdAt });
      }
      return { id: input.id, title: session.title, messages, more, redacted: redacted.value };
    },

    'import.run': async (input): Promise<ImportRunResult> => {
      if (!Array.isArray(input.ids) || !input.ids.length) throw new Error('Select at least one conversation to import.');
      if (input.ids.length > 500) throw new Error('Import at most 500 conversations at a time.');
      if (running) throw new Error('An import is already running.');
      running = true;
      const runId = randomUUID();
      const options = { addFolders: input.addFolders !== false, continueInMuster: input.continueInMuster === true };
      const result: ImportRunResult = { runId, created: 0, updated: 0, failed: [], chats: [], foldersAdded: [], redacted: 0 };
      try {
        const ids = [...new Set(input.ids.filter((value): value is string => typeof value === 'string'))];
        const own = ownThreads();
        const total = ids.length;
        let done = 0;
        const exported: { map?: Map<string, ChatGptConversation> } = {};
        for (const id of ids) {
          const separator = id.indexOf(':');
          const source = id.slice(0, separator), sessionId = id.slice(separator + 1);
          let title = sessionId;
          try {
            if (!isSource(source) || !sessionId) throw new Error('Unknown conversation.');
            if (source !== 'chatgpt' && own.has(sessionId.toLowerCase())) throw new Error('This conversation is already a Muster chat.');
            const { session, events } = await sessionEvents(id, input.path, exported);
            title = session.title;
            context.emit({ type: 'importProgress', runId, done, total, current: title, phase: 'reading' });
            await importSession(session, events, options, result);
          } catch (error) {
            result.failed.push({ id, title, error: error instanceof Error ? error.message : String(error) });
          }
          done++;
          context.emit({ type: 'importProgress', runId, done, total, current: title, phase: done === total ? 'done' : 'reading' });
          if (done % 10 === 0) context.emitSnapshot();
        }
      } finally { running = false; context.emitSnapshot(); }
      return result;
    },
  } };
}
