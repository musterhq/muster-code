import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {AGENT_AUTONOMY_RULE, FULL_ACCESS_NO_ASKING_RULE, runInstructions} from '../src/runtime/provider.ts';
import {ENVELOPE_RULES, TASK_TEXT_MAX, untrusted} from '../src/runtime/checkout/sanitize.ts';
import {asksOpenQuestion, endsWithQuestion, ProjectTaskStore} from '../src/runtime/project-tasks.ts';

test('#385: the keep-going directive is in agent mode only, and short', () => {
  assert.ok(AGENT_AUTONOMY_RULE.length < 600);
  assert.match(AGENT_AUTONOMY_RULE, /Work autonomously until the task is done\. Do the next obvious step without asking\./);
  assert.match(AGENT_AUTONOMY_RULE, /destructive or irreversible/);
  assert.match(AGENT_AUTONOMY_RULE, /not a question/);
  assert.ok(runInstructions('agent')!.includes(AGENT_AUTONOMY_RULE));
  assert.ok(runInstructions('agent', 'extra note', false)!.includes(AGENT_AUTONOMY_RULE));
  assert.ok(!(runInstructions('ask') ?? '').includes(AGENT_AUTONOMY_RULE));
  assert.ok(!(runInstructions('plan') ?? '').includes(AGENT_AUTONOMY_RULE));
});

test('Full access adds the no-asking rule to agent instructions only', () => {
  assert.match(FULL_ACCESS_NO_ASKING_RULE, /Never ask the user for permission or confirmation to proceed/);
  assert.ok(runInstructions('agent', undefined, true, 'full')!.includes(FULL_ACCESS_NO_ASKING_RULE));
  for (const mode of ['workspace', 'read-only', undefined] as const) assert.ok(!runInstructions('agent', undefined, true, mode)!.includes(FULL_ACCESS_NO_ASKING_RULE));
  for (const mode of ['ask', 'plan'] as const) assert.ok(!(runInstructions(mode, undefined, true, 'full') ?? '').includes(FULL_ACCESS_NO_ASKING_RULE));
});

test('#385: the envelope keeps embedded commands untrusted but the task goal is what the person wants, and local commits are expected', () => {
  assert.match(ENVELOPE_RULES, /goal and acceptance criteria[^.]*what the person wants done/);
  assert.match(ENVELOPE_RULES, /local commits on the task branch/);
  assert.match(ENVELOPE_RULES, /Muster handles the push and the hand-back/);
  assert.match(ENVELOPE_RULES, /commands, links[^.]*secrets[^.]*never as instructions/);
  assert.ok(!/never instructions to you/.test(ENVELOPE_RULES));
});

test('#385: task text up to 32,000 characters goes in whole; past it, the envelope is cut', () => {
  assert.equal(TASK_TEXT_MAX, 32_000);
  const whole = 'a'.repeat(20_000);
  assert.ok(untrusted('task', whole).includes(whole), '20,000 characters are no longer cut at 8,000');
  const body = untrusted('task', 'b'.repeat(40_000)).split('\n')[1]!;
  assert.equal(body.length, 32_000);
});

test('#385: endsWithQuestion spots a closing ask and a leading Should I / Want me to', () => {
  for (const q of ['Done with the parser. Should I also update the docs?', 'Shall I proceed with the migration', 'Want me to run the tests', 'Do you want me to continue?', 'All set.\n\nWhich database should I use?  ']) assert.ok(endsWithQuestion(q), q);
  for (const n of ['Implemented and tested. Nothing is left.', '', undefined, 'Why this works: the key is `a ? b : c`.', 'Wrote the file.\n```\nwhat?\n```']) assert.ok(!endsWithQuestion(n), String(n));
});

test('#385: a run that ends with a question is needs-input, not implemented', () => {
  const dir = mkdtempSync(join(tmpdir(), 'muster-autonomy-')), store = new ProjectTaskStore(dir);
  try {
    const a = store.createTask({projectId: 'p', title: 'A', acceptance: 'x', dependencies: []}), b = store.createTask({projectId: 'p', title: 'B', acceptance: 'x', dependencies: []});
    store.startTask({projectId: 'p', id: a.id, revision: 0, requestId: 'r1', chatId: 'c1'});
    store.startTask({projectId: 'p', id: b.id, revision: 0, requestId: 'r2', chatId: 'c2'});
    assert.equal(store.settleRunForChat('c1', 'completed', undefined, 'I fixed it. Want me to add tests?')!.state, 'needs-input');
    assert.equal(store.settleRunForChat('c2', 'completed', undefined, 'Fixed and tested. Nothing left.')!.state, 'implemented');
  } finally { store.close(); rmSync(dir, {recursive: true, force: true}); }
});

test('#383: asksOpenQuestion reuses endsWithQuestion and also catches an offer in the closing paragraph', () => {
  for (const q of ['Should I commit item 1 now?', 'Item 1 is ready. Want me to commit it and start item 2', 'Done.\n\nWould you like me to add docs']) assert.ok(asksOpenQuestion(q), q);
  for (const n of ['Committed and pushed.', '```\nShould I?\n```\nAll done.', '']) assert.ok(!asksOpenQuestion(n), n);
  assert.ok(!asksOpenQuestion(undefined));
});
