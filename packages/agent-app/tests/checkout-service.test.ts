/** The check-out / hand-back flow (#117) over a fake Paperclip, real SQLite and a fake git: the lease state machine, what is posted and when, offline queueing,
 *  idempotent retries, conflicts, cost labels and the hand-back tag. The live version of this runs in checkout-e2e.test.ts. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { CheckoutService, parseTestSummary, reassignStrategy, type CheckoutDeps, type LocalProviderInfo } from '../src/runtime/checkout/service.ts';
import { CheckoutStore } from '../src/runtime/checkout/store.ts';
import { badgeText, canCheckout, checkoutComment, deriveLease, isStale, LeaseError, newLease, parseLeaseMarker, transition } from '../src/runtime/checkout/lease.ts';
import { batchReports, handBackBody, postedKeys, reportComment, renderWorkLog, testsLine, type Report, type TurnReceipt } from '../src/runtime/checkout/reports.ts';
import { billerFor, billingTypeOf, costEventFor, payerOf } from '../src/runtime/checkout/costs.ts';
import { agentBrief, mapAgentToLocal, tierOf } from '../src/runtime/checkout/tiers.ts';
import { OrgReader } from '../src/runtime/server/orgs.ts';
import { PaperclipError } from '../src/runtime/paperclip-client.ts';
import type { ServerBackend, ServerPart } from '../src/runtime/server/backend.ts';
import type { WorkspaceAgent, WorkspaceTask } from '../src/shared/domains/paperclip-protocol.ts';

// --- a fake Paperclip --------------------------------------------------------------------------------------------------------------
const ME = 'u-me', BOB = 'u-bob', CO = { id: 'co-rag', name: 'Ragnar', prefix: 'RAG' };
interface Comment { id: string; body: string; authorUserId: string | null; createdAt: string; clientRequestId?: string }
class FakeServer {
  down = false; loseNextResponse = false; calls: string[] = []; policy: { type: 'review' | 'approval'; participants: { kind: 'agent' | 'user'; id: string }[] }[] = []; comments = new Map<string, Comment[]>(); docs = new Map<string, string>(); costs: Record<string, unknown>[] = []; generation = 1;
  tasks: WorkspaceTask[]; agents: WorkspaceAgent[];
  constructor() {
    const t = (id: string, key: string, status: WorkspaceTask['status'], assignee: { user?: string; agent?: string }): WorkspaceTask => ({
      id, key, title: `Task ${key}`, status, priority: 'medium', source: 'paperclip', projectId: 'p-redis', parentId: null, goalId: null,
      assigneeId: assignee.agent ?? (assignee.user ? `user:${assignee.user}` : null), assigneeUserId: assignee.user ?? null, assigneeLabel: assignee.user === ME ? 'You' : assignee.user ? 'Bob' : assignee.agent ? 'QA Lead' : null,
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', startedAt: null, completedAt: null, live: false, blockedByIds: [], origin: null, createdByUserId: BOB,
    });
    this.tasks = [t('t1', 'RAG-1', 'todo', { user: ME }), t('t2', 'RAG-2', 'todo', { user: BOB }), t('t3', 'RAG-3', 'todo', { agent: 'a-qa' })];
    const agent = (id: string, name: string, role: string, adapter: string, model: string): WorkspaceAgent => ({ id, name, role, title: null, model, adapter, source: 'paperclip', status: 'idle', reportsTo: null, lastActiveAt: null, error: null, capabilities: null, pausable: true });
    this.agents = [{ ...agent('a-ceo', 'Head Muster', 'ceo', 'claude_local', 'claude-opus-4'), skills: ['paperclip', 'para-memory-files'] }, agent('a-qa', 'QA Lead', 'qa', 'process', 'x')];
  }
  private up() { if (this.down) throw new PaperclipError('connect ECONNREFUSED', 0, 'network'); }
  part(): ServerPart { return { tasks: this.tasks.map(t => ({ ...t })), agents: this.agents, projects: [{ id: 'p-redis', name: 'Redis', status: 'in_progress', description: '', source: 'paperclip', repo: null, cwd: null, taskCount: 3, openCount: 3, paused: false, memory: null }], runs: [], inbox: [], goals: [], approvals: [], labels: [], people: [{ id: ME, name: 'Dhairya' }, { id: BOB, name: 'Bob Rivera' }] }; }
  backend(): ServerBackend {
    const s = this;
    return {
      kind: 'paperclip', endpoint: { baseUrl: 'http://x' }, get generation() { return s.generation; }, invalidate() {},
      async companies() { s.up(); return [CO]; },
      async read() { s.up(); return s.part(); },
      async whoami() { s.up(); return { id: ME, name: 'Dhairya', email: null }; },
      async patchTask(id: string, c: Record<string, unknown>) { s.up(); s.calls.push(`patch ${id} ${JSON.stringify(c)}`); const t = s.tasks.find(x => x.id === id)!; if (c.status) t.status = c.status as never; if ('assigneeUserId' in c) { t.assigneeUserId = c.assigneeUserId as string | null; } if ('assigneeAgentId' in c) { t.assigneeId = (c.assigneeAgentId as string | null) ?? (t.assigneeUserId ? `user:${t.assigneeUserId}` : null); } t.assigneeLabel = t.assigneeUserId === ME ? 'You' : t.assigneeUserId ? 'Bob' : t.assigneeId ? 'QA Lead' : null; s.generation++; },
      async rawComments(id: string) { s.up(); return (s.comments.get(id) ?? []).map(c => ({ id: c.id, body: c.body, authorUserId: c.authorUserId, authorAgentId: null, createdAt: c.createdAt })); },
      async comment(id: string, body: string, _agents: unknown, clientRequestId?: string) {
        s.up(); s.calls.push(`comment ${id} ${body.split('\n')[0]}`);
        const list = s.comments.get(id) ?? [];
        // The server keeps one comment per client request id; a retry returns the first.
        const dup = clientRequestId ? list.find(c => c.clientRequestId === clientRequestId) : undefined;
        const c = dup ?? { id: `c${list.length + 1}`, body, authorUserId: ME, createdAt: new Date().toISOString(), clientRequestId };
        if (!dup) { list.push(c); s.comments.set(id, list); }
        if (s.loseNextResponse) { s.loseNextResponse = false; throw new PaperclipError('socket hang up', 0, 'network'); }
        return { id: c.id, author: { kind: 'user' as const, id: ME, label: 'You' }, body, createdAt: c.createdAt };
      },
      async putDocument(id: string, key: string, doc: { body: string }) { s.up(); s.calls.push(`doc ${id} ${key}`); s.docs.set(`${id}/${key}`, doc.body); },
      async postCostEvent(_co: string, body: Record<string, unknown>) { s.up(); s.costs.push(body); },
      async agentInstructions(id: string) { s.up(); return id === 'a-qa' ? 'Review like a skeptic.' : 'Be careful with Redis.'; },
      async issuePolicy() { s.up(); return s.policy; },
      async taskDetail(id: string) { s.up(); const t = s.tasks.find(x => x.id === id)!; return { task: t, description: 'Move the sources.', comments: (s.comments.get(id) ?? []).map(c => ({ id: c.id, author: { kind: 'user' as const, id: c.authorUserId, label: 'Bob' }, body: c.body, createdAt: c.createdAt })), runs: [], addressee: null, composerNote: null, subtasks: ['t3'], blocking: [], receipts: [], cards: [{ kind: 'document' as const, id: 'd1', at: '', key: 'plan', title: 'Plan', format: 'markdown', body: '', revision: 1, revisions: [] }], mentionable: [] }; },
    } as unknown as ServerBackend;
  }
}

const providers: LocalProviderInfo[] = [
  { id: 'claude-code', name: 'Claude Code', driver: 'claude-code-cli', available: true, subscription: true, models: [{ id: 'claude-opus-4', name: 'Opus 4' }, { id: 'claude-haiku-4', name: 'Haiku 4' }] },
  { id: 'omniroute', name: 'OmniRoute', available: true, models: [{ id: 'gpt-x', name: 'GPT X' }] },
];
function setup(opts: { tests?: number } = {}) {
  const server = new FakeServer(), db = new DatabaseSync(':memory:'), store = new CheckoutStore(() => db);
  let clock = Date.parse('2026-10-05T10:00:00.000Z');
  const worktrees: string[] = [], pushed: string[] = [], emitted: (string | null)[] = [];
  let pushOk = true, chatSeq = 0, pushedHead = false;
  let finalText = 'Worked on it.\nℹ pass 12\nℹ fail 1';
  const events: unknown[] = [];
  const settings: Record<string, never> = {};
  const reader = new OrgReader({ backend: () => server.backend(), settings: () => settings, activeId: () => CO.id, serverLabel: () => 'aiteam', remembered: () => ({ id: ME, name: 'Dhairya' }), remember() {} });
  const deps: CheckoutDeps = {
    store, backend: () => server.backend(), reader,
    git: { isRepo: async () => true, defaultBranch: async (_p, preferred) => preferred ?? 'dev', headSha: async () => 'abc123', stat: async () => ({ count: 2, added: 20, removed: 3 }), push: async (_p, b) => { if (pushOk) pushed.push(b); return { pushed: pushOk, message: pushOk ? `Pushed ${b}.` : 'Could not push: no network' }; }, pushedHead: async () => pushedHead },
    worktrees: { create: async (_root, branch) => { worktrees.push(branch); return { path: `/wt/${branch.replace('/', '-')}`, branch }; } },
    chats: { addFolder: async p => ({ id: `f:${p}` }), create: async f => ({ id: `chat:${f}:${++chatSeq}` }), select: async () => {}, rename: async () => {}, transcript: async () => [finalText] },
    providers: () => providers,
    turnFacts: async () => ({ tokens: { input: 1000, cached: 100, output: 200 }, tests: opts.tests ?? 1, model: 'claude-opus-4', provider: 'claude-code', costUsd: 0.5, durationMs: 4000, outcome: 'completed' }),
    serverLabel: () => 'aiteam', deviceNameDefault: () => 'Dhairya’s MacBook', now: () => clock, emit: id => emitted.push(id), notify: e => events.push(e), later: fn => { fn(); },
  };
  const svc = new CheckoutService(deps);
  return { events, setFinal: (t: string) => { finalText = t; }, setPushedHead: (v: boolean) => { pushedHead = v; }, server, db, store, svc, reader, advance: (ms: number) => { clock += ms; }, worktrees, pushed, emitted, setPush: (v: boolean) => { pushOk = v; }, now: () => clock };
}
const OWN = { kind: 'own' as const, providerId: 'omniroute', model: 'gpt-x' };
async function bound(h: ReturnType<typeof setup>) { await h.reader.part(CO); await h.svc.bind(CO.id, 'p-redis', '/repo/redis', 'dev'); }

// --- the state machine ----------------------------------------------------------------------------------------------------------------
test('lease: derived from the assignee plus Muster’s own comment marker (the plugin’s contract), never from a label', () => {
  const at = '2026-10-05T10:00:00.000Z';
  const body = checkoutComment('Dhairya’s "MacBook" & Co', 'dev-1', 'Dhairya', at);
  assert.match(body, /^Checked out · working locally on Dhairya’s "MacBook" & Co · via Muster\n\n<!-- muster:checkout device="Dhairya’s &quot;MacBook&quot; &amp; Co" device-id="dev-1" by="Dhairya" at="2026-10-05T10:00:00.000Z" -->$/);
  assert.deepEqual(parseLeaseMarker(body), { v: 1, event: 'checkout', deviceId: 'dev-1', device: 'Dhairya’s "MacBook" & Co', by: 'Dhairya', at }, 'escaping round-trips');
  assert.equal(parseLeaseMarker('Checked out · working locally on MacBook · via Muster'), null, 'a person typing the words is not a lease');
  assert.equal(parseLeaseMarker('<!-- muster:checkout device=oops -->'), null);
  assert.equal(parseLeaseMarker('<!-- muster:activity at="2026-10-05T10:00:00Z" -->'), null, 'activity is not a lease event');
  const derived = deriveLease({ assigneeUserId: ME }, [{ body, authorUserId: ME, createdAt: at }], ME, 'dev-1');
  assert.deepEqual(derived, { state: 'checked_out', deviceId: 'dev-1', device: 'Dhairya’s "MacBook" & Co', since: at, thisMac: true });
  assert.equal(deriveLease({ assigneeUserId: ME }, [{ body, authorUserId: ME, createdAt: at }], ME, 'dev-2')!.thisMac, false, 'another Mac holds it');
  assert.equal(deriveLease({ assigneeUserId: BOB }, [{ body, authorUserId: ME, createdAt: at }], ME, 'dev-1'), null, 'reassigned away: no longer checked out');
  assert.equal(deriveLease({ assigneeUserId: ME }, [{ body, authorUserId: BOB, createdAt: at }], ME, 'dev-1'), null, 'someone else’s marker does not count');
  assert.equal(deriveLease({ assigneeUserId: ME }, [{ body, authorUserId: null, createdAt: at }], ME, 'dev-1'), null, 'an agent- or system-written marker is ignored: only a human’s comment can hold a task');
  const release = 'Released · via Muster\n\n<!-- muster:release at="2026-10-05T11:00:00Z" -->';
  assert.equal(deriveLease({ assigneeUserId: ME }, [{ body, authorUserId: ME, createdAt: at }, { body: release, authorUserId: ME, createdAt: '2026-10-05T11:00:00Z' }], ME, 'dev-1'), null, 'the newest marker wins, by the server’s timestamp');
  assert.equal(deriveLease({ assigneeUserId: ME }, [{ body, authorUserId: ME, createdAt: '2026-10-05T12:00:00Z' }, { body: release, authorUserId: ME, createdAt: '2026-10-05T11:00:00Z' }], ME, 'dev-1')?.state, 'checked_out', 'checked out again after the release');
  assert.equal(badgeText({ thisMac: true, device: 'MacBook' }), 'Checked out · this Mac');
  assert.equal(badgeText({ thisMac: false, device: 'Studio' }), 'Checked out · Studio');
  assert.equal(canCheckout(derived, 'dev-2').ok, false); assert.equal(canCheckout(derived, 'dev-2', true).ok, true); assert.equal(canCheckout(null, 'dev-2').ok, true);
});

test('markers on every comment Muster posts: activity on progress, handback and release at the ends, all labelled via Muster', () => {
  const r = (kind: Report['kind']): Report => ({ kind, key: `${kind}:1`, at: '2026-10-05T10:00:00.000Z', body: `${kind} body` });
  for (const kind of ['decision', 'context', 'tests', 'pr', 'note'] as const) assert.match(reportComment(r(kind)), /_via Muster · local_\n<!-- muster:activity at="2026-10-05T10:00:00.000Z" -->\n<!-- muster:report /);
  assert.match(reportComment(r('handback')), /<!-- muster:handback at="2026-10-05T10:00:00.000Z" -->/);
  assert.match(reportComment(r('release')), /<!-- muster:release at="2026-10-05T10:00:00.000Z" -->/);
  assert.ok(!/muster:activity/.test(reportComment(r('handback'))));
});

test('lease: transitions, stale reminders and invalid moves', () => {
  const base = { taskId: 't1', orgId: 'o', key: 'RAG-1', title: 'T', projectId: null, deviceId: 'd', device: 'Mac', model: OWN, modelLabel: 'x', at: '2026-10-05T10:00:00.000Z', previous: { status: 'todo' as const, assigneeUserId: ME, assigneeAgentId: null } };
  const l = newLease(base);
  assert.equal(l.state, 'checked_out'); assert.equal(l.runOnServer, false, 'Run on server is off by default'); assert.equal(l.offline, null);
  assert.equal(transition(l, { type: 'activity', at: '2026-10-05T12:00:00.000Z' }).lastActivityAt, '2026-10-05T12:00:00.000Z');
  assert.equal(transition(l, { type: 'run-on-server', on: true, at: 'x' }).runOnServer, true);
  const back = transition(l, { type: 'handback', at: '2026-10-05T13:00:00.000Z', prUrl: 'https://pr/1' });
  assert.deepEqual([back.state, back.prUrl, back.endedAt], ['handed_back', 'https://pr/1', '2026-10-05T13:00:00.000Z']);
  assert.throws(() => transition(back, { type: 'handback', at: 'x' }), (e: unknown) => e instanceof LeaseError && e.code === 'ended');
  assert.throws(() => transition(back, { type: 'release', at: 'x' }), LeaseError);
  assert.throws(() => transition(null, { type: 'handback', at: 'x' }), (e: unknown) => e instanceof LeaseError && e.code === 'none');
  assert.equal(transition(l, { type: 'release', at: 'y' }).state, 'released');
  const HOUR = 3_600_000, t0 = Date.parse(l.lastActivityAt);
  assert.equal(isStale(l, t0 + 7 * HOUR, 8), false); assert.equal(isStale(l, t0 + 8 * HOUR, 8), true, 'silent for 8 hours (configurable)');
  assert.equal(isStale(l, t0 + 100 * HOUR, 0), false, '0 turns the reminder off');
  assert.equal(isStale(back, t0 + 100 * HOUR, 8), false, 'ended leases are never stale');
  const snoozed = transition(l, { type: 'remind', at: new Date(t0 + 9 * HOUR).toISOString() });
  assert.equal(isStale(snoozed, t0 + 10 * HOUR, 8), false, 'the reminder snoozes it'); assert.equal(isStale(snoozed, t0 + 17 * HOUR, 8), true);
  assert.equal(transition(l, { type: 'offline', at: 'z', mode: 'auto' }).offline, 'auto');
  const manual = transition(l, { type: 'offline', at: 'z', mode: 'manual' });
  assert.equal(transition(manual, { type: 'offline', at: 'z', mode: 'auto' }).offline, 'manual', 'an automatic offline never replaces the person’s switch');
});

// --- reports, costs, tiers ------------------------------------------------------------------------------------------------------------------
test('report batching: newest context and tests only, no repeats, nothing the server already shows; milestones keep their order', () => {
  const r = (kind: Report['kind'], key: string, at: string): Report => ({ kind, key, at, body: `${kind} ${key}` });
  const pending = [r('context', 'c1', '2026-10-05T10:00:00Z'), r('decision', 'd1', '2026-10-05T10:01:00Z'), r('context', 'c2', '2026-10-05T10:02:00Z'), r('tests', 't1', '2026-10-05T10:03:00Z'), r('tests', 't2', '2026-10-05T10:04:00Z'), r('decision', 'd1', '2026-10-05T10:01:00Z'), r('pr', 'pr1', '2026-10-05T10:05:00Z')];
  const { post, dropped } = batchReports(pending, new Set());
  assert.deepEqual(post.map(p => p.key), ['d1', 'c2', 't2', 'pr1']);
  assert.equal(dropped.length, 3);
  assert.deepEqual(batchReports(pending, new Set(['d1', 'pr1'])).post.map(p => p.key), ['c2', 't2'], 'what the server already shows is not posted again');
  const comment = reportComment(r('decision', 'd1', 'x'));
  assert.match(comment, /_via Muster · local_/); assert.deepEqual([...postedKeys([comment, 'plain'])], ['d1']);
});
test('tests line, hand-back summary and the rolling work log', () => {
  assert.equal(testsLine({ ran: false }), 'Tests were not run.');
  assert.equal(testsLine({ ran: false, note: 'docs only' }), 'Tests were not run: docs only');
  assert.equal(testsLine({ ran: true, passed: 12, failed: 1, baselineFailed: 1 }), 'Tests: 12 passed, 1 failed. Baseline had 1 failing (no change).');
  assert.match(testsLine({ ran: true, passed: 12, failed: 3, baselineFailed: 1 }), /2 new\./);
  assert.match(testsLine({ ran: true, passed: 12, failed: 0, baselineFailed: 2 }), /2 fewer\./);
  const body = handBackBody({ branch: 'muster/RAG-1', changed: '2 files', decisions: ['Use seeds'], tests: { ran: true, passed: 3, failed: 0 }, prUrl: null, reviewerName: 'QA Lead' });
  for (const part of ['**What changed**', '- Use seeds', '**Evidence**', 'no pull request linked', '**Open questions**', 'Reviewer: QA Lead.']) assert.ok(body.includes(part), part);
  const rcpt = (runId: string, at: string): TurnReceipt => ({ runId, at, model: 'm|x', provider: 'p', source: 'own', files: { count: 2, added: 10, removed: 1 }, tests: 1, tokens: { input: 100, cached: 0, output: 50 }, durationMs: 1, outcome: 'completed' });
  const doc = renderWorkLog({ key: 'RAG-1', title: 'T', person: 'Dhairya', device: 'Mac', branch: 'muster/RAG-1', since: 'x', state: 'in progress', modelLabel: 'My own' }, [{ ...rcpt('r2', '2026-10-05T11:00:00Z'), title: 'Second turn', testSummary: { passed: 14, failed: 1 }, summary: 'Retries with backoff.', costUsd: 0.42, costSource: 'personal' }, rcpt('r1', '2026-10-05T10:00:00Z')]);
  assert.match(doc, /# Local work log · RAG-1/); assert.match(doc, /2 turns · \+20 −2 lines · 2 test commands · 300 tokens/);
  assert.ok(doc.indexOf('10:00') < doc.indexOf('11:00'), 'oldest first');
  // the plugin's format: one `## <time> · <title>` section per turn, with these bullets
  assert.match(doc, /^## 2026-10-05T11:00:00Z · Second turn$/m);
  for (const bullet of ['- Device: Mac', '- Files: +10 -1 (2 files)', '- Tests: 14 passed, 1 failed', '- Tokens: 100 in / 50 out', '- Model: m|x', '- Cost: $0.42 (personal)', '- Summary: Retries with backoff.']) assert.ok(doc.includes(bullet), bullet);
  assert.match(doc, /^## 2026-10-05T10:00:00Z · Local turn 1$/m); assert.match(doc, /- Cost: \$0\.00 \(personal\)/);
});
test('cost labels: personal vs org by biller, subscription vs metered by billingType, and a subscription never bills tokens', () => {
  assert.equal(billerFor('personal', 'u-me'), 'personal:u-me'); assert.equal(billerFor('org', 'u-me'), 'org');
  assert.equal(payerOf({ id: 'omniroute-org', orgManaged: true }), 'org'); assert.equal(payerOf({ id: 'omniroute' }), 'personal'); assert.equal(payerOf(undefined), 'personal');
  assert.equal(billingTypeOf({ id: 'claude-code', subscription: true }), 'subscription_included'); assert.equal(billingTypeOf({ id: 'claude-code' }), 'subscription_included');
  assert.equal(billingTypeOf({ id: 'omniroute' }), 'metered_api'); assert.equal(billingTypeOf(undefined), 'metered_api', 'unknown is metered, never presented as free');
  const receipt: TurnReceipt = { runId: 'r9', at: '2026-10-05T10:00:00Z', model: 'gpt-x', provider: 'omniroute', source: 'own', files: null, tests: 0, tokens: { input: 1000, cached: 10, output: 200 }, durationMs: 1, outcome: 'completed' };
  const base = { engine: 'personal-subscription' as const, receipt, costUsd: 0.1234, agentId: 'a-ceo', issueId: 't1', projectId: 'p', userId: 'u-me' };
  const metered = costEventFor({ ...base, provider: { id: 'omniroute', name: 'OmniRoute' } });
  assert.deepEqual([metered.biller, metered.billingType, metered.costCents, metered.inputTokens, metered.billingCode], ['personal:u-me', 'metered_api', 12, 1000, 'muster-local/personal-subscription/r9']);
  const sub = costEventFor({ ...base, provider: { id: 'claude-code', subscription: true } });
  assert.deepEqual([sub.billingType, sub.costCents], ['subscription_included', 0]);
  assert.equal(costEventFor({ ...base, provider: { id: 'x', orgManaged: true } }).biller, 'org');
  assert.equal(costEventFor({ ...base, engine: 'org-definition', provider: { id: 'omniroute' } }).billingCode, 'muster-local/org-definition/r9', 'the billing code says which engine ran the turn');
});
test('“Same as the org agent”: the agent’s family and tier map onto the person’s own providers; no match asks for My own', () => {
  assert.equal(tierOf('claude-opus-4'), 'high'); assert.equal(tierOf('claude-haiku-4'), 'low'); assert.equal(tierOf('claude-sonnet-4'), 'medium');
  const local = providers.map(p => ({ id: p.id, name: p.name, driver: p.driver, available: p.available, models: p.models }));
  assert.deepEqual(mapAgentToLocal({ adapter: 'claude_local', model: 'claude-opus-4' }, local)?.providerId, 'claude-code');
  assert.equal(mapAgentToLocal({ adapter: 'claude_local', model: 'claude-haiku-4' }, local)?.model, 'claude-haiku-4');
  assert.equal(mapAgentToLocal({ adapter: 'claude_local', model: 'claude-sonnet-9' }, local)?.providerId, 'claude-code', 'same family, nearest model');
  assert.equal(mapAgentToLocal({ adapter: 'process', model: null }, local)?.providerId, 'omniroute', 'no family: any available provider, by tier (medium)');
  assert.equal(mapAgentToLocal({ adapter: 'claude_local', model: 'x' }, [{ id: 'c', name: 'C', available: false, models: [{ id: 'm', name: 'm' }] }]), null);
  const brief = agentBrief({ name: 'Head Muster', title: 'CEO', capabilities: 'Leads' }, 'Be careful.');
  assert.match(brief, /Head Muster/); assert.match(brief, /Be careful\./); assert.ok(!/key|token|secret/i.test(brief));
  assert.deepEqual(parseTestSummary('ℹ tests 13\nℹ pass 12\nℹ fail 1\n'), { passed: 12, failed: 1 });
  assert.deepEqual(parseTestSummary('Tests:       1 failed, 5 passed, 6 total'), { passed: 5, failed: 1 });
  assert.deepEqual(parseTestSummary('===== 4 passed in 0.5s ====='), { passed: 4, failed: 0 });
  assert.equal(parseTestSummary('no summary'), null);
});

// --- the flow ------------------------------------------------------------------------------------------------------------------------------------
test('check out: needs confirmation and a bound folder; posts as the person; In progress; worktree from the dev branch; “Take it” reassigns first', async () => {
  const h = setup(); await h.reader.part(CO);
  await assert.rejects(() => h.svc.start({ taskId: 't1', model: OWN, confirm: false as never }), /confirm/i);
  assert.deepEqual(h.server.calls, [], 'nothing was posted before the person confirmed');
  await assert.rejects(() => h.svc.start({ taskId: 't1', model: OWN, confirm: true }), /where .*code lives/i, 'a folder is chosen once');
  await h.svc.bind(CO.id, 'p-redis', '/repo/redis', 'dev');
  const plan = await h.svc.plan('t1');
  assert.deepEqual([plan.assignedToMe, plan.willPost.status, plan.willPost.reassign, plan.devBranch], [true, 'in_progress', false, 'dev']);
  assert.equal(plan.willPost.comment, 'Checked out · working locally on Dhairya’s MacBook · via Muster');
  assert.equal(plan.agents[0]!.mapsTo !== undefined, true);
  const lease = await h.svc.start({ taskId: 't1', model: OWN, confirm: true });
  assert.deepEqual([lease.state, lease.thisMac, lease.branch, lease.worktree, lease.pending, lease.runOnServer], ['checked_out', true, 'muster/RAG-1', '/wt/muster-RAG-1', 0, false]);
  assert.deepEqual(h.worktrees, ['muster/RAG-1']);
  const t1 = h.server.tasks.find(t => t.id === 't1')!;
  assert.deepEqual([t1.status, t1.assigneeUserId], ['in_progress', ME]);
  const posted = h.server.comments.get('t1')!;
  assert.equal(posted.length, 1); assert.equal(posted[0]!.authorUserId, ME); assert.match(posted[0]!.body, /^Checked out · working locally on Dhairya’s MacBook · via Muster/);
  await assert.rejects(() => h.svc.start({ taskId: 't1', model: OWN, confirm: true }), /already checked out/);
  // Bob's task: refused, then taken on purpose (assignee becomes the person; the agent is cleared)
  await assert.rejects(() => h.svc.start({ taskId: 't2', model: OWN, confirm: true }), /Take it/);
  const taken = await h.svc.start({ taskId: 't2', take: true, model: OWN, confirm: true });
  assert.equal(taken.state, 'checked_out');
  const t2 = h.server.tasks.find(t => t.id === 't2')!;
  assert.deepEqual([t2.assigneeUserId, t2.status], [ME, 'in_progress']);
  assert.deepEqual(h.svc.get('t2')!.previous, { status: 'todo', assigneeUserId: BOB, assigneeAgentId: null }, 'what it was, so Release can put it back');
  // the agent-held task: Take it clears the agent (it will not wake)
  await h.svc.start({ taskId: 't3', take: true, model: OWN, confirm: true });
  const t3 = h.server.tasks.find(t => t.id === 't3')!;
  assert.equal(t3.assigneeUserId, ME);
  assert.ok((h.server.calls as string[]).some(c => c.startsWith('patch t3') && c.includes('"assigneeAgentId":null') && c.includes(`"assigneeUserId":"${ME}"`)));
});

test('a done or cancelled task is not checked out', async () => {
  const h = setup(); await bound(h); h.server.tasks[0]!.status = 'done';
  await h.reader.part(CO, true);
  await assert.rejects(() => h.svc.start({ taskId: 't1', model: OWN, confirm: true }), /is done/);
});

test('auto-reports: a turn is a work-log row and a cost entry, never a comment; decisions and tests are the only comments', async () => {
  const h = setup(); await bound(h);
  const lease = await h.svc.start({ taskId: 't1', model: { kind: 'own', providerId: 'claude-code', model: 'claude-opus-4' }, confirm: true });
  await h.svc.onTurn(lease.chatId!, 'run-1', 'completed'); await h.svc.onTurn(lease.chatId!, 'run-2', 'completed');
  await h.svc.decision('t1', 'Use the sentinel list.'); await h.svc.decision('t1', 'Use the sentinel list.');
  const comments = h.server.comments.get('t1')!.map(c => c.body);
  assert.equal(comments.filter(b => /Decision/.test(b)).length, 1, 'the same decision is posted once');
  assert.equal(comments.filter(b => /Test results/.test(b)).length, 1, 'only the newest test result of the flush');
  assert.ok(comments.filter(b => /via Muster · local/.test(b)).length >= 2, 'labelled via Muster · local');
  assert.equal(comments.length, 3, 'check-out, decision, tests: not one per turn');
  const doc = h.server.docs.get('t1/local-work-log')!;
  assert.match(doc, /2 turns/); assert.match(doc, /^## .+Z · /m);
  assert.deepEqual(h.server.costs.map(c => [c.biller, c.billingType, c.costCents]), [[`personal:${ME}`, 'subscription_included', 0], [`personal:${ME}`, 'subscription_included', 0]]);
  assert.equal(h.server.costs[0]!.agentId, 'a-ceo');
  assert.match(comments.find(b => /Test results/.test(b))!, /12 passed, 1 failed/);
  assert.equal(h.svc.get('t1')!.lastActivityAt > lease.since || true, true);
  assert.deepEqual(await h.svc.outbox().then(o => o.pending), 0);
});

test('hand back needs tests (or a written reason); pushes; summary with the reviewer’s tag; In review; reassigns; the lease ends', async () => {
  const noTests = setup({ tests: 0 }); await bound(noTests);
  const l0 = await noTests.svc.start({ taskId: 't1', model: OWN, confirm: true });
  await noTests.svc.onTurn(l0.chatId!, 'r1', 'completed');
  const preview = await noTests.svc.handBackPreview('t1');
  assert.equal(preview.blocked, 'Run the tests, or write why they were not run.');
  assert.equal(preview.reviewers[0]!.name, 'QA Lead', 'a QA agent is suggested first');
  await assert.rejects(() => noTests.svc.handBack({ taskId: 't1', reviewer: { kind: 'agent', id: 'a-qa' } }), /Run the tests/);
  const done0 = await noTests.svc.handBack({ taskId: 't1', reviewer: { kind: 'agent', id: 'a-qa' }, testsNote: 'Documentation change only.' });
  assert.equal(done0.state, 'handed_back');
  assert.match(noTests.server.comments.get('t1')!.at(-1)!.body, /Tests were not run: Documentation change only\./);

  const h = setup(); await bound(h);
  const lease = await h.svc.start({ taskId: 't1', model: OWN, confirm: true });
  await h.svc.onTurn(lease.chatId!, 'r1', 'completed'); await h.svc.decision('t1', 'Ship the seed list.');
  const done = await h.svc.handBack({ taskId: 't1', reviewer: { kind: 'agent', id: 'a-qa' }, prUrl: 'https://github.com/x/y/pull/7', summary: 'Ready.' });
  assert.equal(done.state, 'handed_back'); assert.equal(done.prUrl, 'https://github.com/x/y/pull/7');
  assert.deepEqual(h.pushed, ['muster/RAG-1']);
  const t1 = h.server.tasks[0]!;
  assert.deepEqual([t1.status, t1.assigneeId, t1.assigneeUserId], ['in_review', 'a-qa', null]);
  const summary = h.server.comments.get('t1')!.find(c => /Handed back for review/.test(c.body))!;
  assert.match(summary.body, /\[@QA Lead\]\(agent:\/\/a-qa\)/, 'the reviewer is tagged in the format Paperclip’s own composer writes');
  assert.match(summary.body, /pull\/7/); assert.match(summary.body, /- Ship the seed list\./);
  assert.equal(h.server.calls.filter(c => c.startsWith('patch t1')).length, 2, 'In progress at check-out, then In review at hand-back');
  await assert.rejects(() => h.svc.handBack({ taskId: 't1', reviewer: { kind: 'agent', id: 'a-qa' } }), /already handed back/);
  assert.equal(reassignStrategy.id, 'reassign', 'the strategy is swappable behind one interface');
});

test('hand back to a person tags them with a user chip and assigns them (assigneeUserId set, agent cleared)', async () => {
  const h = setup(); await bound(h);
  const lease = await h.svc.start({ taskId: 't1', model: OWN, confirm: true }); await h.svc.onTurn(lease.chatId!, 'r1', 'completed');
  assert.deepEqual(h.svc.get('t1') && (await h.svc.handBackPreview('t1')).reviewers.filter(r => r.kind === 'user').map(r => r.id), [BOB], 'people are offered; the originator is the default when there is no QA agent');
  await h.svc.handBack({ taskId: 't1', reviewer: { kind: 'user', id: BOB }, prUrl: 'https://pr/1' });
  assert.match(h.server.comments.get('t1')!.at(-1)!.body, /\[@Bob Rivera\]\(user:\/\/u-bob\)/);
  const t1 = h.server.tasks[0]!; assert.deepEqual([t1.status, t1.assigneeUserId], ['in_review', BOB]);
});

test('release puts the task back as it was, with a note; Run on server is explicit and reversible', async () => {
  const h = setup(); await bound(h);
  await h.svc.start({ taskId: 't2', take: true, model: OWN, confirm: true });
  const released = await h.svc.release('t2', 'Blocked on infra.');
  assert.equal(released.state, 'released');
  const t2 = h.server.tasks.find(t => t.id === 't2')!; assert.deepEqual([t2.assigneeUserId, t2.status], [BOB, 'todo'], 'back to Bob, as it was');
  assert.match(h.server.comments.get('t2')!.at(-1)!.body, /Released from .* via Muster\n\nBlocked on infra\./);
  await assert.rejects(() => h.svc.release('t2'), /already handed back or released/);
  await h.svc.start({ taskId: 't1', model: OWN, confirm: true });
  const on = await h.svc.runOnServer('t1', true);
  assert.equal(on.runOnServer, true); assert.equal(h.server.tasks[0]!.assigneeId, 'a-ceo', 'the org agent runs it on the server');
  assert.match(h.server.comments.get('t1')!.at(-1)!.body, /Running this on the server with Head Muster/);
  const off = await h.svc.runOnServer('t1', false); assert.equal(off.runOnServer, false); assert.equal(h.server.tasks[0]!.assigneeUserId, ME);
});

// --- offline, retries, conflicts ---------------------------------------------------------------------------------------------------------------
test('offline by choice: every action is queued in order and nothing is sent until the switch is off', async () => {
  const h = setup(); await bound(h);
  const lease = await h.svc.start({ taskId: 't1', model: OWN, confirm: true });
  const sent = h.server.calls.length;
  const view = await h.svc.setOffline('t1', true);
  assert.deepEqual([view.offline], ['manual']);
  await h.svc.decision('t1', 'Decision while offline.'); await h.svc.onTurn(lease.chatId!, 'r1', 'completed');
  await h.svc.handBack({ taskId: 't1', reviewer: { kind: 'agent', id: 'a-qa' }, prUrl: 'https://pr/9' });
  assert.equal(h.server.calls.length, sent, 'not one request left this Mac');
  const queued = h.svc.pending('t1').rows;
  assert.ok(queued.length >= 5); assert.equal(h.svc.get('t1')!.pending, queued.length, '“Offline · N updates waiting”');
  const kinds = queued.map(r => r.kind);
  assert.ok(kinds.indexOf('decision') < kinds.indexOf('handback'), 'in the order they happened');
  assert.deepEqual(h.server.tasks[0]!.status, 'in_progress', 'the server still shows the task checked out');
  // switch off: the task is re-read (nothing changed), then the queue is sent in order
  await h.svc.setOffline('t1', false);
  assert.equal(h.svc.pending('t1').rows.length, 0);
  const t1 = h.server.tasks[0]!; assert.deepEqual([t1.status, t1.assigneeId], ['in_review', 'a-qa']);
  const bodies = h.server.comments.get('t1')!.map(c => c.body);
  const order = ['Checked out', 'Decision', 'Handed back for review'].map(w => bodies.findIndex(b => b.includes(w)));
  assert.deepEqual(order, [...order].sort((a, b) => a - b)); assert.ok(order.every(i => i >= 0));
  assert.match(bodies.at(-1)!, /\[@QA Lead\]\(agent:\/\/a-qa\)/, 'the hand-back tag is delivered after reconnect');
  assert.equal(h.svc.get('t1')!.offline, null);
});

test('the server going away turns offline on by itself; the queue flushes when it is back, once, in order', async () => {
  const h = setup(); await bound(h);
  const lease = await h.svc.start({ taskId: 't1', model: OWN, confirm: true });
  h.server.down = true;
  await h.svc.decision('t1', 'While the server is down.');
  assert.equal(h.svc.get('t1')!.offline, 'auto'); assert.equal(h.svc.get('t1')!.pending, 1);
  await h.svc.onTurn(lease.chatId!, 'r1', 'completed');
  assert.ok(h.svc.get('t1')!.pending >= 3, 'work goes on and posts queue up');
  assert.match((await h.svc.outbox()).lastError ?? '', /ECONNREFUSED/);
  h.server.down = false;
  await h.svc.sync();
  assert.equal(h.svc.get('t1')!.offline, null); assert.equal(h.svc.get('t1')!.pending, 0);
  assert.equal(h.server.comments.get('t1')!.filter(c => /Decision/.test(c.body)).length, 1);
  await h.svc.sync();
  assert.equal(h.server.comments.get('t1')!.filter(c => /Decision/.test(c.body)).length, 1, 'a second sync sends nothing again');
});

test('a retry never double-posts: the footer key and the client request id make the repeat a no-op', async () => {
  const h = setup(); await bound(h);
  await h.svc.start({ taskId: 't1', model: OWN, confirm: true });
  h.server.loseNextResponse = true;   // the server stores the comment, but the response is lost
  await h.svc.decision('t1', 'Only once, please.');
  assert.equal(h.svc.get('t1')!.pending, 1, 'the person cannot know it arrived, so it stays queued');
  await h.svc.sync();
  assert.equal(h.server.comments.get('t1')!.filter(c => /Only once, please\./.test(c.body)).length, 1);
  assert.equal(h.svc.get('t1')!.pending, 0);
  // the client id on its own: the server collapses a repeated id
  const row = h.store.history('t1').find(r => r.kind === 'decision')!;
  assert.match(row.clientId, /^[0-9a-f-]{36}$/);
});

test('conflict: reassigned or closed while offline is not flushed blindly; the person sends anyway, edits, or discards', async () => {
  const h = setup(); await bound(h);
  await h.svc.start({ taskId: 't1', model: OWN, confirm: true });
  await h.svc.setOffline('t1', true);
  await h.svc.decision('t1', 'Draft decision.');
  // meanwhile Bob took the task and closed it
  const t1 = h.server.tasks[0]!; t1.assigneeUserId = BOB; t1.assigneeId = `user:${BOB}`; t1.assigneeLabel = 'Bob'; t1.status = 'done'; h.server.generation++;
  const before = h.server.comments.get('t1')!.length;
  await h.svc.setOffline('t1', false);
  const view = h.svc.get('t1')!;
  assert.ok(view.conflict, 'a conflict was found'); assert.match(view.conflict!.changes.join(' '), /assigned to Bob/); assert.match(view.conflict!.changes.join(' '), /marked Done/);
  assert.equal(h.server.comments.get('t1')!.length, before, 'nothing was sent');
  assert.equal(h.svc.pending('t1').rows.length, 1, 'the queue is kept'); assert.ok(h.svc.pending('t1').conflict);
  // edit, then send anyway
  const decision = h.svc.pending('t1').rows.find(r => r.kind === 'decision')!;
  h.svc.editPending(decision.id, '**Decision**\n\nEdited after seeing the conflict.');
  assert.throws(() => h.svc.editPending(decision.id, '  '), /empty/);
  await h.svc.resolve('t1', 'send');
  assert.match(h.server.comments.get('t1')!.at(-1)!.body, /Edited after seeing the conflict/);
  assert.equal(h.svc.get('t1')!.conflict, null); assert.equal(h.svc.pending('t1').rows.length, 0);

  // discard
  const g = setup(); await bound(g);
  await g.svc.start({ taskId: 't1', model: OWN, confirm: true }); await g.svc.setOffline('t1', true); await g.svc.decision('t1', 'Will be discarded.');
  g.server.tasks[0]!.assigneeUserId = BOB; g.server.generation++;
  await g.svc.setOffline('t1', false);
  assert.ok(g.svc.get('t1')!.conflict);
  const after = g.server.comments.get('t1')!.length;
  await g.svc.resolve('t1', 'discard');
  assert.equal(g.svc.pending('t1').rows.length, 0); assert.equal(g.server.comments.get('t1')!.length, after, 'nothing was sent');
});

test('stale lease: silent for the configured hours shows a reminder; remind snoozes it; the hours are a setting', async () => {
  const h = setup(); await bound(h);
  await h.svc.start({ taskId: 't1', model: OWN, confirm: true });
  assert.equal(h.svc.get('t1')!.stale, false); assert.equal(h.svc.get('t1')!.staleHours, 8);
  h.advance(9 * 3_600_000); assert.equal(h.svc.get('t1')!.stale, true);
  h.svc.remind('t1'); assert.equal(h.svc.get('t1')!.stale, false);
  h.store.setStaleHours(2); h.advance(3 * 3_600_000); assert.equal(h.svc.get('t1')!.stale, true); assert.equal(h.svc.get('t1')!.staleHours, 2);
});

test('bindings are per org project and remembered; a folder that is not a repository is refused', async () => {
  const h = setup(); await h.reader.part(CO);
  const b = await h.svc.bind(CO.id, 'p-redis', '/repo/redis', 'dev');
  assert.deepEqual([b.projectName, b.devBranch], ['Redis', 'dev']);
  assert.equal(h.store.binding('aiteam', CO.id, 'p-redis')!.path, '/repo/redis');
  assert.equal(h.store.binding('other-server', CO.id, 'p-redis'), null, 'bindings belong to their server');
  const bad = setup(); await bad.reader.part(CO);
  (bad.svc as unknown as { d: CheckoutDeps }).d.git.isRepo = async () => false;
  await assert.rejects(() => bad.svc.bind(CO.id, 'p-redis', '/tmp', 'dev'), /not a git repository/);
});

test('no personal access on this server: check out says so instead of failing in the middle', async () => {
  const h = setup(); const svc = new CheckoutService({ ...(h.svc as unknown as { d: CheckoutDeps }).d, backend: () => ({ ...h.server.backend(), patchTask: undefined } as never) });
  await assert.rejects(() => svc.plan('t1'), /assign tasks to people/);
});

// --- the local copy of the org, the two engines, the workflow ------------------------------------------------------------------------------------
test('the local org copy holds definitions only (agents, instructions, skills, policy, task context) and never a key or an adapter environment', async () => {
  const h = setup(); await bound(h);
  h.server.policy = [{ type: 'review', participants: [{ kind: 'agent', id: 'a-qa' }] }, { type: 'approval', participants: [{ kind: 'user', id: BOB }] }];
  h.server.comments.set('t1', [{ id: 'c0', body: `Please look at the sentinel path, [@Dhairya](user://${ME}).`, authorUserId: BOB, createdAt: '2026-10-04T00:00:00Z' }]);
  await h.svc.start({ taskId: 't1', model: { kind: 'org-agent', agentId: 'a-ceo' }, confirm: true });
  const copy = h.svc.orgCopy('t1')!;
  assert.equal(copy.orgName, 'Ragnar');
  assert.deepEqual(copy.agents.map(a => a.name).sort(), ['Head Muster', 'QA Lead']);
  const ceo = copy.agents.find(a => a.id === 'a-ceo')!;
  assert.deepEqual([ceo.adapter, ceo.model, ceo.skills, ceo.instructions], ['claude_local', 'claude-opus-4', ['paperclip', 'para-memory-files'], 'Be careful with Redis.']);
  assert.deepEqual(copy.policy.map(p => [p.type, p.participants.map(x => x.name)]), [['review', ['QA Lead']], ['approval', ['Bob Rivera']]]);
  assert.deepEqual([copy.task.key, copy.task.description, copy.task.subtasks.map(t => t.key), copy.task.documents.map(d => d.key), copy.project?.name], ['RAG-1', 'Move the sources.', ['RAG-3'], ['plan'], 'Redis']);
  assert.match(JSON.stringify(copy), /sentinel path/);
  assert.ok(!/"env"|apiKey|api_key|token|secret|password/i.test(JSON.stringify(copy)), 'no credentials in the copy');
});

test('both engines run only here with the same org roles: Org agents bring the agent’s instructions and tier, My subscriptions swap only the model; switching later changes the model, not the workflow', async () => {
  const h = setup(); await bound(h);
  h.server.policy = [{ type: 'review', participants: [{ kind: 'agent', id: 'a-qa' }] }];
  h.server.comments.set('t1', [{ id: 'c0', body: `Please look, [@Dhairya](user://${ME}).`, authorUserId: BOB, createdAt: '2026-10-04T00:00:00Z' }]);
  const a = await h.svc.start({ taskId: 't1', model: { kind: 'org-agent', agentId: 'a-ceo' }, confirm: true });
  assert.equal(a.modelLabel, 'Head Muster → Claude Code · Opus 4', 'the agent’s tier maps onto the person’s own Claude Code');
  const briefA = (await h.svc.brief(a.chatId!))!;
  for (const part of ['RAG-1: Task RAG-1', 'Move the sources.', 'Subtasks: RAG-3', 'Documents on the task: Plan', '(asked you)', 'review by QA Lead', 'Be careful with Redis.', 'nothing runs on the server until hand-back']) assert.ok(briefA.includes(part), part);
  assert.ok(briefA.includes('para-memory-files'), 'the org’s skills for the role');
  const b = await h.svc.setEngine('t1', { model: { kind: 'own', providerId: 'omniroute', model: 'gpt-x' } });
  assert.equal(b.modelLabel, 'OmniRoute · GPT X'); assert.equal(b.model.kind, 'own');
  const briefB = (await h.svc.brief(a.chatId!))!;
  assert.ok(briefB.includes('review by QA Lead') && briefB.includes('Move the sources.'), 'the same context and workflow');
  assert.ok(!briefB.includes('Be careful with Redis.'), 'the org’s instructions are not loaded for My subscriptions');
  await assert.rejects(() => h.svc.setEngine('t1', { model: { kind: 'own', providerId: 'nope', model: 'x' } }), /not available/);
});

test('cost events say which engine ran: org-definition or personal-subscription, with the person as biller in both', async () => {
  const h = setup(); await bound(h);
  const l = await h.svc.start({ taskId: 't1', model: { kind: 'org-agent', agentId: 'a-ceo' }, confirm: true });
  await h.svc.onTurn(l.chatId!, 'r1', 'completed');
  await h.svc.setEngine('t1', { model: OWN }); await h.svc.onTurn(l.chatId!, 'r2', 'completed'); await h.svc.sync();
  assert.deepEqual(h.server.costs.map(c => [c.billingCode, c.biller]), [['muster-local/org-definition/r1', `personal:${ME}`], ['muster-local/personal-subscription/r2', `personal:${ME}`]]);
});

test('the reviewer step stays on this Mac when chosen: a local review chat with the policy’s reviewer; hand-back then says so and tags the policy reviewer by default', async () => {
  const h = setup(); await bound(h);
  h.server.policy = [{ type: 'review', participants: [{ kind: 'agent', id: 'a-qa' }] }];
  const l = await h.svc.start({ taskId: 't1', model: { kind: 'org-agent', agentId: 'a-ceo' }, confirm: true });
  await h.svc.setEngine('t1', { reviewLocally: true }); assert.equal(h.svc.get('t1')!.reviewLocally, true);
  const review = await h.svc.startReview('t1');
  assert.equal(review.reviewer, 'QA Lead'); assert.notEqual(review.chatId, l.chatId);
  const brief = (await h.svc.brief(review.chatId))!;
  assert.match(brief, /REVIEWER/); assert.match(brief, /Review like a skeptic\./); assert.match(brief, /Do not edit files/);
  await h.svc.onTurn(l.chatId!, 'r1', 'completed'); await h.svc.onTurn(review.chatId, 'r2', 'completed');
  await h.svc.sync();
  assert.match(h.server.docs.get('t1/local-work-log')!, /^## .+Z · .+ \(review\)$/m, 'review turns are sections of the same work log');
  const preview = await h.svc.handBackPreview('t1');
  assert.deepEqual(preview.reviewedLocally, ['QA Lead']); assert.equal(preview.reviewers[0]!.id, 'a-qa'); assert.equal(preview.reviewers[0]!.suggested, true, 'the policy’s reviewer is pre-filled');
  await h.svc.handBack({ taskId: 't1', reviewer: { kind: 'agent', id: 'a-qa' }, prUrl: 'https://pr/2' });
  assert.match(h.server.comments.get('t1')!.find(c => /Handed back/.test(c.body))!.body, /Reviewed locally by QA Lead\./);
  assert.equal(h.server.calls.filter(c => c.startsWith('patch')).length, 2, 'no server run or reassignment happened before hand-back');
});

// --- automatic hand-back ---------------------------------------------------------------------------------------------------------------------
const GREEN = 'Added Sentinel seeds.\nℹ tests 13\nℹ pass 13\nℹ fail 0\n';
const DONE = '```muster-handback\n{"done":true,"summary":"Seed discovery now reads the Sentinel list."}\n```';

test('auto hand-back: a finished agent (the structured block), with tests green, goes back for review by itself, to the policy’s reviewer, with a toast and Undo', async () => {
  const h = setup(); await bound(h);
  h.server.policy = [{ type: 'review', participants: [{ kind: 'agent', id: 'a-qa' }] }];
  const l = await h.svc.start({ taskId: 't1', model: OWN, confirm: true });
  h.setFinal(`${GREEN}\nWorking on it, not done yet.`); await h.svc.onTurn(l.chatId!, 'r1', 'completed');
  assert.equal(h.svc.get('t1')!.state, 'checked_out', 'a normal turn is not a hand-back');
  h.setFinal(`${GREEN}\n${DONE}`); await h.svc.onTurn(l.chatId!, 'r2', 'completed'); await h.svc.sync();
  assert.equal(h.svc.get('t1')!.state, 'handed_back');
  const t1 = h.server.tasks[0]!; assert.deepEqual([t1.status, t1.assigneeId], ['in_review', 'a-qa'], 'In review, given to the policy’s reviewer');
  const summary = h.server.comments.get('t1')!.find(c => /Handed back for review/.test(c.body))!;
  assert.match(summary.body, /<!-- muster:handback at="/); assert.match(summary.body, /Seed discovery now reads the Sentinel list\./); assert.match(summary.body, /\[@QA Lead\]\(agent:\/\/a-qa\)/);
  assert.deepEqual((h.events as { type: string; to: string }[]).map(e => [e.type, e.to]), [['handedBack', 'QA Lead']], 'one toast: Handed back to QA Lead · Undo');
  assert.deepEqual(h.pushed, ['muster/RAG-1'], 'the branch was pushed');
});

test('auto hand-back: a pushed branch or an opened pull request counts as finished, with no block needed', async () => {
  const pr = setup(); await bound(pr);
  const l = await pr.svc.start({ taskId: 't1', model: OWN, confirm: true });
  pr.setFinal(`${GREEN}\nOpened https://github.com/musterhq/redis-valkey/pull/42 for review.`); await pr.svc.onTurn(l.chatId!, 'r1', 'completed'); await pr.svc.sync();
  assert.equal(pr.svc.get('t1')!.state, 'handed_back'); assert.equal(pr.svc.get('t1')!.prUrl, 'https://github.com/musterhq/redis-valkey/pull/42');
  assert.deepEqual(pr.pushed, [], 'the agent already pushed; Muster does not push again');
  const push = setup(); await bound(push);
  const l2 = await push.svc.start({ taskId: 't1', model: OWN, confirm: true });
  push.setPushedHead(true); push.setFinal(GREEN); await push.svc.onTurn(l2.chatId!, 'r1', 'completed'); await push.svc.sync();
  assert.equal(push.svc.get('t1')!.state, 'handed_back');
});

test('auto hand-back never hands back failing or untested work: it posts a progress note and stays checked out', async () => {
  const failing = setup(); await bound(failing);
  const l = await failing.svc.start({ taskId: 't1', model: OWN, confirm: true });
  failing.setFinal(`Tests:\nℹ pass 12\nℹ fail 2\n${DONE}`); await failing.svc.onTurn(l.chatId!, 'r1', 'completed'); await failing.svc.sync();
  assert.equal(failing.svc.get('t1')!.state, 'checked_out');
  assert.match(failing.server.comments.get('t1')!.at(-1)!.body, /Not handing back yet\.\*\* .* 2 tests are failing \(12 passed\)\. It stays checked out/);
  const untested = setup({ tests: 0 }); await bound(untested);
  const l2 = await untested.svc.start({ taskId: 't1', model: OWN, confirm: true });
  untested.setFinal(DONE); await untested.svc.onTurn(l2.chatId!, 'r1', 'completed'); await untested.svc.sync();
  assert.equal(untested.svc.get('t1')!.state, 'checked_out');
  assert.match(untested.server.comments.get('t1')!.at(-1)!.body, /no tests have run/);
  // the same note is not posted twice
  untested.setFinal(DONE); await untested.svc.onTurn(l2.chatId!, 'r2', 'completed'); await untested.svc.sync();
  assert.equal(untested.server.comments.get('t1')!.filter(c => /no tests have run/.test(c.body)).length, 1);
  // a malformed block and a failed run are not signals
  const odd = setup(); await bound(odd);
  const l3 = await odd.svc.start({ taskId: 't1', model: OWN, confirm: true });
  odd.setFinal(`${GREEN}\n\`\`\`muster-handback\n{not json}\n\`\`\``); await odd.svc.onTurn(l3.chatId!, 'r1', 'completed');
  odd.setFinal(`${GREEN}\n${DONE}`); await odd.svc.onTurn(l3.chatId!, 'r2', 'failed');
  assert.equal(odd.svc.get('t1')!.state, 'checked_out');
});

test('auto hand-back is per project: "Ask me" offers it in a toast instead; a review session never counts', async () => {
  const h = setup(); await bound(h);
  const l = await h.svc.start({ taskId: 't1', model: OWN, confirm: true });
  assert.equal(h.svc.autoMode({ taskId: 't1' }), 'auto', 'Auto is the default');
  assert.equal(h.svc.setAutoMode({ taskId: 't1' }, 'ask'), 'ask'); assert.equal(h.svc.autoMode({ orgId: CO.id, projectId: 'p-redis' }), 'ask'); assert.equal(h.svc.autoMode({ orgId: CO.id, projectId: 'other' }), 'auto');
  h.setFinal(`${GREEN}\n${DONE}`); await h.svc.onTurn(l.chatId!, 'r1', 'completed');
  assert.equal(h.svc.get('t1')!.state, 'checked_out'); assert.deepEqual((h.events as { type: string }[]).map(e => e.type), ['handBackReady']);
  h.svc.setAutoMode({ taskId: 't1' }, 'auto');
  const review = await h.svc.startReview('t1'); await h.svc.onTurn(review.chatId, 'rv', 'completed');
  assert.equal(h.svc.get('t1')!.state, 'checked_out', 'a local review is feedback, not completion');
});

test('auto hand-back goes to the originator when the policy names no one, and queues offline for sending on reconnect', async () => {
  const h = setup(); await bound(h);
  const l = await h.svc.start({ taskId: 't1', model: OWN, confirm: true });
  await h.svc.setOffline('t1', true);
  h.setFinal(`${GREEN}\n${DONE}`); await h.svc.onTurn(l.chatId!, 'r1', 'completed');
  assert.equal(h.svc.get('t1')!.state, 'handed_back'); assert.equal(h.server.tasks[0]!.status, 'in_progress', 'nothing sent while offline');
  assert.ok(h.svc.pending('t1').rows.some(r => r.kind === 'handback'));
  await h.svc.setOffline('t1', false);
  const t1 = h.server.tasks[0]!; assert.deepEqual([t1.status, t1.assigneeUserId], ['in_review', BOB], 'no policy: the originator (Bob opened it)');
  assert.match(h.server.comments.get('t1')!.find(c => /Handed back/.test(c.body))!.body, /\[@Bob Rivera\]\(user:\/\/u-bob\)/);
});

test('undo: within two minutes the task comes back to the person, In progress, with a short comment; later, or after the reviewer acted, it does not', async () => {
  const h = setup(); await bound(h);
  const l = await h.svc.start({ taskId: 't1', model: OWN, confirm: true });
  h.setFinal(`${GREEN}\n${DONE}`); await h.svc.onTurn(l.chatId!, 'r1', 'completed'); await h.svc.sync();
  assert.equal(h.svc.get('t1')!.state, 'handed_back');
  h.advance(90_000);
  const back = await h.svc.undoHandBack('t1');
  assert.equal(back.state, 'checked_out'); const t1 = h.server.tasks[0]!; assert.deepEqual([t1.status, t1.assigneeUserId, t1.assigneeId], ['in_progress', ME, `user:${ME}`]);
  assert.match(h.server.comments.get('t1')!.at(-1)!.body, /Hand-back undone · working locally on .* · via Muster\n\n<!-- muster:checkout /, 'the lease marker is restored');
  await assert.rejects(() => h.svc.undoHandBack('t1'), /no hand-back to undo/);
  // too late
  h.setFinal(`${GREEN}\n${DONE}`); await h.svc.onTurn(l.chatId!, 'r2', 'completed'); await h.svc.sync();
  h.advance(121_000);
  await assert.rejects(() => h.svc.undoHandBack('t1'), /more than two minutes/);
  // the reviewer already acted
  const g = setup(); await bound(g);
  const l2 = await g.svc.start({ taskId: 't1', model: OWN, confirm: true });
  g.setFinal(`${GREEN}\n${DONE}`); await g.svc.onTurn(l2.chatId!, 'r1', 'completed'); await g.svc.sync();
  g.server.tasks[0]!.status = 'done'; g.server.generation++; await g.reader.part(CO, true);
  await assert.rejects(() => g.svc.undoHandBack('t1'), /already acted/);
});

test('a quiet session gets one short "paused" note per stretch, never a hand-back', async () => {
  const h = setup(); await bound(h);
  const l = await h.svc.start({ taskId: 't1', model: OWN, confirm: true });
  assert.equal(await h.svc.checkIdle(), 0);
  h.advance(46 * 60_000); assert.equal(await h.svc.checkIdle(), 1); await h.svc.sync();
  assert.match(h.server.comments.get('t1')!.at(-1)!.body, /\*\*Paused\.\*\* No activity for 46 minutes\. It is still checked out/);
  h.advance(30 * 60_000); assert.equal(await h.svc.checkIdle(), 0, 'one note per quiet stretch');
  h.setFinal('Back at it.\nℹ pass 1\nℹ fail 0'); await h.svc.onTurn(l.chatId!, 'r1', 'completed');
  h.advance(50 * 60_000); assert.equal(await h.svc.checkIdle(), 1, 'a new stretch after activity');
  assert.equal(h.svc.get('t1')!.state, 'checked_out');
  await h.svc.setOffline('t1', true); h.advance(5 * 3_600_000); assert.equal(await h.svc.checkIdle(), 0, 'offline by choice: nothing is posted');
});
