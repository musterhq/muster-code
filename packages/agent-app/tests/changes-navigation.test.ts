/** DIF-06: keyboard model for the changed-files list and the Diff tab's previous/next file. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {diffFileStep, isEditableTarget, nextChangeIndex} from '../src/renderer/changesNavigation.ts';

test('list keys: ↑/↓ and k/j step, Home/End jump, and nothing moves past either end', () => {
  assert.equal(nextChangeIndex(-1, 3, 'ArrowDown'), 0, 'from outside the list, ↓ enters at the top');
  assert.equal(nextChangeIndex(-1, 3, 'ArrowUp'), 2, 'and ↑ at the bottom');
  assert.equal(nextChangeIndex(0, 3, 'j'), 1);
  assert.equal(nextChangeIndex(2, 3, 'k'), 1);
  assert.equal(nextChangeIndex(2, 3, 'ArrowDown'), undefined);
  assert.equal(nextChangeIndex(0, 3, 'ArrowUp'), undefined);
  assert.equal(nextChangeIndex(1, 3, 'Home'), 0);
  assert.equal(nextChangeIndex(1, 3, 'End'), 2);
  assert.equal(nextChangeIndex(0, 3, 'Enter'), undefined);
  assert.equal(nextChangeIndex(0, 0, 'ArrowDown'), undefined);
});

test('Diff tab keys: Alt+↑/↓ anywhere, [ and ] outside text fields, never with ⌘ or Ctrl', () => {
  const key = (value: string, mods: Partial<{altKey: boolean; metaKey: boolean; ctrlKey: boolean}> = {}) => ({key: value, altKey: false, metaKey: false, ctrlKey: false, ...mods});
  assert.equal(diffFileStep(key('ArrowDown', {altKey: true}), true), 1);
  assert.equal(diffFileStep(key('ArrowUp', {altKey: true}), false), -1);
  assert.equal(diffFileStep(key(']'), false), 1);
  assert.equal(diffFileStep(key('['), false), -1);
  assert.equal(diffFileStep(key(']'), true), undefined, 'typing a bracket in a field is not navigation');
  assert.equal(diffFileStep(key(']', {metaKey: true}), false), undefined);
  assert.equal(diffFileStep(key('ArrowDown'), false), undefined);
  assert.equal(isEditableTarget({tagName: 'TEXTAREA'} as unknown as EventTarget), true);
  assert.equal(isEditableTarget({tagName: 'DIV', isContentEditable: true} as unknown as EventTarget), true);
  assert.equal(isEditableTarget({tagName: 'BUTTON'} as unknown as EventTarget), false);
  assert.equal(isEditableTarget(null), false);
});
