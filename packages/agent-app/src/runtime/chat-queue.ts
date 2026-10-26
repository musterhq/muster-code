/**
 * Follow-ups typed while a run is working. Items persist in SQLite (chat_queue)
 * and dispatch one at a time through the normal chat.send path, each with its
 * own requestId, so a crash or double-dispatch replays the same receipt.
 * Composer chips (skills, plugins, effort) persist beside each item in
 * chat_queue_chips and travel with it to chat.send. Like Codex's queue, a run
 * that does not complete pauses the queue (chat_queue_state) until the user
 * resumes it, and an item whose send was refused keeps its error for Retry.
 */
import { randomUUID } from 'node:crypto';
import { MAX_QUEUED_MESSAGES, REASONING_EFFORTS, type Chat, type ChatStatus, type QueuePause, type QueuedMessage, type ReasoningEffort } from '../shared/protocol.ts';
import type { AgentStore } from './store.ts';

/** Only a completed run continues the queue. Anything else pauses it for the user. */
export function queueActionAfter(status: ChatStatus): 'dispatch' | 'hold' {
  return status === 'completed' ? 'dispatch' : 'hold';
}
/** Codex copy for the paused-queue banner. */
export function queuePausedLabel(reason: QueuePause): string {
  return reason === 'interrupted' ? 'Queue paused because you interrupted' : reason === 'limited' ? 'Queue waits for the usage limit to reset' : 'Queue paused because the last run did not finish';
}

/** The queued row was removed or edited while its dispatch was being prepared; nothing was sent. */
export class QueueChangedError extends Error { constructor() { super('The queued message changed before it was sent.'); this.name = 'QueueChangedError'; } }

export interface QueueChips { skillIds?: string[]; pluginIds?: string[]; effort?: ReasoningEffort }
interface ChipRow { id: string; skill_ids: string; plugin_ids: string; effort: string | null }
const strings = (json: string): string[] => { try { const value = JSON.parse(json) as unknown; return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; } catch { return []; } };

export class ChatQueue {
  constructor(private readonly store: AgentStore) {
    store.database().exec(`CREATE TABLE IF NOT EXISTS chat_queue_chips (id TEXT PRIMARY KEY, skill_ids TEXT NOT NULL, plugin_ids TEXT NOT NULL, effort TEXT);
      CREATE TABLE IF NOT EXISTS chat_queue_state (chat_id TEXT PRIMARY KEY, paused TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_queue_errors (id TEXT PRIMARY KEY, error TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_queue_native (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, submission_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_queue_stranded (submission_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL)`);
  }
  private get db() { return this.store.database(); }

  private chips(ids: string[]): Map<string, QueueChips & { error?: string }> {
    const found = new Map<string, QueueChips & { error?: string }>();
    if (!ids.length) return found;
    const marks = ids.map(() => '?').join(',');
    for (const row of this.db.prepare(`SELECT * FROM chat_queue_chips WHERE id IN (${marks})`).all(...ids) as unknown as ChipRow[]) {
      const skillIds = strings(row.skill_ids), pluginIds = strings(row.plugin_ids), effort = REASONING_EFFORTS.includes(row.effort as ReasoningEffort) ? row.effort as ReasoningEffort : undefined;
      found.set(row.id, { ...(skillIds.length ? { skillIds } : {}), ...(pluginIds.length ? { pluginIds } : {}), ...(effort ? { effort } : {}) });
    }
    for (const row of this.db.prepare(`SELECT * FROM chat_queue_errors WHERE id IN (${marks})`).all(...ids) as unknown as { id: string; error: string }[]) found.set(row.id, { ...found.get(row.id), error: row.error });
    return found;
  }
  private withChips(items: QueuedMessage[]): QueuedMessage[] {
    const chips = this.chips(items.map(item => item.id));
    return chips.size ? items.map(item => ({ ...item, ...chips.get(item.id) })) : items;
  }
  private saveChips(id: string, chips: QueueChips): void {
    if (!chips.skillIds?.length && !chips.pluginIds?.length && !chips.effort) return;
    this.db.prepare('INSERT OR REPLACE INTO chat_queue_chips (id, skill_ids, plugin_ids, effort) VALUES (?, ?, ?, ?)').run(id, JSON.stringify(chips.skillIds ?? []), JSON.stringify(chips.pluginIds ?? []), chips.effort ?? null);
  }
  private dropChips(id: string): void { this.db.prepare('DELETE FROM chat_queue_chips WHERE id = ?').run(id); this.db.prepare('DELETE FROM chat_queue_errors WHERE id = ?').run(id); this.clearNative(id); }

  /** Codex `thread/queue/*` mirror: the app-server submission that carries this queued message, if any. */
  nativeId(queueId: string): string | undefined { return (this.db.prepare('SELECT submission_id FROM chat_queue_native WHERE id = ?').get(queueId) as { submission_id: string } | undefined)?.submission_id; }
  setNative(chatId: string, queueId: string, submissionId: string): void { this.db.prepare('INSERT OR REPLACE INTO chat_queue_native (id, chat_id, submission_id) VALUES (?, ?, ?)').run(queueId, chatId, submissionId); }
  clearNative(queueId: string): void { this.db.prepare('DELETE FROM chat_queue_native WHERE id = ?').run(queueId); }
  /** Queued messages of a chat that the app-server holds natively, in queue order. */
  nativeRows(chatId: string): { queueId: string; submissionId: string }[] {
    const rows = new Map((this.db.prepare('SELECT id, submission_id FROM chat_queue_native WHERE chat_id = ?').all(chatId) as unknown as { id: string; submission_id: string }[]).map(row => [row.id, row.submission_id]));
    return this.store.queue(chatId).flatMap(item => rows.has(item.id) ? [{ queueId: item.id, submissionId: rows.get(item.id)! }] : []);
  }
  /**
   * Submissions the app-server may still hold for rows Muster now sends itself (taken back with no live session, or left
   * over from the previous process). The app-server would send them again when the thread goes idle, so each is deleted
   * once the chat's session is live. Persisted, so a restart before that session exists does not lose them.
   */
  strand(chatId: string, submissionId: string): void { this.db.prepare('INSERT OR REPLACE INTO chat_queue_stranded (submission_id, chat_id) VALUES (?, ?)').run(submissionId, chatId); }
  stranded(chatId: string): string[] { return (this.db.prepare('SELECT submission_id FROM chat_queue_stranded WHERE chat_id = ?').all(chatId) as unknown as { submission_id: string }[]).map(row => row.submission_id); }
  clearStranded(chatId: string): void { this.db.prepare('DELETE FROM chat_queue_stranded WHERE chat_id = ?').run(chatId); }
  /** Drops a row the app-server already dispatched (or deleted) natively; its turn shows the message. */
  dropSent(chatId: string, queueId: string): QueuedMessage | undefined {
    const removed = this.store.removeQueued(chatId, queueId);
    if (removed) this.dropChips(queueId);
    if (!this.store.queue(chatId).length) this.resume(chatId);
    return removed;
  }

  list(chatId: string): QueuedMessage[] { return this.withChips(this.store.queue(chatId)); }

  /** Snapshot chats carry their queue without chips; add them (and the pause) for the renderer. */
  decorate(chat: Chat): Chat {
    if (!chat.queue?.length) return chat;
    const paused = this.paused(chat.id);
    return { ...chat, queue: this.withChips(chat.queue), ...(paused ? { queuePaused: paused } : {}) };
  }

  add(chatId: string, input: { text: string; requestId: string; attachmentIds: string[] } & QueueChips): QueuedMessage {
    if (!input.text.trim() && input.attachmentIds.length === 0) throw new Error('Write a message first.');
    if (this.store.receipt(input.requestId)) throw new Error('This message was already sent.');
    const item = this.store.enqueue(chatId, { id: randomUUID(), text: input.text, requestId: input.requestId, attachmentIds: input.attachmentIds, createdAt: new Date().toISOString() }, MAX_QUEUED_MESSAGES);
    const chips: QueueChips = { ...(input.skillIds?.length ? { skillIds: input.skillIds } : {}), ...(input.pluginIds?.length ? { pluginIds: input.pluginIds } : {}), ...(input.effort ? { effort: input.effort } : {}) };
    this.saveChips(item.id, chips);
    return { ...item, ...chips };
  }

  update(chatId: string, queueId: string, text: string): QueuedMessage {
    const current = this.store.queued(chatId, queueId);
    if (!current) throw new Error('This queued message was already sent or removed.');
    if (!text.trim() && current.attachmentIds.length === 0) throw new Error('A queued message cannot be empty. Remove it instead.');
    const updated = this.store.updateQueued(chatId, queueId, text);
    this.clearError(queueId);
    return this.withChips([updated])[0];
  }

  remove(chatId: string, queueId: string): QueuedMessage | undefined {
    const extra = this.chips([queueId]).get(queueId);
    const removed = this.store.removeQueued(chatId, queueId);
    if (removed) this.dropChips(queueId);
    if (!this.store.queue(chatId).length) this.resume(chatId);
    const { error: _error, ...chips } = extra ?? {};
    return removed ? { ...removed, ...chips } : undefined;
  }

  move(chatId: string, queueId: string, direction: 'up' | 'down'): void { this.store.moveQueued(chatId, queueId, direction); }

  /** Drag-to-reorder: `ids` must name exactly the chat's queued messages, in the new order. */
  reorder(chatId: string, ids: readonly string[]): void {
    const current = this.store.queue(chatId).map(item => item.id);
    if (ids.length !== current.length || new Set(ids).size !== ids.length || ids.some(id => !current.includes(id))) throw new Error('The queue changed. Try moving the message again.');
    const set = this.db.prepare('UPDATE chat_queue SET position = ? WHERE chat_id = ? AND id = ?');
    this.db.exec('BEGIN');
    try { ids.forEach((id, index) => set.run(index, chatId, id)); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** Moves one message to the head so it is the next to send. */
  promote(chatId: string, queueId: string): void {
    const ids = this.store.queue(chatId).map(item => item.id);
    if (!ids.includes(queueId)) throw new Error('This queued message was already sent or removed.');
    this.reorder(chatId, [queueId, ...ids.filter(id => id !== queueId)]);
  }

  /** The next message to dispatch, with its chips. It stays queued until `consume` runs inside the send's receipt transaction. */
  head(chatId: string): QueuedMessage | undefined {
    const head = this.store.queue(chatId)[0];
    return head ? this.withChips([head])[0] : undefined;
  }

  /**
   * #450: removes a dispatched row inside chat.send's receipt transaction (raw statements: the store's
   * transaction is already open), so a quit between dispatch and send neither loses the message nor
   * sends it twice. Throws QueueChangedError when the row was removed or edited after dispatch began.
   */
  consume(chatId: string, item: QueuedMessage): void {
    const row = this.db.prepare('SELECT text, attachment_ids FROM chat_queue WHERE chat_id = ? AND id = ?').get(chatId, item.id) as { text: string; attachment_ids: string } | undefined;
    if (!row || row.text !== item.text || row.attachment_ids !== JSON.stringify(item.attachmentIds)) throw new QueueChangedError();
    this.db.prepare('DELETE FROM chat_queue WHERE chat_id = ? AND id = ?').run(chatId, item.id);
    this.dropChips(item.id);
  }

  /** Marks a refused row so it offers Retry instead of being skipped. */
  fail(queueId: string, error: string): void { this.db.prepare('INSERT OR REPLACE INTO chat_queue_errors (id, error) VALUES (?, ?)').run(queueId, error.slice(0, 2000)); }

  /**
   * #450, at boot: a row whose request id already has a send receipt was sent (never send it again);
   * rows the Codex app-server held natively come back under Muster's dispatch, because that process
   * and its in-memory queue ended with the app. Returns the chats whose queue changed.
   */
  recoverAtBoot(): string[] {
    // The app-server's copies of every native row are stranded first (even for rows already sent): its process may outlive Muster's and would send them again.
    for (const row of this.db.prepare('SELECT chat_id, submission_id FROM chat_queue_native').all() as unknown as { chat_id: string; submission_id: string }[]) this.strand(row.chat_id, row.submission_id);
    const sent = this.db.prepare('SELECT q.chat_id AS chat_id, q.id AS id FROM chat_queue q JOIN receipts r ON r.request_id = q.request_id').all() as unknown as { chat_id: string; id: string }[];
    for (const row of sent) { this.db.prepare('DELETE FROM chat_queue WHERE chat_id = ? AND id = ?').run(row.chat_id, row.id); this.dropChips(row.id); }
    const native = this.db.prepare('SELECT DISTINCT chat_id FROM chat_queue_native').all() as unknown as { chat_id: string }[];
    this.db.exec('DELETE FROM chat_queue_native');
    return [...new Set([...sent.map(row => row.chat_id), ...native.map(row => row.chat_id)])];
  }
  clearError(queueId: string): void { this.db.prepare('DELETE FROM chat_queue_errors WHERE id = ?').run(queueId); }

  /** Why the queue is not dispatching, or undefined when it runs. */
  paused(chatId: string): QueuePause | undefined {
    const row = this.db.prepare('SELECT paused FROM chat_queue_state WHERE chat_id = ?').get(chatId) as { paused: string } | undefined;
    return row?.paused === 'interrupted' || row?.paused === 'failed' || row?.paused === 'limited' ? row.paused : undefined;
  }
  pause(chatId: string, reason: QueuePause): void { this.db.prepare('INSERT OR REPLACE INTO chat_queue_state (chat_id, paused) VALUES (?, ?)').run(chatId, reason); }
  resume(chatId: string): void { this.db.prepare('DELETE FROM chat_queue_state WHERE chat_id = ?').run(chatId); }

  /** Attachment ids a queued message still owns; the composer must not show them as its own. */
  attachmentIds(chatId: string): Set<string> { return new Set(this.store.queue(chatId).flatMap(item => item.attachmentIds)); }
}
