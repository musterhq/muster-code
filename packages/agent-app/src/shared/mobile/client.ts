/**
 * The phone side of the link (#326): pair with a desktop from its QR link, reconnect later with the saved record, call
 * methods and receive events over the Noise channel. Used by the app (noble crypto, React Native's WebSocket) and by the
 * desktop's workflow tests (Node crypto, Node's WebSocket), so both exercise the same code.
 */
import {concat, fromBase64, fromUtf8, toBase64, utf8} from './bytes.ts';
import {Handshake, type NoiseCrypto} from './noise.ts';
import {checkCodeOf, MODE_BYTE, prologue, SecureChannel, type ChannelMode} from './channel.ts';
import {CLOSE_REASON, MOBILE_PROTOCOL_VERSION, MobileError, parsePairingLink, UPLOAD_CHUNK_BYTES, UPLOAD_MAX_BYTES, type MobileAttachment, type MobileAccess, type MobileEvent, type MobileFrame, type MobileMethod, type MobileMethods, type PairingLink, type PairRequest, type Welcome} from './protocol.ts';

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

/** What the phone keeps (in Keychain / Keystore) to reconnect. Keys are base64url. */
export interface PairedRecord {
  relayUrl: string; route: string; desktopKey: string; desktopName: string; deviceId: string;
  publicKey: string; privateKey: string;
}

export interface MobileConnection {
  readonly desktopName: string;
  readonly deviceId: string;
  readonly access: MobileAccess;
  readonly closed: boolean;
  call<M extends MobileMethod>(method: M, params: MobileMethods[M]['params']): Promise<MobileMethods[M]['result']>;
  on(listener: (event: MobileEvent) => void): () => void;
  /** `reason` is the close reason ('revoked' only when the desktop no longer knows this phone); `code` the close code. */
  onClose(listener: (reason: string, code: number) => void): () => void;
  close(): void;
}

const HANDSHAKE_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;
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
  desktopName: string; deviceId: string; access: MobileAccess; closed = false;
  private nextId = 1;
  private readonly calls = new Map<number, {resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>}>();
  private readonly listeners = new Set<(event: MobileEvent) => void>();
  private readonly closers = new Set<(reason: string, code: number) => void>();
  pending: boolean;
  constructor(private readonly socket: SocketLike, private readonly channel: SecureChannel, welcome: Welcome) {
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

interface HandshakeInput { relayUrl: string; route: string; desktopKey: Uint8Array; keyPair: {publicKey: Uint8Array; privateKey: Uint8Array}; mode: ChannelMode; psk?: Uint8Array; payload: object; crypto: NoiseCrypto; socket: SocketFactory; timeoutMs?: number }
function handshake(input: HandshakeInput): Promise<{connection: Connection; checkCode: string}> {
  return new Promise((resolve, reject) => {
    const noise = new Handshake(input.crypto, {pattern: input.mode === 'pair' ? 'IKpsk1' : 'IK', initiator: true, s: input.keyPair, rs: input.desktopKey, ...(input.psk ? {psk: input.psk} : {}), prologue: prologue(input.mode)});
    let socket: SocketLike;
    let settled = false;
    const fail = (error: MobileError) => { if (settled) return; settled = true; clearTimeout(timer); try { socket?.close(1000, 'failed'); } catch { /* ignore */ } reject(error); };
    const timer = setTimeout(() => fail(new MobileError('timeout', 'Your computer did not answer in time.')), input.timeoutMs ?? HANDSHAKE_TIMEOUT_MS);
    try { socket = input.socket(phoneUrl(input.relayUrl, input.route)); } catch (error) { fail(new MobileError('offline', (error as Error).message)); return; }
    socket.onopen = () => {
      try { socket.send(toBase64(concat(Uint8Array.of(MODE_BYTE[input.mode]), noise.writeMessage(utf8(JSON.stringify(input.payload)))))); }
      catch (error) { fail(new MobileError('failed', (error as Error).message)); }
    };
    socket.onerror = () => undefined;
    socket.onclose = (event: {code: number; reason: string}) => fail(closeError(event.code, event.reason, input.mode));
    socket.onmessage = (event: {data: unknown}) => {
      if (settled || typeof event.data !== 'string') return;
      try {
        const welcome = JSON.parse(fromUtf8(noise.readMessage(fromBase64(event.data)))) as Welcome;
        if (welcome?.v !== MOBILE_PROTOCOL_VERSION || typeof welcome.deviceId !== 'string') throw new Error('Unsupported desktop version.');
        const {send, receive} = noise.split();
        settled = true; clearTimeout(timer);
        resolve({connection: new Connection(socket, new SecureChannel(send, receive), welcome), checkCode: checkCodeOf(noise.handshakeHash)});
      } catch { fail(new MobileError(input.mode === 'pair' ? 'pairing-failed' : 'failed', 'Your computer’s answer could not be verified.')); }
    };
  });
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
  const {connection, checkCode} = await handshake({relayUrl: link.relayUrl, route: link.route, desktopKey: fromBase64(link.desktopKey), keyPair, mode: 'pair', psk: fromBase64(link.code), payload: request, crypto: options.crypto, socket: options.socket, ...(options.timeoutMs ? {timeoutMs: options.timeoutMs} : {})});
  const confirmed = new Promise<void>((resolve, reject) => {
    if (!connection.pending) { resolve(); return; }
    const off = connection.on(event => { if (event.type === 'paired') { off(); offClose(); resolve(); } });
    const offClose = connection.onClose((reason, code) => { off(); offClose(); reject(closeError(code, reason, 'pair')); });
  }).then(async () => { await connection.call('hello', {}); });
  confirmed.catch(() => undefined);
  const record: PairedRecord = {relayUrl: link.relayUrl, route: link.route, desktopKey: link.desktopKey, desktopName: connection.desktopName, deviceId: connection.deviceId,
    publicKey: toBase64(keyPair.publicKey, true), privateKey: toBase64(keyPair.privateKey, true)};
  return {client: connection, record, checkCode, confirmed};
}

export interface ConnectOptions { record: PairedRecord; crypto: NoiseCrypto; socket: SocketFactory; timeoutMs?: number }
/** Opens a session with a desktop this phone paired with before. Its first encrypted message (hello) is what marks it
 *  connected on the desktop. */
export async function connectPhone(options: ConnectOptions): Promise<MobileConnection> {
  const {record} = options;
  const {connection} = await handshake({relayUrl: record.relayUrl, route: record.route, desktopKey: fromBase64(record.desktopKey), keyPair: {publicKey: fromBase64(record.publicKey), privateKey: fromBase64(record.privateKey)},
    mode: 'session', payload: {v: MOBILE_PROTOCOL_VERSION}, crypto: options.crypto, socket: options.socket, ...(options.timeoutMs ? {timeoutMs: options.timeoutMs} : {})});
  const hello = await connection.call('hello', {});
  connection.access = hello.access;
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
