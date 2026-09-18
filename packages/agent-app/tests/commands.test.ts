import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCommandName } from '../src/main/commands.ts';

test('accepts protocol command names', () => {
  assert.ok(isCommandName('app.snapshot'));
  assert.ok(isCommandName('folder.pick'));
  assert.ok(isCommandName('chat.send'));
});

test('rejects arbitrary/hostile channel strings', () => {
  assert.ok(!isCommandName('__proto__'));
  assert.ok(!isCommandName('constructor'));
  assert.ok(!isCommandName('toString'));
  assert.ok(!isCommandName('shell.exec'));
  assert.ok(!isCommandName(''));
  assert.ok(!isCommandName(42));
  assert.ok(!isCommandName(null));
});
