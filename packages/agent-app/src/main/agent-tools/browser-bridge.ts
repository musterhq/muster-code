import {randomBytes, timingSafeEqual} from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {AGENT_BROWSER_SESSION, agentBrowserOwner, browserScopeProfile, type BrowserState} from '../../shared/browser-protocol.ts';
import type {AgentEvent, Snapshot} from '../../shared/protocol.ts';
import type {ComputerControlOwner} from '../../shared/domains/computer-protocol.ts';
import {launcherFile, nodeLauncherScript} from '../../runtime/launcher-script.ts';
import {runBrowserTool, type AgentBrowserHost, type AgentPage} from './browser-actions.ts';
import {BROWSER_TOOL_NAMES, textResult, type McpToolResult} from './browser-tools.ts';

/** What the bridge needs from the browser workspace (BrowserWorkspaceController satisfies it). */
export interface BridgeBrowser {
  agentOpen(owner: string, profileId: string, url?: string): BrowserState;
  hasTab(owner: string): boolean;
  agentPage(owner: string): AgentPage;
  back(owner: string): BrowserState;
  reload(owner: string): BrowserState;
  console(input: {owner: string}): {level: 'debug' | 'info' | 'warning' | 'error' | 'network'; message: string; source: string; line: number; at: number}[];
  /** The tab's state without waking a discarded page (optional for test doubles). */
  status?(owner: string): BrowserState;
  frame(owner: string, width?: number): Promise<{dataUrl: string; width: number; height: number; url: string; title: string} | undefined>;
}
export interface BridgeOptions {
  dir: string;
  browser: BridgeBrowser;
  snapshot(): Promise<Snapshot>;
  lease(chatId: string): Promise<ComputerControlOwner>;
  emit(event: AgentEvent): void;
  /** Node binary (Electron with ELECTRON_RUN_AS_NODE) and the bundled stdio server. */
  execPath: string;
  script: string;
}
/** One agent tab per chat; the renderer adopts it into the right pane under the same owner. */
export {agentBrowserOwner};
const FRAME_INTERVAL_MS = 1000, FRAME_IDLE_MS = 8000, MAX_BODY = 1024 * 1024;
/** #387: a call answers within this, so the MCP client (110 s) and Codex (120 s) never time out on a silent bridge. */
export const BROWSER_CALL_TIMEOUT_MS = 100_000;
/** #424: how HTTP routes (in the runtime bundle, same process) reach this bridge without a socket. */
export const BROWSER_CALLER_KEY = Symbol.for('muster.browserToolCaller');
/** Main's "start the bridge now" hook, for a turn that finds no launcher (the start at launch failed). */
export const BROWSER_BRIDGE_START_KEY = Symbol.for('muster.browserBridgeStart');
export type BrowserToolCaller = (chatId: string, tool: string, args: unknown, session?: string) => Promise<McpToolResult>;
/** The session key a call names: the explicit one (an MCP server's env), else the model's `session` argument. */
export function callSession(args: unknown, session?: string): string | undefined {
  const named = typeof session === 'string' && session ? session : args && typeof args === 'object' && typeof (args as {session?: unknown}).session === 'string' ? (args as {session: string}).session : undefined;
  return named && AGENT_BROWSER_SESSION.test(named) ? named : undefined;
}

/** Launcher script Codex runs as the muster_browser MCP server (config overrides cannot carry an args array). */
export function launcherScript(execPath: string, script: string, endpoint: string, platform: NodeJS.Platform = process.platform): string {
  return nodeLauncherScript(execPath, script, endpoint, platform);
}

/** Local HTTP endpoint (127.0.0.1, bearer token in a 0600 file) that turns MCP tool calls into browser actions. */
export class BrowserBridge {
  readonly launcher: string;
  private server?: http.Server;
  private token = randomBytes(32);
  private pumps = new Map<string, {timer?: ReturnType<typeof setTimeout>; until: number; busy: boolean; label?: string}>();
  private queues = new Map<string, Promise<unknown>>();
  private disposed = false;
  private starting?: Promise<string>;
  constructor(private options: BridgeOptions) { this.launcher = launcherFile(path.join(options.dir, 'muster-browser-mcp')); }
  /** #387: starts the endpoint once; a failed start is retried once, then the error says what to do. Later calls after a
   *  failure try again (first use), so a bridge that could not start at launch is not gone for the session. */
  ensureStarted(retryDelayMs = 500): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('Muster is closing.'));
    if (this.server?.listening && fs.existsSync(this.launcher)) return Promise.resolve(this.launcher);
    this.starting ??= (async () => {
      try { return await this.start(); }
      catch {
        this.server?.close(); this.server = undefined;
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        try { return await this.start(); }
        catch (error) { throw new Error(`Muster's browser could not start: ${error instanceof Error ? error.message : String(error)}. Try again; if it keeps failing, restart Muster.`); }
      } finally { this.starting = undefined; }
    })();
    return this.starting;
  }
  /** In-process caller for HTTP routes; registered on globalThis because main and the runtime are separate bundles. */
  register(): () => void {
    const caller: BrowserToolCaller = (chatId, tool, args, session) => this.call(chatId, tool, args, session);
    (globalThis as Record<symbol, unknown>)[BROWSER_CALLER_KEY] = caller;
    return () => { if ((globalThis as Record<symbol, unknown>)[BROWSER_CALLER_KEY] === caller) delete (globalThis as Record<symbol, unknown>)[BROWSER_CALLER_KEY]; };
  }
  async start(): Promise<string> {
    fs.mkdirSync(this.options.dir, {recursive: true, mode: 0o700});
    const server = http.createServer((request, response) => void this.handle(request, response));
    this.server = server;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
    const {port} = server.address() as {port: number};
    const endpoint = path.join(this.options.dir, 'browser-endpoint.json');
    fs.writeFileSync(endpoint, JSON.stringify({url: `http://127.0.0.1:${port}/v1/call`, token: this.token.toString('hex')}), {mode: 0o600});
    fs.chmodSync(endpoint, 0o600);
    fs.writeFileSync(this.launcher, launcherScript(this.options.execPath, this.options.script, endpoint), {mode: 0o700});
    fs.chmodSync(this.launcher, 0o700);
    return this.launcher;
  }
  private authorized(header: string | undefined): boolean {
    const presented = Buffer.from(/^Bearer ([a-f0-9]{64})$/.exec(header ?? '')?.[1] ?? '', 'hex');
    return presented.length === this.token.length && timingSafeEqual(presented, this.token);
  }
  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown) => { response.writeHead(status, {'content-type': 'application/json'}); response.end(JSON.stringify(body)); };
    if (request.method !== 'POST' || request.url !== '/v1/call' || !this.authorized(request.headers.authorization)) { reply(403, {error: 'Forbidden'}); return; }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) { size += (chunk as Buffer).length; if (size > MAX_BODY) { reply(413, {error: 'Too large'}); return; } chunks.push(chunk as Buffer); }
    let body: {chatId?: unknown; tool?: unknown; arguments?: unknown; session?: unknown};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reply(400, {error: 'Invalid JSON'}); return; }
    reply(200, await this.call(body.chatId, body.tool, body.arguments, typeof body.session === 'string' ? body.session : undefined));
  }
  /** Calls for one tab run one at a time, in order; different chats and sub-agent sessions never wait on each other. */
  call(chatId: unknown, tool: unknown, args: unknown, session?: string, timeoutMs = BROWSER_CALL_TIMEOUT_MS): Promise<McpToolResult> {
    if (typeof chatId !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(chatId)) return Promise.resolve(textResult('This browser bridge was started without a chat.', true));
    if (typeof tool !== 'string' || !BROWSER_TOOL_NAMES.has(tool)) return Promise.resolve(textResult(`Unknown browser tool ${String(tool)}.`, true));
    const key = callSession(args, session), owner = agentBrowserOwner(chatId, key);
    const previous = this.queues.get(owner) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.execute(chatId, tool, args, key));
    this.queues.set(owner, next);
    void next.finally(() => { if (this.queues.get(owner) === next) this.queues.delete(owner); });
    // #387: a page that hangs (a script that never returns, a frozen renderer) answers with a clear error, not a timeout.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<McpToolResult>(resolve => { timer = setTimeout(() => {
      // The stuck call no longer holds up this tab's later calls.
      if (this.queues.get(owner) === next) this.queues.delete(owner);
      resolve(textResult(`Muster's browser did not finish ${tool} within ${Math.max(1, Math.round(timeoutMs / 1000))} s. The page may be busy or stuck: take a browser_snapshot, or browser_reload the page, and try again.`, true));
    }, timeoutMs); timer.unref?.(); });
    return Promise.race([next, late]).finally(() => clearTimeout(timer));
  }
  private async execute(chatId: string, tool: string, args: unknown, session?: string): Promise<McpToolResult> {
    if (this.disposed) return textResult('Muster is closing.', true);
    const snapshot = await this.options.snapshot();
    const chat = snapshot.chats.find(item => item.id === chatId);
    if (!chat) return textResult('This chat no longer exists in Muster.', true);
    // CUA-03/09: the user holding control revokes the agent's input lease.
    if (await this.options.lease(chatId) === 'user') return textResult('The user has taken control of the browser. Stop using browser tools and wait until they hand control back.', true);
    const owner = agentBrowserOwner(chatId, session), profileId = browserScopeProfile(chat), browser = this.options.browser;
    let announced = false;
    const host: AgentBrowserHost = {
      has: () => browser.hasTab(owner),
      open: url => { const opened = !browser.hasTab(owner), state = browser.agentOpen(owner, profileId, url); if (opened) { announced = true; this.options.emit({type: 'computerBrowserOpened', chatId, owner, profileId, url: state.url}); } return state; },
      page: () => browser.agentPage(owner),
      back: () => browser.back(owner),
      reload: () => browser.reload(owner),
      console: () => browser.console({owner}),
      // A hidden tab still paints (stayHidden); 1280px keeps the image useful without flooding the model's context.
      screenshot: async () => await browser.frame(owner, 1280) ?? null,
    };
    try {
      const outcome = await runBrowserTool(host, tool, args, {readOnly: chat.mode !== 'agent' || (chat.permissionMode ?? 'workspace') === 'read-only'});
      if (browser.hasTab(owner)) {
        // #423: every call re-announces which tab the agent drives, so a renderer that reloaded, reconnected or opened
        // the chat after the tab was created still binds the session to this tab (not a picture-only placeholder).
        if (!announced) this.options.emit({type: 'computerBrowserOpened', chatId, owner, profileId, url: (() => { try { return browser.status?.(owner)?.url ?? ''; } catch { return ''; } })()});
        this.pump(chatId, owner, profileId, outcome.action);
      }
      return outcome.result;
    } catch (error) {
      return textResult(error instanceof Error ? error.message : String(error), true);
    }
  }
  /** Live PiP frames: one now, then about once a second until the agent has been idle for a while. Frames never reach the model. */
  private pump(chatId: string, owner: string, profileId: string, action: string): void {
    const state = this.pumps.get(owner) ?? {until: 0, busy: false};
    state.until = Date.now() + FRAME_IDLE_MS;
    if (action) state.label = action;
    this.pumps.set(owner, state);
    const tick = async () => {
      state.timer = undefined;
      const label = state.label; state.label = undefined;
      if (this.disposed || state.busy) return;
      state.busy = true;
      try {
        const frame = await this.options.browser.frame(owner).catch(() => undefined);
        if (frame && !this.disposed) this.options.emit({type: 'computerFrame', frame: {chatId, owner, profileId, ...frame, ...(label ? {action: label} : {}), at: Date.now()}});
      } finally { state.busy = false; }
      if (!this.disposed && Date.now() < state.until) { state.timer = setTimeout(() => void tick(), FRAME_INTERVAL_MS); state.timer.unref?.(); }
      else this.pumps.delete(owner);
    };
    if (state.timer) { clearTimeout(state.timer); state.timer = undefined; }
    if (!state.busy) void tick();
  }
  dispose(): void {
    this.disposed = true;
    for (const state of this.pumps.values()) clearTimeout(state.timer);
    this.pumps.clear();
    this.server?.close();
    try { fs.rmSync(path.join(this.options.dir, 'browser-endpoint.json'), {force: true}); } catch {}
  }
}
