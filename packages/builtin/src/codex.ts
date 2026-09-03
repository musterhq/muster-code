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
  readonly model?: string;
  readonly reasoning?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  /** Discovered from permissionProfile/list (see listAccessModes); defaults to workspace-write without prompts. */
  readonly access?: AccessMode;
  /** "plan" runs the turn in Codex's plan collaboration mode. */
  readonly mode?: "plan" | "default";
  readonly handlers: CodexTurnHandlers;
}): Promise<CodexTurnResult> {
  const result = await runCodexAppServer({
    prompt: input.prompt,
    cwd: input.cwd,
    ...(input.threadId ? { threadId: input.threadId, cacheKey: `thread:${input.threadId}` } : { cacheKey: `new:${input.cwd}` }),
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    sandbox: input.access?.sandbox ?? "workspace-write",
    ...(input.access ? { approvalPolicy: input.access.approvalPolicy } : {}),
    ...(input.mode === "plan" ? { collaborationMode: { mode: "plan" as const, settings: { model: input.model ?? "", ...(input.reasoning ? { reasoning_effort: input.reasoning } : {}) } } } : {}),
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
    models.push({ id: `claude:${id}`, provider: "claude", name: id.replace(/^claude-/, "Claude ").replace(/-(\d)/g, " $1").replace(/-\d{8}$/, ""), description: "Claude Code · your Claude subscription", efforts: ["low", "medium", "high", "xhigh", "max"].map((e) => ({ id: e, description: "" })), defaultEffort: "medium", isDefault: false });
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
