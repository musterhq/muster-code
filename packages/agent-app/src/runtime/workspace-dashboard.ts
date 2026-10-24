/**
 * The Dashboard's numbers (#132), aggregated where the data lives instead of loading it:
 * - agent turns per local day and outcome, and this month's spend, in SQL over the Ledger (`turn_ledger` receipts and
 *   `turn_ledger_history` imported history);
 * - tasks by day and state, task runs and recent activity, in SQL in the project task store (`project.stats`);
 * - the linked Paperclip's runs, tasks and activity, from what its cached (ETag) reads already hold.
 * A month with turns but no prices reports `usd: null` ("unpriced"), never $0.
 */
import type { DatabaseSync } from 'node:sqlite';
import { assumesCacheWriteRate, estimateCostUsd, type ModelPricing } from '../shared/model-catalog.ts';
import type { ProjectStats, TaskState } from '../shared/domains/projects-protocol.ts';
import type { DashboardData, DashboardDay, LedgerEntry, WorkspaceRow, WorkspaceStatus, WorkspaceTask } from '../shared/domains/paperclip-protocol.ts';

export const DASHBOARD_DAYS = 14;
const STATE: Record<TaskState, WorkspaceStatus> = { backlog: 'backlog', todo: 'todo', running: 'in_progress', 'needs-input': 'in_review', blocked: 'blocked', review: 'in_review', implemented: 'in_review', verified: 'done', failed: 'blocked', cancelled: 'cancelled' };
type Outcome = 'succeeded' | 'failed' | 'other';
/** Receipt outcomes and Paperclip run states on one three-way scale. */
export const outcomeOf = (value: string | null | undefined): Outcome => {
  const v = String(value ?? '').toLowerCase();
  return v === 'completed' || v === 'succeeded' ? 'succeeded' : v === 'failed' || v === 'timed_out' || v === 'error' ? 'failed' : 'other';
};
/** A UTC offset (minutes east of UTC) as an SQLite date modifier. */
export const tzModifier = (offset: number) => `${offset >= 0 ? '+' : ''}${Math.round(offset)} minutes`;
/** The local calendar day of an instant, for a UTC offset in minutes. */
export const localDay = (iso: string, offset: number) => new Date(Date.parse(iso) + offset * 60_000).toISOString().slice(0, 10);
/** The last `count` local days, oldest first, ending today. */
export function dayRange(now: number, offset: number, count = DASHBOARD_DAYS): string[] {
  const today = Date.parse(`${localDay(new Date(now).toISOString(), offset)}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, i) => new Date(today - (count - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}
/** The first instant of the current local month, as UTC ISO. */
export function monthStart(now: number, offset: number): string {
  const local = new Date(now + offset * 60_000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - offset * 60_000).toISOString();
}

export interface LedgerAggregates { turns: { day: string; outcome: string | null; count: number }[]; spend: { usd: number; priced: number; unpriced: number; tokens?: number; /** Turns whose cost is an estimate (#663). */ estimated?: number } }
/**
 * Two grouped queries over the Ledger. `skipImportedPaperclip`: when a Paperclip is linked its own runs are counted
 * from Paperclip, so the imported copies of them (history rows with no chat) are left out here.
 */
export function ledgerAggregates(db: DatabaseSync, input: { since: string; monthStart: string; offset: number; skipImportedPaperclip: boolean; projectId?: string; priceOf?: (providerId: string, model: string) => ModelPricing | null | undefined }): LedgerAggregates {
  const mod = tzModifier(input.offset), scope = input.projectId ? 'AND project_id = ?' : '', history = `${input.skipImportedPaperclip ? 'AND chat_id IS NOT NULL' : ''} ${scope}`;
  const p = input.projectId ? [input.projectId] : [];
  const turns = (db.prepare(`SELECT day, outcome, COUNT(*) AS n FROM (
      SELECT date(created_at, ?) AS day, json_extract(body, '$.outcome') AS outcome FROM turn_ledger WHERE created_at >= ? ${scope}
      UNION ALL SELECT date(ended_at, ?) AS day, json_extract(body, '$.outcome') AS outcome FROM turn_ledger_history WHERE ended_at >= ? ${history}
    ) GROUP BY day, outcome`).all(mod, input.since, ...p, mod, input.since, ...p) as { day: string; outcome: string | null; n: number }[]).map(r => ({ day: r.day, outcome: r.outcome, count: Number(r.n) }));
  // One pass over this month's turns, summed per model and per priced/unpriced/no-usage: the unpriced turns of a model with
  // a known price (`priceOf`: the user's price, else the catalog's) are priced from their tokens. A known price times unknown
  // usage is still unknown, so a turn with no recorded tokens (an imported multi-turn chat) stays unpriced, never $0, the
  // same rule the Costs tab follows.
  const cols = `json_extract(body, '$.provider') AS provider, json_extract(body, '$.model') AS model, json_extract(body, '$.costUsd') AS cost, COALESCE(json_extract(body, '$.tokens.input'), 0) AS i, COALESCE(json_extract(body, '$.tokens.cached'), 0) AS c, COALESCE(json_extract(body, '$.tokens.cacheWrite'), 0) AS w, COALESCE(json_extract(body, '$.tokens.output'), 0) AS o, COALESCE(json_extract(body, '$.estimated'), 0) AS est`;
  const groups = db.prepare(`SELECT provider, model, est, cost IS NULL AS unpriced, (i > 0 OR o > 0) AS used, COALESCE(SUM(cost), 0) AS usd, SUM(i) AS i, SUM(c) AS c, SUM(w) AS w, SUM(o) AS o, COUNT(*) AS n FROM (
      SELECT ${cols} FROM turn_ledger WHERE created_at >= ? ${scope}
      UNION ALL SELECT ${cols} FROM turn_ledger_history WHERE ended_at >= ? ${history}
    ) GROUP BY 1, 2, 3, 4, 5`).all(input.monthStart, ...p, input.monthStart, ...p) as { provider: string | null; model: string | null; unpriced: number; used: number; usd: number; i: number; c: number; w: number; o: number; n: number; est: number }[];
  let usd = 0, priced = 0, unpriced = 0, tokens = 0, estimated = 0;
  for (const g of groups) {
    const n = Number(g.n), i = Number(g.i), o = Number(g.o);
    tokens += i + o;
    if (g.est) estimated += n;
    if (!g.unpriced) { usd += Number(g.usd); priced += n; continue; }
    const pricing = input.priceOf && g.used && g.provider && g.model ? input.priceOf(g.provider, g.model) : null;
    const totals = { inputTokens: i, cachedInputTokens: Number(g.c), cacheWriteTokens: Number(g.w), outputTokens: o, reasoningOutputTokens: 0, requests: 0 };
    const cost = estimateCostUsd(totals, pricing);
    if (cost === null) unpriced += n; else { usd += cost; priced += n; if (!g.est && assumesCacheWriteRate(totals, pricing)) estimated += n; }
  }
  return { turns, spend: { usd, priced, unpriced, tokens, ...(estimated ? { estimated } : {}) } };
}

export interface DashboardInputs {
  now: number; offset: number;
  ledger: LedgerAggregates;
  local: Pick<ProjectStats, 'byDay' | 'activity'> | null;
  /** The linked Paperclip, when there is one: its recent runs (receipts), tasks and activity rows. */
  paperclip: { receipts: LedgerEntry[]; tasks: WorkspaceTask[]; activity: WorkspaceRow[]; name: string } | null;
}
export function buildDashboard(input: DashboardInputs): DashboardData {
  const days = dayRange(input.now, input.offset), month = monthStart(input.now, input.offset);
  const runs = new Map<string, DashboardDay>(days.map(day => [day, { day, succeeded: 0, failed: 0, other: 0 }]));
  for (const t of input.ledger.turns) { const row = runs.get(t.day); if (row) row[outcomeOf(t.outcome)] += t.count; }
  let usd = input.ledger.spend.priced ? input.ledger.spend.usd : 0, priced = input.ledger.spend.priced, unpriced = input.ledger.spend.unpriced, tokens = input.ledger.spend.tokens ?? 0, estimated = input.ledger.spend.estimated ?? 0;
  for (const r of input.paperclip?.receipts ?? []) {
    const day = localDay(r.endedAt, input.offset), row = runs.get(day);
    if (row) row[outcomeOf(r.outcome)]++;
    if (r.endedAt >= month) { if (r.costUsd === null) unpriced++; else { usd += r.costUsd; priced++; if (r.estimated) estimated++; } tokens += (r.tokens?.input ?? 0) + (r.tokens?.output ?? 0); }
  }
  const tasks = new Map<string, Partial<Record<WorkspaceStatus, number>>>(days.map(day => [day, {}]));
  for (const row of input.local?.byDay ?? []) { const counts = tasks.get(row.day); if (counts) { const s = STATE[row.state] ?? 'todo'; counts[s] = (counts[s] ?? 0) + row.count; } }
  for (const t of input.paperclip?.tasks ?? []) { const counts = tasks.get(localDay(t.updatedAt, input.offset)); if (counts) counts[t.status] = (counts[t.status] ?? 0) + 1; }
  const activity: DashboardData['activity'] = [
    ...(input.local?.activity ?? []).map(a => ({ id: a.id, actor: a.actor, summary: a.summary, at: a.createdAt, projectId: a.projectId, projectName: a.projectName, source: 'local' as const, refId: a.refId })),
    ...(input.paperclip?.activity ?? []).filter(r => r.at).map(r => ({ id: `pc:${r.id}`, actor: r.detail, summary: r.title, at: r.at!, projectId: r.projectId ?? null, projectName: input.paperclip!.name, source: 'paperclip' as const, refId: null })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12);
  return {
    days, runs: [...runs.values()], tasksByDay: [...tasks].map(([day, counts]) => ({ day, counts })),
    // Turns but no prices at all: unknown, not $0.
    spend: { usd: priced ? usd : null, pricedTurns: priced, unpricedTurns: unpriced, ...(estimated ? { estimatedTurns: estimated } : {}), tokens, since: month, source: input.paperclip ? `Muster and ${input.paperclip.name}` : 'Muster' },
    activity, generatedAt: new Date(input.now).toISOString(),
  };
}
