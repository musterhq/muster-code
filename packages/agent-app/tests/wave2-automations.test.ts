/** Wave 2: C22 automations that create tasks, G20 variables / signed webhook / approval gate / activity gate, G3 templates and the standup digest. */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { wave2, until, type Wave2 } from './wave2-harness.ts';
import { automationTiming } from '../src/runtime/domains/automations.ts';
import { signWebhook, verifyWebhook, variablesFromBody } from '../src/runtime/automations/webhook.ts';
import { AUTOMATION_TEMPLATES, builtinValues, checkVariables, renderTemplate, resolveVariables, variablesIn } from '../src/shared/automation-templates.ts';
import type { AutomationExt } from '../src/shared/domains/automations-protocol.ts';

const memorySecrets = () => { const m = new Map<string, string>(); return { secureStorage: () => true, set: (id: string, v: unknown) => { m.set(id, String(v)); }, get: (id: string) => m.get(id), clear: (id: string) => { m.delete(id); }, all: m }; };
const ext = (over: Partial<AutomationExt> = {}): AutomationExt => ({ variables: [], approval: false, activityGate: false, webhook: false, ...over });
const base = (h: Wave2, over: Record<string, unknown> = {}) => ({ name: 'Triage', prompt: 'Look at {{ticket}} ({{label}}) on {{date}}.', timezone: 'UTC', schedule: { kind: 'interval' as const, minutes: 60 }, permissionMode: 'workspace' as const, overlap: 'skip' as const, catchUp: 'none' as const, target: { kind: 'task' as const, projectId: h.project.id, start: false, mode: 'task' as const, titleTemplate: 'Triage {{ticket}}' }, ...over });
const post = async (url: string, secret: string | null, body: string, over: { ts?: number; sig?: string; method?: string } = {}) => {
  const ts = over.ts ?? Math.floor(Date.now() / 1000), headers: Record<string, string> = { 'x-muster-timestamp': String(ts) };
  if (secret !== null) headers['x-muster-signature'] = over.sig ?? signWebhook(secret, ts, body);
  const r = await fetch(url, { method: over.method ?? 'POST', headers, body: over.method === 'GET' ? undefined : body });
  return { status: r.status, body: await r.json().catch(() => null) as Record<string, unknown> | null };
};
const tasksOf = async (h: Wave2) => (await h.work()).tasks.items;

test('G20: placeholders are validated, rendered with built-ins and resolved from the given value, then the default; a missing required one is named', () => {
  assert.deepEqual(variablesIn('Hi {{ticket}} {{ Date }} {{ticket}}'), ['ticket', 'date']);
  assert.equal(renderTemplate('{{a}}-{{b}}-{{c}}', { a: '1', b: '2' }), '1-2-{{c}}');
  assert.equal(checkVariables(['{{ticket}}'], [{ name: 'ticket' }]), null);
  assert.match(checkVariables(['{{ticket}}'], []) ?? '', /no variable with that name/);
  assert.match(checkVariables([''], [{ name: 'Bad Name' }]) ?? '', /not a valid variable name/);
  assert.match(checkVariables([''], [{ name: 'date' }]) ?? '', /built in/);
  assert.match(checkVariables([''], [{ name: 'a' }, { name: 'a' }]) ?? '', /twice/);
  const b = builtinValues('Triage', new Date('2026-10-01T22:30:00Z'), 'Asia/Kolkata');
  assert.deepEqual([b.date, b.time, b.automation], ['2026-10-02', '04:00', 'Triage']);
  const r = resolveVariables([{ name: 'ticket', required: true, label: 'Ticket' }, { name: 'label', default: 'triage' }], { label: '' }, b);
  assert.deepEqual([r.values.label, r.missing], ['triage', ['Ticket']]);
  assert.deepEqual(resolveVariables([{ name: 'ticket', required: true }], { ticket: 42 }, b).values.ticket, '42');
});

test('G20 and C22: Run now creates a task from the automation, filling {{variables}} from the dialog; a required one with no value stops the run', async t => {
  const h = await wave2(t);
  const created = await h.s.invoke('automations.create', base(h, { ext: ext({ variables: [{ name: 'ticket', required: true, label: 'Ticket' }, { name: 'label', default: 'triage' }] }) }));
  assert.deepEqual(created.ext.variables.map(v => v.name), ['ticket', 'label']);
  const empty = await h.s.invoke('automations.runNow', { id: created.id });
  assert.equal(empty.status, 'failed'); assert.match(empty.reason ?? '', /needs a value for Ticket/);
  assert.equal((await tasksOf(h)).length, 0);
  const run = await h.s.invoke('automations.runNow', { id: created.id, variables: { ticket: 'ABC-1' } });
  const done = await until(async () => (await h.s.invoke('automations.runs', { id: created.id })).find(r => r.id === run.id && r.status === 'completed'), 'the run to complete');
  assert.match(done.reason ?? '', /Created OSS-\d+\./);
  const [task] = await tasksOf(h);
  assert.equal(task!.title, `Triage ABC-1`);
  assert.match(task!.acceptance, /Look at ABC-1 \(triage\) on \d{4}-\d{2}-\d{2}\./);
  assert.equal(done.taskId, task!.id); assert.deepEqual(done.variables, { ticket: 'ABC-1', label: 'triage' });
  // Saving text that uses an undeclared placeholder is refused.
  await assert.rejects(h.s.invoke('automations.update', { ...base(h, { prompt: 'Look at {{nope}}', ext: ext({ variables: [{ name: 'ticket' }] }) }), id: created.id }), /no variable with that name/);
  await assert.rejects(h.s.invoke('automations.create', base(h, { prompt: 'Plain.', ext: ext({ activityGate: true }), target: { kind: 'chat', chatId: 'x' } })), /needs a project or folder to watch/);
});

test('C22: a task automation can start its owner, who runs it in a worktree like any task, and the automation run ends with that run', async t => {
  const h = await wave2(t);
  const cto = await h.member('CTO');
  h.sayWhen(/Check the build/, 'Build is green.');
  const a = await h.s.invoke('automations.create', base(h, { prompt: 'Check the build.', ext: ext(), target: { kind: 'task', projectId: h.project.id, assigneeId: `member:${cto.id}`, priority: 'high', start: true, mode: 'task', titleTemplate: 'Build check {{date}}' } }));
  const run = await h.s.invoke('automations.runNow', { id: a.id });
  assert.equal(run.status, 'running');
  const done = await until(async () => (await h.s.invoke('automations.runs', { id: a.id })).find(r => r.id === run.id && r.status === 'completed'), 'the automation run to end');
  const task = (await tasksOf(h)).find(x => x.id === done.taskId)!;
  assert.match(task.title, /^Build check \d{4}-/); assert.equal(task.owner.id, cto.id); assert.equal(task.priority, 1);
  assert.ok(task.attempts.length === 1 && task.attempts[0]!.status === 'completed');
  assert.ok(h.calls.some(c => /Check the build\./.test(c.prompt)));
  assert.equal(done.chatId, task.attempts[0]!.chatId);
});

test('G20: the webhook needs a stored secret, verifies the signature and timestamp, fills variables from the body, rejects replays, and never leaks the secret', async t => {
  automationTiming.webhookPort = 0;
  const secrets = memorySecrets(); automationTiming.secrets = () => secrets;
  const h = await wave2(t);
  const a = await h.s.invoke('automations.create', base(h, { ext: ext({ webhook: true, variables: [{ name: 'ticket', required: true }, { name: 'label', default: 'triage' }] }) }));
  assert.equal(a.webhook!.hasSecret, false);
  const hook = await h.s.invoke('automations.webhook.rotate', { id: a.id });
  assert.match(hook.secret, /^whsec_[0-9a-f]{64}$/); assert.match(hook.url ?? '', new RegExp(`^http://127\\.0\\.0\\.1:\\d+/hooks/${a.id}$`));
  assert.equal((await h.s.invoke('automations.list', undefined))[0]!.webhook!.hasSecret, true);
  assert.ok(!JSON.stringify(await h.s.invoke('automations.list', undefined)).includes(hook.secret), 'the list never carries the secret');
  const body = JSON.stringify({ ticket: 'ZZ-9', label: 'urgent', nested: { x: 1 } });
  assert.equal((await post(hook.url!, null, body)).status, 401);
  assert.equal((await post(hook.url!, hook.secret, body, { sig: 'sha256=00' })).status, 401);
  const stale = await post(hook.url!, hook.secret, body, { ts: Math.floor(Date.now() / 1000) - 3600 });
  assert.equal(stale.status, 401); assert.match(String(stale.body?.error), /five minutes/);
  assert.equal((await post(hook.url!, hook.secret, body, { method: 'GET' })).status, 405);
  assert.equal((await post(hook.url!.replace(a.id, 'nonexistent'), hook.secret, body)).status, 401);
  assert.equal((await post(hook.url!, hook.secret, 'x'.repeat(70_000))).status, 413);
  const ts = Math.floor(Date.now() / 1000), sig = signWebhook(hook.secret, ts, body);
  const ok = await post(hook.url!, hook.secret, body, { ts, sig });
  assert.equal(ok.status, 202); assert.equal(ok.body?.status, 'started');
  const again = await post(hook.url!, hook.secret, body, { ts, sig });
  assert.equal(again.status, 409);
  const run = await until(async () => (await h.s.invoke('automations.runs', { id: a.id })).find(r => r.trigger === 'webhook' && r.status === 'completed'), 'the webhook run');
  assert.deepEqual(run.variables, { ticket: 'ZZ-9', label: 'urgent' });
  assert.equal((await tasksOf(h))[0]!.title, 'Triage ZZ-9');
  // A missing required variable is a clear 422, not a silent run.
  const bad = JSON.stringify({ other: 1 }), r2 = await post(hook.url!, hook.secret, bad);
  assert.equal(r2.status, 422); assert.match(String(r2.body?.reason), /needs a value for ticket/);
  // Rotating makes the old secret useless.
  const rotated = await h.s.invoke('automations.webhook.rotate', { id: a.id });
  assert.equal((await post(hook.url!, hook.secret, JSON.stringify({ ticket: 'A' }))).status, 401);
  assert.equal((await post(rotated.url!, rotated.secret, JSON.stringify({ ticket: 'A' }))).status, 202);
  // Paused: it answers like an unknown automation.
  await h.s.invoke('automations.pause', { id: a.id });
  await assert.rejects(post(rotated.url!, rotated.secret, JSON.stringify({ ticket: 'B' })), 'with nothing to listen for, the listener is closed');
  const other = await h.s.invoke('automations.create', base(h, { name: 'Other', prompt: 'Other {{ticket}}', ext: ext({ webhook: true, variables: [{ name: 'ticket', default: 'q' }] }) }));
  const otherHook = await h.s.invoke('automations.webhook.rotate', { id: other.id });
  assert.equal((await post(rotated.url!.replace(/:\d+\//, `:${new URL(otherHook.url!).port}/`), rotated.secret, JSON.stringify({ ticket: 'B' }))).status, 401, 'a paused automation answers like an unknown one');
  // No file in the data directory holds the secret.
  const scan = (dir: string): string[] => readdirSync(dir).flatMap(f => { const p = join(dir, f); return statSync(p).isDirectory() ? scan(p) : readFileSync(p).includes(rotated.secret) || readFileSync(p).includes(hook.secret) ? [p] : []; });
  assert.deepEqual(scan(h.dataDir), []);
  assert.ok(createHmac('sha256', 'k') && verifyWebhook(rotated.secret, String(ts), signWebhook(rotated.secret, ts, 'x'), 'x', ts * 1000) === 'ok');
  assert.deepEqual(variablesFromBody('[1,2]'), {}); assert.deepEqual(variablesFromBody('not json'), {});
});

test('G20: with secure storage missing the webhook secret is refused rather than stored in plain text', async t => {
  automationTiming.secrets = () => ({ secureStorage: () => false, set() { throw new Error('no'); }, get: () => undefined, clear() {} });
  const h = await wave2(t);
  const a = await h.s.invoke('automations.create', base(h, { prompt: 'Look at {{ticket}}.', ext: ext({ webhook: true, variables: [{ name: 'ticket', default: 'x' }] }) }));
  await assert.rejects(h.s.invoke('automations.webhook.rotate', { id: a.id }), /no secure keychain/);
  const off = await h.s.invoke('automations.create', base(h, { prompt: 'Look at {{ticket}}.', ext: ext({ variables: [{ name: 'ticket', default: 'x' }] }) }));
  await assert.rejects(h.s.invoke('automations.webhook.rotate', { id: off.id }), /Turn the webhook trigger on/);
});

test('G20: the approval gate holds automatic firings for you in the Inbox, approving starts the run once, declining skips it, and Run now needs no approval', async t => {
  automationTiming.webhookPort = 0; const secrets = memorySecrets(); automationTiming.secrets = () => secrets;
  const h = await wave2(t);
  const a = await h.s.invoke('automations.create', base(h, { name: 'Gated', prompt: 'Look at {{ticket}}.', ext: ext({ webhook: true, approval: true, variables: [{ name: 'ticket', default: 'T-1' }] }) }));
  const hook = await h.s.invoke('automations.webhook.rotate', { id: a.id });
  const fire = (ticket: string) => post(hook.url!, hook.secret, JSON.stringify({ ticket }));
  const held = await fire('T-2');
  assert.equal(held.status, 202); assert.equal(held.body?.status, 'awaiting');
  assert.equal((await tasksOf(h)).length, 0, 'nothing started before approval');
  const gates = (await h.s.invoke('automations.gate.list', {})).items;
  assert.equal(gates.length, 1); assert.equal(gates[0]!.automationName, 'Gated'); assert.match(gates[0]!.summary, /Webhook .*ticket: T-2/);
  const overlay = await h.s.invoke('work.overlay', {});
  assert.deepEqual(overlay.inbox.map(i => [i.id, i.kind, i.projectId]), [[`gate:${gates[0]!.id}`, 'approval', h.project.id]]);
  assert.equal((await h.s.invoke('automations.list', undefined))[0]!.awaiting, 1);
  // A second firing while one waits is skipped, not stacked.
  assert.equal((await fire('T-3')).body?.status, 'skipped');
  const approved = await h.s.invoke('automations.gate.decide', { id: gates[0]!.id, approve: true });
  assert.equal(approved.ok, true);
  const run = await until(async () => (await h.s.invoke('automations.runs', { id: a.id })).find(r => r.status === 'completed'), 'the approved run');
  assert.equal((await tasksOf(h)).filter(x => x.title === 'Triage T-2').length, 1);
  assert.equal(run.variables?.ticket, 'T-2');
  await assert.rejects(h.s.invoke('automations.gate.decide', { id: gates[0]!.id, approve: true }), /already decided/);
  assert.equal((await h.s.invoke('automations.gate.list', {})).items.length, 0);
  // Declined: skipped, nothing created.
  await fire('T-4');
  const g2 = (await h.s.invoke('automations.gate.list', {})).items[0]!;
  await h.s.invoke('automations.gate.decide', { id: g2.id, approve: false });
  const runs = await h.s.invoke('automations.runs', { id: a.id });
  assert.ok(runs.some(r => r.status === 'skipped' && r.reason === 'Declined by you.'));
  assert.equal((await tasksOf(h)).filter(x => x.title === 'Triage T-4').length, 0);
  // Run now is you: no gate.
  const manual = await h.s.invoke('automations.runNow', { id: a.id });
  assert.notEqual(manual.status, 'awaiting');
});

test('G20: the activity gate skips a firing at no cost when nothing changed since the last run ended, and fires again after real activity', async t => {
  automationTiming.webhookPort = 0; const secrets = memorySecrets(); automationTiming.secrets = () => secrets;
  const h = await wave2(t);
  const a = await h.s.invoke('automations.create', base(h, { name: 'Quiet', prompt: 'Report.', ext: ext({ webhook: true, activityGate: true }), target: { kind: 'task', projectId: h.project.id, start: false, mode: 'task', titleTemplate: 'Report {{automation}}' } }));
  const hook = await h.s.invoke('automations.webhook.rotate', { id: a.id });
  const fire = (n: number) => post(hook.url!, hook.secret, JSON.stringify({ n }));
  assert.equal((await fire(1)).body?.status, 'started');
  await until(async () => (await h.s.invoke('automations.runs', { id: a.id })).find(r => r.status === 'completed'), 'the first run');
  await h.wait(250); // its end-of-run snapshot
  const quiet = await fire(2);
  assert.equal(quiet.body?.status, 'skipped'); assert.match(String(quiet.body?.reason), /Nothing changed since the last run/);
  assert.equal((await tasksOf(h)).length, 1, 'no second task was made');
  await h.addTask('A real change', { kind: 'user', id: 'local' });
  assert.equal((await fire(3)).body?.status, 'started');
  await until(async () => (await tasksOf(h)).filter(x => x.title.startsWith('Report')).length === 2, 'the run after activity');
  // Run now is explicit, so it never skips.
  await h.wait(250);
  const manual = await h.s.invoke('automations.runNow', { id: a.id });
  assert.notEqual(manual.status, 'skipped');
});

test('G3: the four templates are real automations that save and carry the right gates; the standup asks every Roster agent and writes one digest into its task', async t => {
  const h = await wave2(t);
  const templates = (await h.s.invoke('automations.templates', {})).templates;
  assert.deepEqual(templates.map(x => x.id), ['daily-standup', 'weekly-learnings', 'ci-health', 'project-digest']);
  for (const tpl of AUTOMATION_TEMPLATES) {
    const saved = await h.s.invoke('automations.create', { name: tpl.name, prompt: tpl.prompt, schedule: tpl.schedule, timezone: 'UTC', permissionMode: 'workspace', overlap: 'skip', catchUp: 'none', target: { ...tpl.target, projectId: h.project.id }, ext: tpl.ext });
    assert.equal(saved.target.kind, 'task'); assert.equal(saved.ext.activityGate, true);
    await h.s.invoke('automations.delete', { id: saved.id });
  }
  await assert.rejects(h.s.invoke('automations.create', { name: 'Standup', prompt: 'x', schedule: { kind: 'interval', minutes: 60 }, timezone: 'UTC', permissionMode: 'workspace', overlap: 'skip', catchUp: 'none', target: { kind: 'task', projectId: h.project.id, start: false, mode: 'standup' } }), /has to start them/);
  // Standup with two agents.
  await h.member('CTO'); await h.member('QA');
  h.sayWhen(/Standup for/, input => `Yesterday: shipped. Today: next. Blockers: none. (${input.chat.title})`);
  const standup = AUTOMATION_TEMPLATES[0]!;
  const a = await h.s.invoke('automations.create', { name: standup.name, prompt: standup.prompt, schedule: standup.schedule, timezone: 'UTC', permissionMode: 'workspace', overlap: 'skip', catchUp: 'none', target: { ...standup.target, projectId: h.project.id }, ext: ext() });
  const run = await h.s.invoke('automations.runNow', { id: a.id });
  const done = (await until(async () => (await h.s.invoke('automations.runs', { id: a.id })).find(r => r.id === run.id && ['completed', 'failed'].includes(r.status)), 'the standup digest', 40_000));
  assert.equal(done.status, 'completed', done.reason ?? '');
  assert.match(done.reason ?? '', /Digest ready in OSS-\d+/);
  const tasks = await tasksOf(h), parent = tasks.find(x => x.id === done.taskId)!;
  assert.match(parent.title, /^Daily standup \d{4}-\d{2}-\d{2}$/);
  const kids = tasks.filter(x => x.parentId === parent.id);
  assert.deepEqual(kids.map(k => k.title).sort(), ['Standup · CTO', 'Standup · QA']);
  assert.equal(parent.state, 'review');
  assert.match(parent.acceptance, /## CTO\n\nYesterday: shipped\./); assert.match(parent.acceptance, /## QA\n\nYesterday: shipped\./);
  const doc = await h.s.invoke('work.docs.get', { projectId: h.project.id, taskId: parent.id, key: 'digest' });
  assert.match(doc.text, /## CTO/); assert.match(doc.text, /## QA/);
  assert.ok(kids.every(k => k.attempts.length === 1));
});

test('G3: a standup in a project with no agents says so', async t => {
  const h = await wave2(t);
  const standup = AUTOMATION_TEMPLATES[0]!;
  const a = await h.s.invoke('automations.create', { name: 'Standup', prompt: standup.prompt, schedule: standup.schedule, timezone: 'UTC', permissionMode: 'workspace', overlap: 'skip', catchUp: 'none', target: { ...standup.target, projectId: h.project.id }, ext: ext() });
  const run = await h.s.invoke('automations.runNow', { id: a.id });
  const failed = await until(async () => (await h.s.invoke('automations.runs', { id: a.id })).find(r => r.id === run.id && r.status === 'failed'), 'the failure');
  assert.match(failed.reason ?? '', /no agents on its Roster/);
});
