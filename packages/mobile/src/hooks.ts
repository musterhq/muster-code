/** Live views of the desktop over one MobileConnection: the chat list, one chat, the needs-you feed, this phone's access. */
import {useEffect, useState} from 'react';
import {applyItemOps, type MobileAccess, type MobileChat, type MobileConnection, type MobileItem, type MobileItemOp, type MobileNeed} from './shared';

export const READ_ONLY_NOTE = 'Read only: allow this phone to act in Settings on your computer';
export const requestId = (): string => `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
export const errorText = (error: unknown): string => (error as Error)?.message || 'That did not work.';

export function useAccess(connection: MobileConnection): MobileAccess {
  const [access, setAccess] = useState(connection.access);
  useEffect(() => connection.on(event => { if (event.type === 'access') setAccess(event.access); }), [connection]);
  return access;
}

export function useChats(connection: MobileConnection) {
  const [chats, setChats] = useState<MobileChat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => connection.call('chats.list', {}).then(result => { setChats(result.chats); setError(null); }, failure => setError(errorText(failure)));
  useEffect(() => {
    const off = connection.on(event => { if (event.type === 'chats') setChats(event.chats); });
    void refresh();
    return off;
  }, [connection]);
  return {chats, error, refresh};
}

/** Merges item events into the list: a known id is replaced in place (a streaming reply grows), a new one is appended. */
export function mergeItems(current: MobileItem[], incoming: MobileItem[]): MobileItem[] {
  const next = [...current];
  const at = new Map(next.map((item, index) => [item.id, index]));
  for (const item of incoming) {
    const index = at.get(item.id);
    if (index === undefined) { at.set(item.id, next.length); next.push(item); } else next[index] = item;
  }
  return next;
}

/**
 * One chat, live. The phone asks for deltas (phase 3): numbered changes that carry only appended text and changed items, so a
 * streaming reply costs a few bytes per token and only its own row changes. Deltas that arrive before chat.open answers wait
 * and are applied after it; a skipped number (a missed delta) reopens the chat and takes the desktop's state as it is. A new
 * connection (after a reconnect) opens the chat again, which is the same resync. Phase 1 desktops send whole items instead.
 */
export function useChat(connection: MobileConnection, chatId: string) {
  const [chat, setChat] = useState<MobileChat | null>(null);
  const [items, setItems] = useState<MobileItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    /** Null while chat.open is in flight: deltas wait in `waiting`. */
    let seq: number | null = null;
    let current: MobileItem[] = [];
    let waiting: Array<{seq: number; ops: MobileItemOp[]}> = [];
    const show = (next: MobileItem[]) => { current = next; setItems(next); };
    const apply = (delta: {seq: number; ops: MobileItemOp[]}) => {
      if (seq === null) { waiting.push(delta); return; }
      if (delta.seq <= seq) return;
      const next = delta.seq === seq + 1 ? applyItemOps(current, delta.ops) : null;
      if (!next) { open(); return; }
      seq = delta.seq;
      show(next);
    };
    const open = () => {
      seq = null; waiting = [];
      connection.call('chat.open', {id: chatId, deltas: true}).then(result => {
        if (!live) return;
        setChat(existing => existing ?? result.chat);
        setError(null);
        if (result.seq === undefined) { show(mergeItems(result.items, current)); return; }
        seq = result.seq;
        show(result.items);
        const held = waiting.sort((a, b) => a.seq - b.seq);
        waiting = [];
        for (const delta of held) { if (seq === null) break; apply(delta); }
      }, failure => { if (live) setError(errorText(failure)); });
    };
    const off = connection.on(event => {
      if (event.type === 'delta' && event.chatId === chatId) apply(event);
      else if (event.type === 'items' && event.chatId === chatId) show(mergeItems(current, event.items));
      else if (event.type === 'chats') { const found = event.chats.find(entry => entry.id === chatId); if (found) setChat(found); }
    });
    open();
    return () => { live = false; off(); void connection.call('chat.close', {id: chatId}).catch(() => undefined); };
  }, [connection, chatId]);
  return {chat, items, error};
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
