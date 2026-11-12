/**
 * #844: MCP Apps (the `io.modelcontextprotocol/ui` extension, SEP-1865, stable spec 2026-01-26). A tool declares an interactive
 * UI with `_meta.ui.resourceUri` (a `ui://` resource of type `text/html;profile=mcp-app`); the host reads it from the same
 * server, shows it in a sandboxed frame and talks to it with JSON-RPC 2.0 over postMessage.
 *
 * Muster's frame is the one it uses for agent pages (SandboxedHtml: its own `muster-report://` origin, scripts-only sandbox,
 * no network unless the person allowed it). Pure: shared by the runtime (marking rows, reading resources, gating the app's
 * tool calls), main (the served CSP) and the renderer (the bridge).
 */

export const MCP_APPS_PROTOCOL = '2026-01-26';
export const MCP_APPS_EXTENSION = 'io.modelcontextprotocol/ui';
export const MCP_APP_MIME = 'text/html;profile=mcp-app';
/** One app's HTML, as for a render_html page. */
export const MCP_APP_MAX_BYTES = 2_000_000;
const MAX_DOMAINS = 16;

export type McpAppVisibility = 'model' | 'app';
export interface McpToolUi { resourceUri?: string; visibility: McpAppVisibility[] }
/** What a tool row carries once its tool is known to declare an app (`data.mcpApp`); server and tool come from the row. */
export interface McpAppMark { uri: string }
/** A standard MCP CallToolResult, bounded. */
export interface McpCallToolResult { content: unknown[]; structuredContent?: unknown; isError?: boolean; _meta?: Record<string, unknown> }
/** The https hosts the resource declared (`_meta.ui.csp`): fetch/XHR/WebSocket, and scripts, styles, images, fonts and media. */
export interface McpAppDomains { connect: string[]; resource: string[] }
/** What the runtime returns for an app row: the resource and the call it belongs to. */
export interface McpAppView {
  html: string; uri: string; server: string; tool: string; title: string;
  toolInput: Record<string, unknown>; toolResult: McpCallToolResult;
  domains: McpAppDomains;
  /** The resource declared https domains. */
  networkRequested: boolean;
  /** The person allowed them for this row (Allow for this page). Never set by the app, the server or the agent. */
  networkAllowed: boolean;
  prefersBorder?: boolean;
}

const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** A tool's UI declaration: `_meta.ui.resourceUri` (or the deprecated flat `_meta["ui/resourceUri"]`), only a `ui://` URI. */
export function toolUi(tool: unknown): McpToolUi | undefined {
  const meta = record(record(tool)?._meta), ui = record(meta?.ui);
  if (!meta) return undefined;
  const raw = typeof ui?.resourceUri === 'string' ? ui.resourceUri : typeof meta['ui/resourceUri'] === 'string' ? meta['ui/resourceUri'] as string : undefined;
  const resourceUri = raw && /^ui:\/\/[^\s]{1,2000}$/.test(raw) ? raw : undefined;
  const visibility = Array.isArray(ui?.visibility) ? (ui.visibility as unknown[]).filter((entry): entry is McpAppVisibility => entry === 'model' || entry === 'app') : ['model', 'app'] as McpAppVisibility[];
  if (!resourceUri && !Array.isArray(ui?.visibility)) return undefined;
  return {...(resourceUri ? {resourceUri} : {}), visibility};
}
/** May the app call this tool (`visibility` includes "app"; the default is both). */
export const appMayCall = (tool: unknown): boolean => (toolUi(tool)?.visibility ?? ['model', 'app']).includes('app');
/** The tool says it changes nothing (`annotations.readOnlyHint`). Anything else is treated as a change. */
export const toolReadOnly = (tool: unknown): boolean => record(record(tool)?.annotations)?.readOnlyHint === true;

/** The app of a finished MCP tool row: its resource and the server and tool that made it. */
export function mcpAppOf(data: Record<string, unknown> | undefined): {uri: string; server: string; tool: string} | undefined {
  if (!data || data.type !== 'mcpToolCall') return undefined;
  const mark = record(data.mcpApp), uri = typeof mark?.uri === 'string' && mark.uri.startsWith('ui://') ? mark.uri : undefined;
  const server = typeof data.server === 'string' ? data.server : undefined, tool = typeof data.tool === 'string' ? data.tool : undefined;
  return uri && server && tool ? {uri, server, tool} : undefined;
}

const parse = (value: unknown): unknown => { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return undefined; } };
/** The tool's arguments from its row (a JSON string or an object). */
export function rowArguments(data: Record<string, unknown> | undefined): Record<string, unknown> { return record(parse(data?.arguments)) ?? {}; }
/** The tool's result from its row: the stored CallToolResult when it parses, otherwise its text output as one text block. */
export function rowResult(data: Record<string, unknown> | undefined, text = ''): McpCallToolResult {
  const result = record(parse(data?.result));
  if (result && Array.isArray(result.content)) return {content: result.content, ...(result.structuredContent !== undefined ? {structuredContent: result.structuredContent} : {}), ...(result.isError === true ? {isError: true} : {}), ...(record(result._meta) ? {_meta: record(result._meta)} : {})};
  const output = typeof data?.output === 'string' ? data.output : text;
  return {content: output ? [{type: 'text', text: output}] : []};
}

/** The row's result as plain text (its text blocks): what is shown when the app cannot be opened. */
export function rowResultText(data: Record<string, unknown> | undefined, text = ''): string {
  return rowResult(data, text).content.map(block => record(block)?.type === 'text' && typeof record(block)?.text === 'string' ? String(record(block)!.text) : '').filter(Boolean).join('\n').slice(0, 20_000);
}

/** Declared domains kept as `https://host` (a leading `*.` allowed): never http, a path, a port-less wildcard or anything else. */
function httpsHosts(value: unknown): string[] {
  const out = new Set<string>();
  for (const entry of Array.isArray(value) ? value : []) {
    if (typeof entry !== 'string' || out.size >= MAX_DOMAINS) continue;
    const match = /^https:\/\/(\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::(\d{1,5}))?\/?$/i.exec(entry.trim());
    if (match) out.add(`https://${match[1] ?? ''}${match[2]!.toLowerCase()}${match[3] ? `:${match[3]}` : ''}`);
  }
  return [...out];
}
/** The resource's `_meta.ui.csp`, reduced to https hosts. */
export function appDomains(meta: unknown): McpAppDomains {
  const csp = record(record(record(meta)?.ui)?.csp);
  return {connect: httpsHosts(csp?.connectDomains), resource: httpsHosts(csp?.resourceDomains)};
}
/** What main serves the app with: no network, or (once the person allowed it) only the declared hosts. */
export function mcpAppNetwork(app: Pick<McpAppView, 'domains' | 'networkAllowed'>): false | McpAppDomains {
  return app.networkAllowed && (app.domains.connect.length > 0 || app.domains.resource.length > 0) ? app.domains : false;
}

/**
 * Whether the app's call to a tool on its own server runs: a read-only tool runs; a change is refused in a read-only chat,
 * runs in Full access and asks on the approval card otherwise. Project tool rules come first (deny refuses, ask always asks,
 * allow runs except in a read-only chat).
 */
export function appCallDecision(input: {mode: string | undefined; readOnly: boolean; policy?: 'allow' | 'ask' | 'deny' | null}): 'allow' | 'ask' | 'refuse' {
  if (input.policy === 'deny') return 'refuse';
  if (!input.readOnly && (input.mode === 'read-only' || !input.mode)) return 'refuse';
  if (input.policy === 'ask') return 'ask';
  if (input.readOnly || input.policy === 'allow' || input.mode === 'full') return 'allow';
  return 'ask';
}

// ---- the bridge ---------------------------------------------------------------------------------------------------------

export interface McpAppHost {
  /** Sends one message to the app's frame. */
  post(message: unknown): void;
  toolInput: Record<string, unknown>;
  toolResult: McpCallToolResult;
  /** A tools/call from the app, to its own server through the runtime (which applies access and approvals). Throws to refuse. */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Opens an http(s) URL in the in-app browser. Called only for a request that came with a click. */
  openLink(url: string): void;
  /** Puts text in the chat's composer. Never sends it. */
  toComposer(text: string): void;
  /** The app's reported content height. */
  onSize?(height: number): void;
  hostContext(): Record<string, unknown>;
}
interface Rpc { jsonrpc: '2.0'; id?: string | number; method?: string; params?: unknown }
const isRpc = (value: unknown): value is Rpc => {
  const message = record(value);
  return !!message && message.jsonrpc === '2.0' && (typeof message.method === 'string' || message.id !== undefined);
};
const validId = (id: unknown): id is string | number => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
export const MCP_APP_HOST_INFO = {name: 'Muster', version: '1'};

/**
 * The host side of the bridge for one app. `receive` takes one message from the app's own frame (the caller checks the source);
 * `context.userActive` is whether the person just used the frame (for links).
 */
export function createMcpAppBridge(host: McpAppHost) {
  let initialized = false, delivered = false, closed = false;
  const reply = (id: string | number, result: unknown) => { if (!closed) host.post({jsonrpc: '2.0', id, result}); };
  const fail = (id: string | number, code: number, message: string) => { if (!closed) host.post({jsonrpc: '2.0', id, error: {code, message}}); };
  const notify = (method: string, params: unknown) => { if (!closed) host.post({jsonrpc: '2.0', method, params}); };
  const deliver = () => {
    if (delivered) return;
    delivered = true;
    notify('ui/notifications/tool-input', {arguments: host.toolInput});
    notify('ui/notifications/tool-result', host.toolResult);
  };
  return {
    async receive(data: unknown, context: {userActive: boolean}): Promise<void> {
      if (closed || !isRpc(data)) return;
      const {id, method} = data, params = record(data.params) ?? {};
      // Replies to requests the host made (none yet) and malformed ids are dropped.
      if (!method) return;
      const request = validId(id);
      switch (method) {
        case 'ui/initialize':
          if (!request) return;
          initialized = true;
          return reply(id, {protocolVersion: MCP_APPS_PROTOCOL, hostInfo: MCP_APP_HOST_INFO,
            hostCapabilities: {openLinks: {}, serverTools: {}, logging: {}, sandbox: {permissions: {}, csp: {}}},
            hostContext: host.hostContext()});
        case 'ui/notifications/initialized':
          if (initialized) deliver();
          return;
        case 'ui/notifications/size-changed': {
          const height = typeof params.height === 'number' && Number.isFinite(params.height) ? Math.max(0, Math.min(20_000, Math.ceil(params.height))) : undefined;
          if (height !== undefined) host.onSize?.(height);
          return;
        }
        case 'notifications/message': return;
        case 'ping': if (request) reply(id, {}); return;
        case 'ui/open-link': {
          if (!request) return;
          let url: URL | undefined;
          try { url = new URL(String(params.url ?? '')); } catch { /* refused below */ }
          if (!url || !/^https?:$/.test(url.protocol)) return fail(id, -32000, 'Only http and https links can be opened.');
          if (!context.userActive) return fail(id, -32000, 'A link opens only when you click it in the app.');
          host.openLink(url.href);
          return reply(id, {});
        }
        case 'ui/message': {
          if (!request) return;
          const blocks = Array.isArray(params.content) ? params.content : [params.content];
          const text = blocks.map(block => record(block)?.type === 'text' && typeof record(block)?.text === 'string' ? String(record(block)!.text) : '').filter(Boolean).join('\n').slice(0, 20_000);
          if (!text) return fail(id, -32602, 'The message has no text.');
          host.toComposer(text);
          return reply(id, {});
        }
        case 'ui/update-model-context': if (request) reply(id, {}); return;
        case 'ui/request-display-mode': if (request) reply(id, {mode: 'inline'}); return;
        case 'tools/call': {
          if (!request) return;
          const name = typeof params.name === 'string' ? params.name : '';
          if (!name) return fail(id, -32602, 'tools/call needs a tool name.');
          try { return reply(id, await host.callTool(name, record(params.arguments) ?? {})); }
          catch (error) { return fail(id, -32000, error instanceof Error ? error.message : String(error)); }
        }
        default:
          if (request) fail(id, -32601, `Muster does not support ${method.slice(0, 80)} from an app.`);
      }
    },
    /** Host context changes (the theme) reach an initialized app as one notification. */
    contextChanged(context: Record<string, unknown>) { if (initialized) notify('ui/notifications/host-context-changed', context); },
    close() { closed = true; },
  };
}
export type McpAppBridge = ReturnType<typeof createMcpAppBridge>;
