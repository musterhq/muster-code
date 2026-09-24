/**
 * Codex app-server native thread APIs (goals, queue, projects) behind a capability probe.
 *
 * Muster delegates a feature to the app-server only when the chat's live Codex session answers
 * the family's probe method. A definite "the server does not have this" (JSON-RPC method not
 * found, unknown variant) is cached per provider binding; a feature that is merely switched off
 * for this launch ("goals feature is disabled") or a transport failure is not cached, so the
 * next session can try again. Every caller keeps Muster's own implementation as the fallback.
 */

export type NativeFamily = 'goals' | 'queue' | 'projects';

/** The chat has no live Codex app-server session (adapter route, cold chat, retired session). */
export class NativeUnavailableError extends Error {
  constructor(message = 'No live Codex app-server session holds this chat.') { super(message); this.name = 'NativeUnavailableError'; }
}

export interface NativeThreadBridge {
  /** Thread identity of the chat's live Codex session, or undefined when there is none. */
  thread(chatId: string): { threadId: string; providerId: string; bindingId: string } | undefined;
  /** Calls a method on the chat's live session (the thread's single writer). Throws NativeUnavailableError when none. */
  call(chatId: string, method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  /** Whether the chat's app-server supports a method family. Never throws. */
  supports(chatId: string, family: NativeFamily): Promise<boolean>;
  /** Host-level call that is not tied to a chat (project/*). Absent when no Codex route is configured. */
  query?(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
}

export type ProbeVerdict = 'supported' | 'unsupported' | 'unavailable';

/** Classifies a native call failure: the server lacks the method (cache it) vs. it is off or unreachable right now. */
export function classifyNativeError(error: unknown): 'missing' | 'disabled' | 'other' {
  const record = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : {};
  const message = typeof record.message === 'string' ? record.message : String(error);
  if (record.code === -32601 || /method not found|unknown method|unknown variant|unrecognized method|not implemented/i.test(message)) return 'missing';
  if (/feature is disabled|feature disabled|experimental api|requires experimental|not enabled/i.test(message)) return 'disabled';
  return 'other';
}

const PROBES: Record<NativeFamily, (threadId: string) => { method: string; params: Record<string, unknown>; host?: boolean }> = {
  goals: threadId => ({ method: 'thread/goal/get', params: { threadId } }),
  queue: threadId => ({ method: 'thread/queue/list', params: { threadId, limit: 1 } }),
  projects: () => ({ method: 'project/list', params: { limit: 1 }, host: true }),
};

/**
 * Builds the bridge from a provider's per-chat session accessors. `missing` caches are keyed by
 * provider binding: another account or binary may support the family.
 */
export function createNativeThreadBridge(options: {
  thread(chatId: string): { threadId: string; providerId: string; bindingId: string } | undefined;
  call(chatId: string, method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  query?(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
}): NativeThreadBridge & { forget(): void } {
  const verdicts = new Map<string, boolean>();
  const inflight = new Map<string, Promise<ProbeVerdict>>();
  async function probe(chatId: string, family: NativeFamily): Promise<ProbeVerdict> {
    const probeSpec = PROBES[family];
    const identity = options.thread(chatId);
    if (probeSpec('').host) {
      if (!options.query) return 'unavailable';
    } else if (!identity) return 'unavailable';
    const cacheKey = `${family}\0${probeSpec('').host ? 'host' : `${identity!.providerId}\0${identity!.bindingId}`}`;
    const known = verdicts.get(cacheKey);
    if (known !== undefined) return known ? 'supported' : 'unsupported';
    const running = inflight.get(cacheKey);
    if (running) return running;
    const task = (async (): Promise<ProbeVerdict> => {
      const spec = probeSpec(identity?.threadId ?? '');
      try {
        if (spec.host) await options.query!(spec.method, spec.params, 5_000);
        else await options.call(chatId, spec.method, spec.params, 5_000);
        verdicts.set(cacheKey, true);
        return 'supported';
      } catch (error) {
        if (error instanceof NativeUnavailableError) return 'unavailable';
        const kind = classifyNativeError(error);
        if (kind === 'missing') { verdicts.set(cacheKey, false); return 'unsupported'; }
        return kind === 'disabled' ? 'unsupported' : 'unavailable';
      }
    })().finally(() => inflight.delete(cacheKey));
    inflight.set(cacheKey, task);
    return task;
  }
  return {
    thread: options.thread,
    call: options.call,
    ...(options.query ? { query: options.query } : {}),
    async supports(chatId, family) { try { return (await probe(chatId, family)) === 'supported'; } catch { return false; } },
    forget() { verdicts.clear(); },
  };
}

/** Codex `ThreadGoal` (camelCase statuses) → Muster's stored snake_case status. */
export function goalStatusFromCodex(value: unknown): 'active' | 'paused' | 'blocked' | 'usage_limited' | 'budget_limited' | 'complete' | undefined {
  switch (value) {
    case 'active': case 'paused': case 'blocked': case 'complete': return value;
    case 'usageLimited': case 'usage_limited': return 'usage_limited';
    case 'budgetLimited': case 'budget_limited': return 'budget_limited';
    default: return undefined;
  }
}

/** Muster status → the value `thread/goal/set` accepts. Only the user-settable ones are ever sent. */
export function goalStatusToCodex(value: 'active' | 'paused' | 'blocked' | 'complete'): string { return value; }

export interface NativeGoalSnapshot { objective?: string; status?: ReturnType<typeof goalStatusFromCodex>; tokenBudget: number | null; tokensUsed?: number; timeUsedSeconds?: number }
/** Parses a `ThreadGoal` from a result or notification; undefined for anything malformed. */
export function parseNativeGoal(value: unknown): NativeGoalSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const goal = value as Record<string, unknown>;
  const count = (entry: unknown) => typeof entry === 'number' && Number.isFinite(entry) && entry >= 0 ? Math.floor(entry) : undefined;
  const status = goalStatusFromCodex(goal.status);
  if (!status && typeof goal.objective !== 'string') return undefined;
  return {
    ...(typeof goal.objective === 'string' ? { objective: goal.objective } : {}),
    ...(status ? { status } : {}),
    tokenBudget: count(goal.tokenBudget) ?? null,
    ...(count(goal.tokensUsed) !== undefined ? { tokensUsed: count(goal.tokensUsed) } : {}),
    ...(count(goal.timeUsedSeconds) !== undefined ? { timeUsedSeconds: count(goal.timeUsedSeconds) } : {}),
  };
}

/** Provider-reported token counts from `thread/tokenUsage/updated`: the last model call and the thread's running total. */
export function tokensFromUsage(params: Record<string, unknown>): { last?: number; total?: number } {
  const usage = params.tokenUsage && typeof params.tokenUsage === 'object' ? params.tokenUsage as Record<string, unknown> : undefined;
  const read = (entry: unknown): number | undefined => {
    if (!entry || typeof entry !== 'object') return undefined;
    const record = entry as Record<string, unknown>;
    const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
    if (typeof record.totalTokens === 'number' && Number.isFinite(record.totalTokens) && record.totalTokens >= 0) return record.totalTokens;
    const sum = number(record.inputTokens) + number(record.outputTokens);
    return sum > 0 ? sum : undefined;
  };
  const last = read(usage?.last), total = read(usage?.total);
  return { ...(last !== undefined ? { last } : {}), ...(total !== undefined ? { total } : {}) };
}
