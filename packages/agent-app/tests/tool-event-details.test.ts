import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {extractToolImages,imageSize,setToolImageStore,toolEventDetails,type ToolImage} from '../src/runtime/tool-event-details.ts';

// 1×1 PNG.
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('image parts become decoded images with a placeholder in the JSON, never base64 text',()=>{
  setToolImageStore(undefined);
  let images:ToolImage[]=[];
  const copy=extractToolImages({content:[{type:'image',data:PNG,mimeType:'image/png'},{type:'text',text:'done'}]},images);
  assert.equal(images.length,1);assert.equal(images[0]!.width,1);assert.equal(images[0]!.height,1);assert.equal(images[0]!.mime,'image/png');
  assert.ok(images[0]!.dataUrl?.startsWith('data:image/png;base64,'));
  assert.deepEqual(copy,{content:[{type:'image',mimeType:'image/png',shown:1},{type:'text',text:'done'}]});
  const codex=extractToolImages([{type:'inputImage',imageUrl:`data:image/png;base64,${PNG}`}],images=[]);
  assert.equal(images.length,1);assert.deepEqual(codex,[{type:'image',mimeType:'image/png',shown:1}]);
  assert.equal(imageSize(Buffer.from('GIF89a\x10\x00\x08\x00','latin1'))?.width,16);
});

test('tool details keep full-resolution screenshots in the image store and mask typed secrets',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'muster-tool-images-'));
  setToolImageStore(dir);
  try {
    const details=toolEventDetails({type:'mcpToolCall',server:'computer-use',tool:'type',arguments:JSON.stringify({app:'Safari',element:'Password',text:'hunter2'}),result:{content:[{type:'image',data:PNG,mimeType:'image/png'}]}});
    assert.equal(details.computer,'computer');
    assert.ok(!String(details.arguments).includes('hunter2'));assert.ok(String(details.arguments).includes('••••••'));
    assert.ok(!String(details.result).includes(PNG));
    const images=details.images as ToolImage[];
    assert.equal(images.length,1);assert.match(images[0]!.id!,/^[a-f0-9]{32}\.png$/);assert.ok(!images[0]!.dataUrl);
    assert.equal(fs.readFileSync(path.join(dir,images[0]!.id!)).toString('base64'),PNG);
    // Re-reading the same result (hydration) reuses the file.
    toolEventDetails({type:'mcpToolCall',server:'computer-use',tool:'screenshot',result:{content:[{type:'image',data:PNG,mimeType:'image/png'}]}});
    assert.equal(fs.readdirSync(dir).length,1);
    const plain=toolEventDetails({type:'mcpToolCall',server:'github',tool:'search',arguments:'{"q":"x"}'});
    assert.equal(plain.computer,undefined);assert.equal(plain.images,undefined);assert.equal(JSON.parse(String(plain.arguments)),'{"q":"x"}');
  } finally { setToolImageStore(undefined); fs.rmSync(dir,{recursive:true,force:true}); }
});

test('file changes keep Codex kind objects, renames and whole patches (cut on a line and marked)',async()=>{
  const {fileChanges,MAX_CHANGE_DIFF}=await import('../src/runtime/tool-event-details.ts');
  const details=toolEventDetails({type:'fileChange',changes:[{path:'a.md',kind:{type:'add'},diff:'# A\n'},{path:'old.ts',kind:{type:'update',move_path:'new.ts'},diff:'@@ -1 +1 @@\n-a\n+b'},{path:'s.ts',kind:'update',diff:'@@ -1 +1 @@\n-a\n+b'}]});
  assert.deepEqual(details.changes,[{path:'a.md',kind:'add',diff:'# A\n'},{path:'old.ts',kind:'update',movePath:'new.ts',diff:'@@ -1 +1 @@\n-a\n+b'},{path:'s.ts',kind:'update',diff:'@@ -1 +1 @@\n-a\n+b'}]);
  const big='@@ -0,0 +1,99999 @@\n'+Array.from({length:99999},(_,index)=>`+line ${index}`).join('\n');
  assert.ok(big.length>MAX_CHANGE_DIFF);
  const [cut]=fileChanges([{path:'big.ts',diff:big}]);
  assert.equal(cut.diffTruncated,true);
  assert.ok((cut.diff as string).length<=MAX_CHANGE_DIFF&&!(cut.diff as string).endsWith('+line'),'cut at a line boundary');
  const small='@@ -1 +1 @@\n-a\n+b\n'+'+x\n'.repeat(12000);
  assert.equal(fileChanges([{path:'s.ts',diff:small}])[0].diff,small,'patches over the old 32 KB limit are kept whole');
});
