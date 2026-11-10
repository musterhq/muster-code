/**
 * Dev relay for the phone link (#326, docs/mobile/DESIGN.md §2). It forwards opaque base64 strings between a phone and the
 * desktop it asks for, and nothing else: no accounts, no storage, no keys. Development and tests only; where the production
 * relay runs is a later decision.
 *
 *   desktop:  GET /v1/desktop          relay → {t:'challenge', nonce}; desktop → {t:'register', key, sig} where key is its raw
 *                                      Ed25519 route public key and sig signs "muster-relay/1 register <nonce>";
 *                                      relay verifies, then → {t:'registered', route}; route = hex(sha256(key))[0:32].
 *                                      The relay never learns anything that would let it (or a ws:// observer) register the
 *                                      route itself; a live registration is replaced only by another valid signature.
 *             relay → desktop          {t:'open', c} · {t:'data', c, d} · {t:'closed', c}
 *             desktop → relay          {t:'data', c, d} · {t:'close', c, code, reason}
 *   phone:    GET /v1/phone/<route>    text frames are the base64 strings, both ways; 4404 when the desktop is offline
 *
 * Test-only, and off unless started with `{test: true}`: every forwarded payload is recorded in `frames` (tests prove they
 * are ciphertext), and `intercept` lets a test change, drop or duplicate a payload in flight.
 */
import {createHash, createPublicKey, randomBytes, verify} from 'node:crypto';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {acceptUpgrade, type WsConnection} from '../../server/src/net/ws.ts';

export interface RelayFrame { from: 'phone' | 'desktop'; route: string; conn: number; data: string }
export type RelayIntercept = (frame: RelayFrame) => string | string[] | null;
export interface DevRelay {
  url: string;
  frames: RelayFrame[];
  intercept: RelayIntercept | undefined;
  close(): Promise<void>;
}
/** The route of a desktop: the first 16 bytes of sha256(its raw Ed25519 route public key), hex. */
export const routeFor = (publicKey: Uint8Array): string => createHash('sha256').update(publicKey).digest('hex').slice(0, 32);
const ED_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const registration = (nonce: string) => Buffer.from(`muster-relay/1 register ${nonce}`, 'utf8');
function verified(key: unknown, sig: unknown, nonce: string): Buffer | null {
  if (typeof key !== 'string' || typeof sig !== 'string' || key.length > 64 || sig.length > 128) return null;
  try {
    const raw = Buffer.from(key, 'base64');
    if (raw.length !== 32) return null;
    const ok = verify(null, registration(nonce), createPublicKey({key: Buffer.concat([ED_SPKI, raw]), format: 'der', type: 'spki'}), Buffer.from(sig, 'base64'));
    return ok ? raw : null;
  } catch { return null; }
}
const ROUTE = /^[a-f0-9]{32}$/;
const DATA = /^[A-Za-z0-9+/=_-]{1,22000000}$/;
const MAX_RECORDED = 20_000;

export async function startRelay(options: {host?: string; port?: number; log?: (line: string) => void; /** Record frames and allow intercept (tests only). */ test?: boolean} = {}): Promise<DevRelay> {
  const desktops = new Map<string, {socket: WsConnection; phones: Map<number, WsConnection>}>();
  const all = new Set<WsConnection>();
  let nextConn = 1;
  const relay: DevRelay = {url: '', frames: [], intercept: undefined, close};
  const log = options.log ?? (() => undefined);
  const forward = (frame: RelayFrame, deliver: (data: string) => void) => {
    const out = options.test && relay.intercept ? relay.intercept(frame) : frame.data;
    for (const data of out === null ? [] : Array.isArray(out) ? out : [out]) {
      if (options.test && relay.frames.length < MAX_RECORDED) relay.frames.push({...frame, data});
      deliver(data);
    }
  };

  const server = http.createServer((_req, res) => { res.writeHead(404).end(); });
  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://relay').pathname;
    const phone = /^\/v1\/phone\/([a-f0-9]{32})$/.exec(path);
    if (path !== '/v1/desktop' && !phone) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    const ws = acceptUpgrade(req, socket, head);
    if (!ws) return;
    all.add(ws); ws.on('close', () => all.delete(ws));
    ws.on('error', () => undefined);
    if (phone) return attachPhone(ws, phone[1]!);
    attachDesktop(ws);
  });

  function attachDesktop(ws: WsConnection) {
    let route: string | null = null;
    const nonce = randomBytes(32).toString('base64');
    ws.send(JSON.stringify({t: 'challenge', nonce}));
    ws.on('message', (text: string) => {
      let message: {t?: string; key?: unknown; sig?: unknown; c?: unknown; d?: unknown; code?: unknown; reason?: unknown};
      try { message = JSON.parse(text); } catch { ws.close(1003, 'bad message'); return; }
      if (message.t === 'register') {
        const key = route ? null : verified((message as {key?: unknown}).key, (message as {sig?: unknown}).sig, nonce);
        if (!key) { ws.close(4401, 'bad signature'); return; }
        route = routeFor(key);
        // A newer registration for the same route replaces the old link; its phones are dropped.
        const old = desktops.get(route);
        if (old && old.socket !== ws) { for (const p of old.phones.values()) p.close(4404, 'offline'); old.socket.close(4409, 'replaced'); }
        desktops.set(route, {socket: ws, phones: new Map()});
        ws.send(JSON.stringify({t: 'registered', route}));
        log(`desktop registered ${route}`);
        return;
      }
      const entry = route ? desktops.get(route) : undefined;
      if (!entry || entry.socket !== ws || typeof message.c !== 'number') return;
      const target = entry.phones.get(message.c);
      if (!target) return;
      if (message.t === 'data' && typeof message.d === 'string' && DATA.test(message.d)) forward({from: 'desktop', route: route!, conn: message.c, data: message.d}, data => target.send(data));
      else if (message.t === 'close') {
        const code = typeof message.code === 'number' && message.code >= 4000 && message.code < 5000 ? message.code : 1000;
        target.close(code, typeof message.reason === 'string' ? message.reason.slice(0, 60) : '');
        entry.phones.delete(message.c);
      }
    });
    ws.on('close', () => {
      if (!route) return;
      const entry = desktops.get(route);
      if (entry?.socket !== ws) return;
      desktops.delete(route);
      for (const p of entry.phones.values()) p.close(4404, 'offline');
    });
  }

  function attachPhone(ws: WsConnection, route: string) {
    const entry = ROUTE.test(route) ? desktops.get(route) : undefined;
    if (!entry) { ws.close(4404, 'offline'); return; }
    const conn = nextConn++;
    entry.phones.set(conn, ws);
    entry.socket.send(JSON.stringify({t: 'open', c: conn}));
    ws.on('message', (text: string) => {
      if (!DATA.test(text)) { ws.close(1003, 'bad frame'); return; }
      const live = desktops.get(route);
      if (live !== entry) return;
      forward({from: 'phone', route, conn, data: text}, data => entry.socket.send(JSON.stringify({t: 'data', c: conn, d: data})));
    });
    ws.on('close', () => {
      if (entry.phones.get(conn) !== ws) return;
      entry.phones.delete(conn);
      if (desktops.get(route) === entry) entry.socket.send(JSON.stringify({t: 'closed', c: conn}));
    });
  }

  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve()); });
  const address = server.address() as AddressInfo;
  relay.url = `ws://${address.address.includes(':') ? `[${address.address}]` : address.address}:${address.port}`;

  async function close(): Promise<void> {
    for (const ws of all) ws.terminate();
    all.clear(); desktops.clear();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  return relay;
}
