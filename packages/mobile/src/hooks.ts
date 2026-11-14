/** Live views of the desktop over one MobileConnection: the chat list, one chat, the needs-you feed, this phone's access. */
import {useEffect, useState} from 'react';
import {TimelineStore} from './timeline/store';
import {cacheScopeOf, chatSaver, offlineOf} from './offline/connection';
import type {OutboxEntry} from './offline/cache';
import {haptics} from './haptics';
import {type MobileAccess, type MobileChat, type MobileConnection, type MobileItemOp, type MobileNeed} from './shared';

export const READ_ONLY_NOTE = 'Read only: allow this phone to act in Settings on your computer';
export const requestId = (): string => `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
export const errorText = (error: unknown): string => (error as Error)?.message || 'That did not work.';

export function useAccess(connection: MobileConnection): MobileAccess {
  const [access, setAccess] = useState(connection.access);
  useEffect(() => connection.on(event => { if (event.type === 'access') setAccess(event.access); }), [connection]);
  return access;
}

/**
 * One chat, live, in a per-item store (src/timeline/store.ts). The phone asks for deltas (phase 3): numbered changes that
 * carry only appended text and changed items, so a streaming reply costs a few bytes per token and only its own row changes.
 * Deltas that arrive before chat.open answers wait and are applied after it; a skipped number (a missed delta) reopens the
 * chat and takes the desktop's state as it is. A new connection (after a reconnect) opens the chat again, which is the same
 * resync. Phase 1 desktops send whole items instead.
 */
export function useChat(connection: MobileConnection, chatId: string) {
  const [chat, setChat] = useState<MobileChat | null>(null);
  const [store] = useState(() => new TimelineStore());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    /** Null while chat.open is in flight: deltas wait in `waiting`. */
    let seq: number | null = null;
    let waiting: Array<{seq: number; ops: MobileItemOp[]}> = [];
    /** Items that were there when the chat opened: their streaming makes no haptic texture. */
    let opened = new Set<string>();
    /** The open chat is kept for offline reading (a live connection only; the cached one is what it reads). */
    let current: MobileChat | null = null;
    const saver = chatSaver(offlineOf(connection) ? undefined : cacheScopeOf(connection), chatId);
    const persist = () => saver.save(current, store.getIds().map(id => store.getItem(id)!));
    const apply = (delta: {seq: number; ops: MobileItemOp[]}) => {
      if (seq === null) { waiting.push(delta); return; }
      if (delta.seq <= seq) return;
      if (delta.seq !== seq + 1 || !store.apply(delta.ops)) { open(); return; }
      seq = delta.seq;
      persist();
      if (delta.ops.some(op => !('item' in op) && op.append && !opened.has(op.id))) haptics.streamTick();
    };
    const open = () => {
      seq = null; waiting = [];
      connection.call('chat.open', {id: chatId, deltas: true}).then(result => {
        if (!live) return;
        current = result.chat;
        setChat(existing => existing ?? result.chat);
        setError(null);
        opened = new Set(result.items.map(item => item.id));
        if (result.seq === undefined) { store.upsert(result.items); persist(); return; }
        seq = result.seq;
        store.reset(result.items);
        const held = waiting.sort((a, b) => a.seq - b.seq);
        waiting = [];
        for (const delta of held) { if (seq === null) break; apply(delta); }
        persist();
      }, failure => { if (live) setError(errorText(failure)); });
    };
    const off = connection.on(event => {
      if (event.type === 'delta' && event.chatId === chatId) apply(event);
      else if (event.type === 'items' && event.chatId === chatId) { store.upsert(event.items); persist(); }
      else if (event.type === 'chats') { const found = event.chats.find(entry => entry.id === chatId); if (found) { current = found; setChat(found); } }
    });
    open();
    return () => { live = false; off(); saver.flush(); void connection.call('chat.close', {id: chatId}).catch(() => undefined); };
  }, [connection, chatId, store]);
  return {chat, store, error};
}

export function useNeeds(connection: MobileConnection) {
  const [needs, setNeeds] = useState<MobileNeed[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const off = connection.on(event => { if (event.type === 'needs') setNeeds(event.needs); });
    connection.call('needs.list', {}).then(result => setNeeds(result.needs), failure => setError(errorText(failure)));
    return off;
  }, [connection]);
  return {needs, error};
}

/** How many approvals and questions wait across chats, for the Needs you tab's badge (0 while not connected). */
export function useNeedsCount(connection: MobileConnection | null): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!connection) { setCount(0); return; }
    let live = true;
    const off = connection.on(event => { if (event.type === 'needs') setCount(event.needs.length); });
    connection.call('needs.list', {}).then(result => { if (live) setCount(result.needs.length); }, () => undefined);
    return () => { live = false; off(); };
  }, [connection]);
  return count;
}

/** Messages written to this chat offline that wait to go out (#326 phase 4). */
export function useOutbox(connection: MobileConnection, chatId: string) {
  const scope = cacheScopeOf(connection);
  const read = () => scope ? scope.cache.outbox(scope.computerId, chatId) : NO_ENTRIES;
  const [entries, setEntries] = useState(read);
  useEffect(() => { setEntries(read()); return scope?.cache.subscribe(() => setEntries(read())); }, [connection, chatId]);
  return entries;
}
const NO_ENTRIES: OutboxEntry[] = [];
