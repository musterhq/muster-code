import test from 'node:test';
import assert from 'node:assert/strict';
import {buildInlineFileDiff} from '../src/renderer/inlineFileDiffModel.ts';

test('renders current additions and a deleted-line widget in the exact source position',()=>{
  const added=buildInlineFileDiff('const a = 1;\nconst b = 2;','--- a/src/math.js\n+++ b/src/math.js\n@@ -1 +1,2 @@\n const a = 1;\n+const b = 2;');
  assert.equal(added.state,'decorated');
  assert.deepEqual(added.rows,[
    {kind:'source',line:1,text:'const a = 1;',added:false},
    {kind:'source',line:2,text:'const b = 2;',added:true},
  ]);

  const removed=buildInlineFileDiff('const a = 1;\nconst c = 3;','@@ -1,3 +1,2 @@\n const a = 1;\n-const b = 2;\n const c = 3;');
  assert.equal(removed.state,'decorated');
  assert.deepEqual(removed.rows,[
    {kind:'source',line:1,text:'const a = 1;',added:false},
    {kind:'deleted',line:2,anchorLine:2,text:'const b = 2;'},
    {kind:'source',line:2,text:'const c = 3;',added:false},
  ]);
});

test('does not paint stale or incomplete patches as current source changes',()=>{
  assert.equal(buildInlineFileDiff('const current = true;','@@ -1 +1,2 @@\n const old = true;\n+const added = true;').state,'stale');
  assert.equal(buildInlineFileDiff('const value = 1;','').state,'unavailable');
  assert.equal(buildInlineFileDiff('x\ny','@@ -1 +1,2 @@\n-x\n+y\n+z',2).state,'unavailable');
});

test('cumulative review decorates every change since the baseline, not only the latest patch',async()=>{
  const {buildCumulativeFileDiff}=await import('../src/renderer/inlineFileDiffModel.ts');
  const {computeHunks,reverseHunk,applyHunk}=await import('../src/shared/review-hunks.ts');
  const baseline='a\nb\nc\nd\ne\nf\n';
  // Two separate agent edits in one turn: an insertion near the top and a replacement near the end.
  const current='a\nNEW\nb\nc\nd\nE\nf\n';
  const model=buildCumulativeFileDiff(baseline,current);
  assert.equal(model.state,'decorated');
  assert.equal(model.hunks.length,2,'both edits stay visible');
  assert.deepEqual(model.rows.map(row=>row.kind==='deleted'?`-${row.text}`:`${row.added?'+':' '}${row.text}`),[' a','+NEW',' b',' c',' d','-e','+E',' f']);
  assert.equal(model.rows.find(row=>row.kind==='deleted')?.hunkId,model.hunks[1].id,'removed lines carry their hunk');
  // Kept hunks are left undecorated; keeping everything leaves a clean file.
  const partly=buildCumulativeFileDiff(baseline,current,new Set([model.hunks[0].id]));
  assert.equal(partly.hunks.length,1);
  assert.equal(partly.kept,1);
  assert.equal(partly.rows.some(row=>row.kind==='source'&&row.text==='NEW'&&row.added),false);
  assert.equal(buildCumulativeFileDiff(baseline,current,new Set(['*'])).state,'clean');
  assert.equal(buildCumulativeFileDiff(baseline,baseline).state,'clean');
  // Hunk ids are content based: undoing one hunk leaves the other's id (and a Keep mark on it) intact.
  const hunks=computeHunks(baseline,current)!;
  const afterUndo=reverseHunk(current,hunks[0]);
  assert.equal(afterUndo,'a\nb\nc\nd\nE\nf\n');
  assert.deepEqual(computeHunks(baseline,afterUndo)!.map(hunk=>hunk.id),[hunks[1].id]);
  assert.equal(applyHunk(baseline,hunks[1]),'a\nb\nc\nd\nE\nf\n','applying one hunk stages exactly that change');
});

test('cumulative review keeps exact line endings, including a dropped final newline',async()=>{
  const {buildCumulativeFileDiff}=await import('../src/renderer/inlineFileDiffModel.ts');
  const {computeHunks,reverseHunk}=await import('../src/shared/review-hunks.ts');
  const model=buildCumulativeFileDiff('x\r\ny\r\nz','x\r\ny');
  assert.equal(model.state,'decorated');
  assert.deepEqual(model.rows.map(row=>`${row.kind}:${row.text}${row.kind==='source'&&row.added?':added':''}`),['source:x','deleted:y','deleted:z','source:y:added'],'a changed final line (lost newline) shows as removed and re-added');
  const [hunk]=computeHunks('x\r\ny\r\nz','x\r\ny')!;
  assert.equal(reverseHunk('x\r\ny',hunk),'x\r\ny\r\nz','reverting restores CRLF and the missing final newline exactly');
});
