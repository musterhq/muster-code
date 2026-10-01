/**
 * Costs and your stats, read from the turn Ledger (G24, G38). Pure aggregation over the entries the Ledger already holds:
 * nothing new is recorded. A turn with no known price is counted as unpriced, never as $0.
 */
import type { DatabaseSync } from 'node:sqlite';
import { effectivePricing, estimateCostUsd, type ModelPolicy, type ModelPricing } from '../../shared/model-catalog.ts';
import type { CostBucket, CostDay, CostsReport, ProfileStats, ProviderWindow } from '../../shared/domains/insight-protocol.ts';

export interface TurnRow { projectId: string | null; agent: string; provider: string | null; model: string | null; input: number; output: number; cached?: number; costUsd: number | null; endedAt: string; outcome: string }

const MAX_ROWS = 60_000, DAY_MS = 86_400_000;
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : 0;

/** Ledger turns that ended at or after `since` (live receipts and imported history), newest first, capped. */
export function readTurns(db: DatabaseSync, since: string, projectId?: string): TurnRow[] {
  const out: TurnRow[] = [];
  const take = (rows: { body: string; project_id: string | null }[]) => {
    for (const r of rows) {
      try {
        const b = JSON.parse(r.body) as Record<string, unknown>, t = (b.tokens ?? null) as Record<string, unknown> | null;
        out.push({ projectId: r.project_id ?? (typeof b.projectId === 'string' ? b.projectId : null), agent: typeof b.agent === 'string' && b.agent ? b.agent : 'Agent', provider: typeof b.provider === 'string' ? b.provider : null, model: typeof b.model === 'string' ? b.model : null, input: num(t?.input), output: num(t?.output), cached: num(t?.cached), costUsd: typeof b.costUsd === 'number' && Number.isFinite(b.costUsd) ? b.costUsd : null, endedAt: String(b.endedAt ?? ''), outcome: String(b.outcome ?? '') });
      } catch { /* an unreadable body is skipped */ }
    }
  };
  const where = projectId ? 'AND project_id = ?' : '', args = projectId ? [since, projectId, MAX_ROWS] : [since, MAX_ROWS];
  try { take(db.prepare(`SELECT body, project_id FROM turn_ledger WHERE created_at >= ? ${where} ORDER BY seq DESC LIMIT ?`).all(...(args as never[])) as never); } catch { /* no ledger yet */ }
  try { take(db.prepare(`SELECT body, project_id FROM turn_ledger_history WHERE ended_at >= ? ${where} ORDER BY ended_at DESC LIMIT ?`).all(...(args as never[])) as never); } catch { /* no history yet */ }
  return out.filter(t => t.endedAt);
}
/** A turn the Ledger could not price (a model with no catalog price) gets the user's own price from Settings › Models, when there is one. Turns the Ledger priced keep that price. */
export function repriceTurns(turns: readonly TurnRow[], policy: ModelPolicy, catalogPrice: (providerId: string, model: string) => ModelPricing | undefined): TurnRow[] {
  return turns.map(t => {
    if (t.costUsd !== null || !t.provider || !t.model || (!t.input && !t.output)) return t;
    const pricing = effectivePricing(policy, t.provider, t.model, catalogPrice(t.provider, t.model));
    if (!pricing) return t;
    const cost = estimateCostUsd({ inputTokens: t.input, cachedInputTokens: t.cached ?? 0, outputTokens: t.output, reasoningOutputTokens: 0, requests: 1 }, pricing);
    return cost === null ? t : { ...t, costUsd: cost };
  });
}
export function oldestTurn(db: DatabaseSync): string | null {
  const ends: string[] = [];
  for (const sql of ['SELECT MIN(created_at) AS at FROM turn_ledger', 'SELECT MIN(ended_at) AS at FROM turn_ledger_history']) { try { const r = db.prepare(sql).get() as { at: string | null } | undefined; if (r?.at) ends.push(r.at); } catch { /* table missing */ } }
  return ends.sort()[0] ?? null;
}

/** The caller's calendar day (`YYYY-MM-DD`) for an instant, from its UTC offset in minutes. */
export const dayOf = (iso: string, offsetMin: number): string => new Date(Date.parse(iso) + offsetMin * 60_000).toISOString().slice(0, 10);

const bucket = (key: string, label: string): CostBucket => ({ key, label, turns: 0, inputTokens: 0, outputTokens: 0, costUsd: null, unpricedTurns: 0 });
const add = (b: CostBucket, t: TurnRow) => {
  b.turns++; b.inputTokens += t.input; b.outputTokens += t.output;
  if (t.costUsd === null) b.unpricedTurns++; else b.costUsd = (b.costUsd ?? 0) + t.costUsd;
};
const byTokens = (a: CostBucket, b: CostBucket) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens) || b.turns - a.turns;
const round = (n: number | null) => n === null ? null : Math.round(n * 1e6) / 1e6;
const tidy = (b: CostBucket): CostBucket => ({ ...b, costUsd: round(b.costUsd) });

export function buildCosts(turns: readonly TurnRow[], o: { days: number; offsetMin: number; now: number; projectNames: ReadonlyMap<string, string>; windows: ProviderWindow[]; ledgerSince: string | null }): CostsReport {
  const totals = bucket('all', 'Total'), model = new Map<string, CostBucket>(), agent = new Map<string, CostBucket>(), project = new Map<string, CostBucket & { projectId: string | null }>();
  const dayMap = new Map<string, CostDay>();
  for (let i = o.days - 1; i >= 0; i--) { const d = dayOf(new Date(o.now - i * DAY_MS).toISOString(), o.offsetMin); dayMap.set(d, { day: d, turns: 0, tokens: 0, costUsd: null }); }
  const first = dayMap.keys().next().value as string;
  for (const t of turns) {
    const day = dayOf(t.endedAt, o.offsetMin);
    if (day < first) continue;
    add(totals, t);
    const mKey = `${t.provider ?? ''}|${t.model ?? ''}`, mb = model.get(mKey) ?? bucket(mKey, t.model ?? 'Unknown model'); add(mb, t); model.set(mKey, mb);
    const ab = agent.get(t.agent) ?? bucket(t.agent, t.agent); add(ab, t); agent.set(t.agent, ab);
    const pKey = t.projectId ?? '', pb = project.get(pKey) ?? { ...bucket(pKey, t.projectId ? o.projectNames.get(t.projectId) ?? 'Deleted project' : 'Chats outside projects'), projectId: t.projectId }; add(pb, t); project.set(pKey, pb);
    const d = dayMap.get(day); if (d) { d.turns++; d.tokens += t.input + t.output; if (t.costUsd !== null) d.costUsd = (d.costUsd ?? 0) + t.costUsd; }
  }
  const sorted = <T extends CostBucket>(m: Map<string, T>) => [...m.values()].sort(byTokens).map(b => ({ ...b, costUsd: round(b.costUsd) }));
  return {
    days: o.days, since: first, until: [...dayMap.keys()].at(-1)!, entries: totals.turns, totals: tidy(totals),
    byDay: [...dayMap.values()].map(d => ({ ...d, costUsd: round(d.costUsd) })), byModel: sorted(model), byAgent: sorted(agent), byProject: sorted(project), windows: o.windows, ledgerSince: o.ledgerSince,
  };
}

export function buildProfile(turns: readonly TurnRow[], o: { offsetMin: number; now: number; states: Partial<Record<string, number>>; providerNames: ReadonlyMap<string, string>; projects: { projectId: string; name: string; completed: number; open: number }[]; since: string | null }): ProfileStats {
  const s = o.states, n = (k: string) => s[k] ?? 0;
  const completed = n('verified') + n('implemented'), failed = n('failed'), total = Object.values(s).reduce<number>((a, b) => a + (b ?? 0), 0);
  const open = total - completed - n('cancelled') - failed;
  const runs = { total: turns.length, succeeded: turns.filter(t => t.outcome === 'completed').length, failed: turns.filter(t => t.outcome === 'failed').length, other: 0 };
  runs.other = runs.total - runs.succeeded - runs.failed;
  let input = 0, output = 0, cost: number | null = null, unpriced = 0;
  const mix = new Map<string, number>(), perDay = new Map<string, number>();
  for (const t of turns) {
    input += t.input; output += t.output; if (t.costUsd === null) unpriced++; else cost = (cost ?? 0) + t.costUsd;
    const p = t.provider ?? 'unknown'; mix.set(p, (mix.get(p) ?? 0) + 1);
    const d = dayOf(t.endedAt, o.offsetMin); perDay.set(d, (perDay.get(d) ?? 0) + 1);
  }
  const activity: { day: string; runs: number }[] = [];
  for (let i = 27; i >= 0; i--) { const d = dayOf(new Date(o.now - i * DAY_MS).toISOString(), o.offsetMin); activity.push({ day: d, runs: perDay.get(d) ?? 0 }); }
  // The streak counts back from today, or from yesterday when today has no run yet.
  let streak = 0; for (let i = activity.length - 1; i >= 0; i--) { if (activity[i]!.runs > 0) streak++; else if (i === activity.length - 1) continue; else break; }
  const providerMix = [...mix].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([provider, count]) => ({ provider, name: o.providerNames.get(provider) ?? provider, turns: count, share: turns.length ? count / turns.length : 0 }));
  return {
    since: o.since, tasks: { total, completed, open: Math.max(0, open), failed }, runs, tokens: { input, output }, costUsd: round(cost), unpricedTurns: unpriced,
    providerMix, activity, activeDays: activity.filter(a => a.runs > 0).length, streak,
    topProjects: [...o.projects].sort((a, b) => b.completed - a.completed || b.open - a.open).slice(0, 5),
  };
}
