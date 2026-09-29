/**
 * The turn ledger (#115, Phase 1 audit foundation): every agent turn Muster runs appends one entry — trigger, agent,
 * provider/model, tokens (in / cached / out / reasoning) and cost, tools used, approvals, the files it changed observed
 * from disk against the review baseline (before/after blob hashes; project and task runs only), duration and outcome. Entries are hash-chained:
 * each stores sha256(previous hash + canonical entry), so editing or deleting a past entry breaks every later hash.
 * `verify()` walks the chain. Recording is observation only; it never blocks or fails a run.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import type { LedgerEntry, LedgerFile } from '../shared/domains/paperclip-protocol.ts';
import { estimateCostUsd, ZERO_USAGE, type UsageTotals } from '../shared/model-catalog.ts';
import { usageStep, type UsageCursor } from './model-usage.ts';
import { snapshotTree } from './review-baseline.ts';
import type { DomainContext } from './domains/types.ts';

const GENESIS = '0'.repeat(64);
type Body = Omit<LedgerEntry, 'seq' | 'hash' | 'prevHash' | 'source'>;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, (v as Record<string, unknown>)[k]])) : v);
export const entryHash = (prevHash: string, body: Body) => createHash('sha256').update(prevHash).update('\n').update(canonical(body)).digest('hex');

export class TurnLedger {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS turn_ledger (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, chat_id TEXT NOT NULL, run_id TEXT NOT NULL,
      project_id TEXT, body TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS turn_ledger_chat ON turn_ledger(chat_id, seq);
      CREATE INDEX IF NOT EXISTS turn_ledger_project ON turn_ledger(project_id, seq);`);
  }
  head(): string { const row = this.db.prepare('SELECT hash FROM turn_ledger ORDER BY seq DESC LIMIT 1').get() as { hash: string } | undefined; return row?.hash ?? GENESIS; }
  append(body: Body): LedgerEntry {
    const prevHash = this.head(), hash = entryHash(prevHash, body);
    const info = this.db.prepare('INSERT INTO turn_ledger (id, chat_id, run_id, project_id, body, prev_hash, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(body.id, body.chatId ?? '', body.runId, body.projectId, canonical(body), prevHash, hash, body.endedAt);
    return { ...body, seq: Number(info.lastInsertRowid), prevHash, hash, source: 'local' };
  }
  list(filter: { chatIds?: readonly string[]; projectId?: string; limit?: number } = {}): LedgerEntry[] {
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
    const rows = filter.chatIds?.length
      ? this.db.prepare(`SELECT * FROM turn_ledger WHERE chat_id IN (${filter.chatIds.map(() => '?').join(',')}) ORDER BY seq DESC LIMIT ?`).all(...filter.chatIds, limit)
      : filter.projectId ? this.db.prepare('SELECT * FROM turn_ledger WHERE project_id = ? ORDER BY seq DESC LIMIT ?').all(filter.projectId, limit)
      : this.db.prepare('SELECT * FROM turn_ledger ORDER BY seq DESC LIMIT ?').all(limit);
    return (rows as { seq: number; body: string; prev_hash: string; hash: string }[]).map(r => ({ ...(JSON.parse(r.body) as Body), seq: r.seq, prevHash: r.prev_hash, hash: r.hash, source: 'local' as const }));
  }
  /** Recomputes every hash in order. `brokenAt` is the first entry whose stored hash or link does not match. */
  verify(): { ok: boolean; entries: number; head: string; brokenAt: number | null } {
    let prev = GENESIS, count = 0;
    for (const row of this.db.prepare('SELECT seq, body, prev_hash, hash FROM turn_ledger ORDER BY seq').iterate() as Iterable<{ seq: number; body: string; prev_hash: string; hash: string }>) {
      count++;
      if (row.prev_hash !== prev || entryHash(prev, JSON.parse(row.body) as Body) !== row.hash) return { ok: false, entries: count, head: prev, brokenAt: row.seq };
      prev = row.hash;
    }
    return { ok: true, entries: count, head: prev, brokenAt: null };
  }
}

const git = (cwd: string, args: string[]) => new Promise<string>((resolve, reject) => execFile('git', args, { cwd, timeout: 5000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout) => error ? reject(error) : resolve(stdout)));
/** Files a turn changed: its review baseline tree against the working tree now, with both blob hashes. */
export async function filesChanged(cwd: string, beforeTree: string | null): Promise<LedgerFile[] | null> {
  if (!beforeTree) return null;
  try {
    const after = await snapshotTree(cwd);
    if (after === beforeTree) return [];
    const [out, numstat] = await Promise.all([git(cwd, ['diff-tree', '-r', '--no-renames', '-z', beforeTree, after]), git(cwd, ['diff-tree', '-r', '--no-renames', '--numstat', '-z', beforeTree, after]).catch(() => '')]);
    const counts = new Map<string, { added: number | null; removed: number | null }>();
    for (const row of numstat.split('\0').filter(Boolean)) { const [a, r, ...path] = row.split('\t'); counts.set(path.join('\t'), { added: a === '-' ? null : Number(a), removed: r === '-' ? null : Number(r) }); }
    const parts = out.split('\0').filter(Boolean), files: LedgerFile[] = [];
    for (let i = 0; i + 1 < parts.length && files.length < 200; i += 2) {
      const [, , before, afterHash, status] = parts[i].slice(1).split(' '), path = parts[i + 1], n = counts.get(path);
      files.push({ path, status: status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified', before: /^0+$/.test(before) ? null : before, after: /^0+$/.test(afterHash) ? null : afterHash, added: n?.added ?? null, removed: n?.removed ?? null });
    }
    return files;
  } catch { return null; }
}

const TOOL_TYPES = new Set(['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'fileChange', 'webSearch', 'imageView']);
interface Open { startedAt: number; cwd: string; usage: UsageTotals; cursor?: UsageCursor; tools: Map<string, number>; approvals: number; tests: number }
const TEST_COMMAND = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b|\bnode\s+--test\b|\bvitest\b|\bjest\b|\bmake\s+test\b/;

/** Wires the ledger to the run hooks. Returns an unsubscribe. Safe in bare test contexts (no hooks). */
export function attachTurnLedger(context: DomainContext, ledger: () => TurnLedger, onAppend?: (entry: LedgerEntry) => void): () => void {
  const hooks = context.hooks;
  if (!hooks?.onRunStarted || !hooks.onRunSettled || !hooks.onProviderEvent) return () => undefined;
  const open = new Map<string, Open>();
  const byChat = new Map<string, string>();
  const offStart = hooks.onRunStarted(run => { open.set(run.runId, { startedAt: Date.now(), cwd: run.cwd, usage: { ...ZERO_USAGE }, tools: new Map(), approvals: 0, tests: 0 }); byChat.set(run.chat.id, run.runId); });
  const offEvent = hooks.onProviderEvent(event => {
    const runId = byChat.get(event.chat.id), turn = runId ? open.get(runId) : undefined;
    if (!turn) return;
    const step = usageStep(turn.cursor, event.method, event.params);
    if (step) { turn.cursor = step.cursor; turn.usage = { inputTokens: turn.usage.inputTokens + step.delta.inputTokens, cachedInputTokens: turn.usage.cachedInputTokens + step.delta.cachedInputTokens, outputTokens: turn.usage.outputTokens + step.delta.outputTokens, reasoningOutputTokens: turn.usage.reasoningOutputTokens + step.delta.reasoningOutputTokens, requests: turn.usage.requests + step.delta.requests }; return; }
    if (/requestApproval|approval\/request/i.test(event.method)) { turn.approvals++; return; }
    if (event.method === 'item/started') {
      const item = (event.params.item ?? {}) as Record<string, unknown>, type = typeof item.type === 'string' ? item.type : '';
      if (!TOOL_TYPES.has(type)) return;
      const name = type === 'mcpToolCall' ? `${item.server ?? 'mcp'}/${item.tool ?? 'tool'}` : type === 'commandExecution' ? 'shell' : type;
      if (type === 'commandExecution' && TEST_COMMAND.test(String(item.command ?? ''))) turn.tests++;
      turn.tools.set(name, (turn.tools.get(name) ?? 0) + 1);
    }
  });
  const offSettled = hooks.onRunSettled(async run => {
    const turn = open.get(run.runId);
    open.delete(run.runId);
    if (!turn) return;
    try {
      // Files cost a second full-tree snapshot, so only project and task runs pay it; everyday chats record no files.
      const baseline = run.chat.projectId ? context.db().prepare('SELECT tree_sha FROM review_baselines WHERE run_id = ?').get(run.runId) as { tree_sha: string | null } | undefined : undefined;
      const files = run.chat.projectId ? await filesChanged(turn.cwd, baseline?.tree_sha ?? null) : null;
      const pricing = (() => { try { const provider = context.modelCatalog?.().providers.find(p => p.id === run.chat.providerId) as unknown as { models?: { id: string; pricing?: unknown }[] } | undefined; return provider?.models?.find(m => m.id === run.chat.model)?.pricing ?? null; } catch { return null; } })();
      const endedAt = new Date().toISOString();
      const entry = ledger().append({
        id: `${run.chat.id}:${run.runId}`, chatId: run.chat.id, runId: run.runId, taskId: null, projectId: run.chat.projectId ?? null,
        trigger: run.chat.projectId ? 'project chat' : 'chat', agent: run.chat.title || 'Agent', provider: run.chat.providerId ?? null, model: run.chat.model ?? null,
        tokens: { input: turn.usage.inputTokens, cached: turn.usage.cachedInputTokens, output: turn.usage.outputTokens, reasoning: turn.usage.reasoningOutputTokens },
        costUsd: estimateCostUsd(turn.usage, pricing as never), tools: [...turn.tools].map(([name, count]) => ({ name, count })), approvals: turn.approvals, tests: turn.tests,
        files, startedAt: new Date(turn.startedAt).toISOString(), endedAt, durationMs: Date.now() - turn.startedAt, outcome: run.status,
      });
      onAppend?.(entry);
    } catch { /* the ledger never fails a run */ }
  });
  return () => { offStart(); offEvent(); offSettled(); open.clear(); byChat.clear(); };
}
