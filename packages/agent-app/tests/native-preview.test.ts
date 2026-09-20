import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {previewBounds,NativePreviewController} from '../src/main/native-preview.ts';

test('native preview clamps geometry and rejects non-finite input',()=>{
  assert.deepEqual(previewBounds({x:80,y:20,width:90,height:100},100,80),{x:80,y:20,width:20,height:60});
  assert.throws(()=>previewBounds({x:NaN,y:0,width:1,height:1},100,100));
  assert.throws(()=>previewBounds({x:0,y:0,width:'10',height:1},100,100));
});

test('native preview rejects escaped paths and late work cannot retake a closed pane',{skip:process.platform!=='darwin'},async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'muster-native-preview-'));
  try {
    const root=path.join(dir,'root');await (await import('node:fs/promises')).mkdir(root);
    await writeFile(path.join(root,'sample.pdf'),'fixture');await writeFile(path.join(dir,'outside.pdf'),'outside');
    await symlink(path.join(dir,'outside.pdf'),path.join(root,'escape.pdf'));
    const modulePath=path.join(dir,'preview.cjs');await writeFile(modulePath,'module.exports={show(){throw new Error("unexpected native show")},hide(){},refresh(){}}');
    const controller=new NativePreviewController({isDestroyed:()=>false,getContentSize:()=>[100,100]} as never,modulePath);
    const request={owner:'tab:1',folderId:'folder',path:'sample.pdf',bounds:{x:0,y:0,width:90,height:90}};
    await assert.rejects(controller.show({...request,path:'../outside.pdf'},async()=>root));
    await assert.rejects(controller.show({...request,path:'escape.pdf'},async()=>root));
    await assert.rejects(controller.show({...request,path:'sample.exe'},async()=>root));
    let release!:(root:string)=>void;const pending=controller.show(request,()=>new Promise(resolve=>{release=resolve}));
    controller.hide('tab:1');release(root);await pending;
    controller.position('tab:1',request.bounds); // closed ownership must not resurrect preview
  } finally {await rm(dir,{recursive:true,force:true});}
});
