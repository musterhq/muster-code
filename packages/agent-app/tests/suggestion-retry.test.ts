import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InteractionStore } from '../src/runtime/governance/interactions.ts';
import { createTaskTools, type TaskToolDeps } from '../src/runtime/governance/task-tools.ts';
import { ProjectTaskStore } from '../src/runtime/project-tasks.ts';

for (const failure of ['second task', 'suggestion save'] as const) {
  test(`suggested task retry after ${failure} failure creates each item once`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'suggestion-retry-'));
    let tasks = new ProjectTaskStore(dir);
    let store = new InteractionStore(dir);
    t.after(() => { tasks.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
    const parent = tasks.createTask({ projectId: 'p', title: 'Parent', acceptance: '', dependencies: [] });
    const suggestion = store.addSuggestion({ projectId: 'p', taskId: parent.id, memberId: null, memberName: 'Agent', items: ['First', 'Second'].map(title => ({ title, acceptance: '', assignee: null, priority: null })) });
    const tools = createTaskTools({
      tasks: () => tasks, store: () => store, exists: () => true,
      keyOf: () => 'P-1', record: () => {}, changed: () => {}, onAssigned: () => {},
    } as unknown as TaskToolDeps);
    const createTask = tasks.createTask.bind(tasks), save = store.saveSuggestion.bind(store);
    if (failure === 'second task') tasks.createTask = (input, actor) => {
      if (input.title === 'Second') throw new Error('Injected failure');
      return createTask(input, actor);
    };
    else store.saveSuggestion = () => { throw new Error('Injected failure'); };
    const create = () => tools.handlers['project.suggestions.create']({ projectId: 'p', id: suggestion.id });
    assert.throws(create, /Injected failure/);
    if (failure === 'second task') assert.equal(tasks.listTasks('p').items.length, 1, 'failed batch must roll back all children');
    tasks.createTask = createTask; store.saveSuggestion = save;
    // A retry may arrive after restarting: keys must survive reopening both stores.
    tasks.close(); store.close();
    tasks = new ProjectTaskStore(dir); store = new InteractionStore(dir);
    const result = create();
    const children = tasks.listTasks('p').items.filter(task => task.parentId === parent.id);
    assert.equal(children.length, 2, 'retry must not duplicate a previously created task');
    assert.equal(new Set(result.items.map(item => item.created)).size, 2);
    assert.equal(result.state, 'done');
    if (failure === 'second task') assert.equal(children[0]!.seq! + children[1]!.seq!, 5, 'failed batch must roll back task sequence allocation');
  });
}

test('a suggested task deleted before the retry is created again instead of failing every retry', t => {
  const dir = mkdtempSync(join(tmpdir(), 'suggestion-retry-'));
  const tasks = new ProjectTaskStore(dir), store = new InteractionStore(dir);
  t.after(() => { tasks.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const parent = tasks.createTask({ projectId: 'p', title: 'Parent', acceptance: '', dependencies: [] });
  const suggestion = store.addSuggestion({ projectId: 'p', taskId: parent.id, memberId: null, memberName: 'Agent', items: ['First', 'Second'].map(title => ({ title, acceptance: '', assignee: null, priority: null })) });
  const tools = createTaskTools({
    tasks: () => tasks, store: () => store, exists: () => true,
    keyOf: () => 'P-1', record: () => {}, changed: () => {}, onAssigned: () => {},
  } as unknown as TaskToolDeps);
  const save = store.saveSuggestion.bind(store);
  store.saveSuggestion = () => { throw new Error('Injected failure'); };
  const create = () => tools.handlers['project.suggestions.create']({ projectId: 'p', id: suggestion.id });
  assert.throws(create, /Injected failure/);
  store.saveSuggestion = save;
  const first = tasks.listTasks('p').items.find(task => task.title === 'First')!;
  tasks.deleteTask({ projectId: 'p', id: first.id, revision: first.revision });
  const result = create();
  const children = tasks.listTasks('p').items.filter(task => task.parentId === parent.id);
  assert.deepEqual(children.map(task => task.title).sort(), ['First', 'Second']);
  assert.equal(result.state, 'done');
  assert.ok(!children.some(task => task.id === first.id), 'the deleted task stays deleted');
});
