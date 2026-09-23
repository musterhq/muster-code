import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cleanDiffMessage,isCleanDiff} from '../src/renderer/diffCleanState.ts';

test('F61: a Diff tab whose file now matches HEAD shows a clean "No changes · committed" state', () => {
  const text = 'line\n'.repeat(102);
  // After a commit HEAD and the working copy are the same text: clean, not "102 unchanged lines".
  assert.equal(isCleanDiff(text, text), true);
  assert.deepEqual(cleanDiffMessage('head'), {title: 'No changes · committed', detail: 'This file matches the last commit (HEAD).'});
  // Every other baseline gets its own accurate wording.
  assert.equal(cleanDiffMessage('staged').title, 'Nothing staged');
  assert.equal(cleanDiffMessage('unstaged').title, 'No unstaged changes');
  assert.equal(cleanDiffMessage({runId: 'r1'}).title, 'No changes in this turn');
});

test('real changes, renames, mode flips, truncation and unloaded texts are never "clean"', () => {
  assert.equal(isCleanDiff('a\n', 'b\n'), false);
  assert.equal(isCleanDiff('a\n', 'a\n', {previousPath: 'old.md'}), false, 'a pure rename is still a change');
  assert.equal(isCleanDiff('a\n', 'a\n', {mode: {old: '100644', new: '100755'}}), false);
  assert.equal(isCleanDiff('a\n', 'a\n', {truncated: true}), false, 'a truncated read cannot prove equality');
  assert.equal(isCleanDiff(undefined, 'a\n'), false, 'still loading');
});
