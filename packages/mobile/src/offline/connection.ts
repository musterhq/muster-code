/** Connections the screens use per computer (#326 phase 4). Online, `cachingConnection` passes everything through and keeps
 *  the chat list, Needs you and this phone's access in the offline cache as they arrive. Offline, `offlineConnection`
 *  answers reads from that cache and refuses everything else, so the screens show the last known state unchanged. */
import {MobileError, type MobileAccess, type MobileChat, type MobileConnection, type MobileItem, type MobileNeed} from '../shared';
import type {OfflineCache} from './cache';

export interface CacheScope { computerId: string; name: string; cache: OfflineCache }
export interface OfflineInfo extends CacheScope { retry(): void }
const SCOPE = Symbol('muster.cache'), OFFLINE = Symbol('muster.offline');
type Tagged = MobileConnection & {[SCOPE]?: CacheScope; [OFFLINE]?: OfflineInfo};
/** The cache behind a connection, if any (screens save the open chat there). */
export const cacheScopeOf = (connection: MobileConnection): CacheScope | undefined => (connection as Tagged)[SCOPE];
/** Set when the connection is the cached stand-in for a computer that is not reachable. */
export const offlineOf = (connection: MobileConnection): OfflineInfo | undefined => (connection as Tagged)[OFFLINE];

export function cachingConnection(live: MobileConnection, scope: CacheScope): MobileConnection {
  const {cache, computerId} = scope;
  cache.saveList(computerId, 'access', live.access);
  live.on(event => {
    if (event.type === 'chats') cache.saveList(computerId, 'chats', event.chats);
    else if (event.type === 'needs') cache.saveList(computerId, 'needs', event.needs);
    else if (event.type === 'access') cache.saveList(computerId, 'access', event.access);
  });
  const wrapped: Tagged = {
    get desktopName() { return live.desktopName; }, get deviceId() { return live.deviceId; }, get access() { return live.access; },
    get closed() { return live.closed; }, get via() { return live.via; }, get lan() { return live.lan; },
    on: listener => live.on(listener), onClose: listener => live.onClose(listener), close: () => live.close(),
    call: (async (method, params) => {
      const result = await live.call(method, params);
      if (method === 'chats.list') cache.saveList(computerId, 'chats', (result as {chats: MobileChat[]}).chats);
      else if (method === 'needs.list') cache.saveList(computerId, 'needs', (result as {needs: MobileNeed[]}).needs);
      return result;
    }) as MobileConnection['call'],
  };
  wrapped[SCOPE] = scope;
  return wrapped;
}

export function offlineConnection(info: OfflineInfo): MobileConnection {
  const {cache, computerId, name} = info;
  const gone = () => new MobileError('offline', `${name} is offline. This works again once it is back.`);
  const connection: Tagged = {
    desktopName: name, deviceId: '', closed: true, via: 'relay', lan: [],
    get access() { return cache.list<MobileAccess>(computerId, 'access')?.value ?? 'read-only'; },
    async call(method, params) {
      if (method === 'chats.list') return {chats: cache.list<MobileChat[]>(computerId, 'chats')?.value ?? []} as never;
      if (method === 'needs.list') return {needs: cache.list<MobileNeed[]>(computerId, 'needs')?.value ?? []} as never;
      if (method === 'chat.close') return {} as never;
      if (method === 'chat.open') {
        const saved = cache.chat(computerId, (params as {id: string}).id);
        if (!saved) throw new MobileError('offline', `${name} is offline, and this chat was not opened on this phone before.`);
        return {chat: saved.chat, items: saved.items, revision: 0} as never;
      }
      throw gone();
    },
    on: () => () => undefined,
    onClose: () => () => undefined,
    close() {},
  };
  connection[SCOPE] = info;
  connection[OFFLINE] = info;
  return connection;
}
/** Saves the open chat's items (at most every 2 seconds while it streams, and when it closes). */
export function chatSaver(scope: CacheScope | undefined, chatId: string) {
  let timer: ReturnType<typeof setTimeout> | undefined, latest: {chat: MobileChat; items: readonly MobileItem[]} | null = null;
  const write = () => { timer = undefined; if (scope && latest) scope.cache.saveChat(scope.computerId, latest.chat, latest.items); };
  return {
    save(chat: MobileChat | null, items: readonly MobileItem[]) { if (!scope || !chat || chat.id !== chatId) return; latest = {chat, items}; timer ??= setTimeout(write, 2000); },
    flush() { clearTimeout(timer); write(); },
  };
}
