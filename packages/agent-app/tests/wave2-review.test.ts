/** Review of PR #250: regression tests, one per fixed item. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wave2, until, wait } from './wave2-harness.ts';
import { automationTiming } from '../src/runtime/domains/automations.ts';
import { AUTOMATION_TEMPLATES } from '../src/shared/automation-templates.ts';

const ext = { variables: [], approval: false, activityGate: false, webhook: false };

test('M1: a standup that is still waiting on its agents is not failed by the scheduler tick', async t => {
  const was = { tick: automationTiming.tickMs, first: automationTiming.firstTickMs };
  automationTiming.tickMs = 250; automationTiming.firstTickMs = 100;
  t.after(() => { automationTiming.tickMs = was.tick; automationTiming.firstTickMs = was.first; });
  const h = await wave2(t);
  await h.member('CTO');
  await wait(400); // ticks with no automations at all, as for a user who has none yet
  h.sayWhen(/Standup for/, 'Yesterday: shipped. Blockers: none.', { delayMs: 1800 });
  const su = AUTOMATION_TEMPLATES[0]!;
  const a = await h.s.invoke('automations.create', { name: su.name, prompt: su.prompt, schedule: su.schedule, timezone: 'UTC', permissionMode: 'workspace', overlap: 'skip', catchUp: 'none', target: { ...su.target, projectId: h.project.id }, ext });
  const run = await h.s.invoke('automations.runNow', { id: a.id });
  const done = await until(async () => (await h.s.invoke('automations.runs', { id: a.id })).find(r => r.id === run.id && ['completed', 'failed'].includes(r.status)), 'the standup to end', 30_000);
  assert.equal(done.status, 'completed', done.reason ?? '');
  assert.match(done.reason ?? '', /Digest ready/);
});

test('M2: a task or standup automation set to Read only never starts a run with more access', async t => {
  const h = await wave2(t);
  const cto = await h.member('CTO');
  h.sayWhen(/Look at the build/, 'Looked.'); h.sayWhen(/Standup for/, 'Fine.');
  const base = { schedule: { kind: 'interval' as const, minutes: 60 }, timezone: 'UTC', permissionMode: 'read-only' as const, overlap: 'skip' as const, catchUp: 'none' as const, ext };
  const task = await h.s.invoke('automations.create', { ...base, name: 'Build look', prompt: 'Look at the build.', target: { kind: 'task', projectId: h.project.id, assigneeId: `member:${cto.id}`, start: true, mode: 'task' } });
  const r1 = await h.s.invoke('automations.runNow', { id: task.id });
  await until(async () => (await h.s.invoke('automations.runs', { id: task.id })).find(r => r.id === r1.id && r.status === 'completed'), 'the task run');
  const su = AUTOMATION_TEMPLATES[0]!;
  const stand = await h.s.invoke('automations.create', { ...base, name: 'Standup', prompt: su.prompt, target: { ...su.target, projectId: h.project.id } });
  const r2 = await h.s.invoke('automations.runNow', { id: stand.id });
  await until(async () => (await h.s.invoke('automations.runs', { id: stand.id })).find(r => r.id === r2.id && r.status === 'completed'), 'the standup', 30_000);
  const modes = h.calls.filter(c => /Look at the build|Standup for/.test(c.prompt)).map(c => c.permission);
  assert.ok(modes.length >= 2);
  assert.deepEqual([...new Set(modes)], ['read-only']);
});

test('S1: the same message id voted in two projects makes two votes; one project cannot overwrite the other', async t => {
  const h = await wave2(t);
  const other = await h.s.invoke('project.create', { name: 'Other', goal: '', folderIds: [h.folder.id] });
  await h.s.invoke('work.votes.set', { projectId: h.project.id, subject: 'message', subjectId: 'shared-id', vote: 'helpful', reason: 'mine', excerpt: 'A' });
  await h.s.invoke('work.votes.set', { projectId: other.id, subject: 'message', subjectId: 'shared-id', vote: 'needs_work', reason: 'theirs', excerpt: 'B' });
  const mine = (await h.s.invoke('work.votes.list', { projectId: h.project.id })).votes, theirs = (await h.s.invoke('work.votes.list', { projectId: other.id })).votes;
  assert.deepEqual([mine.length, mine[0]!.vote, mine[0]!.reason], [1, 'helpful', 'mine']);
  assert.deepEqual([theirs.length, theirs[0]!.vote], [1, 'needs_work']);
  await h.s.invoke('work.votes.set', { projectId: other.id, subject: 'message', subjectId: 'shared-id', vote: null });
  assert.equal((await h.s.invoke('work.votes.list', { projectId: h.project.id })).votes.length, 1);
});

test('S2: saving a card with the id of another project\'s card is refused and returns nothing of it', async t => {
  const h = await wave2(t);
  const other = await h.s.invoke('project.create', { name: 'Other', goal: '', folderIds: [h.folder.id] });
  const card = await h.s.invoke('work.summaries.save', { projectId: other.id, title: 'Secret card', query: 'status:todo', refresh: 'manual', tokenCap: 300 });
  await assert.rejects(h.s.invoke('work.summaries.save', { projectId: h.project.id, id: card.id, title: 'x', query: '', refresh: 'manual', tokenCap: 300 }), /no longer exists/);
});

test('S3: removing a label id from another project strips nothing from that project\'s tasks', async t => {
  const h = await wave2(t);
  const other = await h.s.invoke('project.create', { name: 'Other', goal: '', folderIds: [h.folder.id] });
  const label = await h.s.invoke('work.labels.save', { projectId: other.id, name: 'theirs', color: 'ok' });
  const otherTask = await h.s.invoke('project.tasks.add', { projectId: other.id, title: 'T', acceptance: '', dependencies: [], owner: { kind: 'user', id: 'local' } });
  await h.s.invoke('work.task.labels.set', { projectId: other.id, taskId: otherTask.id, labelIds: [label.id] });
  await h.s.invoke('work.labels.remove', { projectId: h.project.id, id: label.id });
  assert.equal((await h.s.invoke('work.labels.list', { projectId: other.id })).labels[0]!.tasks, 1);
});

test('S4 (runtime): starring an agent through a project it is not on is refused', async t => {
  const h = await wave2(t);
  const cto = await h.member('CTO');
  const other = await h.s.invoke('project.create', { name: 'Other', goal: '', folderIds: [h.folder.id] });
  await assert.rejects(h.s.invoke('work.star.set', { kind: 'agent', id: `member:${cto.id}`, projectId: other.id, starred: true }), /not on this project/);
  assert.deepEqual(await h.s.invoke('work.star.set', { kind: 'agent', id: `member:${cto.id}`, projectId: h.project.id, starred: true }), { starred: true, hidden: false });
});

test('S5: a recommendation left working by a quit is failed when the store opens, so it can be asked again', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { WorkStore } = await import('../src/runtime/work/store.ts');
  const dir = await mkdtemp(join(tmpdir(), 'muster-s5-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const first = new WorkStore(dir);
  first.setRecommendation('ws:task:1', { state: 'working', agent: 'CTO', text: '', chatId: 'c1', at: new Date().toISOString() });
  first.setRecommendation('ws:task:2', { state: 'ready', agent: 'CTO', text: 'Pick A.', chatId: 'c2', at: new Date().toISOString() });
  first.close();
  const second = new WorkStore(dir);
  assert.equal(second.failStuckRecommendations(), 1);
  assert.equal(second.inboxItem('ws:task:1')!.recommendation!.state, 'failed');
  assert.match(second.inboxItem('ws:task:1')!.recommendation!.text, /Muster closed/);
  assert.equal(second.inboxItem('ws:task:2')!.recommendation!.state, 'ready');
  second.close();
});

const memorySecrets = () => { const m = new Map<string, string>(); return { secureStorage: () => true, set: (id: string, v: unknown) => { m.set(id, String(v)); }, get: (id: string) => m.get(id), clear: (id: string) => { m.delete(id); } }; };
async function hookSetup(t: Parameters<typeof wave2>[0]) {
  automationTiming.webhookPort = 0; const store = memorySecrets(); automationTiming.secrets = () => store;
  const { signWebhook } = await import('../src/runtime/automations/webhook.ts');
  const h = await wave2(t);
  const a = await h.s.invoke('automations.create', { name: 'Hook', prompt: 'Report.', timezone: 'UTC', schedule: { kind: 'interval', minutes: 60 }, permissionMode: 'workspace', overlap: 'queue', catchUp: 'none', target: { kind: 'task', projectId: h.project.id, start: false, mode: 'task' }, ext: { ...ext, webhook: true } });
  const hook = await h.s.invoke('automations.webhook.rotate', { id: a.id });
  const call = (url: string, body: string, ts: number, sig = signWebhook(hook.secret, ts, body)) => fetch(url, { method: 'POST', headers: { 'x-muster-timestamp': String(ts), 'x-muster-signature': sig }, body }).then(async r => ({ status: r.status, body: await r.json() as Record<string, unknown> }));
  return { h, a, hook, call };
}

test('S6: a signed request cannot be replayed after the listener stops and starts again', async t => {
  const { h, a, hook, call } = await hookSetup(t);
  const ts = Math.floor(Date.now() / 1000), body = '{}';
  assert.equal((await call(hook.url!, body, ts)).status, 202);
  await h.s.invoke('automations.pause', { id: a.id }); await h.s.invoke('automations.resume', { id: a.id });
  const url = await until(async () => { const u = (await h.s.invoke('automations.list', undefined))[0]!.webhook?.url; if (!u) return null; try { return (await fetch(u)).status === 405 ? u : null; } catch { return null; } }, 'the listener to be back');
  assert.equal((await call(url, body, ts)).status, 409);
});

test('S7: a wrong timestamp, a wrong signature and an unknown id all answer the same', async t => {
  const { a, hook, call } = await hookSetup(t);
  const ts = Math.floor(Date.now() / 1000), body = '{}';
  const stale = await call(hook.url!, body, ts - 3600), bad = await call(hook.url!, body, ts, 'sha256=00'), unknown = await call(hook.url!.replace(a.id, 'nope'), body, ts);
  assert.deepEqual([stale.status, bad.status, unknown.status], [401, 401, 401]);
  assert.deepEqual(stale.body, bad.body); assert.deepEqual(bad.body, unknown.body);
});

test('S8: pruning run history removes the rows that hang off a run and never a run that is waiting or running', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { pruneRuns } = await import('../src/runtime/automations/prune.ts');
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE automation_runs (id TEXT PRIMARY KEY, automation_id TEXT, scheduled_for INTEGER, status TEXT);
    CREATE TABLE automation_run_ext (run_id TEXT PRIMARY KEY); CREATE TABLE automation_gates (id TEXT PRIMARY KEY, run_id TEXT); CREATE TABLE standup_children (child_id TEXT PRIMARY KEY, run_id TEXT)`);
  const add = (id: string, at: number, status: string) => { db.prepare('INSERT INTO automation_runs VALUES (?,?,?,?)').run(id, 'a', at, status); db.prepare('INSERT INTO automation_run_ext VALUES (?)').run(id); db.prepare('INSERT INTO automation_gates VALUES (?,?)').run(`g-${id}`, id); db.prepare('INSERT INTO standup_children VALUES (?,?)').run(`k-${id}`, id); };
  add('old-awaiting', 1, 'awaiting'); add('old-running', 2, 'running'); add('old-done', 3, 'completed');
  for (let i = 10; i < 20; i++) add(`skipped-${i}`, i, 'skipped');
  assert.equal(pruneRuns(db, 'a', 5), 6, 'the old finished run and the older skipped ones go');
  const left = (db.prepare('SELECT id FROM automation_runs ORDER BY scheduled_for').all() as { id: string }[]).map(r => r.id);
  assert.deepEqual(left.slice(0, 2), ['old-awaiting', 'old-running']); assert.ok(!left.includes('old-done')); assert.equal(left.length, 7);
  for (const table of [['automation_run_ext', 'run_id'], ['automation_gates', 'run_id'], ['standup_children', 'run_id']]) assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table[0]} WHERE ${table[1]} NOT IN (SELECT id FROM automation_runs)`).get() as { n: number }).n, 0, `${table[0]} keeps no orphans`);
});

test('F1: dot segments are not an owner or repository in a pull request link', async t => {
  const { findPullRequests } = await import('../src/shared/domains/work-protocol.ts');
  assert.deepEqual(findPullRequests('https://github.com/../user/pull/1 https://github.com/acme/../pull/2 https://github.com/./x/pull/3 https://github.com/acme/ok/pull/4').map(p => p.repo), ['acme/ok']);
  const h = await wave2(t);
  const task = await h.addTask('T', { kind: 'user', id: 'local' });
  await assert.rejects(h.s.invoke('work.links.add', { projectId: h.project.id, taskId: task.id, url: 'https://github.com/../user/pull/1' }), /Paste a GitHub pull request link/);
});

test('F2: a task holds at most 20 MB of documents, and says so', async t => {
  const h = await wave2(t);
  const task = await h.addTask('Docs', { kind: 'user', id: 'local' });
  let refused = '';
  for (let k = 0; k < 11 && !refused; k++) for (let rev = 0; rev < 10 && !refused; rev++) {
    try { await h.s.invoke('work.docs.save', { projectId: h.project.id, taskId: task.id, key: `doc-${k}`, text: `${rev}`.repeat(1) + 'x'.repeat(199_000 + rev) }); } catch (e) { refused = (e as Error).message; }
  }
  assert.match(refused, /20 MB of documents/);
});

test('F3: old resolved comment threads and Inbox state for deleted items are pruned', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { WorkStore } = await import('../src/runtime/work/store.ts');
  const dir = await mkdtemp(join(tmpdir(), 'muster-f3-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const w = new WorkStore(dir); const day = 86_400_000; let now = Date.parse('2026-01-01T00:00:00Z'); w.clock = () => now;
  w.saveDoc('p', 't1', 'plan', 'hello world', '', 'You');
  const old = w.addThread('t1', 'plan', 1, 'hello', 0, 5, 'You', 'user', 'old one'); w.setThreadStatus(old, 'resolved');
  const open = w.addThread('t1', 'plan', 1, 'world', 6, 11, 'You', 'user', 'still open');
  w.markRead([{ id: 'ws:task:t1', at: 'x' }, { id: 'ws:task:kept', at: 'x' }]); w.setDecideBy('ws:task:decided', '2026-12-01');
  now += 120 * day;
  assert.ok(w.prune() >= 2);
  assert.equal(w.thread(old), undefined); assert.ok(w.thread(open), 'an open thread stays');
  assert.equal(w.inboxItem('ws:task:kept'), undefined, 'old read state is dropped'); assert.ok(w.inboxItem('ws:task:decided'), 'a decide-by date stays');
  w.markRead([{ id: 'ws:task:t1', at: 'y' }]); w.forgetTask('t1');
  assert.equal(w.inboxItem('ws:task:t1'), undefined, 'a deleted task takes its Inbox state with it');
  w.close();
});

test('F4: a chat is matched to its task once, and a project without goal links reads nothing at all', async t => {
  const { workStats } = await import('../src/runtime/domains/work.ts');
  const h = await wave2(t);
  const cto = await h.member('CTO');
  const plain = await h.addTask('Plain', { kind: 'agent', id: cto.id });
  workStats.projectWorkReads = 0;
  await h.start(plain.id); await h.settled(plain.id);
  assert.equal(workStats.projectWorkReads, 0, 'no goal links in the project: no lookup');
  const goal = await h.s.invoke('work.goals.save', { projectId: h.project.id, level: 'project', title: 'G' });
  const linked = await h.addTask('Linked', { kind: 'agent', id: cto.id });
  await h.s.invoke('work.goals.link', { projectId: h.project.id, kind: 'task', refId: linked.id, goalId: goal.id });
  await h.start(linked.id); await h.settled(linked.id);
  const after = workStats.projectWorkReads;
  assert.ok(after >= 1 && after <= 2, `one lookup for the chat, got ${after}`);
  await h.s.invoke('paperclip.comment', { taskId: linked.id, body: 'again please' });
  await h.s.invoke('project.agent.wake', { projectId: h.project.id, memberId: cto.id, taskId: linked.id }).catch(() => undefined);
  await h.wait(300);
  assert.ok(workStats.projectWorkReads <= after + 1);
});
