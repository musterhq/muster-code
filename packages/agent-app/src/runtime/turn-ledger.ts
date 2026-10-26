/**
 * The turn ledger (#115, Phase 1 audit foundation): every agent turn Muster runs appends one entry — trigger, agent,
 * provider/model, tokens (in / cached / out / reasoning) and cost, tools used, approvals, the files it changed observed
 * from disk against the review baseline (before/after blob hashes; every turn in a Git work tree, worktrees included), duration and outcome. Entries are hash-chained:
 * each stores sha256(previous hash + canonical entry), so editing or deleting a past entry breaks every later hash.
 * `verify()` walks the chain. Recording is observation only; it never blocks or fails a run.
 *
 * Imported history (#190) lives beside the chain in `turn_ledger_history`: turns that ran before the Ledger existed,
 * rebuilt by ledger-history.ts. Those rows are unchained on purpose (source `history`, no seq or hash): the chain only
 * vouches for what Muster observed live, so importing history never rewrites or weakens it, and `verify()` is unchanged.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import type { LedgerEntry, LedgerFile } from '../shared/domains/paperclip-protocol.ts';
import { addUsage, assumesCacheWriteRate, effectivePricing, estimateCostUsd, ZERO_USAGE, type ModelPricing, type UsageTotals } from '../shared/model-catalog.ts';
import { usageStep, type UsageCursor } from './model-usage.ts';
import { ReviewBaselineStore, snapshotTree } from './review-baseline.ts';
import type { DomainContext } from './domains/types.ts';

const GENESIS = '0'.repeat(64);
export type Body = Omit<LedgerEntry, 'seq' | 'hash' | 'prevHash' | 'source'>;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, (v as Record<string, unknown>)[k]])) : v);
export const entryHash = (prevHash: string, body: Body) => createHash('sha256').update(prevHash).update('\n').update(canonical(body)).digest('hex');
/** First entry number a tail/saved-head mismatch touches: the first removed entry after a truncation, or the saved head
 *  itself when the chain was rewritten up to the same length. */
const mismatchAt = (tail: { seq: number }, saved: { seq: number }) => tail.seq < saved.seq ? tail.seq + 1 : saved.seq;

export class TurnLedger {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS turn_ledger (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, chat_id TEXT NOT NULL, run_id TEXT NOT NULL,
      project_id TEXT, body TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS turn_ledger_chat ON turn_ledger(chat_id, seq);
      CREATE INDEX IF NOT EXISTS turn_ledger_project ON turn_ledger(project_id, seq);
      CREATE INDEX IF NOT EXISTS turn_ledger_created ON turn_ledger(created_at);
      CREATE TABLE IF NOT EXISTS turn_ledger_history (id TEXT PRIMARY KEY, chat_id TEXT, project_id TEXT, body TEXT NOT NULL, ended_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS turn_ledger_history_chat ON turn_ledger_history(chat_id, ended_at);
      CREATE INDEX IF NOT EXISTS turn_ledger_history_project ON turn_ledger_history(project_id, ended_at);
      CREATE INDEX IF NOT EXISTS turn_ledger_history_ended ON turn_ledger_history(ended_at);`);
    // The baselines a Receipt diffs against, created up front: a turn that settles before the review domain's first
    // (fire-and-forget) capture must still find the table rather than lose its whole entry.
    new ReviewBaselineStore(db);
    // The head the chain should end at, saved with every receipt (#179). Rehashing rows alone cannot see the newest
    // receipts being deleted or the whole chain being rewritten; comparing against this saved head can. A ledger from
    // before this table existed adopts its current tail the first time it is opened.
    db.exec('CREATE TABLE IF NOT EXISTS turn_ledger_anchor (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL, hash TEXT NOT NULL, broken_at INTEGER)');
    if (!db.prepare('SELECT 1 FROM turn_ledger_anchor WHERE id = 1').get()) {
      const tail = this.tail();
      db.prepare('INSERT INTO turn_ledger_anchor (id, seq, hash, broken_at) VALUES (1, ?, ?, NULL)').run(tail.seq, tail.hash);
    }
  }
  private tail(): { seq: number; hash: string } {
    const row = this.db.prepare('SELECT seq, hash FROM turn_ledger ORDER BY seq DESC LIMIT 1').get() as { seq: number; hash: string } | undefined;
    return row ?? { seq: 0, hash: GENESIS };
  }
  private anchor(): { seq: number; hash: string; broken_at: number | null } {
    return this.db.prepare('SELECT seq, hash, broken_at FROM turn_ledger_anchor WHERE id = 1').get() as { seq: number; hash: string; broken_at: number | null };
  }
  head(): string { const row = this.db.prepare('SELECT hash FROM turn_ledger ORDER BY seq DESC LIMIT 1').get() as { hash: string } | undefined; return row?.hash ?? GENESIS; }
  append(body: Body): LedgerEntry {
    // One transaction: a quit between the receipt and the saved head would otherwise leave a healthy ledger that every
    // later check reports as tampered.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prevHash = this.head(), hash = entryHash(prevHash, body);
      // A tail that no longer matches the saved head was truncated or rewritten. Remember where, before the new receipt
      // chains onto the shortened tail, so appending can never make a broken ledger pass again.
      const tail = this.tail(), saved = this.anchor();
      if (saved.broken_at === null && (tail.seq !== saved.seq || tail.hash !== saved.hash)) this.db.prepare('UPDATE turn_ledger_anchor SET broken_at = ? WHERE id = 1').run(mismatchAt(tail, saved));
      const info = this.db.prepare('INSERT INTO turn_ledger (id, chat_id, run_id, project_id, body, prev_hash, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(body.id, body.chatId ?? '', body.runId, body.projectId, canonical(body), prevHash, hash, body.endedAt);
      this.db.prepare('UPDATE turn_ledger_anchor SET seq = ?, hash = ? WHERE id = 1').run(Number(info.lastInsertRowid), hash);
      // A task run's chat is Ledger-era from its first turn: a history row the backfill made for it while it was idle
      // between turns would show the same turn twice (under the chat title). History is not chained, so it can go.
      if (body.trigger === 'task' && body.chatId) this.db.prepare('DELETE FROM turn_ledger_history WHERE chat_id = ?').run(body.chatId);
      this.db.exec('COMMIT');
      return { ...body, seq: Number(info.lastInsertRowid), prevHash, hash, source: 'local' };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  /** Imported history: one row per past turn, keyed by its id, so importing again adds nothing. Returns how many were new. */
  importHistory(bodies: readonly Body[]): number {
    const insert = this.db.prepare('INSERT OR IGNORE INTO turn_ledger_history (id, chat_id, project_id, body, ended_at) VALUES (?, ?, ?, ?, ?)');
    let added = 0;
    for (const body of bodies) added += Number(insert.run(body.id, body.chatId, body.projectId, canonical(body), body.endedAt).changes);
    return added;
  }
  /** Live receipts and imported history, newest first. */
  list(filter: { chatIds?: readonly string[]; projectId?: string; limit?: number } = {}): LedgerEntry[] {
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
    const rows = filter.chatIds?.length
      ? this.db.prepare(`SELECT * FROM turn_ledger WHERE chat_id IN (${filter.chatIds.map(() => '?').join(',')}) ORDER BY seq DESC LIMIT ?`).all(...filter.chatIds, limit)
      : filter.projectId ? this.db.prepare('SELECT * FROM turn_ledger WHERE project_id = ? ORDER BY seq DESC LIMIT ?').all(filter.projectId, limit)
      : this.db.prepare('SELECT * FROM turn_ledger ORDER BY seq DESC LIMIT ?').all(limit);
    const history = filter.chatIds?.length
      ? this.db.prepare(`SELECT body FROM turn_ledger_history WHERE chat_id IN (${filter.chatIds.map(() => '?').join(',')}) ORDER BY ended_at DESC LIMIT ?`).all(...filter.chatIds, limit)
      : filter.projectId ? this.db.prepare('SELECT body FROM turn_ledger_history WHERE project_id = ? ORDER BY ended_at DESC LIMIT ?').all(filter.projectId, limit)
      : this.db.prepare('SELECT body FROM turn_ledger_history ORDER BY ended_at DESC LIMIT ?').all(limit);
    const live = (rows as { seq: number; body: string; prev_hash: string; hash: string }[]).map(r => ({ ...(JSON.parse(r.body) as Body), seq: r.seq, prevHash: r.prev_hash, hash: r.hash, source: 'local' as const }));
    if (!history.length) return live;
    const imported = (history as { body: string }[]).map(r => ({ ...(JSON.parse(r.body) as Body), seq: null, prevHash: null, hash: null, source: 'history' as const }));
    return [...live, ...imported].sort((a, b) => b.endedAt.localeCompare(a.endedAt)).slice(0, limit);
  }
  /** Recomputes every hash in order, then compares the tail with the head saved when the last receipt was written.
   *  `brokenAt` is the first entry whose stored hash or link does not match, or the first entry a truncation or rewrite
   *  removed or replaced. */
  verify(): { ok: boolean; entries: number; head: string; brokenAt: number | null } {
    let prev = GENESIS, count = 0, last = 0;
    for (const row of this.db.prepare('SELECT seq, body, prev_hash, hash FROM turn_ledger ORDER BY seq').iterate() as Iterable<{ seq: number; body: string; prev_hash: string; hash: string }>) {
      count++;
      if (row.prev_hash !== prev || entryHash(prev, JSON.parse(row.body) as Body) !== row.hash) return { ok: false, entries: count, head: prev, brokenAt: row.seq };
      prev = row.hash; last = row.seq;
    }
    // Entries cut from the end leave the chain internally consistent; AUTOINCREMENT remembers the highest seq ever issued
    // (this also catches a cut made before the saved head below existed).
    let issued = 0;
    try { issued = Number((this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'turn_ledger'").get() as { seq: number } | undefined)?.seq ?? 0); } catch { /* no sequence table yet: nothing was ever appended */ }
    if (issued > last) return { ok: false, entries: count, head: prev, brokenAt: last + 1 };
    const saved = this.anchor();
    if (saved.broken_at !== null) return { ok: false, entries: count, head: prev, brokenAt: saved.broken_at };
    if (last !== saved.seq || prev !== saved.hash) return { ok: false, entries: count, head: prev, brokenAt: mismatchAt({ seq: last }, saved) };
    return { ok: true, entries: count, head: prev, brokenAt: null };
  }
}

const git = (cwd: string, args: string[]) => new Promise<string>((resolve, reject) => execFile('git', args, { cwd, timeout: 5000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout) => error ? reject(error) : resolve(stdout)));
/** HEAD's commit, or null outside a Git work tree (or on an unborn branch). */
export const headCommit = (cwd: string) => git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']).then(out => out.trim() || null, () => null);
/** #387: when HEAD moved during a turn (checkout, merge, rebase, pull), the files that came in with commits made before the
 *  turn are not the turn's edits. The turn's own work is what differs from HEAD now plus what its own commits (made since it
 *  started) touched; null when that cannot be read. */
async function ownPaths(cwd: string, startedAt: number): Promise<Set<string> | null> {
  try {
    const [uncommitted, staged, untracked, committed] = await Promise.all([
      git(cwd, ['diff', '--name-only', '--no-renames', '-z', 'HEAD']),
      git(cwd, ['diff', '--cached', '--name-only', '--no-renames', '-z', 'HEAD']),
      git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
      git(cwd, ['log', `--since=@${Math.floor(startedAt / 1000)}`, '--no-renames', '--format=', '--name-only', '-z', 'HEAD']),
    ]);
    return new Set([uncommitted, staged, untracked, committed].flatMap(out => out.split(/[\0\n]/)).filter(Boolean));
  } catch { return null; }
}
/** Files a turn changed: its review baseline tree against the working tree now, with both blob hashes. When HEAD moved since
 *  `head.before`, only paths the turn itself touched are kept (#387). */
export async function filesChanged(cwd: string, beforeTree: string | null, head?: { before: string | null; startedAt: number }): Promise<LedgerFile[] | null> {
  if (!beforeTree) return null;
  try {
    // HEAD is read alongside the snapshot so the Receipt is not written any later than before (#387).
    const [after, headNow] = await Promise.all([snapshotTree(cwd), head ? headCommit(cwd) : Promise.resolve(null)]);
    if (after === beforeTree) return [];
    const [out, numstat] = await Promise.all([git(cwd, ['diff-tree', '-r', '--no-renames', '-z', beforeTree, after]), git(cwd, ['diff-tree', '-r', '--no-renames', '--numstat', '-z', beforeTree, after]).catch(() => '')]);
    const counts = new Map<string, { added: number | null; removed: number | null }>();
    for (const row of numstat.split('\0').filter(Boolean)) { const [a, r, ...path] = row.split('\t'); counts.set(path.join('\t'), { added: a === '-' ? null : Number(a), removed: r === '-' ? null : Number(r) }); }
    const parts = out.split('\0').filter(Boolean), files: LedgerFile[] = [];
    const own = head && head.before && headNow && headNow !== head.before ? await ownPaths(cwd, head.startedAt) : undefined;
    for (let i = 0; i + 1 < parts.length && files.length < 200; i += 2) {
      const [, , before, afterHash, status] = parts[i].slice(1).split(' '), path = parts[i + 1], n = counts.get(path);
      if (own && !own.has(path)) continue;
      files.push({ path, status: status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified', before: /^0+$/.test(before) ? null : before, after: /^0+$/.test(afterHash) ? null : afterHash, added: n?.added ?? null, removed: n?.removed ?? null });
    }
    return files;
  } catch { return null; }
}

/** Emitted by the service only when an approval card is actually shown; Full-access auto-accepts and policy allows never emit it. */
export const APPROVAL_SHOWN_EVENT = 'muster/approval/shown';
export const TOOL_TYPES = new Set(['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'fileChange', 'webSearch', 'imageView']);
const MAX_OPEN_RUNS = 1000;
interface Open { chatId: string; startedAt: number; cwd: string; /** HEAD when the turn started, read without blocking the start (#387). */ head: Promise<string | null>; usage: UsageTotals; /** A message's usage arrived before its final count (#663). */ partial?: true; cursor?: UsageCursor; tools: Map<string, number>; approvals: number; tests: number }
/** How a tool shows in a Receipt: `server/tool` for MCP, `shell` for commands, else the item type. */
export const toolName = (type: string, server: unknown, tool: unknown) => type === 'mcpToolCall' ? `${server ?? 'mcp'}/${tool ?? 'tool'}` : type === 'commandExecution' ? 'shell' : type;
export const TEST_COMMAND = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b|\bnode\s+--test\b|\bvitest\b|\bjest\b|\bmake\s+test\b/;

/** Wires the ledger to the run hooks. Returns an unsubscribe. Safe in bare test contexts (no hooks). */
/** Who a project run worked for: the task whose attempt ran in this chat, and its Roster owner's name. */
export type RunAttribution = (run: { chatId: string; projectId: string }) => Promise<{ taskId: string; agent: string } | null>;

export function attachTurnLedger(context: DomainContext, ledger: () => TurnLedger, onAppend?: (entry: LedgerEntry) => void, attribute?: RunAttribution): () => void {
  const hooks = context.hooks;
  if (!hooks?.onRunStarted || !hooks.onRunSettled || !hooks.onProviderEvent) return () => undefined;
  const open = new Map<string, Open>();
  const byChat = new Map<string, string>();
  const release = (runId: string) => {
    const turn = open.get(runId);
    open.delete(runId);
    if (turn && byChat.get(turn.chatId) === runId) byChat.delete(turn.chatId);
    return turn;
  };
  const offStart = hooks.onRunStarted(run => {
    const previous = byChat.get(run.chat.id);
    if (previous) release(previous);
    // Bound abandoned runs without timers or work on provider events. Evicted runs produce no partial receipts.
    if (open.size >= MAX_OPEN_RUNS) release(open.keys().next().value!);
    open.set(run.runId, { chatId: run.chat.id, startedAt: Date.now(), cwd: run.cwd, head: run.cwd ? headCommit(run.cwd) : Promise.resolve(null), usage: { ...ZERO_USAGE }, tools: new Map(), approvals: 0, tests: 0 });
    byChat.set(run.chat.id, run.runId);
  });
  const offEvent = hooks.onProviderEvent(event => {
    const runId = byChat.get(event.chat.id), turn = runId ? open.get(runId) : undefined;
    if (!turn) return;
    const step = usageStep(turn.cursor, event.method, event.params);
    if (step) { turn.cursor = step.cursor; turn.usage = addUsage(turn.usage, step.delta); if (step.partial) turn.partial = true; return; }
    if (event.method === APPROVAL_SHOWN_EVENT) { turn.approvals++; return; }
    if (event.method === 'item/started') {
      const item = (event.params.item ?? {}) as Record<string, unknown>, type = typeof item.type === 'string' ? item.type : '';
      if (!TOOL_TYPES.has(type)) return;
      const name = toolName(type, item.server, item.tool);
      if (type === 'commandExecution' && TEST_COMMAND.test(String(item.command ?? ''))) turn.tests++;
      turn.tools.set(name, (turn.tools.get(name) ?? 0) + 1);
    }
  });
  const offSettled = hooks.onRunSettled(async run => {
    const turn = release(run.runId);
    if (!turn) return;
    try {
      // Files cost a second full-tree snapshot, taken for every turn that has a baseline. That includes a Work locally chat
      // (a checkout worktree, which has no projectId) and any Git folder, whatever the provider or how it edits: null means
      // only that the folder is not a Git work tree or its snapshot failed, never that the chat kind skipped it.
      // A files error costs the Receipt its file list (null), never the whole entry.
      let files: LedgerFile[] | null = null;
      try {
        ledger();
        const baseline = context.db().prepare('SELECT tree_sha FROM review_baselines WHERE run_id = ?').get(run.runId) as { tree_sha: string | null } | undefined;
        files = await filesChanged(turn.cwd, baseline?.tree_sha ?? null, { before: await turn.head, startedAt: turn.startedAt });
      } catch { files = null; }
      const catalog = (() => { try { const provider = context.modelCatalog?.().providers.find(p => p.id === run.chat.providerId) as unknown as { models?: { id: string; pricing?: ModelPricing }[] } | undefined; return provider?.models?.find(m => m.id === run.chat.model)?.pricing; } catch { return undefined; } })();
      // The user's Settings price wins over the catalog's, as in Settings usage and the Dashboard (effectivePricing). Read
      // once at settlement, never on provider events; the cost is stamped into the chained entry, so a later price change
      // never rewrites a recorded turn. No price anywhere stays unknown (null), never $0.
      let pricing: ModelPricing | null = catalog ?? null;
      if (run.chat.providerId && run.chat.model) {
        try { pricing = effectivePricing(await context.invoke('models.policy.get', {}), run.chat.providerId, run.chat.model, catalog); } catch { /* policy unreadable: the catalog price, if any */ }
      }
      const endedAt = new Date().toISOString();
      // A task run is the task's: its Roster owner, the task, trigger "task" (Costs, Timeline and task links key on these).
      const owner = run.chat.projectId && attribute ? await attribute({ chatId: run.chat.id, projectId: run.chat.projectId }).catch(() => null) : null;
      const entry = ledger().append({
        id: `${run.chat.id}:${run.runId}`, chatId: run.chat.id, runId: run.runId, taskId: owner?.taskId ?? null, projectId: run.chat.projectId ?? null,
        trigger: owner ? 'task' : run.chat.projectId ? 'project chat' : 'chat', agent: owner?.agent || run.chat.title || 'Agent', provider: run.chat.providerId ?? null, model: run.chat.model ?? null,
        tokens: { input: turn.usage.inputTokens, cached: turn.usage.cachedInputTokens, output: turn.usage.outputTokens, reasoning: turn.usage.reasoningOutputTokens, ...(turn.usage.cacheWriteTokens ? { cacheWrite: turn.usage.cacheWriteTokens } : {}) },
        costUsd: estimateCostUsd(turn.usage, pricing), ...(turn.partial || assumesCacheWriteRate(turn.usage, pricing) ? { estimated: true as const } : {}), tools: [...turn.tools].map(([name, count]) => ({ name, count })), approvals: turn.approvals, tests: turn.tests,
        files, startedAt: new Date(turn.startedAt).toISOString(), endedAt, durationMs: Date.now() - turn.startedAt, outcome: run.status,
      });
      onAppend?.(entry);
    } catch { /* the ledger never fails a run */ }
  });
  return () => { offStart(); offEvent(); offSettled(); open.clear(); byChat.clear(); };
}
