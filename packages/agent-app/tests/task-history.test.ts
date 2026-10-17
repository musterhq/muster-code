/** #434: a server task worked on locally starts with its whole history: the full thread, every document, the earlier agents' runs, parent, blockers and
 *  siblings, written to the self-ignoring `.muster/task/` folder, and a compact brief that points at it; the worktree continues the server agents' branch.
 *  Over a fake server and a fake git (the real git only for the one branch fetch). Nothing here reads ~/.paperclip or a real server. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CheckoutService, REFRESH_MS, type CheckoutDeps, type LocalProviderInfo } from '../src/runtime/checkout/service.ts';
import { CheckoutStore } from '../src/runtime/checkout/store.ts';
import { OrgReader } from '../src/runtime/server/orgs.ts';
import { PaperclipError } from '../src/runtime/paperclip-client.ts';
import { realGit } from '../src/runtime/checkout/git-port.ts';
import { BRIEF_BUDGET, compactBrief, gitHints, readTaskFolder, taskFolderProblem, UnsafeTaskFolder, UNSAFE_FOLDER_NOTE, validBranch, writeTaskFolder, type TaskHistory } from '../src/runtime/checkout/task-history.ts';
import { historyFromImport, ImportedHistory, IMPORTED_RULES, type ImportedTask } from '../src/runtime/checkout/imported-history.ts';
import type { ServerBackend, ServerPart } from '../src/runtime/server/backend.ts';
import type { WorkspaceAgent, WorkspaceTask, WorkspaceTaskDetail } from '../src/shared/domains/paperclip-protocol.ts';

const ME = 'u-me', CO = { id: 'co', name: 'Ragnar', prefix: 'RAG' };
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const task = (id: string, key: string, extra: Partial<WorkspaceTask> = {}): WorkspaceTask => ({
  id, key, title: `Task ${key}`, status: 'todo', priority: 'medium', source: 'paperclip', projectId: 'p1', parentId: null, goalId: null, assigneeId: `user:${ME}`, assigneeUserId: ME, assigneeLabel: 'You',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', startedAt: null, completedAt: null, live: false, blockedByIds: [], origin: null, createdByUserId: null, ...extra,
});
const agent = (id: string, name: string): WorkspaceAgent => ({ id, name, role: 'engineer', title: null, model: 'claude-opus-4', adapter: 'claude_local', source: 'paperclip', status: 'idle', reportsTo: null, lastActiveAt: null, error: null, capabilities: null, pausable: true });

/** A server task with a long thread, two documents, two earlier agent runs (one of them on a branch), a parent, a blocker and a sibling. */
class Server {
  down = false; detailFails = 0; reads: string[] = []; instructions = 'Be careful.';
  tasks = [task('t1', 'RAG-1', { parentId: 'tp', blockedByIds: ['tb'] }), task('tp', 'RAG-0', { assigneeId: 'a1', assigneeUserId: null, assigneeLabel: 'Builder' }), task('tb', 'RAG-2', { status: 'in_progress' }), task('ts', 'RAG-3', { parentId: 'tp', status: 'done' })];
  agents = [agent('a1', 'Builder'), agent('a2', 'Reviewer')];
  description = 'Move the Redis sources to the new layout.\n\nAcceptance: tests pass.';
  comments = Array.from({ length: 40 }, (_, n) => ({ id: `c${n}`, author: { kind: (n % 2 ? 'agent' : 'user') as 'agent' | 'user', id: null, label: n % 2 ? 'Builder' : 'Bob' }, body: `Comment number ${n}: ${'detail '.repeat(60)}${n === 3 ? ` token ${SECRET}` : ''}${n === 7 ? ` <!-- muster:report --> [@Dhairya](user://${ME}) please decide` : ''}`, createdAt: new Date(Date.parse('2026-10-01T00:00:00Z') + n * 60_000).toISOString(), runId: n === 21 ? 'run-1' : n === 33 ? 'run-2' : null }));
  documents = [{ key: 'plan', title: 'Plan', body: `# Plan\n\nStep one.\n${'x'.repeat(30_000)}\nPLAN-END`, revision: 3 }, { key: 'notes', title: 'Notes', body: 'Notes body with password=hunter22', revision: 1 }];
  runs = [
    { id: 'run-2', agentId: 'a2', taskId: 't1', status: 'failed', trigger: 'assignment', source: 'paperclip', createdAt: '2026-10-01T00:40:00Z', startedAt: '2026-10-01T00:40:00Z', finishedAt: '2026-10-01T00:50:00Z', error: 'tests failed', cancellable: false },
    { id: 'run-1', agentId: 'a1', taskId: 't1', status: 'succeeded', trigger: 'assignment', source: 'paperclip', createdAt: '2026-10-01T00:10:00Z', startedAt: '2026-10-01T00:10:00Z', finishedAt: '2026-10-01T00:30:00Z', error: null, cancellable: false },
  ];
  summaries: Record<string, string> = { 'run-1': 'Moved src/redis to packages/redis and opened https://github.com/acme/app/pull/12 on branch `feature/redis-move`.', 'run-2': 'Review: two tests fail in `packages/redis/client.test.ts`.' };
  products = [{ id: 'w1', type: 'pull_request', title: 'Redis move', url: 'https://github.com/acme/app/pull/12', status: 'ready_for_review', summary: 'The move', createdByRunId: 'run-1', metadata: { headRefName: 'feature/redis-move' }, updatedAt: '2026-10-01T00:30:00Z' }];
  workspace: Record<string, unknown> | null = null;
  private up() { if (this.down) throw new PaperclipError('connect ECONNREFUSED', 0, 'network'); }
  part(): ServerPart { return { tasks: this.tasks.map(t => ({ ...t })), agents: this.agents, projects: [{ id: 'p1', name: 'Redis', status: 'in_progress', description: '', source: 'paperclip', repo: null, cwd: null, taskCount: 4, openCount: 3, paused: false, memory: null }], runs: [], inbox: [], goals: [], approvals: [], labels: [], people: [{ id: ME, name: 'Dhairya' }] }; }
  detail(id: string): WorkspaceTaskDetail {
    // The imported project's issue id stands for the same task here.
    const t = this.tasks.find(x => x.id === id) ?? this.tasks[0]!;
    return { task: t, description: this.description, comments: this.comments.map(c => ({ ...c })), runs: this.runs as never, addressee: null, composerNote: null, subtasks: [], blocking: [], receipts: [],
      cards: [...this.documents.map(d => ({ kind: 'document' as const, id: `d-${d.key}`, at: '2026-10-01T01:00:00Z', key: d.key, title: d.title, format: 'markdown', body: d.body.slice(0, 24_000), revision: d.revision, revisions: [] })),
        { kind: 'needs' as const, id: 'n1', at: '2026-10-01T01:00:00Z', from: 'Builder', prompt: 'Keep the old import path as an alias?', detail: null, status: 'pending' as const, resolution: null, interactionId: 'i1', acceptLabel: null, rejectLabel: null }],
      mentionable: [] };
  }
  get(path: string): unknown {
    this.up(); this.reads.push(path);
    if (path === '/issues/t1' || path === '/issues/srv-15') return { id: 't1', executionWorkspaceId: this.workspace ? 'ew1' : null };
    if (path === '/issues/tp') return { id: 'tp', identifier: 'RAG-0', title: 'Task RAG-0', status: 'in_progress', description: 'The parent: split the monolith.' };
    if (path === '/execution-workspaces/ew1') return this.workspace;
    if (path === '/issues/t1/work-products' || path === '/issues/srv-15/work-products') return this.products;
    const doc = /^\/issues\/t1\/documents\/(\w+)$/.exec(path);
    if (doc) return this.documents.find(d => d.key === doc[1]);
    const run = /^\/heartbeat-runs\/([\w-]+)$/.exec(path);
    if (run) return { id: run[1], resultJson: { summary: this.summaries[run[1]!] } };
    throw new PaperclipError('not found', 404, 'service');
  }
  backend(): ServerBackend {
    const s = this;
    return {
      kind: 'paperclip', endpoint: { baseUrl: 'http://x' }, generation: 1, invalidate() {},
      async companies() { s.up(); return [CO]; }, async read() { s.up(); return s.part(); }, async whoami() { s.up(); return { id: ME, name: 'Dhairya', email: null }; },
      async patchTask() { s.up(); }, async rawComments() { s.up(); return []; }, async putDocument() { s.up(); }, async postCostEvent() { s.up(); },
      async agentInstructions() { s.up(); return s.instructions; }, async issuePolicy() { s.up(); return []; },
      async comment(_id: string, body: string) { s.up(); return { id: 'x', author: { kind: 'user' as const, id: ME, label: 'You' }, body, createdAt: new Date().toISOString() }; },
      async taskDetail(id: string) { s.up(); if (s.detailFails > 0) { s.detailFails--; throw new PaperclipError('Bad gateway', 502, 'service'); } return s.detail(id); },
      importReader() { return { get: async (path: string) => s.get(path), issuePages: async function* () { /* none */ }, commentPages: async function* () { /* none */ } }; },
    } as unknown as ServerBackend;
  }
}

const providers: LocalProviderInfo[] = [{ id: 'claude-code', name: 'Claude Code', driver: 'claude-code-cli', available: true, subscription: true, models: [{ id: 'claude-opus-4', name: 'Opus 4' }] }, { id: 'omniroute', name: 'OmniRoute', available: true, models: [{ id: 'gpt-x', name: 'GPT X' }] }];
const OWN = { kind: 'own' as const, providerId: 'omniroute', model: 'gpt-x' };
function setup(opts: { remote?: (branch: string) => string | null } = {}) {
  const server = new Server(), db = new DatabaseSync(':memory:'), store = new CheckoutStore(() => db, join(mkdtempSync(join(tmpdir(), 'muster-h-copy-')), 'checkout'));
  const repo = mkdtempSync(join(tmpdir(), 'muster-h-repo-')), home = mkdtempSync(join(tmpdir(), 'muster-h-home-'));
  let clock = Date.parse('2026-10-05T10:00:00.000Z');
  const made: { branch: string; base: string; path: string }[] = [], fetched: string[] = [];
  const settings: Record<string, never> = {};
  const reader = new OrgReader({ backend: () => server.backend(), settings: () => settings, activeId: () => CO.id, serverLabel: () => 'aiteam', remembered: () => ({ id: ME, name: 'Dhairya' }), remember() {} });
  const chats: { id: string; path: string }[] = [];
  const deps: CheckoutDeps = {
    store, backend: () => server.backend(), reader,
    git: {
      isRepo: async () => true, defaultBranch: async (_p, preferred) => preferred ?? 'dev', headSha: async (_p, rev) => `sha-of-${rev ?? 'HEAD'}`, stat: async () => ({ count: 0, added: 0, removed: 0 }),
      push: async () => ({ pushed: true, message: 'ok' }), commitAll: async () => ({ committed: true, message: 'ok' }), pushedHead: async () => false, verifyPr: async () => false, isClean: async () => true, state: async () => 's', summaryStat: async () => ({ count: 0, added: 0, removed: 0 }),
      ...(opts.remote ? { remoteBranch: async (_p: string, branch: string) => { fetched.push(branch); return opts.remote!(branch); } } : {}),
    },
    worktrees: { create: async (_root, branch, base) => { const path = mkdtempSync(join(tmpdir(), 'muster-h-wt-')); made.push({ branch, base, path }); return { path, branch }; } },
    chats: { addFolder: async p => ({ id: `f:${p}` }), create: async f => { const id = `chat${chats.length + 1}`; chats.push({ id, path: f.slice(2) }); return { id }; }, select: async () => {}, rename: async () => {}, timeline: async () => [], inFolder: async p => chats.filter(c => c.path === p).map(c => ({ id: c.id, activeAt: 0 })), folderOf: id => chats.find(c => c.id === id)?.path ?? null },
    exists: () => true, providers: () => providers, home: () => home, testSetup: async () => true,
    turnFacts: async () => null, serverLabel: () => 'aiteam', origin: () => 'https://aiteam.example', deviceNameDefault: () => 'Mac', now: () => clock, emit: () => {}, later: fn => fn(),
    countdown: { schedule: () => () => {} },
  };
  const svc = new CheckoutService(deps);
  return { server, store, svc, reader, repo, made, fetched, advance: (ms: number) => { clock += ms; } };
}
async function checkedOut(h: ReturnType<typeof setup>, model: { kind: 'own'; providerId: string; model: string } | { kind: 'org-agent'; agentId: string } = OWN) {
  await h.reader.part(CO);
  await h.svc.bind(CO.id, 'p1', h.repo, 'dev');
  return h.svc.start({ taskId: 't1', model, confirm: true });
}
const dirOf = (worktree: string) => join(worktree, '.muster', 'task');

test('#434 a check-out writes the whole history to .muster/task: full thread, every document, both earlier runs, parent, blockers and siblings', async () => {
  const h = setup();
  const lease = await checkedOut(h);
  const dir = dirOf(lease.worktree!);
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), '*\n', 'the folder ignores itself: never committed');
  const thread = readFileSync(join(dir, 'THREAD.md'), 'utf8');
  for (let n = 0; n < 40; n++) assert.ok(thread.includes(`Comment number ${n}:`), `comment ${n}`);
  assert.ok(thread.indexOf('Comment number 0:') < thread.indexOf('Comment number 39:'), 'oldest first');
  assert.match(thread, /## Builder · 2026-10-01 00:01/, 'authors and times');
  assert.ok(thread.includes('detail '.repeat(60).trim()), 'each comment whole, not cut at 500 characters');
  const runs = readFileSync(join(dir, 'RUNS.md'), 'utf8');
  assert.ok(runs.indexOf('## Reviewer · failed') < runs.indexOf('## Builder · succeeded'), 'newest run first');
  assert.match(runs, /Moved src\/redis to packages\/redis/, 'run 1’s summary');
  assert.match(runs, /two tests fail/, 'run 2’s summary');
  assert.match(runs, /Comment number 21/, 'what the run posted to the thread');
  assert.match(runs, /pull request: Redis move \(ready for review\) https:\/\/github\.com\/acme\/app\/pull\/12/, 'its outputs');
  assert.match(runs, /packages\/redis\/client\.test\.ts/, 'files it named');
  assert.match(runs, /Error: tests failed/);
  assert.deepEqual(readdirSync(join(dir, 'docs')).sort(), ['notes.md', 'plan.md']);
  assert.match(readFileSync(join(dir, 'docs', 'plan.md'), 'utf8'), /PLAN-END/, 'a document past the detail’s 24,000 characters is read whole');
  const taskMd = readFileSync(join(dir, 'TASK.md'), 'utf8');
  assert.match(taskMd, /Acceptance: tests pass\./);
  assert.match(taskMd, /## Parent task\n\n- RAG-0 · Task RAG-0/); assert.match(taskMd, /split the monolith/, 'the parent’s description');
  assert.match(taskMd, /## Blocked by\n\n- RAG-2 · Task RAG-2 \(in progress/);
  assert.match(taskMd, /## Other subtasks of the parent\n\n- RAG-3 · Task RAG-3 \(done/);
  assert.match(taskMd, /Keep the old import path as an alias\?/, 'open questions');
  assert.match(taskMd, /branch feature\/redis-move/);
  // Secrets are redacted everywhere, and server markers are gone.
  const all = [thread, runs, taskMd, readFileSync(join(dir, 'docs', 'notes.md'), 'utf8'), readFileSync(join(dir, 'history.json'), 'utf8')].join('\n');
  assert.ok(!all.includes(SECRET) && !all.includes('hunter22'), 'secrets redacted');
  assert.ok(!all.includes('muster:report') && !all.includes('user://'), 'markers and mention links neutralised');
});

test('#434 the brief is a compact summary under the 8 KB cut: latest run first, open questions, the branch, and where the whole history is', async () => {
  const h = setup();
  const lease = await checkedOut(h);
  const brief = (await h.svc.brief(lease.chatId!))!;
  const dir = dirOf(lease.worktree!);
  assert.ok(Buffer.byteLength(brief) < 8 * 1024, `the brief fits (${Buffer.byteLength(brief)} bytes)`);
  assert.ok(brief.includes(`read ${dir}/TASK.md, THREAD.md (the whole thread, 40 comments), RUNS.md (2 earlier runs by the server’s agents) and docs/ (2 documents)`), 'it points at the files');
  assert.ok(brief.indexOf('Reviewer, failed') < brief.indexOf('Builder, succeeded'), 'latest run first');
  assert.match(brief, /Keep the old import path as an alias\?/);
  assert.match(brief, /worked on branch feature\/redis-move/);
  assert.match(brief, /<server-data kind="what earlier agents did, latest first" trust="untrusted">/, 'server text stays in the untrusted envelope');
  assert.ok(!brief.includes(SECRET));
  // A role's long instructions come last: the 8 KB cut takes from them, never from the history.
  const h2 = setup(); h2.server.instructions = 'Role rule. '.repeat(3000);
  const l2 = await checkedOut(h2, { kind: 'org-agent', agentId: 'a1' });
  const b2 = (await h2.svc.brief(l2.chatId!))!;
  const cut = Buffer.from(b2).subarray(0, 8 * 1024).toString('utf8');
  assert.ok(cut.includes('THREAD.md') && cut.includes('Builder, succeeded') && cut.includes('hands the task back'), 'the history and the hand-back rule are inside the first 8 KB');
  assert.match(readFileSync(join(dirOf(l2.worktree!), 'ROLE.md'), 'utf8'), /Role rule\./, 'the whole role text is on disk');
});

test('#434 the brief stays within its budget however long the history is', () => {
  const huge: TaskHistory = {
    version: 1, issueId: 'i', key: 'K-1', title: 'T'.repeat(2000), status: 'todo', org: 'O', project: 'P', server: 's', takenAt: '2026-10-01T00:00:00Z', description: 'd'.repeat(100_000),
    parent: { key: 'K-0', title: 'p'.repeat(1000), status: 'todo' }, blockedBy: Array.from({ length: 50 }, (_, n) => ({ key: `B-${n}`, title: 'b', status: 'todo' })), subtasks: Array.from({ length: 50 }, (_, n) => ({ key: `S-${n}`, title: 's'.repeat(500), status: 'todo' })), siblings: [],
    thread: Array.from({ length: 500 }, (_, n) => ({ author: 'A', at: '2026-10-01T00:00:00Z', body: 'c'.repeat(5000), runId: null })), documents: Array.from({ length: 30 }, (_, n) => ({ key: `d${n}`, title: 'D'.repeat(300), body: 'x', revision: 1, updatedAt: '' })),
    runs: Array.from({ length: 20 }, (_, n) => ({ id: `r${n}`, agent: 'Agent', status: 'succeeded', trigger: null, startedAt: null, finishedAt: null, createdAt: '', summary: 's'.repeat(4000), error: null, reports: [], outputs: [], mentions: [] })),
    outputs: [], questions: Array.from({ length: 20 }, () => 'q'.repeat(600)), decisions: [], git: { branch: 'feature/x', source: 'x', base: null, commit: null, repo: null, pr: null },
  };
  const brief = compactBrief(huge, { dir: '/wt/.muster/task' });
  assert.ok(brief.length <= BRIEF_BUDGET + 200, `within budget (${brief.length})`);
  assert.match(brief, /Before you start, read \/wt\/\.muster\/task\/TASK\.md/);
  assert.match(brief, /feature\/x/);
});

test('#434 never a title-only start: a copy that failed at check-out is taken before the first turn; an unreachable server falls back to the last copy and says so', async () => {
  const h = setup();
  h.server.detailFails = 2; // check-out could not read the task's detail
  const lease = await checkedOut(h);
  assert.equal(h.store.orgCopy('t1'), null, 'no copy was taken at check-out');
  const brief = (await h.svc.brief(lease.chatId!))!;
  assert.match(brief, /Move the Redis sources/, 'the first turn takes the copy');
  assert.match(brief, /THREAD\.md/);
  assert.ok(existsSync(join(dirOf(lease.worktree!), 'THREAD.md')), 'and writes the history before the turn');
  // Later: the server is down. The copy is a minute old, so the turn tries, then uses the last copy, and says so in one line.
  h.advance(REFRESH_MS + 1000); h.server.down = true;
  const offline = (await h.svc.brief(lease.chatId!))!;
  assert.match(offline, /Move the Redis sources/);
  assert.match(offline, /Muster Server could not be reached just now, so this is the copy taken at 2026-10-05T10:00:00\.000Z\./);
  // No copy at all and no server: the title, and a line that says why there is nothing else.
  h.store.deleteOrgCopy('t1');
  const bare = (await h.svc.brief(lease.chatId!))!;
  assert.match(bare, /could not be reached and no copy of this task was taken yet/);
});

test('#434 later turns refresh the files with what is new, without duplicating', async () => {
  const h = setup();
  const lease = await checkedOut(h);
  await h.svc.brief(lease.chatId!);
  h.server.comments.push({ id: 'c-new', author: { kind: 'agent', id: null, label: 'Builder' }, body: 'A brand new finding.', createdAt: '2026-10-05T10:00:30Z', runId: null });
  await h.svc.brief(lease.chatId!);
  assert.ok(!readFileSync(join(dirOf(lease.worktree!), 'THREAD.md'), 'utf8').includes('brand new'), 'within a minute the copy is reused');
  h.advance(REFRESH_MS + 1);
  await h.svc.brief(lease.chatId!);
  const thread = readFileSync(join(dirOf(lease.worktree!), 'THREAD.md'), 'utf8');
  assert.equal(thread.split('A brand new finding.').length - 1, 1, 'the new comment, once');
  assert.equal(thread.split('Comment number 5:').length - 1, 1, 'old comments are not repeated');
  h.server.documents.pop();
  h.advance(REFRESH_MS + 1);
  await h.svc.brief(lease.chatId!);
  assert.deepEqual(readdirSync(join(dirOf(lease.worktree!), 'docs')), ['plan.md'], 'a document gone from the server loses its file');
});

test('#434 git continuity: the worktree starts from the server agents’ branch when the remote has it; otherwise the brief names it', async () => {
  const h = setup({ remote: branch => `origin/${branch}` });
  const lease = await checkedOut(h);
  assert.deepEqual(h.fetched, ['feature/redis-move'], 'the branch from the agents’ pull request is fetched');
  assert.deepEqual(h.made.map(m => [m.branch, m.base]), [['muster/RAG-1', 'origin/feature/redis-move']], 'the worktree starts from it');
  assert.equal(h.store.lease('t1')!.baseSha, 'sha-of-origin/feature/redis-move', 'files changed are counted from there');
  assert.match((await h.svc.brief(lease.chatId!))!, /This worktree starts from origin\/feature\/redis-move/);
  // The execution workspace's branch wins over what comments say.
  const h2 = setup({ remote: () => null });
  h2.server.workspace = { id: 'ew1', branchName: 'agents/rag-1', baseRef: 'dev' };
  const l2 = await checkedOut(h2);
  assert.deepEqual(h2.fetched, ['agents/rag-1']);
  assert.equal(h2.made[0]!.base, 'dev', 'not on the remote: the dev branch, as before');
  assert.match((await h2.svc.brief(l2.chatId!))!, /worked on branch agents\/rag-1, which is not in this worktree\. Continue from it/);
});

test('#434 branch hints: workspace, then work products, then the thread; never an option-like or default branch', () => {
  assert.equal(gitHints({ workspace: { branchName: 'ws/one' }, products: [{ type: 'branch', title: 'wp/two' }], thread: [] }).branch, 'ws/one');
  assert.equal(gitHints({ products: [{ type: 'branch', title: 'wp/two' }], thread: [] }).branch, 'wp/two');
  assert.equal(gitHints({ thread: [{ author: 'A', at: '1', body: 'Pushed to branch `fix/a`', runId: null }, { author: 'A', at: '2', body: 'Now on branch: fix/b.', runId: null }] }).branch, 'fix/b', 'the newest mention');
  assert.equal(gitHints({ thread: [{ author: 'A', at: '1', body: 'commit `abc1234def` on branch `--upload-pack=evil`', runId: null }] }).branch, null);
  assert.equal(gitHints({ thread: [{ author: 'A', at: '1', body: 'committed abc1234def', runId: null }] }).commit, 'abc1234def');
  for (const bad of ['-x', 'a..b', 'main', 'a b', 'x.lock', 'x/']) assert.equal(validBranch(bad), false, bad);
});

test('#434 the real branch fetch only moves the remote-tracking ref: the person’s checkout keeps its branch and files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'muster-h-git-')), remote = join(root, 'remote.git'), work = join(root, 'agents'), mine = join(root, 'mine');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'dev', remote]);
  execFileSync('git', ['clone', '-q', remote, work]); git(work, 'config', 'user.email', 't@t'); git(work, 'config', 'user.name', 't');
  writeFileSync(join(work, 'a.txt'), 'a\n'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'init'); git(work, 'push', '-q', 'origin', 'HEAD:dev');
  execFileSync('git', ['clone', '-q', remote, mine]);
  git(work, 'checkout', '-qb', 'feature/agents'); writeFileSync(join(work, 'b.txt'), 'b\n'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'agents'); git(work, 'push', '-q', 'origin', 'feature/agents');
  writeFileSync(join(mine, 'local.txt'), 'mine\n');
  const before = { head: git(mine, 'rev-parse', 'HEAD'), branch: git(mine, 'branch', '--show-current'), status: git(mine, 'status', '--porcelain') };
  assert.equal(await realGit.remoteBranch!(mine, 'feature/agents'), 'origin/feature/agents');
  assert.equal(git(mine, 'rev-parse', 'origin/feature/agents'), git(work, 'rev-parse', 'HEAD'));
  assert.deepEqual({ head: git(mine, 'rev-parse', 'HEAD'), branch: git(mine, 'branch', '--show-current'), status: git(mine, 'status', '--porcelain') }, before, 'the checkout is untouched');
  assert.equal(git(mine, 'branch', '--list', 'feature/agents'), '', 'no local branch was made');
  assert.equal(await realGit.remoteBranch!(mine, 'feature/missing'), null, 'a branch the remote does not have');
  assert.equal(await realGit.remoteBranch!(mine, '--upload-pack=x'), null, 'never an option');
});

test('#434 a plain folder check-out gets the same files in the folder, which hand-back never counts as work', async () => {
  const h = setup();
  await h.reader.part(CO);
  await h.svc.bind(CO.id, 'p1', h.repo, undefined, false);
  // The fake git says every folder is a repository; a plain folder is bound by kind.
  h.store.bind('https://aiteam.example', { ...h.store.binding('https://aiteam.example', CO.id, 'p1')!, kind: 'folder', devBranch: '' });
  const lease = await h.svc.start({ taskId: 't1', model: OWN, confirm: true });
  assert.equal(lease.worktree, h.repo, 'used in place');
  assert.ok(existsSync(join(h.repo, '.muster', 'task', 'THREAD.md')));
  assert.equal(readFileSync(join(h.repo, '.muster', 'task', '.gitignore'), 'utf8'), '*\n');
  assert.match((await h.svc.brief(lease.chatId!))!, new RegExp(`read ${join(h.repo, '.muster', 'task').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/TASK\\.md`));
  const { snapshotFolder } = await import('../src/runtime/checkout/folder.ts');
  assert.ok(Object.keys(await snapshotFolder(h.repo)).every(p => !p.startsWith('.muster')), 'the history is not part of the folder’s work');
});

// --- imported projects: Start and the scheduler ---------------------------------------------------------------------------------------------
function importedTask(): ImportedTask {
  const t = task('m1', 'RAG-15', { source: 'local' as never, parentId: 'm0', blockedByIds: ['m2'] });
  const comments = Array.from({ length: 25 }, (_, n) => ({ id: `pc:c${n}`, author: { kind: 'agent' as const, id: null, label: n % 2 ? 'CTO' : 'Builder' }, body: `Imported comment ${n}${n === 2 ? ` key ${SECRET}` : ''}${n === 20 ? ' Pushed to branch `feature/rag-15`.' : ''}`, createdAt: new Date(Date.parse('2026-09-01T00:00:00Z') + n * 60_000).toISOString(), runId: n === 20 ? 'srv-run-9' : null }));
  return {
    detail: { task: t, description: 'Short acceptance (cut)', comments: [...comments, { id: 'local-1', author: { kind: 'system', id: null, label: 'Muster' }, body: 'Local notice', createdAt: '2026-09-02T00:00:00Z' }], runs: [], addressee: null, composerNote: null, subtasks: [], blocking: [], receipts: [], cards: [], mentionable: [] },
    tasks: [t, task('m0', 'RAG-1', { source: 'local' as never }), task('m2', 'RAG-14', { source: 'local' as never, status: 'done' }), task('m3', 'RAG-16', { source: 'local' as never, parentId: 'm0' })],
    sourceId: 'srv-15', fullDescription: 'The full description, longer than the acceptance.', org: 'Ragnar', project: 'OSS Manager', server: 'aiteam',
    rows: [
      { kind: 'document:plan', taskId: 'm1', title: 'Plan', status: '2', detail: JSON.stringify({ body: 'The imported plan body.' }), at: '2026-09-01T02:00:00Z', pending: false },
      { kind: 'work_product:pull_request', taskId: 'm1', title: 'RAG-15 PR', status: 'open', detail: JSON.stringify({ url: 'https://github.com/acme/app/pull/40', summary: 'The PR' }), at: '2026-09-01T03:00:00Z', pending: false },
      { kind: 'interaction', taskId: 'm1', title: 'Which queue?', status: 'pending', detail: '', at: '2026-09-01T03:00:00Z', pending: true },
      { kind: 'document:other', taskId: 'mX', title: 'Not this task', status: '1', detail: '{}', at: '', pending: false },
    ],
  };
}

test('#434 an imported task’s history comes from what the import kept when the server is not connected', () => {
  const h = historyFromImport(importedTask(), Date.parse('2026-10-05T10:00:00Z'));
  assert.equal(h.thread.length, 25, 'every imported comment, none of the local notices');
  assert.equal(h.description, 'The full description, longer than the acceptance.');
  assert.deepEqual(h.documents.map(d => [d.key, d.body]), [['plan', 'The imported plan body.']]);
  assert.equal(h.runs.length, 1, 'a run that posted to the thread is an earlier run');
  assert.deepEqual([h.parent?.key, h.blockedBy.map(b => b.key), h.siblings.map(s => s.key)], ['RAG-1', ['RAG-14'], ['RAG-16']]);
  assert.deepEqual(h.questions, ['Which queue?']);
  assert.equal(h.git.branch, 'feature/rag-15'); assert.equal(h.git.pr, 'https://github.com/acme/app/pull/40');
  assert.ok(!JSON.stringify(h).includes(SECRET));
});

test('#434 imported Start and scheduler runs: the history is written to the run’s worktree and the brief points at it; the server it came from is read when connected', async () => {
  let clock = Date.parse('2026-10-05T10:00:00Z');
  let server: { backend: ServerBackend; label: string } | null = null;
  const history = new ImportedHistory({ now: () => clock, local: async (_p, id) => id === 'm1' ? importedTask() : null, server: async () => server });
  // Start / the scheduler: collected before the worktree, written into it.
  const got = (await history.collect('p', 'm1'))!;
  assert.match(got.note!, /not connected, so this is the copy the last import kept/);
  const wt = mkdtempSync(join(tmpdir(), 'muster-h-imp-'));
  history.write(wt, got.history, 'origin/feature/rag-15');
  const dir = dirOf(wt);
  assert.match(readFileSync(join(dir, 'THREAD.md'), 'utf8'), /Imported comment 24/);
  assert.match(readFileSync(join(dir, 'docs', 'plan.md'), 'utf8'), /imported plan body/);
  const brief = (await history.brief({ projectId: 'p', taskId: 'm1', folder: { path: wt, checkout: false } }))!;
  assert.ok(brief.startsWith(IMPORTED_RULES));
  assert.ok(brief.includes(`read ${dir}/TASK.md, THREAD.md (the whole thread, 25 comments)`));
  assert.match(brief, /This worktree starts from origin\/feature\/rag-15/);
  assert.ok(Buffer.byteLength(brief) < 4_800, 'leaves room in the project block for the task’s critical lines');
  assert.equal(await history.brief({ projectId: 'p', taskId: 'other', folder: null }), null, 'not an imported task');
  // A later turn with the server connected: the server's history replaces the import's copy, and the branch the worktree started from is kept.
  const s = new Server();
  server = { backend: s.backend(), label: 'aiteam' };
  clock += 61_000;
  const later = (await history.brief({ projectId: 'p', taskId: 'm1', folder: { path: wt, checkout: false } }))!;
  assert.match(later, /THREAD\.md \(the whole thread, 40 comments\)/);
  assert.ok(s.reads.includes('/heartbeat-runs/run-1'), 'the earlier runs were read from the server');
  assert.equal(readTaskFolder(wt)!.git.continuedFrom, 'origin/feature/rag-15');
  // A run in the project's own checkout: nothing is written there.
  const checkout = mkdtempSync(join(tmpdir(), 'muster-h-co-'));
  const own = (await history.brief({ projectId: 'p', taskId: 'm1', folder: { path: checkout, checkout: true } }))!;
  assert.match(own, /not written to this folder/);
  assert.ok(!existsSync(join(checkout, '.muster')));
});

// --- security: a repository can commit .muster (or any part of the path) as a link -------------------------------------------------------------
/** A stand-in for the person's own files outside the worktree. */
function home() {
  const dir = mkdtempSync(join(tmpdir(), 'muster-h-victim-'));
  const files: Record<string, string> = { 'plan.md': 'my plan', 'notes.md': 'my notes', 'other.md': 'other', 'keep.txt': 'keep', 'TASK.md': 'mine', 'history.json': '{"version":1,"key":"FAKE"}' };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const intact = () => { assert.deepEqual(readdirSync(dir).sort(), Object.keys(files).sort(), 'no file added or lost'); for (const [name, text] of Object.entries(files)) assert.equal(readFileSync(join(dir, name), 'utf8'), text, `${name} unchanged`); };
  return { dir, intact };
}
const sample = (): TaskHistory => historyFromImport(importedTask(), Date.parse('2026-10-05T10:00:00Z'));

test('#434 security: a docs folder that is a link to the person’s files is refused, and not one of their files is lost or changed', async () => {
  const victim = home(), wt = mkdtempSync(join(tmpdir(), 'muster-h-wt-'));
  mkdirSync(join(wt, '.muster', 'task'), { recursive: true });
  symlinkSync(victim.dir, join(wt, '.muster', 'task', 'docs'));
  assert.match(taskFolderProblem(wt)!, /is a link/);
  assert.throws(() => writeTaskFolder(wt, sample()), UnsafeTaskFolder);
  victim.intact();
  // Through a check-out: the brief carries the summary alone and says why; nothing is written or removed.
  const h = setup();
  await h.reader.part(CO); await h.svc.bind(CO.id, 'p1', h.repo, 'dev');
  const lease = await h.svc.start({ taskId: 't1', model: OWN, confirm: true });
  const v2 = home();
  // The repository now has docs/ as a link (as if it came with a pull).
  const { rmSync } = await import('node:fs');
  rmSync(join(lease.worktree!, '.muster', 'task', 'docs'), { recursive: true, force: true });
  symlinkSync(v2.dir, join(lease.worktree!, '.muster', 'task', 'docs'));
  h.advance(REFRESH_MS + 1);
  const brief = (await h.svc.brief(lease.chatId!))!;
  v2.intact();
  assert.ok(brief.includes(UNSAFE_FOLDER_NOTE), 'one line says why');
  assert.ok(!brief.includes('Before you start, read'), 'the brief does not point at files that were not written');
  assert.match(brief, /Builder, succeeded/, 'the summary is still there');
});

test('#434 security: a .muster that is a link makes Muster refuse; a file that is a link is replaced, never written through', async () => {
  const victim = home(), wt = mkdtempSync(join(tmpdir(), 'muster-h-wt-'));
  symlinkSync(victim.dir, join(wt, '.muster'));
  assert.throws(() => writeTaskFolder(wt, sample()), UnsafeTaskFolder);
  assert.equal(readTaskFolder(wt), null, 'nothing is read through the link either');
  victim.intact();
  const history = new ImportedHistory({ now: () => Date.parse('2026-10-05T10:00:00Z'), local: async () => importedTask(), server: async () => null });
  assert.equal(history.write(wt, sample()), null, 'the imported path refuses too');
  const brief = (await history.brief({ projectId: 'p', taskId: 'm1', folder: { path: wt, checkout: false } }))!;
  assert.ok(brief.includes(UNSAFE_FOLDER_NOTE)); victim.intact();
  // A file that is a link (TASK.md → the person's file): the link is replaced by Muster's file; their file is untouched.
  const v2 = home(), wt2 = mkdtempSync(join(tmpdir(), 'muster-h-wt-'));
  mkdirSync(join(wt2, '.muster', 'task', 'docs'), { recursive: true });
  symlinkSync(join(v2.dir, 'TASK.md'), join(wt2, '.muster', 'task', 'TASK.md'));
  writeTaskFolder(wt2, sample());
  v2.intact();
  assert.ok(lstatSync(join(wt2, '.muster', 'task', 'TASK.md')).isFile());
  assert.match(readFileSync(join(wt2, '.muster', 'task', 'TASK.md'), 'utf8'), /# RAG-15/);
  // Only regular files named like documents are ever removed from docs/.
  const docs = join(wt2, '.muster', 'task', 'docs');
  mkdirSync(join(docs, 'sub.md')); writeFileSync(join(docs, 'readme.txt'), 'r'); writeFileSync(join(docs, '.hidden.md'), 'h'); writeFileSync(join(docs, 'gone.md'), 'g');
  symlinkSync(join(v2.dir, 'notes.md'), join(docs, 'linked.md'));
  writeTaskFolder(wt2, sample());
  assert.deepEqual(readdirSync(docs).sort(), ['.hidden.md', 'linked.md', 'plan.md', 'readme.txt', 'sub.md'], 'a stale document file goes; links, folders and other files stay');
  v2.intact();
});
