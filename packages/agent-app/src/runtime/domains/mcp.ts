import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isEnabled, type ExtensionEnablement, type InstalledExtension } from '../../shared/domains/extensions-protocol.ts';
import { MCP_HOOK_EVENTS, MCP_HOOK_LIMITS, type McpHook, type McpHookRun, type McpLogLine, type McpScope, type McpServer, type McpSource, type McpTestResult, type McpTool } from '../../shared/domains/mcp-protocol.ts';
import { BROWSER_MCP } from '../../shared/computer-use.ts';
import { TERMINAL_MCP } from '../terminal-agent-tools.ts';
import type { Chat } from '../../shared/protocol.ts';
import { assignConfigKeys, maskDetectedServer, parseTomlSections, redact, testHttp, testStdio } from '../mcp-client.ts';
import { activeSecretStore } from '../secret-store.ts';
import type { DomainContext, DomainModule } from './types.ts';

type Stored = Omit<McpServer, 'configKey' | 'healthy' | 'loadedBy' | 'auth'> & { auth: { kind: 'none' } | { kind: 'bearer' } | { kind: 'env'; name: string }; tools?: McpTool[] };
type Declared = Omit<McpHook, 'enabled' | 'timeoutSec' | 'maxOutputKb' | 'lastRun'> & { path: string };
interface HookRow { id: string; enabled: number; timeout_sec: number; max_output_kb: number; last_run: string | null }
const SCOPES: readonly McpScope[] = ['user', 'folder', 'project'];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_LOG_LINES = 300;
/** Same sanitising as the extensions domain, so collisions are detected against the keys it emits. */
const pluginKey = (extension: string, server: string) => `${extension}_${server}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
const text = (value: unknown, label: string, max = 4096): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`Enter a valid ${label}.`);
  return value.trim();
};
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const clamp = (value: unknown, limits: { min: number; max: number; default: number }) => typeof value === 'number' && Number.isFinite(value) ? Math.min(limits.max, Math.max(limits.min, Math.round(value))) : limits.default;

/** Tests point this at a fixture home directory. */
export const mcpOptions: { home?: string } = {};
const MAX_DETECTED = 200;
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
/** A server config as read from Codex or Claude, not yet a stored row. */
export interface DetectedMcpInput { name: string; transport: 'stdio' | 'http'; command?: string; args: string[]; env: Record<string, string>; url?: string; enabled: boolean; scope: McpScope; scopeId: string; source: McpSource }
const detectedName = (raw: string, max = 64) => raw.trim().slice(0, max);
const detectedArgs = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 64) : [];
const detectedEnv = (value: unknown) => { const table = record(value) ?? {}; const env: Record<string, string> = {}; for (const [key, raw] of Object.entries(table)) if (ENV_NAME.test(key) && typeof raw === 'string') env[key] = raw.slice(0, 4096); return env; };

/** `[mcp_servers.<name>]` (+ its `[mcp_servers.<name>.env]`) tables from Codex's config.toml. Never throws: a missing or unreadable file is simply no servers. */
export function readCodexMcpServers(configPath: string): DetectedMcpInput[] {
  let raw: string;
  try { raw = readFileSync(configPath, 'utf8'); } catch { return []; }
  const sections = parseTomlSections(raw.slice(0, 4 * 1024 * 1024));
  const out: DetectedMcpInput[] = [];
  for (const [path, table] of sections) {
    const match = /^mcp_servers\.([^.]+)$/.exec(path);
    if (!match) continue;
    const url = typeof table.url === 'string' ? table.url.slice(0, 2048) : undefined;
    const command = typeof table.command === 'string' ? table.command.slice(0, 1024) : undefined;
    if (!url && !command) continue;
    out.push({ name: detectedName(match[1]), transport: url ? 'http' : 'stdio', ...(command ? { command } : {}), args: detectedArgs(table.args), env: detectedEnv(sections.get(`${path}.env`)), ...(url ? { url } : {}), enabled: table.enabled !== false, scope: 'user', scopeId: '', source: 'codex' });
    if (out.length >= MAX_DETECTED) break;
  }
  return out;
}
/** `{"mcpServers": {"<name>": {...}}}`: Claude's `~/.claude.json` (top-level) or a project's `.mcp.json`. Never throws. */
export function readMcpJsonServers(path: string, scope: McpScope, scopeId: string): DetectedMcpInput[] {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch { return []; }
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return []; }
  const table = record(record(data)?.mcpServers);
  if (!table) return [];
  const out: DetectedMcpInput[] = [];
  for (const [name, value] of Object.entries(table).slice(0, MAX_DETECTED)) {
    const row = record(value);
    if (!row || !name.trim()) continue;
    const url = typeof row.url === 'string' ? row.url.slice(0, 2048) : undefined;
    const command = typeof row.command === 'string' ? row.command.slice(0, 1024) : undefined;
    if (!url && !command) continue;
    out.push({ name: detectedName(name), transport: url ? 'http' : 'stdio', ...(command ? { command } : {}), args: detectedArgs(row.args), env: detectedEnv(row.env), ...(url ? { url } : {}), enabled: row.enabled !== false, scope, scopeId, source: 'claude' });
  }
  return out;
}
/** Stable across restarts: the same source/scope/name always upserts the same row instead of duplicating it. */
const detectedId = (input: Pick<DetectedMcpInput, 'source' | 'scope' | 'scopeId' | 'name'>) => `det_${createHash('sha256').update(`${input.source}\0${input.scope}\0${input.scopeId}\0${input.name}`).digest('hex').slice(0, 20)}`;

/** Mcp domain: user-added MCP servers, connection tests and health, revocation, and review-then-enable plugin hooks. */
export function createMcpDomain(ctx: DomainContext): DomainModule {
  const db = ctx.db();
  db.exec(`CREATE TABLE IF NOT EXISTS mcp_servers (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mcp_hooks (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, timeout_sec INTEGER NOT NULL, max_output_kb INTEGER NOT NULL, last_run TEXT)`);
  const logs = new Map<string, McpLogLine[]>();
  const loaded = new Map<string, Set<string>>();
  const testing = new Map<string, Promise<McpTestResult>>();
  const seenChats = new Set<string>();
  const secretId = (id: string) => `mcp-${id}`;
  const token = (id: string) => activeSecretStore()?.get(secretId(id));

  const rows = (): Stored[] => (db.prepare('SELECT data FROM mcp_servers').all() as Array<{ data: string }>).map(row => JSON.parse(row.data) as Stored).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const row = (id: unknown) => { const found = rows().find(entry => entry.id === id); if (!found) throw new Error('That MCP server was removed.'); return found; };
  const write = (entry: Stored) => db.prepare('INSERT INTO mcp_servers (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(entry.id, JSON.stringify(entry));
  const installedRows = (): InstalledExtension[] => { try { return (db.prepare('SELECT data FROM extensions_installed').all() as Array<{ data: string }>).map(entry => JSON.parse(entry.data) as InstalledExtension); } catch { return []; } };
  const rules = (): ExtensionEnablement[] => { try { return (db.prepare('SELECT * FROM extension_enablement').all() as Array<{ extension_id: string; scope: string; scope_id: string; enabled: number }>).map(entry => ({ extensionId: entry.extension_id, scope: entry.scope as McpScope, scopeId: entry.scope_id, enabled: entry.enabled === 1 })); } catch { return []; } };
  /** Keys taken by plugin servers and the built-in browser server; user servers yield to them. */
  const keys = (list = rows()) => assignConfigKeys(list, [BROWSER_MCP, TERMINAL_MCP, ...installedRows().flatMap(entry => entry.manifest?.capabilities.mcpServers.map(server => pluginKey(entry.name, server.name)) ?? [])]);
  const healthy = (entry: Stored) => entry.health.ok !== false;
  const chatOf = (chatId: string) => ctx.store.snapshot().chats.find(chat => chat.id === chatId);
  const loadedBy = (id: string) => [...loaded].filter(([chatId, ids]) => ids.has(id) && ['running', 'stopping'].includes(chatOf(chatId)?.status ?? '')).map(([chatId]) => ({ chatId, title: chatOf(chatId)?.title ?? 'Chat' }));
  const view = (entry: Stored, configKey: string): McpServer => {
    const { tools: _tools, auth, ...rest } = entry;
    const stored = auth.kind !== 'none' && Boolean(activeSecretStore()?.status(secretId(entry.id)).stored);
    // A detected server's command/url/args/env come from Codex or Claude's own config, not something the
    // user typed into Muster: never let its real values (which may be secrets) leave the runtime.
    const shown = rest.source && rest.source !== 'user' ? { ...rest, ...maskDetectedServer(rest) } : rest;
    return { ...shown, auth: auth.kind === 'none' ? auth : auth.kind === 'bearer' ? { kind: 'bearer', stored } : { kind: 'env', name: auth.name, stored }, configKey, healthy: healthy(entry), loadedBy: loadedBy(entry.id) };
  };
  const list = () => { const all = rows(), assigned = keys(all); return all.map(entry => view(entry, assigned.get(entry.id)!)); };
  const one = (id: string) => list().find(entry => entry.id === id)!;
  /**
   * Re-reads Codex's config.toml and Claude's mcpServers config (DEF-MCP-EMPTY), upserting each as a
   * read-only row keyed by a stable id: the config shape (command/url/args/env) always refreshes, but an
   * existing row's `enabled` toggle, health and cached tools survive so the user's own choices are never
   * clobbered by a re-scan. Rows for a source that disappeared (the block was removed from the file) are
   * dropped. Never runs on its own — only `mcp.servers.detect` calls it, so a bare domain construction
   * (every test that doesn't ask for detection) behaves exactly as before this defect fix.
   */
  const syncDetected = () => {
    const home = mcpOptions.home ?? homedir();
    const folders = ctx.store.snapshot().folders.filter(folder => !folder.missing).slice(0, 200);
    const found: DetectedMcpInput[] = [
      ...readCodexMcpServers(join(home, '.codex', 'config.toml')),
      ...readMcpJsonServers(join(home, '.claude.json'), 'user', ''),
      ...folders.flatMap(folder => readMcpJsonServers(join(folder.path, '.mcp.json'), 'folder', folder.id)),
    ];
    const now = new Date().toISOString(), keep = new Set<string>();
    for (const input of found) {
      const id = detectedId(input);
      keep.add(id);
      const prior = rows().find(entry => entry.id === id);
      const changed = !prior || prior.transport !== input.transport || prior.command !== input.command || prior.url !== input.url || JSON.stringify(prior.args) !== JSON.stringify(input.args) || JSON.stringify(prior.env) !== JSON.stringify(input.env);
      write({ id, name: input.name, transport: input.transport, args: input.args, env: input.env, ...(input.command ? { command: input.command } : {}), ...(input.url ? { url: input.url } : {}),
        auth: { kind: 'none' }, scope: input.scope, scopeId: input.scopeId, enabled: prior ? prior.enabled : input.enabled,
        createdAt: prior?.createdAt ?? now, updatedAt: changed ? now : (prior?.updatedAt ?? now),
        health: changed ? { consecutiveFailures: 0 } : (prior?.health ?? { consecutiveFailures: 0 }), ...(!changed && prior?.tools ? { tools: prior.tools } : {}), source: input.source });
    }
    for (const stale of rows().filter(entry => entry.source && entry.source !== 'user' && !keep.has(entry.id))) {
      db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(stale.id);
      logs.delete(stale.id);
    }
  };
  const log = (id: string, stream: McpLogLine['stream'], line: string) => {
    const lines = logs.get(id) ?? [], secret = token(id);
    lines.push({ at: new Date().toISOString(), stream, text: redact(line, secret ? [secret] : []).slice(0, 2000) });
    logs.set(id, lines.slice(-MAX_LOG_LINES));
  };
  const matches = (entry: Stored, chat: Chat) => entry.scope === 'user' || (entry.scope === 'folder' && entry.scopeId === chat.folderId) || (entry.scope === 'project' && entry.scopeId === chat.projectId);
  const launcher = (id: string) => join(ctx.dataDir, 'mcp-launchers', `${id}.sh`);
  /** Run options carry only scalars, so a stdio server with arguments starts through a small exec script. */
  const writeLauncher = async (entry: Stored) => {
    if (entry.transport !== 'stdio' || !entry.args.length) { await fs.rm(launcher(entry.id), { force: true }); return; }
    await fs.mkdir(join(ctx.dataDir, 'mcp-launchers'), { recursive: true });
    await fs.writeFile(launcher(entry.id), `#!/bin/sh\nexec ${[entry.command!, ...entry.args].map(quote).join(' ')} "$@"\n`, { mode: 0o700 });
  };

  const parse = (input: Record<string, unknown>, prior?: Stored): Stored => {
    const merged = { ...prior, ...input } as Record<string, unknown>;
    const name = text(merged.name, 'name', 64);
    const transport = merged.transport === 'http' ? 'http' : merged.transport === 'stdio' ? 'stdio' : null;
    if (!transport) throw new Error('Choose stdio or Streamable HTTP.');
    const scope = SCOPES.includes(merged.scope as McpScope) ? merged.scope as McpScope : 'user';
    const scopeId = scope === 'user' ? '' : text(merged.scopeId, scope, 128);
    if (scope === 'folder' && !ctx.store.folder(scopeId)) throw new Error('That folder was removed.');
    if (scope === 'project' && !ctx.store.project(scopeId)) throw new Error('That project was removed.');
    if (rows().some(entry => entry.id !== prior?.id && entry.name.toLowerCase() === name.toLowerCase())) throw new Error(`A server named “${name}” already exists.`);
    const args = transport === 'stdio' && Array.isArray(merged.args) ? merged.args.slice(0, 64).map(arg => { if (typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0')) throw new Error('Invalid argument.'); return arg; }) : [];
    const env: Record<string, string> = {};
    if (transport === 'stdio') for (const [key, value] of Object.entries((merged.env && typeof merged.env === 'object' ? merged.env : {}) as Record<string, unknown>).slice(0, 32)) {
      if (!ENV_NAME.test(key) || typeof value !== 'string' || value.length > 4096 || value.includes('\0')) throw new Error(`Invalid environment variable ${key}.`);
      env[key] = value;
    }
    let url: string | undefined, command: string | undefined;
    if (transport === 'http') { url = text(merged.url, 'URL', 2048); let parsed: URL; try { parsed = new URL(url); } catch { throw new Error('Enter a valid URL.'); } if (!/^https?:$/.test(parsed.protocol)) throw new Error('Use an http:// or https:// URL.'); }
    else command = text(merged.command, 'command', 1024);
    const authInput = (input.auth ?? prior?.auth ?? { kind: 'none' }) as Record<string, unknown>;
    let auth: Stored['auth'] = { kind: 'none' };
    if (authInput.kind === 'bearer' && transport === 'http') auth = { kind: 'bearer' };
    else if (authInput.kind === 'env' && transport === 'stdio') { if (!ENV_NAME.test(String(authInput.name))) throw new Error('Enter a valid environment variable name for the token.'); auth = { kind: 'env', name: String(authInput.name) }; }
    const now = new Date().toISOString();
    const changed = !prior || prior.transport !== transport || prior.command !== command || prior.url !== url || JSON.stringify(prior.args) !== JSON.stringify(args);
    // A detected server (DEF-MCP-EMPTY) only ever reaches here through the `enabled` toggle or Revoke; its
    // `source` must survive that update so it keeps showing as read-only instead of reverting to a plain user server.
    return { id: prior?.id ?? randomUUID().replace(/-/g, '').slice(0, 12), name, transport, args, env, ...(command ? { command } : {}), ...(url ? { url } : {}), auth, scope, scopeId, enabled: typeof merged.enabled === 'boolean' ? merged.enabled : true, createdAt: prior?.createdAt ?? now, updatedAt: now, health: changed ? { consecutiveFailures: 0 } : prior!.health, ...(!changed && prior?.tools ? { tools: prior.tools } : {}), ...(prior?.source ? { source: prior.source } : {}) };
  };
  const saveToken = (entry: Stored, input: Record<string, unknown>, prior?: Stored) => {
    const auth = input.auth as { token?: unknown } | undefined, store = activeSecretStore();
    if (entry.auth.kind === 'none') { store?.clear(secretId(entry.id)); return; }
    if (typeof auth?.token === 'string' && auth.token.trim()) {
      if (!store) throw new Error('Secure storage is unavailable, so the token was not saved.');
      store.set(secretId(entry.id), auth.token);
      return;
    }
    // Switching auth kind (e.g. bearer -> env) without a fresh token must not carry the old secret into the new use.
    if (prior && prior.auth.kind !== 'none' && prior.auth.kind !== entry.auth.kind) store?.clear(secretId(entry.id));
  };

  const test = (id: string): Promise<McpTestResult> => {
    const inflight = testing.get(id);
    if (inflight) return inflight;
    const work = (async () => {
      const entry = row(id), secret = token(id), sink = (stream: McpLogLine['stream'], line: string) => log(id, stream, line);
      log(id, 'client', `Testing ${entry.transport === 'http' ? entry.url : [entry.command, ...entry.args].join(' ')}`);
      const result = entry.transport === 'http'
        ? await testHttp({ url: entry.url!, ...(entry.auth.kind === 'bearer' && secret ? { headers: { authorization: `Bearer ${secret}` } } : {}), log: sink })
        : await testStdio({ command: entry.command!, args: entry.args, env: { ...entry.env, ...(entry.auth.kind === 'env' && secret ? { [entry.auth.name]: secret } : {}) }, log: sink });
      if (!result.ok && entry.auth.kind !== 'none' && !secret) result.error = `${result.error} No token is stored for this server.`;
      const current = rows().find(item => item.id === id);
      if (current) {
        const info = result.serverInfo ?? current.health.serverInfo, toolCount = result.ok ? result.tools?.length ?? 0 : current.health.toolCount;
        write({ ...current, health: { lastTestAt: new Date().toISOString(), ok: result.ok, stage: result.stage, latencyMs: result.latencyMs, consecutiveFailures: result.ok ? 0 : current.health.consecutiveFailures + 1, ...(result.error ? { error: result.error } : {}), ...(toolCount !== undefined ? { toolCount } : {}), ...(info ? { serverInfo: info } : {}) }, ...(result.ok ? { tools: result.tools ?? [] } : current.tools ? { tools: current.tools } : {}) });
      }
      return result;
    })().finally(() => testing.delete(id));
    testing.set(id, work);
    return work;
  };

  // ---------------------------------------------------------------- plugin hooks (review, then enable)
  const hookRows = () => new Map((db.prepare('SELECT * FROM mcp_hooks').all() as unknown as HookRow[]).map(entry => [entry.id, entry]));
  const declared = new Map<string, Promise<Declared[]>>();
  const readJson = async (path: string) => JSON.parse(await fs.readFile(path, 'utf8')) as Record<string, unknown>;
  const hooksOf = (entry: InstalledExtension): Promise<Declared[]> => {
    const cacheKey = `${entry.id}@${entry.path}`;
    if (!declared.has(cacheKey)) declared.set(cacheKey, (async () => {
      let table: unknown;
      for (const file of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
        const manifest = await readJson(join(entry.path, file)).catch(() => null);
        if (manifest?.hooks && typeof manifest.hooks === 'object') { table = manifest.hooks; break; }
        if (typeof manifest?.hooks === 'string') { table = await readJson(join(entry.path, manifest.hooks)).catch(() => null); break; }
      }
      table ??= await readJson(join(entry.path, 'hooks', 'hooks.json')).catch(() => null);
      const events = ((table as Record<string, unknown> | null)?.hooks ?? table ?? {}) as Record<string, unknown>;
      const output: Declared[] = [];
      for (const [event, groups] of Object.entries(events)) for (const group of Array.isArray(groups) ? groups as Array<Record<string, unknown>> : []) for (const hook of (Array.isArray(group?.hooks) ? group.hooks : [group]) as Array<Record<string, unknown>>) {
        const type = typeof hook?.type === 'string' ? hook.type : 'command', command = typeof hook?.command === 'string' ? hook.command.slice(0, 2000) : typeof hook?.url === 'string' ? hook.url.slice(0, 2000) : '';
        if (!command) continue;
        const matcher = typeof group?.matcher === 'string' && group.matcher ? group.matcher.slice(0, 200) : undefined;
        const supported = type === 'command' && (MCP_HOOK_EVENTS as readonly string[]).includes(event);
        output.push({ id: createHash('sha256').update(`${entry.id}\0${event}\0${matcher ?? ''}\0${type}\0${command}`).digest('hex').slice(0, 16), extensionId: entry.id, extensionName: entry.manifest?.displayName ?? entry.name, event, type, command, path: entry.path, supported, ...(matcher ? { matcher } : {}),
          ...(supported ? {} : { reason: type !== 'command' ? `${type} hooks are not supported.` : `Muster has no ${event} lifecycle point.` }) });
      }
      return output.slice(0, 64);
    })());
    return declared.get(cacheKey)!;
  };
  const hooks = async (): Promise<Array<McpHook & { path: string }>> => {
    const settings = hookRows();
    const all = (await Promise.all(installedRows().filter(entry => entry.kind === 'plugin' && entry.state !== 'Failed' && entry.state !== 'Staging').map(hooksOf))).flat();
    return all.map(hook => { const saved = settings.get(hook.id); return { ...hook, enabled: hook.supported && saved?.enabled === 1, timeoutSec: saved?.timeout_sec ?? MCP_HOOK_LIMITS.timeoutSec.default, maxOutputKb: saved?.max_output_kb ?? MCP_HOOK_LIMITS.maxOutputKb.default, ...(saved?.last_run ? { lastRun: JSON.parse(saved.last_run) as McpHookRun } : {}) }; });
  };
  const publicHooks = async (): Promise<McpHook[]> => (await hooks()).map(({ path: _path, ...hook }) => hook);
  /** Runs one enabled hook under its timeout and output cap; the process group is killed on timeout or abort. */
  const runHook = (hook: McpHook & { path: string }, payload: Record<string, unknown>, signal?: AbortSignal) => new Promise<McpHookRun>(resolve => {
    const started = Date.now(), cap = hook.maxOutputKb * 1024;
    const child = spawn('/bin/sh', ['-c', hook.command], { cwd: hook.path, env: { ...process.env, CLAUDE_PLUGIN_ROOT: hook.path, MUSTER_PLUGIN_ROOT: hook.path }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let output = Buffer.alloc(0), truncated = false, timedOut = false, done = false;
    const kill = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
    const take = (chunk: Buffer) => { if (output.length >= cap) { truncated = true; return; } output = Buffer.concat([output, chunk]); if (output.length > cap) { output = output.subarray(0, cap); truncated = true; } };
    child.stdout.on('data', take); child.stderr.on('data', take);
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(payload));
    const timer = setTimeout(() => { timedOut = true; kill(); }, hook.timeoutSec * 1000);
    const abort = () => { timedOut = true; kill(); };
    signal?.addEventListener('abort', abort, { once: true });
    const finish = (exitCode: number | null) => {
      if (done) return; done = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      const run: McpHookRun = { at: new Date(started).toISOString(), exitCode, durationMs: Date.now() - started, timedOut, truncated, output: redact(output.toString('utf8').replace(/�+$/, '')) };
      db.prepare('UPDATE mcp_hooks SET last_run = ? WHERE id = ?').run(JSON.stringify({ ...run, output: run.output.slice(0, 4096) }), hook.id);
      resolve(run);
    };
    child.once('error', error => { output = Buffer.from(error.message); finish(null); });
    child.once('close', code => finish(code));
  });
  const hooksFor = async (chat: Chat, event: string) => {
    const at = { folderId: chat.folderId, projectId: chat.projectId }, enablement = rules();
    return (await hooks()).filter(hook => hook.enabled && hook.event === event && isEnabled(enablement, hook.extensionId, at));
  };

  // ---------------------------------------------------------------- run seams
  const offOptions = ctx.hooks.addRunOptionsContributor(async (chat: Chat) => {
    const active = rows().filter(entry => entry.enabled && matches(entry, chat));
    if (!active.length) return null;
    const assigned = keys(), configOverrides: Record<string, unknown> = {};
    for (const entry of active) {
      const key = `mcp_servers.${assigned.get(entry.id)}`;
      // An unhealthy server goes to the provider disabled, so it cannot stall startup for the others.
      if (!healthy(entry)) { configOverrides[`${key}.enabled`] = false; continue; }
      const secret = token(entry.id);
      configOverrides[`${key}.startup_timeout_sec`] = 10;
      if (entry.transport === 'http') {
        configOverrides[`${key}.url`] = entry.url;
        if (entry.auth.kind === 'bearer' && secret) configOverrides[`${key}.http_headers.Authorization`] = `Bearer ${secret}`;
      } else {
        configOverrides[`${key}.command`] = entry.args.length ? launcher(entry.id) : entry.command;
        for (const [name, value] of Object.entries(entry.env)) configOverrides[`${key}.env.${name}`] = value;
        if (entry.auth.kind === 'env' && secret) configOverrides[`${key}.env.${entry.auth.name}`] = secret;
      }
    }
    loaded.set(chat.id, new Set(active.filter(healthy).map(entry => entry.id)));
    return { configOverrides };
  });
  const offPrompt = ctx.hooks.addPromptContributor(async ({ chat, prompt, signal }) => {
    const first = !seenChats.has(chat.id);
    seenChats.add(chat.id);
    const selected = [...(first ? await hooksFor(chat, 'SessionStart') : []), ...await hooksFor(chat, 'UserPromptSubmit')];
    if (!selected.length) return null;
    const runs = await Promise.all(selected.map(hook => runHook(hook, { hook_event_name: hook.event, session_id: chat.id, ...(hook.event === 'UserPromptSubmit' ? { prompt } : { source: 'startup' }) }, signal).then(run => ({ hook, run }))));
    const output = runs.filter(({ run }) => run.exitCode === 0 && run.output.trim()).map(({ hook, run }) => `[${hook.extensionName} ${hook.event}]\n${run.output.trim()}`).join('\n\n');
    return output ? { label: 'plugin hooks', text: output } : null;
  });
  const offSettled = ctx.hooks.onRunSettled(async ({ chat }) => {
    loaded.delete(chat.id);
    await Promise.all((await hooksFor(chat, 'Stop')).map(hook => runHook(hook, { hook_event_name: 'Stop', session_id: chat.id })));
  });

  const handlers: DomainModule['handlers'] = {
    'mcp.servers.list': () => list(),
    'mcp.servers.detect': () => { syncDetected(); return list(); },
    'mcp.servers.add': async input => {
      const entry = parse(input);
      saveToken(entry, input);
      write(entry); await writeLauncher(entry);
      log(entry.id, 'client', 'Added.');
      return one(entry.id);
    },
    'mcp.servers.update': async input => {
      const prior = row(input.id);
      const entry = parse(input, prior);
      saveToken(entry, input, prior);
      write(entry); await writeLauncher(entry);
      return one(entry.id);
    },
    'mcp.servers.remove': async input => {
      const entry = row(input.id);
      db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(entry.id);
      activeSecretStore()?.clear(secretId(entry.id));
      logs.delete(entry.id);
      await fs.rm(launcher(entry.id), { force: true });
    },
    'mcp.servers.test': input => test(row(input.id).id),
    'mcp.servers.tools': async input => {
      const entry = row(input.id);
      if (input.refresh === true || !entry.tools) { const result = await test(entry.id); if (!result.ok) throw new Error(`Test failed at ${result.stage}: ${result.error}`); }
      return row(entry.id).tools ?? [];
    },
    'mcp.servers.logs': input => [...(logs.get(row(input.id).id) ?? [])],
    'mcp.revoke': async input => {
      const entry = row(input.id);
      write({ ...entry, enabled: false, updatedAt: new Date().toISOString() });
      log(entry.id, 'client', 'Revoked: new runs no longer load this server.');
      const chats = loadedBy(entry.id), stopped: string[] = [];
      if (input.stopChats === true) for (const chat of chats) { try { await ctx.invoke('chat.stop', { id: chat.chatId }); stopped.push(chat.chatId); } catch { /* already finished */ } }
      return { server: one(entry.id), chats, stopped };
    },
    'mcp.hooks.list': () => publicHooks(),
    'mcp.hooks.set': async input => {
      const hook = (await hooks()).find(entry => entry.id === input.id);
      if (!hook) throw new Error('That hook is no longer declared by an installed plugin.');
      if (input.enabled === true && !hook.supported) throw new Error(hook.reason ?? 'This hook cannot run in Muster.');
      const enabled = typeof input.enabled === 'boolean' ? input.enabled : hook.enabled;
      db.prepare('INSERT INTO mcp_hooks (id, enabled, timeout_sec, max_output_kb, last_run) VALUES (?, ?, ?, ?, NULL) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, timeout_sec = excluded.timeout_sec, max_output_kb = excluded.max_output_kb')
        .run(hook.id, enabled ? 1 : 0, input.timeoutSec === undefined ? hook.timeoutSec : clamp(input.timeoutSec, MCP_HOOK_LIMITS.timeoutSec), input.maxOutputKb === undefined ? hook.maxOutputKb : clamp(input.maxOutputKb, MCP_HOOK_LIMITS.maxOutputKb));
      return publicHooks();
    },
  };
  return { handlers, dispose() { offOptions(); offPrompt(); offSettled(); } };
}
