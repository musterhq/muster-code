/**
 * What the phone keeps so it opens with no connection (#326 phase 4): per computer, its last chat list, Needs you, this
 * phone's access and the chats it opened, plus the outbox of messages written offline. Only what the computer already sent
 * this phone is stored, keyed by computer, and a computer's rows are wiped when it revokes the phone or is unpaired.
 */
import type {MobileChat, MobileItem} from '../shared';
import type {SqlDb} from './db';

/** Chats kept per computer (the most recently synced). */
export const CACHED_CHATS = 40;
export interface OutboxEntry { id: string; chatId: string; text: string; createdAt: number; error: string | null }
type ListKey = 'chats' | 'needs' | 'access' | 'prefs';

export class OfflineCache {
  private readonly listeners = new Set<() => void>();
  constructor(private readonly db: SqlDb) {
    db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS lists (computer TEXT NOT NULL, key TEXT NOT NULL, json TEXT NOT NULL, synced INTEGER NOT NULL, PRIMARY KEY (computer, key));
      CREATE TABLE IF NOT EXISTS chat_items (computer TEXT NOT NULL, chat TEXT NOT NULL, json TEXT NOT NULL, synced INTEGER NOT NULL, PRIMARY KEY (computer, chat));
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, computer TEXT NOT NULL, chat TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL, error TEXT);`);
  }
  /** Called when the outbox changes, so queued bubbles update. */
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed(): void { for (const listener of [...this.listeners]) listener(); }

  saveList(computer: string, key: ListKey, value: unknown, at = Date.now()): void {
    this.db.run('INSERT INTO lists (computer, key, json, synced) VALUES (?, ?, ?, ?) ON CONFLICT (computer, key) DO UPDATE SET json = excluded.json, synced = excluded.synced', computer, key, JSON.stringify(value), at);
  }
  list<T>(computer: string, key: ListKey): {value: T; synced: number} | null {
    const row = this.db.all<{json: string; synced: number}>('SELECT json, synced FROM lists WHERE computer = ? AND key = ?', computer, key)[0];
    return row ? {value: JSON.parse(row.json) as T, synced: row.synced} : null;
  }
  /** When this phone last heard from the computer. */
  lastSync(computer: string): number | null {
    const row = this.db.all<{at: number | null}>('SELECT MAX(synced) AS at FROM (SELECT synced FROM lists WHERE computer = ? UNION ALL SELECT synced FROM chat_items WHERE computer = ?)', computer, computer)[0];
    return row?.at ?? null;
  }
  saveChat(computer: string, chat: MobileChat, items: readonly MobileItem[], at = Date.now()): void {
    this.db.run('INSERT INTO chat_items (computer, chat, json, synced) VALUES (?, ?, ?, ?) ON CONFLICT (computer, chat) DO UPDATE SET json = excluded.json, synced = excluded.synced', computer, chat.id, JSON.stringify({chat, items}), at);
    this.db.run('DELETE FROM chat_items WHERE computer = ? AND chat NOT IN (SELECT chat FROM chat_items WHERE computer = ? ORDER BY synced DESC LIMIT ?)', computer, computer, CACHED_CHATS);
  }
  chat(computer: string, chatId: string): {chat: MobileChat; items: MobileItem[]; synced: number} | null {
    const row = this.db.all<{json: string; synced: number}>('SELECT json, synced FROM chat_items WHERE computer = ? AND chat = ?', computer, chatId)[0];
    return row ? {...(JSON.parse(row.json) as {chat: MobileChat; items: MobileItem[]}), synced: row.synced} : null;
  }

  enqueue(computer: string, chatId: string, text: string): OutboxEntry {
    const entry: OutboxEntry = {id: `o-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, chatId, text, createdAt: Date.now(), error: null};
    this.db.run('INSERT INTO outbox (id, computer, chat, text, created, error) VALUES (?, ?, ?, ?, ?, NULL)', entry.id, computer, chatId, text, entry.createdAt);
    this.changed();
    return entry;
  }
  /** Waiting messages in the order they were written. */
  outbox(computer: string, chatId?: string): OutboxEntry[] {
    const rows = this.db.all<{id: string; chat: string; text: string; created: number; error: string | null}>(
      `SELECT id, chat, text, created, error FROM outbox WHERE computer = ?${chatId ? ' AND chat = ?' : ''} ORDER BY created, rowid`, ...(chatId ? [computer, chatId] : [computer]));
    return rows.map(row => ({id: row.id, chatId: row.chat, text: row.text, createdAt: row.created, error: row.error}));
  }
  sent(id: string): void { this.db.run('DELETE FROM outbox WHERE id = ?', id); this.changed(); }
  failed(id: string, error: string): void { this.db.run('UPDATE outbox SET error = ? WHERE id = ?', error, id); this.changed(); }
  /** Everything cached from one computer goes: its lists, chats and unsent messages. */
  wipe(computer: string): void {
    for (const table of ['lists', 'chat_items', 'outbox']) this.db.run(`DELETE FROM ${table} WHERE computer = ?`, computer);
    this.changed();
  }
}
