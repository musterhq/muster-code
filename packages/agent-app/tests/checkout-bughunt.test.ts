/** The check-out / hand-back flow (#117) over a fake Paperclip, real SQLite and a fake git: the lease state machine, what is posted and when, offline queueing,
 *  idempotent retries, conflicts, cost labels and the hand-back tag. The live version of this runs in checkout-e2e.test.ts. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { NO_PROJECT } from '../src/shared/domains/checkout-protocol.ts';
import { CheckoutService, isRealTestCommand, lastTestRun, lastUserText, parseTestSummary, reassignStrategy, userSaysDone, type CheckoutDeps, type LocalProviderInfo, type TimelineEntry } from '../src/runtime/checkout/service.ts';
import { ENVELOPE_RULES, redactSecrets, sanitizeOut, stripMarkup, untrusted } from '../src/runtime/checkout/sanitize.ts';
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
/** A real folder standing in for the project's repository (binding checks the disk now). */
const REPO = mkdtempSync(join(tmpdir(), 'muster-repo-'));
const ME = 'u-me', BOB = 'u-bob', CO = { id: 'co-rag', name: 'Ragnar', prefix: 'RAG' };
interface Comment { id: string; body: string; authorUserId: string | null; createdAt: string; clientRequestId?: string }
class FakeServer {
  down = false; unauthorized = false; token: string | undefined = undefined; rejectPatch = false; costFail: string | null = null; runs: { id: string; agentId: string | null; taskId: string | null; status: string }[] = []; loseNextResponse = false; calls: string[] = []; policy: { type: 'review' | 'approval'; participants: { kind: 'agent' | 'user'; id: string }[] }[] = []; comments = new Map<string, Comment[]>(); docs = new Map<string, string>(); costs: Record<string, unknown>[] = []; generation = 1; description = 'Move the sources.';
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
  patchCount = 0; foldedComments = 0;
  private up() { if (this.down) throw new PaperclipError('connect ECONNREFUSED', 0, 'network'); if (this.unauthorized) throw new PaperclipError('Muster Server refused the API token (401).', 401, 'auth'); }
  part(): ServerPart { return { tasks: this.tasks.map(t => ({ ...t })), agents: this.agents, projects: [{ id: 'p-redis', name: 'Redis', status: 'in_progress', description: '', source: 'paperclip', repo: null, cwd: null, taskCount: 3, openCount: 3, paused: false, memory: null }], runs: this.runs as never, inbox: [], goals: [], approvals: [], labels: [], people: [{ id: ME, name: 'Dhairya' }, { id: BOB, name: 'Bob Rivera' }] }; }
  backend(): ServerBackend {
    const s = this;
    return {
      kind: 'paperclip', endpoint: { baseUrl: 'http://x', ...(s.token ? { token: s.token } : {}) }, get generation() { return s.generation; }, invalidate() {},
      async companies() { s.up(); return [CO]; },
      async read() { s.up(); return s.part(); },
      async whoami() { s.up(); return { id: ME, name: 'Dhairya', email: null }; },
      async patchTask(id: string, full: Record<string, unknown>) { s.up(); if (s.rejectPatch) throw new PaperclipError('Muster Server refused the change (403). You cannot reassign this task.', 403, 'service'); const { comment, commentClientRequestId, ...c } = full; s.calls.push(`patch ${id} ${JSON.stringify(c)}`); s.patchCount++; if (typeof comment === 'string') { s.calls.push(`comment ${id} ${comment.split('\n')[0]}`); const list = s.comments.get(id) ?? []; if (!list.some(x => x.clientRequestId === commentClientRequestId)) { list.push({ id: `c${list.length + 1}`, body: comment, authorUserId: ME, createdAt: new Date().toISOString(), clientRequestId: commentClientRequestId as string | undefined }); s.comments.set(id, list); } s.foldedComments++; } const t = s.tasks.find(x => x.id === id)!; if (c.status) t.status = c.status as never; if ('assigneeUserId' in c) { t.assigneeUserId = c.assigneeUserId as string | null; } if ('assigneeAgentId' in c) { t.assigneeId = (c.assigneeAgentId as string | null) ?? (t.assigneeUserId ? `user:${t.assigneeUserId}` : null); } t.assigneeLabel = t.assigneeUserId === ME ? 'You' : t.assigneeUserId ? 'Bob' : t.assigneeId ? 'QA Lead' : null; s.generation++; },
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
      async postCostEvent(_co: string, body: Record<string, unknown>) { s.up(); if (s.costFail) throw new PaperclipError(s.costFail, 0, 'network'); s.costs.push(body); },
      async agentInstructions(id: string) { s.up(); return id === 'a-qa' ? 'Review like a skeptic.' : 'Be careful with Redis.'; },
      async issuePolicy() { s.up(); return s.policy; },
      async taskDetail(id: string) { s.up(); const t = s.tasks.find(x => x.id === id)!; return { task: t, description: s.description, comments: (s.comments.get(id) ?? []).map(c => ({ id: c.id, author: { kind: 'user' as const, id: c.authorUserId, label: 'Bob' }, body: c.body, createdAt: c.createdAt })), runs: [], addressee: null, composerNote: null, subtasks: ['t3'], blocking: [], receipts: [], cards: [{ kind: 'document' as const, id: 'd1', at: '', key: 'plan', title: 'Plan', format: 'markdown', body: '', revision: 1, revisions: [] }], mentionable: [] }; },
    } as unknown as ServerBackend;
  }
}

const providers: LocalProviderInfo[] = [
  { id: 'claude-code', name: 'Claude Code', driver: 'claude-code-cli', available: true, subscription: true, models: [{ id: 'claude-opus-4', name: 'Opus 4' }, { id: 'claude-haiku-4', name: 'Haiku 4' }] },
  { id: 'omniroute', name: 'OmniRoute', available: true, models: [{ id: 'gpt-x', name: 'GPT X' }] },
];
function setup(opts: { tests?: number; lazy?: boolean } = {}) {
  const server = new FakeServer(), db = new DatabaseSync(':memory:'), orgDir = join(mkdtempSync(join(tmpdir(), 'muster-orgcopy-')), 'checkout'), store = new CheckoutStore(() => db, orgDir);
  let clock = Date.parse('2026-10-05T10:00:00.000Z');
  const worktrees: string[] = [], pushed: string[] = [], emitted: (string | null)[] = [];
  let pushOk = true, noRemote = false, commitOk = true, hasTests = true, repo = true, chatSeq = 0, pushedHead = false, clean = true, head = 'abc123', origin = 'https://aiteam.example';
  const prOk = new Set<string>(), gitCalls: string[] = [], commits: string[] = [], statCalls: string[][] = [];
  let salt = 0, statFails = false, stat = { count: 7, added: 120, removed: 30 }, queuedMore = false, wait: { fn: () => void; ms: number; live: boolean }[] = [];
  const homeDir = mkdtempSync(join(tmpdir(), 'muster-home-'));
  // The local chat as the timeline shows it: the person's message, a file change, a test run (tool output), and the agent's last message.
  const tl = { user: 'Implement it.', change: true, test: 'ℹ pass 12\nℹ fail 1' as string | null, testStatus: 'completed', exit: 0 as number, testCommand: 'npm test', after: null as { command: string } | null, final: 'Worked on it.', trailingTool: null as string | null, outcome: 'completed', question: false };
  const events: unknown[] = [];
  const chatList: { id: string; path: string; activeAt: number }[] = [], sent: [string, string][] = [];
  const settings: Record<string, never> = {};
  const reader = new OrgReader({ backend: () => server.backend(), settings: () => settings, activeId: () => CO.id, serverLabel: () => 'aiteam', remembered: () => ({ id: ME, name: 'Dhairya' }), remember() {} });
  const timeline = async (): Promise<TimelineEntry[]> => [
    { kind: 'user', text: tl.user },
    ...(tl.change ? [{ kind: 'tool', text: 'seed.js', data: { type: 'fileChange', status: 'completed' } }] : []),
    ...(tl.test !== null ? [{ kind: 'tool', text: `npm test\n${tl.test}`, data: { type: 'commandExecution', command: tl.testCommand, output: tl.test, status: tl.testStatus, exitCode: tl.exit } }] : []),
    ...(tl.after ? [{ kind: 'tool', text: tl.after.command, data: { type: 'commandExecution', command: tl.after.command, output: '', status: 'completed', exitCode: 0 } }] : []),
    ...(tl.trailingTool !== null ? [{ kind: 'tool', text: tl.trailingTool, data: { type: 'commandExecution', command: 'env', output: tl.trailingTool, status: 'completed' } }] : []),
    { kind: 'assistant', text: tl.final },
    ...(tl.question ? [{ kind: 'question', text: 'Which database?', status: 'pending' }] : []),
  ];
  const deps: CheckoutDeps = {
    store, backend: () => server.backend(), reader,
    git: counted(gitCalls, { isRepo: async () => repo, defaultBranch: async (_p, preferred) => preferred ?? 'dev', headSha: async () => head, stat: async () => ({ count: 2, added: 20, removed: 3 }), push: async (_p, b) => { if (pushOk) { pushed.push(b); pushedHead = true; } return { pushed: pushOk, ...(noRemote ? { noRemote: true } : {}), message: pushOk ? `Pushed ${b}.` : noRemote ? 'This repository has no remote.' : 'Could not push: no network' }; }, commitAll: async (_p, message) => { if (!commitOk) return { committed: false, message: 'Git has no name and email set.' }; commits.push(message); head = `commit${commits.length}`; clean = true; pushedHead = false; return { committed: true, message: 'Committed.' }; }, pushedHead: async () => pushedHead, isClean: async () => clean, state: async () => `${head}|${clean ? 'clean' : 'dirty'}|${salt}`, summaryStat: async (_p, bases) => { statCalls.push([...bases]); if (statFails) throw new Error('no merge base'); return stat; }, verifyPr: async (_p, url) => prOk.has(url) }),
    worktrees: { create: async (_root, branch) => { worktrees.push(branch); return { path: `/wt/${branch.replace('/', '-')}`, branch }; } },
    chats: { addFolder: async p => ({ id: `f:${p}` }), create: async f => { const id = `chat:${f}:${++chatSeq}`; chatList.push({ id, path: f.replace(/^f:/, ''), activeAt: clock }); return { id }; }, select: async () => {}, rename: async () => {}, timeline, send: async (c, text) => { sent.push([c, text]); }, inFolder: async p => chatList.filter(c => c.path === p).map(c => ({ id: c.id, activeAt: c.activeAt })), folderOf: id => chatList.find(c => c.id === id)?.path ?? null },
    exists: () => true,
    providers: () => providers, home: () => homeDir, testSetup: async () => hasTests,
    turnFacts: async () => ({ tokens: { input: 1000, cached: 100, output: 200 }, tests: opts.tests ?? 1, model: 'claude-opus-4', provider: 'claude-code', costUsd: 0.5, durationMs: 4000, outcome: tl.outcome }),
    serverLabel: () => 'aiteam', origin: () => origin, deviceNameDefault: () => 'Dhairya’s MacBook', now: () => clock, emit: id => emitted.push(id), notify: e => events.push(e), later: fn => { if (!opts.lazy) fn(); },
    queued: () => queuedMore, countdown: { schedule: (fn, ms) => { const t = { fn, ms, live: true }; wait.push(t); return () => { t.live = false; }; } },
  };
  const svc = new CheckoutService(deps);
  // Most tests are about what a finished turn leads to, not the 60 seconds in between: the countdown runs out right after the turn unless a test turns that off.
  let autoFire = true;
  const rawOnTurn = svc.onTurn.bind(svc);
  svc.onTurn = async (...args) => { await rawOnTurn(...args); if (autoFire) await fire(); };
  /** Lets the 60 second countdown run out (or says there is none). */
  const fire = async (sync = true): Promise<number> => { const live = wait.filter(t => t.live); wait = wait.filter(t => !live.includes(t)); for (const t of live) { t.live = false; t.fn(); } await new Promise(r => setTimeout(r, 20)); if (sync) await svc.sync(); return live.length; };
  return { events, chatList, sent, fire, hold: (v = true) => { autoFire = !v; }, countdownMs: () => wait.filter(t => t.live).map(t => t.ms), statCalls, setSalt: (v: number) => { salt = v; }, setStatFails: (v: boolean) => { statFails = v; }, setStat: (v: typeof stat) => { stat = v; }, setQueued: (v: boolean) => { queuedMore = v; }, tl, orgDir, homeDir, gitCalls, commits, setNoRemote: (v: boolean) => { noRemote = v; }, setCommitOk: (v: boolean) => { commitOk = v; }, setHasTests: (v: boolean) => { hasTests = v; }, setRepo: (v: boolean) => { repo = v; }, dirty: () => !clean, setClean: (v: boolean) => { clean = v; }, setHead: (v: string) => { head = v; }, setPushedHead: (v: boolean) => { pushedHead = v; }, setOrigin: (v: string) => { origin = v; }, prOk, server, db, store, svc, reader, advance: (ms: number) => { clock += ms; }, worktrees, pushed, emitted, setPush: (v: boolean) => { pushOk = v; }, now: () => clock };
}
/** The fake git, with every call counted (a plain folder must make none). */
function counted<T extends object>(calls: string[], target: T): T { return new Proxy(target, { get: (t, k) => { const v = (t as Record<string | symbol, unknown>)[k]; return typeof v === 'function' ? (...args: unknown[]) => { calls.push(String(k)); return (v as (...a: unknown[]) => unknown)(...args); } : v; } }); }
const OWN = { kind: 'own' as const, providerId: 'omniroute', model: 'gpt-x' };
async function bound(h: ReturnType<typeof setup>) { await h.reader.part(CO); await h.svc.bind(CO.id, 'p-redis', REPO, 'dev'); }

// --- the state machine ----------------------------------------------------------------------------------------------------------------

test('two simultaneous check-outs of one task make one worktree, one chat and one check-out post', async () => {
  const h = setup(); await h.reader.part(CO);
  await h.svc.bind(CO.id, 'p-redis', REPO, 'dev');
  const results = await Promise.allSettled([h.svc.start({ taskId: 't1', model: OWN, confirm: true }), h.svc.start({ taskId: 't1', model: OWN, confirm: true })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1, 'the second click is refused as already checked out');
  assert.deepEqual(h.worktrees, ['muster/RAG-1'], 'one worktree');
  assert.equal(h.chatList.length, 1, 'one chat');
  assert.equal(h.server.comments.get('t1')!.length, 1, 'one check-out comment');
});
