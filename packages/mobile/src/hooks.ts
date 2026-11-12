/** Live views of the desktop over one MobileConnection: the chat list, one chat, the needs-you feed, this phone's access. */
import {useEffect, useState} from 'react';
import type {MobileAccess, MobileChat, MobileConnection, MobileItem, MobileNeed} from './shared';

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

export function useChat(connection: MobileConnection, chatId: string) {
  const [chat, setChat] = useState<MobileChat | null>(null);
  const [items, setItems] = useState<MobileItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const off = connection.on(event => {
      if (event.type === 'items' && event.chatId === chatId) setItems(current => mergeItems(current, event.items));
      if (event.type === 'chats') { const found = event.chats.find(entry => entry.id === chatId); if (found) setChat(found); }
    });
    connection.call('chat.open', {id: chatId}).then(result => {
      if (!live) return;
      setChat(current => current ?? result.chat);
      setItems(current => mergeItems(result.items, current));
    }, failure => { if (live) setError(errorText(failure)); });
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
