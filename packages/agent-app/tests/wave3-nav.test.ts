/** Wave 3 renderer models: C3 shortcuts, C34 palette commands, C20/G31 setup, C26 runs, G36 routine items. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHEATSHEET, CHORD_MS, GO_KEYS, IDLE, readShortcutsEnabled, resolveShortcut, shortcutsApplyOn, stepRow, writeShortcutsEnabled, type ShortcutKey } from '../src/renderer/shortcuts.ts';
import { COMMANDS, commandRows, commandState, type CommandContext } from '../src/renderer/commandPalette.ts';
import { AGENT_TEMPLATES, SETUP_STEPS, describeOp, launchLines, needsSetup } from '../src/renderer/setupModel.ts';
import { RUN_WINDOW_LABEL, countOutcomes, filterRuns, isRoutineTrigger, outcomeOf, readHideRoutine, writeHideRoutine } from '../src/renderer/runsModel.ts';
import { buildActivity } from '../src/renderer/inboxModel.ts';
import type { WorkspaceRun, WorkspaceSnapshot } from '../src/shared/domains/paperclip-protocol.ts';

const key = (k: string, over: Partial<ShortcutKey> = {}): ShortcutKey => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, typing: false, blocked: false, ...over });

test('C3: bare keys map to actions; a g chord goes to a page within 1.2 s; modifiers, typing, dialogs and repeats never fire', () => {
  const t0 = 1_000_000;
  assert.equal(resolveShortcut(IDLE, key('c'), t0).action, 'new-task');
  assert.equal(resolveShortcut(IDLE, key('/'), t0).action, 'search');
  assert.equal(resolveShortcut(IDLE, key('?', { shiftKey: true }), t0).action, 'cheatsheet');
  assert.equal(resolveShortcut(IDLE, key('['), t0).action, 'toggle-sidebar');
  assert.equal(resolveShortcut(IDLE, key('j'), t0).action, 'next-row');
  assert.equal(resolveShortcut(IDLE, key('k'), t0).action, 'prev-row');
  // g arms the chord and consumes the key; the next letter chooses the page.
  const armed = resolveShortcut(IDLE, key('g'), t0);
  assert.deepEqual([armed.action, armed.consume, armed.next.armedAt], [null, true, t0]);
  for (const [letter, action] of Object.entries(GO_KEYS)) assert.equal(resolveShortcut(armed.next, key(letter), t0 + 100).action, action, letter);
  assert.equal(resolveShortcut(armed.next, key('i'), t0 + CHORD_MS).action, 'go-inbox');
  // Too late: the letter is just a letter again (i is nothing), and c is a new task, not a page.
  assert.equal(resolveShortcut(armed.next, key('i'), t0 + CHORD_MS + 1).action, null);
  assert.equal(resolveShortcut(armed.next, key('c'), t0 + CHORD_MS + 1).action, 'new-task');
  // An unrelated key after g ends the chord and means what it means: g then j moves a row.
  const jump = resolveShortcut(armed.next, key('j'), t0 + 50);
  assert.equal(jump.action, 'next-row'); assert.equal(jump.next.armedAt, null);
  // g c while armed is the comment box, not a new task.
  assert.equal(resolveShortcut(armed.next, key('c'), t0 + 50).action, 'focus-comment');
  // Never while typing, in a dialog or menu, with a modifier, composing, repeating or already handled.
  for (const over of [{ typing: true }, { blocked: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true }, { isComposing: true }, { defaultPrevented: true }]) assert.equal(resolveShortcut(IDLE, key('c', over), t0).consume, false, JSON.stringify(over));
  assert.equal(resolveShortcut(IDLE, key('c', { repeat: true }), t0).consume, false);
  assert.equal(resolveShortcut(IDLE, key('x'), t0).consume, false);
  assert.equal(resolveShortcut(IDLE, key('C', { shiftKey: true }), t0).consume, false);
  // The chat screen keeps its plain letters.
  assert.deepEqual(['hub', 'projects', 'work', 'settings', 'automations'].map(shortcutsApplyOn), [true, true, false, false, false]);
});

test('C3: rows step without wrapping and from nothing land on the first or last; the cheatsheet lists every chord once and the preference defaults on', () => {
  assert.equal(stepRow(0, -1, 'next-row'), -1);
  assert.equal(stepRow(5, -1, 'next-row'), 0); assert.equal(stepRow(5, -1, 'prev-row'), 4);
  assert.equal(stepRow(5, 4, 'next-row'), 4); assert.equal(stepRow(5, 0, 'prev-row'), 0); assert.equal(stepRow(5, 2, 'next-row'), 3);
  const chords = CHEATSHEET.flatMap(s => s.entries).filter(e => e.then).map(e => e.keys[1]);
  assert.deepEqual([...chords].sort(), Object.keys(GO_KEYS).sort());
  assert.ok(CHEATSHEET.some(s => s.title === 'Inbox' && s.entries.some(e => e.keys[0] === 'r')));
  const store = new Map<string, string>(); const mem = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  assert.equal(readShortcutsEnabled(mem), true); assert.equal(readShortcutsEnabled(undefined), true);
  writeShortcutsEnabled(mem, false); assert.equal(readShortcutsEnabled(mem), false);
  writeShortcutsEnabled(mem, true); assert.equal(readShortcutsEnabled(mem), true);
  assert.equal(readShortcutsEnabled({ getItem() { throw new Error('blocked'); } }), true);
});

const ctx = (over: Partial<CommandContext> = {}): CommandContext => ({ screen: 'work', draftOpen: false, chat: null, canBack: false, canForward: false, slotTitles: [], chatCount: 0, ...over });
test('C34: the palette lists page jumps and New task, with a reason when there is no project to put a task in', () => {
  const ids = ['new-task', 'go-inbox', 'go-dashboard', 'go-tasks', 'go-roster', 'go-outputs', 'go-ledger', 'go-costs', 'show-shortcuts'] as const;
  for (const id of ids) assert.ok(COMMANDS.some(c => c.id === id), id);
  assert.equal(commandState('go-inbox', ctx()).enabled, true);
  assert.equal(commandState('new-task', ctx()).enabled, true);
  assert.equal(commandState('new-task', ctx({ projectCount: 2 })).enabled, true);
  const none = commandState('new-task', ctx({ projectCount: 0 }));
  assert.deepEqual([none.enabled, /Create a project first/.test(none.reason ?? '')], [false, true]);
  assert.equal(commandRows('inbox', ctx())[0]!.command.id, 'go-inbox');
  assert.equal(commandRows('spend', ctx())[0]!.command.id, 'go-costs');
  assert.equal(commandRows('keys', ctx())[0]!.command.id, 'show-shortcuts');
  assert.equal(COMMANDS.find(c => c.id === 'go-inbox')!.shortcut, 'g i');
  assert.equal(new Set(COMMANDS.map(c => c.id)).size, COMMANDS.length);
});

test('C20/G31: starter agents, the empty-project test, the launch summary and one readable line per proposed change', () => {
  assert.deepEqual(SETUP_STEPS.map(s => s.id), ['mission', 'team', 'first', 'launch']);
  assert.deepEqual(AGENT_TEMPLATES.map(t => t.id), ['chief', 'engineer', 'researcher', 'reviewer']);
  assert.ok(AGENT_TEMPLATES.every(t => t.name && t.title && t.instructions.length > 80 && t.instructions.length < 1200));
  assert.equal(needsSetup({ tasks: 0, agents: 0 }), true); assert.equal(needsSetup({ tasks: 1, agents: 0 }), false); assert.equal(needsSetup({ tasks: 0, agents: 1 }), false);
  assert.deepEqual(launchLines({ goal: false, agents: [], task: null, interview: false }).length, 2);
  const full = launchLines({ goal: true, agents: ['A', 'B'], task: 'OSS-1 · Plan', interview: true });
  assert.match(full[1]!, /Agents on the Roster: A, B/); assert.match(full[2]!, /OSS-1 · Plan/); assert.match(full[3]!, /Coordinator/);
  assert.match(describeOp({ op: 'goal', text: 'Ship it.' }), /^Mission: “Ship it\.”/);
  assert.match(describeOp({ op: 'create', title: 'Write the plan', owner: 'user' }), /Add task “Write the plan” \(yours\)/);
  assert.match(describeOp({ op: 'status', id: 'abc', state: 'review' }), /Move task abc to review/);
  assert.match(describeOp({ op: 'decision', title: 'Use SQLite' }), /Record the decision/);
  assert.ok(describeOp({ op: 'create', title: 'x'.repeat(500) }).length < 130);
});

const run = (over: Partial<WorkspaceRun> & { id: string }): WorkspaceRun => ({ agentId: 'a1', taskId: null, status: 'succeeded', trigger: 'user', source: 'local', createdAt: '2026-10-10T10:00:00Z', startedAt: '2026-10-10T10:00:00Z', finishedAt: '2026-10-10T10:05:00Z', error: null, cancellable: false, ...over });
test('C26: runs filter by window, outcome and agent, newest first, with counts per outcome', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  const runs = [run({ id: 'new' }), run({ id: 'old', startedAt: '2026-10-01T10:00:00Z', createdAt: '2026-10-01T10:00:00Z' }), run({ id: 'bad', status: 'failed', agentId: 'a2', startedAt: '2026-10-10T11:00:00Z' }), run({ id: 'live', status: 'running', startedAt: '2026-10-10T11:30:00Z' }), run({ id: 'stop', status: 'cancelled', startedAt: '2026-10-09T11:30:00Z' }), run({ id: 'to', status: 'timed_out', startedAt: '2026-10-09T10:30:00Z' })];
  const ids = (f: Parameters<typeof filterRuns>[1]) => filterRuns(runs, f, now).map(r => r.id);
  assert.deepEqual(ids({ window: '24h', outcome: 'all', agentId: '' }), ['live', 'bad', 'new']);
  assert.deepEqual(ids({ window: '7d', outcome: 'all', agentId: '' }), ['live', 'bad', 'new', 'stop', 'to']);
  assert.deepEqual(ids({ window: 'all', outcome: 'all', agentId: '' }), ['live', 'bad', 'new', 'stop', 'to', 'old']);
  assert.deepEqual(ids({ window: 'all', outcome: 'failed', agentId: '' }), ['bad', 'to']);
  assert.deepEqual(ids({ window: 'all', outcome: 'active', agentId: '' }), ['live']);
  assert.deepEqual(ids({ window: 'all', outcome: 'other', agentId: '' }), ['stop']);
  assert.deepEqual(ids({ window: 'all', outcome: 'all', agentId: 'a2' }), ['bad']);
  assert.deepEqual(countOutcomes(runs), { all: 6, active: 1, succeeded: 2, failed: 2, other: 1 });
  assert.equal(outcomeOf({ status: 'queued' }), 'active'); assert.equal(outcomeOf({ status: 'interrupted' }), 'other');
  assert.equal(RUN_WINDOW_LABEL['30d'], 'Last 30 days');
});

test('G36: items from automations, timers and heartbeats are marked routine and can be hidden; the choice is remembered', () => {
  for (const t of ['automation', 'Routine', 'heartbeat', 'timer', 'schedule', 'cron:daily', 'webhook', 'watchdog', 'monitor']) assert.equal(isRoutineTrigger(t), true, t);
  for (const t of ['user', 'assignment', 'mention', 'task', null, undefined]) assert.equal(isRoutineTrigger(t), false, String(t));
  const at = '2026-10-10T10:00:00Z';
  const ws = { paperclip: null, tasks: [], agents: [], projects: [], goals: [], fetchedAt: at, counts: { liveRuns: 0, inbox: 2, failedRuns: 2, openTasks: 0 },
    runs: [run({ id: 'r1', trigger: 'heartbeat', status: 'failed' }), run({ id: 'r2', trigger: 'user', status: 'failed' })],
    inbox: [{ id: 'i1', kind: 'failed_run', title: 'Heartbeat failed', why: 'x', severity: 'medium', at, taskId: null, agentId: null, runId: 'r1' }, { id: 'i2', kind: 'failed_run', title: 'You ran it', why: 'x', severity: 'medium', at, taskId: null, agentId: null, runId: 'r2' }, { id: 'i3', kind: 'approval', title: 'No run', why: 'x', severity: 'medium', at, taskId: null, agentId: null, runId: null }] } as unknown as WorkspaceSnapshot;
  const items = buildActivity(null, ws, Date.parse(at));
  assert.deepEqual(items.filter(i => i.routine).map(i => i.title), ['Heartbeat failed']);
  assert.equal(items.length, 3);
  const store = new Map<string, string>(); const mem = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  assert.equal(readHideRoutine(mem), false); writeHideRoutine(mem, true); assert.equal(readHideRoutine(mem), true); writeHideRoutine(mem, false); assert.equal(readHideRoutine(mem), false);
  assert.equal(readHideRoutine(undefined), false);
});
