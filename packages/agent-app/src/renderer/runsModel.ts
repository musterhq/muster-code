/** Audit Runs (C26): filtering the workspace's runs by window, outcome and agent, and which Inbox items are routine (G36). Pure so it is unit tested. */
import type { WorkspaceRun } from '../shared/domains/paperclip-protocol';

export type RunWindow = '24h' | '7d' | '30d' | 'all';
export const RUN_WINDOW_LABEL: Record<RunWindow, string> = { '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days', all: 'All time' };
const WINDOW_MS: Record<Exclude<RunWindow, 'all'>, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };
export type RunOutcome = 'all' | 'active' | 'succeeded' | 'failed' | 'other';
export const RUN_OUTCOME_LABEL: Record<RunOutcome, string> = { all: 'All', active: 'Active', succeeded: 'Succeeded', failed: 'Failed', other: 'Stopped' };

export const outcomeOf = (r: Pick<WorkspaceRun, 'status'>): Exclude<RunOutcome, 'all'> =>
  r.status === 'running' || r.status === 'queued' ? 'active' : r.status === 'succeeded' ? 'succeeded' : r.status === 'failed' || r.status === 'timed_out' ? 'failed' : 'other';

export interface RunFilter { window: RunWindow; outcome: RunOutcome; agentId: string }
export function filterRuns(runs: readonly WorkspaceRun[], f: RunFilter, now = Date.now()): WorkspaceRun[] {
  const from = f.window === 'all' ? 0 : now - WINDOW_MS[f.window];
  return runs.filter(r => Date.parse(r.startedAt ?? r.createdAt) >= from && (f.outcome === 'all' || outcomeOf(r) === f.outcome) && (!f.agentId || r.agentId === f.agentId))
    .sort((a, b) => (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt));
}
export function countOutcomes(runs: readonly WorkspaceRun[]): Record<RunOutcome, number> {
  const out: Record<RunOutcome, number> = { all: runs.length, active: 0, succeeded: 0, failed: 0, other: 0 };
  for (const r of runs) out[outcomeOf(r)]++;
  return out;
}

/** A run that started by itself: an automation, a timer or heartbeat wake, a schedule. Not something you or an agent asked for. */
export const isRoutineTrigger = (trigger: string | null | undefined): boolean => /automation|routine|heartbeat|timer|schedul|cron|webhook|watchdog|monitor/i.test(trigger ?? '');
export const HIDE_ROUTINE_KEY = 'muster.inbox.hideRoutine';
export const readHideRoutine = (storage: Pick<Storage, 'getItem'> | undefined): boolean => { try { return storage?.getItem(HIDE_ROUTINE_KEY) === 'on'; } catch { return false; } };
export const writeHideRoutine = (storage: Pick<Storage, 'setItem'> | undefined, on: boolean): void => { try { storage?.setItem(HIDE_ROUTINE_KEY, on ? 'on' : 'off'); } catch { /* it stays as it was */ } };
