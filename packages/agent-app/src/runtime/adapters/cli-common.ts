import {execFile, spawn as nodeSpawn, type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {cliSpawn, jsonLines, text} from './shared.ts';
import type {AdapterRunInput, AdapterRunResult, RunnableAdapter} from './types.ts';

/**
 * Shared plumbing for the user's own agent CLIs (Cursor, Gemini, Grok). The protocol and flag details follow each
 * CLI's public documentation; the approach to driving them (headless JSON output, ACP over stdio for Grok, a version
 * gate for Grok 1.0.13) was cross-checked against T3 Code (github.com/pingdotgg/t3code, MIT, (c) T3 Tools Inc.).
 * No T3 source is copied; these adapters follow Muster's own RunnableAdapter interface.
 */
export type AgentSpawn = (command: string, args: string[], options: {cwd: string; env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe']; windowsHide?: boolean; detached?: boolean}) => ChildProcess;

/** Variables a CLI needs to run at all. Anything else in Muster's environment (API keys, MUSTER_*, Electron) is left out. */
const BASE_ENV = /^(?:PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z_]+|TERM|COLORTERM|TMPDIR|TEMP|TMP|TZ|SYSTEMROOT|SYSTEMDRIVE|COMSPEC|PATHEXT|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES(?:\(X86\))?|XDG_[A-Z_]+|SSH_AUTH_SOCK|DISPLAY|WAYLAND_DISPLAY|DBUS_SESSION_BUS_ADDRESS|(?:HTTPS?|ALL|NO)_PROXY|(?:https?|all|no)_proxy|SSL_CERT_(?:FILE|DIR)|NODE_EXTRA_CA_CERTS|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE)$/;
const GIT_IDENTITY = /^GIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL)$/;

/**
 * A clean environment for one CLI process: the basics, the CLI's own sign-in variables (the user's, from their shell),
 * and the agent's git identity. Muster's other secrets, including anything lent to a run, never reach these CLIs.
 */
export function cleanAgentEnv(base: NodeJS.ProcessEnv, own: readonly string[], run?: Record<string, string>, binary?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined && (BASE_ENV.test(key) || own.includes(key))) env[key] = value;
  for (const [key, value] of Object.entries(run ?? {})) if (GIT_IDENTITY.test(key)) env[key] = value;
  env.NO_COLOR = '1';
  // A `#!/usr/bin/env node` launcher needs Node on PATH; npm installs it next to the CLI.
  if (binary && /[\\/]/.test(binary)) {
    const dir = binary.replace(/[\\/][^\\/]*$/, '');
    const sep = process.platform === 'win32' ? ';' : ':';
    if (dir && !(env.PATH ?? '').split(sep).includes(dir)) env.PATH = env.PATH ? `${env.PATH}${sep}${dir}` : dir;
  }
  return env;
}

/** Stop a CLI and everything it started: the process group on macOS/Linux, `taskkill /T` on Windows. */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  const pid = child.pid;
  if (pid && process.platform === 'win32') { try { execFile('taskkill', ['/pid', String(pid), '/T', '/F'], {windowsHide: true}, () => {}); } catch { /* fall through */ } }
  else if (pid) { try { process.kill(-pid, signal); return; } catch { /* not a group leader */ } }
  try { child.kill(signal); } catch { /* already gone */ }
}

export const stripAnsi = (value: string) => value.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '');

/** First `1.2.3` in a version banner ("grok 1.0.13", "0.11.3", "2025.09.18-7ae6800"). */
export function parseVersion(output: string): string | undefined { return /\b(\d+(?:\.\d+){1,3})(?:[-+][\w.]+)?\b/.exec(stripAnsi(output))?.[1]; }
/** Negative when a < b. Missing parts are zero. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) { const d = (left[i] ?? 0) - (right[i] ?? 0); if (d) return d; }
  return 0;
}

/** Run a short probe (`--version`, `models`, `status`): stdout+stderr with ANSI removed, plus the exit code. Never throws on a non-zero exit. */
export function probeCli(binary: string, args: string[], options: {spawn?: AgentSpawn; env?: NodeJS.ProcessEnv; timeoutMs?: number; cwd?: string} = {}): Promise<{output: string; code: number | null}> {
  return new Promise((resolve, reject) => {
    const spawn = options.spawn ?? (nodeSpawn as unknown as AgentSpawn), launch = cliSpawn(binary, args, options.env ?? process.env);
    let child: ChildProcess, out = '';
    try { child = spawn(launch.command, launch.args, {cwd: options.cwd ?? process.cwd(), env: launch.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32'}); } catch (error) { reject(error); return; }
    const timer = setTimeout(() => { killTree(child, 'SIGKILL'); reject(new Error(`${binary} ${args.join(' ')} did not answer within ${(options.timeoutMs ?? 8000) / 1000}s.`)); }, options.timeoutMs ?? 8000);
    child.stdin?.on('error', () => {}); child.stdin?.end();
    const take = (chunk: Buffer | string) => { if (out.length < 256 * 1024) out += String(chunk); };
    child.stdout?.on('data', take); child.stderr?.on('data', take);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({output: stripAnsi(out), code}); });
  });
}

/** Everything a protocol handler needs to turn one CLI's events into the shared timeline. */
export interface TurnApi {
  readonly input: AdapterRunInput; readonly turnId: string;
  session(): string | undefined;
  /** First call binds the chat to the CLI's session id. */
  accept(id: string): void;
  delta(text: string): void; reasoning(text: string): void;
  started(item: Record<string, unknown>): void;
  completed(item: Record<string, unknown>): void;
  usage(tokens: {input?: number; output?: number; cached?: number; total?: number}): void;
  /** The CLI's own verdict, from its final `result` event. */
  result(ok: boolean, message: string): void;
  fail(message: string): void;
  answer(): string;
}

export interface CliTurnSpec {
  label: string; binary: string; args: string[]; env: NodeJS.ProcessEnv; spawn?: AgentSpawn; killGraceMs?: number;
  onEvent(event: Record<string, unknown>, api: TurnApi): void;
  /** Called when the process closes, for items still open. */
  onClose?(api: TurnApi): void;
}

const usageTotals = (tokens: {input?: number; output?: number; cached?: number; total?: number}) => {
  const inputTokens = (tokens.input ?? 0), outputTokens = tokens.output ?? 0;
  return {last: {inputTokens, outputTokens, totalTokens: tokens.total ?? inputTokens + outputTokens, ...(tokens.cached ? {cachedInputTokens: tokens.cached} : {})}};
};

/** One headless turn of a JSON-lines CLI: spawn in its own process group, map events, kill the whole tree on cancel. */
export function runJsonLinesTurn(spec: CliTurnSpec, input: AdapterRunInput): Promise<AdapterRunResult> {
  return new Promise<AdapterRunResult>(resolve => {
    const spawn = spec.spawn ?? (nodeSpawn as unknown as AgentSpawn), turnId = randomUUID(), launch = cliSpawn(spec.binary, spec.args, spec.env);
    let child: ChildProcess;
    try { child = spawn(launch.command, launch.args, {cwd: input.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32'}); }
    catch (error) { resolve({status: 'failed', finalMessage: '', dispatchState: 'not-dispatched', errorMessage: `${spec.label} could not start: ${error instanceof Error ? error.message : String(error)}`}); return; }
    let session = input.resumeThreadId, accepted = false, settled = false, failure = '', stderr = '', answer = '', verdict: {ok: boolean; message: string} | undefined, killer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => { killTree(child, 'SIGTERM'); killer = setTimeout(() => killTree(child, 'SIGKILL'), spec.killGraceMs ?? 3000); };
    if (input.signal.aborted) abort(); else input.signal.addEventListener('abort', abort, {once: true});
    const finish = (result: AdapterRunResult) => { if (settled) return; settled = true; clearTimeout(killer); input.signal.removeEventListener('abort', abort); resolve(result); };
    const api: TurnApi = {
      input, turnId, session: () => session,
      accept(id) { if (accepted || !id) return; accepted = true; session = id; input.onThreadReady(id); input.onTurnAccepted({threadId: id, turnId}); },
      delta(chunk) { if (!chunk) return; answer += chunk; input.onDelta(chunk); },
      reasoning(chunk) { if (chunk) input.onReasoning(chunk); },
      started(item) { input.onEvent('item/started', {threadId: session ?? '', turnId, item: {...item, status: undefined, aggregatedOutput: undefined}}); },
      completed(item) { input.onEvent('item/completed', {threadId: session ?? '', turnId, item}); },
      usage(tokens) { if (tokens.input === undefined && tokens.output === undefined && tokens.total === undefined) return; input.onEvent('thread/tokenUsage/updated', {threadId: session ?? '', turnId, tokenUsage: usageTotals(tokens)}); },
      result(ok, message) { verdict = {ok, message}; },
      fail(message) { failure = message; },
      answer: () => answer,
    };
    child.stderr?.setEncoding('utf8'); child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
    jsonLines(child.stdout!, event => { try { spec.onEvent(event, api); } catch { /* a malformed event must not end the turn */ } });
    child.on('error', error => finish({status: 'failed', finalMessage: '', dispatchState: accepted ? 'dispatched' : 'not-dispatched', errorMessage: `${spec.label} could not start: ${error.message}`}));
    child.on('close', code => {
      spec.onClose?.(api);
      const identity = accepted ? {threadId: session!, turnId} : {};
      if (input.signal.aborted) return finish({status: 'failed', finalMessage: '', dispatchState: accepted ? 'dispatched' : 'not-dispatched', ...identity, errorMessage: 'Stopped.'});
      if (code === 0 && !failure && (verdict?.ok ?? true)) return finish({status: 'completed', finalMessage: verdict?.message || answer, dispatchState: 'dispatched', ...identity});
      const reason = failure || (verdict && !verdict.ok ? verdict.message : '') || stderr.trim().split('\n').slice(-3).join(' ') || `${spec.label} exited with code ${code}.`;
      finish({status: 'failed', finalMessage: '', dispatchState: accepted ? 'dispatched' : 'not-dispatched', ...identity, errorMessage: stripAnsi(reason).replace(/[\x00-\x1f]+/g, ' ').slice(0, 400)});
    });
    child.stdin?.on('error', () => {}); child.stdin?.end();
  });
}

export const jsonRunnable = (build: (input: AdapterRunInput) => CliTurnSpec): RunnableAdapter => ({kind: 'cli', run: input => runJsonLinesTurn(build(input), input)});
export const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
export const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export {text};
