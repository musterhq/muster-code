/**
 * Authentication for the HTTP calls Muster itself makes to a Codex-configured provider (today: the `/models`
 * listing). Chats on these providers run through the Codex app-server, which authenticates them itself; this
 * module mirrors the same `[model_providers.<id>]` settings so Muster's own requests carry the same credentials:
 *
 *   env_key                         Authorization: Bearer $<env_key>
 *   experimental_bearer_token       Authorization: Bearer <token>
 *   [auth] command/args/cwd/...     Authorization: Bearer <first line the command prints>
 *   http_headers                    static headers
 *   env_http_headers                header -> environment variable name
 *
 * A command token is cached in memory only (never logged, never written), keyed by a hash of the command, and
 * refreshed after `refresh_interval_ms` (default 5 minutes) or after the provider answers 401.
 */
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';

export interface CodexAuthCommand {command: string; args: string[]; timeoutMs?: number; refreshIntervalMs?: number; cwd?: string}
export interface CodexProviderAuth {
  envKey?: string;
  bearerToken?: string;
  authCommand?: CodexAuthCommand;
  httpHeaders?: Record<string, string>;
  envHttpHeaders?: Record<string, string>;
}
export const DEFAULT_TOKEN_REFRESH_MS = 5 * 60_000;
const MAX_TIMEOUT_MS = 30_000;

export type RunCommand = (command: CodexAuthCommand, env: NodeJS.ProcessEnv) => Promise<string>;
/** Runs the helper and returns its first non-empty stdout line. Errors never carry stdout or stderr. */
export const runAuthCommand: RunCommand = (command, env) => new Promise((resolve, reject) => execFile(command.command, command.args,
  {timeout: Math.min(command.timeoutMs ?? 5000, MAX_TIMEOUT_MS), maxBuffer: 64 * 1024, env, encoding: 'utf8', windowsHide: true, ...(command.cwd ? {cwd: command.cwd} : {})},
  (error, stdout) => {
    const token = String(stdout ?? '').split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '';
    if (error) reject(new Error((error as {killed?: boolean}).killed ? 'The provider’s auth command timed out.' : `The provider’s auth command failed${typeof (error as {code?: unknown}).code === 'number' ? ` (exit ${(error as {code: number}).code})` : ''}.`));
    else if (!token || /\s/.test(token)) reject(new Error('The provider’s auth command printed no usable token.'));
    else resolve(token);
  }));

interface Cached {token?: string; at: number; pending?: Promise<string>}
const tokens = new Map<string, Cached>();
const commandKey = (command: CodexAuthCommand) => createHash('sha256').update(JSON.stringify([command.command, command.args, command.cwd ?? ''])).digest('hex');
/** Forgets every cached command token (tests, sign-out). */
export function clearCommandTokens(): void { tokens.clear(); }

/** The command's token, cached for `refreshIntervalMs`. Concurrent callers share one run. */
export async function commandToken(command: CodexAuthCommand, env: NodeJS.ProcessEnv, options: {now?: () => number; run?: RunCommand; force?: boolean} = {}): Promise<string> {
  const now = options.now ?? Date.now, key = commandKey(command), refresh = command.refreshIntervalMs && command.refreshIntervalMs > 0 ? command.refreshIntervalMs : DEFAULT_TOKEN_REFRESH_MS;
  const hit = tokens.get(key);
  if (!options.force && hit?.token && now() - hit.at < refresh) return hit.token;
  if (!options.force && hit?.pending) return hit.pending;
  const pending = (options.run ?? runAuthCommand)(command, env);
  tokens.set(key, {at: hit?.at ?? 0, ...(hit?.token ? {token: hit.token} : {}), pending});
  try {
    const token = await pending;
    if (tokens.size >= 32 && !tokens.has(key)) tokens.delete(tokens.keys().next().value!);
    tokens.set(key, {token, at: now()});
    return token;
  } catch (error) { tokens.delete(key); throw error; }
}

const HEADER = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
/** Request headers for a Codex-configured provider. Throws a secret-free message when a configured credential is missing. */
export async function codexAuthHeaders(auth: CodexProviderAuth, env: NodeJS.ProcessEnv, options: {now?: () => number; run?: RunCommand; force?: boolean} = {}): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(auth.httpHeaders ?? {})) if (HEADER.test(name) && typeof value === 'string' && !/[\r\n]/.test(value)) headers[name.toLowerCase()] = value;
  for (const [name, variable] of Object.entries(auth.envHttpHeaders ?? {})) {
    const value = env[variable];
    if (HEADER.test(name) && value && !/[\r\n]/.test(value)) headers[name.toLowerCase()] = value;
  }
  let token: string | undefined;
  if (auth.envKey) { token = env[auth.envKey]; if (!token) throw new Error(`${auth.envKey} is not set in Muster’s environment.`); }
  else if (auth.bearerToken) token = auth.bearerToken;
  else if (auth.authCommand) token = await commandToken(auth.authCommand, env, options);
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

/** Parses a TOML inline table of string values, `{ "X-Team" = "a", Other = 'b' }`; undefined when it is anything else. */
export function inlineStringTable(raw: string | undefined): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return undefined;
  const out: Record<string, string> = {};
  const pair = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(,|$)/y;
  const body = text.slice(1, -1).trim();
  let at = 0;
  while (at < body.length) {
    pair.lastIndex = at; const match = pair.exec(body); if (!match) return undefined;
    const unescape = (value: string) => { try { return JSON.parse(`"${value}"`) as string; } catch { return value; } };
    const key = match[1] !== undefined ? unescape(match[1]) : match[2] ?? match[3]!;
    out[key] = match[4] !== undefined ? unescape(match[4]) : match[5]!;
    at = pair.lastIndex; if (!match[6]) break;
  }
  return at >= body.length ? out : undefined;
}
