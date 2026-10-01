/** Dashboard aggregates (#132, #193): turns per local day and outcome and this month's spend come from SQL over the
 *  Ledger (live receipts + imported history); unpriced months read null, never $0; Paperclip runs join in once. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { TurnLedger } from '../src/runtime/turn-ledger.ts';
import { buildDashboard, dayRange, ledgerAggregates, localDay, monthStart, outcomeOf } from '../src/runtime/workspace-dashboard.ts';

const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const body = (i: number, endedAt: string, outcome: string, costUsd: number | null, projectId: string | null = null, chatId: string | null = 'c') => ({ id: `t${i}`, chatId, runId: `r${i}`, taskId: null, projectId, trigger: 'chat', agent: 'CTO', provider: null, model: null, tokens: null, costUsd, tools: [], approvals: 0, tests: 0, files: null, startedAt: endedAt, endedAt, durationMs: 1, outcome }) as any;

function ledger() {
  const db = new DatabaseSync(':memory:');
  const l = new TurnLedger(db);
  l.append({ ...body(1, '2026-09-29T09:00:00.000Z', 'completed', 0.5, 'p1'), tokens: { input: 1000, cached: 200, output: 300, reasoning: 0 } });
  l.append(body(2, '2026-09-29T10:00:00.000Z', 'failed', null, 'p1'));
  l.append(body(3, '2026-09-28T23:30:00.000Z', 'completed', 1.25, 'p2'));
  l.append(body(4, '2026-08-20T10:00:00.000Z', 'completed', 9, 'p1')); // last month: not in this month's spend, not in 14 days
  l.importHistory([body(5, '2026-09-27T10:00:00.000Z', 'completed', null, 'p1'), body(6, '2026-09-27T11:00:00.000Z', 'failed', null, null, null)]);
  return db;
}

test('local days and the month start follow the caller’s UTC offset', () => {
  assert.equal(localDay('2026-09-28T23:30:00.000Z', 330), '2026-09-29', 'IST: 23:30 UTC is the next morning');
  assert.equal(localDay('2026-09-28T23:30:00.000Z', 0), '2026-09-28');
  const days = dayRange(NOW, 0);
  assert.equal(days.length, 14); assert.equal(days[13], '2026-09-29'); assert.equal(days[0], '2026-09-16');
  assert.equal(monthStart(NOW, 0), '2026-09-01T00:00:00.000Z');
  assert.equal(monthStart(NOW, 330), '2026-08-31T18:30:00.000Z');
  assert.deepEqual(['completed', 'succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted'].map(outcomeOf), ['succeeded', 'succeeded', 'failed', 'failed', 'other', 'other']);
});

test('the Ledger is aggregated in SQL: turns by day and outcome, and this month’s priced and unpriced turns', () => {
  const db = ledger();
  const since = new Date(NOW - 15 * 86_400_000).toISOString();
  const a = ledgerAggregates(db, { since, monthStart: monthStart(NOW, 0), offset: 0, skipImportedPaperclip: false });
  const count = (day: string, outcome: string) => a.turns.find(t => t.day === day && t.outcome === outcome)?.count ?? 0;
  assert.equal(count('2026-09-29', 'completed'), 1); assert.equal(count('2026-09-29', 'failed'), 1); assert.equal(count('2026-09-28', 'completed'), 1);
  assert.equal(count('2026-09-27', 'failed'), 1, 'imported history counts');
  assert.ok(!a.turns.some(t => t.day === '2026-08-20'), 'older than the window');
  assert.deepEqual(a.spend, { usd: 1.75, priced: 2, unpriced: 3, tokens: 1300 }, 'tokens: input + output this month, priced or not');
  // A linked Paperclip reports its own runs: the imported copies (history rows without a chat) are left out.
  const linked = ledgerAggregates(db, { since, monthStart: monthStart(NOW, 0), offset: 0, skipImportedPaperclip: true });
  assert.equal(linked.spend.unpriced, 2);
  // One project (the Budget tab).
  const p1 = ledgerAggregates(db, { since, monthStart: monthStart(NOW, 0), offset: 0, skipImportedPaperclip: false, projectId: 'p1' });
  assert.deepEqual(p1.spend, { usd: 0.5, priced: 1, unpriced: 2, tokens: 1300 });
});

test('buildDashboard: 14 days of run activity, tasks by day and status, and spend that is null (unpriced), never $0', () => {
  const db = ledger();
  const since = new Date(NOW - 15 * 86_400_000).toISOString();
  const d = buildDashboard({ now: NOW, offset: 0, ledger: ledgerAggregates(db, { since, monthStart: monthStart(NOW, 0), offset: 0, skipImportedPaperclip: false }),
    local: { byDay: [{ day: '2026-09-29', state: 'running', count: 2 }, { day: '2026-09-29', state: 'verified', count: 1 }, { day: '2026-09-29', state: 'needs-input', count: 1 }, { day: '2026-01-01', state: 'todo', count: 9 }],
      activity: [{ id: 'a1', projectId: 'p1', actor: 'You', kind: 'member.added', summary: 'Added CTO as Chief Technology Officer', refId: null, createdAt: '2026-09-29T11:00:00.000Z', projectName: 'OSSMANAGER' }] },
    paperclip: null });
  assert.equal(d.runs.length, 14);
  assert.deepEqual(d.runs.at(-1), { day: '2026-09-29', succeeded: 1, failed: 1, other: 0 });
  assert.deepEqual(d.tasksByDay.at(-1)!.counts, { in_progress: 2, done: 1, in_review: 1 });
  assert.equal(d.spend.usd, 1.75); assert.equal(d.spend.unpricedTurns, 3);
  assert.equal(d.activity[0].summary, 'Added CTO as Chief Technology Officer'); assert.equal(d.activity[0].projectName, 'OSSMANAGER');
  // A month of turns with no known price: unknown, not $0.
  const unpriced = buildDashboard({ now: NOW, offset: 0, ledger: { turns: [], spend: { usd: 0, priced: 0, unpriced: 4 } }, local: null, paperclip: null });
  assert.equal(unpriced.spend.usd, null); assert.equal(unpriced.spend.unpricedTurns, 4);
  // Paperclip runs and cost join in.
  const withPc = buildDashboard({ now: NOW, offset: 0, ledger: { turns: [], spend: { usd: 0, priced: 0, unpriced: 0 } }, local: null,
    paperclip: { name: 'RagnarDataOps', tasks: [{ status: 'blocked', updatedAt: '2026-09-29T08:00:00.000Z' } as any], activity: [{ id: 'x', title: 'updated · agent', detail: 'board 1234', status: null, at: '2026-09-29T07:00:00.000Z', source: 'paperclip' }],
      receipts: [{ endedAt: '2026-09-29T09:00:00.000Z', outcome: 'succeeded', costUsd: 0.2 } as any, { endedAt: '2026-09-28T09:00:00.000Z', outcome: 'failed', costUsd: null } as any] } });
  assert.deepEqual(withPc.runs.at(-1), { day: '2026-09-29', succeeded: 1, failed: 0, other: 0 });
  assert.equal(withPc.spend.usd, 0.2); assert.equal(withPc.spend.unpricedTurns, 1); assert.match(withPc.spend.source, /RagnarDataOps/);
  assert.deepEqual(withPc.tasksByDay.at(-1)!.counts, { blocked: 1 });
  assert.equal(withPc.activity[0].source, 'paperclip');
});
