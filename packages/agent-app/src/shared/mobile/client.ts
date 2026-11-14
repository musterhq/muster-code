/**
 * The phone side of the link (#326): pair with a desktop from its QR link, reconnect later with the saved record, call
 * methods and receive events over the Noise channel. Used by the app (noble crypto, React Native's WebSocket) and by the
 * desktop's workflow tests (Node crypto, Node's WebSocket), so both exercise the same code.
 */
import {concat, fromBase64, fromUtf8, toBase64, utf8} from './bytes.ts';
import {Handshake, type NoiseCrypto} from './noise.ts';
import {checkCodeOf, MODE_BYTE, prologue, SecureChannel, type ChannelMode} from './channel.ts';
import {CLOSE_REASON, cleanLanAddresses, lanUrl, MOBILE_PROTOCOL_VERSION, MobileError, parsePairingLink, UPLOAD_CHUNK_BYTES, UPLOAD_MAX_BYTES, type MobileAttachment, type MobileAccess, type MobileEvent, type MobileFrame, type MobileMethod, type MobileMethods, type PairingLink, type PairRequest, type Welcome} from './protocol.ts';

export {MobileError} from './protocol.ts';

/** The subset of the WebSocket API both Node and React Native provide. Handler events are `any` so the platform's own
 *  WebSocket (whose handlers take Event / MessageEvent / CloseEvent) is assignable; the client reads only `data`, `code`
 *  and `reason`. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: any) => void) | null;
  onmessage: ((event: any) => void) | null;
  onclose: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
}
export type SocketFactory = (url: string) => SocketLike;

/** What the phone keeps (in Keychain / Keystore) to reconnect. Keys are base64url. `lan`: the desktop's direct addresses on
 *  its network, tried before the relay. */
export interface PairedRecord {
  relayUrl: string; route: string; desktopKey: string; desktopName: string; deviceId: string;
  publicKey: string; privateKey: string;
  lan?: string[];
}

export interface MobileConnection {
  readonly desktopName: string;
  readonly deviceId: string;
  readonly access: MobileAccess;
  readonly closed: boolean;
  /** How this session reached the desktop: directly on the same network, or through the relay. */
  readonly via: 'lan' | 'relay';
  /** The desktop's direct addresses as its hello reported them (empty when it has none or has them off). */
  readonly lan: string[];
  call<M extends MobileMethod>(method: M, params: MobileMethods[M]['params']): Promise<MobileMethods[M]['result']>;
  on(listener: (event: MobileEvent) => void): () => void;
  /** `reason` is the close reason ('revoked' only when the desktop no longer knows this phone); `code` the close code. */
  onClose(listener: (reason: string, code: number) => void): () => void;
  close(): void;
}

const HANDSHAKE_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;
/** How long the LAN gets before the relay is used: a socket to open (pairing), or a whole session with hello (reconnect). */
export const LAN_OPEN_MS = 1500;
export const LAN_SESSION_MS = 3000;
export const phoneUrl = (relayUrl: string, route: string): string => `${relayUrl.replace(/\/+$/, '')}/v1/phone/${route}`;

export const CODE_ALREADY_USED = 'This pairing code was already used by another phone. On your computer, check Settings › Integrations › Phone: if a phone you don’t recognise is waiting or listed, reject or revoke it, then start pairing again.';
export const closeError = (code: number, reason: string, mode: ChannelMode): MobileError => {
  const kind = CLOSE_REASON[code];
  if (kind === 'pairing-failed' && reason === 'code-used') return new MobileError('pairing-failed', CODE_ALREADY_USED);
  if (kind === 'pairing-failed' && reason === 'rejected') return new MobileError('pairing-failed', 'Pairing was rejected on your computer.');
  if (kind === 'pairing-failed' || (mode === 'pair' && kind !== 'offline' && kind !== undefined)) return new MobileError('pairing-failed', 'Pairing failed: the code has expired or does not match. Start pairing again on your computer.');
  if (kind === 'revoked') return new MobileError('revoked', 'This phone is no longer paired with that computer. Pair it again from Settings › Integrations › Phone.');
  if (kind === 'offline') return new MobileError('offline', 'Your computer is not connected right now. Make sure Muster is open on it.');
  return new MobileError('closed', reason || 'The connection closed.');
};

class Connection implements MobileConnection {
  desktopName: string; deviceId: string; access: MobileAccess; closed = false; lan: string[] = [];
  private nextId = 1;
  private readonly calls = new Map<number, {resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>}>();
  private readonly listeners = new Set<(event: MobileEvent) => void>();
  private readonly closers = new Set<(reason: string, code: number) => void>();
  pending: boolean;
  constructor(private readonly socket: SocketLike, private readonly channel: SecureChannel, welcome: Welcome, readonly via: 'lan' | 'relay') {
    this.desktopName = welcome.desktopName; this.deviceId = welcome.deviceId; this.access = welcome.access; this.pending = welcome.pending === true;
    socket.onmessage = (event: {data: unknown}) => this.receive(event.data);
    socket.onclose = (event: {code: number; reason: string}) => this.finish(event.reason || CLOSE_REASON[event.code] || 'closed', event.code);
    socket.onerror = () => undefined;
  }
  private receive(data: unknown): void {
    if (this.closed || typeof data !== 'string') return;
    let frame: MobileFrame | null;
    try { frame = this.channel.open(data); } catch { this.socket.close(1000, 'bad frame'); this.finish('bad frame', 4400); return; }
    if (!frame) return;
    if (frame.t === 'res') {
      const call = this.calls.get(frame.id);
      if (!call) return;
      this.calls.delete(frame.id); clearTimeout(call.timer);
      if (frame.ok) call.resolve(frame.r); else call.reject(new MobileError(frame.e.code, frame.e.message));
    } else if (frame.t === 'evt') {
      if (frame.e.type === 'access') this.access = frame.e.access;
      if (frame.e.type === 'paired') this.pending = false;
      for (const listener of [...this.listeners]) { try { listener(frame.e); } catch { /* a listener never breaks the link */ } }
    }
  }
  private finish(reason: string, code = 1000): void {
    if (this.closed) return;
    this.closed = true;
    for (const call of this.calls.values()) { clearTimeout(call.timer); call.reject(new MobileError('closed', 'The connection closed.')); }
    this.calls.clear();
    for (const closer of [...this.closers]) { try { closer(reason, code); } catch { /* ignore */ } }
  }
  call<M extends MobileMethod>(method: M, params: MobileMethods[M]['params']): Promise<MobileMethods[M]['result']> {
    if (this.closed) return Promise.reject(new MobileError('closed', 'The connection closed.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.calls.delete(id); reject(new MobileError('timeout', 'Your computer did not answer in time.')); }, CALL_TIMEOUT_MS);
      this.calls.set(id, {resolve: resolve as (value: unknown) => void, reject, timer});
      try { for (const message of this.channel.seal({t: 'req', id, m: method, p: params ?? {}})) this.socket.send(message); }
      catch (error) { this.calls.delete(id); clearTimeout(timer); reject(error as Error); }
    });
  }
  on(listener: (event: MobileEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onClose(listener: (reason: string, code: number) => void): () => void { this.closers.add(listener); return () => { this.closers.delete(listener); }; }
  close(): void { if (this.closed) return; try { this.socket.close(1000, 'closed'); } catch { /* already closed */ } this.finish('closed'); }
}

interface HandshakeInput { desktopKey: Uint8Array; keyPair: {publicKey: Uint8Array; privateKey: Uint8Array}; mode: ChannelMode; psk?: Uint8Array; payload: object; crypto: NoiseCrypto }

/** Opens one socket; rejects (and closes it) if it closes or errors first, or after `timeoutMs`. */
function openSocket(factory: SocketFactory, url: string, timeoutMs: number, mode: ChannelMode): Promise<SocketLike> {
  return new Promise((resolve, reject) => {
    let socket: SocketLike;
    let settled = false;
    const fail = (error: MobileError) => { if (settled) return; settled = true; clearTimeout(timer); try { socket?.close(1000, 'failed'); } catch { /* ignore */ } reject(error); };
    const timer = setTimeout(() => fail(new MobileError('timeout', 'Your computer did not answer in time.')), timeoutMs);
    try { socket = factory(url); } catch (error) { fail(new MobileError('offline', (error as Error).message)); return; }
    socket.onopen = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(socket); };
    socket.onerror = () => undefined;
    socket.onclose = (event: {code: number; reason: string}) => fail(closeError(event.code, event.reason, mode));
    socket.onmessage = () => undefined;
  });
}
/** The first of several sockets to open; the others are closed. Rejects when none opens in time. */
function firstOpen(factory: SocketFactory, urls: string[], timeoutMs: number, mode: ChannelMode): Promise<SocketLike> {
  return new Promise((resolve, reject) => {
    let left = urls.length, won = false;
    for (const url of urls) openSocket(factory, url, timeoutMs, mode).then(socket => {
      if (won) { try { socket.close(1000, 'unused'); } catch { /* ignore */ } return; }
      won = true; resolve(socket);
    }, error => { if (--left === 0 && !won) reject(error); });
  });
}
/** Runs the Noise handshake on an open socket: message 1 now, then the desktop's welcome. */
function handshakeOn(socket: SocketLike, input: HandshakeInput, timeoutMs: number, via: 'lan' | 'relay'): Promise<{connection: Connection; checkCode: string}> {
  return new Promise((resolve, reject) => {
    const noise = new Handshake(input.crypto, {pattern: input.mode === 'pair' ? 'IKpsk1' : 'IK', initiator: true, s: input.keyPair, rs: input.desktopKey, ...(input.psk ? {psk: input.psk} : {}), prologue: prologue(input.mode)});
    let settled = false;
    const fail = (error: MobileError) => { if (settled) return; settled = true; clearTimeout(timer); try { socket.close(1000, 'failed'); } catch { /* ignore */ } reject(error); };
    const timer = setTimeout(() => fail(new MobileError('timeout', 'Your computer did not answer in time.')), timeoutMs);
    socket.onerror = () => undefined;
    socket.onclose = (event: {code: number; reason: string}) => fail(closeError(event.code, event.reason, input.mode));
    socket.onmessage = (event: {data: unknown}) => {
      if (settled || typeof event.data !== 'string') return;
      try {
        const welcome = JSON.parse(fromUtf8(noise.readMessage(fromBase64(event.data)))) as Welcome;
        if (welcome?.v !== MOBILE_PROTOCOL_VERSION || typeof welcome.deviceId !== 'string') throw new Error('Unsupported desktop version.');
        const {send, receive} = noise.split();
        settled = true; clearTimeout(timer);
        resolve({connection: new Connection(socket, new SecureChannel(send, receive), welcome, via), checkCode: checkCodeOf(noise.handshakeHash)});
      } catch { fail(new MobileError(input.mode === 'pair' ? 'pairing-failed' : 'failed', 'Your computer’s answer could not be verified.')); }
    };
    try { socket.send(toBase64(concat(Uint8Array.of(MODE_BYTE[input.mode]), noise.writeMessage(utf8(JSON.stringify(input.payload)))))); }
    catch (error) { fail(new MobileError('failed', (error as Error).message)); }
  });
}
/** Through the relay: open the route, then the handshake, within one timeout. */
async function overRelay(factory: SocketFactory, relayUrl: string, route: string, input: HandshakeInput, timeoutMs: number) {
  const started = Date.now();
  const socket = await openSocket(factory, phoneUrl(relayUrl, route), timeoutMs, input.mode);
  return handshakeOn(socket, input, Math.max(1, timeoutMs - (Date.now() - started)), 'relay');
}
/** Applies the desktop's hello to the connection: access and its current LAN addresses. */
function applyHello(connection: Connection, hello: MobileMethods['hello']['result']) {
  connection.access = hello.access;
  connection.lan = cleanLanAddresses(hello.lan) ?? [];
}

export interface PairOptions { link: PairingLink | string; crypto: NoiseCrypto; socket: SocketFactory; name: string; platform: string; timeoutMs?: number }
export interface PairResult {
  client: MobileConnection; record: PairedRecord;
  /** The 6-digit code the phone shows; the owner checks the desktop shows the same before adding the phone. */
  checkCode: string;
  /** Settles when the desktop adds the phone (then keep `record`), or rejects when it is rejected, expires or disconnects. */
  confirmed: Promise<void>;
}
/** Pairs with the desktop that showed `link`. The phone is pending until the owner confirms the check code on the desktop. */
export async function pairPhone(options: PairOptions): Promise<PairResult> {
  const link = typeof options.link === 'string' ? parsePairingLink(options.link) : options.link;
  const keyPair = options.crypto.generateKeyPair();
  const request: PairRequest = {v: MOBILE_PROTOCOL_VERSION, name: options.name.slice(0, 80), platform: options.platform.slice(0, 20)};
  const input: HandshakeInput = {desktopKey: fromBase64(link.desktopKey), keyPair, mode: 'pair', psk: fromBase64(link.code), payload: request, crypto: options.crypto};
  const timeoutMs = options.timeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  // Same network first. Only the socket races: once message 1 is sent the code may be taken, so a pairing never retries on
  // another path after that (a second try would be told the code was already used).
  let lanSocket: SocketLike | null = null;
  if (link.lan?.length) { try { lanSocket = await firstOpen(options.socket, link.lan.map(address => lanUrl(address, link.route)), LAN_OPEN_MS, 'pair'); } catch { /* the relay */ } }
  const {connection, checkCode} = lanSocket ? await handshakeOn(lanSocket, input, timeoutMs, 'lan') : await overRelay(options.socket, link.relayUrl, link.route, input, timeoutMs);
  const record: PairedRecord = {relayUrl: link.relayUrl, route: link.route, desktopKey: link.desktopKey, desktopName: connection.desktopName, deviceId: connection.deviceId,
    publicKey: toBase64(keyPair.publicKey, true), privateKey: toBase64(keyPair.privateKey, true), ...(link.lan?.length ? {lan: link.lan} : {})};
  const confirmed = new Promise<void>((resolve, reject) => {
    if (!connection.pending) { resolve(); return; }
    const off = connection.on(event => { if (event.type === 'paired') { off(); offClose(); resolve(); } });
    const offClose = connection.onClose((reason, code) => { off(); offClose(); reject(closeError(code, reason, 'pair')); });
  }).then(async () => {
    applyHello(connection, await connection.call('hello', {}));
    if (connection.lan.length) record.lan = connection.lan; else delete record.lan;
  });
  confirmed.catch(() => undefined);
  return {client: connection, record, checkCode, confirmed};
}

/** A whole session (handshake and hello) on the same network, the first address to finish winning; null when none does in
 *  LAN_SESSION_MS. Any failure here, a "revoked" close included, only means "use the relay": something else may be answering
 *  at that address, and only a desktop that proved its key in the handshake can say anything about this phone. */
function overLan(factory: SocketFactory, urls: string[], input: HandshakeInput): Promise<Connection | null> {
  return new Promise(resolve => {
    let left = urls.length, done = false;
    const finish = (value: Connection | null) => { if (done) { value?.close(); return; } done = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => finish(null), LAN_SESSION_MS);
    for (const url of urls) {
      void (async () => {
        const socket = await openSocket(factory, url, LAN_SESSION_MS, 'session');
        const {connection} = await handshakeOn(socket, input, LAN_SESSION_MS, 'lan');
        if (done) { connection.close(); return; }
        const late = setTimeout(() => connection.close(), LAN_SESSION_MS);
        try { applyHello(connection, await connection.call('hello', {})); } finally { clearTimeout(late); }
        finish(connection);
      })().catch(() => { if (--left === 0) finish(null); });
    }
  });
}

export interface ConnectOptions { record: PairedRecord; crypto: NoiseCrypto; socket: SocketFactory; timeoutMs?: number }
/** Opens a session with a desktop this phone paired with before. Its first encrypted message (hello) is what marks it
 *  connected on the desktop. */
export async function connectPhone(options: ConnectOptions): Promise<MobileConnection> {
  const {record} = options;
  const input: HandshakeInput = {desktopKey: fromBase64(record.desktopKey), keyPair: {publicKey: fromBase64(record.publicKey), privateKey: fromBase64(record.privateKey)}, mode: 'session', payload: {v: MOBILE_PROTOCOL_VERSION}, crypto: options.crypto};
  const lan = cleanLanAddresses(record.lan);
  if (lan) { const direct = await overLan(options.socket, lan.map(address => lanUrl(address, record.route)), input); if (direct) return direct; }
  const {connection} = await overRelay(options.socket, record.relayUrl, record.route, input, options.timeoutMs ?? HANDSHAKE_TIMEOUT_MS);
  applyHello(connection, await connection.call('hello', {}));
  return connection;
}

export interface UploadOptions {
  chatId: string; name: string; mime: string; bytes: Uint8Array;
  /** SHA-256 of the bytes (the phone's noble or the desktop's Node hash). */
  sha256(bytes: Uint8Array): Uint8Array;
  /** Bytes the desktop has received so far, after each chunk. */
  onProgress?(sent: number): void;
}
/** Sends a photo or file to a chat on the desktop through the encrypted session, in order, one chunk at a time; the desktop
 *  checks the length and hash and stages it. Pass the returned id in chat.send's attachmentIds. */
export async function uploadAttachment(connection: MobileConnection, options: UploadOptions): Promise<MobileAttachment> {
  const {bytes} = options;
  if (!bytes.length) throw new MobileError('bad-request', 'This file is empty.');
  if (bytes.length > UPLOAD_MAX_BYTES) throw new MobileError('bad-request', `${options.name} is larger than 20 MB.`);
  const sha256 = Array.from(options.sha256(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
  const {uploadId, chunkBytes} = await connection.call('upload.start', {chatId: options.chatId, name: options.name, mime: options.mime, size: bytes.length, sha256});
  const step = Math.max(1, Math.min(chunkBytes || UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES));
  try {
    for (let offset = 0; offset < bytes.length; offset += step) {
      const {received} = await connection.call('upload.chunk', {uploadId, offset, data: toBase64(bytes.subarray(offset, offset + step))});
      options.onProgress?.(received);
    }
    return (await connection.call('upload.finish', {uploadId})).attachment;
  } catch (error) {
    void connection.call('upload.cancel', {uploadId}).catch(() => undefined);
    throw error;
  }
}
