/**
 * #844: the runtime side of MCP Apps. When a chat's run finishes an MCP tool call on a server Muster knows (added in Settings
 * or detected from Codex/Claude config), Muster asks that server (its own connection, not the agent's) whether the tool
 * declares a `ui://` resource and marks the row. The renderer then opens the app through `mcp.apps.open`, and the app's own
 * tools/call requests come back through `mcp.apps.callTool`: to the row's server only, for a tool the app may call, under the
 * chat's access level and approvals. None of this ever holds up the turn.
 */
import type {Chat, TimelineItem} from '../shared/protocol.ts';
import {MCP_APP_MAX_BYTES, MCP_APP_MIME, appDomains, appMayCall, mcpAppOf, rowArguments, rowResult, toolReadOnly, toolUi, type McpAppView, type McpCallToolResult} from '../shared/mcp-apps.ts';
import {listTools, openMcpSession, type McpSession, type McpSessionTarget} from './mcp-session.ts';
import type {DomainContext, ProviderEventInfo} from './domains/types.ts';

export interface McpAppsServer {id: string; name: string; target: McpSessionTarget}
export interface McpAppsDeps {
  ctx: DomainContext;
  /** The enabled server this chat's row named (by its config key, then its name); undefined when Muster does not know it. */
  server(chat: Chat, name: string): McpAppsServer | undefined;
  /** Test seam: how long an idle session stays open. */
  idleMs?: number;
}
type Tool = Record<string, unknown>;
const TOOLS_TTL_MS = 5 * 60_000, IDLE_MS = 60_000, MAX_RESULT_BYTES = 2_000_000;
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function createMcpAppsHost(deps: McpAppsDeps) {
  const {ctx} = deps;
  const sessions = new Map<string, {session: Promise<McpSession>; timer?: ReturnType<typeof setTimeout>}>();
  const tools = new Map<string, {at: number; list: Promise<Tool[]>}>();
  let disposed = false;

  const drop = (id: string) => { const held = sessions.get(id); sessions.delete(id); if (held) { clearTimeout(held.timer); void held.session.then(session => session.close(), () => {}); } };
  /** One open session per server, closed after a minute without use. A broken session is dropped and opened again once. */
  const withSession = async <T>(server: McpAppsServer, work: (session: McpSession) => Promise<T>, retry = true): Promise<T> => {
    if (disposed) throw new Error('Muster is shutting down.');
    let held = sessions.get(server.id);
    if (!held) { held = {session: openMcpSession(server.target)}; sessions.set(server.id, held); held.session.catch(() => { if (sessions.get(server.id) === held) sessions.delete(server.id); }); }
    clearTimeout(held.timer);
    const session = await held.session;
    if (session.closed) { drop(server.id); if (retry) return withSession(server, work, false); throw new Error(`The server ${server.name} is not running.`); }
    try { return await work(session); }
    catch (error) { if (session.closed) { drop(server.id); if (retry) return withSession(server, work, false); } throw error; }
    finally {
      const current = sessions.get(server.id);
      if (current === held) { current.timer = setTimeout(() => drop(server.id), deps.idleMs ?? IDLE_MS); current.timer.unref?.(); }
    }
  };
  const toolList = (server: McpAppsServer, fresh = false): Promise<Tool[]> => {
    const cached = tools.get(server.id);
    if (cached && !fresh && Date.now() - cached.at < TOOLS_TTL_MS) return cached.list;
    const list = withSession(server, listTools);
    tools.set(server.id, {at: Date.now(), list});
    list.catch(() => { if (tools.get(server.id)?.list === list) tools.delete(server.id); });
    return list;
  };

  const revision = (chatId: string) => (ctx.db().prepare('SELECT revision FROM timeline_cursors WHERE chat_id = ?').get(chatId) as {revision: number} | undefined)?.revision ?? 0;
  const update = (item: TimelineItem, data: Record<string, unknown>) => {
    const before = revision(item.chatId);
    ctx.store.updateItem(item.id, item.text, item.status, data);
    const patch = ctx.store.timelineChanges(item.chatId, before);
    if (patch.revision > before) ctx.emit({type: 'timelinePatch', chatId: item.chatId, patch: {...patch, after: before}});
  };
  const rowOf = (chatId: string, providerItemId: string) => {
    const items = ctx.store.timeline(chatId);
    for (let index = items.length - 1; index >= 0; index--) { const item = items[index]!; if (item.kind === 'tool' && item.data?.providerItemId === providerItemId) return item; }
    return undefined;
  };

  /** Marks a finished MCP tool row whose tool declares an app. Runs after the row is stored; failures only mean no app. */
  const mark = async (chat: Chat, item: Record<string, unknown>) => {
    const name = typeof item.server === 'string' ? item.server : '', tool = typeof item.tool === 'string' ? item.tool : '', id = typeof item.id === 'string' ? item.id : '';
    const server = name && tool && id ? deps.server(chat, name) : undefined;
    if (!server) return;
    const declared = (await toolList(server)).find(entry => entry.name === tool);
    const uri = toolUi(declared)?.resourceUri;
    if (!uri || disposed) return;
    const row = rowOf(chat.id, id);
    if (!row || row.status !== 'completed' || mcpAppOf(row.data)) return;
    update(row, {...row.data, mcpApp: {uri}});
  };
  const observe = ({chat, method, params}: ProviderEventInfo) => {
    if (method !== 'item/completed' || disposed) return;
    const item = record(params.item);
    if (item?.type !== 'mcpToolCall' || item.error != null || item.status === 'failed' || item.success === false) return;
    void Promise.resolve().then(() => mark(chat, item)).catch(() => {});
  };

  /** The chat, the app row and its server, or a plain error. */
  const locate = (input: Record<string, unknown>) => {
    const chat = typeof input.chatId === 'string' ? ctx.store.chat(input.chatId) : undefined;
    if (!chat) throw new Error('Chat not found.');
    const item = typeof input.itemId === 'string' ? ctx.store.item(input.itemId) : undefined;
    const app = item && item.chatId === chat.id ? mcpAppOf(item.data) : undefined;
    if (!item || !app) throw new Error('This tool row has no app.');
    const server = deps.server(chat, app.server);
    if (!server) throw new Error(`The MCP server ${app.server} is no longer available. Check Settings › MCP servers.`);
    return {chat, item, app, server};
  };

  const open = async (input: Record<string, unknown>): Promise<McpAppView> => {
    const {item, app, server} = locate(input);
    const result = await withSession(server, session => session.request('resources/read', {uri: app.uri}));
    const contents = (Array.isArray(result.contents) ? result.contents : []).map(record).filter((entry): entry is Record<string, unknown> => !!entry);
    const content = contents.find(entry => entry.uri === app.uri) ?? contents[0];
    if (!content) throw new Error(`${app.server} returned nothing for ${app.uri}.`);
    const mime = typeof content.mimeType === 'string' ? content.mimeType.replace(/\s+/g, '').toLowerCase() : '';
    if (mime !== MCP_APP_MIME) throw new Error(`${app.uri} is not an MCP app (its type is ${mime || 'missing'}).`);
    const html = typeof content.text === 'string' ? content.text : typeof content.blob === 'string' ? Buffer.from(content.blob, 'base64').toString('utf8') : '';
    if (!html.trim()) throw new Error(`${app.uri} is empty.`);
    if (Buffer.byteLength(html) > MCP_APP_MAX_BYTES) throw new Error(`${app.uri} is larger than ${MCP_APP_MAX_BYTES / 1_000_000} MB.`);
    const domains = appDomains(content._meta), ui = record(record(content._meta)?.ui);
    const networkRequested = domains.connect.length > 0 || domains.resource.length > 0;
    return {html, uri: app.uri, server: app.server, tool: app.tool, title: `${app.server} / ${app.tool}`,
      toolInput: rowArguments(item.data), toolResult: rowResult(item.data, item.text),
      domains, networkRequested, networkAllowed: networkRequested && record(item.data?.mcpApp)?.networkAllowed === true,
      ...(typeof ui?.prefersBorder === 'boolean' ? {prefersBorder: ui.prefersBorder} : {})};
  };

  const allowNetwork = async (input: Record<string, unknown>) => {
    const view = await open(input);
    if (!view.networkRequested) throw new Error('This app did not ask for network access.');
    const {item} = locate(input);
    update(item, {...item.data, mcpApp: {...record(item.data?.mcpApp), networkAllowed: true}});
    return {networkAllowed: true};
  };

  const callTool = async (input: Record<string, unknown>): Promise<McpCallToolResult> => {
    const {chat, app, server} = locate(input);
    const name = typeof input.name === 'string' ? input.name.slice(0, 200) : '';
    const args = record(input.arguments) ?? {};
    // Always the row's own server: anything else the request names is ignored.
    const declared = (await toolList(server)).find(entry => entry.name === name) ?? (await toolList(server, true)).find(entry => entry.name === name);
    if (!declared || !appMayCall(declared)) throw new Error(`${name || 'That tool'} is not available to the app.`);
    const readOnly = toolReadOnly(declared);
    const verdict = ctx.appToolApproval ? await ctx.appToolApproval(chat.id, {server: app.server, tool: name, arguments: args, readOnly, app: app.tool}) : readOnly ? {allowed: true as const} : {allowed: false as const, reason: 'This tool call needs approval, which is not available here.'};
    if (!verdict.allowed) throw new Error(verdict.reason);
    const result = await withSession(server, session => session.request('tools/call', {name, arguments: args}));
    const json = JSON.stringify(result);
    if (json.length > MAX_RESULT_BYTES) return {content: [{type: 'text', text: `The result of ${name} was too large to pass to the app.`}], isError: true};
    return {content: Array.isArray(result.content) ? result.content : [], ...(result.structuredContent !== undefined ? {structuredContent: result.structuredContent} : {}), ...(result.isError === true ? {isError: true} : {}), ...(record(result._meta) ? {_meta: record(result._meta)} : {})};
  };

  return {
    observe,
    handlers: {'mcp.apps.open': open, 'mcp.apps.allowNetwork': allowNetwork, 'mcp.apps.callTool': callTool},
    /** A server's config changed or it was removed: its session and tool list are stale. */
    forget(id: string) { drop(id); tools.delete(id); },
    dispose() { disposed = true; for (const id of [...sessions.keys()]) drop(id); tools.clear(); },
  };
}
