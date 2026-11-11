/**
 * Direct phone connections on the same network (#326 phase 2, docs/mobile/DESIGN.md §2.3). The desktop listens for phones
 * on its private-network addresses and carries exactly what the relay carries: the phone's base64 Noise messages, into the
 * same session code, so the handshake, the device registry, the access checks and the command allowlist are the same code.
 *
 * Binding (why it can't weaken the relay path's threat model):
 * - Only literal private-network addresses of this computer's interfaces (RFC 1918 IPv4 and unique-local IPv6), one listener
 *   each, on one port. Never 0.0.0.0 or ::, never a public address, never loopback, link-local, carrier-grade NAT (VPN
 *   overlays) or container and VM bridges. Off while phone access is off, and switchable in Settings.
 * - It accepts one thing: a WebSocket upgrade to /v1/phone/<this desktop's route>. Anything else is 404.
 * - Host must be the literal address it was reached on (a DNS-rebinding page sends a name), and an Origin, if any, must be that
 *   same address (React Native sends its own; a browser page elsewhere sends its own origin). Otherwise 403.
 * - Messages larger than one Noise message (87,384 base64 characters) close the socket, the same cap as the relay, and a
 *   socket that stops answering pings is dropped. At most 64 sockets at once; the session code also caps unauthenticated
 *   ones and times out stalled handshakes, for both paths.
 * - Plain ws:// is fine here for the same reason a ws:// relay on a private network is: everything inside is Noise ciphertext,
 *   and a LAN attacker gets what a malicious relay gets (sizes and timing, the power to drop). The phone only treats a LAN
 *   session as good after the Noise handshake proves the desktop's static key, and never takes a LAN close as "revoked".
 */
import {createHash} from 'node:crypto';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import type {NetworkInterfaceInfo} from 'node:os';
import type {Duplex} from 'node:stream';

/** One Noise message (65,535 bytes plus the handshake's mode byte) as base64; nothing larger is a valid message. */
export const MAX_LAN_MESSAGE = 87_384;
export const MAX_LAN_SOCKETS = 64;
/** LAN connection ids are far from the relay's, so both can share the session table. */
const LAN_CONN_BASE = 1_000_000_000;
const MAX_LAN_HOSTS = 4;
const VIRTUAL = /^(docker|br-|veth|vmnet|vboxnet|bridge|virbr|cni|flannel|podman|lxc|lxd|tailscale|zt|utun|ipsec|ppp|awdl|llw|anpi)/i;
const DATA = /^[A-Za-z0-9+/=_-]+$/;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const privateIpv4 = (address: string) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(address);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
};
const uniqueLocalIpv6 = (address: string) => /^f[cd][0-9a-f]{2}:/i.test(address);

/** The addresses to listen on: private IPv4 first, then unique-local IPv6, at most four, from real (not virtual) interfaces. */
export function lanHosts(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
  const v4: string[] = [], v6: string[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (VIRTUAL.test(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family === 'IPv4' && privateIpv4(entry.address)) v4.push(entry.address);
      else if (entry.family === 'IPv6' && uniqueLocalIpv6(entry.address)) v6.push(entry.address.toLowerCase());
    }
  }
  return [...new Set([...v4, ...v6])].slice(0, MAX_LAN_HOSTS);
}
/** host:port as the pairing link and the phone write it (IPv6 in brackets). */
export const hostPort = (host: string, port: number) => `${host.includes(':') ? `[${host}]` : host}:${port}`;

export interface LanHandlers {
  open(conn: number): void;
  data(conn: number, data: string): void;
  closed(conn: number): void;
}
export interface LanOptions { hosts: string[]; port: number; keepAlive?: {intervalMs: number; timeoutMs: number} }

/** A minimal server-side RFC 6455 connection: text frames, ping/pong, close, fragmentation, a message cap. */
class LanSocket {
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private closed = false;
  lastPongAt = Date.now();
  onMessage: (text: string) => void = () => undefined;
  onClose: () => void = () => undefined;
  constructor(private readonly socket: Duplex) {
    socket.on('data', chunk => this.read(chunk as Buffer));
    socket.on('close', () => this.finish());
    socket.on('end', () => this.finish());
    socket.on('error', () => this.finish());
  }
  private finish() { if (this.closed) return; this.closed = true; this.socket.destroy(); this.onClose(); }
  private read(chunk: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (this.closed || this.buffer.length < 2) return;
      const b0 = this.buffer[0]!, b1 = this.buffer[1]!;
      const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f, at = 2;
      if (length === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); at = 4; }
      else if (length === 127) { if (this.buffer.length < 10) return; const big = this.buffer.readBigUInt64BE(2); if (big > BigInt(MAX_LAN_MESSAGE)) return this.close(1009, 'message too big'); length = Number(big); at = 10; }
      if (length > MAX_LAN_MESSAGE) return this.close(1009, 'message too big');
      if (!masked) return this.close(1002, 'unmasked frame');
      const total = at + 4 + length;
      if (this.buffer.length < total) return;
      const mask = this.buffer.subarray(at, at + 4), payload = Buffer.from(this.buffer.subarray(at + 4, total));
      for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!;
      this.buffer = this.buffer.subarray(total);
      this.frame(fin, opcode, payload);
    }
  }
  private frame(fin: boolean, opcode: number, payload: Buffer) {
    if (opcode === 0x8) { this.write(0x8, payload.subarray(0, 2)); this.finish(); return; }
    if (opcode === 0x9) { this.write(0xa, payload); return; }
    if (opcode === 0xa) { this.lastPongAt = Date.now(); return; }
    if (opcode === 0x1) this.fragments = [payload];
    else if (opcode === 0x0 && this.fragments.length) this.fragments.push(payload);
    else return this.close(1003, 'text only');
    const size = this.fragments.reduce((sum, part) => sum + part.length, 0);
    if (size > MAX_LAN_MESSAGE) return this.close(1009, 'message too big');
    if (!fin) return;
    const text = Buffer.concat(this.fragments).toString('utf8'); this.fragments = [];
    this.onMessage(text);
  }
  private write(opcode: number, payload: Buffer) {
    if (this.socket.destroyed) return;
    const length = payload.length;
    const head = length < 126 ? Buffer.of(0x80 | opcode, length) : length < 65_536 ? Buffer.of(0x80 | opcode, 126, length >> 8, length & 0xff) : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeBigUInt64BE(BigInt(length), 2); return h; })();
    this.socket.write(Buffer.concat([head, payload]));
  }
  get open() { return !this.closed; }
  send(text: string) { if (!this.closed) this.write(0x1, Buffer.from(text, 'utf8')); }
  ping() { if (!this.closed) this.write(0x9, Buffer.alloc(0)); }
  close(code: number, reason: string) {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason)); body.writeUInt16BE(code); body.write(reason, 2);
    this.write(0x8, body);
    const timer = setTimeout(() => this.finish(), 200); timer.unref?.();
  }
  terminate() { this.finish(); }
}

export class LanListener {
  private readonly servers = new Map<string, http.Server>();
  private readonly sockets = new Map<number, {socket: LanSocket; host: string}>();
  private nextConn = LAN_CONN_BASE;
  private keepAlive: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  port: number;
  constructor(private readonly route: string, private readonly handlers: LanHandlers, private readonly options: LanOptions) { this.port = options.port; }

  /** The addresses phones dial, as host:port. */
  get addresses(): string[] { return [...this.servers.keys()].map(host => hostPort(host, this.port)); }

  /** Binds every host on one port: the saved one when it is free, else a new one (then every host moves to it). */
  async start(): Promise<void> {
    await this.update(this.options.hosts);
    const {intervalMs = 25_000, timeoutMs = 10_000} = this.options.keepAlive ?? {};
    this.keepAlive = setInterval(() => {
      const sentAt = Date.now();
      for (const {socket} of this.sockets.values()) socket.ping();
      const check = setTimeout(() => { for (const {socket} of this.sockets.values()) if (socket.lastPongAt < sentAt) socket.terminate(); }, timeoutMs);
      check.unref?.();
    }, intervalMs);
    this.keepAlive.unref?.();
  }

  /** Follows the computer's addresses as networks change: new hosts are bound, gone ones are closed with their sockets. */
  async update(hosts: string[]): Promise<void> {
    if (this.stopped) return;
    for (const host of [...this.servers.keys()]) if (!hosts.includes(host)) this.unbind(host);
    for (const host of hosts) {
      if (this.servers.has(host)) continue;
      try { await this.bind(host, this.port); }
      catch {
        // The saved port is taken: the first host takes any free port and the rest follow it. A later host that can't
        // have the shared port is skipped (the phone tries the others, then the relay).
        if (this.servers.size || this.port === 0) continue;
        this.port = 0;
        await this.bind(host, 0).catch(() => undefined);
      }
    }
  }

  private bind(host: string, port: number): Promise<void> {
    const server = http.createServer((_req, res) => { res.writeHead(404, {Connection: 'close'}).end(); });
    server.on('upgrade', (req, socket, head) => this.upgrade(host, req, socket, head));
    server.on('clientError', (_error, socket) => socket.destroy());
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({host, port, exclusive: true}, () => {
        server.off('error', reject);
        server.on('error', () => undefined);
        this.port = (server.address() as AddressInfo).port;
        this.servers.set(host, server);
        resolve();
      });
    });
  }
  private unbind(host: string) {
    const server = this.servers.get(host);
    this.servers.delete(host);
    for (const [conn, entry] of this.sockets) if (entry.host === host) { entry.socket.terminate(); this.sockets.delete(conn); this.handlers.closed(conn); }
    server?.close();
  }

  private upgrade(host: string, req: http.IncomingMessage, socket: Duplex, head: Buffer) {
    const refuse = (status: string) => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); socket.destroy(); };
    if (req.url !== `/v1/phone/${this.route}`) return refuse('404 Not Found');
    const expected = hostPort(host, this.port);
    if (req.headers.host !== expected) return refuse('403 Forbidden');
    const origin = req.headers.origin;
    if (origin !== undefined) { let reached = ''; try { reached = new URL(origin).host; } catch { /* refused below */ } if (reached !== expected) return refuse('403 Forbidden'); }
    const key = req.headers['sec-websocket-key'];
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string' || req.headers['sec-websocket-version'] !== '13') return refuse('400 Bad Request');
    if (this.sockets.size >= MAX_LAN_SOCKETS) return refuse('503 Service Unavailable');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createHash('sha1').update(key + GUID).digest('base64')}\r\n\r\n`);
    const ws = new LanSocket(socket);
    if (head.length) socket.unshift(head);
    const conn = this.nextConn++;
    this.sockets.set(conn, {socket: ws, host});
    ws.onMessage = text => { if (!DATA.test(text)) { ws.close(1003, 'bad frame'); return; } this.handlers.data(conn, text); };
    ws.onClose = () => { if (this.sockets.delete(conn)) this.handlers.closed(conn); };
    this.handlers.open(conn);
  }

  send(conn: number, data: string): void { this.sockets.get(conn)?.socket.send(data); }
  closePhone(conn: number, code: number, reason: string): void {
    const entry = this.sockets.get(conn);
    if (!entry) return;
    this.sockets.delete(conn);
    entry.socket.close(code >= 4000 && code < 5000 ? code : 1000, reason.slice(0, 60));
  }
  stop(): void {
    this.stopped = true;
    if (this.keepAlive) clearInterval(this.keepAlive);
    for (const host of [...this.servers.keys()]) this.unbind(host);
  }
}
