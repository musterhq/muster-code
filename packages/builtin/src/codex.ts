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
  readonly handlers: CodexTurnHandlers;
}): Promise<CodexTurnResult> {
  const result = await runCodexAppServer({
    prompt: input.prompt,
    cwd: input.cwd,
    ...(input.threadId ? { threadId: input.threadId, cacheKey: `thread:${input.threadId}` } : { cacheKey: `new:${input.cwd}` }),
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    sandbox: "workspace-write",
    transportOwner: TRANSPORT_OWNER,
    keepAlive: true,
    configOverrides: ['model_reasoning_summary="detailed"'],
    onDelta: input.handlers.onDelta,
    onReasoningDelta: input.handlers.onReasoning,
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
