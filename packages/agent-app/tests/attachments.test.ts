import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter,ProviderInput,ProviderResult} from '../src/runtime/provider.ts';
import {attachmentKind,imageDimensions,sanitizeAttachmentName} from '../src/runtime/attachments.ts';

const info:ProviderAdapter['info']=()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture'}]}];
async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-attach-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<500;i++){if(await check())return;await new Promise(resolve=>setImmediate(resolve));}assert.fail('condition not reached');}
function png(width:number,height:number){const data=Buffer.alloc(33);Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(data);data.writeUInt32BE(13,8);data.write('IHDR',12,'ascii');data.writeUInt32BE(width,16);data.writeUInt32BE(height,20);return data;}
function service(dataDir:string,result:ProviderResult={status:'completed',finalMessage:'ok'}){
  const inputs:ProviderInput[]=[];
  const provider:ProviderAdapter={info,run:async input=>{inputs.push(input);return result;},stop:async()=>true,dispose(){}};
  return {inputs,service:createAgentService({dataDir,provider,onEvent(){}})};
}

test('header parsing, names and kinds',()=>{
  assert.deepEqual(imageDimensions('image/png',png(640,480)),{width:640,height:480});
  const gif=Buffer.from('GIF89a\x20\x00\x10\x00','latin1');assert.deepEqual(imageDimensions('image/gif',gif),{width:32,height:16});
  const jpeg=Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0x04,0x00,0x00,0xff,0xc0,0x00,0x11,0x08,0x00,0x20,0x00,0x40,0x03]);assert.deepEqual(imageDimensions('image/jpeg',jpeg),{width:64,height:32});
  const webp=Buffer.alloc(30);webp.write('RIFF',0,'ascii');webp.write('WEBP',8,'ascii');webp.write('VP8X',12,'ascii');webp.writeUIntLE(99,24,3);webp.writeUIntLE(49,27,3);assert.deepEqual(imageDimensions('image/webp',webp),{width:100,height:50});
  assert.equal(imageDimensions('image/png',Buffer.from('not an image')),undefined);
  assert.equal(sanitizeAttachmentName('../../etc/pass wd?.txt'),'pass wd_.txt');assert.equal(sanitizeAttachmentName('...'),'attachment');
  assert.equal(attachmentKind('image/webp'),'image');assert.equal(attachmentKind('image/svg+xml'),'file');assert.equal(attachmentKind('application/pdf'),'file');
});

test('staged files persist privately, dedupe, preview, and survive a restart',async t=>{
  const dataDir=await directory(t);let {service:agent}=service(dataDir);
  const chat=await agent.invoke('chat.create',{});
  const image=await agent.invoke('attachments.stage',{chatId:chat.id,name:'shot.png',mime:'image/png',dataBase64:png(4,3).toString('base64')});
  assert.equal(image.kind,'image');assert.equal(image.width,4);assert.equal(image.height,3);assert.equal(image.state,'staged');assert.equal(image.size,33);
  assert.equal((await agent.invoke('attachments.stage',{chatId:chat.id,name:'shot.png',mime:'image/png',dataBase64:png(4,3).toString('base64')})).id,image.id);
  const file=await agent.invoke('attachments.stage',{chatId:chat.id,name:'notes.txt',mime:'text/plain',dataBase64:Buffer.from('hello').toString('base64')});
  assert.equal(file.kind,'file');
  await assert.rejects(agent.invoke('attachments.stage',{chatId:chat.id,name:'fake.png',mime:'image/png',dataBase64:Buffer.from('nope').toString('base64')}),/not a readable PNG/);
  await assert.rejects(agent.invoke('attachments.stage',{chatId:chat.id,name:'empty.txt',mime:'text/plain',dataBase64:''}),/empty/);
  const stored=await stat(join(dataDir,'attachments',chat.id,`${file.id}-notes.txt`));assert.equal(stored.mode&0o777,0o600);
  assert.ok((await agent.invoke('attachments.preview',{chatId:chat.id,id:image.id})).dataUrl.startsWith('data:image/png;base64,'));
  await assert.rejects(agent.invoke('attachments.preview',{chatId:chat.id,id:file.id}),/Only images/);
  await agent.dispose();
  ({service:agent}=service(dataDir));
  assert.deepEqual((await agent.invoke('attachments.list',{chatId:chat.id})).map(ref=>ref.name),['shot.png','notes.txt']);
  await agent.invoke('attachments.discard',{chatId:chat.id,id:file.id});
  assert.deepEqual((await agent.invoke('attachments.list',{chatId:chat.id})).map(ref=>ref.id),[image.id]);
  await assert.rejects(stat(join(dataDir,'attachments',chat.id,`${file.id}-notes.txt`)));
  await agent.dispose();
});

test('send delivers images as local paths and files as prompt lines, then marks them sent',async t=>{
  const dataDir=await directory(t),{service:agent,inputs}=service(dataDir);
  const chat=await agent.invoke('chat.create',{}),other=await agent.invoke('chat.create',{});
  const image=await agent.invoke('attachments.stage',{chatId:chat.id,name:'shot.png',mime:'image/png',dataBase64:png(2,2).toString('base64')});
  const file=await agent.invoke('attachments.stage',{chatId:chat.id,name:'notes.txt',mime:'text/plain',dataBase64:Buffer.from('hello').toString('base64')});
  const foreign=await agent.invoke('attachments.stage',{chatId:other.id,name:'x.txt',mime:'text/plain',dataBase64:Buffer.from('x').toString('base64')});
  await assert.rejects(agent.invoke('chat.send',{id:chat.id,text:'look',requestId:'bad',attachmentIds:[foreign.id]}),/no longer available/);
  await assert.rejects(agent.invoke('chat.send',{id:chat.id,text:'look',requestId:'dup',attachmentIds:[image.id,image.id]}),/twice/);
  const sent=await agent.invoke('chat.send',{id:chat.id,text:'',requestId:'good',attachmentIds:[image.id,file.id]});
  await until(()=>inputs.length===1);
  assert.deepEqual(inputs[0]!.images,[join(dataDir,'attachments',chat.id,`${image.id}-shot.png`)]);
  assert.match(inputs[0]!.prompt,new RegExp(`Attached file: .*${file.id}-notes\\.txt \\(text/plain, 5 B\\)`));
  assert.doesNotMatch(inputs[0]!.prompt,/shot\.png/);
  assert.equal((await agent.invoke('chat.send',{id:chat.id,text:'',requestId:'good',attachmentIds:[image.id,file.id]})).runId,sent.runId);
  await assert.rejects(agent.invoke('chat.send',{id:chat.id,text:'',requestId:'good',attachmentIds:[image.id]}),/conflicts/);
  const user=(await agent.invoke('chat.timeline',{id:chat.id})).items.find(item=>item.kind==='user')!;
  const refs=user.data?.attachments as Array<{id:string;state:string;path?:string}>;
  assert.deepEqual(refs.map(ref=>[ref.id,ref.state,'path' in ref]),[[image.id,'sent',false],[file.id,'sent',false]]);
  assert.deepEqual(await agent.invoke('attachments.list',{chatId:chat.id}),[]);
  await until(async()=>(await agent.invoke('app.snapshot',undefined)).chats.find(item=>item.id===chat.id)?.status==='completed');
  await assert.rejects(agent.invoke('chat.send',{id:chat.id,text:'again',requestId:'again',attachmentIds:[image.id]}),/already sent/);
  await assert.rejects(agent.invoke('attachments.discard',{chatId:chat.id,id:image.id}),/already sent/);
  await agent.dispose();
});

test('a send that never reached the provider returns its files to the composer',async t=>{
  const dataDir=await directory(t),{service:agent}=service(dataDir,{status:'failed',finalMessage:'',dispatchState:'not-dispatched',recovery:{kind:'failed',retryable:false,reason:'No.'}});
  const chat=await agent.invoke('chat.create',{});
  const file=await agent.invoke('attachments.stage',{chatId:chat.id,name:'a.txt',mime:'text/plain',dataBase64:Buffer.from('a').toString('base64')});
  await agent.invoke('chat.send',{id:chat.id,text:'try',requestId:'try',attachmentIds:[file.id]});
  await until(async()=>(await agent.invoke('app.snapshot',undefined)).chats[0]?.status==='failed');
  assert.deepEqual((await agent.invoke('attachments.list',{chatId:chat.id})).map(ref=>ref.id),[file.id]);
  await agent.dispose();
});

test('queued messages own their attachments until dispatched',async t=>{
  const dataDir=await directory(t);let gate=Promise.withResolvers<ProviderResult>();const inputs:ProviderInput[]=[];
  const provider:ProviderAdapter={info,run:async input=>{inputs.push(input);return gate.promise;},stop:async()=>true,dispose(){}};
  const agent=createAgentService({dataDir,provider,onEvent(){}});
  const chat=await agent.invoke('chat.create',{});
  await agent.invoke('chat.send',{id:chat.id,text:'start',requestId:'start'});await until(()=>inputs.length===1);
  const file=await agent.invoke('attachments.stage',{chatId:chat.id,name:'later.txt',mime:'text/plain',dataBase64:Buffer.from('later').toString('base64')});
  await agent.invoke('chat.queue.add',{id:chat.id,text:'with file',requestId:'queued',attachmentIds:[file.id]});
  assert.deepEqual(await agent.invoke('attachments.list',{chatId:chat.id}),[]);
  await assert.rejects(agent.invoke('attachments.discard',{chatId:chat.id,id:file.id}),/queued message/);
  const again=await agent.invoke('attachments.stage',{chatId:chat.id,name:'later.txt',mime:'text/plain',dataBase64:Buffer.from('later').toString('base64')});
  assert.notEqual(again.id,file.id);
  await assert.rejects(agent.invoke('chat.send',{id:chat.id,text:'steal',requestId:'steal',attachmentIds:[file.id]}),/queued message/);
  await agent.invoke('attachments.discard',{chatId:chat.id,id:again.id});
  const first=gate;gate=Promise.withResolvers();first.resolve({status:'completed',finalMessage:'ok'});
  await until(()=>inputs.length===2);
  assert.match(inputs[1]!.prompt,/Attached file: .*later\.txt/);
  gate.resolve({status:'completed',finalMessage:'ok'});
  await until(async()=>(await agent.invoke('app.snapshot',undefined)).chats[0]?.status==='completed');
  await agent.dispose();
});

// png() above is only complete enough for imageDimensions() (attachments.stage); file-assets.ts's readAsset (used by
// attachments.asset) also requires a trailing IEND chunk, so give it one.
function completePng(width:number,height:number){return Buffer.concat([png(width,height),Buffer.from([0,0,0,0,0x49,0x45,0x4e,0x44,0,0,0,0])]);}

// The "open in the resource pane" fix (AttachmentTab): images and text files read through the same confined
// root+rel readers as files.asset/files.read, scoped to this chat's own attachment directory.
test('attachments.asset/read serve a staged attachment for the resource pane, confined to its own chat',async t=>{
  const dataDir=await directory(t),{service:agent}=service(dataDir);
  const chat=await agent.invoke('chat.create',{}),other=await agent.invoke('chat.create',{});
  const image=await agent.invoke('attachments.stage',{chatId:chat.id,name:'shot.png',mime:'image/png',dataBase64:completePng(6,4).toString('base64')});
  const note=await agent.invoke('attachments.stage',{chatId:chat.id,name:'notes.txt',mime:'text/plain',dataBase64:Buffer.from('hello from the pane').toString('base64')});
  const asset=await agent.invoke('attachments.asset',{chatId:chat.id,id:image.id});
  assert.equal(asset.mime,'image/png');assert.equal(asset.width,6);assert.equal(asset.height,4);
  assert.ok(asset.dataUrl.startsWith('data:image/png;base64,'));
  const read=await agent.invoke('attachments.read',{chatId:chat.id,id:note.id});
  assert.equal(read.text,'hello from the pane');assert.equal(read.truncated,false);
  // A sent attachment keeps serving its bytes (the transcript and queue chips open it too, long after it left the composer).
  await agent.invoke('chat.send',{id:chat.id,text:'',requestId:'send',attachmentIds:[image.id]});
  assert.ok((await agent.invoke('attachments.asset',{chatId:chat.id,id:image.id})).dataUrl.startsWith('data:image/png;base64,'));
  // Confinement: neither a foreign chat's id nor an unknown id resolves, and reading an image as text is refused.
  await assert.rejects(agent.invoke('attachments.asset',{chatId:other.id,id:image.id}),/no longer available/);
  await assert.rejects(agent.invoke('attachments.read',{chatId:chat.id,id:'00000000-0000-0000-0000-000000000000'}),/no longer available/);
  await assert.rejects(agent.invoke('attachments.read',{chatId:chat.id,id:image.id}),/Binary file/);
  await agent.dispose();
});

// The queued-message chips fix: attachments.info gives QueuedMessages the file names it has no other way to know.
test('attachments.info returns metadata for known ids in this chat and silently drops the rest',async t=>{
  const dataDir=await directory(t),{service:agent}=service(dataDir);
  const chat=await agent.invoke('chat.create',{}),other=await agent.invoke('chat.create',{});
  const file=await agent.invoke('attachments.stage',{chatId:chat.id,name:'later.txt',mime:'text/plain',dataBase64:Buffer.from('later').toString('base64')});
  const foreign=await agent.invoke('attachments.stage',{chatId:other.id,name:'x.txt',mime:'text/plain',dataBase64:Buffer.from('x').toString('base64')});
  const info=await agent.invoke('attachments.info',{chatId:chat.id,ids:[file.id,foreign.id,'missing-id']});
  assert.deepEqual(info.map(ref=>[ref.id,ref.name,ref.mime]),[[file.id,'later.txt','text/plain']]);
  await agent.dispose();
});
