/** Small, serializable state. Kept separate from transcripts and provider history. */
export interface ComposerDraft { text: string; context: string[] }
export function cleanDraft(value: unknown): ComposerDraft {
  const v = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return { text: typeof v.text === "string" ? v.text : "", context: Array.isArray(v.context) ? [...new Set(v.context.filter((t): t is string => typeof t === "string" && /^@[\w./:?=&%#+-]+$/.test(t)))] : [] };
}

/** Use reported counts only; missing is unavailable, never a fabricated zero. */
export interface RunUsage { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; reasoningOutputTokens?: number }
export function readUsage(value: unknown): RunUsage {
  const v = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const out: RunUsage = {};
  for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"] as const) {
    const n = v[key]; if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[key] = n;
  }
  return out;
}

/** States persisted by the pane. A disconnected run is recoverable metadata;
 * it is never an instruction to replay a request that may have reached the provider. */
export type RunState = "preparing" | "running" | "waiting" | "disconnected" | "interrupted" | "complete" | "failed";
export interface UsageLedgerEntry extends RunUsage {
  readonly id: string;
  readonly turnId?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly model?: string;
  readonly effort?: string;
}
export interface ActivityRecord {
  readonly id: string;
  readonly ts: number;
  readonly method: string;
  readonly phase?: string;
  readonly itemType?: string;
  readonly itemId?: string;
  readonly summary?: string;
  /** A bounded, JSON-safe projection of provider params for reload/debug UI. */
  readonly data?: Record<string, unknown>;
}
export interface DurableRun {
  readonly id: string;
  readonly state: RunState;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly error?: string;
  readonly dispatched?: boolean;
}

const MAX_ACTIVITY_DATA = 12_000;
/** Make provider event metadata safe to retain in workspace state. */
export function boundedEventData(value: unknown, budget = MAX_ACTIVITY_DATA): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const seen = new WeakSet<object>();
  const clip = (v: unknown, left: { n: number }): unknown => {
    if (left.n <= 0) return "…";
    if (typeof v === "string") { const s = v.slice(0, Math.min(4000, left.n)); left.n -= s.length; return s; }
    if (typeof v === "number" || typeof v === "boolean" || v === null) { left.n -= 16; return v; }
    if (Array.isArray(v)) { const a: unknown[] = []; for (const item of v.slice(0, 32)) { if (left.n <= 0) break; a.push(clip(item, left)); } return a; }
    if (typeof v === "object") {
      if (seen.has(v as object)) return "[circular]";
      seen.add(v as object);
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v as Record<string, unknown>).slice(0, 48)) { if (left.n <= 0) break; out[k] = clip(item, left); }
      return out;
    }
    return String(v);
  };
  const left = { n: Math.max(256, budget) };
  const result = clip(value, left);
  return result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : undefined;
}

/** Stable across a webview reload for lifecycle events; sequence keeps deltas distinct. */
export function activityId(method: string, params: Record<string, unknown>, sequence: number): string {
  const item = params.item && typeof params.item === "object" ? params.item as Record<string, unknown> : {};
  const turn = typeof params.turnId === "string" ? params.turnId : typeof params.turn === "object" && params.turn ? String((params.turn as Record<string, unknown>).id ?? "") : "";
  const itemId = typeof params.itemId === "string" ? params.itemId : typeof item.id === "string" ? item.id : "";
  return `${turn || "turn"}:${itemId || method}:${sequence}`;
}

/** Pure queue primitives used by the pane so cancellation can be tested
 * without a live VS Code host or provider process. */
export function queueMessage(queue: string[], waiters: (() => void)[], text: string, waiter: () => void = () => {}): void {
  if (!text.trim()) return;
  queue.push(text);
  waiters.push(waiter);
}
export function cancelQueuedMessages(queue: string[], waiters: (() => void)[]): number {
  const count = queue.length;
  queue.splice(0);
  waiters.splice(0).forEach((resolve) => resolve());
  return count;
}
export function editLeaseBlocks(owner: { readonly id: string; readonly active: boolean } | undefined, candidateId: string): boolean {
  return !!owner?.active && owner.id !== candidateId;
}

export function uniqueMentions(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(/(?:^|\s)@([\w./:?=&%#+-]+)/g)].map(m => m[1]!.replace(/[.,;:)]+$/, "")))];
}

export function browserUrl(input: string): string {
  const text = input.trim();
  if (!text) throw new Error("Enter a URL to open.");
  const local = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|[\w.-]+:\d+)(?:[:/]|$)/i.test(text);
  const url = new URL(/^https?:\/\//i.test(text) ? text : /^[a-z][a-z\d+.-]*:/i.test(text) && !local ? text : `${local ? "http" : "https"}://${text}`);
  if (!/^https?:$/.test(url.protocol)) throw new Error("The browser supports http and https URLs.");
  return url.href;
}
