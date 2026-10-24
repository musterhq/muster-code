import assert from 'node:assert/strict';
import {test} from 'node:test';
import {LocalWorkspace} from '../src/runtime/workspace-local.ts';

// Spec: MUS-SPEC-12-572A (docs/spec/clauses/12-projects-orgs-and-tasks.md#mus-spec-12-572a)
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

// Spec: MUS-SPEC-07-572A (docs/spec/clauses/07-files-editor-and-search.md#mus-spec-07-572a)
test('search scope prefixes named after Object.prototype keys are plain words', async () => {
  const {parseSearch} = await import('../src/shared/search-query.ts');
  for (const word of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    const parsed = parseSearch(`${word}:foo`);
    assert.equal(parsed.scope, 'all', word);
    assert.equal(parsed.text, `${word}:foo`, word);
    assert.equal(parseSearch(`in:${word}`).scope, 'all', `in:${word}`);
  }
});

// Spec: MUS-SPEC-15-572A (docs/spec/clauses/15-settings-and-themes.md#mus-spec-15-572a)
test('a custom theme list with extra fields or untrimmed token values is rejected, not stored as given', async () => {
  const {validateSetting} = await import('../src/shared/domains/settings-protocol.ts');
  const theme = {id: 'mine', name: 'Mine', base: 'dark', tokens: {bg: '#101010'}};
  assert.deepEqual(validateSetting('appearance.customThemes', [theme]), [theme]);
  assert.throws(() => validateSetting('appearance.customThemes', [{...theme, notes: 'x'.repeat(100_000)}]), /customThemes/);
  assert.throws(() => validateSetting('appearance.customThemes', [{...theme, tokens: {...theme.tokens, extra: 'x'}}]), /customThemes/);
  assert.throws(() => validateSetting('appearance.customThemes', [{...theme, tokens: {bg: '  #101010  '}}]), /customThemes/);
});
