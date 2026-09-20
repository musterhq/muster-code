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
      if (name) row.name = name;
      if (state) row.state = state;
      if (model) row.model = model;
      if (role) row.role = role;
      if (prompt) row.prompt = prompt;
      if (result) row.result = result;
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
