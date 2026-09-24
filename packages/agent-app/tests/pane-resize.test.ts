import assert from 'node:assert/strict';
import {test} from 'node:test';
import {dragPaneWidth, PANE_MIN_WIDTH} from '../src/renderer/paneResize.ts';

test('F40: a separator drag only resizes while the primary button is held', () => {
  const drag = {x: 1000, width: 560};
  assert.equal(dragPaneWidth(drag, {clientX: 900, buttons: 1}, 1100), 660, 'dragging left widens by the distance moved');
  assert.equal(dragPaneWidth(drag, {clientX: 400, buttons: 1}, 1100), 1100, 'clamped to the maximum');
  assert.equal(dragPaneWidth(drag, {clientX: 1900, buttons: 1}, 1100), PANE_MIN_WIDTH, 'clamped to the minimum');
  // The pointerup was swallowed by the Browser tab's native view: the next buttonless move must end the
  // drag, never widen the pane toward wherever the pointer happens to be.
  assert.equal(dragPaneWidth(drag, {clientX: 500, buttons: 0}, 1100), null);
});
