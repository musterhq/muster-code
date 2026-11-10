/**
 * #844: a long-lived MCP client session (stdio or Streamable HTTP) for MCP Apps: Muster's own connection to a server the
 * person added or Muster detected, used to read an app's `ui://` resource and to run the app's tool calls. It announces the
 * MCP Apps extension in `initialize`, so a server that checks for it registers its UI tools.
 */
import {spawn} from 'node:child_process';
import {MCP_PROTOCOL_VERSION, readReply, type Rpc} from './mcp-client.ts';
import {MCP_APP_MIME, MCP_APPS_EXTENSION} from '../shared/mcp-apps.ts';

export interface McpSession {
  request(method: string, params?: unknown): Promise<Record<string, unknown>>;
  close(): void;
  readonly closed: boolean;
}
export type McpSessionTarget =
  | {transport: 'stdio'; command: string; args?: string[]; env?: Record<string, string>}
  | {transport: 'http'; url: string; headers?: Record<string, string>};

const MAX_LINE = 8 * 1024 * 1024;
export const MCP_SESSION_TIMEOUT_MS = 20_000;
const INITIALIZE = {protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {extensions: {[MCP_APPS_EXTENSION]: {mimeTypes: [MCP_APP_MIME]}}}, clientInfo: {name: 'muster', version: '1.0.0'}};
const failure = (reply: Rpc) => new Error(`${reply.error?.message ?? 'The server returned an error'}${typeof reply.error?.code === 'number' ? ` (${reply.error.code})` : ''}`);

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`The server did not answer ${what} within ${Math.round(ms / 1000)}s.`)), ms); timer.unref?.(); })]).finally(() => clearTimeout(timer));
}

function stdioSession(target: Extract<McpSessionTarget, {transport: 'stdio'}>, timeoutMs: number): {session: McpSession; raw(method: string, params?: unknown): Promise<Rpc>; notify(method: string): void} {
  const child = spawn(target.command, target.args ?? [], {env: {...process.env, ...target.env}, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true});
  const pending = new Map<number, {resolve(reply: Rpc): void; reject(error: Error): void}>();
  let nextId = 1, buffer = '', closed = false;
  const failAll = (error: Error) => { for (const entry of pending.values()) entry.reject(error); pending.clear(); };
  child.once('error', error => { closed = true; failAll(new Error(`Could not start ${target.command}: ${error.message}`)); });
  child.once('exit', code => { closed = true; failAll(new Error(`The server exited (code ${code}).`)); });
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE) buffer = '';
    let at: number;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1);
      if (!line) continue;
      let message: Rpc;
      try { message = JSON.parse(line) as Rpc; } catch { continue; }
      const waiter = typeof message.id === 'number' ? pending.get(message.id) : undefined;
      if (waiter) { pending.delete(message.id as number); waiter.resolve(message); }
    }
  });
  const raw = (method: string, params?: unknown) => {
    if (closed) return Promise.reject(new Error('The server connection is closed.'));
    const id = nextId++;
    const reply = new Promise<Rpc>((resolve, reject) => pending.set(id, {resolve, reject}));
    child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id, method, ...(params ? {params} : {})})}\n`);
    return withTimeout(reply, timeoutMs, method).finally(() => pending.delete(id));
  };
  const close = () => {
    if (closed && child.exitCode !== null) return;
    closed = true; failAll(new Error('The server connection is closed.'));
    try { child.stdin.end(); child.kill('SIGTERM'); } catch { /* gone */ }
    setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1000).unref();
  };
  return {raw, notify: method => { if (!closed) child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', method})}\n`); },
    session: {request: async (method, params) => { const reply = await raw(method, params); if (reply.error) throw failure(reply); return reply.result ?? {}; }, close, get closed() { return closed; }}};
}

function httpSession(target: Extract<McpSessionTarget, {transport: 'http'}>, timeoutMs: number): {session: McpSession; raw(method: string, params?: unknown): Promise<Rpc>; notify(method: string): void} {
  if (!/^https?:$/.test(new URL(target.url).protocol)) throw new Error('The server URL must be http or https.');
  let session: string | undefined, protocol: string | undefined, nextId = 1, closed = false;
  const headers = () => ({'content-type': 'application/json', accept: 'application/json, text/event-stream', ...target.headers, ...(session ? {'mcp-session-id': session} : {}), ...(protocol ? {'mcp-protocol-version': protocol} : {})});
  const raw = async (method: string, params?: unknown): Promise<Rpc> => {
    if (closed) throw new Error('The server connection is closed.');
    const id = nextId++;
    const response = await fetch(target.url, {method: 'POST', headers: headers(), body: JSON.stringify({jsonrpc: '2.0', id, method, ...(params ? {params} : {})}), signal: AbortSignal.timeout(timeoutMs)});
    session = response.headers.get('mcp-session-id') ?? session;
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    const reply = await readReply(response, id);
    if (method === 'initialize') protocol = typeof reply.result?.protocolVersion === 'string' ? reply.result.protocolVersion : MCP_PROTOCOL_VERSION;
    return reply;
  };
  const close = () => {
    if (closed) return;
    closed = true;
    if (session) void fetch(target.url, {method: 'DELETE', headers: headers(), signal: AbortSignal.timeout(2000)}).catch(() => {});
  };
  return {raw, notify: method => { if (!closed) void fetch(target.url, {method: 'POST', headers: headers(), body: JSON.stringify({jsonrpc: '2.0', method}), signal: AbortSignal.timeout(timeoutMs)}).then(response => response.body?.cancel()).catch(() => {}); },
    session: {request: async (method, params) => { const reply = await raw(method, params); if (reply.error) throw failure(reply); return reply.result ?? {}; }, close, get closed() { return closed; }}};
}

/** Connects and runs the MCP handshake; the session stays open until `close`. */
export async function openMcpSession(target: McpSessionTarget, timeoutMs = MCP_SESSION_TIMEOUT_MS): Promise<McpSession> {
  const opened = target.transport === 'http' ? httpSession(target, timeoutMs) : stdioSession(target, timeoutMs);
  try {
    const init = await opened.raw('initialize', INITIALIZE);
    if (init.error) throw failure(init);
    opened.notify('notifications/initialized');
    return opened.session;
  } catch (error) { opened.session.close(); throw error; }
}

/** Every tools/list page (bounded), the raw tool objects with their `_meta` and annotations. */
export async function listTools(session: McpSession): Promise<Array<Record<string, unknown>>> {
  const tools: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10 && tools.length < 500; page++) {
    const result = await session.request('tools/list', cursor ? {cursor} : {});
    for (const tool of Array.isArray(result.tools) ? result.tools : []) if (tool && typeof tool === 'object' && typeof (tool as {name?: unknown}).name === 'string') tools.push(tool as Record<string, unknown>);
    cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
    if (!cursor) break;
  }
  return tools.slice(0, 500);
}
