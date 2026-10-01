/**
 * Minimal RFC 6455 WebSocket (text frames, ping/pong, close, fragmentation), no dependencies.
 * Server side: the /events stream. Client side: Slack Socket Mode and Mattermost, with protocol-level ping liveness
 * (a dead TCP path is detected by a missing pong, not by waiting for traffic that may never come).
 */
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const MAX_MESSAGE = 4 * 1024 * 1024;
const acceptKey = (key: string) => createHash('sha1').update(key + GUID).digest('base64');

export class WsConnection extends EventEmitter {
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private closed = false;
  lastPongAt = Date.now();
  constructor(private readonly socket: Duplex, private readonly maskOutgoing: boolean) {
    super();
    socket.on('data', chunk => this.onData(chunk as Buffer));
    socket.on('close', () => this.finish(1006, 'socket closed'));
    // A reset or broken pipe ends the connection; it is never an uncaught exception (an EventEmitter 'error' with no listener throws).
    socket.on('error', error => { if (this.listenerCount('error')) this.emit('error', error); this.finish(1006, String(error.message)); });
    socket.on('end', () => this.finish(1006, 'socket ended'));
  }
  get isOpen(): boolean { return !this.closed; }
  private finish(code: number, reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code, reason);
    this.socket.destroy();
  }
  private onData(chunk: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0]!, b1 = this.buffer[1]!;
      const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, offset = 2;
      if (len === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (this.buffer.length < 10) return; const big = this.buffer.readBigUInt64BE(2); if (big > BigInt(MAX_MESSAGE)) return this.fail(1009, 'message too big'); len = Number(big); offset = 10; }
      if (len > MAX_MESSAGE) return this.fail(1009, 'message too big');
      // Servers must reject unmasked client frames; clients must reject masked server frames.
      if (masked === this.maskOutgoing) return this.fail(1002, masked ? 'masked frame from server' : 'unmasked frame from client');
      const total = offset + (masked ? 4 : 0) + len;
      if (this.buffer.length < total) return;
      let payload = this.buffer.subarray(offset + (masked ? 4 : 0), total);
      if (masked) {
        const mask = this.buffer.subarray(offset, offset + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!;
      }
      this.buffer = this.buffer.subarray(total);
      this.frame(fin, opcode, payload);
      if (this.closed) return;
    }
  }
  private frame(fin: boolean, opcode: number, payload: Buffer) {
    if (opcode === 0x8) { const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005; this.write(0x8, payload.subarray(0, 2)); this.finish(code, payload.subarray(2).toString('utf8')); return; }
    if (opcode === 0x9) { this.write(0xA, payload); this.emit('ping'); return; }
    if (opcode === 0xA) { this.lastPongAt = Date.now(); this.emit('pong'); return; }
    if (opcode === 0x1 || opcode === 0x2) { this.fragments = [payload]; this.fragmentOpcode = opcode; }
    else if (opcode === 0x0) { this.fragments.push(payload); if (this.fragments.reduce((n, f) => n + f.length, 0) > MAX_MESSAGE) return this.fail(1009, 'message too big'); }
    else return this.fail(1002, 'bad opcode');
    if (!fin) return;
    const data = Buffer.concat(this.fragments); this.fragments = [];
    if (this.fragmentOpcode === 0x1) this.emit('message', data.toString('utf8'));
  }
  private fail(code: number, reason: string) { this.close(code, reason); this.finish(code, reason); }
  private write(opcode: number, payload: Buffer) {
    if (this.socket.destroyed) return;
    const len = payload.length;
    const head: number[] = [0x80 | opcode];
    const maskBit = this.maskOutgoing ? 0x80 : 0;
    if (len < 126) head.push(maskBit | len);
    else if (len < 65536) head.push(maskBit | 126, len >> 8, len & 0xff);
    else { head.push(maskBit | 127); const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); head.push(...b); }
    if (this.maskOutgoing) {
      const mask = randomBytes(4), body = Buffer.from(payload);
      for (let i = 0; i < body.length; i++) body[i]! ^= mask[i & 3]!;
      this.socket.write(Buffer.concat([Buffer.from(head), mask, body]));
    } else this.socket.write(Buffer.concat([Buffer.from(head), payload]));
  }
  send(text: string): void { if (!this.closed) this.write(0x1, Buffer.from(text, 'utf8')); }
  ping(): void { if (!this.closed) this.write(0x9, Buffer.alloc(0)); }
  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason)); body.writeUInt16BE(code); body.write(reason, 2);
    this.write(0x8, body);
    setTimeout(() => this.finish(code, reason), 200).unref();
  }
  terminate(reason = 'terminated'): void { this.finish(1006, reason); }
}

/** Completes a server-side upgrade. Returns null (and answers 400) for a bad handshake. */
export function acceptUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): WsConnection | null {
  const key = req.headers['sec-websocket-key'];
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string' || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return null;
  }
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
  const conn = new WsConnection(socket, false);
  if (head.length) socket.unshift(head);
  return conn;
}

/** Opens a client connection (ws: or wss:). */
export function connectWebSocket(url: string, options: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<WsConnection> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const secure = target.protocol === 'wss:' || target.protocol === 'https:';
    const key = randomBytes(16).toString('base64');
    const req = (secure ? https : http).request({
      hostname: target.hostname, port: target.port || (secure ? 443 : 80), path: target.pathname + target.search, method: 'GET',
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key, ...options.headers },
    });
    const timer = setTimeout(() => { req.destroy(new Error('WebSocket connect timed out')); }, options.timeoutMs ?? 15_000);
    req.on('upgrade', (res, socket, head) => {
      clearTimeout(timer);
      if (res.headers['sec-websocket-accept'] !== acceptKey(key)) { socket.destroy(); reject(new Error('WebSocket handshake failed (bad accept key).')); return; }
      const conn = new WsConnection(socket, true);
      if (head.length) socket.unshift(head);
      resolve(conn);
    });
    req.on('response', res => { clearTimeout(timer); reject(new Error(`WebSocket upgrade refused: HTTP ${res.statusCode}`)); res.resume(); });
    req.on('error', error => { clearTimeout(timer); reject(error); });
    req.end();
  });
}

/** Sends a protocol ping every `intervalMs`; terminates the connection when no pong arrives within `timeoutMs`. */
export function keepAlive(conn: WsConnection, intervalMs = 25_000, timeoutMs = 10_000): () => void {
  let waiting: NodeJS.Timeout | undefined;
  const tick = setInterval(() => {
    if (!conn.isOpen) return stop();
    const sentAt = Date.now();
    conn.ping();
    waiting = setTimeout(() => { if (conn.lastPongAt < sentAt) conn.terminate('pong timeout'); }, timeoutMs);
    waiting.unref();
  }, intervalMs);
  tick.unref();
  const stop = () => { clearInterval(tick); if (waiting) clearTimeout(waiting); };
  conn.once('close', stop);
  return stop;
}
