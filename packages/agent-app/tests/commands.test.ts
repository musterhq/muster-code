import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCommandName } from '../src/main/commands.ts';
import { PROCESS_COMMANDS } from '../src/shared/process-protocol.ts';
import { BROWSER_COMMANDS } from '../src/shared/browser-protocol.ts';
import { SCOPED_COMPUTER_COMMANDS } from '../src/shared/scoped-computer-protocol.ts';

test('accepts protocol command names', () => {
  assert.ok(isCommandName('app.snapshot'));
  assert.ok(isCommandName('folder.pick'));
  assert.ok(isCommandName('chat.send'));
  for (const name of ['chat.queue.add', 'chat.queue.update', 'chat.queue.remove', 'chat.queue.move', 'chat.steer', 'attachments.stage', 'attachments.discard', 'attachments.list', 'attachments.preview']) assert.ok(isCommandName(name), name);
  // GIT-10/11/13: history, compare, blame, conflicts and clone are domain commands the main allowlist must carry.
  for (const name of ['git.log', 'git.commitDetail', 'git.compare', 'git.refDiff', 'git.blame', 'git.conflicts', 'git.conflictFile', 'git.conflictWrite', 'git.conflictMarkResolved', 'git.conflictContinue', 'git.clone.start', 'git.clone.cancel', 'git.clone.defaultDestination', 'git.clone.pickDestination']) assert.ok(isCommandName(name), name);
});

test('spreads the process, browser and scoped computer allowlists', () => {
  for (const name of [...Object.keys(PROCESS_COMMANDS), ...Object.keys(BROWSER_COMMANDS), ...Object.keys(SCOPED_COMPUTER_COMMANDS)]) assert.ok(isCommandName(name), name);
  // Counts pinned so a command silently dropped from an allowlist (not just added) still fails
  // loudly; bump them, don't delete them, whenever a command set legitimately grows.
  assert.equal(Object.keys(PROCESS_COMMANDS).length, 15, 'processes.ports + processes.stopListener joined (S3-E listening ports; outputPage was PER-05)');
  assert.equal(Object.keys(BROWSER_COMMANDS).length, 21);
  assert.equal(Object.keys(SCOPED_COMPUTER_COMMANDS).length, 27);
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
