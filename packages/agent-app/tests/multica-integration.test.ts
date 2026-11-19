/** Multica servers in Muster (#890), against a fake Multica server on a loopback port (tests/fixtures/multica-fake-server.ts, modelled on
 *  real Multica answers). Each test drives the runtime's own command handlers (`paperclip.*`, `musterServer.*`) or the check-out service,
 *  the way Settings › Integrations, the Projects pages and Work locally do. Nothing here talks to a real Multica server. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { createMusterServerDomain } from '../src/runtime/domains/muster-server.ts';
import { createPaperclipDomain } from '../src/runtime/domains/paperclip.ts';
import type { DomainContext } from '../src/runtime/domains/types.ts';
import type { MusterServerEntryView } from '../src/shared/domains/muster-server-protocol.ts';
import type { PaperclipTestResult, WorkspaceSnapshot, WorkspaceTaskDetail, WorkspaceTask } from '../src/shared/domains/paperclip-protocol.ts';
import { MulticaBackend } from '../src/runtime/server/multica-backend.ts';
import { OrgReader } from '../src/runtime/server/orgs.ts';
import { CheckoutService, type CheckoutDeps } from '../src/runtime/checkout/service.ts';
import { CheckoutStore } from '../src/runtime/checkout/store.ts';
import { AGENT_DEV, AGENT_QA, BOB_ID, ME_ID, PROJECT_WEB, WS_ACME, WS_LAB, startMulticaFake, type MulticaFake } from './fixtures/multica-fake-server.ts';

function secretsFake() { const values = new Map<string, string>(); return { values, store: { status: (id: string) => ({ stored: values.has(id), updatedAt: null, secureStorage: true }), get: (id: string) => values.get(id), set(id: string, v: string) { values.set(id, v); return this.status(id); }, clear(id: string) { values.delete(id); return this.status(id); } } }; }
async function home(t: TestContext) { const dir = await mkdtemp(join(tmpdir(), 'muster-multica-')); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })); return dir; }
async function fake(t: TestContext, ...args: Parameters<typeof startMulticaFake>) { const f = await startMulticaFake(...args); t.after(() => f.close()); return f; }
const ctxOf = (dataDir: string) => ({ dataDir, db: (() => { const memory = new DatabaseSync(':memory:'); return () => memory; })(), store: { snapshot: () => ({ folders: [] }) }, emit() {}, hooks: {}, async invoke(command: string) { if (command === 'mailbox.list') return { messages: [], unacked: 0, pending: 0 }; if (command === 'project.list') return []; if (command === 'memory.browse') return { records: [] }; throw new Error(`unexpected ${command}`); } }) as unknown as DomainContext;
const NO_TIMERS = { setTimeout: (() => 0) as never, clearTimeout: (() => undefined) as never };
function runtime(t: TestContext, dir: string) {
  const secrets = secretsFake(), ctx = ctxOf(dir);
  const ms = createMusterServerDomain(ctx, { secrets: () => secrets.store as never });
  const pc = createPaperclipDomain(ctx, { secrets: () => secrets.store as never, timers: NO_TIMERS });
  t.after(() => { pc.dispose?.(); ms.dispose?.(); });
  const call = <T>(command: string, input: Record<string, unknown> = {}) => Promise.resolve().then(() => (ms.handlers[command] ?? pc.handlers[command])!(input as never)) as Promise<T>;
  return { secrets, call, list: async () => (await call<{ servers: MusterServerEntryView[] }>('musterServer.list')).servers };
}
/** What Settings › Integrations does with "Connect with token": probe with the token, then save it for that address. */
async function addWithToken(r: ReturnType<typeof runtime>, f: { origin: string; token: string }, serverId = 'new') {
  const probe = await r.call<PaperclipTestResult>('paperclip.test', { mode: 'custom', baseUrl: f.origin, token: f.token });
  assert.equal(probe.ok, true, probe.message);
  await r.call('paperclip.config.set', { mode: 'custom', baseUrl: f.origin, token: f.token, backend: probe.backend, companyId: probe.companies?.[0]?.id ?? null, serverId });
  return probe;
}

// Spec: MUS-SPEC-13-890A (docs/spec/clauses/13-muster-server.md#mus-spec-13-890a)
test('two Multica servers added with personal access tokens are both listed online, each token kept in the secret store and sent only to its own server', async t => {
  const dir = await home(t), one = await fake(t), two = await fake(t), r = runtime(t, dir);
  const probe = await addWithToken(r, one);
  assert.equal(probe.backend, 'multica', 'the address is recognised as Multica');
  assert.equal(probe.compatibility, 'Multica');
  assert.deepEqual(probe.companies?.map(c => c.name), ['Acme', 'Lab'], 'Multica workspaces are the orgs');
  assert.equal(probe.message, 'Connected to Multica. 2 workspaces.');
  await addWithToken(r, two);
  await r.call('musterServer.rename', { serverId: (await r.list())[1]!.id, name: 'Lab Multica' });
  await r.call('musterServer.check', {});
  const list = await r.list();
  assert.deepEqual(list.map(s => [s.name, s.url, s.kind, s.state, s.account]), [
    [new URL(one.origin).host, one.origin, 'multica', 'online', 'Dana Founder · API token'],
    ['Lab Multica', two.origin, 'multica', 'online', 'Dana Founder · API token'],
  ]);
  assert.deepEqual([...r.secrets.values.values()].sort(), [one.token, two.token].sort(), 'each token is in the secret store, under its own entry');
  const onDisk = await readFile(join(dir, 'servers.json'), 'utf8') + await readFile(join(dir, 'server.json'), 'utf8');
  assert.equal(onDisk.includes(one.token) || onDisk.includes(two.token), false, 'no token in the server files');
  for (const [f, other] of [[one, two], [two, one]] as const) {
    assert.ok(f.calls.some(c => c.auth), 'the server was read with its token');
    for (const c of f.calls) if (c.auth) assert.equal(c.auth, `Bearer ${f.token}`, `${f.origin} only ever receives its own token`);
    assert.equal(f.calls.some(c => c.auth === `Bearer ${other.token}`), false);
  }
  const config = await r.call<Record<string, unknown>>('paperclip.config.get', {});
  assert.equal(JSON.stringify(config).includes(one.token), false, 'the token never reaches the window');
});

// Spec: MUS-SPEC-13-890B (docs/spec/clauses/13-muster-server.md#mus-spec-13-890b)
test('Test connection to a Multica server says what is wrong: a bad address, a token Multica refuses, a server that does not answer', async t => {
  const dir = await home(t), f = await fake(t), r = runtime(t, dir);
  const bad = await r.call<PaperclipTestResult>('paperclip.test', { mode: 'custom', baseUrl: 'not a url', token: f.token });
  assert.equal(bad.ok, false); assert.equal(bad.stage, 'config'); assert.match(bad.message, /not a valid URL/);
  const refused = await r.call<PaperclipTestResult>('paperclip.test', { mode: 'custom', baseUrl: f.origin, token: 'mul_wrong_token_000000000000' });
  assert.equal(refused.ok, false); assert.equal(refused.stage, 'auth'); assert.equal(refused.backend, 'multica');
  assert.match(refused.message, /did not accept this token: invalid token\./, 'Multica’s own words are shown');
  const none = await r.call<PaperclipTestResult>('paperclip.test', { mode: 'custom', baseUrl: f.origin });
  assert.equal(none.stage, 'auth'); assert.deepEqual(none.signIn, [], 'no browser sign-in is offered for Multica');
  assert.match(none.message, /needs a personal access token/);
  const closed = createServer(); await new Promise<void>(res => closed.listen(0, '127.0.0.1', res)); const port = (closed.address() as { port: number }).port; await new Promise(res => closed.close(res));
  const gone = await r.call<PaperclipTestResult>('paperclip.test', { mode: 'custom', baseUrl: `http://127.0.0.1:${port}`, token: f.token });
  assert.equal(gone.ok, false); assert.equal(gone.stage, 'network'); assert.match(gone.message, /Nothing answered/);
});

// Spec: MUS-SPEC-13-890C (docs/spec/clauses/13-muster-server.md#mus-spec-13-890c)
test('a Multica server that redirects never passes the token on: the redirect target receives nothing and the test fails', async t => {
  const dir = await home(t), f = await fake(t), elsewhere = await fake(t), r = runtime(t, dir);
  f.redirectTo = elsewhere.origin;
  const probe = await r.call<PaperclipTestResult>('paperclip.test', { mode: 'custom', baseUrl: f.origin, token: f.token });
  assert.equal(probe.ok, false, 'a redirect is not followed');
  assert.equal(probe.stage, 'network');
  assert.ok(f.calls.some(c => c.auth === `Bearer ${f.token}`), 'the token went to its own server');
  assert.equal(elsewhere.calls.length, 0, 'the redirect target was never contacted');
});

async function connected(t: TestContext) {
  const dir = await home(t), f = await fake(t), r = runtime(t, dir);
  await addWithToken(r, f);
  return { dir, f, r };
}

// Spec: MUS-SPEC-12-890A (docs/spec/clauses/12-projects-orgs-and-tasks.md#mus-spec-12-890a)
test('a Multica workspace shows its projects and issues on the Projects pages, and an issue opens with its description and comments', async t => {
  const { f, r } = await connected(t);
  const snap = await r.call<WorkspaceSnapshot>('paperclip.snapshot', { refresh: true });
  assert.deepEqual(snap.paperclip?.companies.map(c => c.name), ['Acme', 'Lab'], 'both workspaces are listed as orgs');
  assert.equal(snap.paperclip?.company?.id, WS_ACME);
  assert.deepEqual(snap.projects.map(p => [p.name, p.description, p.taskCount, p.openCount]), [['Website', 'The marketing site.', 2, 2]]);
  const row = (key: string) => snap.tasks.find(x => x.key === key)!;
  assert.deepEqual(snap.tasks.map(x => x.key).sort(), ['ACME-1', 'ACME-2', 'ACME-3']);
  assert.deepEqual([row('ACME-1').status, row('ACME-1').priority, row('ACME-1').assigneeLabel, row('ACME-1').assigneeId, row('ACME-1').projectId, row('ACME-1').labels], ['in_review', 'critical', 'Dev Agent', AGENT_DEV, PROJECT_WEB, [{ name: 'bug', color: '#e5484d' }]], 'urgent reads as Critical; the agent assignee by name');
  assert.deepEqual([row('ACME-2').assigneeLabel, row('ACME-2').assigneeUserId], ['You', ME_ID], 'a member assignee is a person, matched by user id');
  assert.deepEqual([row('ACME-3').status, row('ACME-3').priority, row('ACME-3').assigneeLabel], ['backlog', 'low', null]);
  assert.deepEqual(snap.people?.map(p => p.name).sort(), ['Bob Builder', 'Dana Founder'], 'the workspace members can be assigned');
  assert.ok(snap.agents.some(a => a.name === 'QA Agent'));
  const detail = await r.call<WorkspaceTaskDetail>('paperclip.task', { id: row('ACME-1').id });
  assert.equal(detail.description, 'After sign-in the app lands on /undefined.');
  assert.deepEqual(detail.comments.map(c => [c.author.kind, c.author.label, c.body]), [['agent', 'Dev Agent', `Opened a fix. [@Dana Founder](user://${ME_ID}) please review.`]], 'the agent’s comment, its mention in Muster’s own form');
  const scoped = f.calls.filter(c => c.path.startsWith('/api/issues'));
  assert.ok(scoped.length && scoped.every(c => c.workspace === WS_ACME || c.workspace === WS_LAB), 'issue calls name their workspace in X-Workspace-ID');
  assert.ok(f.calls.filter(c => c.path.startsWith(`/api/issues/${row('ACME-1').id}`)).every(c => c.workspace === WS_ACME), 'an Acme issue is read in Acme');
});

// Spec: MUS-SPEC-12-890B (docs/spec/clauses/12-projects-orgs-and-tasks.md#mus-spec-12-890b)
test('acting on a Multica issue sends Multica’s own fields, keeps the server’s answer, and shows a refusal in the server’s words', async t => {
  const { f, r } = await connected(t);
  await r.call('paperclip.snapshot', { refresh: true });
  const created = await r.call<WorkspaceTask>('paperclip.task.create', { projectId: PROJECT_WEB, title: 'Add a sitemap', description: 'For search engines.', priority: 'high', assigneeId: AGENT_DEV });
  assert.equal(created.key, 'ACME-4');
  const post = f.calls.find(c => c.method === 'POST' && c.path === '/api/issues')!;
  assert.deepEqual(post.body, { title: 'Add a sitemap', status: 'todo', description: 'For search engines.', priority: 'high', project_id: PROJECT_WEB, assignee_type: 'agent', assignee_id: AGENT_DEV });
  const target = f.state.issues.find(i => i.identifier === 'ACME-3')!;
  const moved = await r.call<WorkspaceTask>('paperclip.task.update', { taskId: target.id, status: 'in_progress', priority: 'critical' });
  assert.deepEqual([moved.status, moved.priority], ['in_progress', 'critical'], 'what comes back is the server’s answer');
  assert.deepEqual(f.calls.filter(c => c.method === 'PUT').at(-1)?.body, { status: 'in_progress', priority: 'urgent' });
  const toBob = await r.call<WorkspaceTask>('paperclip.task.update', { taskId: target.id, assigneeId: `user:${BOB_ID}` });
  assert.deepEqual(f.calls.filter(c => c.method === 'PUT').at(-1)?.body, { assignee_type: 'member', assignee_id: BOB_ID });
  assert.equal(toBob.assigneeLabel, 'Bob Builder');
  const toQa = await r.call<WorkspaceTask>('paperclip.task.update', { taskId: target.id, assigneeId: AGENT_QA });
  assert.deepEqual(f.calls.filter(c => c.method === 'PUT').at(-1)?.body, { assignee_type: 'agent', assignee_id: AGENT_QA });
  assert.equal(toQa.assigneeId, AGENT_QA);
  await r.call('paperclip.comment', { taskId: target.id, body: `Looks good. [@QA Agent](agent://${AGENT_QA}) please check.` });
  assert.equal(f.state.comments.at(-1)?.content, `Looks good. [@QA Agent](mention://agent/${AGENT_QA}) please check.`, 'a mention is sent in Multica’s form, so it wakes the agent');
  f.forbiddenAgents.add(AGENT_DEV);
  await assert.rejects(r.call('paperclip.task.update', { taskId: target.id, assigneeId: AGENT_DEV }), /you do not have permission to assign work to this agent \(403\)/);
  assert.equal(f.state.issues.find(i => i.id === target.id)?.assignee_id, AGENT_QA, 'a refused change changes nothing');
  await assert.rejects(r.call('paperclip.comment', { taskId: target.id, body: ' ' }), /Message/);
});

// --- check-out ------------------------------------------------------------------------------------------------------------------------
function checkoutRig(f: MulticaFake) {
  const backend = new MulticaBackend({ baseUrl: f.origin, token: f.token });
  const db = new DatabaseSync(':memory:'), store = new CheckoutStore(() => db, join(mkdtempSync(join(tmpdir(), 'muster-mcopy-')), 'checkout'));
  const homeDir = mkdtempSync(join(tmpdir(), 'muster-mhome-'));
  const reader = new OrgReader({ backend: () => backend, settings: () => ({}), activeId: () => WS_ACME, serverLabel: () => new URL(f.origin).host, remembered: () => ({ id: ME_ID, name: 'Dana Founder' }), remember() {} });
  let clock = Date.parse('2026-11-19T10:00:00.000Z'), seq = 0;
  const timeline = async () => [{ kind: 'user', text: 'Write them.' }, { kind: 'tool', text: 'notes.md', data: { type: 'fileChange', status: 'completed' } }, { kind: 'assistant', text: 'Wrote the release notes in notes.md.' }];
  const deps: CheckoutDeps = {
    store, backend: () => backend, reader,
    git: { isRepo: async () => false, defaultBranch: async () => 'main', headSha: async () => 'abc', stat: async () => ({ count: 0, added: 0, removed: 0 }), push: async () => ({ pushed: false, message: 'no git' }), commitAll: async () => ({ committed: false, message: 'no git' }) } as never,
    worktrees: { create: async () => { throw new Error('a plain folder makes no worktree'); } },
    chats: { addFolder: async p => ({ id: `f:${p}` }), create: async folder => ({ id: `chat:${folder}:${++seq}` }), select: async () => {}, rename: async () => {}, timeline, send: async () => {}, inFolder: async () => [], folderOf: () => null },
    exists: () => true, providers: () => [{ id: 'omniroute', name: 'OmniRoute', available: true, models: [{ id: 'gpt-x', name: 'GPT X' }] }], home: () => homeDir, testSetup: async () => false,
    turnFacts: async () => ({ tokens: { input: 1000, cached: 0, output: 200 }, tests: 0, model: 'gpt-x', provider: 'omniroute', costUsd: null, durationMs: 1000, outcome: 'completed' }),
    serverLabel: () => new URL(f.origin).host, origin: () => f.origin, deviceNameDefault: () => 'Dana’s laptop', now: () => clock, emit: () => {}, notify: () => {}, later: fn => fn(),
    queued: () => false, countdown: { schedule: () => () => {} },
  } as CheckoutDeps;
  return { svc: new CheckoutService(deps), reader, homeDir, tick: (ms: number) => { clock += ms; } };
}

// Spec: MUS-SPEC-12-890C (docs/spec/clauses/12-projects-orgs-and-tasks.md#mus-spec-12-890c)
test('working a Multica issue from a chat: check-out moves it to in_progress with a comment, hand-back moves it to in_review for the reviewer with a summary that mentions them', async t => {
  const f = await fake(t), rig = checkoutRig(f);
  const folder = await mkdtemp(join(rig.homeDir, 'site-'));
  await writeFile(join(folder, 'notes.md'), 'draft\n');
  await rig.reader.part({ id: WS_ACME, name: 'Acme', prefix: 'ACME' });
  await rig.svc.bind(WS_ACME, PROJECT_WEB, folder);
  const issue = f.state.issues.find(i => i.identifier === 'ACME-2')!;
  const plan = await rig.svc.plan('ACME-2');
  assert.equal(plan.assignedToMe, true); assert.equal(plan.task.orgName, 'Acme'); assert.equal(plan.task.projectName, 'Website');
  const lease = await rig.svc.start({ taskId: 'ACME-2', model: { kind: 'own', providerId: 'omniroute', model: 'gpt-x' }, confirm: true });
  assert.equal(lease.state, 'checked_out'); assert.ok(lease.chatId, 'a Muster chat was started for the issue');
  assert.equal(issue.status, 'in_progress', 'Multica’s own convention: the issue is in_progress while it is worked');
  assert.deepEqual([issue.assignee_type, issue.assignee_id], ['member', ME_ID]);
  const checkout = f.state.comments.filter(c => c.issue_id === issue.id).at(-1)!;
  assert.match(checkout.content, /^Checked out · working locally on Dana’s laptop · via Muster/);
  await writeFile(join(folder, 'notes.md'), 'Release 1.4: faster sign-in.\n');
  rig.tick(60_000);
  await rig.svc.handBack({ taskId: issue.id, reviewer: { kind: 'agent', id: AGENT_QA }, summary: 'Release notes drafted.', push: false });
  assert.equal(issue.status, 'in_review', 'delivered work awaits acceptance in in_review; done stays with a person');
  assert.deepEqual([issue.assignee_type, issue.assignee_id], ['agent', AGENT_QA], 'the reviewer agent now holds the issue');
  const handBack = f.state.comments.filter(c => c.issue_id === issue.id).at(-1)!;
  assert.match(handBack.content, /Handed back for review/);
  assert.ok(handBack.content.includes(`(mention://agent/${AGENT_QA})`), 'the reviewer is mentioned the Multica way, so Multica wakes the agent');
  assert.equal(handBack.content.includes('agent://'.replace('agent', '(agent')), false, 'no Muster-only mention link is left in the text');
  assert.equal(f.calls.some(c => /documents|cost-events/.test(c.path)), false, 'nothing is sent to routes Multica does not have');
  for (const c of f.calls) if (c.auth) assert.equal(c.auth, `Bearer ${f.token}`);
  assert.equal(f.calls.filter(c => c.path.startsWith(`/api/issues/${issue.id}`)).every(c => c.workspace === WS_ACME), true, 'the issue is always addressed in its own workspace');
});
