/**
 * Check out → work locally → hand back, end to end (#117), through the REAL agent service (fresh data dir, real SQLite, real git repos and
 * worktrees, a scripted provider for the local turns) against an ISOLATED Paperclip test-drive instance with TWO companies and two users.
 *
 * It needs that instance, so it only runs when MUSTER_PAPERCLIP_E2E names its API base (and MUSTER_PAPERCLIP_PG its embedded Postgres port, for
 * the cost-event and run checks). Start one with scratchpad `e2e/pc.sh start` + `e2e/seed.mjs`; never point this at a real instance.
 *   MUSTER_PAPERCLIP_E2E=http://127.0.0.1:3221/api MUSTER_PAPERCLIP_PG=54871 MUSTER_PAPERCLIP_SEED=seed.json node --experimental-transform-types --test tests/checkout-e2e.test.ts
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createAgentService } from '../src/runtime/service.ts';
import type { ProviderAdapter, ProviderInput } from '../src/runtime/provider.ts';

const BASE = process.env.MUSTER_PAPERCLIP_E2E, PG = process.env.MUSTER_PAPERCLIP_PG, SEED = process.env.MUSTER_PAPERCLIP_SEED;
const skip = !BASE || !SEED ? 'set MUSTER_PAPERCLIP_E2E and MUSTER_PAPERCLIP_SEED to run against the isolated Paperclip test-drive' : false;
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | undefined | null | false> | T | undefined | null | false, label: string, ms = 15_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v as T; await wait(80); }
  throw new Error(`timed out waiting for ${label}`);
}
const origin = BASE ? new URL(BASE).origin : '';
const api = async (path: string, init?: RequestInit) => { const r = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json' } }); const t = await r.text(); if (!r.ok) throw new Error(`${path} ${r.status} ${t}`); return t ? JSON.parse(t) : {}; };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
async function sql(query: string, args: unknown[] = []): Promise<Record<string, unknown>[]> {
  const { default: pg } = await import(process.env.MUSTER_PG_MODULE ?? '/Users/dhairya/.npm/_npx/0aa74679bec75e15/node_modules/pg/lib/index.js');
  const c = new pg.Client({ host: '127.0.0.1', port: Number(PG), user: 'paperclip', password: 'paperclip', database: 'paperclip' });
  await c.connect(); try { return (await c.query(query, args)).rows; } finally { await c.end(); }
}

async function harness(t: TestContext) {
  const seed = JSON.parse(await readFile(SEED!, 'utf8')) as { me: string; companies: { rag: { id: string; qa: string; ceo: string; redis: string; issues: Record<string, { id: string; key: string }> }; hyb: { id: string; issues: Record<string, { id: string; key: string }> } } };
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-checkout-e2e-'));
  // The project's repository on this Mac: a clone of a bare "origin" with a dev branch.
  const bare = join(dataDir, 'origin.git'), repo = join(dataDir, 'redis-repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['clone', '-q', bare, repo]);
  git(repo, 'config', 'user.email', 'dev@muster.test'); git(repo, 'config', 'user.name', 'Dev');
  await writeFile(join(repo, 'README.md'), '# redis\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init'); git(repo, 'branch', '-M', 'main'); git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'checkout', '-q', '-b', 'dev'); await writeFile(join(repo, 'DEV.md'), 'dev\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'dev work'); git(repo, 'push', '-q', '-u', 'origin', 'dev'); git(repo, 'checkout', '-q', 'main');
  const prompts: string[] = [];
  const provider: ProviderAdapter = {
    info: () => [{ id: 'scripted', name: 'Scripted', available: true, identityMasked: 'configured', models: [{ id: 'scripted-model', name: 'Scripted model' }] }],
    stop: async () => true, dispose() {},
    async run(input: ProviderInput) {
      prompts.push(`${input.developerInstructions ?? ''}\n${input.prompt}`);
      input.onEvent('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 900, cachedInputTokens: 100, outputTokens: 250, reasoningOutputTokens: 0 }, last: { inputTokens: 900, cachedInputTokens: 100, outputTokens: 250, reasoningOutputTokens: 0 } } });
      input.onEvent('item/started', { item: { type: 'commandExecution', id: 'cmd-1', command: 'npm test' } });
      await wait(200);
      await writeFile(join(input.cwd, 'SEEDS.md'), 'cluster seed discovery\nline two\n');
      return { status: 'completed', finalMessage: 'Added SEEDS.md and ran npm test: 12 passed.' };
    },
  };
  const s = createAgentService({ dataDir, provider, onEvent() {} });
  t.after(async () => { await s.dispose(); await rm(dataDir, { recursive: true, force: true }); });
  await s.invoke('paperclip.config.set', { mode: 'custom', baseUrl: origin, companyId: seed.companies.rag.id });
  return { s, seed, repo, bare, dataDir, prompts };
}

test('orgs: both companies are listed with the signed-in person, unticking one hides it, and the app no longer silently picks one', { skip }, async t => {
  const { s, seed } = await harness(t);
  const list = await s.invoke('orgs.list', {});
  assert.equal(list.connected, true);
  assert.equal(list.me?.id, seed.me, 'the person is the server user id from /cli-auth/me');
  assert.deepEqual(list.orgs.map(o => o.name).sort(), ['Hybrow', 'Ragnar']);
  assert.ok(list.orgs.every(o => o.enabled && o.sidebar === 'mine'), 'ticked, My work by default');
  assert.equal(list.orgs.find(o => o.name === 'Ragnar')!.projects, 2);
  const off = await s.invoke('orgs.set', { companyId: seed.companies.hyb.id, enabled: false });
  assert.equal(off.orgs.find(o => o.name === 'Hybrow')!.enabled, false);
  assert.deepEqual((await s.invoke('orgs.work', {})).orgs.map(o => o.org.name), ['Ragnar']);
  await s.invoke('orgs.set', { companyId: seed.companies.hyb.id, enabled: true });
});

test('my work: only the signed-in person’s active tasks per org, counts per project, and an Inbox that never lists other people’s tasks', { skip }, async t => {
  const { s, seed } = await harness(t);
  const work = await s.invoke('orgs.work', { refresh: true });
  const rag = work.orgs.find(o => o.org.name === 'Ragnar')!, hyb = work.orgs.find(o => o.org.name === 'Hybrow')!;
  assert.deepEqual(rag.tasks.map(x => x.key).sort(), ['RAG-1', 'RAG-2', 'RAG-3'], 'todo, in progress, in review: not done, backlog, Bob’s, or the agent’s');
  assert.equal(rag.open, 3);
  assert.deepEqual(hyb.tasks.map(x => x.key), ['HYB-1']);
  assert.deepEqual(rag.projects.find(p => p.name === 'Redis'), { id: seed.companies.rag.redis, name: 'Redis', open: 3 });
  assert.equal(rag.projects.find(p => p.name === 'PostgreSQL')!.open, 0);
  assert.ok(rag.tasks.every(x => x.why === 'mine'));
  const inbox = work.orgs.flatMap(o => o.inbox);
  assert.ok(inbox.every(i => i.org), 'every row carries its org chip');
  assert.ok(!inbox.some(i => /RAG-6|HYB-2/.test(i.title) || (/RAG-5/.test(i.title) && i.kind !== 'mention')), 'Bob’s tasks are never in the Inbox (only a mention of the person on one is)');
  assert.ok(inbox.some(i => i.kind === 'mention' && /RAG-5/.test(i.title)), 'an @mention of the person reaches the Inbox, on whoever’s task');
  assert.ok(inbox.some(i => i.kind === 'approval' && i.org?.name === 'Hybrow'), 'the other org’s approval is in the same list');
  // The workspace snapshot (Inbox page and badge) agrees: the active org scoped, the other org’s items added.
  const snap = await s.invoke('paperclip.snapshot', { refresh: true });
  assert.ok(!snap.inbox.some(i => /RAG-6/.test(i.title)), 'Bob’s in-review task is not in the Inbox');
  assert.ok(snap.inbox.some(i => i.org?.name === 'Hybrow'), 'Hybrow items arrive in the one Inbox');
  const tasks = snap.tasks.find(x => x.key === 'RAG-5');
  assert.equal(tasks?.assigneeLabel, 'Bob Rivera', 'a teammate’s task is named, never labelled You');
  assert.ok(snap.people?.some(p => p.me && p.id === seed.me) && snap.people?.some(p => p.name === 'Bob Rivera'), 'the org’s people, with you marked');
});

test('check out → the server shows the comment and assignee, no agent wakes, a worktree exists, auto-posts appear as the person, hand back wakes QA', { skip }, async t => {
  const { s, seed, repo, bare, prompts } = await harness(t);
  const task = seed.companies.rag.issues.r1!, rag = seed.companies.rag;
  const runsFor = async (issueId: string) => (await api(`/companies/${rag.id}/heartbeat-runs?limit=200`) as { agentId?: string; contextSnapshot?: { issueId?: string } }[]).filter(r => r.contextSnapshot?.issueId === issueId);
  assert.equal((await runsFor(task.id)).length, 0);

  // bind the local checkout once; the plan shows exactly what will be posted
  const bound = await s.invoke('checkout.bind', { orgId: rag.id, projectId: rag.redis, path: repo, devBranch: 'dev' });
  assert.equal(bound.devBranch, 'dev');
  const plan = await s.invoke('checkout.plan', { taskId: task.id });
  assert.equal(plan.assignedToMe, true);
  assert.match(plan.willPost.comment, /^Checked out · working locally on .+ · via Muster$/);
  assert.equal(plan.binding?.path, bound.path);
  assert.ok(plan.agents.some(a => a.name === 'Head Muster'));
  await assert.rejects(() => s.invoke('checkout.start', { taskId: task.id, model: { kind: 'own', providerId: 'scripted', model: 'scripted-model' }, confirm: false as never }), /confirm/i, 'nothing is posted before the person confirms');

  const lease = await s.invoke('checkout.start', { taskId: task.id, model: { kind: 'own', providerId: 'scripted', model: 'scripted-model' }, confirm: true });
  assert.equal(lease.state, 'checked_out'); assert.equal(lease.thisMac, true); assert.equal(lease.branch, 'muster/RAG-1');
  assert.ok(lease.worktree && existsSync(lease.worktree), 'the worktree exists');
  assert.equal(git(lease.worktree!, 'rev-parse', '--abbrev-ref', 'HEAD'), 'muster/RAG-1');
  assert.ok(existsSync(join(lease.worktree!, 'DEV.md')), 'the branch starts from the project’s dev branch');

  const issue = await api(`/issues/${task.id}`);
  assert.equal(issue.status, 'in_progress'); assert.equal(issue.assigneeUserId, seed.me); assert.equal(issue.assigneeAgentId, null);
  const comments = await api(`/issues/${task.id}/comments?order=asc&limit=50`) as { body: string; authorUserId: string | null; authorAgentId: string | null }[];
  const checkout = comments.find(c => /Checked out · working locally on/.test(c.body));
  assert.ok(checkout, 'the check-out comment is on the server'); assert.equal(checkout!.authorUserId, seed.me, 'posted as the person'); assert.equal(checkout!.authorAgentId, null);
  assert.match(checkout!.body, /<!-- muster:checkout device=".+" device-id=".+" by=".*" at=".+" -->/, 'the marker is the machine-readable state, in the plugin’s format');
  await wait(1500);
  assert.equal((await runsFor(task.id)).length, 0, 'no agent woke on the human-assigned task');
  assert.ok((await s.invoke('orgs.work', {})).orgs.find(o => o.org.name === 'Ragnar')!.tasks.find(x => x.key === 'RAG-1')?.checkout?.thisMac, 'My work shows “Checked out · this Mac”');

  // work locally: the chat is in the worktree, with the task as context
  const chats = await s.invoke('app.snapshot', undefined);
  const chat = chats.chats.find(c => c.id === lease.chatId)!;
  assert.equal(chat.providerId, 'scripted');
  await s.invoke('checkout.decision', { taskId: task.id, text: 'Use the sentinel seed list, not DNS discovery.' });
  await s.invoke('chat.send', { id: lease.chatId!, text: 'Implement seed discovery and run the tests.', requestId: 'r-1' });
  await until(() => prompts.length > 0, 'the scripted turn');
  assert.match(prompts[0]!, /RAG-1: External Valkey migration|server task RAG-1/, 'the local agent is told about the server task');
  await until(async () => (await s.invoke('checkout.get', { taskId: task.id })).lease && existsSync(join(lease.worktree!, 'SEEDS.md')), 'file written');
  // the receipt becomes one row of the rolling Local work log document, and a cost entry labelled personal
  await until(async () => { await s.invoke('checkout.sync', {}); return (await api(`/issues/${task.id}/documents`) as { key: string }[]).some(d => d.key === 'local-work-log'); }, 'the work log document', 20_000);
  const doc = await api(`/issues/${task.id}/documents/local-work-log`);
  assert.match(doc.body, /# Local work log · RAG-1/); assert.match(doc.body, /^## .+Z · /m);
  assert.match(doc.body, /- Files: \+2 -0 \(1 file\)/, 'files and lines of the turn'); assert.match(doc.body, /- Cost: \$[\d.]+ \(personal\)/);
  if (PG) {
    const costs = await until(async () => { await s.invoke('checkout.sync', {}); const rows = await sql('select biller, billing_type, issue_id, input_tokens from cost_events where issue_id = $1', [task.id]); return rows.length ? rows : null; }, 'a cost event');
    assert.equal(costs[0]!.biller, `personal:${seed.me}`, 'the Ledger separates personal from org by biller');
    assert.equal(costs[0]!.billing_type, 'metered_api');
  }
  const afterTurn = await api(`/issues/${task.id}/comments?order=asc&limit=100`) as { body: string }[];
  assert.equal(afterTurn.filter(c => /muster:report (tests|context)/.test(c.body)).length <= 1, true, 'no comment per turn');
  const decisionComment = afterTurn.find(c => /\*\*Decision\*\*/.test(c.body));
  assert.ok(decisionComment && /via Muster · local/.test(decisionComment.body), 'the decision is posted as the person, labelled via Muster · local');

  // hand back: tests ran, so it is allowed; push, PR link, summary, In review, reassign to the QA agent (which wakes)
  const preview = await s.invoke('checkout.handback.preview', { taskId: task.id });
  assert.equal(preview.testsRun, true); assert.equal(preview.blocked, null);
  assert.ok(preview.reviewers.some(r => r.name === 'QA Lead' && r.suggested), 'a QA agent is suggested');
  const done = await s.invoke('checkout.handback', { taskId: task.id, reviewer: { kind: 'agent', id: rag.qa }, prUrl: 'https://github.com/musterhq/example/pull/7', summary: 'Seed discovery now reads the Sentinel list.' });
  assert.equal(done.state, 'handed_back');
  const back = await api(`/issues/${task.id}`);
  assert.equal(back.status, 'in_review'); assert.equal(back.assigneeAgentId, rag.qa); assert.equal(back.assigneeUserId, null);
  const finalComments = await api(`/issues/${task.id}/comments?order=asc&limit=100`) as { body: string; authorUserId: string | null }[];
  const summary = finalComments.find(c => /Handed back for review/.test(c.body))!;
  assert.ok(summary && summary.authorUserId === seed.me); assert.match(summary.body, /pull\/7/); assert.match(summary.body, new RegExp(`agent://${rag.qa}`), 'the reviewer is @mentioned');
  assert.match(summary.body, /Use the sentinel seed list/, 'the decision is in the summary');
  assert.match(git(bare, 'branch', '--list', 'muster/RAG-1'), /muster\/RAG-1/, 'the branch was pushed');
  await until(async () => (await runsFor(task.id)).length > 0, 'the QA agent woke on hand-back', 40_000);
  assert.equal((await runsFor(task.id))[0]!.agentId, rag.qa, 'the run is the QA agent’s');
  assert.equal((await s.invoke('checkout.get', { taskId: task.id })).lease?.state, 'handed_back');
});

test('release puts the task back as it was with a note; Take it reassigns first; the escape hatch is explicit', { skip }, async t => {
  const { s, seed, repo } = await harness(t);
  const rag = seed.companies.rag, bob = rag.issues.r5!, mine = rag.issues.r2!;
  await s.invoke('checkout.bind', { orgId: rag.id, projectId: rag.redis, path: repo, devBranch: 'dev' });
  const model = { kind: 'own' as const, providerId: 'scripted', model: 'scripted-model' };
  // A teammate's task needs "Take it" on purpose
  await assert.rejects(() => s.invoke('checkout.start', { taskId: bob.id, model, confirm: true }), /Take it/);
  // release restores status and assignee
  const lease = await s.invoke('checkout.start', { taskId: mine.id, model, confirm: true });
  assert.equal((await api(`/issues/${mine.id}`)).status, 'in_progress');
  const released = await s.invoke('checkout.release', { taskId: mine.id, note: 'Blocked on the infra team.' });
  assert.equal(released.state, 'released');
  const issue = await api(`/issues/${mine.id}`);
  assert.equal(issue.assigneeUserId, seed.me); assert.equal(issue.status, 'in_progress', 'it was in progress before, so Release keeps it in progress');
  const comments = await api(`/issues/${mine.id}/comments?order=asc&limit=50`) as { body: string }[];
  assert.ok(comments.some(c => /Released from .* via Muster/.test(c.body) && /Blocked on the infra team/.test(c.body)));
  void lease;
});

test('people and tags: the org’s people are mentionable and assignable; a person’s chip is the format Paperclip’s own composer writes; assigning a person clears the agent', { skip }, async t => {
  const { s, seed } = await harness(t);
  const rag = seed.companies.rag, task = rag.issues.r7!;
  const detail = await s.invoke('paperclip.task', { id: task.id });
  assert.ok(detail.mentionable.some(m => m.kind === 'user' && m.name === 'Bob Rivera'), 'people are in the @ picker');
  assert.ok(detail.mentionable.some(m => m.kind === 'agent' && m.name === 'QA Lead'));
  await s.invoke('paperclip.comment', { taskId: task.id, body: 'Ping [@Bob Rivera](user://user-bob) about the failover.' });
  assert.ok((await api(`/issues/${task.id}/comments?order=asc&limit=20`) as { body: string }[]).some(c => c.body.includes('(user://user-bob)')));
  await s.invoke('paperclip.task.update', { taskId: task.id, assigneeId: 'user:user-bob' });
  let issue = await api(`/issues/${task.id}`);
  assert.deepEqual([issue.assigneeUserId, issue.assigneeAgentId], ['user-bob', null], 'a person takes it and the agent is cleared');
  await s.invoke('paperclip.task.update', { taskId: task.id, assigneeId: rag.qa });
  issue = await api(`/issues/${task.id}`);
  assert.deepEqual([issue.assigneeUserId, issue.assigneeAgentId], [null, rag.qa], 'an agent takes it and the person is cleared');
  const created = await s.invoke('paperclip.task.create', { title: 'Made for me', description: '', projectId: rag.redis, assigneeId: `user:${seed.me}` });
  assert.equal(created.assigneeUserId, seed.me);
});

test('offline: nothing leaves the Mac while it is switched on; the queue is re-checked and sent in order when it is switched off, and a hand-back tag is delivered then', { skip }, async t => {
  const { s, seed, repo } = await harness(t);
  const rag = seed.companies.rag, task = rag.issues.r2!;
  await s.invoke('checkout.bind', { orgId: rag.id, projectId: rag.redis, path: repo, devBranch: 'dev' });
  const lease = await s.invoke('checkout.start', { taskId: task.id, model: { kind: 'org-agent', agentId: rag.ceo }, confirm: true });
  const org = (await s.invoke('checkout.org', { taskId: task.id })).copy!;
  assert.deepEqual(org.agents.map(a => a.name).sort(), ['Head Muster', 'QA Lead']); assert.ok(org.agents.find(a => a.name === 'Head Muster')!.instructions.length > 50, 'the CEO’s AGENTS.md was copied');
  const keys = (v: unknown): string[] => v && typeof v === 'object' ? Object.entries(v as object).flatMap(([k, x]) => [k, ...keys(x)]) : [];
  assert.deepEqual(keys(org).filter(k => /^(env|adapterConfig|token|secret|apiKey|password|credentials?)$/i.test(k)), [], 'definitions only: no env, no adapter config, no keys');
  const comments = async () => (await api(`/issues/${task.id}/comments?order=asc&limit=100`) as { body: string }[]).map(c => c.body);
  const before = (await comments()).length;
  await s.invoke('checkout.offline', { taskId: task.id, on: true });
  await s.invoke('checkout.decision', { taskId: task.id, text: 'Offline decision: keep the seed list.' });
  await s.invoke('chat.send', { id: lease.chatId!, text: 'Do the work and run the tests.', requestId: 'r-off' });
  await until(async () => (await s.invoke('checkout.pending', { taskId: task.id })).rows.some(r => r.kind === 'cost'), 'the turn was queued', 20_000);
  const done = await s.invoke('checkout.handback', { taskId: task.id, reviewer: { kind: 'agent', id: rag.qa }, prUrl: 'https://github.com/musterhq/example/pull/8' });
  assert.equal(done.state, 'handed_back'); assert.equal(done.offline, 'manual');
  assert.equal((await comments()).length, before, 'not one comment reached the server while offline');
  assert.equal((await api(`/issues/${task.id}`)).status, 'in_progress', 'and the task was untouched');
  assert.ok((await s.invoke('checkout.pending', { taskId: task.id })).rows.length >= 4);
  await s.invoke('checkout.offline', { taskId: task.id, on: false });
  const after = await comments();
  assert.ok(after.some(b => /Offline decision/.test(b))); const summary = after.find(b => /Handed back for review/.test(b))!;
  assert.match(summary, new RegExp(`agent://${rag.qa}`), 'the hand-back tag was delivered after reconnect');
  assert.ok(after.findIndex(b => /Offline decision/.test(b)) < after.findIndex(b => /Handed back for review/.test(b)), 'in order');
  const issue = await api(`/issues/${task.id}`); assert.deepEqual([issue.status, issue.assigneeAgentId], ['in_review', rag.qa]);
  assert.equal((await s.invoke('checkout.pending', { taskId: task.id })).rows.length, 0);
  await s.invoke('checkout.sync', {});
  assert.equal((await comments()).filter(b => /Handed back for review/.test(b)).length, 1, 'a second sync sends nothing again');
});
