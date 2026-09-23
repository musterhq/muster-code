import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyTool, commandLabel, commandOutcome, diffStats, fileStats, planSteps, planText, resolveToolPath, formatToolDuration, uniqueFileLabels } from '../src/renderer/components/toolPresentation.ts';

test('classifies explicit provider item types', () => {
  assert.deepEqual(classifyTool({type: 'fileRead', name: 'src/runtime/service.ts'}),
    {kind: 'read', verb: 'Read', runningVerb: 'Reading', subject: 'src/runtime/service.ts', paths: ['src/runtime/service.ts']});
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

test('edit rows count +/- from unified patches, ignoring file and hunk headers', () => {
  assert.deepEqual(diffStats('--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,3 @@\n-old\n+new\n+++counter;\n context'), {adds: 2, dels: 1}, 'a +++ line inside a hunk is content');
  assert.deepEqual(diffStats('+one\n+two\n-three'), {adds: 2, dels: 1}, 'bare patches without hunks still count');
  assert.deepEqual(diffStats('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/c b/c\n--- a/c\n+++ b/c\n@@ -0,0 +1 @@\n+c'), {adds: 2, dels: 1});
  const p = classifyTool({type: 'fileChange', changes: [{path: 'src/Foo.tsx', diff: '@@ -1 +1,8 @@\n-a\n+1\n+2\n+3\n+4\n+5\n+6\n+7\n+8'}, {path: 'src/Foo.tsx', diff: '+9'}, {path: 'b.css', diff: '-x'}]});
  assert.equal(p.kind, 'edit'); assert.equal(p.adds, 9); assert.equal(p.dels, 2);
  assert.deepEqual(p.files, [{path: 'src/Foo.tsx', adds: 9, dels: 1}, {path: 'b.css', adds: 0, dels: 1}]);
  assert.deepEqual(fileStats({changes: [{path: 'x'}]}), [{path: 'x', adds: 0, dels: 0}], 'missing patch reports zero, never invented');
});

test('command outcomes keep the verb, add exit/duration, and excerpt the last two failure lines', () => {
  const ok = commandOutcome({exitCode: 0, durationMs: 1800}, 'completed', 'done');
  assert.deepEqual(ok, {exitCode: 0, duration: '1.8s', failed: false, suffix: '', excerpt: []});
  const failed = commandOutcome({exitCode: 1, durationMs: 64000}, 'failed', 'line 1\nline 2\n\nTypeError: boom\n  at x.ts:4\n');
  assert.equal(failed.suffix, 'failed (exit 1)'); assert.equal(failed.duration, '1m 4s');
  assert.deepEqual(failed.excerpt, ['TypeError: boom', '  at x.ts:4']);
  assert.deepEqual(commandOutcome({exitCode: 2, stderr: 'fatal: nope'}, 'completed', 'stdout').excerpt, ['fatal: nope'], 'a non-zero exit is a failure and stderr wins');
  assert.equal(commandOutcome({error: '{"message":"denied"}'}, 'failed').excerpt[0], 'denied');
  assert.equal(commandOutcome({}, 'failed').suffix, 'failed');
  assert.equal(commandOutcome({durationMs: 5}, 'running').duration, undefined, 'no duration while running');
  assert.equal(formatToolDuration(250), '250ms');
});

test('F15: same-basename files disambiguate with the shortest unique path suffix, VS Code style', () => {
  const labels = uniqueFileLabels(['package.json', 'apps/api/package.json']);
  assert.equal(labels.get('package.json'), 'package.json', 'the shallowest file keeps its bare name');
  assert.equal(labels.get('apps/api/package.json'), 'api/package.json', 'the deeper collision grows just enough to be unique');
  // Three-way collision across different depths.
  const three = uniqueFileLabels(['apps/api/package.json', 'apps/web/package.json', 'package.json']);
  assert.equal(three.get('package.json'), 'package.json');
  assert.equal(three.get('apps/api/package.json'), 'api/package.json');
  assert.equal(three.get('apps/web/package.json'), 'web/package.json');
  // No collision: every label is just the basename.
  const unique = uniqueFileLabels(['src/App.tsx', 'src/Foo.tsx']);
  assert.equal(unique.get('src/App.tsx'), 'App.tsx');
  assert.equal(unique.get('src/Foo.tsx'), 'Foo.tsx');
  // A collision one level up still needs disambiguation two levels up.
  const deep = uniqueFileLabels(['apps/api/src/index.ts', 'apps/web/src/index.ts']);
  assert.equal(deep.get('apps/api/src/index.ts'), 'api/src/index.ts');
  assert.equal(deep.get('apps/web/src/index.ts'), 'web/src/index.ts');
});

test('tool paths resolve inside attached folders only', () => {
  const folders = [{id: 'f', path: '/repo'}];
  assert.deepEqual(resolveToolPath('/repo/src/a.ts', folders), {folderId: 'f', path: 'src/a.ts'});
  assert.deepEqual(resolveToolPath('src/a.ts', folders, 'f'), {folderId: 'f', path: 'src/a.ts'});
  assert.equal(resolveToolPath('/elsewhere/a.ts', folders), undefined);
  assert.equal(resolveToolPath('../escape.ts', folders, 'f'), undefined);
});

test('plans render as checklist steps from Codex and Claude shapes', () => {
  assert.deepEqual(planSteps({type: 'todoList', items: [{text: 'Read', completed: true}, {text: 'Write', completed: false}]}), [{text: 'Read', status: 'completed'}, {text: 'Write', status: 'pending'}]);
  assert.deepEqual(planSteps({plan: [{step: 'A', status: 'inProgress'}, {step: 'B', status: 'completed'}]}), [{text: 'A', status: 'in_progress'}, {text: 'B', status: 'completed'}]);
  const claude = classifyTool({type: 'dynamicToolCall', tool: 'TodoWrite', arguments: JSON.stringify({todos: [{content: 'Test', status: 'in_progress'}, {content: 'Ship', status: 'pending'}]})});
  assert.equal(claude.kind, 'list'); assert.equal(claude.plan, true); assert.equal(claude.subject, '0 of 2 done');
  assert.deepEqual(planSteps({arguments: 'not json'}), []);
});

test('a plan submitted as markdown (not a steps array) is kept and classified as a plan', () => {
  // A native plan item whose `plan` field is prose, not a steps array — planSteps finds nothing,
  // but the raw text must still surface via planText/classifyTool rather than being dropped.
  assert.deepEqual(planSteps({type: 'plan', plan: '# Plan\n1. Do the thing'}), []);
  assert.equal(planText({type: 'plan', plan: '# Plan\n1. Do the thing'}), '# Plan\n1. Do the thing');
  const native = classifyTool({type: 'plan', plan: '# Plan\n1. Do the thing'});
  assert.equal(native.kind, 'list'); assert.equal(native.plan, true);
  assert.equal(native.planText, '# Plan\n1. Do the thing');

  // Claude's ExitPlanMode: a generic dynamic tool call whose sole argument is the plan's markdown.
  const exitPlan = classifyTool({type: 'dynamicToolCall', name: 'ExitPlanMode', arguments: JSON.stringify({plan: 'Ship the fix, then add a test.'})});
  assert.equal(exitPlan.kind, 'list'); assert.equal(exitPlan.verb, 'Proposed plan'); assert.equal(exitPlan.plan, true);
  assert.equal(exitPlan.planText, 'Ship the fix, then add a test.');
  assert.equal(exitPlan.subject, 'Ship the fix, then add a test.');

  // A long first line is trimmed for the collapsed row's subject, but the full text is kept.
  const long = 'x'.repeat(200);
  const trimmed = classifyTool({type: 'plan', plan: long});
  assert.equal(trimmed.planText, long);
  assert.equal(trimmed.subject!.length, 80);
  assert.ok(trimmed.subject!.endsWith('…'));

  // A plan tool call with genuinely nothing in it never fabricates text or a subject.
  const empty = classifyTool({type: 'dynamicToolCall', name: 'ExitPlanMode', arguments: '{}'});
  assert.equal(empty.planText, undefined);
  assert.equal(empty.subject, '');
});
