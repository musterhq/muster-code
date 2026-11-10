/** Holds the phone's one link to its computer: loads the pairing record from secure storage, connects (and reconnects with
 *  backoff, also when the app returns to the foreground), and pairs or unpairs. */
import {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {AppState, Platform} from 'react-native';
import * as SecureStore from 'expo-secure-store';
import {getRandomBytes} from 'expo-crypto';
import Constants from 'expo-constants';
import {connectPhone, MobileError, pairPhone, type MobileConnection, type PairedRecord, type PairingLink, type SocketLike} from '../shared';
import {nobleNoiseCrypto} from './noble-crypto';
import {createPairingStore, type PairingStore, type SecureStoreLike} from './store';

export type LinkState = {phase: 'loading'} | {phase: 'unpaired'} | {phase: 'connecting'; record: PairedRecord; error?: string}
  | {phase: 'connected'; record: PairedRecord; connection: MobileConnection} | {phase: 'revoked'; record: PairedRecord};
interface LinkContext { state: LinkState; store: PairingStore; pair(link: PairingLink): Promise<PairedRecord>; unpair(): Promise<void>; retry(): void }
const Context = createContext<LinkContext | null>(null);

const secure: SecureStoreLike = {
  getItemAsync: key => SecureStore.getItemAsync(key, {keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY}),
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, {keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY}),
  deleteItemAsync: key => SecureStore.deleteItemAsync(key),
};
const crypto = nobleNoiseCrypto(length => getRandomBytes(length));
const socket = (url: string) => new WebSocket(url) as unknown as SocketLike;
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];
const phoneName = () => String(Constants.deviceName ?? (Platform.OS === 'ios' ? 'iPhone' : 'Android phone')).slice(0, 80);

export function ConnectionProvider({children}: {children: ReactNode}) {
  const store = useMemo(() => createPairingStore(secure), []);
  const [state, setState] = useState<LinkState>({phase: 'loading'});
  const attempt = useRef(0), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), current = useRef<MobileConnection | null>(null);

  const connect = useCallback((record: PairedRecord) => {
    if (timer.current) clearTimeout(timer.current);
    setState({phase: 'connecting', record});
    connectPhone({record, crypto, socket}).then(connection => {
      attempt.current = 0; current.current = connection;
      setState({phase: 'connected', record, connection});
      connection.onClose(reason => {
        current.current = null;
        if (reason === 'revoked') { setState({phase: 'revoked', record}); return; }
        timer.current = setTimeout(() => connect(record), BACKOFF_MS[Math.min(attempt.current++, BACKOFF_MS.length - 1)]);
      });
    }, (error: unknown) => {
      if (error instanceof MobileError && error.code === 'revoked') { setState({phase: 'revoked', record}); return; }
      setState({phase: 'connecting', record, error: (error as Error).message});
      timer.current = setTimeout(() => connect(record), BACKOFF_MS[Math.min(attempt.current++, BACKOFF_MS.length - 1)]);
    });
  }, []);

  useEffect(() => {
    void store.load().then(record => { if (record) connect(record); else setState({phase: 'unpaired'}); });
    const sub = AppState.addEventListener('change', next => {
      if (next !== 'active' || current.current) return;
      void store.load().then(record => { if (record) { attempt.current = 0; connect(record); } });
    });
    return () => { sub.remove(); if (timer.current) clearTimeout(timer.current); current.current?.close(); };
  }, [store, connect]);

  const value = useMemo<LinkContext>(() => ({
    state, store,
    async pair(link) {
      const {client, record} = await pairPhone({link, crypto, socket, name: phoneName(), platform: Platform.OS});
      client.close();
      return record;
    },
    async unpair() { current.current?.close(); current.current = null; if (timer.current) clearTimeout(timer.current); await store.clear(); setState({phase: 'unpaired'}); },
    retry() { void store.load().then(record => { if (record) { attempt.current = 0; connect(record); } }); },
  }), [state, store, connect]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useLink(): LinkContext {
  const value = useContext(Context);
  if (!value) throw new Error('useLink outside ConnectionProvider');
  return value;
}
