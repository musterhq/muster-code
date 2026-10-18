import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pipReserveFor} from '../src/renderer/pipReserve.ts';

const textEnd = (width: number, px: number, max = 804) => { const w = width - px, column = Math.min(w, max); return (w - column) / 2 + column - 32; };

test('no reserve when the preview card sits clear of the centred transcript column', () => {
  assert.equal(pipReserveFor({left: 260, right: 1660, width: 1400}, 804, 1680, {right: 20, width: 300}, 'right'), undefined);
});
test('the smallest reserve that clears the card: the text ends at the card minus the gap', () => {
  // Wide pane, card overlaps the column's right side by about 100px.
  const box = {left: 270, right: 1600, width: 1330}, anchor = {right: 624, width: 300}; // card at 756..1056 (pane-relative 486..786)
  const r = pipReserveFor(box, 804, 1680, anchor, 'right')!;
  assert.ok(r, 'overlap is detected');
  assert.ok(Math.abs(textEnd(box.width, r.px) - (1680 - 624 - 300 - 8 - box.left)) <= 1, 'text ends right at the card');
  // Pane narrower than the column: gives up just the overlap.
  const narrow = {left: 0, right: 900, width: 900};
  const n = pipReserveFor(narrow, 804, 1180, {right: 20 + 280, width: 300}, 'right')!;
  assert.ok(Math.abs(textEnd(narrow.width, n.px) - (1180 - 300 - 300 - 8)) <= 1);
});
test('left-side cards mirror the right side', () => {
  const r = pipReserveFor({left: 0, right: 900, width: 900}, 804, 900, {right: 600, width: 300}, 'left');
  assert.deepEqual(r?.side, 'left');
});
test('never squeezes the column below 440px: the card overlaps instead', () => {
  assert.equal(pipReserveFor({left: 260, right: 860, width: 600}, 804, 880, {right: 20, width: 300}, 'right'), undefined);
});
