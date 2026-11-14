/** Holds the phone's links to every paired computer (#326 phase 4): loads the pairing records from secure storage, keeps
 *  one link per computer (each reconnects with backoff and a heartbeat on its own), pairs and unpairs, and remembers which
 *  computer the person chose and whether all are shown together. Screens read the chosen computer's connection, which is the
 *  live one or, while it can't be reached, the cached stand-in. */
import {createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode} from 'react';
import {AppState, Platform} from 'react-native';
import * as SecureStore from 'expo-secure-store';
import {getRandomBytes} from 'expo-crypto';
import Constants from 'expo-constants';
import {connectPhone, pairPhone, type MobileConnection, type PairedRecord, type PairingLink, type SocketLike} from '../shared';
import {nobleNoiseCrypto} from './noble-crypto';
import {createComputerStore, type ComputerStore, type SecureStoreLike} from './store';
import {Computers, type ComputerView} from './computers';
import {OfflineCache} from '../offline/cache';
import {openCacheDb} from '../offline/db';

/** A pairing in progress: show `checkCode`; `confirmed` settles once the desktop adds the phone. */
export interface PendingPairing { record: PairedRecord; checkCode: string; confirmed: Promise<void> }
interface LinkContext {
  phase: 'loading' | 'ready';
  computers: ComputerView[];
  /** The chosen computer (the first when none was chosen); null with none paired. */
  selected: ComputerView | null;
  showAll: boolean;
  store: ComputerStore;
  select(id: string): void;
  setShowAll(on: boolean): void;
  pair(link: PairingLink): Promise<PendingPairing>;
  /** A pairing was confirmed and saved: connect to that computer and choose it. */
  paired(record: PairedRecord): void;
  unpair(id: string): Promise<void>;
  retry(id?: string): void;
  computer(id: string | undefined): ComputerView | null;
}
const Context = createContext<LinkContext | null>(null);

const secure: SecureStoreLike = {
  getItemAsync: key => SecureStore.getItemAsync(key, {keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY}),
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, {keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY}),
  deleteItemAsync: key => SecureStore.deleteItemAsync(key),
};
const crypto = nobleNoiseCrypto(length => getRandomBytes(length));
const socket = (url: string) => new WebSocket(url) as unknown as SocketLike;
const phoneName = () => String(Constants.deviceName ?? (Platform.OS === 'ios' ? 'iPhone' : 'Android phone')).slice(0, 80);
/** Not secret: which computer is chosen and whether all show together. Kept in the cache database, under no computer. */
interface Prefs { selected: string | null; showAll: boolean }
const PREFS_COMPUTER = '';
function openCache(): OfflineCache | null { try { return new OfflineCache(openCacheDb()); } catch { return null; } }

export function ConnectionProvider({children}: {children: ReactNode}) {
  const [{store, cache, computers}] = useState(() => {
    const store = createComputerStore(secure), cache = openCache();
    return {store, cache, computers: new Computers({store, cache, connect: record => connectPhone({record, crypto, socket})})};
  });
  const views = useSyncExternalStore(computers.subscribe, computers.views);
  const [phase, setPhase] = useState<'loading' | 'ready'>('loading');
  const [prefs, setPrefs] = useState<Prefs>(() => cache?.list<Prefs>(PREFS_COMPUTER, 'prefs')?.value ?? {selected: null, showAll: false});
  const savePrefs = (next: Prefs) => { setPrefs(next); cache?.saveList(PREFS_COMPUTER, 'prefs', next); };

  useEffect(() => {
    void computers.load().finally(() => setPhase('ready'));
    // Back in the foreground: every link checks itself now (a dead one reconnects without waiting out its backoff).
    const sub = AppState.addEventListener('change', next => { if (next === 'active') computers.retry(); });
    return () => { sub.remove(); computers.dispose(); };
  }, [computers]);

  const value = useMemo<LinkContext>(() => {
    const selected = views.find(view => view.id === prefs.selected) ?? views[0] ?? null;
    return {
      phase, computers: views, selected, showAll: prefs.showAll && views.length > 1, store,
      select: id => savePrefs({...prefs, selected: id}),
      setShowAll: on => savePrefs({...prefs, showAll: on}),
      async pair(link) {
        const {client, record, checkCode, confirmed} = await pairPhone({link, crypto, socket, name: phoneName(), platform: Platform.OS});
        // The pairing connection stays open until the desktop adds (or rejects) the phone; sessions then use the record.
        const done = confirmed.finally(() => client.close());
        done.catch(() => undefined);
        return {record, checkCode, confirmed: done};
      },
      paired(record) { computers.add(record); savePrefs({...prefs, selected: record.route}); },
      unpair: id => computers.remove(id),
      retry: id => computers.retry(id),
      computer: id => (id ? views.find(view => view.id === id) : undefined) ?? selected,
    };
  }, [views, prefs, phase, store, computers]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useLink(): LinkContext {
  const value = useContext(Context);
  if (!value) throw new Error('useLink outside ConnectionProvider');
  return value;
}
/** The connection for one computer (the chosen one when `id` is not given), live or cached. */
export function useComputerConnection(id?: string): {view: ComputerView | null; connection: MobileConnection | null} {
  const view = useLink().computer(id);
  return {view, connection: view?.connection ?? null};
}
