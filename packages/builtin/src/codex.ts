// The Codex side of Muster Code: threads, history, and turns — all through
// muster core's app-server client on the owner's ChatGPT plan.
import {
  discoverCodexSessions,
  readCodexThreadNames,
  readCodexRollout,
  runCodexAppServer,
  interruptActiveCodexTurn,
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
  const result = await runCodexAppServer({
    prompt: input.prompt,
    cwd: input.cwd,
    // One warm app-server process per conversation (pane tab): the process that started a thread is its
    // writer, and a second process resuming it would be refused ("already has an active writer").
    ...(input.threadId ? { threadId: input.threadId } : {}),
    cacheKey: input.conversation ? `conv:${input.conversation}` : input.threadId ? `thread:${input.threadId}` : `new:${input.cwd}:${Date.now().toString(36)}`,
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    ...(input.rules ? { developerInstructions: input.rules } : {}),
    ...(input.images?.length ? { images: input.images } : {}),
    sandbox: input.access?.sandbox ?? "workspace-write",
    ...(input.access ? { approvalPolicy: input.access.approvalPolicy } : {}),
    // Codex keeps a thread in its last collaboration mode: say which one on every turn (plan → no edits; default → agent).
    ...(input.mode && input.model ? { collaborationMode: { mode: input.mode, settings: { model: input.model, ...(input.reasoning ? { reasoning_effort: input.reasoning } : {}) } } } : {}),
    transportOwner: TRANSPORT_OWNER,
    keepAlive: true,
    configOverrides: ['model_reasoning_summary="detailed"'],
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
}

export function interruptTurn(): Promise<boolean> {
  return interruptActiveCodexTurn(TRANSPORT_OWNER);
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
  const result = await queryCodex("permissionProfile/list", {}, cwd);
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
  try { for (const r of rows(await queryCodex("plugin/list", {}, cwd))) out.push({ name: String(r.name ?? r.id), kind: "plugin", detail: [r.version, r.enabled === false ? "disabled" : r.enabled === true ? "enabled" : "", r.description].filter(Boolean).join(" · ") }); } catch { /* no plugin support */ }
  try { for (const r of rows(await queryCodex("mcpServerStatus/list", {}, cwd))) out.push({ name: String(r.name ?? r.id), kind: "mcp", detail: [r.status ?? r.state, Array.isArray(r.tools) ? `${r.tools.length} tools` : ""].filter(Boolean).join(" · ") }); } catch { /* no MCP */ }
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
    const result = await queryCodex("model/list", { includeHidden: false }, cwd);
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
  const raw = (await runClaudeCode({ prompt: input.prompt, cwd: input.cwd, model: input.model, ...(effort ? { effort } : {}), ...(input.sessionId ? { sessionId: input.sessionId, resume: input.resume === true } : {}) })) as unknown as Record<string, unknown>;
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

/** Rules for the agent: .muster/rules/*.md and Cursor's .cursor/rules/*.mdc, concatenated. */
export function readRules(cwd: string): string {
  const parts: string[] = [];
  for (const dir of [joinPath(cwd, ".muster", "rules"), joinPath(cwd, ".cursor", "rules")]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const path = joinPath(dir, name);
      if (!/\.(md|mdc)$/.test(name) || !statSync(path).isFile()) continue;
      const text = readFileSync(path, "utf8").replace(/^---[\s\S]*?---\n/, "").trim();
      if (text) parts.push(`# Rule: ${name}\n${text}`);
    }
  }
  return parts.join("\n\n");
}

export interface SkillInfo { readonly name: string; readonly description: string }

/** skills/list → the skills Codex knows for this folder ("/" in the composer). */
export async function listSkills(cwd?: string): Promise<SkillInfo[]> {
  try {
    const result = await queryCodex("skills/list", {}, cwd);
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
    return flat.map((s) => ({ name: String(s.name), description: String(s.description ?? s.summary ?? "") }));
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
