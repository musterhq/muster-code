/**
 * Costs and your stats, read from the turn Ledger (G24, G38). The Ledger is aggregated in SQL (one row per day, project,
 * agent, provider, model and outcome), so opening Costs or the Dashboard never parses a Ledger body in JavaScript. A turn
 * with no known price is counted as unpriced, never as $0.
 */
import type { DatabaseSync } from 'node:sqlite';
import { effectivePricing, estimateCostUsd, type ModelPolicy, type ModelPricing } from '../../shared/model-catalog.ts';
import type { LedgerEntry } from '../../shared/domains/paperclip-protocol.ts';
import type { CostBucket, CostDay, CostsReport, ProfileStats, ProviderWindow } from '../../shared/domains/insight-protocol.ts';

/** One turn, as the pure tests build them. The runtime never builds these: it reads groups. */
export interface TurnRow { projectId: string | null; agent: string; provider: string | null; model: string | null; input: number; output: number; cached?: number; costUsd: number | null; endedAt: string; outcome: string; trigger?: string }
/** What the SQL returns: the turns of one day, project, agent, provider, model and outcome, summed. `cost` is the sum over the priced turns; `u*` are the tokens of the unpriced ones. */
export interface TurnGroup {
  day: string; projectId: string | null; agent: string; provider: string | null; model: string | null; outcome: string;
  n: number; input: number; output: number; cached: number; cost: number; pricedN: number; uInput: number; uOutput: number; uCached: number;
}

/** More groups than this are not read; the report then says it is truncated instead of quietly undercounting. */
export const MAX_GROUPS = 20_000;
const DAY_MS = 86_400_000;
export const CHATS = 'Chats (not task runs)';

/** Indexes the reports filter on. Additive: a Ledger that already has them is left alone, and a table that does not exist yet is skipped. */
export function ensureLedgerIndexes(db: DatabaseSync): void {
  for (const sql of ['CREATE INDEX IF NOT EXISTS turn_ledger_created ON turn_ledger(created_at)', 'CREATE INDEX IF NOT EXISTS turn_ledger_history_ended ON turn_ledger_history(ended_at)']) { try { db.exec(sql); } catch { /* no ledger yet */ } }
}

const J = (path: string) => `json_extract(body,'$.${path}')`;
const FIELDS = `project_id AS pid,
  CASE WHEN ${J('trigger')} IN ('chat','project chat') THEN @chats ELSE COALESCE(${J('agent')},'Agent') END AS agent,
  ${J('provider')} AS provider, ${J('model')} AS model, COALESCE(${J('outcome')},'') AS outcome, COUNT(*) AS n,
  SUM(COALESCE(${J('tokens.input')},0)) AS tin, SUM(COALESCE(${J('tokens.output')},0)) AS tout, SUM(COALESCE(${J('tokens.cached')},0)) AS tc,
  SUM(COALESCE(${J('costUsd')},0)) AS cost, SUM(CASE WHEN ${J('costUsd')} IS NULL THEN 0 ELSE 1 END) AS pricedN,
  SUM(CASE WHEN ${J('costUsd')} IS NULL THEN COALESCE(${J('tokens.input')},0) ELSE 0 END) AS uin,
  SUM(CASE WHEN ${J('costUsd')} IS NULL THEN COALESCE(${J('tokens.output')},0) ELSE 0 END) AS uout,
  SUM(CASE WHEN ${J('costUsd')} IS NULL THEN COALESCE(${J('tokens.cached')},0) ELSE 0 END) AS uc`;
const offsetModifier = (offsetMin: number) => `${offsetMin >= 0 ? '+' : '-'}${Math.abs(offsetMin)} minutes`;

/** Ledger turns (live receipts and imported history) that ended at or after `since`, summed per group, newest days first. */
export function readGroups(db: DatabaseSync, since: string, offsetMin: number, projectId?: string, limit = MAX_GROUPS): { groups: TurnGroup[]; truncated: boolean } {
  const out: TurnGroup[] = [];
  let truncated = false;
  for (const [table, ts] of [['turn_ledger', 'created_at'], ['turn_ledger_history', 'ended_at']] as const) {
    const sql = `SELECT date(${ts}, @mod) AS day, ${FIELDS} FROM ${table} WHERE ${ts} >= @since ${projectId ? 'AND project_id = @project' : ''} GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY day DESC LIMIT @limit`;
    try {
      const rows = db.prepare(sql).all({ mod: offsetModifier(offsetMin), since, chats: CHATS, limit: limit + 1, ...(projectId ? { project: projectId } : {}) }) as Record<string, unknown>[];
      if (rows.length > limit) { truncated = true; rows.length = limit; }
      for (const r of rows) out.push({ day: String(r.day), projectId: typeof r.pid === 'string' && r.pid ? r.pid : null, agent: String(r.agent), provider: typeof r.provider === 'string' ? r.provider : null, model: typeof r.model === 'string' ? r.model : null, outcome: String(r.outcome), n: Number(r.n), input: Number(r.tin), output: Number(r.tout), cached: Number(r.tc), cost: Number(r.cost), pricedN: Number(r.pricedN), uInput: Number(r.uin), uOutput: Number(r.uout), uCached: Number(r.uc) });
    } catch { /* no ledger yet */ }
  }
  return { groups: out, truncated };
}
export function oldestTurn(db: DatabaseSync): string | null {
  const ends: string[] = [];
  for (const sql of ['SELECT MIN(created_at) AS at FROM turn_ledger', 'SELECT MIN(ended_at) AS at FROM turn_ledger_history']) { try { const r = db.prepare(sql).get() as { at: string | null } | undefined; if (r?.at) ends.push(r.at); } catch { /* table missing */ } }
  return ends.sort()[0] ?? null;
}

/** The caller's calendar day (`YYYY-MM-DD`) for an instant, from its UTC offset in minutes. */
export const dayOf = (iso: string, offsetMin: number): string => new Date(Date.parse(iso) + offsetMin * 60_000).toISOString().slice(0, 10);

/** Turns grouped the way the SQL groups them (tests, and a check that the two agree). */
export function groupTurns(turns: readonly TurnRow[], offsetMin: number): TurnGroup[] {
  const map = new Map<string, TurnGroup>();
  for (const t of turns) {
    const day = dayOf(t.endedAt, offsetMin), agent = t.trigger === 'chat' || t.trigger === 'project chat' ? CHATS : t.agent;
    const key = [day, t.projectId ?? '', agent, t.provider ?? '', t.model ?? '', t.outcome].join('\u0000');
    const g = map.get(key) ?? { day, projectId: t.projectId, agent, provider: t.provider, model: t.model, outcome: t.outcome, n: 0, input: 0, output: 0, cached: 0, cost: 0, pricedN: 0, uInput: 0, uOutput: 0, uCached: 0 };
    g.n++; g.input += t.input; g.output += t.output; g.cached += t.cached ?? 0;
    if (t.costUsd === null) { g.uInput += t.input; g.uOutput += t.output; g.uCached += t.cached ?? 0; } else { g.cost += t.costUsd; g.pricedN++; }
    map.set(key, g);
  }
  return [...map.values()];
}

/** The unpriced turns of a group get the user's own price from Settings › Models when there is one; the Ledger's own prices are kept. */
export function repriceGroups(groups: readonly TurnGroup[], policy: ModelPolicy, catalogPrice: (providerId: string, model: string) => ModelPricing | undefined): TurnGroup[] {
  return groups.map(g => {
    const unpriced = g.n - g.pricedN;
    if (!unpriced || !g.provider || !g.model || (!g.uInput && !g.uOutput)) return g;
    const pricing = effectivePricing(policy, g.provider, g.model, catalogPrice(g.provider, g.model));
    if (!pricing) return g;
    const cost = estimateCostUsd({ inputTokens: g.uInput, cachedInputTokens: g.uCached, outputTokens: g.uOutput, reasoningOutputTokens: 0, requests: unpriced }, pricing);
    return cost === null ? g : { ...g, cost: g.cost + cost, pricedN: g.n, uInput: 0, uOutput: 0, uCached: 0 };
  });
}

/**
 * A linked server's run receipts as the groups `buildCosts` reads: the server's own usage and cost, per day, project, agent, provider,
 * model and outcome. A run with no reported cost is counted unpriced (never $0); one with no tokens counts as a turn with none.
 */
export function groupsFromReceipts(receipts: readonly Pick<LedgerEntry, 'projectId' | 'agent' | 'provider' | 'model' | 'tokens' | 'costUsd' | 'endedAt' | 'outcome'>[], offsetMin: number, projectId?: string): TurnGroup[] {
  const groups = new Map<string, TurnGroup>();
  for (const r of receipts) {
    const pid = projectId ?? r.projectId, day = dayOf(r.endedAt, offsetMin), key = [day, pid, r.agent, r.provider, r.model, r.outcome].join('\u0000');
    const g = groups.get(key) ?? { day, projectId: pid, agent: r.agent, provider: r.provider, model: r.model, outcome: r.outcome, n: 0, input: 0, output: 0, cached: 0, cost: 0, pricedN: 0, uInput: 0, uOutput: 0, uCached: 0 };
    const input = r.tokens?.input ?? 0, output = r.tokens?.output ?? 0, cached = r.tokens?.cached ?? 0;
    g.n++; g.input += input; g.output += output; g.cached += cached;
    if (r.costUsd !== null) { g.cost += r.costUsd; g.pricedN++; } else { g.uInput += input; g.uOutput += output; g.uCached += cached; }
    groups.set(key, g);
  }
  return [...groups.values()];
}

const bucket = (key: string, label: string): CostBucket => ({ key, label, turns: 0, inputTokens: 0, outputTokens: 0, costUsd: null, unpricedTurns: 0 });
const add = (b: CostBucket, g: TurnGroup) => {
  b.turns += g.n; b.inputTokens += g.input; b.outputTokens += g.output;
  b.unpricedTurns += g.n - g.pricedN;
  if (g.pricedN) b.costUsd = (b.costUsd ?? 0) + g.cost;
};
const byTokens = (a: CostBucket, b: CostBucket) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens) || b.turns - a.turns;
const round = (n: number | null) => n === null ? null : Math.round(n * 1e6) / 1e6;
const tidy = (b: CostBucket): CostBucket => ({ ...b, costUsd: round(b.costUsd) });

export function buildCosts(groups: readonly TurnGroup[], o: { days: number; offsetMin: number; now: number; projectNames: ReadonlyMap<string, string>; windows: ProviderWindow[]; ledgerSince: string | null; truncated?: boolean }): CostsReport {
  const totals = bucket('all', 'Total'), model = new Map<string, CostBucket>(), agent = new Map<string, CostBucket>(), project = new Map<string, CostBucket & { projectId: string | null }>();
  const dayMap = new Map<string, CostDay>();
  for (let i = o.days - 1; i >= 0; i--) { const d = dayOf(new Date(o.now - i * DAY_MS).toISOString(), o.offsetMin); dayMap.set(d, { day: d, turns: 0, tokens: 0, costUsd: null }); }
  const first = dayMap.keys().next().value as string;
  for (const g of groups) {
    if (g.day < first) continue;
    add(totals, g);
    const mKey = `${g.provider ?? ''}|${g.model ?? ''}`, mb = model.get(mKey) ?? bucket(mKey, g.model ?? 'Unknown model'); add(mb, g); model.set(mKey, mb);
    const ab = agent.get(g.agent) ?? bucket(g.agent, g.agent); add(ab, g); agent.set(g.agent, ab);
    const pKey = g.projectId ?? '', pb = project.get(pKey) ?? { ...bucket(pKey, g.projectId ? o.projectNames.get(g.projectId) ?? 'Deleted project' : 'Chats outside projects'), projectId: g.projectId }; add(pb, g); project.set(pKey, pb);
    const d = dayMap.get(g.day); if (d) { d.turns += g.n; d.tokens += g.input + g.output; if (g.pricedN) d.costUsd = (d.costUsd ?? 0) + g.cost; }
  }
  const sorted = <T extends CostBucket>(m: Map<string, T>) => [...m.values()].sort(byTokens).map(b => ({ ...b, costUsd: round(b.costUsd) }));
  return {
    days: o.days, since: first, until: [...dayMap.keys()].at(-1)!, entries: totals.turns, totals: tidy(totals),
    byDay: [...dayMap.values()].map(d => ({ ...d, costUsd: round(d.costUsd) })), byModel: sorted(model), byAgent: sorted(agent), byProject: sorted(project), windows: o.windows, ledgerSince: o.ledgerSince,
    truncated: o.truncated === true,
  };
}

export function buildProfile(groups: readonly TurnGroup[], o: { offsetMin: number; now: number; states: Partial<Record<string, number>>; providerNames: ReadonlyMap<string, string>; projects: { projectId: string; name: string; completed: number; open: number }[]; since: string | null; truncated?: boolean }): ProfileStats {
  const s = o.states, n = (k: string) => s[k] ?? 0;
  const completed = n('verified') + n('implemented'), failed = n('failed'), total = Object.values(s).reduce<number>((a, b) => a + (b ?? 0), 0);
  const open = total - completed - n('cancelled') - failed;
  let turnsTotal = 0, input = 0, output = 0, cost: number | null = null, unpriced = 0, succeeded = 0, failedRuns = 0;
  const mix = new Map<string, number>(), perDay = new Map<string, number>();
  for (const g of groups) {
    turnsTotal += g.n; input += g.input; output += g.output; unpriced += g.n - g.pricedN; if (g.pricedN) cost = (cost ?? 0) + g.cost;
    if (g.outcome === 'completed') succeeded += g.n; else if (g.outcome === 'failed') failedRuns += g.n;
    const p = g.provider ?? 'unknown'; mix.set(p, (mix.get(p) ?? 0) + g.n);
    perDay.set(g.day, (perDay.get(g.day) ?? 0) + g.n);
  }
  const runs = { total: turnsTotal, succeeded, failed: failedRuns, other: turnsTotal - succeeded - failedRuns };
  const activity: { day: string; runs: number }[] = [];
  for (let i = 27; i >= 0; i--) { const d = dayOf(new Date(o.now - i * DAY_MS).toISOString(), o.offsetMin); activity.push({ day: d, runs: perDay.get(d) ?? 0 }); }
  // The streak counts back from today, or from yesterday when today has no run yet.
  let streak = 0; for (let i = activity.length - 1; i >= 0; i--) { if (activity[i]!.runs > 0) streak++; else if (i === activity.length - 1) continue; else break; }
  const providerMix = [...mix].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([provider, count]) => ({ provider, name: o.providerNames.get(provider) ?? provider, turns: count, share: turnsTotal ? count / turnsTotal : 0 }));
  return {
    since: o.since, tasks: { total, completed, open: Math.max(0, open), failed }, runs, tokens: { input, output }, costUsd: round(cost), unpricedTurns: unpriced,
    providerMix, activity, activeDays: activity.filter(a => a.runs > 0).length, streak,
    topProjects: [...o.projects].sort((a, b) => b.completed - a.completed || b.open - a.open).slice(0, 5), truncated: o.truncated === true,
  };
}
