import {test} from 'node:test';
import assert from 'node:assert/strict';

test('UX-13: narrow windows auto-collapse the sidebar and restore it, never fighting a manual toggle', async () => {
  const {nextAutoNav, installResponsiveNav} = await import('../src/renderer/responsiveNav.ts');
  assert.deepEqual(nextAutoNav({narrow: true, navHidden: false, autoCollapsed: false}), {navHidden: true, autoCollapsed: true});
  assert.equal(nextAutoNav({narrow: true, navHidden: true, autoCollapsed: false}), null, 'already hidden by the user: nothing to do');
  assert.deepEqual(nextAutoNav({narrow: false, navHidden: true, autoCollapsed: true}), {navHidden: false, autoCollapsed: false}, 'widening restores it');
  assert.equal(nextAutoNav({narrow: false, navHidden: true, autoCollapsed: false}), null, 'a sidebar the user hid stays hidden');

  // Wired to a fake window: narrow collapses without persisting; a manual re-open while narrow sticks after widening.
  let narrow = true, hidden = false; const calls: Array<[boolean, unknown]> = []; let listener: (() => void) | undefined;
  const win = {matchMedia: () => ({get matches() { return narrow; }, addEventListener: (_: string, fn: () => void) => { listener = fn; }, removeEventListener() {}})} as unknown as Window;
  const dispose = installResponsiveNav({navHidden: () => hidden, setNavHidden: (value, options) => { hidden = value; calls.push([value, options]); }}, win);
  assert.deepEqual(calls, [[true, {persist: false}]]);
  hidden = false; // the user re-opens it while narrow
  narrow = false; listener!();
  assert.equal(calls.length, 1, 'no automatic change after the user took over');
  assert.equal(hidden, false);
  dispose();
});
