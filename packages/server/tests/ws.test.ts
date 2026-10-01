import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { acceptUpgrade, connectWebSocket, keepAlive, type WsConnection } from '../src/net/ws.ts';

async function server(onConn: (c: WsConnection) => void, opts: { answerPings?: boolean } = {}) {
  const sockets: import('node:stream').Duplex[] = [];
  const s = http.createServer();
  s.on('upgrade', (req, socket, head) => {
    sockets.push(socket);
    if (opts.answerPings === false) { // a half-open peer: completes the handshake, then never answers anything
      const key = String(req.headers['sec-websocket-key']);
      const { createHash } = require('node:crypto') as typeof import('node:crypto');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')}\r\n\r\n`);
      socket.on('data', () => undefined);
      return;
    }
    const c = acceptUpgrade(req, socket, head); if (c) onConn(c);
  });
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  return { url: `ws://127.0.0.1:${(s.address() as AddressInfo).port}/`, close: () => { for (const x of sockets) x.destroy(); s.close(); } };
}
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

test('server and client exchange text frames both ways, including large and multi-byte messages', async () => {
  const srv = await server(c => c.on('message', (t: string) => c.send(`echo:${t}`)));
  const client = await connectWebSocket(srv.url);
  const got: string[] = [];
  client.on('message', (t: string) => got.push(t));
  const big = 'é'.repeat(70_000);
  client.send('hi'); client.send(big);
  for (let i = 0; i < 50 && got.length < 2; i++) await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(got, ['echo:hi', `echo:${big}`]);
  client.close(); srv.close();
});

test('protocol pings get pongs; a peer that stops answering is terminated so the adapter reconnects', async () => {
  const healthy = await server(() => undefined);
  const a = await connectWebSocket(healthy.url);
  let pongs = 0; a.on('pong', () => pongs++);
  const stopA = keepAlive(a, 40, 100);
  await new Promise(r => setTimeout(r, 200));
  assert.ok(pongs >= 2, `expected pongs, got ${pongs}`);
  assert.equal(a.isOpen, true);
  stopA(); a.close(); healthy.close();

  const dead = await server(() => undefined, { answerPings: false });
  const b = await connectWebSocket(dead.url);
  const closed = new Promise<string>(r => b.once('close', (_c: number, reason: string) => r(reason)));
  keepAlive(b, 40, 80);
  assert.equal(await closed, 'pong timeout');
  dead.close();
});

test('a bad handshake is refused', async () => {
  const s = http.createServer(); s.on('upgrade', (req, socket, head) => { acceptUpgrade(req, socket, head); });
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  const status = await new Promise<number>(resolve => {
    const req = http.request({ port, host: '127.0.0.1', headers: { Connection: 'Upgrade', Upgrade: 'websocket' } });
    req.on('upgrade', () => resolve(101)); req.on('response', res => resolve(res.statusCode ?? 0)); req.on('error', () => resolve(-1)); req.end();
  });
  assert.equal(status, 400);
  s.close();
});
void require;
