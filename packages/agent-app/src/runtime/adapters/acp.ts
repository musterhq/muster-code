import {spawn as nodeSpawn, type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {isAbsolute} from 'node:path';
import {spawnOwned} from '../owned-process.ts';
import {permissionResult} from '../permission-result.ts';
import {cleanAgentEnv, killTree, num, obj, stripAnsi, type AgentSpawn} from './cli-common.ts';
import {cliSpawn, findBinary, jsonLines, loadImages, text} from './shared.ts';
import {acpMcpServers} from './grok-cli.ts';
import {readLimited, resolvePath, writeConfined} from './http-tools.ts';
import type {AdapterRunInput, AdapterRunResult, RunnableAdapter} from './types.ts';
import {BROWSER_MCP, BROWSER_TOOLS, NO_BROWSER_NOTE, browserNote} from '../../shared/computer-use.ts';
import {SANDBOX_TOOLS} from '../../shared/sandbox-routes.ts';

/**
 * #160: any agent that speaks the Agent Client Protocol (agentclientprotocol.com, protocol version 1) as a Muster route.
 * A small hand-written JSON-RPC 2.0 client over the agent's stdio; no SDK. One process per turn: `initialize`, then
 * `session/resume` or `session/load` for a saved conversation (when advertised) or `session/new`, then `session/prompt`.
 * Muster answers the agent's `session/request_permission` through its approval flow and serves `fs/read_text_file` and
 * `fs/write_text_file` inside the chat folder. Terminals are not offered: agents run their own commands after asking.
 */
export const ACP_PROTOCOL_VERSION = 1;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export interface AcpAgentSpec {
  /** Provider id (`acp_…`); model ids are `<id>/<agent model id>`. */
  id: string; name: string;
  command: string; args: string[];
  /** Variables the person set for this agent in Settings. */
  env?: Record<string, string>;
  /** Sign-in variables passed from Muster's environment when set (the preset's list). */
  envNames?: string[];
  /** Shown when the command is missing. */
  installHint?: string;
}

export class AcpRpcError extends Error { constructor(message: string, readonly code: number, readonly data?: unknown) { super(message); } }
/** ACP's `auth_required` error code. */
const AUTH_REQUIRED = -32000;

/** Finds the command (bare names on PATH and the usual install folders), or explains why it cannot run. */
export function resolveAcpCommand(agent: Pick<AcpAgentSpec, 'command' | 'name' | 'installHint'>, env: NodeJS.ProcessEnv, home = homedir()): {binary: string} | {problem: string} {
  const command = agent.command.trim();
  const hint = agent.installHint ? ` ${agent.installHint}` : ' Install it, or enter the full path to its command.';
  if (!command) return {problem: `Enter the command that starts ${agent.name}.`};
  if (isAbsolute(command) || /[\\/]/.test(command)) return existsSync(command) ? {binary: command} : {problem: `${command} does not exist.${hint}`};
  const found = findBinary(command, env, home);
  return found ? {binary: found} : {problem: `\`${command}\` was not found on this computer.${hint}`};
}

/** The environment one ACP agent runs with: basics, its sign-in variables, the run's git identity, and what the person set. */
export const acpEnv = (agent: AcpAgentSpec, base: NodeJS.ProcessEnv, binary: string, run?: Record<string, string>): NodeJS.ProcessEnv =>
  ({...cleanAgentEnv(base, agent.envNames ?? [], run, binary), ...(agent.env ?? {})});

/** One JSON-RPC connection to an agent process. Requests from the agent go to `onRequest`; notifications to `onNotification`. */
export class AcpConnection {
  readonly child: ChildProcess;
  readonly closed: Promise<number | null>;
  stderr = '';
  private nextId = 1; private done = false; private startError?: Error;
  private pending = new Map<number, {resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout>}>();
  onRequest?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  onNotification?: (method: string, params: Record<string, unknown>) => void;
  constructor(binary: string, args: string[], options: {cwd: string; env: NodeJS.ProcessEnv; spawn?: AgentSpawn; label: string}) {
    const launch = cliSpawn(binary, args, options.env);
    this.child = spawnOwned(launch.command, launch.args, {cwd: options.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe']}, options.spawn ?? (nodeSpawn as unknown as AgentSpawn));
    this.closed = new Promise(resolve => {
      this.child.on('error', error => { this.startError = error; this.fail(new Error(`${options.label} could not start: ${error.message}`)); resolve(null); });
      this.child.on('close', code => { this.fail(new Error(this.exitReason(options.label, code))); resolve(code); });
    });
    this.child.stdin?.on('error', () => {});
    this.child.stderr?.setEncoding('utf8'); this.child.stderr?.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-4096); });
    jsonLines(this.child.stdout!, message => this.receive(message));
  }
  get running(): boolean { return !this.done; }
  get failedToStart(): Error | undefined { return this.startError; }
  /** The last lines the agent wrote to stderr, cleaned for a one-line message. */
  stderrTail(): string { return stripAnsi(this.stderr).trim().split('\n').slice(-3).join(' ').replace(/[\x00-\x1f]+/g, ' ').slice(0, 300); }
  private exitReason(label: string, code: number | null): string { const tail = this.stderrTail(); return `${label} exited${code === null ? '' : ` with code ${code}`}${tail ? `: ${tail}` : '.'}`; }
  private fail(error: Error) { this.done = true; for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); } this.pending.clear(); }
  private write(message: Record<string, unknown>) { if (this.done) return; try { this.child.stdin?.write(`${JSON.stringify({jsonrpc: '2.0', ...message})}\n`); } catch { /* closed */ } }
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
    if (this.done) return Promise.reject(new Error('The agent is no longer running.'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = timeoutMs ? setTimeout(() => { this.pending.delete(id); reject(new AcpRpcError(`${method} got no answer within ${Math.round(timeoutMs / 1000)}s.`, -32603)); }, timeoutMs) : undefined;
      this.pending.set(id, {resolve, reject, timer});
      this.write({id, method, params});
    });
  }
  notify(method: string, params: Record<string, unknown>) { this.write({method, params}); }
  private receive(message: Record<string, unknown>) {
    const id = message.id, method = text(message.method);
    if (method && id !== undefined && id !== null) {
      const params = obj(message.params);
      void Promise.resolve().then(() => this.onRequest ? this.onRequest(method, params) : Promise.reject(new AcpRpcError(`${method} is not supported by Muster.`, -32601)))
        .then(result => this.write({id, result: result ?? null}), (error: unknown) => this.write({id, error: {code: error instanceof AcpRpcError ? error.code : -32603, message: error instanceof Error ? error.message : String(error)}}));
      return;
    }
    if (method) { try { this.onNotification?.(method, obj(message.params)); } catch { /* a malformed update must not end the turn */ } return; }
    if (typeof id !== 'number') return;
    const entry = this.pending.get(id); if (!entry) return;
    this.pending.delete(id); clearTimeout(entry.timer);
    if (message.error) { const error = obj(message.error); entry.reject(new AcpRpcError(text(error.message) || 'The agent returned an error.', num(error.code) ?? -32603, error.data)); }
    else entry.resolve(obj(message.result));
  }
  /** Ends stdin (ACP agents exit on EOF), then the whole process group after `graceMs`. */
  async close(graceMs = 3000): Promise<void> {
    try { this.child.stdin?.end(); } catch { /* closed */ }
    if (this.child.exitCode !== null || this.child.signalCode !== null || this.startError) { killTree(this.child, 'SIGKILL'); await this.closed; return; }
    let term: ReturnType<typeof setTimeout> | undefined, kill: ReturnType<typeof setTimeout> | undefined;
    term = setTimeout(() => { killTree(this.child, 'SIGTERM'); kill = setTimeout(() => killTree(this.child, 'SIGKILL'), graceMs); }, graceMs);
    await this.closed;
    clearTimeout(term); clearTimeout(kill);
    // A tool command the agent started may still hold the group: it must not outlive the turn.
    killTree(this.child, 'SIGKILL');
  }
}

/** What an agent reports about a session: its models (configOptions category "model", or the older `models` field) and modes. */
export interface AcpCatalog {
  models: Array<{id: string; name: string}>; currentModel?: string;
  /** How a model is chosen: `session/set_config_option` with this config id, or the older `session/set_model`. */
  modelSetter?: {kind: 'config'; configId: string} | {kind: 'legacy'};
  modes: Array<{id: string; name: string}>; currentMode?: string;
}
export function acpCatalog(result: Record<string, unknown>): AcpCatalog {
  const catalog: AcpCatalog = {models: [], modes: []};
  const config = (Array.isArray(result.configOptions) ? result.configOptions : []).map(obj).find(option => option.category === 'model' && option.type === 'select');
  if (config) {
    const flat = (Array.isArray(config.options) ? config.options : []).flatMap(entry => Array.isArray(obj(entry).options) ? obj(entry).options as unknown[] : [entry]).map(obj);
    catalog.models = flat.map(option => ({id: text(option.value), name: text(option.name) || text(option.value)})).filter(model => model.id);
    catalog.currentModel = text(config.currentValue) || undefined; catalog.modelSetter = {kind: 'config', configId: text(config.id)};
  } else {
    const legacy = obj(result.models);
    catalog.models = (Array.isArray(legacy.availableModels) ? legacy.availableModels : []).map(obj).map(model => ({id: text(model.modelId), name: text(model.name) || text(model.modelId)})).filter(model => model.id);
    if (catalog.models.length) { catalog.currentModel = text(legacy.currentModelId) || undefined; catalog.modelSetter = {kind: 'legacy'}; }
  }
  const modes = obj(result.modes);
  catalog.modes = (Array.isArray(modes.availableModes) ? modes.availableModes : []).map(obj).map(mode => ({id: text(mode.id), name: text(mode.name) || text(mode.id)})).filter(mode => mode.id);
  catalog.currentMode = text(modes.currentModeId) || undefined;
  catalog.models = catalog.models.slice(0, 200); catalog.modes = catalog.modes.slice(0, 50);
  return catalog;
}
/** Provider model rows: the agent's current model first; one default entry when it reports none. */
export function acpModelRows(agent: Pick<AcpAgentSpec, 'id' | 'name'>, catalog: Pick<AcpCatalog, 'models' | 'currentModel'> | undefined): Array<{id: string; name: string}> {
  const models = catalog?.models ?? [];
  if (!models.length) return [{id: `${agent.id}/default`, name: `${agent.name} default`}];
  const current = models.find(model => model.id === catalog?.currentModel);
  return [...(current ? [current] : []), ...models.filter(model => model !== current)].map(model => ({id: `${agent.id}/${model.id}`, name: model.name}));
}

/** A unified hunk for an ACP diff (`oldText` null for a new file): the changed lines with up to three lines of context. */
export function acpUnifiedDiff(oldText: string | null | undefined, newText: string): string {
  const split = (value: string) => { const lines = value.split('\n'); if (lines.length > 1 && lines.at(-1) === '') lines.pop(); return value ? lines : []; };
  const a = oldText == null ? [] : split(oldText), b = split(newText);
  if (oldText == null) return [`@@ -0,0 +1,${b.length} @@`, ...b.map(line => `+${line}`)].join('\n');
  let start = 0; while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0; while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  if (start === a.length && start === b.length) return '';
  const before = Math.min(3, start), after = Math.min(3, end);
  const from = start - before, removed = a.slice(start, a.length - end), added = b.slice(start, b.length - end), tail = a.slice(a.length - end, a.length - end + after);
  const oldCount = before + removed.length + after, newCount = before + added.length + after;
  return [`@@ -${oldCount ? from + 1 : from},${oldCount} +${newCount ? from + 1 : from},${newCount} @@`, ...a.slice(from, start).map(line => ` ${line}`), ...removed.map(line => `-${line}`), ...added.map(line => `+${line}`), ...tail.map(line => ` ${line}`)].join('\n');
}

const contentText = (content: unknown): string => (Array.isArray(content) ? content : []).map(obj).map(entry => entry.type === 'content' ? text(obj(entry.content).text) : text(entry.text)).filter(Boolean).join('\n').slice(0, 256 * 1024);
const diffs = (content: unknown) => (Array.isArray(content) ? content : []).map(obj).filter(entry => entry.type === 'diff' && text(entry.path));

/** One ACP tool call as a Codex timeline item. Diffs in its content become a fileChange with real hunks. */
export function acpToolItem(call: Record<string, unknown>, cwd: string): Record<string, unknown> {
  const id = text(call.toolCallId), kind = text(call.kind), title = text(call.title), raw = obj(call.rawInput), first = obj(Array.isArray(call.locations) ? call.locations[0] : undefined);
  const path = text(first.path) || text(raw.path) || text(raw.file_path) || text(raw.filePath) || text(raw.abs_path);
  const changed = diffs(call.content);
  if (changed.length) return {id, type: 'fileChange', title, changes: changed.slice(0, 64).map(entry => ({path: text(entry.path), kind: entry.oldText == null ? 'add' : 'update', diff: acpUnifiedDiff(entry.oldText as string | null, text(entry.newText))}))};
  switch (kind) {
    case 'read': return {id, type: 'fileRead', path, name: path || title};
    case 'edit': case 'delete': case 'move': return {id, type: 'fileChange', title, changes: [{path: path || title, kind: kind === 'delete' ? 'delete' : 'update', diff: ''}]};
    case 'execute': return {id, type: 'commandExecution', command: text(raw.command) || (Array.isArray(raw.command) ? (raw.command as unknown[]).map(String).join(' ') : '') || title, cwd};
    case 'search': return {id, type: 'commandExecution', command: title || 'search', cwd, commandActions: [{type: 'search', query: text(raw.pattern) || text(raw.query) || title, path}]};
    case 'fetch': return {id, type: 'webSearch', query: text(raw.url) || text(raw.query) || title};
    default: {
      const browser = /\b(browser_[a-z_]+)\b/.exec(title)?.[1];
      if (browser && (BROWSER_TOOLS as readonly string[]).includes(browser)) return {id, type: 'mcpToolCall', server: BROWSER_MCP, tool: browser, arguments: raw};
      return {id, type: 'dynamicToolCall', tool: title || kind || 'tool', name: title || kind || 'tool', arguments: raw};
    }
  }
}

const SANDBOX_TOOL_TITLE = new RegExp(`\\b(?:${SANDBOX_TOOLS.join('|')})\\b`);
const READ_KINDS = new Set(['read', 'search', 'think']);
/** The approval Muster asks for an ACP tool call: a command, a file change or another tool. */
export function acpApprovalAsk(call: Record<string, unknown>, cwd: string, agentName: string): [string, Record<string, unknown>] {
  const item = acpToolItem(call, cwd), itemId = text(call.toolCallId);
  if (item.type === 'commandExecution' && text(call.kind) === 'execute') return ['item/commandExecution/requestApproval', {command: item.command, cwd, itemId}];
  if (item.type === 'fileChange') return ['item/fileChange/requestApproval', {changes: item.changes, itemId}];
  return ['item/mcpToolCall/requestApproval', {server: agentName, tool: text(call.title) || text(call.kind) || 'tool', arguments: obj(call.rawInput), itemId}];
}
const pickOption = (options: Array<{optionId: string; kind: string}>, allow: boolean): string | undefined => {
  for (const kind of allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always']) { const hit = options.find(option => option.kind === kind); if (hit) return hit.optionId; }
  return undefined;
};

const sentence = (message: string) => message.replace(/[\x00-\x1f]+/g, ' ').trim().slice(0, 400);
/** Plain words for a handshake that failed: not ACP, too old, or a sign-in the agent needs first. */
function handshakeProblem(agent: AcpAgentSpec, error: unknown, connection: AcpConnection): string {
  if (connection.failedToStart) return `${agent.name} could not start: ${connection.failedToStart.message}`;
  if (error instanceof AcpRpcError && error.code === AUTH_REQUIRED) return `${agent.name} needs you to sign in first. Run \`${[agent.command, ...agent.args].join(' ')}\`'s own sign-in (or its CLI) in Terminal, then try again.`;
  const message = error instanceof Error ? error.message : String(error);
  if (/got no answer|exited|no longer running/.test(message)) return `${agent.name} did not answer as an Agent Client Protocol agent (${sentence(message)}). Check the command and its arguments; many agents need a flag such as --acp or --experimental-acp.`;
  return sentence(message);
}

async function handshake(connection: AcpConnection, agent: AcpAgentSpec, timeoutMs: number, files = true): Promise<Record<string, unknown>> {
  const init = await connection.request('initialize', {protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {fs: {readTextFile: files, writeTextFile: files}, terminal: false}, clientInfo: {name: 'muster', title: 'Muster', version: '1'}}, timeoutMs);
  const version = num(init.protocolVersion);
  if (version !== undefined && version !== ACP_PROTOCOL_VERSION) throw new Error(`${agent.name} speaks Agent Client Protocol version ${version}; Muster speaks version ${ACP_PROTOCOL_VERSION}.`);
  return init;
}

/** Settings › Providers check: the handshake, then one session in a scratch folder to read the agent's models and modes. */
export async function acpProbe(agent: AcpAgentSpec, options: {cwd: string; env?: NodeJS.ProcessEnv; home?: string; spawn?: AgentSpawn; timeoutMs?: number}): Promise<{agentName?: string; version?: string; loadSession: boolean; catalog: AcpCatalog}> {
  const base = options.env ?? process.env, found = resolveAcpCommand(agent, base, options.home);
  if ('problem' in found) throw new Error(found.problem);
  const connection = new AcpConnection(found.binary, agent.args, {cwd: options.cwd, env: acpEnv(agent, base, found.binary), spawn: options.spawn, label: agent.name});
  connection.onRequest = async method => { throw new AcpRpcError(`${method} is not available while Muster checks the agent.`, -32601); };
  const timeoutMs = options.timeoutMs ?? 30_000;
  try {
    let init: Record<string, unknown>;
    try { init = await handshake(connection, agent, timeoutMs); } catch (error) { throw new Error(handshakeProblem(agent, error, connection)); }
    const info = obj(init.agentInfo), caps = obj(init.agentCapabilities);
    let session: Record<string, unknown>;
    try { session = await connection.request('session/new', {cwd: options.cwd, mcpServers: []}, timeoutMs); } catch (error) { throw new Error(handshakeProblem(agent, error, connection)); }
    return {agentName: text(info.title) || text(info.name) || undefined, version: text(info.version) || undefined, loadSession: caps.loadSession === true, catalog: acpCatalog(session)};
  } finally { await connection.close(1000); }
}

/** An ACP agent as a route. */
export function acpAdapter(options: {agent: AcpAgentSpec; env?: NodeJS.ProcessEnv; home?: string; spawn?: AgentSpawn; killGraceMs?: number; handshakeTimeoutMs?: number}): RunnableAdapter {
  const agent = options.agent, label = agent.name;
  return {kind: 'cli', async run(input): Promise<AdapterRunResult> {
    // #147: on an SSH host the command is found there (the remote run's own command); this computer's PATH does not matter.
    const turnId = randomUUID(), base = options.env ?? process.env, found = input.remote ? {binary: input.remote.command} : resolveAcpCommand(agent, base, options.home);
    if ('problem' in found) return {status: 'failed', finalMessage: '', dispatchState: 'not-dispatched', errorMessage: found.problem};
    let connection: AcpConnection;
    try { connection = new AcpConnection(found.binary, agent.args, {cwd: input.cwd, env: acpEnv(agent, base, found.binary, input.env), spawn: options.spawn, label}); }
    catch (error) { return {status: 'failed', finalMessage: '', dispatchState: 'not-dispatched', errorMessage: `${label} could not start: ${error instanceof Error ? error.message : String(error)}`}; }
    let session: string | undefined, accepted = false, replaying = false, answer = '', failure = '', finished = false, prompting = false, waitingApprovals = 0;
    const steers: string[] = [];
    const open = new Map<string, Record<string, unknown>>(), calls = new Map<string, Record<string, unknown>>();
    const threadId = () => session ?? '';
    const emitStarted = (item: Record<string, unknown>) => input.onEvent('item/started', {threadId: threadId(), turnId, item: {...item, status: undefined, aggregatedOutput: undefined}});
    const settle = (id: string, body: Record<string, unknown>) => {
      const item = open.get(id); if (!item) return; open.delete(id);
      const failed = body.status === 'failed';
      input.onEvent('item/completed', {threadId: threadId(), turnId, item: {...item, status: failed ? 'failed' : 'completed', aggregatedOutput: contentText(calls.get(id)?.content) || text(obj(calls.get(id)?.rawOutput).output), ...(failed ? {success: false} : {})}});
    };
    const toolUpdate = (body: Record<string, unknown>, fresh: boolean) => {
      const id = text(body.toolCallId); if (!id) return;
      const merged = {...calls.get(id), ...Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined && value !== null))};
      calls.set(id, merged);
      if (!open.has(id) && fresh) { const item = acpToolItem(merged, input.cwd); open.set(id, item); emitStarted(item); }
      else if (open.has(id)) open.set(id, acpToolItem(merged, input.cwd));
      if (merged.status === 'completed' || merged.status === 'failed') settle(id, merged);
    };
    connection.onNotification = (method, params) => {
      if (method !== 'session/update' || replaying || finished) return;
      const body = obj(params.update), kind = text(body.sessionUpdate);
      if (kind === 'agent_message_chunk') { const chunk = text(obj(body.content).text); if (chunk) { answer += chunk; input.onDelta(chunk); } }
      else if (kind === 'agent_thought_chunk') { const chunk = text(obj(body.content).text); if (chunk) input.onReasoning(chunk); }
      else if (kind === 'tool_call') toolUpdate(body, true);
      else if (kind === 'tool_call_update') toolUpdate(body, !open.has(text(body.toolCallId)) && !calls.has(text(body.toolCallId)));
      else if (kind === 'plan') {
        const plan = (Array.isArray(body.entries) ? body.entries : []).map(obj).slice(0, 100).map(entry => ({step: text(entry.content), status: text(entry.status) || 'pending'})).filter(entry => entry.step);
        if (plan.length) input.onEvent('turn/plan/updated', {threadId: threadId(), turnId, plan});
      }
    };
    const fsPath = async (raw: unknown, write: boolean) => {
      if (write && (input.permissionMode === 'read-only' || input.sandboxed)) throw new AcpRpcError('This chat is read-only in Muster, so the file was not written.', -32603);
      // Outside Full access, files are read and written only inside the chat folder, never through a link.
      return resolvePath(raw, {cwd: input.cwd, access: input.permissionMode === 'full' && !input.sandboxed ? 'full' : 'workspace'}).catch((error: unknown) => { throw new AcpRpcError(error instanceof Error ? error.message : String(error), -32603); });
    };
    connection.onRequest = async (method, params) => {
      if (method === 'session/request_permission') {
        const call = {...calls.get(text(obj(params.toolCall).toolCallId)), ...obj(params.toolCall)};
        if (!call.kind && calls.get(text(call.toolCallId))?.kind) call.kind = calls.get(text(call.toolCallId))!.kind;
        const choices = (Array.isArray(params.options) ? params.options : []).map(obj).map(option => ({optionId: text(option.optionId), kind: text(option.kind)}));
        if (input.signal.aborted || finished) return {outcome: {outcome: 'cancelled'}};
        const kind = text(call.kind);
        let allowed: boolean;
        if (input.sandboxed) allowed = READ_KINDS.has(kind) || (!['execute', 'edit', 'delete', 'move'].includes(kind) && SANDBOX_TOOL_TITLE.test(text(call.title)));
        else if (READ_KINDS.has(kind)) allowed = true;
        else if (input.permissionMode === 'read-only') allowed = false;
        else {
          const [ask, askParams] = acpApprovalAsk(call, input.cwd, label);
          waitingApprovals++;
          try { allowed = permissionResult(input.authorize ? await Promise.resolve().then(() => input.authorize!(ask, askParams)).catch(() => undefined) : input.permissionMode === 'full' ? 'allow' : 'deny') === 'allow'; }
          finally { waitingApprovals--; }
        }
        if (input.signal.aborted) return {outcome: {outcome: 'cancelled'}};
        const optionId = pickOption(choices, allowed);
        return optionId ? {outcome: {outcome: 'selected', optionId}} : {outcome: {outcome: 'cancelled'}};
      }
      if (input.remote && method.startsWith('fs/')) throw new AcpRpcError(`The files are on ${input.remote.host}; read and write them there with your own tools.`, -32601);
      if (method === 'fs/read_text_file') {
        const resolved = await fsPath(params.path, false);
        const read = await readLimited(resolved.path, MAX_FILE_BYTES, resolved.confined).catch((error: unknown) => { throw new AcpRpcError(error instanceof Error ? error.message : String(error), -32603); });
        const line = num(params.line), limit = num(params.limit);
        if (!line && !limit) return {content: read.text};
        const lines = read.text.split('\n'), from = Math.max(0, (line ?? 1) - 1);
        return {content: lines.slice(from, limit ? from + limit : undefined).join('\n')};
      }
      if (method === 'fs/write_text_file') {
        if (typeof params.content !== 'string') throw new AcpRpcError('content must be text.', -32602);
        const resolved = await fsPath(params.path, true);
        // Project tool rules and the guard still apply to a write the agent makes through Muster.
        const verdict = input.authorize ? permissionResult(await input.authorize('item/fileChange/requestApproval', {changes: [{path: resolved.path, kind: existsSync(resolved.path) ? 'update' : 'add'}]}, {policyOnly: true}).catch(() => undefined)) : input.permissionMode === 'read-only' ? 'deny' : 'allow';
        if (verdict !== 'allow') throw new AcpRpcError('Muster declined this write (a Project tool rule or your answer).', -32603);
        await writeConfined(resolved, params.content).catch((error: unknown) => { throw new AcpRpcError(error instanceof Error ? error.message : String(error), -32603); });
        return null;
      }
      throw new AcpRpcError(`${method} is not supported by Muster.`, -32601);
    };
    const cancel = () => { if (session && prompting) connection.notify('session/cancel', {sessionId: session}); };
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => { cancel(); stopTimer = setTimeout(() => killTree(connection.child, 'SIGTERM'), options.killGraceMs ?? 3000); };
    if (input.signal.aborted) abort(); else input.signal.addEventListener('abort', abort, {once: true});
    // #839: ACP has no way to add a message to a running turn, so a steer cancels the turn and sends the message next, in the same session.
    input.onSteerable?.(message => {
      if (finished || input.signal.aborted) return false;
      if (waitingApprovals) return {refused: 'Answer the open approval first; this agent can’t take a message while it waits for one.'};
      steers.push(message); cancel(); return true;
    });
    let stopReason = '';
    try {
      let init: Record<string, unknown>;
      // #147: an agent on an SSH host reads and writes its files there itself; Muster does not serve them from this computer.
      try { init = await handshake(connection, agent, options.handshakeTimeoutMs ?? 60_000, !input.remote); } catch (error) { throw new Error(handshakeProblem(agent, error, connection)); }
      const caps = obj(init.agentCapabilities), sessionCaps = obj(caps.sessionCapabilities);
      let mcpServers: unknown[] = acpMcpServers(input.mcpServers), instructions = input.instructions, opened: Record<string, unknown> | undefined, seed: string | undefined;
      if (input.resumeThreadId) {
        if (sessionCaps.resume && typeof sessionCaps.resume === 'object') opened = await connection.request('session/resume', {sessionId: input.resumeThreadId, cwd: input.cwd, mcpServers}).catch(() => undefined);
        else if (caps.loadSession === true) {
          replaying = true;
          opened = await connection.request('session/load', {sessionId: input.resumeThreadId, cwd: input.cwd, mcpServers}).catch(() => undefined);
          replaying = false;
        }
        if (opened) session = input.resumeThreadId;
        // An agent that cannot continue the saved conversation gets a summary of it ahead of the message.
        else seed = input.onThreadReset?.(input.resumeThreadId)?.trim() || undefined;
      }
      if (!opened) {
        const create = () => connection.request('session/new', {cwd: input.cwd, mcpServers});
        opened = await create().catch(async error => {
          if (!mcpServers.length || (error instanceof AcpRpcError && error.code === AUTH_REQUIRED) || !connection.running) throw error;
          // An agent that cannot start Muster's tool servers still runs the turn, and is told plainly that it has no browser.
          mcpServers = []; instructions = instructions?.replace(browserNote('acp'), NO_BROWSER_NOTE);
          return create();
        }).catch(error => { throw new Error(handshakeProblem(agent, error, connection)); });
        session = text(opened.sessionId);
        if (!session) throw new Error(`${label} did not return a session.`);
      }
      accepted = true; input.onThreadReady(session!); input.onTurnAccepted({threadId: session!, turnId});
      const catalog = acpCatalog(opened);
      const model = input.model.startsWith(`${agent.id}/`) ? input.model.slice(agent.id.length + 1) : input.model;
      if (model && model !== 'default' && model !== catalog.currentModel && catalog.modelSetter) {
        await (catalog.modelSetter.kind === 'config' ? connection.request('session/set_config_option', {sessionId: session, configId: catalog.modelSetter.configId, value: model}) : connection.request('session/set_model', {sessionId: session, modelId: model}))
          .catch(error => { throw new Error(`${label} could not switch to ${model}: ${error instanceof Error ? error.message : String(error)}`); });
      }
      // Read-only and Plan chats use the agent's own plan mode when it has one.
      const plan = (input.permissionMode === 'read-only' || input.chat.mode === 'plan') ? catalog.modes.find(mode => /^plan$/i.test(mode.id) || /\bplan\b/i.test(mode.name)) : undefined;
      if (plan && plan.id !== catalog.currentMode) await connection.request('session/set_mode', {sessionId: session, modeId: plan.id}).catch(() => undefined);
      const images = obj(caps.promptCapabilities).image === true ? loadImages(input.images).map(image => ({type: 'image', data: image.data, mimeType: image.mediaType})) : [];
      let message = [seed, instructions, input.prompt].filter(Boolean).join('\n\n'), first = true;
      for (;;) {
        prompting = true;
        const reply = await connection.request('session/prompt', {sessionId: session, prompt: [{type: 'text', text: message}, ...(first ? images : [])]}).finally(() => { prompting = false; });
        first = false;
        stopReason = text(reply.stopReason) || 'end_turn';
        const usage = obj(reply.usage), inputTokens = num(usage.inputTokens), outputTokens = num(usage.outputTokens);
        if (inputTokens !== undefined || outputTokens !== undefined) input.onEvent('thread/tokenUsage/updated', {threadId: session, turnId, tokenUsage: {last: {inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0, totalTokens: num(usage.totalTokens) ?? (inputTokens ?? 0) + (outputTokens ?? 0), ...(num(usage.cachedReadTokens) ? {cachedInputTokens: num(usage.cachedReadTokens)} : {})}}});
        if (input.signal.aborted || !steers.length) break;
        message = steers.splice(0).join('\n\n');
      }
      if (input.signal.aborted || stopReason === 'cancelled') failure = 'Stopped.';
      else if (stopReason === 'refusal') failure = `${label} refused to continue.`;
    } catch (error) { failure = input.signal.aborted ? 'Stopped.' : error instanceof Error ? error.message : String(error); }
    finished = true;
    input.signal.removeEventListener('abort', abort);
    for (const [id, item] of open) input.onEvent('item/completed', {threadId: threadId(), turnId, item: {...item, id, status: 'interrupted'}});
    open.clear();
    await connection.close(input.signal.aborted ? 500 : options.killGraceMs ?? 3000);
    clearTimeout(stopTimer);
    const identity = accepted ? {threadId: session!, turnId} : {};
    if (input.signal.aborted) return {status: 'failed', finalMessage: '', dispatchState: accepted ? 'dispatched' : 'not-dispatched', ...identity, errorMessage: 'Stopped.'};
    if (!failure) return {status: 'completed', finalMessage: answer, dispatchState: 'dispatched', ...identity};
    return {status: 'failed', finalMessage: '', dispatchState: accepted ? 'dispatched' : 'not-dispatched', ...identity, errorMessage: sentence(failure)};
  }};
}
