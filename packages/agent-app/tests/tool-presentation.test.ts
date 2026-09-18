import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyTool, commandLabel } from '../src/renderer/components/toolPresentation.ts';

test('classifies explicit provider item types', () => {
  assert.deepEqual(classifyTool({type: 'fileRead', name: 'src/runtime/service.ts'}),
    {kind: 'read', verb: 'Read', runningVerb: 'Reading', subject: 'src/runtime/service.ts'});
  assert.deepEqual(classifyTool({type: 'webSearch', name: 'electron csp'}),
    {kind: 'search', verb: 'Searched', runningVerb: 'Searching', subject: 'electron csp'});
  assert.equal(classifyTool({type: 'todoList'}).kind, 'list');
  assert.equal(classifyTool({type: 'collabAgentToolCall', name: 'reviewer'}).kind, 'subagent');
  assert.equal(classifyTool({type: 'mcpToolCall', name: 'browser.navigate'}).kind, 'mcp');
});

test('commands stay commands even when text looks like a file read', () => {
  const p = classifyTool({type: 'commandExecution', name: 'cat src/main/index.ts'});
  assert.equal(p.kind, 'command');
  assert.equal(p.subject, 'cat src/main/index.ts');
});

test('unknown or missing types fall back to honest generic', () => {
  assert.equal(classifyTool({type: 'imageGeneration', name: 'x'}).kind, 'generic');
  assert.equal(classifyTool({type: 42 as unknown as string, name: 'x'}).kind, 'generic');
  assert.equal(classifyTool(undefined).kind, 'generic');
  assert.equal(classifyTool({}).kind, 'generic');
});

test('non-string name yields empty subject, never fabricated', () => {
  assert.equal(classifyTool({type: 'fileRead', name: {path: 'a'} as unknown as string}).subject, '');
  assert.equal(classifyTool({type: 'fileRead'}).subject, '');
});

test('commandLabel unwraps shell -c and quotes, leaves plain commands alone', () => {
  assert.equal(commandLabel(`/bin/zsh -lc 'ls -la'`), 'ls -la');
  assert.equal(commandLabel('bash -c "make build"'), 'make build');
  assert.equal(commandLabel('git status'), 'git status');
  assert.equal(commandLabel(`sh -c 'echo "a'`), `echo "a`);
});
