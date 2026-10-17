/** Bug hunt: governance tool policy. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { globMatches } from '../src/shared/domains/project-governance-protocol.ts';

test('a tool-rule glob with many stars matches in linear-ish time against a long command', () => {
  const pattern = '*a*a*a*a*a*a*a*a*a*a*a*a*b';
  const subject = 'a'.repeat(400);
  const started = Date.now();
  assert.equal(globMatches(pattern, subject), false);
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
  assert.equal(globMatches('npm * test', 'NPM run\nx test'), true, 'still anchored, case-insensitive, dot matches newline');
  assert.equal(globMatches('git ?ush', 'git push'), true);
  assert.equal(globMatches('git ?ush', 'git ush'), false);
  assert.equal(globMatches('a.b(c)', 'a.b(c)'), true);
  assert.equal(globMatches('a.b', 'axb'), false);
});
