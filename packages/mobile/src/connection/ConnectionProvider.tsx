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
import {afterLinkClose, afterLinkFailure, backoff} from './reconnect';

export type LinkState = {phase: 'loading'} | {phase: 'unpaired'} | {phase: 'connecting'; record: PairedRecord; error?: string}
  | {phase: 'connected'; record: PairedRecord; connection: MobileConnection} | {phase: 'revoked'; record: PairedRecord};
/** A pairing in progress: show `checkCode`; `confirmed` settles once the desktop adds the phone. */
export interface PendingPairing { record: PairedRecord; checkCode: string; confirmed: Promise<void> }
interface LinkContext { state: LinkState; store: PairingStore; pair(link: PairingLink): Promise<PendingPairing>; unpair(): Promise<void>; retry(): void }
const Context = createContext<LinkContext | null>(null);

const secure: SecureStoreLike = {
  getItemAsync: key => SecureStore.getItemAsync(key, {keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY}),
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, {keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY}),
  deleteItemAsync: key => SecureStore.deleteItemAsync(key),
};
const crypto = nobleNoiseCrypto(length => getRandomBytes(length));
const socket = (url: string) => new WebSocket(url) as unknown as SocketLike;
const phoneName = () => String(Constants.deviceName ?? (Platform.OS === 'ios' ? 'iPhone' : 'Android phone')).slice(0, 80);

export function ConnectionProvider({children}: {children: ReactNode}) {
  const store = useMemo(() => createPairingStore(secure), []);
  const [state, setState] = useState<LinkState>({phase: 'loading'});
  const attempt = useRef(0), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), current = useRef<MobileConnection | null>(null);

  const generation = useRef(0);
  const connect = useCallback((record: PairedRecord) => {
    if (timer.current) clearTimeout(timer.current);
    // A newer connect (pairing again, possibly from a muster://pair link) supersedes this one: its link closes quietly.
    const mine = ++generation.current;
    const stale = () => generation.current !== mine;
    current.current?.close(); current.current = null;
    setState({phase: 'connecting', record});
    connectPhone({record, crypto, socket}).then(connection => {
      if (stale()) { connection.close(); return; }
      attempt.current = 0; current.current = connection;
      setState({phase: 'connected', record, connection});
      connection.onClose(reason => {
        if (stale()) return;
        current.current = null;
        // Only the desktop's revoked close shows revoked; a network error or bad frame reconnects. The record is kept.
        if (afterLinkClose(reason) === 'revoked') { setState({phase: 'revoked', record}); return; }
        setState({phase: 'connecting', record});
        timer.current = setTimeout(() => connect(record), backoff(attempt.current++));
      });
    }, (error: unknown) => {
      if (stale()) return;
      if (afterLinkFailure(error) === 'revoked') { setState({phase: 'revoked', record}); return; }
      setState({phase: 'connecting', record, error: error instanceof MobileError || error instanceof Error ? error.message : String(error)});
      timer.current = setTimeout(() => connect(record), backoff(attempt.current++));
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
      const {client, record, checkCode, confirmed} = await pairPhone({link, crypto, socket, name: phoneName(), platform: Platform.OS});
      // The pairing connection stays open until the desktop adds (or rejects) the phone; sessions then use the record.
      const done = confirmed.finally(() => client.close());
      done.catch(() => undefined);
      return {record, checkCode, confirmed: done};
    },
    async unpair() { generation.current++; current.current?.close(); current.current = null; if (timer.current) clearTimeout(timer.current); await store.clear(); setState({phase: 'unpaired'}); },
    retry() { void store.load().then(record => { if (record) { attempt.current = 0; connect(record); } }); },
  }), [state, store, connect]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useLink(): LinkContext {
  const value = useContext(Context);
  if (!value) throw new Error('useLink outside ConnectionProvider');
  return value;
}
