import {randomBytes, timingSafeEqual} from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {browserScopeProfile, type BrowserState} from '../../shared/browser-protocol.ts';
import type {AgentEvent, Snapshot} from '../../shared/protocol.ts';
import type {ComputerControlOwner} from '../../shared/domains/computer-protocol.ts';
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
export const agentBrowserOwner = (chatId: string) => `browser:agent-${chatId}`;
const FRAME_INTERVAL_MS = 1000, FRAME_IDLE_MS = 8000, MAX_BODY = 1024 * 1024;
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** Launcher script Codex runs as the muster_browser MCP server (config overrides cannot carry an args array). */
export function launcherScript(execPath: string, script: string, endpoint: string): string {
  return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(execPath)} ${shellQuote(script)} ${shellQuote(endpoint)}\n`;
}

/** Local HTTP endpoint (127.0.0.1, bearer token in a 0600 file) that turns MCP tool calls into browser actions. */
export class BrowserBridge {
  readonly launcher: string;
  private server?: http.Server;
  private token = randomBytes(32);
  private pumps = new Map<string, {timer?: ReturnType<typeof setTimeout>; until: number; busy: boolean; label?: string}>();
  private queues = new Map<string, Promise<unknown>>();
  private disposed = false;
  constructor(private options: BridgeOptions) { this.launcher = path.join(options.dir, 'muster-browser-mcp'); }
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
    let body: {chatId?: unknown; tool?: unknown; arguments?: unknown};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reply(400, {error: 'Invalid JSON'}); return; }
    reply(200, await this.call(body.chatId, body.tool, body.arguments));
  }
  /** Calls for one chat run one at a time, in order; different chats never wait on each other. */
  call(chatId: unknown, tool: unknown, args: unknown): Promise<McpToolResult> {
    if (typeof chatId !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(chatId)) return Promise.resolve(textResult('This browser bridge was started without a chat.', true));
    if (typeof tool !== 'string' || !BROWSER_TOOL_NAMES.has(tool)) return Promise.resolve(textResult(`Unknown browser tool ${String(tool)}.`, true));
    const previous = this.queues.get(chatId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.execute(chatId, tool, args));
    this.queues.set(chatId, next);
    void next.finally(() => { if (this.queues.get(chatId) === next) this.queues.delete(chatId); });
    return next;
  }
  private async execute(chatId: string, tool: string, args: unknown): Promise<McpToolResult> {
    if (this.disposed) return textResult('Muster is closing.', true);
    const snapshot = await this.options.snapshot();
    const chat = snapshot.chats.find(item => item.id === chatId);
    if (!chat) return textResult('This chat no longer exists in Muster.', true);
    // CUA-03/09: the user holding control revokes the agent's input lease.
    if (await this.options.lease(chatId) === 'user') return textResult('The user has taken control of the browser. Stop using browser tools and wait until they hand control back.', true);
    const owner = agentBrowserOwner(chatId), profileId = browserScopeProfile(chat), browser = this.options.browser;
    const host: AgentBrowserHost = {
      has: () => browser.hasTab(owner),
      open: url => { const opened = !browser.hasTab(owner), state = browser.agentOpen(owner, profileId, url); if (opened) this.options.emit({type: 'computerBrowserOpened', chatId, owner, profileId, url: state.url}); return state; },
      page: () => browser.agentPage(owner),
      back: () => browser.back(owner),
      reload: () => browser.reload(owner),
      console: () => browser.console({owner}),
      // A hidden tab still paints (stayHidden); 1280px keeps the image useful without flooding the model's context.
      screenshot: async () => await browser.frame(owner, 1280) ?? null,
    };
    try {
      const outcome = await runBrowserTool(host, tool, args, {readOnly: chat.mode !== 'agent' || (chat.permissionMode ?? 'workspace') === 'read-only'});
      if (browser.hasTab(owner)) this.pump(chatId, owner, profileId, outcome.action);
      return outcome.result;
    } catch (error) {
      return textResult(error instanceof Error ? error.message : String(error), true);
    }
  }
  /** Live PiP frames: one now, then about once a second until the agent has been idle for a while. Frames never reach the model. */
  private pump(chatId: string, owner: string, profileId: string, action: string): void {
    const state = this.pumps.get(chatId) ?? {until: 0, busy: false};
    state.until = Date.now() + FRAME_IDLE_MS;
    if (action) state.label = action;
    this.pumps.set(chatId, state);
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
      else this.pumps.delete(chatId);
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
