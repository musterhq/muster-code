import * as vscode from "vscode";
// The Codex side of Muster Code: threads, history, and turns — all through
// muster core's app-server client on the owner's ChatGPT plan.
import {
  discoverCodexSessions,
  readCodexThreadNames,
  readCodexRollout,
  runCodexAppServer,
  interruptActiveCodexTurn, steerActiveCodexTurn, callCodexConversation,
  type CodexSessionSummary,
  type CodexTranscriptMessage,
} from "@musterhq/core";
import { queryCodexAppServer, runClaudeCode } from "@musterhq/core";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join as joinPath, resolve as resolvePath } from "node:path";

export interface CodexThread {
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
  readonly errorMessage?: string;
  readonly tokenUsage?: { readonly inputTokens?: number; readonly outputTokens?: number };
}

const TRANSPORT_OWNER = "muster-code";

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
const BROWSER_NOTE = "The IDE has a built-in browser tab that the user is looking at. Whenever you need a browser (\"open the site\", \"check the page\", \"click\", reproducing or verifying UI work, reading console errors), use the muster_browser MCP tools — browser_navigate, browser_snapshot, browser_click, browser_type, browser_press_key, browser_hover, browser_select_option, browser_screenshot, browser_console_messages, browser_evaluate, browser_wait_for, browser_go_back, browser_reload, browser_tabs — and not other browser automation or computer-use tools unless the user explicitly asks for those. Flow: browser_navigate, read the snapshot, act on the [ref=eN] handles, re-snapshot.";
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
  const instructions = [input.rules ?? "", browserMcp ? BROWSER_NOTE : ""].filter(Boolean).join("\n\n");
  turnHooks.start?.();
  try {
  const result = await runCodexAppServer({
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
    configOverrides: ['model_reasoning_summary="detailed"', ...browserOverrides(), ...disabledMcpServers.map((n) => `mcp_servers.${n}.enabled=false`)],
    onDelta: input.handlers.onDelta,
    onReasoningDelta: input.handlers.onReasoning,
    ...(input.handlers.onEvent ? { onEvent: input.handlers.onEvent } : {}),
    ...(input.handlers.onRequest ? { onRequest: input.handlers.onRequest } : {}),
  });
  return {
    status: result.status,
    text: result.finalMessage,
    ...(result.threadId ? { threadId: result.threadId } : {}),
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    ...(result.tokenUsage ? { tokenUsage: result.tokenUsage } : {}),
  };
  } finally { turnHooks.end?.(); }
}

/** Stop the running turn of one conversation (pane tab), or every turn of this host when none is given. */
/** Type mid-turn: the message joins the running turn (`turn/steer`); false when nothing is running for that conversation. */
export function steerTurn(text: string, conversation?: string): Promise<boolean> {
  return steerActiveCodexTurn(text, TRANSPORT_OWNER, conversation ? `conv:${conversation}` : undefined);
}

export let lastRollbackError = "";
/** `thread/name/set` on the process that owns the thread (or a one-shot when none is warm). */
export async function setThreadName(conversation: string | undefined, threadId: string, name: string, cwd: string): Promise<boolean> {
  try { await callCodexConversation(conversation ? `conv:${conversation}` : `none:${threadId}`, "thread/name/set", { threadId, name }, { transportOwner: TRANSPORT_OWNER, cwd }); return true; }
  catch (error) { lastRollbackError = error instanceof Error ? error.message : String(error); return false; }
}
/** `thread/archive`: the rollout moves to archived_sessions; the History tab stops listing it. */
export async function archiveThread(conversation: string | undefined, threadId: string, cwd: string): Promise<boolean> {
  try { await callCodexConversation(conversation ? `conv:${conversation}` : `none:${threadId}`, "thread/archive", { threadId }, { transportOwner: TRANSPORT_OWNER, cwd }); return true; }
  catch (error) { lastRollbackError = error instanceof Error ? error.message : String(error); return false; }
}
/** Paginated threads: replace the history so that `beforeTurnId` and every later turn are gone (`thread/revert`). */
export async function revertThread(conversation: string, threadId: string, beforeTurnId: string, cwd: string): Promise<boolean> {
  try { await callCodexConversation(`conv:${conversation}`, "thread/revert", { threadId, beforeTurnId }, { transportOwner: TRANSPORT_OWNER, cwd }); return true; }
  catch (error) { lastRollbackError = error instanceof Error ? error.message : String(error); return false; }
}
/** Drop the last N turns of a thread's history (`thread/rollback`); the caller reverts the files from its checkpoints. */
export async function rollbackThread(conversation: string, threadId: string, numTurns: number, cwd: string): Promise<boolean> {
  try { await callCodexConversation(`conv:${conversation}`, "thread/rollback", { threadId, numTurns }, { transportOwner: TRANSPORT_OWNER, cwd }); return true; }
  catch (error) { lastRollbackError = error instanceof Error ? error.message : String(error); return false; }
}

export function interruptTurn(conversation?: string): Promise<boolean> {
  return interruptActiveCodexTurn(TRANSPORT_OWNER, conversation ? `conv:${conversation}` : undefined);
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
export async function cachedQuery(method: string, params: Record<string, unknown> = {}, cwd?: string, options: { ttlMs?: number; refresh?: boolean } = {}): Promise<Record<string, unknown>> {
  const key = `${cwd ?? ""}|${method}|${JSON.stringify(params)}`; const ttl = options.ttlMs ?? 10 * 60_000;
  const entry = catalog.get(key) ?? { at: 0 }; catalog.set(key, entry);
  const fresh = entry.value !== undefined && Date.now() - entry.at < ttl && !options.refresh;
  if (fresh) return entry.value!;
  if (!entry.inflight) {
    entry.inflight = queryCodex(method, params, cwd).then((value) => { entry.value = value; entry.at = Date.now(); persistCatalog(); return value; }).finally(() => { delete entry.inflight; });
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

/** permissionProfile/list → the access modes the app exposes (labels follow the Codex app's names). */
export async function listAccessModes(cwd?: string): Promise<AccessMode[]> {
  const result = await cachedQuery("permissionProfile/list", {}, cwd);
  const data = (result.data as { id?: string; description?: string | null; allowed?: boolean }[] | undefined) ?? [];
  return data.filter((p) => p.id && p.allowed !== false).map((p) => {
    const id = String(p.id);
    const preset = ACCESS_PRESETS[id];
    return { id, label: preset?.label ?? p.description ?? id.replace(/^:/, ""), sandbox: preset?.sandbox ?? "workspace-write", approvalPolicy: preset?.approvalPolicy ?? "on-request" };
  });
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
  try {
    const result = await cachedQuery("model/list", { includeHidden: false }, cwd);
    for (const raw of (result.data as Record<string, unknown>[] | undefined) ?? []) {
      if (raw.hidden) continue;
      const efforts = ((raw.supportedReasoningEfforts as { reasoningEffort?: string; description?: string }[] | undefined) ?? [])
        .map((e) => ({ id: String(e.reasoningEffort ?? ""), description: String(e.description ?? "") })).filter((e) => e.id);
      models.push({ id: String(raw.id ?? raw.model), provider: "codex", name: String(raw.displayName ?? raw.id), description: String(raw.description ?? ""), efforts, defaultEffort: String(raw.defaultReasoningEffort ?? efforts[0]?.id ?? "medium"), isDefault: raw.isDefault === true });
    }
  } catch { /* offline or not signed in: the picker shows what it can */ }
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

/** MCP servers the user switched off in Muster Code (settings → MCP): passed as config overrides, the user's config.toml is untouched. */
export let disabledMcpServers: readonly string[] = [];
export function setDisabledMcpServers(names: readonly string[]): void { disabledMcpServers = names; }

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
