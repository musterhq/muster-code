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

// Spec: MUS-SPEC-15-398C (docs/spec/clauses/15-settings-and-themes.md#mus-spec-15-398c)
test('at 900 pixels the sidebar steps aside and returns when widened', async () => {
 const {installResponsiveNav} = await import('../src/renderer/responsiveNav.ts');
 let width=900,hidden=false,change=()=>{};
 const win={matchMedia:(query:string)=>({get matches(){return width<=Number(query.match(/(\d+)px/)![1]);},addEventListener(_:string,fn:()=>void){change=fn;},removeEventListener(){}})} as unknown as Window;
 const dispose=installResponsiveNav({navHidden:()=>hidden,setNavHidden:value=>{hidden=value;}},win);
 assert.equal(hidden,true,'the conversation has the full width at 900px');
 width=1200;change();assert.equal(hidden,false,'the sidebar returns after widening');dispose();
});
