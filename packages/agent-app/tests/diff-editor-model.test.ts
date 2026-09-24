import test from 'node:test';
import assert from 'node:assert/strict';
import {collapseEditor,editorFromPatch,fileEditorModel,hunkStarts,reconstructBefore} from '../src/renderer/diffEditorModel.ts';
import {collectFileChanges,changeTotals} from '../src/renderer/turnFileChanges.ts';
import {fileStats} from '../src/renderer/components/toolPresentation.ts';
import type {TimelineItem} from '../src/shared/protocol.ts';

const show=(rows:ReturnType<typeof collapseEditor>)=>rows.map(row=>row.kind==='gap'?`gap:${row.count}${row.lines?'':'(static)'}`:`${row.kind==='deleted'?'-':row.added?'+':' '}${row.line??''}:${row.text}`);
const after=Array.from({length:30},(_,index)=>`line ${index+1}`).join('\n')+'\n';
// Line 5 was "old five"; line 20 is new.
const patch='@@ -2,7 +2,7 @@\n line 2\n line 3\n line 4\n-old five\n+line 5\n line 6\n line 7\n line 8\n@@ -17,6 +17,7 @@\n line 17\n line 18\n line 19\n+line 20\n line 21\n line 22\n line 23\n';

test('the whole file renders in file order: removed lines above their replacements, the file\'s own numbers',()=>{
  const model=fileEditorModel(after,[patch])!;
  assert.ok(model,'the patch reverses cleanly onto the file on disk');
  const rows=show(collapseEditor(model,new Set(),Infinity));
  assert.equal(model.lines.filter(row=>row.kind==='line').length,30,'every post-edit line is present, not only the hunks');
  assert.deepEqual(rows.slice(3,6),[' 4:line 4','-5:old five','+5:line 5']);
  assert.deepEqual(rows.slice(19,23),[' 19:line 19','+20:line 20',' 21:line 21',' 22:line 22']);
  assert.deepEqual([model.adds,model.dels],[2,1]);
  assert.equal(reconstructBefore(after,[patch])?.split('\n')[4],'old five');
});

test('collapsed context: three lines around each change, the rest in expandable "N unchanged lines" rows',()=>{
  const model=fileEditorModel(after,[patch])!;
  const rows=collapseEditor(model);
  assert.deepEqual(show(rows),[' 1:line 1',' 2:line 2',' 3:line 3',' 4:line 4','-5:old five','+5:line 5',' 6:line 6',' 7:line 7',' 8:line 8','gap:8',' 17:line 17',' 18:line 18',' 19:line 19','+20:line 20',' 21:line 21',' 22:line 22',' 23:line 23','gap:7']);
  const gap=rows.find(row=>row.kind==='gap')!;
  assert.ok(gap.kind==='gap'&&gap.lines?.length===8,'a folded run carries its lines so it can open in place');
  const opened=collapseEditor(model,new Set([gap.kind==='gap'?gap.key:'']));
  assert.equal(opened.filter(row=>row.kind==='gap').length,1,'opening one gap leaves the other folded');
  assert.equal(opened.length,rows.length-1+8);
});

test('a patch alone: its hunks in order, the code between them as a static gap with the real count',()=>{
  const model=editorFromPatch(patch);
  assert.equal(model.complete,false);
  const rows=show(collapseEditor(model));
  assert.equal(rows[0],'gap:1(static)','line 1 precedes the first hunk');
  assert.ok(rows.includes('gap:8(static)'),'lines 9-16 lie between the hunks');
  assert.deepEqual(model.hunks.map(hunk=>[hunk.adds,hunk.dels]),[[1,1],[1,0]]);
  const starts=[...hunkStarts(collapseEditor(model)).values()];
  assert.deepEqual(starts,model.hunks.map(hunk=>hunk.id),'each change block has one start row for its actions');
});

test('a file changed again after the edit falls back (the patch no longer reverses)',()=>{
  assert.equal(fileEditorModel(after.replace('line 20','LINE TWENTY'),[patch]),undefined);
  assert.equal(reconstructBefore('x\n',['@@ @@\n-a\n+x']),undefined,'a patch without positions cannot be placed');
});

test('several edits in one turn reconstruct the pre-turn file',()=>{
  const first='@@ -1,2 +1,2 @@\n-a\n+b\n c\n',second='@@ -1,2 +1,3 @@\n b\n c\n+d\n';
  const model=fileEditorModel('b\nc\nd\n',[first,second])!;
  assert.deepEqual(show(collapseEditor(model,new Set(),Infinity)),['-1:a','+1:b',' 2:c','+3:d']);
});

const item=(id:string,changes:unknown[],status='completed'):TimelineItem=>({id,chatId:'c',kind:'tool',text:'',createdAt:'',status,data:{type:'fileChange',changes}});
test('a multi-file, multi-hunk turn: per-file rows and pill totals come from the same patches',()=>{
  const items=[
    item('e1',[{path:'/w/src/a.ts',kind:'update',diff:patch},{path:'/w/README.md',kind:{type:'add'},diff:'# Readme\n- one\n- two\n'}]),
    item('e2',[{path:'/w/src/a.ts',kind:'update',diff:'@@ -30 +30,2 @@\n line 30\n+line 31\n'}]),
    item('e3',[{path:'/w/src/b.ts',diff:'--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1,2 +1,2 @@\n-x\n+y\n z\n'}],'failed'),
  ];
  const entries=collectFileChanges(items);
  assert.deepEqual(entries.map(entry=>[entry.path,entry.kind,entry.adds,entry.dels,entry.patches.length]),[['/w/src/a.ts','update',3,1,2],['/w/README.md','add',3,0,1]],'a failed edit is not a change; the Codex add body counts its "- " lines as additions');
  assert.deepEqual(changeTotals(entries),{files:2,adds:6,dels:1});
  assert.deepEqual(fileStats(items[0].data),[{path:'/w/src/a.ts',adds:2,dels:1},{path:'/w/README.md',adds:3,dels:0}],'the tool row agrees with the file rows');
});
