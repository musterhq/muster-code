/**
 * #329: a local stand-in for the GitLab (`/gitlab/<host>/api/v4/...`) and Bitbucket Cloud (`/bitbucket/2.0/...`) REST APIs.
 * Tests add routes; every request is recorded (method, raw path with query, auth headers, JSON or text body). Unrouted
 * requests answer 404 like the real services. Nothing here talks to the network beyond 127.0.0.1.
 */
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';

export interface ForgeCall {method: string; path: string; headers: Record<string, string>; body: unknown}
export interface ForgeReply {status?: number; json?: unknown; text?: string; headers?: Record<string, string>}
type Handler = (call: ForgeCall) => ForgeReply | undefined;
export interface FakeForge {
  url: string;
  calls: ForgeCall[];
  on(method: string, path: RegExp, reply: ForgeReply | ((call: ForgeCall) => ForgeReply)): void;
  reset(): void;
  close(): Promise<void>;
}

export async function startFakeForge(): Promise<FakeForge> {
  const calls: ForgeCall[] = [];
  let routes: Handler[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: unknown = raw || undefined;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { /* keep text */ }
    const headers: Record<string, string> = {};
    for (const name of ['authorization', 'private-token', 'x-via', 'content-type']) if (req.headers[name]) headers[name] = String(req.headers[name]);
    const call: ForgeCall = {method: req.method ?? 'GET', path: req.url ?? '/', headers, body};
    calls.push(call);
    let reply: ForgeReply | undefined;
    for (const route of routes) { reply = route(call); if (reply) break; }
    reply ??= {status: 404, json: {message: '404 Not Found'}};
    const text = reply.text ?? JSON.stringify(reply.json ?? null);
    res.writeHead(reply.status ?? 200, {'content-type': reply.text !== undefined ? 'text/plain' : 'application/json', ...(reply.headers ?? {})});
    res.end(text);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    on(method, path, reply) { routes.push(call => call.method === method && path.test(call.path) ? (typeof reply === 'function' ? reply(call) : reply) : undefined); },
    reset() { routes = []; calls.length = 0; },
    close: () => new Promise<void>(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
