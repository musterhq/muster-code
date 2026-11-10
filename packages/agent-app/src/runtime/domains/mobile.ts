/**
 * `mobile.*` (#326): phones paired with this computer (docs/mobile/DESIGN.md).
 *
 * - This computer's Noise static key and its relay route secret live in the secret store (OS-encrypted). Pairing is refused
 *   without secure storage.
 * - Pairing makes a one-time 32-byte code (5 minutes, one phone, dead after 5 wrong tries) shown as a muster://pair QR link.
 *   The phone runs Noise IKpsk1 with it; a valid first message adds the phone to the registry as read-only.
 * - Later sessions are Noise IK; only a phone whose static key is in the registry gets in. Revoke closes its sessions at once.
 * - The relay link is open while a relay address is set and this computer has its key (made by the first pairing).
 * - Requests go through bridge.ts (allowlist, access checks, slim wire types). Chat changes reach open sessions as events.
 *
 * Non-secret state is in dataDir/mobile/{config,devices}.json.
 */
import {randomUUID} from 'node:crypto';
import {chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {hostname} from 'node:os';
import {join} from 'node:path';
import type {AgentEvent, Snapshot} from '../../shared/protocol.ts';
import type {MobileDeviceView, MobileStatus} from '../../shared/domains/mobile-protocol.ts';
import {equalBytes, fromBase64, fromUtf8, toBase64, utf8} from '../../shared/mobile/bytes.ts';
import {prologue, SecureChannel, MODE_BYTE, type ChannelMode} from '../../shared/mobile/channel.ts';
import {Handshake, type KeyPair} from '../../shared/mobile/noise.ts';
import {CLOSE, formatPairingLink, MOBILE_ACCESS, MOBILE_PROTOCOL_VERSION, MobileError, type MobileAccess, type MobileEvent, type MobileFrame, type PairRequest, type Welcome} from '../../shared/mobile/protocol.ts';
import {device} from '../../shared/device-noun.ts';
import {activeSecretStore, openSecretStores, type SecretStore} from '../secret-store.ts';
import {handle, mobileChats, mobileItem, needsList} from '../mobile/bridge.ts';
import {nodeNoiseCrypto} from '../mobile/node-crypto.ts';
import {RelayLink} from '../mobile/relay-link.ts';
import type {DomainContext, DomainModule} from './types.ts';

/** Test seams: the secret store to use and a shorter pairing lifetime. */
export const mobileSeams: {secrets?: () => SecretStore | undefined; pairingTtlMs?: number} = {};
export const PAIRING_TTL_MS = 5 * 60_000;
const MAX_PAIRING_FAILURES = 5;
const MAX_DEVICES = 20;
const KEY_SECRET = 'mobile-desktop-key', ROUTE_SECRET = 'mobile-route-secret';

interface Device { id: string; name: string; platform: string; publicKey: string; access: MobileAccess; pairedAt: string; lastSeenAt: string | null }
interface Pairing { code: Uint8Array; link: string; expiresAt: number; failures: number }
interface Session {
  conn: number; deviceId: string | null; channel: SecureChannel | null; watching: string | null;
  sentChats: string; sentNeeds: string; queue: Promise<void>;
}

function readJson<T>(path: string, fallback: T): T { try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return fallback; } }
function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), {recursive: true, mode: 0o700});
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), {mode: 0o600});
  renameSync(temp, path);
  try { chmodSync(path, 0o600); } catch { /* filesystems without modes */ }
}
const cleanName = (value: unknown, fallback: string) => typeof value === 'string' && value.trim() ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 80) : fallback;
export const desktopName = (): string => cleanName(hostname().replace(/\.local$/i, ''), device().title);
const RELAY_URL = /^wss?:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/;

export function createMobileDomain(context: DomainContext): DomainModule {
  const crypto = nodeNoiseCrypto();
  const dir = join(context.dataDir, 'mobile');
  const configPath = join(dir, 'config.json'), devicesPath = join(dir, 'devices.json');
  let config = readJson<{relayUrl: string | null}>(configPath, {relayUrl: null});
  let devices = readJson<{devices: Device[]}>(devicesPath, {devices: []}).devices.filter(entry => entry && typeof entry.id === 'string' && typeof entry.publicKey === 'string');
  let pairing: Pairing | null = null;
  let link: RelayLink | null = null;
  let disposed = false;
  const sessions = new Map<number, Session>();
  const name = desktopName();

  const secrets = (): SecretStore | undefined => mobileSeams.secrets ? mobileSeams.secrets() : openSecretStores().findLast(store => store.secureStorage()) ?? activeSecretStore();
  const secure = () => Boolean(secrets()?.secureStorage());
  const changed = () => { if (!disposed) context.emit({type: 'mobileChanged'}); };
  const saveDevices = () => writeJson(devicesPath, {version: 1, devices});

  /** This computer's static key and route secret; made on first pairing. Throws without secure storage. */
  function identity(create: boolean): {keys: KeyPair; routeSecret: string} | null {
    const store = secrets();
    if (!store?.secureStorage()) {
      if (!create) return null;
      throw new Error(`Secure storage is unavailable on ${device().the}, so a phone can't be paired: Muster keeps the key phones trust in ${device().secretStore}. On Linux, install and unlock a keyring, then try again.`);
    }
    const stored = store.get(KEY_SECRET), route = store.get(ROUTE_SECRET);
    if (stored && route) {
      const [publicKey, privateKey] = stored.split('.');
      if (publicKey && privateKey) return {keys: {publicKey: fromBase64(publicKey), privateKey: fromBase64(privateKey)}, routeSecret: route};
    }
    if (!create) return null;
    const keys = crypto.generateKeyPair(), routeSecret = toBase64(crypto.randomBytes(32), true);
    store.set(KEY_SECRET, `${toBase64(keys.publicKey, true)}.${toBase64(keys.privateKey, true)}`);
    store.set(ROUTE_SECRET, routeSecret);
    return {keys, routeSecret};
  }
  /** Must match the relay's routeFor: hex of the first 16 bytes of sha256(secret). */
  const routeOf = (secret: string) => Array.from(crypto.sha256(utf8(secret)).subarray(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');

  const pairingOpen = () => { if (pairing && pairing.expiresAt <= Date.now()) pairing = null; return pairing; };
  function status(): MobileStatus {
    const open = pairingOpen();
    const connected = new Set([...sessions.values()].filter(s => s.channel && s.deviceId).map(s => s.deviceId!));
    const views: MobileDeviceView[] = devices.map(d => ({id: d.id, name: d.name, platform: d.platform, access: d.access, pairedAt: d.pairedAt, lastSeenAt: d.lastSeenAt, connected: connected.has(d.id)}));
    return {relayUrl: config.relayUrl, relay: link ? link.state : 'off', relayError: link?.error ?? null, secureStorage: secure(), desktopName: name,
      pairing: open ? {link: open.link, expiresAt: new Date(open.expiresAt).toISOString()} : null, devices: views};
  }

  /** Opens or closes the relay link to match what there is to serve. */
  function syncLink(): RelayLink | null {
    // On while a relay is set and this computer has a key: a revoked phone that comes back is told so, not "offline".
    const want = Boolean(config.relayUrl) && !disposed;
    const id = want ? identity(false) : null;
    if (!want || !id) { stopLink(); return null; }
    if (link) return link;
    link = new RelayLink(config.relayUrl!, id.routeSecret, {
      open: conn => sessions.set(conn, {conn, deviceId: null, channel: null, watching: null, sentChats: '', sentNeeds: '', queue: Promise.resolve()}),
      data: (conn, data) => { const session = sessions.get(conn); if (session) session.queue = session.queue.then(() => receive(session, data)).catch(() => drop(session, CLOSE.badFrame, 'error')); },
      closed: conn => { if (sessions.delete(conn)) changed(); },
      state: () => changed(),
    });
    return link;
  }
  function stopLink() {
    const current = link; link = null;
    sessions.clear();
    current?.stop();
  }
  function drop(session: Session, code: number, reason: string) {
    if (!sessions.delete(session.conn)) return;
    link?.closePhone(session.conn, code, reason);
    if (session.deviceId) changed();
  }
  function send(session: Session, frame: MobileFrame) {
    if (!session.channel || !link || sessions.get(session.conn) !== session) return;
    for (const message of session.channel.seal(frame)) link.send(session.conn, message);
  }
  const sendEvent = (session: Session, event: MobileEvent) => send(session, {t: 'evt', e: event});

  async function receive(session: Session, data: string): Promise<void> {
    if (session.channel) {
      let frame: MobileFrame | null;
      try { frame = session.channel.open(data); } catch { drop(session, CLOSE.badFrame, 'bad frame'); return; }
      if (!frame) return;
      if (frame.t !== 'req' || typeof frame.id !== 'number') return;
      const request = frame;
      // Requests run concurrently (a send must not wait behind a slow read); replies carry their id.
      void (async () => {
        try {
          const result = await handle(bridgeFor(session), request.m, request.p);
          send(session, {t: 'res', id: request.id, ok: true, r: result});
        } catch (error) {
          const e = error instanceof MobileError ? error : new MobileError('failed', 'That did not work.');
          send(session, {t: 'res', id: request.id, ok: false, e: {code: e.code, message: e.message}});
        }
      })();
      return;
    }
    // Handshake: [mode byte] + Noise message 1.
    const id = identity(false);
    let bytes: Uint8Array;
    try { bytes = fromBase64(data); } catch { drop(session, CLOSE.badFrame, 'bad frame'); return; }
    const mode: ChannelMode | null = bytes[0] === MODE_BYTE.pair ? 'pair' : bytes[0] === MODE_BYTE.session ? 'session' : null;
    if (!id || !mode) { drop(session, CLOSE.badFrame, 'bad frame'); return; }
    const open = mode === 'pair' ? pairingOpen() : null;
    if (mode === 'pair' && !open) { drop(session, CLOSE.pairingFailed, 'pairing-failed'); return; }
    const noise = new Handshake(crypto, {pattern: mode === 'pair' ? 'IKpsk1' : 'IK', initiator: false, s: id.keys, ...(open ? {psk: open.code} : {}), prologue: prologue(mode)});
    let payload: Uint8Array;
    try { payload = noise.readMessage(bytes.subarray(1)); } catch {
      if (open) { open.failures++; if (open.failures >= MAX_PAIRING_FAILURES) { pairing = null; changed(); } }
      drop(session, mode === 'pair' ? CLOSE.pairingFailed : CLOSE.revoked, mode === 'pair' ? 'pairing-failed' : 'revoked');
      return;
    }
    const phoneKey = noise.remoteStatic!;
    let entry: Device | undefined;
    if (mode === 'pair') {
      let request: Partial<PairRequest> = {};
      try { request = JSON.parse(fromUtf8(payload)) as PairRequest; } catch { /* a nameless phone still pairs */ }
      if (devices.length >= MAX_DEVICES) { drop(session, CLOSE.pairingFailed, 'pairing-failed'); return; }
      const publicKey = toBase64(phoneKey, true);
      devices = devices.filter(d => d.publicKey !== publicKey);
      entry = {id: randomUUID(), name: cleanName(request.name, 'Phone'), platform: cleanName(request.platform, 'unknown').slice(0, 20), publicKey, access: 'read-only', pairedAt: new Date().toISOString(), lastSeenAt: null};
      devices.push(entry);
      pairing = null;
    } else {
      entry = devices.find(d => equalBytes(fromBase64(d.publicKey), phoneKey));
      if (!entry) { drop(session, CLOSE.revoked, 'revoked'); return; }
    }
    entry.lastSeenAt = new Date().toISOString();
    saveDevices();
    const welcome: Welcome = {v: MOBILE_PROTOCOL_VERSION, desktopName: name, deviceId: entry.id, access: entry.access};
    link?.send(session.conn, toBase64(noise.writeMessage(utf8(JSON.stringify(welcome)))));
    const {send: out, receive: incoming} = noise.split();
    session.channel = new SecureChannel(out, incoming);
    session.deviceId = entry.id;
    changed();
  }

  function bridgeFor(session: Session) {
    return {
      invoke: context.invoke,
      snapshot: () => context.invoke('app.snapshot', undefined),
      access: (): MobileAccess => devices.find(d => d.id === session.deviceId)?.access ?? 'read-only',
      desktopName: name, deviceId: session.deviceId ?? '',
      watch: (chatId: string | null) => { session.watching = chatId; },
    };
  }

  // Chat changes → open sessions.
  let lastAttention = '';
  function fanOut(event: AgentEvent) {
    if (disposed) return;
    const live = [...sessions.values()].filter(s => s.channel);
    if (!live.length) return;
    if (event.type === 'snapshot') {
      const chats = mobileChats(event.snapshot), json = JSON.stringify(chats);
      for (const session of live) if (session.sentChats !== json) { session.sentChats = json; sendEvent(session, {type: 'chats', chats}); }
      const attention = JSON.stringify(event.snapshot.attention ?? null);
      if (attention !== lastAttention) { lastAttention = attention; scheduleNeeds(event.snapshot); }
    } else if (event.type === 'timelinePatch' || event.type === 'timeline') {
      const items = event.type === 'timeline' ? event.items : event.patch.items;
      const revision = event.type === 'timelinePatch' ? event.patch.revision : 0;
      const mapped = items.slice(-200).map(mobileItem);
      for (const session of live) if (session.watching === event.chatId) sendEvent(session, {type: 'items', chatId: event.chatId, items: mapped, revision});
    }
  }
  /** Every attention change is sent, in order (they are rare: a request appears or is answered), so the phone's feed never
   *  skips a state. */
  let needsQueue: Promise<void> = Promise.resolve();
  function scheduleNeeds(snapshot: Snapshot) {
    needsQueue = needsQueue.then(async () => {
      if (disposed) return;
      const needs = await needsList(context.invoke, snapshot);
      const json = JSON.stringify(needs);
      for (const session of sessions.values()) if (session.channel && session.sentNeeds !== json) { session.sentNeeds = json; sendEvent(session, {type: 'needs', needs}); }
    }).catch(() => undefined);
  }
  const offEvents = context.hooks.onAgentEvent?.(fanOut);

  // A computer with paired phones reconnects to the relay on start.
  try { syncLink(); } catch { /* reported by mobile.status */ }

  const byId = (value: unknown): Device => {
    const found = devices.find(d => d.id === value);
    if (!found) throw new Error('That phone is not paired with this computer.');
    return found;
  };
  return {
    handlers: {
      'mobile.status': () => status(),
      'mobile.relay.set': input => {
        const url = input.url === null || input.url === '' ? null : String(input.url ?? '').trim();
        if (url !== null && !RELAY_URL.test(url)) throw new Error('Enter the relay address as ws:// or wss:// followed by its host.');
        config = {relayUrl: url ? url.replace(/\/+$/, '') : null};
        writeJson(configPath, {version: 1, ...config});
        stopLink(); syncLink();
        changed();
        return status();
      },
      'mobile.pair.start': async () => {
        if (!config.relayUrl) throw new Error('Set the relay address first.');
        const id = identity(true)!;
        const code = crypto.randomBytes(32);
        const expiresAt = Date.now() + (mobileSeams.pairingTtlMs ?? PAIRING_TTL_MS);
        const text = formatPairingLink({relayUrl: config.relayUrl, route: routeOf(id.routeSecret), desktopKey: toBase64(id.keys.publicKey, true), code: toBase64(code, true), desktopName: name});
        pairing = {code, link: text, expiresAt, failures: 0};
        const current = syncLink();
        changed();
        try { await current?.ready(); } catch (error) { throw new Error(`Can’t reach the relay at ${config.relayUrl}: ${(error as Error).message}`); }
        return {link: text, expiresAt: new Date(expiresAt).toISOString()};
      },
      'mobile.pair.cancel': () => { pairing = null; syncLink(); changed(); return status(); },
      'mobile.devices.revoke': input => {
        const target = byId(input.id);
        devices = devices.filter(d => d.id !== target.id);
        saveDevices();
        for (const session of [...sessions.values()]) if (session.deviceId === target.id) drop(session, CLOSE.revoked, 'revoked');
        syncLink();
        changed();
        return status();
      },
      'mobile.devices.setAccess': input => {
        const target = byId(input.id);
        if (!(MOBILE_ACCESS as readonly unknown[]).includes(input.access)) throw new Error('Access must be read-only or act.');
        target.access = input.access as MobileAccess;
        saveDevices();
        for (const session of sessions.values()) if (session.deviceId === target.id && session.channel) sendEvent(session, {type: 'access', access: target.access});
        changed();
        return status();
      },
    },
    dispose() {
      disposed = true;
      offEvents?.();
      for (const session of [...sessions.values()]) drop(session, CLOSE.gone, 'closed');
      stopLink();
    },
  };
}
