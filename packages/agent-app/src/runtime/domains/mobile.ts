/**
 * `mobile.*` (#326): phones paired with this computer (docs/mobile/DESIGN.md).
 *
 * - Keys, all in the OS-encrypted secret store: this computer's Noise static key (phones trust it) and its Ed25519 route key
 *   (the relay registers the route only for a signature over its own one-time challenge). Pairing is refused without secure
 *   storage, and a key that exists but can't be decrypted is refused, never silently replaced: `mobile.reset` rotates it.
 * - Pairing makes a one-time 32-byte code (5 minutes, one phone) shown as a muster://pair QR link. The phone runs Noise
 *   IKpsk1 with it; a valid first message makes the phone *pending*: both ends show the same 6-digit check code (from the
 *   handshake hash) and the owner adds the phone on the desktop (`mobile.pair.confirm`) or rejects it. Only then is it in the
 *   registry (read-only). A second phone using a taken code is told so. Wrong codes close their own connection only.
 * - Later sessions are Noise IK. A first message that does not decrypt closes with 4400; one from a key that is not paired
 *   closes with 4403 (revoked). A session counts as connected only after its first valid encrypted message.
 * - Handshakes time out after 10 s, and unauthenticated connections are capped.
 * - Requests go through bridge.ts (allowlist, access checked again right before each runtime command, slim wire types).
 *
 * Non-secret state is in dataDir/mobile/{config,devices}.json.
 */
import {randomUUID} from 'node:crypto';
import {chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {hostname, networkInterfaces} from 'node:os';
import {join} from 'node:path';
import type {AgentEvent, Snapshot} from '../../shared/protocol.ts';
import type {MobileDeviceView, MobileStatus} from '../../shared/domains/mobile-protocol.ts';
import {equalBytes, fromBase64, fromUtf8, toBase64, utf8} from '../../shared/mobile/bytes.ts';
import {checkCodeOf, keyFingerprint, prologue, SecureChannel, MODE_BYTE, type ChannelMode} from '../../shared/mobile/channel.ts';
import {Handshake, type KeyPair} from '../../shared/mobile/noise.ts';
import {CLOSE, formatPairingLink, parsePairingLink, MOBILE_ACCESS, MOBILE_PROTOCOL_VERSION, MobileError, RELAY_NEEDS_TLS, relayUrlAllowed, type MobileAccess, type MobileEvent, type MobileFrame, type PairRequest, type Welcome} from '../../shared/mobile/protocol.ts';
import {device} from '../../shared/device-noun.ts';
import {activeSecretStore, openSecretStores, type SecretStore} from '../secret-store.ts';
import {handle, mobileChats, mobileItem, needsList} from '../mobile/bridge.ts';
import {generateRouteKey, nodeNoiseCrypto, signWithRouteKey, type RouteKey} from '../mobile/node-crypto.ts';
import {RelayLink} from '../mobile/relay-link.ts';
import {LanListener, lanHosts} from '../mobile/lan-listener.ts';
import {PhoneUploads} from '../mobile/uploads.ts';
import type {DomainContext, DomainModule} from './types.ts';

/** Test seams: the secret store, and shorter or smaller limits. */
export const mobileSeams: {secrets?: () => SecretStore | undefined; pairingTtlMs?: number; handshakeTimeoutMs?: number; maxPendingSessions?: number;
  /** The hosts the LAN listener binds instead of this computer's private-network addresses ([] for none). */
  lanHosts?: string[]} = {};
/** How often the LAN listener follows the computer's addresses (a laptop changes networks). */
export const LAN_REFRESH_MS = 30_000;
export const PAIRING_TTL_MS = 5 * 60_000;
export const HANDSHAKE_TIMEOUT_MS = 10_000;
export const MAX_PENDING_SESSIONS = 32;
/** Failed pairing attempts allowed per minute; past it, attempts are refused until the minute passes (the pairing stays). */
export const PAIRING_ATTEMPTS_PER_MINUTE = 20;
const MAX_DEVICES = 20;
const KEY_SECRET = 'mobile-desktop-key', ROUTE_SECRET = 'mobile-route-key';
/** The route secret of the first build of #326; removed by reset. */
const LEGACY_ROUTE_SECRET = 'mobile-route-secret';

interface Device { id: string; name: string; platform: string; publicKey: string; access: MobileAccess; pairedAt: string; lastSeenAt: string | null }
interface Pending { session: Session; device: Device; checkCode: string; fingerprint: string }
interface Pairing { code: Uint8Array; link: string; expiresAt: number; pending: Pending | null; timer: ReturnType<typeof setTimeout> }
/** Where a phone's connection came in: the relay link or the LAN listener. Both carry the same base64 Noise messages. */
interface Transport { send(conn: number, data: string): void; closePhone(conn: number, code: number, reason: string): void }
interface Session {
  conn: number; via: Transport; deviceId: string | null; channel: SecureChannel | null; watching: string | null;
  /** A valid encrypted message arrived: only then is the phone shown as connected. */
  verified: boolean;
  /** Pairing: waits for the owner's confirmation; every request is refused meanwhile. */
  pending: boolean;
  sentChats: string; sentNeeds: string; queue: Promise<void>;
  timer: ReturnType<typeof setTimeout> | undefined;
}
interface Identity { keys: KeyPair; route: RouteKey }

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
const pair64 = (a: Uint8Array, b: Uint8Array) => `${toBase64(a, true)}.${toBase64(b, true)}`;
const unpair64 = (text: string | undefined) => { const [a, b] = (text ?? '').split('.'); return a && b ? [fromBase64(a), fromBase64(b)] as const : null; };

export function createMobileDomain(context: DomainContext): DomainModule {
  const crypto = nodeNoiseCrypto();
  const dir = join(context.dataDir, 'mobile');
  const configPath = join(dir, 'config.json'), devicesPath = join(dir, 'devices.json');
  /** `lan`: direct connections on the same network (on unless turned off); `lanPort`: kept so phones' saved addresses work after a restart. */
  let config = readJson<{relayUrl: string | null; lan?: boolean; lanPort?: number}>(configPath, {relayUrl: null});
  const saveConfig = () => writeJson(configPath, {version: 1, relayUrl: config.relayUrl, ...(config.lan === false ? {lan: false} : {}), ...(config.lanPort ? {lanPort: config.lanPort} : {})});
  let devices = readJson<{devices: Device[]}>(devicesPath, {devices: []}).devices.filter(entry => entry && typeof entry.id === 'string' && typeof entry.publicKey === 'string');
  let pairing: Pairing | null = null;
  /** The last code a phone took, so a second phone using it is told "already used" instead of "wrong code". */
  let usedCode: {code: Uint8Array; until: number} | null = null;
  let failures: number[] = [];
  let link: RelayLink | null = null;
  let lan: LanListener | null = null;
  /** Settles once the LAN listener is bound (pairing waits for it, so the link carries its addresses). */
  let lanReady: Promise<void> = Promise.resolve();
  let lanRefresh: ReturnType<typeof setInterval> | undefined;
  let identityError: string | null = null;
  let disposed = false;
  const sessions = new Map<number, Session>();
  /** Each paired phone's uploads and unsent files, kept across its sessions (a phone reconnects while composing). */
  const uploads = new Map<string, PhoneUploads>();
  const uploadsFor = (deviceId: string) => { let entry = uploads.get(deviceId); if (!entry) { entry = new PhoneUploads(); uploads.set(deviceId, entry); } return entry; };
  /** A revoked or reset phone's open uploads go, and the files it staged but never sent are discarded. */
  const dropUploads = (deviceId: string) => {
    const entry = uploads.get(deviceId);
    if (!entry) return;
    uploads.delete(deviceId);
    for (const file of entry.unsent()) void context.invoke('attachments.discard', {chatId: file.chatId, id: file.id}).catch(() => undefined);
    entry.dispose();
  };
  const name = desktopName();

  const secrets = (): SecretStore | undefined => mobileSeams.secrets ? mobileSeams.secrets() : openSecretStores().findLast(store => store.secureStorage()) ?? activeSecretStore();
  const secure = () => Boolean(secrets()?.secureStorage());
  const changed = () => { if (!disposed) context.emit({type: 'mobileChanged'}); };
  const saveDevices = () => writeJson(devicesPath, {version: 1, devices});
  const unreadable = () => `Muster can’t read the key phones trust from ${device().secretStore}, so it won’t make a new one over it (that would unpair every phone without telling you). If ${device().secretStoreShort} was reset or moved, use Reset phone access in Settings › Integrations › Phone to start over.`;

  /** This computer's keys. `create` makes them when there are none; an entry that exists but can't be read always throws. */
  function identity(create: boolean): Identity | null {
    const store = secrets();
    if (!store?.secureStorage()) {
      if (!create) return null;
      throw new Error(`Secure storage is unavailable on ${device().the}, so a phone can't be paired: Muster keeps the key phones trust in ${device().secretStore}. On Linux, install and unlock a keyring, then try again.`);
    }
    const hasKey = store.status(KEY_SECRET).stored, hasRoute = store.status(ROUTE_SECRET).stored;
    if (hasKey || hasRoute) {
      const keys = unpair64(store.get(KEY_SECRET)), route = unpair64(store.get(ROUTE_SECRET));
      if (!keys || !route) throw new Error(unreadable());
      return {keys: {publicKey: keys[0], privateKey: keys[1]}, route: {publicKey: route[0], privateKey: route[1]}};
    }
    if (!create) return null;
    const keys = crypto.generateKeyPair(), route = generateRouteKey();
    store.set(KEY_SECRET, pair64(keys.publicKey, keys.privateKey));
    store.set(ROUTE_SECRET, pair64(route.publicKey, route.privateKey));
    return {keys, route};
  }
  /** Must match the relay's routeFor: hex of the first 16 bytes of sha256(route public key). */
  const routeOf = (publicKey: Uint8Array) => Array.from(crypto.sha256(publicKey).subarray(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');

  function endPairing(reason: 'expired' | 'rejected' | 'cancelled' | 'used') {
    const current = pairing;
    if (!current) return;
    pairing = null;
    clearTimeout(current.timer);
    if (current.pending && reason !== 'used') drop(current.pending.session, CLOSE.pairingFailed, reason === 'rejected' ? 'rejected' : 'expired');
    changed();
  }
  const pairingOpen = () => { if (pairing && pairing.expiresAt <= Date.now()) endPairing('expired'); return pairing; };

  function status(): MobileStatus {
    const open = pairingOpen();
    const connected = new Set([...sessions.values()].filter(s => s.verified && s.deviceId && !s.pending).map(s => s.deviceId!));
    const views: MobileDeviceView[] = devices.map(d => ({id: d.id, name: d.name, platform: d.platform, fingerprint: keyFingerprint(crypto, fromBase64(d.publicKey)), access: d.access, pairedAt: d.pairedAt, lastSeenAt: d.lastSeenAt, connected: connected.has(d.id)}));
    const pending = open?.pending ? {name: open.pending.device.name, platform: open.pending.device.platform, checkCode: open.pending.checkCode, fingerprint: open.pending.fingerprint} : null;
    return {relayUrl: config.relayUrl, relay: link ? link.state : 'off', lan: {enabled: config.lan !== false, addresses: lan?.addresses ?? []}, relayError: identityError ?? link?.error ?? null, secureStorage: secure(), desktopName: name,
      pairing: open ? {expiresAt: new Date(open.expiresAt).toISOString(), pending} : null, devices: views};
  }

  /** Opens or closes the relay link: on while a relay is set and this computer has its keys. */
  function syncLink(): RelayLink | null {
    const want = Boolean(config.relayUrl) && !disposed;
    let id: Identity | null = null;
    identityError = null;
    if (want) { try { id = identity(false); } catch (error) { identityError = (error as Error).message; } }
    if (!want || !id) { stopLink(); return null; }
    if (link) return link;
    const route = id.route;
    const relay: RelayLink = new RelayLink(config.relayUrl!, nonce => ({key: toBase64(route.publicKey), sig: toBase64(signWithRouteKey(route, utf8(`muster-relay/1 register ${nonce}`)))}), {
      ...phones(() => relay),
      state: () => changed(),
    });
    link = relay;
    startLan(id);
    return link;
  }
  /** One phone connection's life, whichever way it came in: the same caps, timeout and session code for both. */
  function phones(via: () => Transport) {
    return {
      open: (conn: number) => {
        const limit = mobileSeams.maxPendingSessions ?? MAX_PENDING_SESSIONS;
        // Unauthenticated: no valid encrypted message yet. A replayed first message gets a handshake answer but never a
        // valid frame, so it counts here and times out like a stalled handshake (MUS-SPEC-23-10H).
        if ([...sessions.values()].filter(s => !s.verified).length >= limit) { via().closePhone(conn, CLOSE.busy, 'busy'); return; }
        const session: Session = {conn, via: via(), deviceId: null, channel: null, watching: null, verified: false, pending: false, sentChats: '', sentNeeds: '', queue: Promise.resolve(), timer: undefined};
        session.timer = setTimeout(() => { if (!session.verified && !session.pending) drop(session, CLOSE.timeout, 'timeout'); }, mobileSeams.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
        session.timer.unref?.();
        sessions.set(conn, session);
      },
      data: (conn: number, data: string) => { const session = sessions.get(conn); if (session) session.queue = session.queue.then(() => receive(session, data)).catch(() => drop(session, CLOSE.badFrame, 'error')); },
      closed: (conn: number) => { const session = sessions.get(conn); if (session) forget(session); },
    };
  }
  /** Direct connections on the same network: on while phone access is on, unless turned off in Settings. */
  function startLan(id: Identity) {
    if (lan || config.lan === false || disposed) return;
    const hosts = () => mobileSeams.lanHosts ?? lanHosts(networkInterfaces());
    const listener: LanListener = new LanListener(routeOf(id.route.publicKey), phones(() => listener), {hosts: hosts(), port: config.lanPort ?? 0});
    lan = listener;
    lanReady = listener.start().then(() => {
      if (lan !== listener) return;
      if (listener.addresses.length && listener.port !== config.lanPort) { config.lanPort = listener.port; saveConfig(); }
      changed();
    }).catch(() => undefined);
    lanRefresh = setInterval(() => {
      if (lan !== listener) return;
      const before = listener.addresses.join();
      void listener.update(hosts()).then(() => { if (listener.addresses.join() !== before) changed(); }).catch(() => undefined);
    }, LAN_REFRESH_MS);
    lanRefresh.unref?.();
  }
  function stopLan() {
    const current = lan; lan = null;
    if (lanRefresh) clearInterval(lanRefresh);
    lanRefresh = undefined;
    if (!current) return;
    for (const session of [...sessions.values()]) if (session.via === current) forget(session);
    current.stop();
  }
  function stopLink() {
    const current = link; link = null;
    stopLan();
    for (const session of sessions.values()) clearTimeout(session.timer);
    sessions.clear();
    current?.stop();
  }
  /** The phone side went away: a pending pairing goes back to waiting for a phone. */
  function forget(session: Session) {
    if (!sessions.delete(session.conn)) return;
    clearTimeout(session.timer);
    if (pairing?.pending?.session === session) pairing.pending = null;
    if (session.deviceId) changed();
  }
  function drop(session: Session, code: number, reason: string) {
    if (!sessions.has(session.conn)) return;
    forget(session);
    session.via.closePhone(session.conn, code, reason);
  }
  function send(session: Session, frame: MobileFrame) {
    if (!session.channel || sessions.get(session.conn) !== session) return;
    for (const message of session.channel.seal(frame)) session.via.send(session.conn, message);
  }
  const sendEvent = (session: Session, event: MobileEvent) => send(session, {t: 'evt', e: event});
  /** Rate limit on failed pairing attempts, across connections; the pairing itself is never ended by them. */
  const throttled = () => { const now = Date.now(); failures = failures.filter(at => now - at < 60_000); return failures.length >= PAIRING_ATTEMPTS_PER_MINUTE; };

  async function receive(session: Session, data: string): Promise<void> {
    if (session.channel) {
      let frame: MobileFrame | null;
      try { frame = session.channel.open(data); } catch { drop(session, CLOSE.badFrame, 'bad frame'); return; }
      if (!frame) return;
      if (!session.verified && !session.pending) {
        session.verified = true;
        clearTimeout(session.timer); session.timer = undefined;
        const entry = devices.find(d => d.id === session.deviceId);
        if (entry) { entry.lastSeenAt = new Date().toISOString(); saveDevices(); }
        changed();
      }
      if (frame.t !== 'req' || typeof frame.id !== 'number') return;
      const request = frame;
      // Requests run concurrently (a send must not wait behind a slow read); replies carry their id.
      void (async () => {
        try {
          if (session.pending) throw new MobileError('pending', `Confirm the check code on ${device().your} first.`);
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
    let id: Identity | null = null;
    try { id = identity(false); } catch { /* reported by status */ }
    let bytes: Uint8Array;
    try { bytes = fromBase64(data); } catch { drop(session, CLOSE.badFrame, 'bad frame'); return; }
    const mode: ChannelMode | null = bytes[0] === MODE_BYTE.pair ? 'pair' : bytes[0] === MODE_BYTE.session ? 'session' : null;
    if (!id || !mode) { drop(session, CLOSE.badFrame, 'bad frame'); return; }
    if (mode === 'pair') return receivePairing(session, id, bytes.subarray(1));
    const noise = new Handshake(crypto, {pattern: 'IK', initiator: false, s: id.keys, prologue: prologue('session')});
    try { noise.readMessage(bytes.subarray(1)); } catch { drop(session, CLOSE.badFrame, 'bad frame'); return; }
    const phoneKey = noise.remoteStatic!;
    const entry = devices.find(d => equalBytes(fromBase64(d.publicKey), phoneKey));
    if (!entry) { drop(session, CLOSE.revoked, 'revoked'); return; }
    openSession(session, noise, entry, false);
  }

  function receivePairing(session: Session, id: Identity, message: Uint8Array): void {
    if (throttled()) { drop(session, CLOSE.busy, 'busy'); return; }
    const attempt = (code: Uint8Array) => {
      const noise = new Handshake(crypto, {pattern: 'IKpsk1', initiator: false, s: id.keys, psk: code, prologue: prologue('pair')});
      try { return {noise, payload: noise.readMessage(message)}; } catch { return null; }
    };
    const open = pairingOpen();
    const fresh = open ? attempt(open.code) : null;
    if (!fresh || !open || open.pending) {
      // A taken code (pending or already used) decrypts but is refused; anything else failed to decrypt.
      const taken = (open?.pending && fresh) || (usedCode && usedCode.until > Date.now() && attempt(usedCode.code));
      if (!taken) failures.push(Date.now());
      drop(session, CLOSE.pairingFailed, taken ? 'code-used' : 'pairing-failed');
      return;
    }
    if (devices.length >= MAX_DEVICES) { drop(session, CLOSE.pairingFailed, 'pairing-failed'); return; }
    let request: Partial<PairRequest> = {};
    try { request = JSON.parse(fromUtf8(fresh.payload)) as PairRequest; } catch { /* a nameless phone still pairs */ }
    const phoneKey = fresh.noise.remoteStatic!;
    const entry: Device = {id: randomUUID(), name: cleanName(request.name, 'Phone'), platform: cleanName(request.platform, 'unknown').slice(0, 20), publicKey: toBase64(phoneKey, true), access: 'read-only', pairedAt: new Date().toISOString(), lastSeenAt: null};
    session.pending = true;
    openSession(session, fresh.noise, entry, true);
    open.pending = {session, device: entry, checkCode: checkCodeOf(fresh.noise.handshakeHash), fingerprint: keyFingerprint(crypto, phoneKey)};
    changed();
  }

  function openSession(session: Session, noise: Handshake, entry: Device, pending: boolean) {
    const welcome: Welcome = {v: MOBILE_PROTOCOL_VERSION, desktopName: name, deviceId: entry.id, access: entry.access, ...(pending ? {pending: true} : {})};
    session.via.send(session.conn, toBase64(noise.writeMessage(utf8(JSON.stringify(welcome)))));
    const {send: out, receive: incoming} = noise.split();
    session.channel = new SecureChannel(out, incoming);
    session.deviceId = entry.id;
    // A pairing waits for the owner; a session keeps its handshake timeout until its first valid encrypted message.
    if (pending) { clearTimeout(session.timer); session.timer = undefined; }
  }

  function bridgeFor(session: Session) {
    return {
      invoke: context.invoke,
      snapshot: () => context.invoke('app.snapshot', undefined),
      access: (): MobileAccess => devices.find(d => d.id === session.deviceId)?.access ?? 'read-only',
      alive: () => sessions.get(session.conn) === session && devices.some(d => d.id === session.deviceId),
      desktopName: name, deviceId: session.deviceId ?? '',
      lan: () => lan?.addresses ?? [],
      watch: (chatId: string | null) => { session.watching = chatId; },
      ...(session.deviceId ? {uploads: uploadsFor(session.deviceId)} : {}),
    };
  }

  // Chat changes → open sessions.
  let lastAttention = '';
  /** Sessions that proved they hold the phone's keys (a replayed first message never does). */
  const ready = () => [...sessions.values()].filter(s => s.channel && s.verified && !s.pending);
  function fanOut(event: AgentEvent) {
    if (disposed) return;
    const live = ready();
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
      for (const session of ready()) if (session.sentNeeds !== json) { session.sentNeeds = json; sendEvent(session, {type: 'needs', needs}); }
    }).catch(() => undefined);
  }
  const offEvents = context.hooks.onAgentEvent?.(fanOut);

  // A computer with paired phones reconnects to the relay on start.
  syncLink();

  const byId = (value: unknown): Device => {
    const found = devices.find(d => d.id === value);
    if (!found) throw new Error('That phone is not paired with this computer.');
    return found;
  };
  const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'});
  return {
    handlers: {
      'mobile.status': () => status(),
      'mobile.relay.set': input => {
        const url = input.url === null || input.url === '' ? null : String(input.url ?? '').trim().replace(/\/+$/, '');
        if (url !== null && !relayUrlAllowed(url)) throw new Error(/^ws:\/\//.test(url) ? RELAY_NEEDS_TLS : 'Enter the relay address as wss:// followed by its host.');
        config = {...config, relayUrl: url};
        saveConfig();
        stopLink(); syncLink();
        changed();
        return status();
      },
      'mobile.pair.start': async () => {
        if (!config.relayUrl) throw new Error('Set the relay address first.');
        const id = identity(true)!;
        endPairing('cancelled');
        const code = crypto.randomBytes(32);
        const ttl = mobileSeams.pairingTtlMs ?? PAIRING_TTL_MS, expiresAt = Date.now() + ttl;
        const text = formatPairingLink({relayUrl: config.relayUrl, route: routeOf(id.route.publicKey), desktopKey: toBase64(id.keys.publicKey, true), code: toBase64(code, true), desktopName: name});
        const timer = setTimeout(() => { if (pairing?.code === code) endPairing('expired'); }, ttl + 50);
        timer.unref?.();
        pairing = {code, link: text, expiresAt, pending: null, timer};
        const current = syncLink();
        changed();
        try { await current?.ready(); } catch (error) { throw new Error(`Can’t reach the relay at ${config.relayUrl}: ${(error as Error).message}`); }
        // The link carries the addresses a phone on the same network dials first.
        await lanReady;
        const addresses = lan?.addresses ?? [];
        if (addresses.length && pairing?.code === code) {
          pairing.link = formatPairingLink({...parsePairingLink(text), lan: addresses});
          return {link: pairing.link, expiresAt: new Date(expiresAt).toISOString()};
        }
        return {link: text, expiresAt: new Date(expiresAt).toISOString()};
      },
      /** The QR panel's own read of the link (mobile.status never carries it). */
      'mobile.pair.link': () => { const open = pairingOpen(); return open ? {link: open.link, expiresAt: new Date(open.expiresAt).toISOString()} : null; },
      'mobile.pair.confirm': input => {
        const open = pairingOpen();
        const pending = open?.pending;
        if (!open || !pending) throw new Error('No phone is waiting to be added.');
        if (input.checkCode !== pending.checkCode) throw new Error('That is not the check code this phone showed. Reject it if you are not sure.');
        if (!sessions.has(pending.session.conn)) throw new Error('The phone disconnected before it was added. Pair it again.');
        devices = [...devices.filter(d => d.publicKey !== pending.device.publicKey), pending.device];
        pending.device.lastSeenAt = new Date().toISOString();
        saveDevices();
        usedCode = {code: open.code, until: open.expiresAt};
        pending.session.pending = false;
        endPairing('used');
        sendEvent(pending.session, {type: 'paired'});
        context.emit({type: 'notice', message: `A phone named ${pending.device.name} paired at ${time(pending.device.pairedAt)}. If that wasn’t you, revoke it in Settings › Integrations › Phone.`});
        changed();
        return status();
      },
      'mobile.pair.reject': () => { if (pairing?.pending) usedCode = {code: pairing.code, until: pairing.expiresAt}; endPairing('rejected'); return status(); },
      'mobile.pair.cancel': () => { endPairing('cancelled'); return status(); },
      /** Direct connections on the same network. Off closes the listener and its sessions; phones then use the relay. */
      'mobile.lan.set': async input => {
        if (typeof input.enabled !== 'boolean') throw new Error('Choose on or off.');
        config = {...config, lan: input.enabled};
        saveConfig();
        if (!input.enabled) stopLan();
        else { let id: Identity | null = null; try { id = link ? identity(false) : null; } catch { /* reported by status */ } if (id) startLan(id); await lanReady; }
        changed();
        return status();
      },
      'mobile.devices.revoke': input => {
        const target = byId(input.id);
        devices = devices.filter(d => d.id !== target.id);
        saveDevices();
        for (const session of [...sessions.values()]) if (session.deviceId === target.id) drop(session, CLOSE.revoked, 'revoked');
        dropUploads(target.id);
        changed();
        return status();
      },
      'mobile.devices.setAccess': input => {
        const target = byId(input.id);
        if (!(MOBILE_ACCESS as readonly unknown[]).includes(input.access)) throw new Error('Access must be read-only or act.');
        target.access = input.access as MobileAccess;
        saveDevices();
        for (const session of sessions.values()) if (session.deviceId === target.id && session.channel && !session.pending) sendEvent(session, {type: 'access', access: target.access});
        changed();
        return status();
      },
      /** Deliberately new keys and route: every phone is unpaired and must pair again. */
      'mobile.reset': () => {
        endPairing('cancelled');
        for (const session of [...sessions.values()]) drop(session, CLOSE.revoked, 'revoked');
        stopLink();
        for (const deviceId of [...uploads.keys()]) dropUploads(deviceId);
        devices = []; saveDevices();
        usedCode = null; failures = [];
        const store = secrets();
        for (const entry of [KEY_SECRET, ROUTE_SECRET, LEGACY_ROUTE_SECRET]) store?.clear(entry);
        if (store?.secureStorage()) identity(true);
        syncLink();
        changed();
        return status();
      },
    },
    dispose() {
      disposed = true;
      offEvents?.();
      if (pairing) clearTimeout(pairing.timer);
      for (const session of [...sessions.values()]) drop(session, CLOSE.gone, 'closed');
      stopLink();
      for (const entry of uploads.values()) entry.dispose();
      uploads.clear();
    },
  };
}
