import * as vscode from "vscode";
// The Codex side of Muster Code: threads, history, and turns — all through
// muster core's app-server client on the owner's ChatGPT plan.
import {
  discoverCodexSessions,
  readCodexThreadNames,
  readCodexRollout,
  runCodexAppServer,
  interruptActiveCodexTurn, steerActiveCodexTurn, callCodexConversation,
  clearCodexAppServerConversation,
  type CodexSessionSummary,
  type CodexTranscriptMessage,
} from "@musterhq/core";
import { queryCodexAppServer, runClaudeCode } from "@musterhq/core";
import { childControlRequest } from "./agent-control.js";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join as joinPath, resolve as resolvePath } from "node:path";
import { applyProviderDispatch, isDirectModel, PROVIDER_MODELS, providerLabel, providerModelId, resolveProviderRoute, validateSelection, type ProviderId } from "./provider-routing.js";
import { queryProvider } from "./provider-query.js";

export interface CodexThread {
  readonly providerId?: ProviderId;
  readonly model?: string;
  readonly id: string;
  readonly name: string;
  readonly project: string;
  readonly cwd: string;
  readonly filePath: string;
  readonly lastActivityAt: string;
  readonly turnCount: number;
  readonly sizeBytes: number;
  readonly live: boolean;
}

export interface CodexTurnHandlers {
  readonly onDelta: (text: string) => void;
  readonly onReasoning: (text: string) => void;
  /** Raw item/turn notifications — the live edit painter and tool cards feed on these. */
  readonly onEvent?: (method: string, params: Record<string, unknown>) => void;
  /** Approvals / elicitations (computer use, command approval); undefined = decline. */
  readonly onRequest?: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
}

export interface CodexTurnResult {
  readonly status: "completed" | "failed";
  readonly text: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly dispatchState?: "not-dispatched" | "dispatched" | "unknown";
  readonly errorMessage?: string;
  readonly fallbackEligible?: boolean;
  readonly hadActivity?: boolean;
  readonly timings?: { readonly startupMs: number; readonly queueMs: number; readonly threadOpenMs: number; readonly requestToFirstDeltaMs?: number; readonly cacheState: string; readonly threadOpenState: string };
  readonly tokenUsage?: { readonly inputTokens?: number; readonly cachedInputTokens?: number; readonly outputTokens?: number; readonly reasoningOutputTokens?: number };
}

const TRANSPORT_OWNER = "muster-code";
const conversationProviders = new Map<string, ProviderId>();
const runningConversations = new Set<string>();
const conversationScopes = new Map<string, string>();
export function bindConversationProvider(conversation: string, provider: ProviderId): void { conversationProviders.set(conversation, provider); }
function conversationKey(conversation: string): string { const provider = conversationProviders.get(conversation); return `conv:${conversation}${provider ? `:provider:${provider}` : ""}`; }

export function projectLabel(cwd: string): string {
  const label = cwd.replace(/[/\\]+$/, "").split(/[/\\]/).pop();
  return label || "(unknown)";
}

/** Threads the way the Codex app names them, substance-ranked, noise excluded. */
export async function listThreads(limit = 60): Promise<CodexThread[]> {
  const [scan, names] = await Promise.all([
    discoverCodexSessions({ limit, includeSubagents: false, includeExecNoise: false }),
    readCodexThreadNames(),
  ]);
  const now = Date.now();
  const live = (item: CodexSessionSummary): boolean => now - Date.parse(item.lastActivityAt) < 120_000;
  const trivial = (item: CodexSessionSummary): boolean => item.turnCount <= 1 && item.messageCount <= 4;
  const bucket = (item: CodexSessionSummary): number => (live(item) ? 0 : trivial(item) ? 2 : 1);
  return [...scan.sessions]
    .sort((a, b) => bucket(a) - bucket(b) || Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))
    .map((item) => ({
      id: item.threadId,
      ...(item.modelProvider === "openai" ? { providerId: "openai-direct" as const } : item.modelProvider === "hybrow" ? { providerId: "hybrow" as const } : {}),
      ...(item.model ? { model: item.model } : {}),
      name: item.threadName ?? names.get(item.threadId) ?? projectLabel(item.cwd),
      project: projectLabel(item.cwd),
      cwd: item.cwd,
      filePath: item.filePath,
      lastActivityAt: item.lastActivityAt,
      turnCount: item.turnCount,
      sizeBytes: item.sizeBytes,
      live: live(item),
    }));
}

/** Full transcript, newest-preserving on gigabyte rollouts. */
export async function readHistory(thread: CodexThread): Promise<readonly CodexTranscriptMessage[]> {
  const rollout = await readCodexRollout(thread.filePath, { maxBytes: Number.MAX_SAFE_INTEGER, keepTail: true });
  return rollout.messages;
}

/** One turn on an existing thread (or a new one when threadId is undefined). */
// The Muster browser as MCP tools for the agent (browser-mcp.js), launched by the app-server process itself.
let browserMcp: { command: string; args: string[]; env: Record<string, string>; mcpConfig?: string } | null = null;
export function setBrowserMcp(config: { command: string; args: string[]; env: Record<string, string>; mcpConfig?: string } | null): void { browserMcp = config; }
/** Around every agent turn: the browser lock banner and "Take control" reset live here. */
export const turnHooks: { start?: () => void; end?: () => void } = {};
const BROWSER_NOTE = "The IDE has a built-in browser tab the user is looking at. For that tab, prefer muster_browser MCP tools (browser_navigate, browser_snapshot, browser_click, browser_type, browser_press_key, browser_hover, browser_select_option, browser_screenshot, browser_console_messages, browser_evaluate, browser_wait_for, browser_scroll, browser_resize, browser_set_appearance, browser_go_back, browser_reload, browser_tabs). Flow: navigate, snapshot, act on [ref=eN], re-snapshot. For macOS desktop apps, Accessibility, Screen Recording, or anything outside that tab, use the signed-in Codex computer-use plugin (computer-use@openai-bundled / unified-computer-use) the same way Codex desktop does — list apps, snapshot, click, type, scroll, then confirm consequential actions. Use the visualize plugin to save screenshots and embed them as ![alt](path) in the reply. Do not invent a second computer-use path.";
/** Exact plugin tool names; BROWSER_NOTE already points at the plugin. */
const COMPUTER_USE_NOTE = "Codex computer-use plugin tools: listApps, snapshot, click, type, scroll. Visualize screenshots as ![alt](path).";
function browserOverrides(): string[] {
  if (!browserMcp) return [];
  const env = Object.entries(browserMcp.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(", ");
  return [`mcp_servers.muster_browser.command=${JSON.stringify(browserMcp.command)}`, `mcp_servers.muster_browser.args=${JSON.stringify(browserMcp.args)}`, ...(env ? [`mcp_servers.muster_browser.env={ ${env} }`] : [])];
}

export async function runTurn(input: {
  readonly prompt: string;
  readonly cwd: string;
  readonly threadId?: string;
  /** Stable id of the conversation surface (pane tab); keeps one warm process per conversation. */
  readonly conversation?: string;
  readonly model?: string;
  readonly providerId?: ProviderId;
  readonly reasoning?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  /** Discovered from permissionProfile/list (see listAccessModes); defaults to workspace-write without prompts. */
  readonly access?: AccessMode;
  /** "plan" runs the turn in Codex's plan collaboration mode. */
  readonly mode?: "plan" | "default";
  /** Rules for the agent (.muster/rules, .cursor/rules), sent as developer instructions. */
  readonly rules?: string;
  /** Local image paths attached to the prompt. */
  readonly images?: readonly string[];
  readonly handlers: CodexTurnHandlers;
}): Promise<CodexTurnResult> {
  const selection = { modelId: input.model ?? "openai-direct:gpt-5.6-terra", ...(input.providerId ? { providerId: input.providerId } : {}) };
  const route = validateSelection(selection);
  if (input.conversation && runningConversations.has(input.conversation)) throw new Error("This task already has an active provider run.");
  const previousProvider = input.conversation ? conversationProviders.get(input.conversation) : undefined;
  if (input.threadId && previousProvider && previousProvider !== route.providerId) throw new Error("Task provider mismatch. Start a new task to change providers.");
  if (input.conversation) runningConversations.add(input.conversation);
  if (input.conversation) bindConversationProvider(input.conversation, route.providerId);
  const instructions = [input.rules ?? "", COMPUTER_USE_NOTE, browserMcp ? BROWSER_NOTE : ""].filter(Boolean).join("\n\n");
  turnHooks.start?.();
  try {
  if (input.conversation) {
    const scope = JSON.stringify([route.providerId, route.model, input.reasoning, input.access, browserOverrides(), mcpDisableOverrides()]);
    const previous = conversationScopes.get(input.conversation);
    if (previous && previous !== scope) clearCodexAppServerConversation(conversationKey(input.conversation), TRANSPORT_OWNER);
    conversationScopes.set(input.conversation, scope);
  }
  const result = await runCodexAppServer(applyProviderDispatch({
    prompt: input.prompt,
    cwd: input.cwd,
    // One warm app-server process per conversation (pane tab): the process that started a thread is its
    // writer, and a second process resuming it would be refused ("already has an active writer").
    ...(input.threadId ? { threadId: input.threadId } : {}),
    cacheKey: input.conversation ? `conv:${input.conversation}` : input.threadId ? `thread:${input.threadId}` : `new:${input.cwd}:${Date.now().toString(36)}`,
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    ...(instructions ? { developerInstructions: instructions } : {}),
    ...(input.images?.length ? { images: input.images } : {}),
    sandbox: input.access?.sandbox ?? "workspace-write",
    ...(input.access ? { approvalPolicy: input.access.approvalPolicy } : {}),
    // Codex keeps a thread in its last collaboration mode: say which one on every turn (plan → no edits; default → agent).
    ...(input.mode && input.model ? { collaborationMode: { mode: input.mode, settings: { model: input.model, ...(input.reasoning ? { reasoning_effort: input.reasoning } : {}) } } } : {}),
    transportOwner: TRANSPORT_OWNER,
    keepAlive: true,
    // Core's buildCodexAppServerArgs only adds these as -c; it already loads ~/.codex plugins.
    configOverrides: [`model_reasoning_summary=${JSON.stringify(vscode.workspace.getConfiguration("muster").get<string>("codex.reasoningSummary", "detailed"))}`, ...browserOverrides(), ...mcpDisableOverrides()],
    onDelta: input.handlers.onDelta,
    onReasoningDelta: input.handlers.onReasoning,
    ...(input.handlers.onEvent ? { onEvent: input.handlers.onEvent } : {}),
    ...(input.handlers.onRequest ? { onRequest: input.handlers.onRequest } : {}),
  }, route, input.conversation));
  return {
    status: result.status,
    text: result.finalMessage,
    ...(result.threadId ? { threadId: result.threadId } : {}),
    ...(result.turnId ? { turnId: result.turnId } : {}),
    ...(result.dispatchState ? { dispatchState: result.dispatchState } : {}),
    ...(result.errorMessage ? { errorMessage: `${providerLabel(route.providerId)}: ${result.errorMessage}` } : {}),
    ...(result.fallbackEligible !== undefined ? { fallbackEligible: result.fallbackEligible } : {}),
    ...(result.hadActivity !== undefined ? { hadActivity: result.hadActivity } : {}),
    ...(result.timings ? { timings: result.timings } : {}),
    ...(result.tokenUsage ? { tokenUsage: result.tokenUsage } : {}),
  };
  } finally { if (input.conversation) runningConversations.delete(input.conversation); turnHooks.end?.(); }
}

/** Stop the running turn of one conversation (pane tab), or every turn of this host when none is given. */
/** Type mid-turn: the message joins the running turn (`turn/steer`); false when nothing is running for that conversation. */
export function steerTurn(text: string, conversation?: string): Promise<boolean> {
  return steerActiveCodexTurn(text, TRANSPORT_OWNER, conversation ? conversationKey(conversation) : undefined);
}

/** Control a provider-created child through the warm parent conversation that owns it. */
export async function controlOwnedTurn(conversation: string, threadId: string, turnId: string, action: "steer" | "interrupt", text: string | undefined, cwd: string): Promise<{ ok: boolean; reason?: string; capability?: boolean }> {
  if (!conversation || !threadId || !turnId) return { ok: false, reason: "An owning conversation and active turn ID are required." };
  const request = childControlRequest(threadId, turnId, action, text);
  try {
    await callCodexConversation(conversationKey(conversation), request.method, request.params, { transportOwner: TRANSPORT_OWNER, cwd, requireOwner: true });
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason, ...( /unsupported|unknown method|capabilit|not supported/i.test(reason) ? { capability: true } : {}) };
  }
}

/** Call a management method on a loaded thread's actual warm owner; never fall back to a new writer. */
export function callOwnedThread(conversation: string, threadId: string, method: string, params: Record<string, unknown>, cwd: string): Promise<Record<string, unknown>> {
  return callCodexConversation(conversationKey(conversation), method, params, { transportOwner: TRANSPORT_OWNER, cwd, requireOwner: true });
}

export let lastRollbackError = "";
async function manageThread(conversation: string | undefined, method: string, params: Record<string, unknown>, cwd: string): Promise<Record<string, unknown>> {
  if (conversation) {
    try { return await callCodexConversation(conversationKey(conversation), method, params, { transportOwner: TRANSPORT_OWNER, cwd, requireOwner: true }); }
    catch (error) { if (!(error instanceof Error) || !error.message.startsWith("No live app-server owner")) throw error; }
    const provider = conversationProviders.get(conversation);
    if (provider) return queryProvider(resolveProviderRoute(provider, provider === "hybrow" ? "codex/gpt-5.6-terra" : "gpt-5.6-terra"), method, params, cwd);
  }
  // These metadata-only operations never start or resume a turn.
  return queryCodex(method, params, cwd);
}
/** `thread/name/set` on the process that owns the thread (or a one-shot when none is warm). */
export async function setThreadName(conversation: string | undefined, threadId: string, name: string, cwd: string): Promise<boolean> {
  try { await manageThread(conversation, "thread/name/set", { threadId, name }, cwd); return true; }
  catch (error) { lastRollbackError = error instanceof Error ? error.message : String(error); return false; }
}
/** `thread/archive`: the rollout moves to archived_sessions; the History tab stops listing it. */
export async function archiveThread(conversation: string | undefined, threadId: string, cwd: string): Promise<boolean> {
  try { await manageThread(conversation, "thread/archive", { threadId }, cwd); return true; }
  catch (error) { lastRollbackError = error instanceof Error ? error.message : String(error); return false; }
}
/** Paginated threads: replace the history so that `beforeTurnId` and every later turn are gone (`thread/revert`). */
export async function revertThread(conversation: string, threadId: string, beforeTurnId: string, cwd: string): Promise<boolean> {
  try { await manageThread(conversation, "thread/revert", { threadId, beforeTurnId }, cwd); return true; }
  catch (error) { lastRollbackError = error instanceof Error ? error.message : String(error); return false; }
}
/** Drop the last N turns of a thread's history (`thread/rollback`); the caller reverts the files from its checkpoints. */
export async function rollbackThread(conversation: string, threadId: string, numTurns: number, cwd: string): Promise<boolean> {
  try { await manageThread(conversation, "thread/rollback", { threadId, numTurns }, cwd); return true; }
  catch (error) { lastRollbackError = error instanceof Error ? error.message : String(error); return false; }
}

export function interruptTurn(conversation?: string): Promise<boolean> {
  return interruptActiveCodexTurn(TRANSPORT_OWNER, conversation ? conversationKey(conversation) : undefined);
}

export function formatAge(iso: string, nowMs = Date.now()): string {
  const seconds = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

export function formatSize(bytes: number): string {
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/** Ask the app-server directly (model/list, permissionProfile/list, thread/list, skills/list…). Nothing is hardcoded from these answers. */
// ── catalog cache ──
// A one-shot app-server process costs seconds (it loads the user's plugins and, for mcpServerStatus/list,
// connects every MCP server). Catalog answers change rarely, so they are served from a persisted cache
// and revalidated in the background — settings and pickers open instantly after the first run.
interface CatalogEntry { at: number; value?: Record<string, unknown>; inflight?: Promise<Record<string, unknown>> }
const catalog = new Map<string, CatalogEntry>();
let catalogStore: vscode.Memento | undefined;
export function useCatalogStore(store: vscode.Memento): void {
  catalogStore = store;
  for (const [k, v] of Object.entries(store.get<Record<string, { at: number; value: Record<string, unknown> }>>("muster.catalog", {}))) if (!catalog.has(k)) catalog.set(k, { at: v.at, value: v.value });
}
function persistCatalog(): void {
  if (!catalogStore) return;
  const out: Record<string, { at: number; value: Record<string, unknown> }> = {};
  for (const [k, v] of catalog) if (v.value !== undefined && JSON.stringify(v.value).length < 400_000) out[k] = { at: v.at, value: v.value };
  void catalogStore.update("muster.catalog", out);
}
export function catalogAge(method: string, params: Record<string, unknown> = {}, cwd?: string): number | undefined { const e = catalog.get(`${cwd ?? ""}|${method}|${JSON.stringify(params)}`); return e?.value !== undefined ? Date.now() - e.at : undefined; }
/** Cached one-shot query: fresh → cached; stale → cached now, refreshed in the background; empty → wait for the process. */
export async function cachedQuery(method: string, params: Record<string, unknown> = {}, cwd?: string, options: { ttlMs?: number; refresh?: boolean; providerId?: ProviderId } = {}): Promise<Record<string, unknown>> {
  const key = `${options.providerId ? `provider:${options.providerId}|` : ""}${cwd ?? ""}|${method}|${JSON.stringify(params)}`; const ttl = options.ttlMs ?? 10 * 60_000;
  const entry = catalog.get(key) ?? { at: 0 }; catalog.set(key, entry);
  const fresh = entry.value !== undefined && Date.now() - entry.at < ttl && !options.refresh;
  if (fresh) return entry.value!;
  if (!entry.inflight) {
    const request = options.providerId ? queryProvider(resolveProviderRoute(options.providerId, options.providerId === "hybrow" ? "codex/gpt-5.6-terra" : "gpt-5.6-terra"), method, params, cwd) : queryCodex(method, params, cwd);
    entry.inflight = request.then((value) => { entry.value = value; entry.at = Date.now(); persistCatalog(); return value; }).finally(() => { delete entry.inflight; });
    entry.inflight.catch(() => undefined);
  }
  if (entry.value !== undefined && !options.refresh) return entry.value;
  return entry.inflight;
}
/** Warm the catalog in the background (activation): models, access modes, skills, plugins and MCP status. */
export function prefetchCatalog(cwd: string): void {
  // One process at a time, most useful first; fresh entries cost nothing. mcpServerStatus/list goes last (it connects every MCP server).
  void (async () => {
    for (const [method, params] of [["model/list", { includeHidden: false }], ["permissionProfile/list", {}], ["account/read", {}], ["account/rateLimits/read", {}], ["skills/list", {}], ["plugin/list", {}], ["hooks/list", {}], ["mcpServerStatus/list", {}]] as const) {
      await cachedQuery(method, params as Record<string, unknown>, cwd).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
}

export async function queryCodex(method: string, params: Record<string, unknown> = {}, cwd?: string): Promise<Record<string, unknown>> {
  return queryCodexAppServer(method, params, { ...(cwd ? { cwd } : {}) });
}

// ── Discovery: nothing below is a fixed list; the app-server answers are the truth. ──

export interface AccessMode {
  readonly id: string;
  readonly label: string;
  readonly sandbox: "read-only" | "workspace-write" | "danger-full-access";
  readonly approvalPolicy: "untrusted" | "on-request" | "never";
}

const ACCESS_PRESETS: Record<string, Omit<AccessMode, "id">> = {
  ":read-only": { label: "Read only", sandbox: "read-only", approvalPolicy: "on-request" },
  ":workspace": { label: "Manual approval", sandbox: "workspace-write", approvalPolicy: "on-request" },
  ":danger-full-access": { label: "Full access", sandbox: "danger-full-access", approvalPolicy: "never" },
};

/** Map an app-server permission profile onto sandbox + approval policy. */
export function normalizeAccessMode(id: string, description?: string | null): AccessMode {
  const colon = id.startsWith(":") ? id : `:${id}`;
  const preset = ACCESS_PRESETS[id] ?? ACCESS_PRESETS[colon];
  if (preset) return { id, ...preset };
  const blob = `${id} ${description ?? ""}`.toLowerCase();
  if (/danger-full-access|full[\s_-]*access/.test(blob)) return { id, label: description?.trim() || "Full access", sandbox: "danger-full-access", approvalPolicy: "never" };
  if (/read-only|read only/.test(blob)) return { id, label: description?.trim() || "Read only", sandbox: "read-only", approvalPolicy: "on-request" };
  if (/workspace/.test(blob)) return { id, label: description?.trim() || "Manual approval", sandbox: "workspace-write", approvalPolicy: "on-request" };
  return { id, label: description?.trim() || id.replace(/^:/, ""), sandbox: "workspace-write", approvalPolicy: "on-request" };
}

/** Full access / never: the host must not pause the turn on command or patch cards. */
export function isUnattendedAccess(access?: Pick<AccessMode, "sandbox" | "approvalPolicy">): boolean {
  return access?.approvalPolicy === "never" || access?.sandbox === "danger-full-access";
}

/** permissionProfile/list → the access modes the app exposes (labels follow the Codex app's names). */
export async function listAccessModes(cwd?: string): Promise<AccessMode[]> {
  const result = await cachedQuery("permissionProfile/list", {}, cwd);
  const data = (result.data as { id?: string; description?: string | null; allowed?: boolean }[] | undefined) ?? [];
  return data.filter((p) => p.id && p.allowed !== false).map((p) => normalizeAccessMode(String(p.id), p.description));
}

/** Claude Code's own effort levels (`claude --effort low|medium|high|xhigh|max`); Codex efforts come from model/list per model. */
export const CLAUDE_EFFORTS: { readonly id: string; readonly description: string }[] = [
  { id: "low", description: "Fast, lighter reasoning" },
  { id: "medium", description: "Balanced speed and depth" },
  { id: "high", description: "Deeper reasoning" },
  { id: "xhigh", description: "Extra high reasoning depth" },
  { id: "max", description: "Maximum reasoning" },
];

export interface PluginInfo { readonly name: string; readonly kind: "plugin" | "mcp"; readonly detail: string }

/** plugin/list + mcpServerStatus/list: what Codex has loaded for this folder — the same config the Codex app uses. */
export async function listPlugins(cwd?: string): Promise<PluginInfo[]> {
  const out: PluginInfo[] = [];
  const rows = (result: Record<string, unknown>): Record<string, unknown>[] => {
    const seen: Record<string, unknown>[] = [];
    const walk = (v: unknown): void => { if (Array.isArray(v)) { for (const x of v) walk(x); return; } if (v && typeof v === "object") { const r = v as Record<string, unknown>; if (typeof r.name === "string" || typeof r.id === "string") seen.push(r); for (const k of ["data", "items", "plugins", "servers"]) if (k in r) walk(r[k]); } };
    walk(result); return seen;
  };
  try { for (const r of rows(await cachedQuery("plugin/list", {}, cwd))) out.push({ name: String(r.name ?? r.id), kind: "plugin", detail: [r.version, r.enabled === false ? "disabled" : r.enabled === true ? "enabled" : "", r.description].filter(Boolean).join(" · ") }); } catch { /* no plugin support */ }
  try { for (const r of rows(await cachedQuery("mcpServerStatus/list", {}, cwd))) out.push({ name: String(r.name ?? r.id), kind: "mcp", detail: [r.status ?? r.state, Array.isArray(r.tools) ? `${r.tools.length} tools` : ""].filter(Boolean).join(" · ") }); } catch { /* no MCP */ }
  return out;
}

export interface ModelInfo {
  readonly providerId?: ProviderId;
  readonly id: string;
  readonly provider: "codex" | "claude";
  readonly name: string;
  readonly description: string;
  readonly efforts: { readonly id: string; readonly description: string }[];
  readonly defaultEffort: string;
  readonly isDefault: boolean;
}

/** model/list (Codex, with each model's own reasoning efforts) + the Claude models the user configured. */
export async function listModels(cwd?: string, claudeModels: readonly string[] = []): Promise<ModelInfo[]> {
  const models: ModelInfo[] = [];
  for (const providerId of ["openai-direct", "hybrow"] as const) try {
    const result = await cachedQuery("model/list", { includeHidden: false }, cwd, { providerId });
    for (const raw of (result.data as Record<string, unknown>[] | undefined) ?? []) {
      if (raw.hidden) continue;
      const id = String(raw.model ?? raw.id);
      if (!(providerId === "openai-direct" ? isDirectModel(id) : PROVIDER_MODELS.some(entry => entry.providerId === providerId && entry.model === id))) continue;
      const efforts = ((raw.supportedReasoningEfforts as { reasoningEffort?: string; description?: string }[] | undefined) ?? [])
        .map((e) => ({ id: String(e.reasoningEffort ?? ""), description: String(e.description ?? "") })).filter((e) => e.id);
      models.push({ id: providerModelId(providerId, id), provider: "codex", providerId, name: String(raw.displayName ?? raw.id), description: String(raw.description ?? ""), efforts, defaultEffort: String(raw.defaultReasoningEffort ?? efforts[0]?.id ?? "medium"), isDefault: providerId === "openai-direct" && raw.isDefault === true });
    }
  } catch { /* Preserve the failed provider as selectable explicit routes: dispatch reports its configuration error. */ }
  for (const definition of PROVIDER_MODELS) if (!models.some(model => model.id === providerModelId(definition.providerId, definition.model))) {
    models.push({ id: providerModelId(definition.providerId, definition.model), provider: "codex", providerId: definition.providerId, name: definition.name, description: `${definition.description}. Catalog unavailable; dispatch will validate the profile.`, efforts: [], defaultEffort: definition.defaultEffort, isDefault: definition.providerId === "openai-direct" && definition.isDefault === true });
  }
  for (const id of claudeModels) {
    models.push({ id: `claude:${id}`, provider: "claude", name: claudeName(id), description: "Claude Code · your Claude subscription", efforts: CLAUDE_EFFORTS, defaultEffort: "medium", isDefault: false });
  }
  return models;
}

/** A Claude Code turn through muster core (headless CLI), shaped like a Codex turn for the pane. */
export async function runClaudeTurn(input: { readonly prompt: string; readonly cwd: string; readonly model: string; readonly effort?: string; readonly sessionId?: string; readonly resume?: boolean; readonly handlers: CodexTurnHandlers }): Promise<CodexTurnResult> {
  const effort = input.effort && ["low", "medium", "high", "xhigh", "max"].includes(input.effort) ? (input.effort as "low" | "medium" | "high" | "xhigh" | "max") : undefined;
  // The browser tools reach Claude turns through Claude Code's own MCP config; the note tells it they exist.
  const raw = (await runClaudeCode({ prompt: input.prompt, cwd: input.cwd, model: input.model, ...(effort ? { effort } : {}), ...(input.sessionId ? { sessionId: input.sessionId, resume: input.resume === true } : {}), ...(browserMcp?.mcpConfig ? { mcpConfig: browserMcp.mcpConfig, allowedTools: ["mcp__muster_browser"], systemPrompt: BROWSER_NOTE } : {}) })) as unknown as Record<string, unknown>;
  const text = String(raw.text ?? raw.output ?? raw.finalMessage ?? raw.response ?? "");
  if (text) input.handlers.onDelta(text);
  const failed = raw.status === "failed" || raw.ok === false;
  return { status: failed ? "failed" : "completed", ...(typeof raw.errorMessage === "string" ? { errorMessage: raw.errorMessage } : {}), ...(input.sessionId ? { threadId: input.sessionId } : {}) } as unknown as CodexTurnResult;
}

/** Privacy: only threads that belong to the open folder(s) are visible or openable. */
export function threadsForWorkspace<T extends { readonly cwd: string }>(threads: readonly T[], folders: readonly string[]): T[] {
  if (!folders.length) return [];
  const roots = folders.map((f) => resolvePath(f).replace(/\/+$/, ""));
  return threads.filter((t) => {
    const cwd = resolvePath(t.cwd || "/").replace(/\/+$/, "");
    return roots.some((root) => cwd === root || cwd.startsWith(`${root}/`));
  });
}

/** A rule file with Cursor's kinds: Always · Auto Attached (globs) · Agent Requested (description) · Manual. */
export interface RuleFile { readonly name: string; readonly path: string; readonly source: "muster" | "cursor"; readonly kind: "always" | "auto" | "agent" | "manual"; readonly description: string; readonly globs: string[]; readonly body: string }
export function listRuleFiles(cwd: string): RuleFile[] {
  const out: RuleFile[] = [];
  for (const [dir, source] of [[joinPath(cwd, ".muster", "rules"), "muster"], [joinPath(cwd, ".cursor", "rules"), "cursor"]] as const) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const path = joinPath(dir, name);
      if (!/\.(md|mdc)$/.test(name) || !statSync(path).isFile()) continue;
      const raw = readFileSync(path, "utf8"); const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw); const body = raw.replace(/^---[\s\S]*?---\r?\n?/, "").trim();
      const field = (k: string) => (fm ? (new RegExp(`^${k}:\\s*(.*)$`, "m").exec(fm[1]!)?.[1] ?? "").trim() : "");
      const globs = field("globs").replace(/^\[|\]$/g, "").split(",").map((g) => g.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      const always = /^true$/i.test(field("alwaysApply")); const description = field("description").replace(/^["']|["']$/g, "");
      const kind: RuleFile["kind"] = always ? "always" : globs.length ? "auto" : description ? "agent" : fm ? "manual" : "always";
      out.push({ name: name.replace(/\.(md|mdc)$/, ""), path, source, kind, description, globs, body });
    }
  }
  return out;
}
function globToRegExp(glob: string): RegExp {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(?:.*/)?").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\?/g, ".");
  return new RegExp(`(^|/)${re}$`);
}
/**
 * Rules for the agent, the way Cursor attaches them: Always rules go every turn; Auto rules when a mentioned
 * file matches their globs; Agent rules as a one-line offer (`@rule:name` loads them); Manual only when mentioned.
 * Disabled rules (settings → Rules) never go.
 */
export function readRules(cwd: string, options: { readonly disabled?: readonly string[]; readonly mentioned?: readonly string[] } = {}): string {
  const disabled = new Set(options.disabled ?? []); const mentioned = options.mentioned ?? [];
  const parts: string[] = [];
  for (const r of listRuleFiles(cwd)) {
    if (disabled.has(r.name) || !r.body) continue;
    const named = mentioned.includes(`rule:${r.name}`) || mentioned.includes("rules");
    if (r.kind === "always" || named) parts.push(`# Rule: ${r.name}\n${r.body}`);
    else if (r.kind === "auto" && r.globs.some((g) => { const re = globToRegExp(g); return mentioned.some((m) => re.test(m.replace(/:\d+-\d+$/, ""))); })) parts.push(`# Rule: ${r.name} (auto-attached for ${r.globs.join(", ")})\n${r.body}`);
    else if (r.kind === "agent") parts.push(`# Available rule: ${r.name} — ${r.description}. Ask for it with @rule:${r.name} when relevant.`);
  }
  return parts.join("\n\n");
}

/**
 * Bundled Codex computer-use MCP names. Keep them enabled on Muster turns.
 * Never emit mcp_servers.<name>.enabled=false for these. The default disabled
 * list is empty; a Settings toggle of these names is ignored so they stay on
 * even when they share a name with the unused user MCP
 * `[mcp_servers.computer-use] enabled = false` in ~/.codex/config.toml (never
 * written here). Plugin enable already lives in that host file as
 * `[plugins."computer-use@openai-bundled"]` / unified-computer-use / visualize;
 * sibling core only forwards caller -c overrides and does not disable plugins.
 */
export const HOST_COMPUTER_USE_MCP = ["computer-use", "unified-computer-use", "visualize", "cua_repl", "node_repl"] as const;
function isHostComputerUseMcp(name: string): boolean {
  const n = name.trim().toLowerCase();
  return HOST_COMPUTER_USE_MCP.some((id) => n === id || n.startsWith(`${id}@`));
}
/** MCP servers the user switched off in Muster Code (settings → MCP): passed as config overrides, the user's config.toml is untouched. */
export let disabledMcpServers: readonly string[] = [];
export function setDisabledMcpServers(names: readonly string[]): void { disabledMcpServers = names; }
export function mcpDisableOverrides(names: readonly string[] = disabledMcpServers): string[] {
  // Allow-list: skip bundled computer-use names so a Settings toggle (or a
  // collision with the disabled user MCP of the same name) cannot turn the
  // host plugin off. Honor muster.mcp.disabled for every other server.
  return names.filter((n) => !isHostComputerUseMcp(n)).map((n) => `mcp_servers.${n}.enabled=false`);
}

export interface SkillInfo { readonly name: string; readonly description: string; readonly path?: string }

/** skills/list → the skills Codex knows for this folder ("/" in the composer). */
export async function listSkills(cwd?: string): Promise<SkillInfo[]> {
  try {
    const result = await cachedQuery("skills/list", {}, cwd);
    const raw = (result.data ?? result.skills ?? []) as unknown;
    const flat: Record<string, unknown>[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) { for (const v of value) walk(v); return; }
      if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (typeof record.name === "string") flat.push(record);
        for (const key of ["skills", "items", "data"]) if (key in record) walk(record[key]);
      }
    };
    walk(raw);
    return flat.map((s) => ({ name: String(s.name), description: String(s.description ?? s.summary ?? ""), ...(typeof s.path === "string" ? { path: s.path } : typeof s.location === "string" ? { path: s.location } : {}) }));
  } catch { return []; }
}

/** "claude-fable-5-1" → "Claude Fable 5.1", "claude-haiku-4-5-20251001" → "Claude Haiku 4.5". */
function claudeName(id: string): string {
  const parts = id.replace(/-\d{8}$/, "").split("-");
  const words: string[] = [];
  const digits: string[] = [];
  for (const part of parts) { if (/^\d+$/.test(part)) digits.push(part); else words.push(part[0]!.toUpperCase() + part.slice(1)); }
  return `${words.join(" ")}${digits.length ? ` ${digits.join(".")}` : ""}`;
}
