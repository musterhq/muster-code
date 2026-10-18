import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pipReserveFor} from '../src/renderer/pipReserve.ts';

// Center pane 260..1660 (1400 wide) in a 1680 window; the 804px column's text runs 590..1330.
const box = {left: 260, right: 1660, width: 1400};
test('no reserve when the preview card sits clear of the centred transcript column', () => {
  assert.equal(pipReserveFor(box, 804, 1680, {right: 20, width: 300}, 'right'), undefined, 'card at 1360..1660 is right of the text');
});
test('a card over the text reserves exactly the space from its edge to the pane edge', () => {
  const narrow = {left: 260, right: 1160, width: 900};
  assert.deepEqual(pipReserveFor(narrow, 804, 1180, {right: 20, width: 300}, 'right'), {side: 'right', px: 308});
  assert.deepEqual(pipReserveFor({left: 0, right: 900, width: 900}, 804, 1180, {right: 860, width: 300}, 'left'), {side: 'left', px: 328});
});
test('never squeezes the transcript below a readable width: the card overlaps instead', () => {
  assert.equal(pipReserveFor({left: 260, right: 860, width: 600}, 804, 880, {right: 20, width: 300}, 'right'), undefined);
});
