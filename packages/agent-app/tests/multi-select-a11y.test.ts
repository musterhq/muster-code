/** Multiselect reviewer fixes: keyboard selection keys, the no-anchor Shift-click fallback, and batch archive's single summary. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {clearSelection, selectAll, selectionKeyAction, selectRange, toggleSelection, withFallbackAnchor} from '../src/renderer/multiSelect.ts';
import {archiveChats, archiveSummary} from '../src/renderer/batchArchive.ts';

const keyEvent = (key: string, extra: Partial<{metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean}> = {}) => ({key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...extra});

test('selection keys: Space toggles, Cmd+A (Ctrl+A off macOS) selects all, Escape clears; modified keys are left alone', () => {
  assert.equal(selectionKeyAction(keyEvent(' '), true), 'toggle');
  assert.equal(selectionKeyAction(keyEvent(' ', {shiftKey: true}), true), null);
  assert.equal(selectionKeyAction(keyEvent('a', {metaKey: true}), true), 'all');
  assert.equal(selectionKeyAction(keyEvent('A', {ctrlKey: true}), false), 'all');
  assert.equal(selectionKeyAction(keyEvent('a', {ctrlKey: true}), true), null, 'Ctrl+A on macOS is the line-start shortcut');
  assert.equal(selectionKeyAction(keyEvent('a', {metaKey: true, shiftKey: true}), true), null);
  assert.equal(selectionKeyAction(keyEvent('Escape'), true), 'clear');
  assert.equal(selectionKeyAction(keyEvent('Enter'), true), null);
});

test('select all anchors at the focused row; Shift-click without an anchor ranges from the active row', () => {
  const visible = ['a', 'b', 'c', 'd'];
  assert.deepEqual([...selectAll(visible, 'c').selected], visible);
  assert.equal(selectAll(visible, 'c').anchor, 'c');
  assert.equal(selectAll(visible, 'gone').anchor, 'a');
  assert.deepEqual([...selectRange(withFallbackAnchor(clearSelection(), 'b', visible), visible, 'd').selected], ['b', 'c', 'd']);
  assert.deepEqual([...selectRange(withFallbackAnchor(clearSelection(), 'hidden', visible), visible, 'd').selected], ['d'], 'an off-screen active row is no anchor');
  const anchored = toggleSelection(clearSelection(), 'a');
  assert.equal(withFallbackAnchor(anchored, 'c', visible), anchored, 'an existing anchor wins');
});

test('batch archive awaits every chat and reports one summary', async () => {
  const all = await archiveChats(['a', 'b'], async id => ({id, archived: true}));
  assert.deepEqual(archiveSummary(all), {message: 'Archived 2 chats', kind: 'success'});
  const partial = await archiveChats(['a', 'b', 'c'], async id => { if (id === 'b') throw new Error("Error invoking remote method 'invoke': Error: Chat no longer exists."); return id === 'c' ? {archived: false} : {archived: true}; });
  assert.deepEqual(partial.archived, ['a']);
  assert.deepEqual(partial.failed.map(item => item.id), ['b', 'c']);
  assert.deepEqual(archiveSummary(partial), {message: 'Archived 1 of 3 chats. 2 chats could not be archived: Chat no longer exists.', kind: 'error'});
});
