/** Wave 3: G24 costs and provider windows, G38 your stats, G25 Reflection Coach, G26 Skill Studio, G31 setup interview. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { wave3, until } from './wave3-harness.ts';
import { modelKey } from '../src/shared/model-catalog.ts';
import { buildCosts, buildProfile, dayOf, type TurnRow } from '../src/runtime/insight/costs.ts';
import { evidenceOf, hasSignal, parseReflection, reflectionPrompt, type ReflectionFacts } from '../src/runtime/insight/reflection.ts';
import { draftSkillFromTask, skillTestPrompt } from '../src/runtime/insight/skills.ts';
import { InsightStore } from '../src/runtime/insight/store.ts';
import { extensionsOptions } from '../src/runtime/domains/extensions.ts';
import { interviewPrompt } from '../src/runtime/domains/insight.ts';
import { parseCoordinatorBlocks } from '../src/shared/domains/projects-protocol.ts';

const turn = (over: Partial<TurnRow> & { endedAt: string }): TurnRow => ({ projectId: 'p1', agent: 'CTO', provider: 'codex', model: 'gpt-x', input: 1000, output: 500, costUsd: 0.01, outcome: 'completed', ...over });
const NOW = Date.parse('2026-10-10T12:00:00Z');
const dayAgo = (n: number, hour = 9) => new Date(NOW - n * 86_400_000 + (hour - 12) * 3_600_000).toISOString();

test('G24: costs aggregate by model, agent, project and day; unpriced turns are counted, never shown as $0; the window clips the range', () => {
  const turns: TurnRow[] = [
    turn({ endedAt: dayAgo(0) }), turn({ endedAt: dayAgo(0), agent: 'QA', model: 'gpt-y', costUsd: null }), turn({ endedAt: dayAgo(1), projectId: null, costUsd: 0.02 }),
    turn({ endedAt: dayAgo(8) }), turn({ endedAt: dayAgo(40) }),
  ];
  const names = new Map([['p1', 'Alpha']]);
  const r7 = buildCosts(turns, { days: 7, offsetMin: 0, now: NOW, projectNames: names, windows: [], ledgerSince: null });
  assert.equal(r7.entries, 3); assert.equal(r7.byDay.length, 7); assert.equal(r7.byDay.at(-1)!.turns, 2);
  assert.equal(r7.totals.costUsd, 0.03); assert.equal(r7.totals.unpricedTurns, 1);
  assert.deepEqual(r7.byAgent.map(b => [b.label, b.turns]), [['CTO', 2], ['QA', 1]]);
  assert.deepEqual(r7.byModel.map(b => [b.label, b.costUsd]), [['gpt-x', 0.03], ['gpt-y', null]]);
  assert.deepEqual(r7.byProject.map(b => b.label).sort(), ['Alpha', 'Chats outside projects']);
  assert.equal(r7.byDay.at(-1)!.costUsd, 0.01);
  // Chats are one line, not one agent per chat title.
  const chatTurns = [turn({ endedAt: dayAgo(0), agent: 'Reflection · CTO', trigger: 'project chat' }), turn({ endedAt: dayAgo(0), agent: 'Hello there', trigger: 'chat' }), turn({ endedAt: dayAgo(0), trigger: 'task' })];
  const chatCosts = buildCosts(chatTurns, { days: 7, offsetMin: 0, now: NOW, projectNames: names, windows: [], ledgerSince: null });
  assert.deepEqual(chatCosts.byAgent.map(b => [b.label, b.turns]), [['Chats (not task runs)', 2], ['CTO', 1]]);
  const r30 = buildCosts(turns, { days: 30, offsetMin: 0, now: NOW, projectNames: names, windows: [], ledgerSince: null });
  assert.equal(r30.entries, 4);
  const r90 = buildCosts(turns, { days: 90, offsetMin: 0, now: NOW, projectNames: names, windows: [], ledgerSince: null });
  assert.equal(r90.entries, 5);
  // A model with no priced turn has a null cost, and a day with only unpriced turns has a null cost.
  assert.equal(r7.byDay.find(d => d.day === dayOf(dayAgo(0), 0))!.costUsd, 0.01);
  assert.equal(dayOf('2026-10-10T23:30:00Z', 120), '2026-10-11');
  assert.equal(dayOf('2026-10-10T01:30:00Z', -300), '2026-10-09');
});

test('G38: profile counts tasks, runs, tokens, provider mix and the activity streak', () => {
  const turns = [turn({ endedAt: dayAgo(0) }), turn({ endedAt: dayAgo(1), provider: 'openai', outcome: 'failed', costUsd: null }), turn({ endedAt: dayAgo(2), provider: 'openai' }), turn({ endedAt: dayAgo(9) })];
  const p = buildProfile(turns, { offsetMin: 0, now: NOW, states: { verified: 3, implemented: 1, todo: 2, running: 1, failed: 1, cancelled: 1 }, providerNames: new Map([['openai', 'OpenAI']]), projects: [{ projectId: 'a', name: 'A', completed: 1, open: 0 }, { projectId: 'b', name: 'B', completed: 4, open: 2 }], since: '2026-09-01T00:00:00Z' });
  assert.deepEqual(p.tasks, { total: 9, completed: 4, open: 3, failed: 1 });
  assert.deepEqual(p.runs, { total: 4, succeeded: 3, failed: 1, other: 0 });
  assert.equal(p.tokens.input, 4000); assert.equal(p.unpricedTurns, 1);
  assert.deepEqual(p.providerMix.map(m => [m.name, m.turns, m.share]), [['codex', 2, 0.5], ['OpenAI', 2, 0.5]]);
  assert.equal(p.activity.length, 28); assert.equal(p.activeDays, 4); assert.equal(p.streak, 3);
  assert.deepEqual(p.topProjects.map(x => x.name), ['B', 'A']);
  // No run today: the streak counts back from yesterday.
  const q = buildProfile([turn({ endedAt: dayAgo(1) }), turn({ endedAt: dayAgo(2) })], { offsetMin: 0, now: NOW, states: {}, providerNames: new Map(), projects: [], since: null });
  assert.equal(q.streak, 2); assert.deepEqual(q.tasks, { total: 0, completed: 0, open: 0, failed: 0 });
});

test('G24/G38: the commands read the real Ledger after real runs, priced once a price is set, with provider windows listed', async t => {
  const h = await wave3(t);
  const cto = await h.member('CTO');
  const a = await h.addTask('Ship it', { kind: 'agent', id: cto.id });
  await h.start(a.id); await h.settled(a.id);
  const unpriced = await h.s.invoke('insight.costs', { days: 7 });
  assert.equal(unpriced.entries, 1); assert.equal(unpriced.totals.costUsd, null); assert.equal(unpriced.totals.unpricedTurns, 1);
  assert.equal(unpriced.byProject[0]!.label, 'OSSMANAGER'); assert.equal(unpriced.byAgent[0]!.label, 'CTO'); assert.ok(unpriced.totals.inputTokens > 0);
  assert.ok(unpriced.windows.some(w => w.providerId === 'codex' || w.reports));
  await h.s.invoke('models.policy.setPricing', { key: modelKey('scripted', 'scripted-model'), pricing: { inputPerMTok: 10, outputPerMTok: 20 } });
  const b = await h.addTask('Ship it again', { kind: 'agent', id: cto.id });
  await h.start(b.id); await h.settled(b.id);
  const priced = await h.s.invoke('insight.costs', { days: 30, projectId: h.project.id });
  assert.equal(priced.entries, 2); assert.equal(priced.totals.unpricedTurns, 0, 'your price also prices the earlier turn'); assert.ok((priced.totals.costUsd ?? 0) > 0);
  // 1200 in, 300 out per turn at $10 / $20 per million: 0.012 + 0.006 per turn (the scripted run reports 1200 / 300, then 2400 / 600 on a second turn of the same chat).
  assert.ok(priced.totals.costUsd! >= 0.036 - 1e-9, String(priced.totals.costUsd));
  assert.equal((await h.s.invoke('insight.profile', {})).unpricedTurns, 0);
  assert.deepEqual(priced.windows, []);
  await assert.rejects(h.s.invoke('insight.costs', { days: 30, projectId: 'nope' }), /no longer exists/);
  const profile = await h.s.invoke('insight.profile', {});
  assert.equal(profile.runs.total, 2); assert.equal(profile.runs.succeeded, 2); assert.ok(profile.tasks.total >= 2);
  assert.equal(profile.providerMix[0]!.turns, 2); assert.equal(profile.activeDays, 1); assert.equal(profile.streak, 1);
  assert.equal(profile.topProjects[0]!.name, 'OSSMANAGER');
});

const facts = (over: Partial<ReflectionFacts> = {}): ReflectionFacts => ({ agent: 'CTO', project: 'OSS', goal: 'Ship', file: 'AGENTS.md', current: 'Be careful.', now: new Date('2026-10-10'), turns: [], tasks: [], needsWork: [], changes: [], helpful: 0, ...over });

test('G25: the coach needs signal, writes a prompt with the evidence, and reads back one validated proposal block', () => {
  assert.equal(hasSignal(facts(), 3), false);
  assert.equal(hasSignal(facts({ turns: [1, 2, 3].map(() => ({ at: '2026-10-09', outcome: 'failed', tools: [], task: null })) }), 3), true);
  assert.equal(hasSignal(facts({ changes: ['asked for tests'] }), 3), true);
  const f = facts({ turns: [{ at: '2026-10-09T10:00:00Z', outcome: 'failed', tools: ['shell'], task: 'OSS-1' }], tasks: [{ key: 'OSS-1', title: 'Fix login', state: 'todo' }], changes: ['Reviewer asked for a test'], needsWork: [{ task: 'OSS-1', reason: 'No tests', excerpt: '' }], helpful: 2 });
  assert.deepEqual(evidenceOf(f), { turns: 1, failed: 1, needsWork: 1, changesRequested: 1, tasks: 1 });
  const prompt = reflectionPrompt(f);
  for (const s of ['Be careful.', 'OSS-1', 'Reviewer asked for a test', 'No tests', '2 replies were marked', 'muster-reflection', 'Do not change anything']) assert.ok(prompt.includes(s), s);
  const ok = parseReflection('thinking\n```muster-reflection\n{"changed":true,"rationale":"Tests are missed","text":"Be careful.\\nAlways add a test."}\n```', 32_768);
  assert.deepEqual(ok, { changed: true, rationale: 'Tests are missed', text: 'Be careful.\nAlways add a test.\n' });
  assert.equal(parseReflection('```muster-reflection\n{"changed":false,"rationale":"Fits."}\n```', 100).changed, false);
  assert.throws(() => parseReflection('no block', 100), /did not answer/);
  assert.throws(() => parseReflection('```muster-reflection\n{nope\n```', 100), /could not be read/);
  assert.throws(() => parseReflection('```muster-reflection\n{"changed":true,"rationale":"x","text":""}\n```', 100), /no new text/);
  assert.throws(() => parseReflection('```muster-reflection\n{"changed":true,"rationale":"x","text":"' + 'a'.repeat(200) + '"}\n```', 100), /too long/);
  assert.throws(() => parseReflection('```muster-reflection\n{"changed":true,"text":"x"}\n```', 100), /did not say why/);
});

test('G25: a reflection reads the agent read-only, lands in the Inbox as a proposal, applies only when accepted, and refuses a stale base', async t => {
  const h = await wave3(t);
  const cto = await h.member('CTO', { instructions: 'Be careful.' });
  const a = await h.addTask('Fix login', { kind: 'agent', id: cto.id });
  await h.s.invoke('work.votes.set', { projectId: h.project.id, subject: 'message', subjectId: 'm1', taskId: a.id, vote: 'needs_work', reason: 'Shipped without a test' });
  h.sayWhen(/Reflection Coach/, '```muster-reflection\n{"changed":true,"rationale":"Replies were marked as missing tests.","text":"Be careful.\\nAdd a test with every fix.\\n"}\n```', { delayMs: 60 });
  const r = await h.s.invoke('insight.reflect.run', { projectId: h.project.id, memberId: cto.id });
  assert.equal(r.state, 'working'); assert.equal(r.agent, 'CTO'); assert.equal(r.file, 'AGENTS.md'); assert.equal(r.evidence.needsWork, 1);
  assert.equal((await h.s.invoke('insight.reflect.run', { projectId: h.project.id, memberId: cto.id })).id, r.id);
  const call = await until(() => h.calls.find(c => /Reflection Coach/.test(c.prompt)), 'the coach run');
  assert.equal(call.permission, 'read-only'); assert.match(call.prompt, /Shipped without a test/); assert.match(call.prompt, /Be careful\./);
  const ready = await until(async () => { const x = (await h.s.invoke('insight.reflect.list', { projectId: h.project.id })).reflections[0]; return x?.state === 'ready' ? x : null; }, 'the proposal');
  assert.match(ready.proposedText, /Add a test with every fix/); assert.match(ready.rationale, /missing tests/);
  assert.equal((await h.s.invoke('app.snapshot', undefined)).chats.find(c => c.id === ready.chatId)!.archived, true, 'the reading chat is archived once it has answered');
  // Nothing changed yet.
  assert.equal((await h.s.invoke('project.agent.gov.get', { projectId: h.project.id, memberId: cto.id })).files.find(f => f.name === 'AGENTS.md')!.text, 'Be careful.');
  // The Inbox overlay carries it.
  const inbox = (await h.s.invoke('work.overlay', {})).inbox.find(i => i.id === `reflect:${r.id}`)!;
  assert.match(inbox.title, /CTO/); assert.equal(inbox.projectId, h.project.id); assert.equal(inbox.group, 'OSSMANAGER');
  const snap = await h.s.invoke('paperclip.snapshot', {});
  assert.ok(snap.inbox.some(i => i.id === `reflect:${r.id}`));
  assert.ok(h.eventsOf('insightChanged').length >= 2);
  // Accept with an edit.
  const done = await h.s.invoke('insight.reflect.accept', { projectId: h.project.id, id: r.id, text: 'Be careful.\nAdd a test with every fix.\nSay what you ran.\n' });
  assert.equal(done.state, 'accepted');
  const files = (await h.s.invoke('project.agent.gov.get', { projectId: h.project.id, memberId: cto.id })).files;
  assert.match(files.find(f => f.name === 'AGENTS.md')!.text, /Say what you ran/);
  assert.ok(!(await h.s.invoke('work.overlay', {})).inbox.some(i => i.id === `reflect:${r.id}`));
  await assert.rejects(h.s.invoke('insight.reflect.accept', { projectId: h.project.id, id: r.id }), /Already applied/);
  // A second proposal goes stale when the file changes underneath it; dismissing it keeps the file.
  h.sayWhen(/Reflection Coach/, '```muster-reflection\n{"changed":true,"rationale":"More.","text":"Different.\\n"}\n```');
  const r2 = await h.s.invoke('insight.reflect.run', { projectId: h.project.id, memberId: cto.id });
  await until(async () => (await h.s.invoke('insight.reflect.list', { projectId: h.project.id })).reflections.find(x => x.id === r2.id)?.state === 'ready', 'second proposal');
  await h.s.invoke('project.agent.files.save', { projectId: h.project.id, memberId: cto.id, name: 'AGENTS.md', text: 'Changed by hand.\n' });
  await assert.rejects(h.s.invoke('insight.reflect.accept', { projectId: h.project.id, id: r2.id }), /changed after this proposal/);
  assert.equal((await h.s.invoke('insight.reflect.dismiss', { projectId: h.project.id, id: r2.id })).state, 'dismissed');
  assert.match((await h.s.invoke('project.agent.gov.get', { projectId: h.project.id, memberId: cto.id })).files.find(f => f.name === 'AGENTS.md')!.text, /Changed by hand/);
  // A coach that finds nothing to change says so and leaves no Inbox item.
  h.sayWhen(/Reflection Coach/, '```muster-reflection\n{"changed":false,"rationale":"It already fits."}\n```');
  const r3 = await h.s.invoke('insight.reflect.run', { projectId: h.project.id, memberId: cto.id });
  const same = await until(async () => { const x = (await h.s.invoke('insight.reflect.list', { projectId: h.project.id })).reflections.find(y => y.id === r3.id); return x && x.state !== 'working' ? x : null; }, 'unchanged');
  assert.equal(same.state, 'unchanged'); assert.match(same.rationale, /already fits/);
  // An unusable answer fails plainly.
  h.sayWhen(/Reflection Coach/, 'I think it is fine.');
  const r4 = await h.s.invoke('insight.reflect.run', { projectId: h.project.id, memberId: cto.id });
  const bad = await until(async () => { const x = (await h.s.invoke('insight.reflect.list', { projectId: h.project.id })).reflections.find(y => y.id === r4.id); return x && x.state !== 'working' ? x : null; }, 'failed');
  assert.equal(bad.state, 'failed'); assert.match(bad.error!, /did not answer/);
  await assert.rejects(h.s.invoke('insight.reflect.run', { projectId: h.project.id, memberId: 'nobody' }), /Choose an agent/);
});

test('G25: the weekly reflection is opt-in, runs only for agents with something to learn from, and arms the next week', async t => {
  const h = await wave3(t, { fakeClock: true });
  const cto = await h.member('CTO'), qa = await h.member('QA');
  // CTO has changes-requested feedback; QA has nothing, so only CTO is read.
  const a = await h.addTask('Fix login', { kind: 'agent', id: cto.id });
  await h.s.invoke('work.votes.set', { projectId: h.project.id, subject: 'message', subjectId: 'm1', taskId: a.id, vote: 'needs_work', reason: 'No tests' });
  h.sayWhen(/Reflection Coach/, '```muster-reflection\n{"changed":true,"rationale":"Tests.","text":"Add tests.\\n"}\n```');
  assert.equal((await h.s.invoke('insight.reflect.list', { projectId: h.project.id })).settings.weekly, false);
  const before = h.clock!.pending;
  const set = await h.s.invoke('insight.reflect.settings.set', { projectId: h.project.id, weekly: true });
  assert.equal(set.weekly, true); assert.ok(set.nextRunAt); assert.ok(h.clock!.pending > before);
  assert.equal(h.calls.filter(c => /Reflection Coach/.test(c.prompt)).length, 0);
  await h.clock!.advance(7 * 86_400_000 + 5000);
  await until(async () => (await h.s.invoke('insight.reflect.list', { projectId: h.project.id })).reflections.some(r => r.state === 'ready'), 'the weekly proposal');
  const list = (await h.s.invoke('insight.reflect.list', { projectId: h.project.id }));
  assert.deepEqual(list.reflections.map(r => r.agent), ['CTO']); assert.ok(list.settings.lastRunAt);
  assert.ok(list.settings.nextRunAt, 'next week is armed');
  void qa;
  await h.s.invoke('insight.reflect.settings.set', { projectId: h.project.id, weekly: false });
  assert.equal((await h.s.invoke('insight.reflect.list', { projectId: h.project.id })).settings.weekly, false);
  assert.equal(h.clock!.pending, 0, 'turning it off leaves no timer');
});

test('G26: a skill is drafted from a finished task, tested read-only against saved inputs, and the runs are kept', async t => {
  const h = await wave3(t);
  const home = await mkdtemp(join(tmpdir(), 'muster-skill-home-')), before = extensionsOptions.home;
  extensionsOptions.home = home;
  t.after(async () => { extensionsOptions.home = before; await rm(home, { recursive: true, force: true }); });
  const cto = await h.member('CTO');
  const a = await h.addTask('Cut a release', { kind: 'agent', id: cto.id }, { acceptance: '- Tag is pushed\n- Notes are posted\n- Changelog updated' });
  await h.s.invoke('work.docs.save', { projectId: h.project.id, taskId: a.id, key: 'plan', text: '1. Bump version\n2. Tag\n3. Post notes' });
  h.sayWhen(/Cut a release/, 'Released 1.2.0 and posted the notes.');
  await h.start(a.id); await h.settled(a.id);
  const draft = await h.s.invoke('studio.skill.fromTask', { projectId: h.project.id, taskId: a.id });
  assert.equal(draft.draft.name, 'Cut a release'); assert.match(draft.draft.description, /Use when asked to do work like/);
  for (const s of ['## Goal', '## Plan to follow', '1. Bump version', '## Check before finishing', '- Tag is pushed', 'Released 1.2.0']) assert.ok(draft.draft.body.includes(s), s);
  assert.equal(draft.sources.documents, 1); assert.ok(draft.sources.messages >= 2);
  await assert.rejects(h.s.invoke('studio.skill.fromTask', { projectId: h.project.id, taskId: 'nope' }), /not in this project/);
  assert.match(skillTestPrompt('x', 'Do it.', 'input'), /read-only/);
  assert.match(draftSkillFromTask({ title: 'T', acceptance: '', state: 'todo', owner: null, plan: null, documents: [], finalReply: '', tools: [], messages: 0 }).body, /^# T/);

  // Templates, saved inputs and a test run. The skill is saved through the real skill command (a temp HOME-less call uses the default root).
  assert.equal((await h.s.invoke('studio.skill.templates', {})).templates.length, 5);
  await assert.rejects(h.s.invoke('studio.skill.inputs.save', { skill: 'Bad Name', label: 'x', text: 'y' }), /by its name/);
  assert.deepEqual(await h.s.invoke('studio.skill.inputs.list', { skill: 'release-demo' }), { inputs: [], runs: [] });
  const saved = await h.s.invoke('studio.skill.inputs.save', { skill: 'release-demo', label: 'Small release', text: 'Cut 1.2.0 from these 3 changes' });
  assert.equal((await h.s.invoke('studio.skill.inputs.list', { skill: 'release-demo' })).inputs[0]!.id, saved.id);
  await assert.rejects(h.s.invoke('studio.skill.inputs.save', { skill: 'release-demo', label: '', text: 'y' }), /Name the input/);
  await assert.rejects(h.s.invoke('studio.skill.test', { projectId: h.project.id, skill: 'release-demo', input: '' }), /Write a test input/);
  // A real test run: the skill's own text reaches a read-only chat with the saved input, and the reply is kept as the result.
  await h.s.invoke('extensions.skills.save', { name: 'release-demo', description: 'Cut a release', body: '# Release\n1. Tag the build.\n2. Post the notes.' });
  h.sayWhen(/testing the skill “release-demo”/, 'Tagged 1.2.0 and posted notes.\nTest note: step 2 does not say where.', { delayMs: 40 });
  const run = await h.s.invoke('studio.skill.test', { projectId: h.project.id, skill: 'release-demo', input: saved.text, inputId: saved.id });
  assert.equal(run.state, 'working'); assert.equal(run.inputId, saved.id);
  const call = await until(() => h.calls.find(c => /testing the skill/.test(c.prompt)), 'the test run');
  assert.equal(call.permission, 'read-only'); assert.match(call.prompt, /Tag the build/); assert.match(call.prompt, /Cut 1\.2\.0 from these 3 changes/);
  const done = await until(async () => { const r = (await h.s.invoke('studio.skill.inputs.list', { skill: 'release-demo' })).runs[0]; return r && r.state !== 'working' ? r : null; }, 'the result');
  assert.equal(done.state, 'done'); assert.match(done.result, /Test note: step 2/); assert.ok(done.chatId);
  assert.equal((await h.s.invoke('app.snapshot', undefined)).chats.find(c => c.id === done.chatId)!.archived, true, 'the helper chat is archived so it does not clutter the sidebar');
  await assert.rejects(h.s.invoke('studio.skill.test', { projectId: h.project.id, skill: 'does-not-exist', input: 'x' }), /no saved skill named/);
  // A skill saved from a chat or a task lives in ~/.codex/skills; the studio reads that one too, without its front matter.
  await mkdir(join(home, '.codex', 'skills', 'from-chat'), { recursive: true });
  await writeFile(join(home, '.codex', 'skills', 'from-chat', 'SKILL.md'), '---\nname: from-chat\ndescription: "x"\n---\n\n# From chat\nAlways greet first.\n');
  h.sayWhen(/testing the skill “from-chat”/, 'Hello. Test note: none');
  await h.s.invoke('studio.skill.test', { projectId: h.project.id, skill: 'from-chat', input: 'hi' });
  const chatCall = await until(() => h.calls.find(c => /testing the skill “from-chat”/.test(c.prompt)), 'the codex-root skill test');
  assert.match(chatCall.prompt, /Always greet first/); assert.doesNotMatch(chatCall.prompt, /description: "x"/);
  h.sayWhen(/testing the skill “release-demo”/, '', { fail: 'provider down' });
  const bad = await h.s.invoke('studio.skill.test', { projectId: h.project.id, skill: 'release-demo', input: 'again' });
  const failed = await until(async () => { const r = (await h.s.invoke('studio.skill.inputs.list', { skill: 'release-demo' })).runs.find(x => x.id === bad.id); return r && r.state !== 'working' ? r : null; }, 'the failed result');
  assert.equal(failed.state, 'failed');
  await h.s.invoke('studio.skill.inputs.remove', { id: saved.id });
  assert.equal((await h.s.invoke('studio.skill.inputs.list', { skill: 'release-demo' })).inputs.length, 0);
});

test('G26: the insight store keeps inputs and runs per skill, caps them, and fails runs the app left unfinished', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'muster-insight-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const s = new InsightStore(dir);
  for (let i = 0; i < 20; i++) s.addSkillInput('sk', `i${i}`, 'x');
  assert.throws(() => s.addSkillInput('sk', 'one more', 'x'), /up to 20/);
  assert.equal(s.skillInputs('other').length, 0);
  const run = s.addSkillRun({ skill: 'sk', inputId: null, input: 'in', projectId: 'p', chatId: 'c' });
  assert.equal(s.runByChat('c')!.id, run.id);
  assert.equal(s.finishSkillRun(run.id, { state: 'done', result: 'ok' })!.state, 'done');
  assert.equal(s.runByChat('c'), undefined);
  s.addSkillRun({ skill: 'sk', inputId: null, input: 'in', projectId: 'p', chatId: 'c2' });
  s.failStuckSkillRuns();
  assert.equal(s.skillRuns('sk')[0]!.state, 'failed');
  const r = s.addReflection({ projectId: 'p', memberId: 'm', agent: 'A', file: 'AGENTS.md', baseText: '', evidence: { turns: 0, failed: 0, needsWork: 0, changesRequested: 0, tasks: 0 }, chatId: null });
  assert.deepEqual(s.failStuckReflections(), ['p']);
  assert.equal(s.reflection(r.id)!.state, 'failed');
  s.setSettings('p', { weekly: true }); assert.equal(s.weeklyProjects().length, 1);
  s.forgetProject('p'); assert.equal(s.reflections('p').length, 0); assert.equal(s.weeklyProjects().length, 0);
  s.close();
});

test('G31: the setup interview starts the coordinator with the interview opening once; a goal operation sets the mission when applied', async t => {
  const h = await wave3(t);
  h.sayWhen(/Interview me/, 'First question: who is this project for?');
  const first = await h.s.invoke('insight.setup.interview', { projectId: h.project.id });
  assert.equal(first.started, true);
  const call = await until(() => h.calls.find(c => /Interview me/.test(c.prompt)), 'the interview opening');
  assert.match(call.prompt, /OSSMANAGER/); assert.match(call.prompt, /Ship the release/); assert.match(call.prompt, /"op":"goal"/);
  const again = await h.s.invoke('insight.setup.interview', { projectId: h.project.id });
  assert.deepEqual([again.chatId, again.started], [first.chatId, false]);
  assert.match(interviewPrompt('P', ''), /have not written a goal yet/);
  // The mission arrives as a proposal the owner approves; applying it sets the project goal and creates the tasks.
  const reply = '```muster-tasks\n[{"op":"goal","text":"Ship a calm, reliable 0.3.0."},{"op":"create","ref":"a","title":"Write the plan","acceptance":"A plan exists","owner":"agent"},{"op":"create","title":"Cut the release","dependsOn":["a"],"owner":"user"}]\n```';
  const blocks = parseCoordinatorBlocks(reply);
  assert.equal(blocks[0]!.ops[0]!.op, 'goal'); assert.equal(blocks[0]!.ops.length, 3);
  assert.deepEqual(parseCoordinatorBlocks('```muster-tasks\n[{"op":"goal","text":""}]\n```')[0]!.error, 'Invalid goal.');
  h.sayWhen(/Interview me/, reply);
  const fresh = await h.s.invoke('project.create', { name: 'Fresh', goal: '', folderIds: [h.folder.id] });
  const second = await h.s.invoke('insight.setup.interview', { projectId: fresh.id });
  const proposal = await until(async () => (await h.s.invoke('project.work', { projectId: fresh.id })).coordinator.proposals.find(p => p.state === 'pending'), 'the plan proposal');
  assert.equal(proposal.ops[0]!.op, 'goal');
  await h.s.invoke('project.coordinator.apply', { projectId: fresh.id, key: proposal.key });
  assert.equal((await h.s.invoke('project.list', undefined)).find(p => p.id === fresh.id)!.goal, 'Ship a calm, reliable 0.3.0.');
  const titles = (await h.s.invoke('project.work', { projectId: fresh.id })).tasks.items.map(x => x.title).sort();
  assert.deepEqual(titles, ['Cut the release', 'Write the plan']);
  void second;
});
