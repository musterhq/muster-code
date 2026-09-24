/** Minimal MCP client for connection tests: stdio (newline-delimited JSON-RPC) and Streamable HTTP. It runs initialize and tools/list, then disconnects. */
import { spawn } from 'node:child_process';
import type { McpLogLine, McpServerInfo, McpStage, McpTestResult, McpTool } from '../shared/domains/mcp-protocol.ts';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_TEST_TIMEOUT_MS = 10_000;
const MAX_TOOLS = 500, MAX_PAGES = 10, MAX_LINE = 4 * 1024 * 1024;
type Log = (stream: McpLogLine['stream'], text: string) => void;
type Rpc = { id?: number | string; result?: Record<string, unknown>; error?: { code?: number; message?: string } };
const CLIENT = { name: 'muster', version: '1.0.0' };
const initializeParams = { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT };

class StageError extends Error { constructor(readonly stage: McpStage, message: string) { super(message); } }
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const rpcError = (reply: Rpc) => reply.error ? `${reply.error.message ?? 'Error'}${typeof reply.error.code === 'number' ? ` (${reply.error.code})` : ''}` : undefined;

function serverInfo(result: Record<string, unknown> | undefined): McpServerInfo | undefined {
  const info = record(result?.serverInfo);
  if (!info && typeof result?.protocolVersion !== 'string') return undefined;
  return { name: typeof info?.name === 'string' ? info.name.slice(0, 200) : 'unknown', ...(typeof info?.version === 'string' ? { version: info.version.slice(0, 64) } : {}), ...(typeof result?.protocolVersion === 'string' ? { protocolVersion: result.protocolVersion.slice(0, 32) } : {}) };
}
export function normalizeTools(value: unknown): McpTool[] {
  return (Array.isArray(value) ? value : []).flatMap(entry => {
    const tool = record(entry);
    if (!tool || typeof tool.name !== 'string' || !tool.name) return [];
    return [{ name: tool.name.slice(0, 200), ...(typeof tool.title === 'string' ? { title: tool.title.slice(0, 200) } : {}), ...(typeof tool.description === 'string' ? { description: tool.description.slice(0, 4000) } : {}), inputSchema: record(tool.inputSchema) ?? { type: 'object' } }];
  });
}

/** Shared handshake: initialize, notifications/initialized, then every tools/list page. */
async function handshake(request: (method: string, params?: unknown) => Promise<Rpc>, notify: (method: string) => Promise<void>, started: number): Promise<McpTestResult> {
  const init = await request('initialize', initializeParams).catch(error => { throw error instanceof StageError ? error : new StageError('initialize', String(error instanceof Error ? error.message : error)); });
  if (rpcError(init)) throw new StageError('initialize', rpcError(init)!);
  const info = serverInfo(init.result);
  await notify('notifications/initialized');
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES && tools.length < MAX_TOOLS; page++) {
    const reply = await request('tools/list', cursor ? { cursor } : {}).catch(error => { throw error instanceof StageError ? error : new StageError('tools', String(error instanceof Error ? error.message : error)); });
    if (rpcError(reply)) throw new StageError('tools', rpcError(reply)!);
    tools.push(...normalizeTools(reply.result?.tools));
    cursor = typeof reply.result?.nextCursor === 'string' && reply.result.nextCursor ? reply.result.nextCursor : undefined;
    if (!cursor) break;
  }
  return { stage: 'tools', ok: true, tools: tools.slice(0, MAX_TOOLS), latencyMs: Date.now() - started, ...(info ? { serverInfo: info } : {}) };
}
const failed = (error: unknown, fallback: McpStage, started: number): McpTestResult =>
  ({ stage: error instanceof StageError ? error.stage : fallback, ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 2000), latencyMs: Date.now() - started });

export interface StdioTarget { command: string; args?: string[]; env?: Record<string, string>; cwd?: string; timeoutMs?: number; log?: Log }
/** Spawns the server, runs the handshake, and always kills the process afterwards. */
export async function testStdio(target: StdioTarget): Promise<McpTestResult> {
  const started = Date.now(), timeoutMs = target.timeoutMs ?? MCP_TEST_TIMEOUT_MS, log: Log = target.log ?? (() => {});
  let stage: McpStage = 'spawn', stderr = '';
  const child = spawn(target.command, target.args ?? [], { env: { ...process.env, ...target.env }, stdio: ['pipe', 'pipe', 'pipe'], ...(target.cwd ? { cwd: target.cwd } : {}), windowsHide: true });
  const pending = new Map<number, { resolve(reply: Rpc): void; reject(error: Error): void }>();
  let nextId = 1, buffer = '', settled = false;
  const failAll = (error: Error) => { for (const entry of pending.values()) entry.reject(error); pending.clear(); };
  const spawned = new Promise<void>((resolve, reject) => {
    child.once('spawn', () => { stage = 'initialize'; resolve(); });
    child.once('error', error => { const failure = new StageError(stage, stage === 'spawn' ? `Could not start ${target.command}: ${error.message}` : error.message); reject(failure); failAll(failure); });
  });
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE) { buffer = ''; log('client', 'Dropped an oversized stdout line.'); }
    let at: number;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1);
      if (!line) continue;
      let message: Rpc | undefined;
      try { message = JSON.parse(line) as Rpc; } catch { log('stdout', line.slice(0, 2000)); continue; }
      const waiter = typeof message.id === 'number' ? pending.get(message.id) : undefined;
      if (waiter) { pending.delete(message.id as number); waiter.resolve(message); }
    }
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); for (const line of chunk.split('\n')) if (line.trim()) log('stderr', line.slice(0, 2000)); });
  child.stdin.on('error', () => {});
  child.once('exit', (code, signal) => { if (!settled) failAll(new StageError(stage, `The server exited (${signal ?? `code ${code}`}) during ${stage}.${stderr.trim() ? ` ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`)); });
  const request = (method: string, params?: unknown) => new Promise<Rpc>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    if (method === 'tools/list') stage = 'tools';
    log('client', `→ ${method}`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
  });
  const notify = async (method: string) => { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`); };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new StageError(stage, `Timed out after ${Math.round(timeoutMs / 1000)}s during ${stage}.`)), timeoutMs); });
  try {
    const result = await Promise.race([spawned.then(() => handshake(request, notify, started)), timeout]);
    log('client', `Connected; ${result.tools?.length ?? 0} tools.`);
    return result;
  } catch (error) {
    const result = failed(error, stage, started);
    log('client', `Failed at ${result.stage}: ${result.error}`);
    return result;
  } finally {
    settled = true; clearTimeout(timer);
    child.stdin.end(); child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1000).unref();
  }
}

/** Finds the JSON-RPC reply with `id` in a JSON or SSE body, reading an SSE stream only until it arrives. */
async function readReply(response: Response, id: number): Promise<Rpc> {
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('text/event-stream')) return await response.json() as Rpc;
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let at: number;
      while ((at = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const event = buffer.slice(0, at); buffer = buffer.slice(at).replace(/^\r?\n\r?\n/, '');
        const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        try { const message = JSON.parse(data) as Rpc; if (message.id === id) return message; } catch { /* keep reading */ }
      }
      if (done) throw new Error('The stream ended without a reply.');
      if (buffer.length > MAX_LINE) throw new Error('The reply was too large.');
    }
  } finally { void reader.cancel().catch(() => {}); }
}

export interface HttpTarget { url: string; headers?: Record<string, string>; timeoutMs?: number; log?: Log }
/** Streamable HTTP: POSTs each message, keeps the Mcp-Session-Id, and ends the session afterwards. */
export async function testHttp(target: HttpTarget): Promise<McpTestResult> {
  const started = Date.now(), timeoutMs = target.timeoutMs ?? MCP_TEST_TIMEOUT_MS, log: Log = target.log ?? (() => {});
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let stage: McpStage = 'spawn', session: string | undefined, protocol: string | undefined, nextId = 1;
  const headers = () => ({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...target.headers, ...(session ? { 'mcp-session-id': session } : {}), ...(protocol ? { 'mcp-protocol-version': protocol } : {}) });
  const send = async (body: Record<string, unknown>) => {
    let response: Response;
    try { response = await fetch(target.url, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: controller.signal }); }
    catch (error) {
      if (controller.signal.aborted) throw new StageError(stage, `Timed out after ${Math.round(timeoutMs / 1000)}s during ${stage}.`);
      throw new StageError(stage === 'spawn' ? 'spawn' : stage, `Could not connect to ${new URL(target.url).host}: ${error instanceof Error ? (record(error.cause)?.code as string | undefined) ?? error.message : String(error)}`);
    }
    if (stage === 'spawn') stage = 'initialize';
    session = response.headers.get('mcp-session-id') ?? session;
    return response;
  };
  const request = async (method: string, params?: unknown): Promise<Rpc> => {
    if (method === 'tools/list') stage = 'tools';
    const id = nextId++;
    log('client', `→ ${method}`);
    const response = await send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    if (response.status === 401 || response.status === 403) throw new StageError(stage, `The server refused the credentials (HTTP ${response.status}). Check the token.`);
    if (!response.ok) throw new StageError(stage, `HTTP ${response.status} ${response.statusText}`.trim());
    try {
      const reply = await readReply(response, id);
      if (method === 'initialize') protocol = typeof reply.result?.protocolVersion === 'string' ? reply.result.protocolVersion : MCP_PROTOCOL_VERSION;
      return reply;
    } catch (error) {
      if (controller.signal.aborted) throw new StageError(stage, `Timed out after ${Math.round(timeoutMs / 1000)}s during ${stage}.`);
      throw new StageError(stage, `Invalid reply: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const notify = async (method: string) => { const response = await send({ jsonrpc: '2.0', method }); void response.body?.cancel().catch(() => {}); };
  try {
    if (!/^https?:$/.test(new URL(target.url).protocol)) throw new StageError('spawn', 'Use an http:// or https:// URL.');
    const result = await handshake(request, notify, started);
    log('client', `Connected; ${result.tools?.length ?? 0} tools.`);
    return result;
  } catch (error) {
    const result = failed(error instanceof TypeError && stage === 'spawn' ? new StageError('spawn', 'Enter a valid URL.') : error, stage, started);
    log('client', `Failed at ${result.stage}: ${result.error}`);
    return result;
  } finally {
    clearTimeout(timer);
    if (session) void fetch(target.url, { method: 'DELETE', headers: headers(), signal: AbortSignal.timeout(2000) }).catch(() => {});
  }
}

/** Removes known secrets and common token shapes before a line is kept. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let output = text;
  for (const secret of secrets) if (secret && secret.length >= 4) output = output.split(secret).join('••••');
  return output.replace(/(bearer\s+)[^\s"']+/gi, '$1••••').replace(/\b(sk|ghp|gho|xox[abp]|github_pat)[-_][A-Za-z0-9_-]{8,}/g, '••••').replace(/((?:token|secret|password|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1••••');
}

/** Provider-safe `mcp_servers.<key>`; a user server whose key collides with a plugin (or another user) server gets a `user_` prefix and then a numeric suffix. */
export function assignConfigKeys(servers: ReadonlyArray<{ id: string; name: string }>, taken: Iterable<string>): Map<string, string> {
  const used = new Set(taken), keys = new Map<string, string>();
  for (const server of servers) {
    const base = server.name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 56) || 'server';
    let key = used.has(base) ? `user_${base}` : base;
    for (let n = 2; used.has(key); n++) key = `user_${base}_${n}`;
    used.add(key); keys.set(server.id, key);
  }
  return keys;
}

/**
 * Minimal TOML reader for Codex's config.toml: dotted `[section.path]` headers and `key = value` assignments
 * (a quoted string, `true`/`false`, a number, or a single-line array of these). Multi-line values, inline tables,
 * dates and array-of-table headers (`[[...]]`) are outside this subset and are simply not recognised — safe to
 * skip since detection only ever looks at the handful of scalar `mcp_servers.*` keys it knows about.
 */
export function parseTomlSections(text: string): Map<string, Record<string, unknown>> {
  const sections = new Map<string, Record<string, unknown>>();
  let current: Record<string, unknown> | null = null;
  for (const raw of text.split(/\r?\n/).slice(0, 20_000)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[([^[\]]+)\]$/.exec(line);
    if (header) {
      const path = header[1].trim();
      if (!path) { current = null; continue; }
      if (!sections.has(path)) sections.set(path, {});
      current = sections.get(path)!;
      continue;
    }
    if (!current) continue;
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (kv) current[kv[1]] = tomlValue(kv[2]);
  }
  return sections;
}
function tomlValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) { try { return JSON.parse(raw); } catch { return raw.slice(1, -1); } }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  if (raw.startsWith('[') && raw.endsWith(']')) { const inner = raw.slice(1, -1).trim(); return inner ? inner.split(',').map(item => tomlValue(item.trim())) : []; }
  return raw;
}

/** Masks a detected server's env values (never the real value, even the key survives for context) and any secret-shaped text in its command, url or args, before it leaves the runtime. */
export function maskDetectedServer<T extends { command?: string; url?: string; args: string[]; env: Record<string, string> }>(entry: T): T {
  return { ...entry, ...(entry.command ? { command: redact(entry.command) } : {}), ...(entry.url ? { url: redact(entry.url) } : {}),
    args: entry.args.map(arg => redact(arg)), env: Object.fromEntries(Object.keys(entry.env).map(key => [key, '••••'])) };
}
