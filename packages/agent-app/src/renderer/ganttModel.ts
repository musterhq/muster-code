/**
 * The Ledger's Gantt timeline (G1): a bar per run on a row per task (or per agent), a range, zoom, a density minimap and
 * summary stats. Pure: no React, no DOM, no clock of its own.
 */
import type { LedgerEntry, WorkspaceAgent, WorkspaceRun, WorkspaceTask } from '../shared/domains/paperclip-protocol.ts';

export type GanttRange = '1h' | '24h' | '7d' | '30d' | 'all';
export const RANGE_LABEL: Record<GanttRange, string> = { '1h': 'Last hour', '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days', all: 'All time' };
const RANGE_MS: Record<Exclude<GanttRange, 'all'>, number> = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };
export type GanttGroup = 'task' | 'agent';

export interface GanttBar { id: string; taskId: string | null; agentId: string | null; agent: string; start: number; end: number; status: WorkspaceRun['status']; running: boolean; turns: number[]; chatId?: string }
export interface GanttLane { id: string; label: string; sub: string | null; taskId: string | null; bars: GanttBar[] }
export interface GanttStats { runs: number; succeeded: number; failed: number; running: number; activeMs: number; tasks: number; agents: number; busiest: string | null; turns: number }
export interface Gantt { lanes: GanttLane[]; min: number; max: number; stats: GanttStats; density: number[] }

const ms = (iso: string | null | undefined): number | null => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };
const OK = new Set(['succeeded']), BAD = new Set(['failed', 'timed_out']);

/** Bars from runs (a run's span), with the Ledger's turns placed on them as dots. Runs with no time at all are left out. */
export function buildGantt(input: { runs: readonly WorkspaceRun[]; entries: readonly LedgerEntry[]; tasks: readonly WorkspaceTask[]; agents: readonly WorkspaceAgent[]; range: GanttRange; group: GanttGroup; now: number; buckets?: number }): Gantt {
  const { range, now, group } = input, from = range === 'all' ? -Infinity : now - RANGE_MS[range];
  const tasks = new Map(input.tasks.map(t => [t.id, t])), agents = new Map(input.agents.map(a => [a.id, a]));
  const bars: GanttBar[] = [];
  for (const r of input.runs) {
    const start = ms(r.startedAt) ?? ms(r.createdAt); if (start === null) continue;
    const running = r.status === 'running' || r.status === 'queued', end = ms(r.finishedAt) ?? (running ? now : start);
    if (end < from) continue;
    bars.push({ id: r.id, taskId: r.taskId, agentId: r.agentId, agent: (r.agentId && agents.get(r.agentId)?.name) || 'Agent', start, end: Math.max(end, start), status: r.status, running, turns: [], chatId: r.chatId });
  }
  const byChat = new Map(bars.filter(b => b.chatId).map(b => [b.chatId!, b]));
  let turns = 0;
  for (const e of input.entries) { const t = ms(e.endedAt); if (t === null || t < from) continue; turns++; const bar = e.chatId ? byChat.get(e.chatId) : undefined; if (bar) bar.turns.push(t); }
  const laneOf = (b: GanttBar): { id: string; label: string; sub: string | null; taskId: string | null } => {
    if (group === 'agent') return { id: `agent:${b.agentId ?? b.agent}`, label: b.agent, sub: null, taskId: null };
    const t = b.taskId ? tasks.get(b.taskId) : undefined;
    return { id: `task:${b.taskId ?? 'none'}`, label: t ? `${t.key} · ${t.title}` : 'No task', sub: t?.assigneeLabel ?? null, taskId: t?.id ?? null };
  };
  const map = new Map<string, GanttLane>();
  for (const b of bars) { const l = laneOf(b), lane = map.get(l.id) ?? { ...l, bars: [] }; lane.bars.push(b); map.set(l.id, lane); }
  const lanes = [...map.values()].map(l => ({ ...l, bars: l.bars.sort((a, b) => a.start - b.start) })).sort((a, b) => a.bars[0]!.start - b.bars[0]!.start);
  const all = bars.flatMap(b => [b.start, b.end]);
  const min = all.length ? Math.min(...all) : now - 3_600_000, max = all.length ? Math.max(...all, min + 60_000) : now;
  const n = input.buckets ?? 48, density = Array.from({ length: n }, () => 0), span = Math.max(1, max - min);
  for (const b of bars) { const a = Math.min(n - 1, Math.floor(((b.start - min) / span) * n)), z = Math.min(n - 1, Math.floor(((b.end - min) / span) * n)); for (let i = a; i <= z; i++) density[i]!++; }
  const perAgent = new Map<string, number>(); for (const b of bars) perAgent.set(b.agent, (perAgent.get(b.agent) ?? 0) + (b.end - b.start));
  const busiest = [...perAgent].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const stats: GanttStats = { runs: bars.length, succeeded: bars.filter(b => OK.has(b.status)).length, failed: bars.filter(b => BAD.has(b.status)).length, running: bars.filter(b => b.running).length, activeMs: bars.reduce((s, b) => s + (b.end - b.start), 0), tasks: new Set(bars.map(b => b.taskId).filter(Boolean)).size, agents: perAgent.size, busiest, turns };
  return { lanes, min, max, stats, density };
}

/** About six tick marks across a span, on round-ish times. */
export function ticks(min: number, max: number, count = 6): number[] {
  const span = Math.max(1, max - min), steps = [60_000, 300_000, 900_000, 1_800_000, 3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 86_400_000, 2 * 86_400_000, 7 * 86_400_000];
  const step = steps.find(s => span / s <= count) ?? steps[steps.length - 1]!, first = Math.ceil(min / step) * step, out: number[] = [];
  for (let t = first; t <= max && out.length < count * 2; t += step) out.push(t);
  return out;
}
export const durationLabel = (msec: number): string => { const s = Math.round(msec / 1000); if (s < 60) return `${s}s`; const m = Math.round(s / 60); if (m < 60) return `${m}m`; const h = Math.floor(m / 60); return h < 48 ? `${h}h ${m % 60}m` : `${Math.round(h / 24)}d`; };
