/**
 * Per-chat prompt stash: named draft snapshots saved explicitly by the user.
 * Local-only (localStorage); no provider or network involvement (CMP-19).
 */
export interface StashEntry {
  id: string;
  name: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  bytes: number;
}
export type StashMap = Record<string, StashEntry[]>; // chatId -> entries, newest first

const KEY = 'muster.composerStash.v1';
export const MAX_STASH_ENTRIES = 20;
export const MAX_STASH_BYTES = 128 * 1024;

function textBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** First non-blank line, trimmed, used when the user does not name a stash entry. */
export function previewName(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  const trimmed = line.trim().slice(0, 60);
  return trimmed || 'Untitled stash';
}

/** Reads and sanitizes the stash map. Corrupt/oversized/unavailable storage yields {} rather than throwing. */
export function readStash(storage: Pick<Storage, 'getItem'> = localStorage): StashMap {
  try {
    const raw = storage.getItem(KEY);
    if (!raw || raw.length > 4 * MAX_STASH_BYTES) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const result: StashMap = {};
    for (const [chatId, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof chatId !== 'string' || chatId.length > 128 || !Array.isArray(list)) continue;
      const entries: StashEntry[] = [];
      let total = 0;
      for (const raw of list) {
        const e = raw as Partial<StashEntry> | null;
        if (!e || typeof e.id !== 'string' || typeof e.name !== 'string' || typeof e.text !== 'string') continue;
        if (typeof e.createdAt !== 'number' || typeof e.updatedAt !== 'number') continue;
        const bytes = textBytes(e.text);
        if (entries.length >= MAX_STASH_ENTRIES || total + bytes > MAX_STASH_BYTES) continue;
        entries.push({ id: e.id, name: e.name.slice(0, 200), text: e.text, createdAt: e.createdAt, updatedAt: e.updatedAt, bytes });
        total += bytes;
      }
      if (entries.length) result[chatId] = entries;
    }
    return result;
  } catch {
    return {};
  }
}

function writeStash(map: StashMap, storage: Pick<Storage, 'setItem'> = localStorage): boolean {
  try {
    storage.setItem(KEY, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}

export interface AddStashResult {
  ok: boolean;
  reason?: string;
  entry?: StashEntry;
  evicted?: number;
}

/**
 * Adds an entry to chatId's stash. Evicts oldest entries (FIFO) to stay within
 * MAX_STASH_ENTRIES/MAX_STASH_BYTES; refuses only when the entry itself cannot fit
 * or storage rejects the write (quota, private-mode, unavailable).
 */
export function addStashEntry(
  map: StashMap,
  chatId: string,
  text: string,
  name: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
): AddStashResult {
  const bytes = textBytes(text);
  if (!text.trim()) return { ok: false, reason: 'Nothing to stash: draft is empty.' };
  if (bytes > MAX_STASH_BYTES) {
    return { ok: false, reason: `Draft is ${Math.ceil(bytes / 1024)} KiB; stash limit is ${MAX_STASH_BYTES / 1024} KiB per entry.` };
  }
  const existing = [...(map[chatId] ?? [])];
  let total = existing.reduce((sum, e) => sum + e.bytes, 0);
  let evicted = 0;
  while (existing.length && (existing.length >= MAX_STASH_ENTRIES || total + bytes > MAX_STASH_BYTES)) {
    const removed = existing.pop();
    if (removed) {
      total -= removed.bytes;
      evicted++;
    }
  }
  const entry: StashEntry = {
    id: crypto.randomUUID(),
    name: (name.trim() || previewName(text)).slice(0, 200),
    text,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    bytes,
  };
  const next = { ...map, [chatId]: [entry, ...existing] };
  if (!writeStash(next, storage)) {
    return { ok: false, reason: 'Could not save to local storage. Stash not persisted.' };
  }
  return { ok: true, entry, evicted };
}

export function removeStashEntry(map: StashMap, chatId: string, id: string, storage: Pick<Storage, 'setItem'> = localStorage): StashMap {
  const list = (map[chatId] ?? []).filter((e) => e.id !== id);
  const next = { ...map };
  if (list.length) next[chatId] = list;
  else delete next[chatId];
  writeStash(next, storage);
  return next;
}
