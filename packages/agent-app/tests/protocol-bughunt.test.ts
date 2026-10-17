import assert from 'node:assert/strict';
import {test} from 'node:test';
import {LocalWorkspace} from '../src/runtime/workspace-local.ts';

test('creating a task ignores a priority that is an Object.prototype key', async () => {
  const added: Array<Record<string, unknown>> = [];
  const invoke = (async (command: string, input: Record<string, unknown>) => {
    if (command === 'project.list') return [{id: 'p1', archived: false}];
    if (command === 'project.tasks.add') { added.push(input); throw new Error('stop'); }
    throw new Error(`unexpected ${command}`);
  }) as never;
  const workspace = new LocalWorkspace(invoke, () => ({repo: null, cwd: null}));
  for (const priority of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    await workspace.createTask({title: 'T', priority} as never).catch(() => undefined);
  }
  assert.equal(added.length, 4);
  for (const call of added) assert.equal(typeof call.priority, 'undefined', String(call.priority));
});
