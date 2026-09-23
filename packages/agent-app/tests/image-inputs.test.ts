import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ChildProcess} from 'node:child_process';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {mkdtemp,rm,mkdir,writeFile,copyFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {openAICompatibleAdapter,anthropicAdapter} from '../src/runtime/adapters/http-chat.ts';
import {claudeCodeAdapter,claudeStdin,type Spawn} from '../src/runtime/adapters/claude-code.ts';
import {openCodeAdapter,openCodeCapabilities} from '../src/runtime/adapters/opencode.ts';
import type {AdapterRunInput} from '../src/runtime/adapters/types.ts';
import {createProviderAdapter,type ProviderAdapter,type ProviderInput,type ProviderResult} from '../src/runtime/provider.ts';
import {configuredProviderInstances,invalidateProviderInstances} from '../src/runtime/provider-instances.ts';
import {createAgentService} from '../src/runtime/service.ts';

/** A pasted image must reach the model as an image input on every route that can see images,
 * and a route that cannot must say so instead of silently dropping it (DOGFOOD-1 F32). */

function png(width=2,height=2){const data=Buffer.alloc(33);Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(data);data.writeUInt32BE(13,8);data.write('IHDR',12,'ascii');data.writeUInt32BE(width,16);data.writeUInt32BE(height,20);return data;}
async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-images-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function imageFile(t:TestContext){const path=join(await directory(t),'mock.png');await writeFile(path,png());return path;}
function capture(extra:Partial<AdapterRunInput>={}):AdapterRunInput {
  return {chat:{id:'chat',mode:'agent'} as AdapterRunInput['chat'],cwd:'/work',prompt:'describe the mockup',model:'m',permissionMode:'workspace',signal:new AbortController().signal,
    onThreadReady(){},onTurnAccepted(){},onDelta(){},onReasoning(){},onEvent(){},...extra};
}
function fakeChild() {
  const child=new EventEmitter() as EventEmitter&{stdout:PassThrough;stderr:PassThrough;stdin:PassThrough;kill():boolean};
  child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>true;
  let stdin='';child.stdin.on('data',d=>{stdin+=d;});
  const finish=()=>{child.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok'})+'\n');child.stdout.end();child.stderr.end();setImmediate(()=>child.emit('close',0));};
  return {child,finish,stdin:()=>stdin};
}
const sse=(events:unknown[])=>new Response(new ReadableStream({start(c){for(const e of events)c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`));c.close();}}),{status:200,headers:{'content-type':'text/event-stream'}});

test('Claude Code receives the image as a base64 content block over stream-json input',async t=>{
  const path=await imageFile(t);
  const fake=fakeChild();let args:string[]=[];
  const adapter=claudeCodeAdapter({binary:'/bin/claude',spawn:((_c:string,a:string[])=>{args=a;return fake.child as unknown as ChildProcess;}) as Spawn});
  const running=adapter.run(capture({images:[path]}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(args[args.indexOf('--input-format')+1],'stream-json');
  const message=JSON.parse(fake.stdin().trim()) as {type:string;message:{role:string;content:Array<Record<string,unknown>>}};
  assert.equal(message.type,'user');assert.equal(message.message.role,'user');
  const [image,text]=message.message.content;
  assert.equal(image?.type,'image');
  assert.equal(JSON.stringify(image?.source),JSON.stringify({type:'base64',media_type:'image/png',data:png().toString('base64')}));
  assert.equal(text?.type,'text');assert.equal(text?.text,'describe the mockup');
  fake.finish();
  assert.equal((await running).status,'completed');
  // Text-only turns keep the plain prompt and no input-format flag.
  assert.equal(claudeStdin({prompt:'hi'}),'hi');
});

test('OpenCode attaches images with --file after the message, and a build without --file marks models image-blind',async t=>{
  const path=await imageFile(t);
  const fake=fakeChild();let args:string[]=[];
  const adapter=openCodeAdapter({binary:'/bin/opencode',spawn:(_c,a)=>{args=a;return fake.child as unknown as ChildProcess;}});
  const running=adapter.run(capture({images:[path],model:'opencode/anthropic/claude-x'}));
  const message=args.indexOf('describe the mockup');
  assert.ok(message>0);assert.deepEqual(args.slice(message+1),['--file',path]);
  fake.child.stdout.end();fake.child.stderr.end();setImmediate(()=>fake.child.emit('close',0));await running;

  const replies=new Map([['run --help','Usage: opencode run [message..]\n  --format  format: default | json\n  -f, --file  file(s) to attach to message'],['models','anthropic/claude-x\n']]);
  const probe:Spawn=(_c,a)=>{const f=fakeChild();setImmediate(()=>{f.child.stdout.write(replies.get(a.join(' '))??'');f.child.stdout.end();f.child.stderr.end();setImmediate(()=>f.child.emit('close',0));});return f.child as unknown as ChildProcess;};
  assert.equal((await openCodeCapabilities('/bin/opencode',probe)).models[0]?.images,undefined);
  replies.set('run --help','Usage: opencode run [message..]\n  --format  format: default | json');
  assert.equal((await openCodeCapabilities('/bin/opencode',probe)).models[0]?.images,false);
});

test('HTTP adapters send image parts: OpenAI image_url and Anthropic image blocks',async t=>{
  const path=await imageFile(t),data=png().toString('base64');
  let body:Record<string,unknown>={};
  const openai=openAICompatibleAdapter({endpoint:'https://llm.example/v1',apiKey:()=>'k',label:'Example',fetch:async(_u,init)=>{body=JSON.parse(String(init?.body));return sse([{choices:[{delta:{content:'ok'}}]}]);}});
  await openai.run(capture({images:[path]}));
  const user=(body.messages as Array<{role:string;content:Array<Record<string,unknown>>}>).at(-1)!;
  assert.equal(user.content[1]?.type,'image_url');assert.equal((user.content[1]?.image_url as {url:string}).url,`data:image/png;base64,${data}`);
  const anthropic=anthropicAdapter({apiKey:()=>'k',fetch:async(_u,init)=>{body=JSON.parse(String(init?.body));return sse([{type:'content_block_delta',delta:{type:'text_delta',text:'ok'}},{type:'message_stop'}]);}});
  await anthropic.run(capture({images:[path],model:'claude-x'}));
  const block=(body.messages as Array<{content:Array<Record<string,unknown>>}>).at(-1)!.content[0]!;
  assert.equal(block.type,'image');assert.equal(JSON.stringify(block.source),JSON.stringify({type:'base64',media_type:'image/png',data}));
});

test('Codex app-server route passes images to the core, and the bundled core sends them as localImage input items',async t=>{
  const root=await directory(t),path=join(root,'mock.png');await writeFile(path,png());
  const calls:Record<string,unknown>[]=[];
  const adapter=createProviderAdapter({available:()=>true,command:'/bin/fake-codex',core:{CODEX_RUN_LIFECYCLE_VERSION:1,async runCodexAppServer(input){calls.push(input);return {status:'completed',finalMessage:'',threadId:'t',turnId:'u'};},async callCodexConversation(){return {};},async interruptActiveCodexTurn(){return true;},clearCodexAppServerSessions(){}}});
  try {
    await adapter.run({chat:{id:'c',mode:'agent',model:'claude/claude-fable-5'} as ProviderInput['chat'],cwd:root,prompt:'p',images:[path],onDelta(){},onReasoning(){},onEvent(){},async onRequest(){return undefined;}});
    assert.deepEqual(calls[0]?.images,[path]);
  } finally {adapter.dispose();}

  const bundle=resolve(import.meta.dirname,'../dist/runtime/core-client.cjs');
  if(!existsSync(bundle)){t.diagnostic('dist/runtime/core-client.cjs missing; run npm run build to cover the core turn/start mapping');return;}
  // A minimal app-server: records turn/start params and completes the turn.
  const record=join(root,'turn-start.json'),server=join(root,'fake-app-server.cjs'),command=join(root,'fake-codex.sh');
  await writeFile(server,`const fs=require('fs');const rl=require('readline').createInterface({input:process.stdin});
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
  if(m.method==='thread/start')return send({id:m.id,result:{thread:{id:'th1'}}});
  if(m.method==='turn/start'){fs.writeFileSync(${JSON.stringify(record)},JSON.stringify(m.params));send({id:m.id,result:{turn:{id:'tu1'}}});
    send({method:'item/completed',params:{threadId:'th1',turnId:'tu1',item:{type:'agentMessage',text:'seen'}}});
    return send({method:'turn/completed',params:{threadId:'th1',turn:{id:'tu1',status:'completed'}}});}
  send({id:m.id,result:{}});});`);
  await writeFile(command,`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(server)} "$@"\n`,{mode:0o700});
  const core=createRequire(join(import.meta.dirname,'image-inputs.cjs'))(bundle) as {runCodexAppServer(input:Record<string,unknown>):Promise<ProviderResult>;clearCodexAppServerSessions(owner?:string):void};
  try {
    const result=await core.runCodexAppServer({prompt:'describe the mockup',cwd:root,command,model:'claude/claude-fable-5',images:[path],keepAlive:false,transportOwner:'image-test'});
    assert.equal(result.status,'completed');
    const params=JSON.parse(await readFile(record,'utf8')) as {input:Array<Record<string,unknown>>};
    assert.equal(JSON.stringify(params.input),JSON.stringify([{type:'text',text:'describe the mockup'},{type:'localImage',path}]));
  } finally {core.clearCodexAppServerSessions('image-test');}
});

test('a Codex catalog model without image input_modalities is listed as image-blind',async t=>{
  const root=await directory(t),directoryPath=join(root,'runtime'),cli=join(root,'cli'),catalog=join(root,'catalog.json'),home=join(root,'home');
  await mkdir(join(directoryPath,'resources'),{recursive:true});await mkdir(home);await writeFile(cli,'#!/bin/sh\n',{mode:0o700});
  await copyFile(join(import.meta.dirname,'../../builtin/resources/codex-profile.cjs'),join(directoryPath,'resources/codex-profile.cjs'));
  for(const profile of ['hybrow-gateway','openai-direct'])await writeFile(join(directoryPath,'resources',`codex-${profile}.sh`),'#!/bin/sh\n',{mode:0o700});
  await writeFile(catalog,JSON.stringify({models:[{slug:'gpt-5.6-terra',input_modalities:['text','image']},{slug:'gpt-5.6-luna',input_modalities:['text']},{slug:'gpt-6-astra'}]}));
  await writeFile(join(home,'openai-direct.config.toml'),`model_provider="openai"\nmodel_catalog_json=${JSON.stringify(catalog)}\n`);
  await writeFile(join(home,'auth.json'),JSON.stringify({tokens:{account_id:'A',access_token:'T'}}));
  invalidateProviderInstances();
  const direct=configuredProviderInstances({directory:directoryPath,home:root,env:{CODEX_HOME:home,MUSTER_CODEX_COMMAND:cli}}).find(route=>route.info.id==='openai-direct')!;
  const images=Object.fromEntries(direct.info.models.map(model=>[model.id,model.images]));
  // PRO-05: a declared modality is recorded either way; only an undeclared one stays unknown.
  assert.equal(images['gpt-5.6-terra'],true);assert.equal(images['gpt-5.6-luna'],false);assert.equal(images['gpt-6-astra'],undefined);
});

test('send withholds images from an image-blind model, tells the model, and shows a visible notice',async t=>{
  const dataDir=await directory(t);
  for(const [images,delivered] of [[false,false],[undefined,true]] as const){
    const inputs:ProviderInput[]=[];
    const info:ProviderAdapter['info']=()=>[{id:'hybrow',name:'Hybrow OmniRoute',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Claude Fable 5',...(images===false?{images}:{})}]}];
    const agent=createAgentService({dataDir:join(dataDir,String(delivered)),provider:{info,run:async input=>{inputs.push(input);return {status:'completed',finalMessage:'ok'};},stop:async()=>true,dispose(){}},onEvent(){}});
    try {
      const chat=await agent.invoke('chat.create',{});
      const image=await agent.invoke('attachments.stage',{chatId:chat.id,name:'mock.png',mime:'image/png',dataBase64:png().toString('base64')});
      await agent.invoke('chat.send',{id:chat.id,text:'build this',requestId:'r',attachmentIds:[image.id]});
      for(let i=0;i<500&&!inputs.length;i++)await new Promise(resolve=>setImmediate(resolve));
      assert.equal(inputs.length,1);
      const notices=(await agent.invoke('chat.timeline',{id:chat.id})).items.filter(item=>item.kind==='notice'&&item.data?.kind==='images-unsupported');
      if(delivered){
        assert.equal(inputs[0]!.images?.length,1);assert.equal(notices.length,0);assert.doesNotMatch(inputs[0]!.prompt,/cannot view/);
      } else {
        assert.equal(inputs[0]!.images,undefined);
        assert.match(inputs[0]!.prompt,/attached an image \(mock\.png\) that this model cannot view/);
        assert.equal(notices.length,1);assert.match(notices[0]!.text,/Claude Fable 5 \(Hybrow OmniRoute\) can’t view images, so “mock\.png” was not sent/);
      }
    } finally {await agent.dispose();}
  }
});
