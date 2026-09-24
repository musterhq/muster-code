import assert from 'node:assert/strict';
import {test} from 'node:test';
import {clearSelection,emptySelection,extendSelectionByArrow,isRangeClick,isSelected,isToggleClick,keepSelected,pruneSelection,selectRange,selectionCount,toggleSelection,topLevelPaths} from '../src/renderer/multiSelect.ts';

const ids=['a','b','c','d','e'];

test('toggleSelection adds, removes and always sets the anchor to the clicked row',()=>{
  let state=emptySelection();
  state=toggleSelection(state,'b');
  assert.equal(isSelected(state,'b'),true);assert.equal(state.anchor,'b');assert.equal(selectionCount(state),1);
  state=toggleSelection(state,'d');
  assert.equal(isSelected(state,'d'),true);assert.equal(selectionCount(state),2);assert.equal(state.anchor,'d','the most recently toggled row becomes the anchor');
  state=toggleSelection(state,'b');
  assert.equal(isSelected(state,'b'),false);assert.equal(selectionCount(state),1);
});

test('selectRange spans the anchor to the clicked row in visible order, forward or backward',()=>{
  let state=toggleSelection(emptySelection(),'b');
  const forward=selectRange(state,ids,'d');
  assert.deepEqual([...forward.selected].sort(),['b','c','d']);
  assert.equal(forward.anchor,'b','the anchor does not move for a shift-click');
  const backward=selectRange(state,ids,'a');
  assert.deepEqual([...backward.selected].sort(),['a','b']);
  assert.equal(backward.anchor,'b');
});

test('selectRange replaces the previous selection rather than adding to it',()=>{
  let state=toggleSelection(emptySelection(),'a');
  state=toggleSelection(state,'e');// discontiguous: a and e selected, anchor e
  const range=selectRange(state,ids,'c');
  assert.deepEqual([...range.selected].sort(),['c','d','e'],'the range from the anchor (e) to c replaces the old picks, it does not union them');
});

test('selectRange with no prior anchor starts a single-row selection anchored at the clicked row',()=>{
  const range=selectRange(emptySelection(),ids,'c');
  assert.deepEqual([...range.selected],['c']);
  assert.equal(range.anchor,'c');
});

test('selectRange falls back to just the clicked row when the anchor or target is no longer visible (e.g. filtered out)',()=>{
  const state={selected:new Set(['x']),anchor:'missing-anchor'};
  const range=selectRange(state,ids,'c');
  assert.deepEqual([...range.selected],['c']);assert.equal(range.anchor,'c');
  const missingTarget=selectRange(toggleSelection(emptySelection(),'a'),ids,'not-visible');
  assert.deepEqual([...missingTarget.selected],['not-visible']);
});

test('extendSelectionByArrow moves focus one row and grows the range to meet it, in both directions',()=>{
  let state=toggleSelection(emptySelection(),'c');// anchor c
  let step=extendSelectionByArrow(state,ids,'c','down');
  assert.equal(step.focus,'d');assert.deepEqual([...step.state.selected].sort(),['c','d']);
  step=extendSelectionByArrow(step.state,ids,step.focus,'down');
  assert.equal(step.focus,'e');assert.deepEqual([...step.state.selected].sort(),['c','d','e']);
  // Reversing direction shrinks the range back toward the anchor instead of accumulating.
  step=extendSelectionByArrow(step.state,ids,step.focus,'up');
  assert.equal(step.focus,'d');assert.deepEqual([...step.state.selected].sort(),['c','d']);
  step=extendSelectionByArrow(step.state,ids,step.focus,'up');
  assert.equal(step.focus,'c');assert.deepEqual([...step.state.selected],['c']);
  step=extendSelectionByArrow(step.state,ids,step.focus,'up');
  assert.equal(step.focus,'b','crossing the anchor extends the range the other way');
  assert.deepEqual([...step.state.selected].sort(),['b','c']);
});

test('extendSelectionByArrow clamps at either end of the visible list',()=>{
  const state=toggleSelection(emptySelection(),'e');
  const step=extendSelectionByArrow(state,ids,'e','down');
  assert.equal(step.focus,'e','already at the last row');
  assert.deepEqual([...step.state.selected],['e']);
});

test('extendSelectionByArrow is a no-op when the focused row is not in the visible list',()=>{
  const state=emptySelection();
  const step=extendSelectionByArrow(state,ids,'ghost','down');
  assert.equal(step.focus,'ghost');assert.equal(step.state,state);
});

test('clearSelection empties the set and drops the anchor',()=>{
  const state=toggleSelection(emptySelection(),'a');
  const cleared=clearSelection();
  assert.equal(selectionCount(cleared),0);assert.equal(cleared.anchor,null);
  assert.notEqual(cleared,state);
});

test('isToggleClick reads metaKey on mac and ctrlKey elsewhere; isRangeClick just reads shiftKey',()=>{
  assert.equal(isToggleClick({metaKey:true,ctrlKey:false},true),true);
  assert.equal(isToggleClick({metaKey:false,ctrlKey:true},true),false);
  assert.equal(isToggleClick({metaKey:false,ctrlKey:true},false),true);
  assert.equal(isToggleClick({metaKey:true,ctrlKey:false},false),false);
  assert.equal(isRangeClick({shiftKey:true}),true);
  assert.equal(isRangeClick({shiftKey:false}),false);
});

test('pruneSelection drops rows that no longer exist and returns the same state when nothing changed',()=>{
  const state=toggleSelection(toggleSelection(emptySelection(),'a'),'b');// anchor b
  assert.equal(pruneSelection(state,()=>true),state,'unchanged: same object, so a React setter bails out');
  const pruned=pruneSelection(state,id=>id!=='b');
  assert.deepEqual([...pruned.selected],['a']);assert.equal(pruned.anchor,null,'the anchor goes with its row');
});

test('keepSelected keeps only the rows a batch action could not act on',()=>{
  const state=toggleSelection(toggleSelection(toggleSelection(emptySelection(),'a'),'b'),'c');
  assert.deepEqual([...keepSelected(state,['b','zzz']).selected],['b'],'unknown ids are ignored');
  assert.equal(keepSelected(state,[]).selected.size,0);
});

test('topLevelPaths drops paths inside another selected folder (sibling prefixes are not parents)',()=>{
  assert.deepEqual(topLevelPaths(['src/app.tsx','src','src-old/x','README.md','src/lib/a.ts']),['README.md','src','src-old/x']);
});
