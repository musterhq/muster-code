import test from 'node:test';
import assert from 'node:assert/strict';
import {parseInlineDiff} from '../src/renderer/inlineDiffModel.ts';

test('parses unified edits into numbered inline additions, removals and context',()=>{
  const model=parseInlineDiff('@@ -1,2 +1,3 @@\n export function add(a, b) {\n-  return a - b;\n+  return a + b;\n+}\n');
  assert.deepEqual(model.rows.map(row=>row.kind),['hunk','context','del','add','add']);
  assert.deepEqual(model.rows.flatMap(row=>'oldLine' in row?[[row.oldLine,row.newLine]]:[]),[[1,1],[2,null],[null,2],[null,3]]);
});

test('caps expensive inline rendering and reports omitted patch rows',()=>{
  const model=parseInlineDiff('@@ -1 +1 @@\n-a\n+b\n+c\n',2);
  assert.equal(model.rows.length,2); assert.equal(model.totalRows,4); assert.equal(model.truncated,true);
});

test('keeps source lines beginning with patch markers inside hunks',()=>{
  const model=parseInlineDiff('--- a/src/example.js\n+++ b/src/example.js\n@@ -1,2 +1,2 @@\n--- old comment\n+++newCounter\n');
  assert.deepEqual(model.rows.map(row=>[row.kind,row.text]),[
    ['meta','--- a/src/example.js'],
    ['meta','+++ b/src/example.js'],
    ['hunk','@@ -1,2 +1,2 @@'],
    ['del','-- old comment'],
    ['add','++newCounter'],
  ]);
});

// --- Patch shapes the transcript must render exactly (one shared parser for every count). ---
import {normalizeChange,countPatch,contentPatch} from '../src/renderer/patchModel.ts';
const lines=(patch:string)=>parseInlineDiff(patch,Number.MAX_SAFE_INTEGER).rows.filter(row=>row.kind!=='hunk'&&row.kind!=='meta').map(row=>`${row.kind}:${'oldLine' in row?row.oldLine??'':''}:${'newLine' in row?row.newLine??'':''}:${row.text}`);

test('multi-hunk patches keep each hunk\'s own line numbers',()=>{
  const patch='@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -10,2 +10,3 @@\n x\n+y\n z\n';
  assert.deepEqual(lines(patch),['context:1:1:a','del:2::b','add::2:B','context:3:3:c','context:10:10:x','add::11:y','context:11:12:z']);
  assert.deepEqual(countPatch(patch),{adds:2,dels:1});
});

test('hunk headers without counts default to one line and stop there',()=>{
  const model=parseInlineDiff('@@ -1 +1,2 @@\n-old\n+new\n+more\n--- a/next.ts\n+++ b/next.ts\n@@ -4 +4 @@\n-x\n+y\n');
  assert.deepEqual(model.rows.map(row=>row.kind),['hunk','del','add','add','meta','meta','hunk','del','add'],'a header pair after the counts run out starts the next file');
  assert.equal(model.adds,3);assert.equal(model.dels,2);
});

test('new file (--- /dev/null) and deleted file patches',()=>{
  const added=normalizeChange({path:'n.ts',diff:'--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n'})!;
  assert.equal(added.kind,'add');assert.deepEqual([added.adds,added.dels],[2,0]);
  assert.deepEqual(lines(added.patch),['add::1:one','add::2:two']);
  const deleted=normalizeChange({path:'d.ts',diff:'--- a/d.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n'})!;
  assert.equal(deleted.kind,'delete');assert.deepEqual([deleted.adds,deleted.dels],[0,2]);
  assert.deepEqual(lines(deleted.patch),['del:1::one','del:2::two']);
});

test('renames keep their destination and rename headers are not code',()=>{
  const patch='diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-a\n+b\n';
  assert.deepEqual(lines(patch),['del:1::a','add::1:b']);
  assert.equal(normalizeChange({path:'old.ts',kind:{type:'update',move_path:'new.ts'},diff:'@@ -1 +1 @@\n-a\n+b'})!.movePath,'new.ts','Codex move_path');
});

test('"\\ No newline at end of file" is a note, not a line or a change',()=>{
  const model=parseInlineDiff('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+a\n');
  assert.deepEqual(model.rows.map(row=>row.kind),['hunk','del','meta','add']);
  assert.deepEqual([model.adds,model.dels],[1,1]);
});

test('CRLF patches parse like LF ones',()=>{
  assert.deepEqual(lines('@@ -1,2 +1,2 @@\r\n a\r\n-b\r\n+c\r\n'),['context:1:1:a','del:2::b','add::2:c']);
});

test('source lines that start with +++, --- or @@ stay code inside a counted hunk',()=>{
  const patch='@@ -1,3 +1,3 @@\n--- old\n+++ new\n @@ literal @@\n-x\n+y\n';
  assert.deepEqual(lines(patch),['del:1::-- old','add::1:++ new','context:2:2:@@ literal @@','del:3::x','add::3:y']);
});

test('empty added lines and blank context lines keep numbering',()=>{
  assert.deepEqual(lines('@@ -1,3 +1,4 @@\n a\n\n+\n b\n'),['context:1:1:a','context:2:2:','add::3:','context:3:4:b'],'a stripped blank context line is still line 2');
});

test('patches without a/ b/ prefixes',()=>{
  assert.deepEqual(lines('--- src/x.ts\n+++ src/x.ts\n@@ -2 +2 @@\n-a\n+b\n'),['del:2::a','add::2:b']);
});

test('Codex fileChange shapes: an add\'s diff is the file text, an update\'s is hunks, kind may be an object',()=>{
  const add=normalizeChange({path:'a.md',kind:{type:'add'},diff:'# Title\n- item one\n+ plus line\n'})!;
  assert.equal(add.kind,'add');assert.deepEqual([add.adds,add.dels],[3,0],'"- item" in a new markdown file is content, not a removal');
  assert.equal(add.patch,contentPatch('# Title\n- item one\n+ plus line\n','add'));
  const flat=normalizeChange({path:'a.md',kind:'add',diff:'x\ny'})!;
  assert.deepEqual([flat.adds,flat.dels],[2,0],'persisted rows with a string kind');
  const legacy=normalizeChange({path:'a.md',diff:'plain text file\nsecond line'})!;
  assert.deepEqual([legacy.kind,legacy.adds],['add',2],'a body with no patch markers and no kind is a new file');
  const removed=normalizeChange({path:'gone.txt',kind:{type:'delete'},diff:'old\ntext\n'})!;
  assert.deepEqual([removed.kind,removed.adds,removed.dels],['delete',0,2]);
  const update=normalizeChange({path:'u.ts',kind:{type:'update',move_path:null},diff:'@@ -1 +1 @@\n-a\n+b\n'})!;
  assert.deepEqual([update.kind,update.adds,update.dels],['update',1,1]);
});

test('before/after texts become a real patch with the same counts',()=>{
  const change=normalizeChange({path:'t.ts',before:'a\nb\nc\n',after:'a\nB\nc\nd\n'})!;
  assert.deepEqual([change.adds,change.dels],[2,1]);
  assert.deepEqual(lines(change.patch),['context:1:1:a','del:2::b','add::2:B','context:3:3:c','add::4:d']);
});

test('headers without positions leave the gutter empty instead of inventing line 1',()=>{
  const model=parseInlineDiff('@@ @@\n-old\n+new\n@@ @@\n-x\n+y\n');
  assert.deepEqual(model.rows.map(row=>'oldLine' in row?[row.oldLine,row.newLine]:row.kind),['hunk',[null,null],[null,null],'hunk',[null,null],[null,null]]);
  assert.deepEqual([model.adds,model.dels],[2,2]);
});
