import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('Muster Server carries the Muster Agent version it ships with (bump both in a release)', () => {
  const server = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const app = JSON.parse(readFileSync(new URL('../../agent-app/package.json', import.meta.url), 'utf8')).version;
  assert.equal(server, app);
});
