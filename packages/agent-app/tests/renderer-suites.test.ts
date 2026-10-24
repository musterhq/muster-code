// The renderer (DOM) suites: every tests/*.tsx file is run by `npm run test:renderer` or is excluded with a reason (#98).
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {excluded, suiteProblems, suites} from '../scripts/renderer-suites.mjs';

const tsx = readdirSync(import.meta.dirname).filter(name => name.endsWith('.tsx')).map(name => name.slice(0, -'.tsx'.length));

// Spec: MUS-SPEC-22-5A (docs/spec/clauses/22-engineering-standards.md#mus-spec-22-5a)
test('every tests/*.tsx file is a renderer suite or is excluded with a reason', () => {
  assert.deepEqual(suiteProblems(tsx), []);
  for (const [name, reason] of Object.entries(excluded)) assert.ok(reason.length > 20, `${name} needs a real reason`);
  assert.ok(tsx.length > 50 && suites.length > 50, 'the folder was really read');
});

// Spec: MUS-SPEC-22-5B (docs/spec/clauses/22-engineering-standards.md#mus-spec-22-5b)
test('the guard names a stray suite, a stale entry, a name in both lists and a duplicate', () => {
  assert.deepEqual(suiteProblems(['a', 'b'], ['a', 'b'], []), []);
  assert.deepEqual(suiteProblems(['a', 'b', 'stray'], ['a', 'b'], []), ['stray.tsx is not run by test:renderer: add it to suites in scripts/renderer-suites.mjs, or to excluded with the reason']);
  assert.deepEqual(suiteProblems(['a'], ['a', 'gone'], []), ['suites lists gone, but tests/gone.tsx does not exist']);
  assert.deepEqual(suiteProblems(['a'], ['a'], ['gone']), ['excluded lists gone, but tests/gone.tsx does not exist']);
  assert.deepEqual(suiteProblems(['a'], ['a'], ['a']), ['a is both a suite and excluded']);
  assert.deepEqual(suiteProblems(['a'], ['a', 'a'], []), ['suites lists a twice']);
});
