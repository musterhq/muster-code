/**
 * Usage and cost per person, project or model, from the agent runtime's hash-chained turn Ledger.
 *
 * Each turn is attributed to the user who started it: the server records a `turn_actors` row (and a hash-chained `turn.started`
 * audit entry) whenever an authenticated user or a connector sends, retries, resends or starts a task. A Ledger entry belongs to the
 * latest actor for its chat at or before the turn started. The Ledger chain itself is never rewritten.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { entryHash, type Body } from '../../agent-app/src/runtime/turn-ledger.ts';
import { estimateCostUsd } from '../../agent-app/src/shared/model-catalog.ts';
import type { ServerStore, TurnActorRecord, UserRecord } from './store/types.ts';

export interface LedgerRow { id: string; chatId: string | null; projectId: string | null; provider: string | null; model: string | null; startedAt: string | null; endedAt: string;
  tokens: { input: number; cached: number; output: number; reasoning: number } | null; costUsd: number | null; outcome: string; source: 'local' | 'history';
  /** True when the Ledger had no price and the cost comes from the price set under Settings › Models (model-policy.json). */
  priceFromSettings?: boolean }
export interface CostLine { key: string; label: string; turns: number; inputTokens: number; cachedTokens: number; outputTokens: number; reasoningTokens: number; costUsd: number; unpricedTurns: number; lastAt: string | null }
export interface CostReport { since: string | null; by: 'user' | 'project' | 'model'; totals: CostLine; lines: CostLine[]; unattributed: number; ledger: { ok: boolean; entries: number; brokenAt: number | null } }

const ledgerFile = (runtimeDir: string) => join(runtimeDir, 'muster-agent.sqlite');

function open(runtimeDir: string): DatabaseSync | null {
  const file = ledgerFile(runtimeDir);
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA busy_timeout=5000');
  return db;
}
const hasTable = (db: DatabaseSync, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

type Pricing = { inputPerMTok: number; outputPerMTok: number; cachedInputPerMTok?: number };
/** Prices set by an admin under Settings › Models, keyed provider::model. The Ledger itself only records catalog prices. */
function settingsPrices(runtimeDir: string): Record<string, Pricing> {
  try { return (JSON.parse(readFileSync(join(runtimeDir, 'model-policy.json'), 'utf8')) as { policy?: { pricing?: Record<string, Pricing> } }).policy?.pricing ?? {}; } catch { return {}; }
}

export function readLedger(runtimeDir: string, since?: string): LedgerRow[] {
  const prices = settingsPrices(runtimeDir);
  const db = open(runtimeDir);
  if (!db) return [];
  try {
    const rows: LedgerRow[] = [];
    const push = (body: string, source: LedgerRow['source']) => {
      const b = JSON.parse(body) as Body;
      if (since && b.endedAt < since) return;
      let costUsd = b.costUsd ?? null, priceFromSettings = false;
      const price = b.provider && b.model ? prices[`${b.provider}::${b.model}`] : undefined;
      if (costUsd === null && price && b.tokens) {
        costUsd = estimateCostUsd({ inputTokens: b.tokens.input, cachedInputTokens: b.tokens.cached, outputTokens: b.tokens.output, reasoningOutputTokens: b.tokens.reasoning, requests: 1 }, price);
        priceFromSettings = costUsd !== null;
      }
      rows.push({ id: b.id, chatId: b.chatId ?? null, projectId: b.projectId ?? null, provider: b.provider ?? null, model: b.model ?? null, startedAt: b.startedAt ?? null,
        endedAt: b.endedAt, tokens: b.tokens ?? null, costUsd, outcome: b.outcome, source, ...(priceFromSettings ? { priceFromSettings } : {}) });
    };
    if (hasTable(db, 'turn_ledger')) for (const r of db.prepare('SELECT body FROM turn_ledger ORDER BY seq').iterate() as Iterable<{ body: string }>) push(r.body, 'local');
    if (hasTable(db, 'turn_ledger_history')) for (const r of db.prepare('SELECT body FROM turn_ledger_history ORDER BY ended_at').iterate() as Iterable<{ body: string }>) push(r.body, 'history');
    return rows;
  } finally { db.close(); }
}

/** Recomputes the runtime Ledger's hash chain (same algorithm as TurnLedger.verify). */
export function verifyLedger(runtimeDir: string): { ok: boolean; entries: number; head: string; brokenAt: number | null } {
  let prev = '0'.repeat(64), count = 0;
  const db = open(runtimeDir);
  if (!db) return { ok: true, entries: 0, head: prev, brokenAt: null };
  try {
    if (!hasTable(db, 'turn_ledger')) return { ok: true, entries: 0, head: prev, brokenAt: null };
    for (const row of db.prepare('SELECT seq, body, prev_hash, hash FROM turn_ledger ORDER BY seq').iterate() as Iterable<{ seq: number; body: string; prev_hash: string; hash: string }>) {
      count++;
      if (row.prev_hash !== prev || entryHash(prev, JSON.parse(row.body) as Body) !== row.hash) return { ok: false, entries: count, head: prev, brokenAt: row.seq };
      prev = row.hash;
    }
    return { ok: true, entries: count, head: prev, brokenAt: null };
  } finally { db.close(); }
}

/** Ledger entry → user id (or a `connector:<id>` actor). */
export function attribute(rows: readonly LedgerRow[], actors: readonly TurnActorRecord[], owners: Map<string, string>): Map<string, string | null> {
  const byChat = new Map<string, TurnActorRecord[]>();
  for (const a of actors) { const list = byChat.get(a.chatId) ?? []; list.push(a); byChat.set(a.chatId, list); }
  for (const list of byChat.values()) list.sort((x, y) => x.at.localeCompare(y.at));
  const out = new Map<string, string | null>();
  for (const row of rows) {
    if (!row.chatId) { out.set(row.id, null); continue; }
    const start = Date.parse(row.startedAt ?? row.endedAt) + 5_000; // clock skew between the RPC and the run start
    const list = byChat.get(row.chatId) ?? [];
    let actor: TurnActorRecord | undefined;
    for (const a of list) if (Date.parse(a.at) <= start) actor = a; else break;
    out.set(row.id, actor?.userId ?? owners.get(row.chatId) ?? null);
  }
  return out;
}

const blank = (key: string, label: string): CostLine => ({ key, label, turns: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0, unpricedTurns: 0, lastAt: null });
function add(line: CostLine, row: LedgerRow) {
  line.turns++;
  line.inputTokens += row.tokens?.input ?? 0; line.cachedTokens += row.tokens?.cached ?? 0; line.outputTokens += row.tokens?.output ?? 0; line.reasoningTokens += row.tokens?.reasoning ?? 0;
  if (typeof row.costUsd === 'number') line.costUsd += row.costUsd; else line.unpricedTurns++;
  if (!line.lastAt || row.endedAt > line.lastAt) line.lastAt = row.endedAt;
}

export async function costReport(input: { runtimeDir: string; store: ServerStore; since?: string | null; by?: 'user' | 'project' | 'model'; projectNames?: Map<string, string>; connectorNames?: Map<string, string> }): Promise<CostReport> {
  const by = input.by ?? 'user';
  const since = input.since ?? null;
  const rows = readLedger(input.runtimeDir, since ?? undefined);
  const users = new Map((await input.store.listUsers()).map((u: UserRecord) => [u.id, u]));
  const who = attribute(rows, await input.store.turnActors(), await input.store.chatOwners());
  const lines = new Map<string, CostLine>(), totals = blank('total', 'Total');
  let unattributed = 0;
  for (const row of rows) {
    let key: string, label: string;
    if (by === 'user') {
      const id = who.get(row.id) ?? null;
      if (!id) { unattributed++; key = 'unattributed'; label = 'Unattributed (desktop or before attribution)'; }
      else if (id.startsWith('connector:')) { key = id; label = `Connector: ${input.connectorNames?.get(id.slice(10)) ?? id.slice(10)}`; }
      else { key = id; const u = users.get(id); label = u ? `${u.displayName} (@${u.username})` : id; }
    } else if (by === 'project') { key = row.projectId ?? 'none'; label = row.projectId ? input.projectNames?.get(row.projectId) ?? row.projectId : 'No project'; }
    else { key = `${row.provider ?? '?'}/${row.model ?? '?'}`; label = row.model ?? 'unknown model'; }
    const line = lines.get(key) ?? blank(key, label); lines.set(key, line);
    add(line, row); add(totals, row);
  }
  const round = (l: CostLine) => ({ ...l, costUsd: Math.round(l.costUsd * 1e6) / 1e6 });
  const chain = verifyLedger(input.runtimeDir);
  return { since, by, totals: round(totals), lines: [...lines.values()].map(round).sort((a, b) => b.costUsd - a.costUsd || b.turns - a.turns), unattributed,
    ledger: { ok: chain.ok, entries: chain.entries, brokenAt: chain.brokenAt } };
}
