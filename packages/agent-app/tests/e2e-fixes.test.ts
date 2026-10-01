/** Fixes from the 0.2.10 Paperclip-parity E2E pass, through the real agent service: fresh data dir, real SQLite, real git
 *  repos and worktrees, and a scripted provider whose turns edit a file, ask a question (E2E-ASK), ask for an approval
 *  (E2E-APPROVE), fail (E2E-FAIL) or run until stopped (E2E-SLOW). */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createAgentService } from '../src/runtime/service.ts';
import type { ProviderAdapter, ProviderInput } from '../src/runtime/provider.ts';
import { SqliteImportStore } from '../src/runtime/paperclip-import.ts';
import { DatabaseSync } from 'node:sqlite';

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | undefined | null | false> | T | undefined | null | false, label: string, ms = 10_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v as T; await wait(40); }
  throw new Error(`timed out waiting for ${label}`);
}

async function service(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-e2e-fixes-'));
  const repo = join(dataDir, 'oss-repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]); execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t']); execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
  await writeFile(join(repo, 'README.md'), '# oss\n'); execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, 'commit', '-qm', 'init']);
  const answers: unknown[] = [], stopped = new Set<string>();
  const slow = new Map<string, () => void>();
  const provider: ProviderAdapter = {
    info: () => [{ id: 'scripted', name: 'Scripted', available: true, identityMasked: 'configured', models: [{ id: 'scripted-model', name: 'Scripted model' }] }],
    stop: async chatId => { stopped.add(chatId); slow.get(chatId)?.(); return true; }, dispose() {},
    async run(input: ProviderInput) {
      const text = `${input.developerInstructions ?? ''}\n${input.prompt}`;
      if (/E2E-SLOW/.test(text)) {
        await new Promise<void>(r => { const timer = setTimeout(r, 20_000); slow.set(input.chat.id, () => { clearTimeout(timer); r(); }); });
        slow.delete(input.chat.id);
        return stopped.has(input.chat.id) ? { status: 'failed', finalMessage: '', errorMessage: 'stopped', failure: { kind: 'aborted' }, dispatchState: 'dispatched' } : { status: 'completed', finalMessage: 'slow done', dispatchState: 'dispatched' };
      }
      if (/E2E-FAIL/.test(text)) return { status: 'failed', finalMessage: '', errorMessage: 'rate_limited: scripted failure', dispatchState: 'dispatched' };
      if (/E2E-ASK/.test(text)) {
        const answer = await input.onRequest('item/tool/requestUserInput', { itemId: `q-${input.chat.id}`, questions: [{ id: 'color', header: 'Colour', question: 'Which colour should the banner be?', options: [{ label: 'Blue' }, { label: 'Green' }] }] });
        answers.push(answer);
        return { status: 'completed', finalMessage: `Answered: ${JSON.stringify(answer)}` };
      }
      if (/E2E-APPROVE/.test(text)) {
        const decision = await input.onRequest('item/commandExecution/requestApproval', { itemId: `a-${input.chat.id}`, command: 'rm -rf build', cwd: input.cwd, reason: 'Clean the build folder' });
        answers.push(decision);
        return { status: 'completed', finalMessage: `Decision: ${JSON.stringify(decision)}` };
      }
      await writeFile(join(input.cwd, 'E2E-NOTE.md'), 'edited\n');
      return { status: 'completed', finalMessage: 'Wrote E2E-NOTE.md' };
    },
  };
  const s = createAgentService({ dataDir, provider, onEvent() {} });
  t.after(async () => { for (const r of slow.values()) r(); await s.dispose(); await rm(dataDir, { recursive: true, force: true }); });
  const folder = await s.invoke('folder.add', { path: repo });
  const project = await s.invoke('project.create', { name: 'OSSMANAGER', goal: '', folderIds: [folder.id] });
  const member = (name: string) => s.invoke('project.members.add', { projectId: project.id, name, kind: 'agent', role: 'agent', title: name, runner: { providerId: 'scripted', model: 'scripted-model' } });
  const state = async (taskId: string) => (await s.invoke('project.work', { projectId: project.id })).tasks.items.find(i => i.id === taskId)?.state;
  return { s, repo, folder, project, member, state, answers, stopped, dataDir };
}

test('S14 Needs you on a Muster task: the card shows the run’s real question and answering it there resumes that run', async t => {
  const { s, project, member, state, answers } = await service(t);
  const qa = await member('QA');
  const task = await s.invoke('paperclip.task.create', { title: 'Pick a banner colour', description: 'E2E-ASK', projectId: project.id, assigneeId: `member:${qa.id}`, start: true });
  assert.ok(task.started, task.startError ?? "not started");
  await until(async () => await state(task.id) === 'needs-input', 'needs-input');
  const detail = await s.invoke('paperclip.task', { id: task.id });
  const card = detail.cards.find(c => c.kind === 'needs');
  assert.ok(card && card.kind === 'needs');
  assert.equal(card.prompt, 'Which colour should the banner be?', 'the actual question, not a generic line');
  assert.equal(card.chatId, task.started!.chatId);
  assert.equal(card.pending?.kind, 'question');
  await s.invoke('question.respond', { id: card.pending!.id, answers: { color: { answers: ['Blue'] } } });
  await until(() => answers.length > 0, 'the run got the answer');
  assert.deepEqual(answers[0], { answers: { color: { answers: ['Blue'] } } });
  await until(async () => await state(task.id) !== 'needs-input' && await state(task.id) !== 'running', 'the run settled');
  const after = await s.invoke('paperclip.task', { id: task.id });
  assert.ok(!after.cards.some(c => c.kind === 'needs' && c.status === 'pending'), 'nothing left waiting');
});

test('S14 an approval a Muster run is waiting on is answered from the task card through approval.respond', async t => {
  const { s, project, member, state, answers } = await service(t);
  const qa = await member('QA');
  const task = await s.invoke('paperclip.task.create', { title: 'Clean the build', description: 'E2E-APPROVE', projectId: project.id, assigneeId: `member:${qa.id}`, start: true });
  assert.ok(task.started, task.startError ?? "not started");
  const card = await until(async () => (await s.invoke('paperclip.task', { id: task.id })).cards.find(c => c.kind === 'needs' && c.pending?.kind === 'approval'), 'approval card');
  assert.ok(card.kind === 'needs' && card.pending);
  await s.invoke('approval.respond', { id: card.pending.id, approved: true, decision: 'accept' });
  await until(() => answers.length > 0, 'the run got the decision');
  assert.deepEqual(answers[0], { decision: 'accept' });
  await until(async () => await state(task.id) !== 'running', 'the run settled');
});

test('S27 Pause all stops running work and refuses Assign & start and Start while paused; Resume all lifts it', async t => {
  const { s, project, member, state, stopped } = await service(t);
  const cto = await member('CTO');
  const slow = await s.invoke('paperclip.task.create', { title: 'Long job', description: 'E2E-SLOW', projectId: project.id, assigneeId: `member:${cto.id}`, start: true });
  assert.ok(slow.started, slow.startError ?? 'not started');
  await until(async () => (await s.invoke('paperclip.snapshot', {})).runs.find(r => r.taskId === slow.id && r.status === 'running'), 'running');
  assert.deepEqual(await s.invoke('paperclip.pauseAll', { source: 'local' }), { changed: 1 });
  assert.ok(stopped.has(slow.started!.chatId), 'the running attempt was stopped');
  await until(async () => (await s.invoke('paperclip.snapshot', {})).runs.find(r => r.taskId === slow.id)?.status !== 'running', 'the run ended');
  const created = await s.invoke('paperclip.task.create', { title: 'While paused', description: '', projectId: project.id, assigneeId: `member:${cto.id}`, start: true });
  assert.equal(created.started, undefined, 'Assign & start creates the task but starts nothing');
  assert.match(created.startError ?? '', /OSSMANAGER is paused, so nothing new starts/);
  await assert.rejects(() => s.invoke('paperclip.task.start', { taskId: created.id }), /is paused/);
  assert.equal(await state(created.id), 'todo');
  assert.deepEqual(await s.invoke('paperclip.resumeAll', { source: 'local' }), { changed: 1 });
  const started = await s.invoke('paperclip.task.start', { taskId: created.id });
  assert.equal(started.branch, `muster/${created.key.toLowerCase()}`);
});

test('S10 Resume all wakes only the projects Pause all paused', async t => {
  const { s, project, folder } = await service(t);
  const other = await s.invoke('project.create', { name: 'Side project', goal: '', folderIds: [folder.id] });
  // Side project was paused on purpose before Pause all.
  await s.invoke('project.scheduler.set', { projectId: other.id, paused: true });
  assert.deepEqual(await s.invoke('paperclip.pauseAll', { source: 'local' }), { changed: 1 });
  assert.deepEqual(await s.invoke('paperclip.resumeAll', { source: 'local' }), { changed: 1 });
  assert.equal((await s.invoke('project.work', { projectId: project.id })).scheduler.paused, false);
  assert.equal((await s.invoke('project.work', { projectId: other.id })).scheduler.paused, true, 'the deliberately paused project stays paused');
});

test('S15 a Muster parent task shows a Delegated card per subtask', async t => {
  const { s, project, member } = await service(t);
  const cto = await member('CTO'), qa = await member('QA');
  const parent = await s.invoke('paperclip.task.create', { title: 'Migration wizard', description: '', projectId: project.id, assigneeId: `member:${cto.id}` });
  const a = await s.invoke('paperclip.task.create', { title: 'Write the tests', description: '', projectId: project.id, assigneeId: `member:${qa.id}`, parentId: parent.id });
  const b = await s.invoke('paperclip.task.create', { title: 'Design the steps', description: '', projectId: project.id, assigneeId: 'user:local', parentId: parent.id });
  const detail = await s.invoke('paperclip.task', { id: parent.id });
  const cards = detail.cards.filter(c => c.kind === 'delegated');
  assert.deepEqual(cards.map(c => c.kind === 'delegated' ? `${c.from}>${c.to}:${c.key}:${c.taskId}` : '').sort(), [`CTO>QA:${a.key}:${a.id}`, `CTO>You:${b.key}:${b.id}`].sort());
  assert.deepEqual((await s.invoke('paperclip.task', { id: a.id })).cards.filter(c => c.kind === 'delegated'), [], 'a leaf task delegates nothing');
});

test('S20 the task thread shows each run’s final answer, with that run’s Receipt under it', async t => {
  const { s, project, member, state } = await service(t);
  const cto = await member('CTO');
  const task = await s.invoke('paperclip.task.create', { title: 'Write a note', description: 'Write the note', projectId: project.id, assigneeId: `member:${cto.id}`, start: true });
  assert.ok(task.started, task.startError ?? 'not started');
  await until(async () => await state(task.id) !== 'running' && (await s.invoke('paperclip.task', { id: task.id })).receipts.length > 0, 'the run settled with a receipt');
  const detail = await s.invoke('paperclip.task', { id: task.id });
  const turn = detail.comments.find(c => c.body === 'Wrote E2E-NOTE.md');
  assert.ok(turn, 'the agent’s answer is in the thread');
  assert.equal(turn.author.kind, 'agent'); assert.equal(turn.author.label, 'CTO');
  assert.equal(turn.runId, detail.receipts[0].runId, 'the Receipt sits under that message');
});

test('S17 an approval imported with a task is an Approval card in its thread, with its status; a pending one is also Needs you', async t => {
  const { s, project, dataDir } = await service(t);
  const task = await s.invoke('paperclip.task.create', { title: 'Ship it', description: '', projectId: project.id, assigneeId: 'user:local' });
  await s.invoke('paperclip.snapshot', {});
  const db = new DatabaseSync(join(dataDir, 'muster-agent.sqlite'));
  try {
    const store = new SqliteImportStore(db);
    store.putHistory({ sourceId: 'approval:ap-1', kind: 'approval', taskId: task.id, projectId: project.id, title: 'Ship the migration to production', status: 'pending', detail: '', at: new Date().toISOString(), pending: true });
    store.putHistory({ sourceId: 'approval:ap-2', kind: 'approval', taskId: task.id, projectId: project.id, title: 'Rotate the API keys', status: 'approved', detail: '', at: new Date().toISOString(), pending: false });
  } finally { db.close(); }
  const detail = await s.invoke('paperclip.task', { id: task.id });
  assert.deepEqual(detail.cards.filter(c => c.kind === 'approval').map(c => c.kind === 'approval' ? `${c.title}:${c.status}` : ''), ['Ship the migration to production:pending', 'Rotate the API keys:approved']);
  const inbox = (await s.invoke('paperclip.snapshot', {})).inbox.filter(i => i.taskId === task.id && i.kind === 'approval');
  assert.equal(inbox.length, 1, 'only the pending approval needs you');
});

test('S19 a task run’s Receipt is attributed to the task and its Roster owner, not the chat title', async t => {
  const { s, project, member, state } = await service(t);
  const cto = await member('CTO');
  const task = await s.invoke('paperclip.task.create', { title: 'Create HELLO.md', description: 'Write it', projectId: project.id, assigneeId: `member:${cto.id}`, start: true });
  assert.ok(task.started, task.startError ?? 'not started');
  await until(async () => await state(task.id) !== 'running' && (await s.invoke('paperclip.ledger', {})).entries.some(e => e.chatId === task.started!.chatId), 'receipt');
  const entry = (await s.invoke('paperclip.ledger', {})).entries.find(e => e.chatId === task.started!.chatId)!;
  assert.equal(entry.agent, 'CTO'); assert.equal(entry.taskId, task.id); assert.equal(entry.trigger, 'task');
  assert.equal((await s.invoke('paperclip.ledger', {})).chain.ok, true, 'the chain still verifies');
});

test('S29 pausing one agent holds only that agent: its run stops, Start and the scheduler skip it, others keep working', async t => {
  const { s, project, member, stopped } = await service(t);
  const cto = await member('CTO'), qa = await member('QA');
  const slow = await s.invoke('paperclip.task.create', { title: 'Long QA job', description: 'E2E-SLOW', projectId: project.id, assigneeId: `member:${qa.id}`, start: true });
  assert.ok(slow.started, slow.startError ?? 'not started');
  await until(async () => (await s.invoke('paperclip.snapshot', {})).runs.find(r => r.taskId === slow.id && r.status === 'running'), 'running');
  await s.invoke('paperclip.agent.pause', { id: `member:${qa.id}` });
  assert.ok(stopped.has(slow.started!.chatId), 'QA’s running work stopped');
  const snap = await s.invoke('paperclip.snapshot', {});
  assert.deepEqual(snap.agents.filter(a => a.projectId === project.id).map(a => `${a.name}:${a.status}`).sort(), ['CTO:idle', 'QA:paused'], 'only QA is paused');
  assert.equal((await s.invoke('project.work', { projectId: project.id })).scheduler.paused, false, 'the project is not paused');
  const qaTask = await s.invoke('paperclip.task.create', { title: 'QA later', description: '', projectId: project.id, assigneeId: `member:${qa.id}`, start: true });
  assert.match(qaTask.startError ?? '', /QA is paused/);
  const ctoTask = await s.invoke('paperclip.task.create', { title: 'CTO now', description: '', projectId: project.id, assigneeId: `member:${cto.id}`, start: true });
  assert.ok(ctoTask.started, 'CTO still starts');
  // The scheduler skips the held member's ready work.
  await s.invoke('project.scheduler.set', { projectId: project.id, autoDispatch: true });
  await wait(500);
  const work = await s.invoke('project.work', { projectId: project.id });
  assert.equal(work.tasks.items.find(i => i.id === qaTask.id)?.state, 'todo', 'the scheduler left the held agent’s ready task alone');
  await s.invoke('paperclip.agent.resume', { id: `member:${qa.id}` });
  assert.equal((await s.invoke('paperclip.snapshot', {})).agents.find(a => a.name === 'QA')!.status === 'paused', false);
  await until(async () => (await s.invoke('project.work', { projectId: project.id })).tasks.items.find(i => i.id === qaTask.id)?.state !== 'todo', 'the scheduler picks QA’s task up once resumed');
  await s.invoke('project.scheduler.set', { projectId: project.id, autoDispatch: false });
  await until(async () => !(await s.invoke('paperclip.snapshot', {})).runs.some(r => r.status === 'running'), 'every run settled');
  await wait(300);
});

test('S36 a failed run keeps the provider’s own error, so the Inbox can say it plainly', async t => {
  const { s, project, member, state } = await service(t);
  const cto = await member('CTO');
  const task = await s.invoke('paperclip.task.create', { title: 'Flaky job', description: 'E2E-FAIL', projectId: project.id, assigneeId: `member:${cto.id}`, start: true });
  assert.ok(task.started, task.startError ?? 'not started');
  await until(async () => await state(task.id) === 'failed', 'failed');
  const snap = await s.invoke('paperclip.snapshot', {});
  const item = snap.inbox.find(i => i.taskId === task.id)!;
  assert.equal(item.kind, 'failed_run');
  assert.match(item.why, /rate_limited: scripted failure/, 'the provider’s message, not a generic sentence');
  assert.match(snap.runs.find(r => r.taskId === task.id)!.error ?? '', /rate_limited/);
});

test('S37 a failed task can be started again once its run settled', async t => {
  const { s, project, member, state } = await service(t);
  const cto = await member('CTO');
  const task = await s.invoke('paperclip.task.create', { title: 'Flaky job', description: 'E2E-FAIL', projectId: project.id, assigneeId: `member:${cto.id}`, start: true });
  assert.ok(task.started, task.startError ?? 'not started');
  await until(async () => await state(task.id) === 'failed', 'failed');
  const detail = await s.invoke('paperclip.task', { id: task.id });
  assert.equal(detail.runs[0].chatId, task.started!.chatId, 'the thread knows the run chat, for its Open run chat link');
  const again = await s.invoke('paperclip.task.start', { taskId: task.id });
  assert.ok(again.chatId && again.chatId !== task.started!.chatId, 'a new run starts; no "may still be active" dead end');
  await until(async () => await state(task.id) === 'failed', 'second run settled');
});

test('S55/S23 board moves: Backlog is a real state the scheduler skips; Done verifies reviewed work or says why not', async t => {
  const { s, project, member, state } = await service(t);
  const cto = await member('CTO');
  const make = (title: string) => s.invoke('paperclip.task.create', { title, description: '', projectId: project.id, assigneeId: `member:${cto.id}` });
  const parked = await make('Someday');
  assert.equal((await s.invoke('paperclip.task.update', { taskId: parked.id, status: 'backlog' })).status, 'backlog', 'Backlog stays Backlog, not Todo');
  assert.equal(await state(parked.id), 'backlog');
  await s.invoke('project.scheduler.set', { projectId: project.id, autoDispatch: true });
  await wait(400);
  assert.equal(await state(parked.id), 'backlog', 'the scheduler never picks up backlog work');
  await s.invoke('project.scheduler.set', { projectId: project.id, autoDispatch: false });
  const fresh = await make('Not reviewed');
  await assert.rejects(() => s.invoke('paperclip.task.update', { taskId: fresh.id, status: 'done' }), /Move it to In Review first/);
  await assert.rejects(() => s.invoke('paperclip.task.update', { taskId: fresh.id, status: 'in_progress' }), /real run/);
  assert.equal((await s.invoke('paperclip.task.update', { taskId: fresh.id, status: 'in_review' })).status, 'in_review');
  const done = await s.invoke('paperclip.task.update', { taskId: fresh.id, status: 'done' });
  assert.equal(done.status, 'done', 'reviewed work moves to Done through a recorded manual verification');
  const view = (await s.invoke('project.work', { projectId: project.id })).tasks.items.find(i => i.id === fresh.id)!;
  assert.equal(view.verification?.kind, 'manual');
  assert.equal((await s.invoke('paperclip.task.update', { taskId: parked.id, status: 'todo' })).status, 'todo');
});
