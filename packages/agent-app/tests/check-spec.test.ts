// The spec checker: every case has its seven fields, names exactly one real test, and that test names the case back.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {join, resolve, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {removeTmp} from './fixtures/tmp-dir.ts';

const repo = resolve(import.meta.dirname, '../../..');
const checker = join(repo, 'scripts/check-spec.mjs');

const CASE_PATH = 'docs/spec/clauses/04-context-window-and-compaction.md';
const TEST_PATH = 'packages/agent-app/tests/window.test.ts';

function clause(body: string, rows?: string) {
  return `# MUS-SPEC-04: Context window and compaction\n\nWhat it is.\n\n## Acceptance cases\n\n| Case | What the assertions check | Test |\n|---|---|---|\n${rows ?? '| [MUS-SPEC-04-1A](04-context-window-and-compaction.md#mus-spec-04-1a) | The window wins. | [`your window wins`](../../../packages/agent-app/tests/window.test.ts) |'}\n\n${body}`;
}
function block(fields: Partial<Record<string, string>> = {}, id = 'MUS-SPEC-04-1A') {
  const f = {
    Precondition: 'A model with a catalog window.',
    Action: 'Set your own window.',
    'Expected result': 'Your window is used.',
    Test: `\`${TEST_PATH}::your window wins\``,
    Environment: 'Node test runner.',
    'Known gaps': 'None known.',
    Evidence: 'UNVERIFIED',
    ...fields,
  };
  const lines = Object.entries(f).filter(([, v]) => v !== undefined).map(([k, v]) => `- ${k}: ${v}`);
  return `<a id="${id.toLowerCase()}"></a>\n#### ${id}: Your window wins\n\n${lines.join('\n')}\n`;
}
const README = '# Muster specification\n\n## Clause index\n\n| ID | Area | Clause file |\n|---|---|---|\n| `MUS-SPEC-04` | Context window and compaction | [04-context-window-and-compaction.md](clauses/04-context-window-and-compaction.md) |\n';
const INDEX_WITH_04 = '# Test traceability index\n\n## Clauses with cases\n\n| Clause | Area |\n|---|---|\n| `MUS-SPEC-04` | [Context window and compaction](clauses/04-context-window-and-compaction.md) |\n';
const INDEX_EMPTY = '# Test traceability index\n\n## Clauses with cases\n\n| Clause | Area |\n|---|---|\n';
const LINKED_TEST = `import {test} from 'node:test';\n\n// Spec: MUS-SPEC-04-1A (${CASE_PATH}#mus-spec-04-1a)\ntest('your window wins', () => {});\n`;

async function tree(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'muster-check-spec-'));
  const all = {'docs/spec/README.md': README, 'docs/spec/test-traceability.md': INDEX_WITH_04, ...files};
  for (const [path, text] of Object.entries(all)) {
    await mkdir(dirname(join(root, path)), {recursive: true});
    await writeFile(join(root, path), text);
  }
  return root;
}
function run(root: string): {code: number; out: string} {
  try {
    return {code: 0, out: execFileSync(process.execPath, [checker, '--root', root], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']})};
  } catch (error) {
    const e = error as {status: number; stdout: string; stderr: string};
    return {code: e.status, out: `${e.stdout}${e.stderr}`};
  }
}

// Spec: MUS-SPEC-22-1A (docs/spec/clauses/22-engineering-standards.md#mus-spec-22-1a)
test('a case and its test that name each other pass', async t => {
  const root = await tree({[CASE_PATH]: clause(block()), [TEST_PATH]: LINKED_TEST});
  t.after(() => removeTmp(root));
  const result = run(root);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /1 case/);
});

// Spec: MUS-SPEC-22-1B (docs/spec/clauses/22-engineering-standards.md#mus-spec-22-1b)
test('a case missing one of its seven fields fails and names the field', async t => {
  const root = await tree({[CASE_PATH]: clause(block({'Known gaps': undefined})), [TEST_PATH]: LINKED_TEST});
  t.after(() => removeTmp(root));
  const result = run(root);
  assert.equal(result.code, 1);
  assert.match(result.out, /MUS-SPEC-04-1A.*Known gaps/);
});

// Spec: MUS-SPEC-22-2A (docs/spec/clauses/22-engineering-standards.md#mus-spec-22-2a)
test('a case whose test does not exist fails', async t => {
  const root = await tree({[CASE_PATH]: clause(block({Test: `\`${TEST_PATH}::a test nobody wrote\``})), [TEST_PATH]: LINKED_TEST});
  t.after(() => removeTmp(root));
  const result = run(root);
  assert.equal(result.code, 1);
  assert.match(result.out, /a test nobody wrote/);
});

// Spec: MUS-SPEC-22-2B (docs/spec/clauses/22-engineering-standards.md#mus-spec-22-2b)
test('a skipped test cannot prove a case', async t => {
  const skipped = LINKED_TEST.replace("test('your window wins', () => {});", "test('your window wins', {skip: true}, () => {});");
  const root = await tree({[CASE_PATH]: clause(block()), [TEST_PATH]: skipped});
  t.after(() => removeTmp(root));
  const result = run(root);
  assert.equal(result.code, 1);
  assert.match(result.out, /skip/i);
});

// Spec: MUS-SPEC-22-2C (docs/spec/clauses/22-engineering-standards.md#mus-spec-22-2c)
test('a test without its Spec comment fails the link back', async t => {
  const root = await tree({[CASE_PATH]: clause(block()), [TEST_PATH]: "import {test} from 'node:test';\n\ntest('your window wins', () => {});\n"});
  t.after(() => removeTmp(root));
  const result = run(root);
  assert.equal(result.code, 1);
  assert.match(result.out, /MUS-SPEC-04-1A.*Spec:/);
});

// Spec: MUS-SPEC-22-2D (docs/spec/clauses/22-engineering-standards.md#mus-spec-22-2d)
test('a Spec comment that points at a case that does not exist fails', async t => {
  const extra = LINKED_TEST + `\n// Spec: MUS-SPEC-04-9Z (${CASE_PATH}#mus-spec-04-9z)\ntest('orphan', () => {});\n`;
  const root = await tree({[CASE_PATH]: clause(block()), [TEST_PATH]: extra});
  t.after(() => removeTmp(root));
  const result = run(root);
  assert.equal(result.code, 1);
  assert.match(result.out, /MUS-SPEC-04-9Z/);
});

// Spec: MUS-SPEC-22-1C (docs/spec/clauses/22-engineering-standards.md#mus-spec-22-1c)
test('a case ID whose clause number does not match its file fails', async t => {
  const wrong = clause(block({}, 'MUS-SPEC-03-1A'), '| [MUS-SPEC-03-1A](04-context-window-and-compaction.md#mus-spec-03-1a) | x | [`your window wins`](../../../packages/agent-app/tests/window.test.ts) |');
  const root = await tree({[CASE_PATH]: wrong, [TEST_PATH]: LINKED_TEST.replace(/04-1A/g, '03-1A').replace(/04-1a/g, '03-1a')});
  t.after(() => removeTmp(root));
  const result = run(root);
  assert.equal(result.code, 1);
  assert.match(result.out, /MUS-SPEC-03-1A.*04/);
});

// Spec: MUS-SPEC-22-3A (docs/spec/clauses/22-engineering-standards.md#mus-spec-22-3a)
test('a passing receipt must report zero failures and at least one pass', async t => {
  const sha = 'a'.repeat(40);
  const bad = block({Evidence: `local; npm test; exit 0; 0 passed, 2 failed, 0 skipped; commit ${sha}`});
  const root = await tree({[CASE_PATH]: clause(bad), [TEST_PATH]: LINKED_TEST});
  t.after(() => removeTmp(root));
  const result = run(root);
  assert.equal(result.code, 1);
  assert.match(result.out, /Evidence/);
  const good = await tree({[CASE_PATH]: clause(block({Evidence: `local; npm test; exit 0; 3 passed, 0 failed, 0 skipped; commit ${sha}`})), [TEST_PATH]: LINKED_TEST});
  t.after(() => removeTmp(good));
  assert.equal(run(good).code, 0, run(good).out);
});

// Spec: MUS-SPEC-22-3B (docs/spec/clauses/22-engineering-standards.md#mus-spec-22-3b)
test('a not-written-yet case passes only with UNVERIFIED evidence and an issue number', async t => {
  const pending = block({Test: 'not written yet (#701)'});
  const root = await tree({[CASE_PATH]: clause(pending, '| [MUS-SPEC-04-1A](04-context-window-and-compaction.md#mus-spec-04-1a) | x | not written yet (#701) |'), [TEST_PATH]: "import {test} from 'node:test';\n"});
  t.after(() => removeTmp(root));
  assert.equal(run(root).code, 0, run(root).out);
  const claimed = block({Test: 'not written yet (#701)', Evidence: `local; npm test; exit 0; 1 passed, 0 failed, 0 skipped; commit ${'b'.repeat(40)}`});
  const bad = await tree({[CASE_PATH]: clause(claimed, '| [MUS-SPEC-04-1A](04-context-window-and-compaction.md#mus-spec-04-1a) | x | not written yet (#701) |'), [TEST_PATH]: "import {test} from 'node:test';\n"});
  t.after(() => removeTmp(bad));
  assert.equal(run(bad).code, 1);
});

// Spec: MUS-SPEC-22-3C (docs/spec/clauses/22-engineering-standards.md#mus-spec-22-3c)
test('a clause with cases must be listed in the traceability index, and one without must not', async t => {
  const missing = await tree({[CASE_PATH]: clause(block()), [TEST_PATH]: LINKED_TEST, 'docs/spec/test-traceability.md': INDEX_EMPTY});
  t.after(() => removeTmp(missing));
  const a = run(missing);
  assert.equal(a.code, 1);
  assert.match(a.out, /test-traceability.*MUS-SPEC-04/);
  const empty = clause('', '').replace(/\| Case \|[\s\S]*$/, 'No cases yet.\n');
  const stale = await tree({[CASE_PATH]: empty, [TEST_PATH]: "import {test} from 'node:test';\n"});
  t.after(() => removeTmp(stale));
  const b = run(stale);
  assert.equal(b.code, 1);
  assert.match(b.out, /test-traceability.*MUS-SPEC-04/);
});

// Spec: MUS-SPEC-22-2F (docs/spec/clauses/22-engineering-standards.md#mus-spec-22-2f)
test('a run-time skip variable or skip: false still links; skip: true and test.skip do not', async t => {
  const forms: Array<[string, number]> = [
    ["const skip = false;\ntest('your window wins', {skip, timeout: 90_000}, () => {});", 0],
    ["test('your window wins', {skip: false, timeout: 90_000}, () => {});", 0],
    ["test('your window wins', {timeout: 90_000, only: false}, () => {});", 0],
    ["test('your window wins', {skip: true}, () => {});", 1],
    ["test('your window wins', {todo: 'later'}, () => {});", 1],
    ["test.skip('your window wins', () => {});", 1],
    ["test.only('your window wins', () => {});", 1],
  ];
  for (const [call, want] of forms) {
    const [setup, testCall] = call.includes('\n') ? call.split('\n') : ['', call];
    const fixed = `import {test} from 'node:test';\n${setup}\n\n// Spec: MUS-SPEC-04-1A (${CASE_PATH}#mus-spec-04-1a)\n${testCall}\n`;
    const root = await tree({[CASE_PATH]: clause(block()), [TEST_PATH]: fixed});
    t.after(() => removeTmp(root));
    const result = run(root);
    assert.equal(result.code, want, `${call}\n${result.out}`);
  }
});

// Spec: MUS-SPEC-22-1D (docs/spec/clauses/22-engineering-standards.md#mus-spec-22-1d)
test('the same case ID twice, or two tests with one name, fail', async t => {
  const twice = clause(block() + '\n' + block());
  const a = await tree({[CASE_PATH]: twice, [TEST_PATH]: LINKED_TEST});
  t.after(() => removeTmp(a));
  const first = run(a);
  assert.equal(first.code, 1);
  assert.match(first.out, /duplicate case ID/);
  const b = await tree({[CASE_PATH]: clause(block()), [TEST_PATH]: LINKED_TEST + "\ntest('your window wins', () => {});\n"});
  t.after(() => removeTmp(b));
  const second = run(b);
  assert.equal(second.code, 1);
  assert.match(second.out, /2 tests are named/);
});

// Spec: MUS-SPEC-22-2G (docs/spec/clauses/22-engineering-standards.md#mus-spec-22-2g)
test('a blank line between the Spec comment and the test breaks the link', async t => {
  const gap = LINKED_TEST.replace("#mus-spec-04-1a)\ntest(", "#mus-spec-04-1a)\n\ntest(");
  const root = await tree({[CASE_PATH]: clause(block()), [TEST_PATH]: gap});
  t.after(() => removeTmp(root));
  const result = run(root);
  assert.equal(result.code, 1);
  assert.match(result.out, /directly above/);
});

// Spec: MUS-SPEC-22-2E (docs/spec/clauses/22-engineering-standards.md#mus-spec-22-2e)
test('a DOM suite links through a named check in a file that imports dom-check', async t => {
  const dom = `import {check} from './dom-check.ts';\n\n// Spec: MUS-SPEC-04-1A (${CASE_PATH}#mus-spec-04-1a)\nawait check('your window wins', async () => {});\n`;
  const root = await tree({[CASE_PATH]: clause(block({Test: '`packages/agent-app/tests/window-dom.tsx::your window wins`'}), '| [MUS-SPEC-04-1A](04-context-window-and-compaction.md#mus-spec-04-1a) | x | [`your window wins`](../../../packages/agent-app/tests/window-dom.tsx) |'), 'packages/agent-app/tests/window-dom.tsx': dom});
  t.after(() => removeTmp(root));
  assert.equal(run(root).code, 0, run(root).out);
});

// Spec: MUS-SPEC-22-4A (docs/spec/clauses/22-engineering-standards.md#mus-spec-22-4a)
test('the real Muster spec passes the checker', () => {
  const result = run(repo);
  assert.equal(result.code, 0, result.out);
});
