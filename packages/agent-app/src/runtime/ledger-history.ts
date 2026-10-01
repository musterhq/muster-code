/**
 * Imported history for the Ledger (#190). The turn ledger records from the first turn after an upgrade, so a user with
 * months of chats would open an empty Ledger. This rebuilds one entry per past turn from what the app already saved:
 * each chat's timeline (a turn is a user message and everything up to the next one: tools, approvals, test commands,
 * start and end), the chat's provider, model and project, and its stored token usage. Imported Paperclip activity (agent
 * comments from Import from Paperclip, grouped by the run that wrote them) comes in the same way.
 *
 * Entries are written to `turn_ledger_history`, never to the hash chain: they are labelled imported history (source
 * `history`), and `TurnLedger.verify()` still covers exactly the live receipts.
 *
 * Cost: runs in the background after startup, a small batch of chats per tick, reading only the columns it needs (tool
 * payloads stay in SQLite). Each chat is imported once (`turn_ledger_backfill`), each entry has a stable id, so running
 * it again adds nothing. A chat that is busy is left for the next run; a turn the live ledger already recorded is skipped.
 */
import type { DatabaseSync } from 'node:sqlite';
import { estimateCostUsd, type ModelPricing, type UsageTotals } from '../shared/model-catalog.ts';
import { TEST_COMMAND, TOOL_TYPES, toolName, type Body, type TurnLedger } from './turn-ledger.ts';

const CHATS_PER_BATCH = 25, MAX_ITEMS_PER_CHAT = 20_000, MAX_PAPERCLIP_RUNS = 2000;
/** A receipt is written in the same transaction as its user message; this absorbs clock skew between the two rows. */
const RECEIPT_SLACK_MS = 2000;
const BUSY = ['running', 'stopping', 'waiting', 'queued', 'reconnecting'];

export interface HistoryOptions {
  pricing?(providerId: string, model: string): ModelPricing | null | undefined;
  /** Yields between batches (the domain passes a macrotask tick so other work runs in between). */
  pause?(): Promise<void>;
  /** Checked between batches: true stops early (the app is closing). What was imported stays; the rest is picked up next time. */
  stopped?(): boolean;
}
export interface HistoryResult { chats: number; turns: number }

interface ChatRow { id: string; project_id: string | null; title: string; status: string; provider_id: string | null; model: string | null }
interface ItemRow { id: string; kind: string; created_at: string; type: string | null; server: string | null; tool: string | null; command: string | null }
export interface Turn { userId: string; startedAt: string; endedAt: string; tools: Map<string, number>; approvals: number; tests: number }

const hasTable = (db: DatabaseSync, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
const ms = (iso: string) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };

/** Splits a chat's timeline into turns: each user message opens one, and everything after it belongs to it. */
export function splitTurns(items: readonly ItemRow[]): Turn[] {
  const turns: Turn[] = [];
  let turn: Turn | undefined;
  for (const item of items) {
    if (item.kind === 'user') { turn = { userId: item.id, startedAt: item.created_at, endedAt: item.created_at, tools: new Map(), approvals: 0, tests: 0 }; turns.push(turn); continue; }
    if (!turn) continue;
    if (item.created_at > turn.endedAt) turn.endedAt = item.created_at;
    if (item.kind === 'approval') turn.approvals++;
    else if (item.kind === 'tool' && item.type && TOOL_TYPES.has(item.type)) {
      const name = toolName(item.type, item.server, item.tool);
      turn.tools.set(name, (turn.tools.get(name) ?? 0) + 1);
      if (item.type === 'commandExecution' && TEST_COMMAND.test(item.command ?? '')) turn.tests++;
    }
  }
  return turns;
}

/**
 * The run ids behind each turn. A send writes its receipt and its user message in one transaction, so a receipt opens
 * the first unclaimed user message at or just after it; a receipt with none (Retry re-runs a turn's own message) belongs
 * to the turn it falls in.
 */
export function matchReceipts(turns: readonly Turn[], receipts: readonly { run_id: string; created_at: string }[]): string[][] {
  const runs = turns.map(() => [] as string[]);
  let cursor = 0;
  for (const receipt of receipts) {
    const at = ms(receipt.created_at);
    if (at === null) continue;
    while (cursor < turns.length && (ms(turns[cursor].startedAt) ?? 0) < at) cursor++;
    if (cursor < turns.length && (ms(turns[cursor].startedAt) ?? Infinity) - at <= RECEIPT_SLACK_MS && !runs[cursor].length) { runs[cursor].push(receipt.run_id); cursor++; continue; }
    let owner = -1;
    for (let i = 0; i < turns.length && (ms(turns[i].startedAt) ?? Infinity) <= at; i++) owner = i;
    if (owner >= 0) runs[owner].push(receipt.run_id);
  }
  return runs;
}

function chatEntries(db: DatabaseSync, chat: ChatRow, tables: { receipts: boolean; usage: boolean }, options: HistoryOptions): Body[] {
  const json = (path: string) => `CASE WHEN json_valid(data) THEN json_extract(data, '${path}') END`;
  const items = db.prepare(`SELECT id, kind, created_at, ${json('$.type')} AS type, ${json('$.server')} AS server, ${json('$.tool')} AS tool, substr(${json('$.command')}, 1, 400) AS command
    FROM timeline WHERE chat_id = ? ORDER BY seq LIMIT ?`).all(chat.id, MAX_ITEMS_PER_CHAT) as unknown as ItemRow[];
  const turns = splitTurns(items);
  if (!turns.length) return [];
  // A task run's chat was made by Start after the Ledger existed: every turn in it is a live Receipt already (its runs
  // are dispatched, not sent, so no send receipt links them). Importing it again would add each turn twice.
  if (db.prepare("SELECT 1 FROM turn_ledger WHERE chat_id = ? AND json_extract(body, '$.trigger') = 'task' LIMIT 1").get(chat.id)) return [];
  // Turns the live ledger already has (matched through the send receipt's run id) are not imported again.
  const live = new Set((db.prepare('SELECT run_id FROM turn_ledger WHERE chat_id = ?').all(chat.id) as { run_id: string }[]).map(r => r.run_id));
  const receipts = tables.receipts ? (db.prepare('SELECT run_id, created_at FROM receipts WHERE chat_id = ? ORDER BY created_at, rowid').all(chat.id) as { run_id: string; created_at: string }[]) : [];
  const runsOf = matchReceipts(turns, receipts);
  const kept: { turn: Turn; runId: string | null; last: boolean }[] = [];
  turns.forEach((turn, index) => {
    const runs = runsOf[index];
    if (runs.some(run => live.has(run))) return;
    kept.push({ turn, runId: runs.at(-1) ?? null, last: index === turns.length - 1 });
  });
  // Usage is stored per chat, not per turn: it is shown only where it belongs to exactly one imported turn.
  let usage: UsageTotals | null = null;
  if (tables.usage && kept.length === 1 && turns.length === 1 && !live.size) {
    const row = db.prepare(`SELECT SUM(input_tokens) AS i, SUM(cached_input_tokens) AS c, SUM(output_tokens) AS o, SUM(reasoning_output_tokens) AS r, SUM(requests) AS n FROM model_usage WHERE chat_id = ?`).get(chat.id) as { i: number | null; c: number | null; o: number | null; r: number | null; n: number | null } | undefined;
    if (row?.n) usage = { inputTokens: Number(row.i ?? 0), cachedInputTokens: Number(row.c ?? 0), outputTokens: Number(row.o ?? 0), reasoningOutputTokens: Number(row.r ?? 0), requests: Number(row.n) };
  }
  const provider = chat.provider_id || null, model = chat.model || null;
  const pricing = usage && provider && model ? options.pricing?.(provider, model) ?? null : null;
  return kept.map(({ turn, runId, last }) => {
    const start = ms(turn.startedAt), end = ms(turn.endedAt);
    return {
      id: `history:${chat.id}:${turn.userId}`, chatId: chat.id, runId: runId ?? `history:${turn.userId}`, taskId: null, projectId: chat.project_id ?? null,
      trigger: chat.project_id ? 'project chat' : 'chat', agent: chat.title || 'Agent', provider, model,
      tokens: usage ? { input: usage.inputTokens, cached: usage.cachedInputTokens, output: usage.outputTokens, reasoning: usage.reasoningOutputTokens } : null,
      costUsd: usage ? estimateCostUsd(usage, pricing) : null,
      tools: [...turn.tools].map(([name, count]) => ({ name, count })), approvals: turn.approvals, tests: turn.tests, files: null,
      startedAt: turn.startedAt, endedAt: turn.endedAt, durationMs: start !== null && end !== null ? Math.max(0, end - start) : null,
      outcome: last && (chat.status === 'failed' || chat.status === 'interrupted') ? chat.status : 'completed',
    };
  });
}

/** Paperclip runs brought in by Import from Paperclip: one entry per run that wrote agent comments. */
export function paperclipHistory(db: DatabaseSync): Body[] {
  if (!hasTable(db, 'paperclip_import_comments')) return [];
  const mapped = hasTable(db, 'paperclip_import_map');
  const rows = db.prepare(`SELECT c.run_id AS run_id, c.task_id AS task_id, MIN(c.created_at) AS started, MAX(c.created_at) AS ended, MAX(c.author_label) AS agent
      ${mapped ? `, (SELECT CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.projectId') END FROM paperclip_import_map m WHERE m.kind = 'task' AND m.muster_id = c.task_id LIMIT 1) AS project_id` : ', NULL AS project_id'}
    FROM paperclip_import_comments c WHERE c.run_id IS NOT NULL AND c.run_id <> '' AND c.author_kind = 'agent' AND c.created_at <> ''
    GROUP BY c.run_id ORDER BY ended DESC LIMIT ?`).all(MAX_PAPERCLIP_RUNS) as { run_id: string; task_id: string; started: string; ended: string; agent: string | null; project_id: unknown }[];
  return rows.map(r => {
    const start = ms(r.started), end = ms(r.ended);
    return {
      id: `history:paperclip:${r.run_id}`, chatId: null, runId: r.run_id, taskId: r.task_id, projectId: typeof r.project_id === 'string' ? r.project_id : null,
      trigger: 'Paperclip run', agent: r.agent || 'Agent', provider: null, model: null, tokens: null, costUsd: null, tools: [], approvals: 0, tests: 0, files: null,
      startedAt: r.started, endedAt: r.ended, durationMs: start !== null && end !== null ? Math.max(0, end - start) : null, outcome: 'completed',
    };
  });
}

/** Imports every chat not imported yet, a batch at a time, then the imported Paperclip runs. Safe to call repeatedly. */
export async function importLedgerHistory(db: DatabaseSync, ledger: TurnLedger, options: HistoryOptions = {}): Promise<HistoryResult> {
  const result: HistoryResult = { chats: 0, turns: 0 };
  if (hasTable(db, 'chats') && hasTable(db, 'timeline')) {
    db.exec('CREATE TABLE IF NOT EXISTS turn_ledger_backfill (chat_id TEXT PRIMARY KEY, turns INTEGER NOT NULL, done_at TEXT NOT NULL)');
    const tables = { receipts: hasTable(db, 'receipts'), usage: hasTable(db, 'model_usage') };
    const next = db.prepare(`SELECT c.id, c.project_id, c.title, c.status, c.provider_id, c.model FROM chats c
      WHERE c.id > ? AND c.status NOT IN (${BUSY.map(() => '?').join(',')}) AND NOT EXISTS (SELECT 1 FROM turn_ledger_backfill b WHERE b.chat_id = c.id) ORDER BY c.id LIMIT ?`);
    const done = db.prepare('INSERT OR IGNORE INTO turn_ledger_backfill (chat_id, turns, done_at) VALUES (?, ?, ?)');
    let after = '';
    while (!options.stopped?.()) {
      const chats = next.all(after, ...BUSY, CHATS_PER_BATCH) as unknown as ChatRow[];
      if (!chats.length) break;
      after = chats.at(-1)!.id;
      db.exec('BEGIN');
      try {
        for (const chat of chats) {
          const added = ledger.importHistory(chatEntries(db, chat, tables, options));
          done.run(chat.id, added, new Date().toISOString());
          result.chats++; result.turns += added;
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      if (chats.length < CHATS_PER_BATCH) break;
      await options.pause?.();
    }
  }
  if (!options.stopped?.()) result.turns += ledger.importHistory(paperclipHistory(db));
  return result;
}
