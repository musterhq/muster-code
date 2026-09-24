import type { TimelineItem } from '../shared/protocol';

/** The provider only reports these fields when it knows them. IDs stay exact. */
export interface SubagentActivity {
  id: string;
  name: string;
  threadId: string;
  state?: string;
  model?: string;
  role?: string;
  prompt?: string;
  result?: string;
  /** Why the child failed or was stopped, when the provider said (DOGFOOD F51: failed rows showed no reason). */
  error?: string;
  /** First and latest parent report that named this child; bounds the elapsed timer. */
  startedAt?: string;
  updatedAt?: string;
}

export type SubagentStateKind = 'working' | 'waiting' | 'done' | 'failed' | 'unknown';
export interface SubagentSummary {
  agents: SubagentActivity[];
  counts: Record<SubagentStateKind, number>;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function json(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return undefined; }
}

function shortId(id: string): string {
  const tail = id.split(/[/:]/).filter(Boolean).at(-1) || id;
  return tail.length > 14 ? `${tail.slice(0, 10)}…${tail.slice(-3)}` : tail;
}

function records(value: unknown): Record<string, unknown>[] {
  const parsed = json(value);
  if (Array.isArray(parsed)) return parsed.filter(isRecord);
  if (isRecord(parsed)) {
    return Object.entries(parsed).flatMap(([key, entry]) =>
      isRecord(entry) ? [{ ...entry, _key: key }] : []);
  }
  return [];
}

function recordId(record: Record<string, unknown>): string | undefined {
  return text(record.threadId) ?? text(record.receiverThreadId) ?? text(record.agentThreadId) ?? text(record.id) ?? text(record._key);
}

/** The provider's own words for a failure: Codex reports `{status:'errored', message}`; other shapes use error/reason. */
export function failureReason(...sources: (Record<string, unknown> | undefined)[]): string | undefined {
  for (const source of sources) {
    if (!source) continue;
    const nested = isRecord(source.error) ? source.error : undefined;
    const reason = text(source.message) ?? text(source.error) ?? text(nested?.message) ?? text(source.errorMessage) ?? text(source.reason);
    if (reason) return reason.length > 600 ? `${reason.slice(0, 599)}…` : reason;
  }
  return undefined;
}

/** Exact state aliases avoid treating unknown values such as "incomplete" as done. */
export function subagentState(state?: string): {kind: SubagentStateKind; label: string} {
  switch (state?.replace(/[\s_-]/g, '').toLowerCase()) {
    case 'running': case 'inprogress': case 'working': case 'active':
      return {kind:'working', label:'Working'};
    case 'queued': case 'pending': case 'pendinginit': case 'initializing':
      return {kind:'waiting', label:'Queued'};
    case 'waiting': case 'idle': case 'blocked': case 'awaitinginput': case 'waitingforinput':
      return {kind:'waiting', label:'Waiting'};
    case 'completed': case 'complete': case 'done': case 'success': case 'succeeded':
      return {kind:'done', label:'Done'};
    case 'failed': case 'error': case 'errored': case 'notfound':
      return {kind:'failed', label:'Failed'};
    case 'interrupted': return {kind:'failed', label:'Interrupted'};
    case 'cancelled': case 'canceled': return {kind:'failed', label:'Cancelled'};
    case 'shutdown': case 'closed': return {kind:'unknown', label:'Closed'};
    default: return {kind:'unknown', label:state || 'Not reported'};
  }
}

// Timeline replicas publish immutable arrays. Share a projection across the
// compact overview, tab and presence checks; unrelated store updates do no work.
const cache = new WeakMap<readonly TimelineItem[], SubagentSummary>();
export const EMPTY_ACTIVITY_ITEMS: readonly TimelineItem[] = [];

/** Project retained child reports; parent tool completion/result is not child work. */
export function getSubagentActivity(items: readonly TimelineItem[]): SubagentSummary {
  const cached = cache.get(items);
  if (cached) return cached;
  const rows = new Map<string, SubagentActivity>();
  const reports = items.filter(item => item.kind === 'tool' && item.data?.type === 'collabAgentToolCall');
  // Preserve arrival order for ties or missing timestamps; sort only if needed.
  let ordered = reports.map((item, index) => ({item, index, time:Date.parse(item.createdAt)}));
  const dated = ordered.filter(entry => Number.isFinite(entry.time));
  if (dated.some((entry, index) => index > 0 && entry.time < dated[index - 1].time)) {
    dated.sort((a, b) => a.time - b.time || a.index - b.index);
    let index = 0;
    ordered = ordered.map(entry => Number.isFinite(entry.time) ? dated[index++] : entry);
  }
  for (const {item} of ordered) {
    const data = item.data!;
    const parsedStates = json(data.agentsStates);
    const states = isRecord(parsedStates) ? parsedStates : {};
    const agentRecords = records(data.receiverAgents);
    const byId = new Map(agentRecords.flatMap(record => {
      const id = recordId(record);
      return id ? [[id, record] as const] : [];
    }));
    const receiverIds = Array.isArray(data.receiverThreadIds) ? data.receiverThreadIds.filter((id): id is string => !!text(id)) : [];
    const ids = new Set<string>([
      ...receiverIds,
      ...byId.keys(),
      ...Object.keys(states).filter(id => !!text(id)),
    ]);
    // A parent can appear in a broad state snapshot. It is never its own child.
    if (text(data.senderThreadId)) ids.delete(data.senderThreadId as string);
    for (const id of ids) {
      const record = byId.get(id) ?? (!byId.size ? agentRecords[receiverIds.indexOf(id)] : undefined);
      const row: SubagentActivity = rows.get(id) ?? { id, threadId:id, name:shortId(id) };
      const value = Object.hasOwn(states, id) ? states[id] : undefined;
      const stateInfo = isRecord(value) ? value : undefined;
      // A keyed lifecycle report is more specific than receiver metadata.
      const state = text(stateInfo?.status) ?? text(stateInfo?.state) ?? text(value) ?? text(record?.status) ?? text(record?.state);
      const single = ids.size === 1;
      const name = text(record?.name) ?? text(record?.displayName) ?? text(record?.label) ?? text(record?.agentNickname) ?? (single ? text(data.agentNickname) : undefined);
      const model = text(record?.model) ?? (single ? text(data.model) : undefined);
      const role = text(record?.role) ?? text(record?.agentRole) ?? (single ? text(data.agentRole) : undefined);
      const prompt = text(record?.prompt) ?? (single ? text(data.prompt) : undefined);
      const result = text(stateInfo?.message) ?? text(stateInfo?.result) ?? text(record?.result) ?? text(record?.output);
      const failed = subagentState(state).kind === 'failed' || item.status === 'failed' && ids.size === 1;
      const error = failed ? failureReason(stateInfo, record, single ? data : undefined) : undefined;
      if (name) row.name = name;
      if (state) row.state = state;
      if (model) row.model = model;
      if (role) row.role = role;
      if (prompt) row.prompt = prompt;
      if (result) row.result = result;
      if (error) row.error = error;
      else if (state && subagentState(state).kind !== 'failed') delete row.error;
      if (item.createdAt) { row.startedAt ??= item.createdAt; row.updatedAt = item.createdAt; }
      rows.set(id, row);
    }
  }
  const agents = [...rows.values()];
  const counts: SubagentSummary['counts'] = {working:0, waiting:0, done:0, failed:0, unknown:0};
  for (const agent of agents) counts[subagentState(agent.state).kind]++;
  const summary = {agents, counts};
  cache.set(items, summary);
  return summary;
}

export function projectSubagentActivity(items: readonly TimelineItem[]): SubagentActivity[] {
  return getSubagentActivity(items).agents;
}

export function hasSubagentActivity(items: readonly TimelineItem[]): boolean {
  return getSubagentActivity(items).agents.length > 0;
}

export type SubagentLifecycleEvent = 'started' | 'finished' | 'failed';
/**
 * Lifecycle transitions one collab tool report carries, in report order: a
 * spawn starts its receivers; a keyed terminal child state finishes/fails it.
 * A spawn without receiver ids yet (still initializing) is keyed by the item id.
 */
export function subagentLifecycle(item: TimelineItem): {id: string; event: SubagentLifecycleEvent; name?: string; reason?: string}[] {
  const data = item.data;
  if (item.kind !== 'tool' || data?.type !== 'collabAgentToolCall') return [];
  const sender = text(data.senderThreadId);
  const receivers = Array.isArray(data.receiverThreadIds) ? data.receiverThreadIds.filter((id): id is string => !!text(id) && id !== sender) : [];
  const out: {id: string; event: SubagentLifecycleEvent; name?: string; reason?: string}[] = [];
  if (String(data.tool ?? '').replace(/[\s_-]/g, '').toLowerCase() === 'spawnagent') {
    const event = item.status === 'failed' ? 'failed' : 'started';
    const nickname = text(data.agentNickname);
    const reason = event === 'failed' ? failureReason(data) ?? text(data.output) : undefined;
    if (receivers.length) for (const id of receivers) out.push({id, event, ...(receivers.length === 1 && nickname ? {name:nickname} : {}), ...(reason ? {reason} : {})});
    else out.push({id:item.id, event, ...(nickname ? {name:nickname} : {}), ...(reason ? {reason} : {})});
    if (event === 'failed') return out;
  }
  const parsed = json(data.agentsStates), states = isRecord(parsed) ? parsed : {};
  for (const [id, value] of Object.entries(states)) {
    if (!text(id) || id === sender) continue;
    const info = isRecord(value) ? value : undefined;
    const kind = subagentState(text(info?.status) ?? text(info?.state) ?? text(value)).kind;
    const reason = kind === 'failed' ? failureReason(info) : undefined;
    if (kind === 'done' || kind === 'failed') out.push({id, event:kind === 'done' ? 'finished' : 'failed', ...(reason ? {reason} : {})});
  }
  return out;
}

/**
 * The tab separates four outcomes: still running (or queued), completed, verified
 * (completed and its result reported back to the parent), failed or stopped.
 */
export type SubagentPhaseKind = 'running' | 'waiting' | 'completed' | 'verified' | 'failed' | 'unknown';
export function subagentPhase(agent: Pick<SubagentActivity, 'state' | 'result'>, transcriptStatus?: string): {kind: SubagentPhaseKind; label: string} {
  const reported = subagentState(agent.state);
  // The child's own thread is fresher than the parent's last report while it runs.
  const live = transcriptStatus === 'running' ? 'working' : transcriptStatus === 'failed' || transcriptStatus === 'interrupted' ? 'failed' : transcriptStatus === 'completed' && reported.kind !== 'failed' ? 'done' : reported.kind;
  if (live === 'working') return {kind:'running', label:'Running'};
  if (live === 'waiting') return {kind:'waiting', label:reported.kind === 'waiting' ? reported.label : 'Waiting'};
  if (live === 'failed') return {kind:'failed', label:reported.kind === 'failed' ? reported.label : transcriptStatus === 'interrupted' ? 'Interrupted' : 'Failed'};
  if (live === 'done') return agent.result ? {kind:'verified', label:'Reported back'} : {kind:'completed', label:'Completed'};
  return {kind:'unknown', label:reported.label};
}
export function phaseCounts(agents: readonly SubagentActivity[]): Record<SubagentPhaseKind, number> {
  const counts: Record<SubagentPhaseKind, number> = {running:0, waiting:0, completed:0, verified:0, failed:0, unknown:0};
  for (const agent of agents) counts[subagentPhase(agent).kind]++;
  return counts;
}
export function phaseGlyph(kind: SubagentPhaseKind): 'working' | 'done' | 'failed' | 'idle' {
  return kind === 'running' ? 'working' : kind === 'completed' || kind === 'verified' ? 'done' : kind === 'failed' ? 'failed' : 'idle';
}

/** Parent timeline rows the provider tagged with this child's thread id, in order. */
export function childTimelineItems(items: readonly TimelineItem[], threadId: string): TimelineItem[] {
  return items.filter(item => item.data?.threadId === threadId && item.data?.type !== 'collabAgentToolCall');
}

/** Compact elapsed label: 42s, 3m 05s, 1h 02m. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), sec = total % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`;
}

// Which child a chat's Subagents tab shows. Timeline rows and the tab list set it;
// the tab's back arrow clears it. Kept outside the workspace store: it is view state.
const selection = new Map<string, string>();
const listeners = new Set<() => void>();
export function selectSubagent(chatId: string, threadId: string | null): void {
  if ((selection.get(chatId) ?? null) === threadId) return;
  if (threadId) selection.set(chatId, threadId); else selection.delete(chatId);
  for (const listener of listeners) listener();
}
export function selectedSubagent(chatId: string): string | null { return selection.get(chatId) ?? null; }
export function subscribeSubagentSelection(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
