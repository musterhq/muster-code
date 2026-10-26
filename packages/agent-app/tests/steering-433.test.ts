import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ChildProcess} from 'node:child_process';
import {claudeCodeAdapter,claudeSteerText,type Spawn} from '../src/runtime/adapters/claude-code.ts';
import {createProviderAdapter,type ProviderInput,type CoreClient} from '../src/runtime/provider.ts';
import {openAICompatibleAdapter} from '../src/runtime/adapters/http-chat.ts';
import {ConversationMemory} from '../src/runtime/adapters/shared.ts';
import type {AdapterRunInput,AdapterRunResult} from '../src/runtime/adapters/types.ts';

function fakeChild() {
  const child=new EventEmitter() as EventEmitter&{stdout:PassThrough;stderr:PassThrough;stdin:PassThrough;kill(signal?:string):boolean};
  child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>true;
  let stdin='';child.stdin.on('data',d=>{stdin+=d;});
  return {child,emit:(...lines:unknown[])=>{for(const l of lines)child.stdout.write(JSON.stringify(l)+'\n');},close:(code:number)=>{child.stdout.end();child.stderr.end();setImmediate(()=>child.emit('close',code));},stdin:()=>stdin};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('provider.steer reaches a Claude Code run through the real adapter',async()=>{
  const fake=fakeChild();
  const route={info:{id:'claude-code',name:'Claude Code',available:true,bindingId:'b1',identityMasked:'x',models:[{id:'claude-code/opus',name:'Opus'}]},command:'',env:{},sessionsRoot:'',
    adapter:claudeCodeAdapter({binary:'/bin/claude',spawn:(()=>fake.child as unknown as ChildProcess) as Spawn})};
  const provider=createProviderAdapter({instances:()=>[route]});
  const request={chat:{id:'c',mode:'agent',providerId:'claude-code',model:'claude-code/opus',providerBindingId:'b1'},cwd:'/work',prompt:'p',onDelta(){},onReasoning(){},onEvent(){},onTurnAccepted(){},async onRequest(){return undefined;}} as unknown as ProviderInput;
  const running=provider.run(request);await tick();
  fake.emit({type:'system',subtype:'init',session_id:'s'});await tick();
  assert.equal(await provider.steer!('c','also this'),true);
  assert.match(fake.stdin(),/also this/);
  fake.emit({type:'result',subtype:'success',result:'a'},{type:'result',subtype:'success',result:'b'});await tick();fake.close(0);
  assert.equal((await running).status,'completed');provider.dispose();
});

// ---- Claude Code: the CLI folds steers sent mid-turn into that turn and answers with ONE result ----
test('Claude Code: three rapid steers arrive in order; one shared result still ends the run (the CLI folds them into the turn)',async()=>{
  const fake=fakeChild();let ended=false;fake.child.stdin.on('finish',()=>{ended=true;});
  const adapter=claudeCodeAdapter({binary:'/bin/claude',steerGraceMs:30,spawn:(()=>fake.child as unknown as ChildProcess) as Spawn});
  let send!:(text:string)=>boolean;
  const running=adapter.run({chat:{id:'c'} as any,cwd:'/w',prompt:'start',model:'claude-code/opus',permissionMode:'workspace',signal:new AbortController().signal,onThreadReady(){},onTurnAccepted(){},onDelta(){},onReasoning(){},onEvent(){},onSteerable:fn=>{send=fn;}});
  await tick();fake.emit({type:'system',subtype:'init',session_id:'s'},{type:'assistant',message:{content:[{type:'text',text:'working'}]}});
  assert.deepEqual(['one','two','three'].map(send),[true,true,true]);
  assert.deepEqual(fake.stdin().trim().split('\n').map(line=>JSON.parse(line).message.content[0].text),['start',...['one','two','three'].map(claudeSteerText)]);
  fake.emit({type:'result',subtype:'success',result:'ONE two three'});await tick();
  assert.equal(ended,false,'stdin stays open right after the result: a steer may still start another turn');
  assert.equal(send('four'),true,'a steer inside the grace window still goes through');
  await new Promise(resolve=>setTimeout(resolve,10));
  fake.emit({type:'result',subtype:'success',result:'four'});await tick();
  assert.equal(ended,false,'the result answered an unconfirmed steer: wait out the grace window');
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(ended,true);assert.equal(send('late'),false);
  fake.close(0);assert.equal((await running).status,'completed');
});

test('Claude Code: if the CLI answers each steer with its own result, stdin stays open until the last one',async()=>{
  const fake=fakeChild();let ended=false;fake.child.stdin.on('finish',()=>{ended=true;});
  const adapter=claudeCodeAdapter({binary:'/bin/claude',steerGraceMs:40,spawn:(()=>fake.child as unknown as ChildProcess) as Spawn});
  let send!:(text:string)=>boolean;
  const running=adapter.run({chat:{id:'c'} as any,cwd:'/w',prompt:'start',model:'claude-code/opus',permissionMode:'workspace',signal:new AbortController().signal,onThreadReady(){},onTurnAccepted(){},onDelta(){},onReasoning(){},onEvent(){},onSteerable:fn=>{send=fn;}});
  await tick();fake.emit({type:'system',subtype:'init',session_id:'s'});
  send('a');send('b');
  fake.emit({type:'result',subtype:'success',result:'r1'});await tick();
  fake.emit({type:'assistant',message:{content:[{type:'text',text:'second turn'}]}});await new Promise(resolve=>setTimeout(resolve,60));
  assert.equal(ended,false,'a new turn started: the grace timer must not close stdin under it');
  fake.emit({type:'result',subtype:'success',result:'r2'});await new Promise(resolve=>setTimeout(resolve,60));
  assert.equal(ended,true);fake.close(0);await running;
});

// ---- service: normal and project chats, several steers in a row, every route kind ----
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import {NO_MID_RUN_STEER,type ProviderAdapter,type ProviderResult} from '../src/runtime/provider.ts';
const info:ProviderAdapter['info']=()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture'}]}];
async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<500;i++){if(await check())return;await tick();}assert.fail('condition not reached');}
function gated(steer?:ProviderAdapter['steer']){
  let gate:PromiseWithResolvers<ProviderResult>|undefined;
  const provider:ProviderAdapter={info,run:async()=>{gate=Promise.withResolvers();return gate.promise;},stop:async()=>true,dispose(){},...(steer?{steer}:{})};
  return {provider,finish(){const g=gate!;gate=undefined;g.resolve({status:'completed',finalMessage:'done'});},get open(){return !!gate;}};
}
for(const kind of ['normal','project'] as const)test(`service (${kind} chat): three back-to-back steers reach the agent in order and show in the timeline in order`,async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'muster-steer-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const got:string[]=[];
  // The first steer is slow: the second and third must still wait their turn.
  const fake=gated(async(_id,text)=>{if(got.length===0)await new Promise(resolve=>setTimeout(resolve,20));got.push(text);return true;});
  const service=createAgentService({dataDir,provider:fake.provider,onEvent(){}});t.after(()=>service.dispose());
  let chat;
  if(kind==='project'){const folder=await service.invoke('folder.add',{path:dataDir});const project=await service.invoke('project.create',{name:'P',goal:'goal',folderIds:[folder.id]});chat=await service.invoke('chat.create',{folderId:folder.id,projectId:project.id});}
  else chat=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chat.id,text:'start',requestId:'start'});await until(()=>fake.open);
  const results=await Promise.all(['one','two','three'].map((text,i)=>service.invoke('chat.steer',{id:chat.id,text,requestId:`s${i}`})));
  assert.deepEqual(results,[{steered:true},{steered:true},{steered:true}]);
  assert.deepEqual(got,['one','two','three']);
  const users=(await service.invoke('chat.timeline',{id:chat.id})).items.filter(item=>item.kind==='user');
  assert.deepEqual(users.map(item=>item.text),['start','one','two','three']);
  assert.deepEqual(users.slice(1).map(item=>item.data?.steered),[true,true,true]);
  fake.finish();
});

test('service: a route that cannot take messages mid-run says so, and the queue Steer button returns that reason',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'muster-steer-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const fake=gated(async()=>({refused:NO_MID_RUN_STEER}));
  const service=createAgentService({dataDir,provider:fake.provider,onEvent(){}});t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chat.id,text:'start',requestId:'start'});await until(()=>fake.open);
  assert.deepEqual(await service.invoke('chat.steer',{id:chat.id,text:'x',requestId:'sx'}),{steered:false,reason:NO_MID_RUN_STEER});
  const queued=await service.invoke('chat.queue.add',{id:chat.id,text:'later',requestId:'ql'});
  assert.deepEqual(await service.invoke('chat.queue.steer',{id:chat.id,queueId:queued.id}),{steered:false,started:false,reason:NO_MID_RUN_STEER});
  assert.equal((await service.invoke('app.snapshot',undefined)).chats.find(c=>c.id===chat.id)!.queue?.length,1,'the message stays queued');
  fake.finish();await until(()=>fake.open);fake.finish();
});

// ---- provider matrix ----
test('provider: every adapter route answers a steer (steers or says why); Codex names the current turn each time',async()=>{
  const stubAdapter=(steerable:boolean)=>({kind:'cli' as const,run:(input:AdapterRunInput)=>new Promise<AdapterRunResult>(resolve=>{if(steerable)input.onSteerable?.(()=>true);input.onThreadReady('t');input.onTurnAccepted({threadId:'t',turnId:'u'});setTimeout(()=>resolve({status:'completed',finalMessage:'',dispatchState:'dispatched'}),30);})});
  const routes=[['steerable',true],['plain',false]].map(([id,steerable])=>({info:{id:id as string,name:id as string,available:true,bindingId:`b-${id}`,identityMasked:'x',models:[{id:`${id}/m`,name:'m'}]},command:'',env:{},sessionsRoot:'',adapter:stubAdapter(steerable as boolean)}));
  const provider=createProviderAdapter({instances:()=>routes});
  const req=(id:string):ProviderInput=>({chat:{id:`chat-${id}`,mode:'agent',providerId:id,model:`${id}/m`,providerBindingId:`b-${id}`},cwd:'/w',prompt:'p',onDelta(){},onReasoning(){},onEvent(){},onTurnAccepted(){},async onRequest(){return undefined;}} as unknown as ProviderInput);
  const a=provider.run(req('steerable')),b=provider.run(req('plain'));await tick();
  assert.equal(await provider.steer!('chat-steerable','hi'),true);
  assert.deepEqual(await provider.steer!('chat-plain','hi'),{refused:NO_MID_RUN_STEER});
  await Promise.all([a,b]);provider.dispose();
});

test('Codex: three steers each name the current turn, in order',async()=>{
  const calls:Array<{method:string;params:any}>=[];let resolve!:(r:ProviderResult)=>void;
  const core:CoreClient={CODEX_RUN_LIFECYCLE_VERSION:1,runCodexAppServer:(launch:any)=>new Promise(done=>{resolve=done;launch.onThreadReady('th');launch.onTurnAccepted({threadId:'th',turnId:'turn-1',dispatchState:'dispatched'});}),
    async callCodexConversation(_key:string,method:string,params:any){calls.push({method,params});return {};},async interruptActiveCodexTurn(){return true;},clearCodexAppServerSessions(){}} as any;
  const adapter=createProviderAdapter({core,available:()=>true,command:'/unused'});
  const pending=adapter.run({chat:{id:'x',mode:'agent',providerId:'fixture',model:'fixture-model'},cwd:'/w',prompt:'p',onDelta(){},onReasoning(){},onEvent(){},async onRequest(){return undefined;}} as unknown as ProviderInput);
  await tick();
  const outcomes=await Promise.all(['one','two','three'].map(text=>adapter.steer!('x',text)));
  assert.deepEqual(outcomes,[true,true,true]);
  assert.deepEqual(calls.map(c=>c.params.input[0].text),['one','two','three']);
  assert.ok(calls.every(c=>c.method==='turn/steer'&&c.params.expectedTurnId==='turn-1'&&c.params.threadId==='th'));
  resolve({status:'completed',finalMessage:'',dispatchState:'dispatched',threadId:'th',turnId:'turn-1'});await pending;adapter.dispose();
});

// ---- HTTP / router routes: the loop owns its rounds, so steers join before the next request ----
test('HTTP route: three steers sent during a stream join the next request in order and the next turn remembers them',async()=>{
  const bodies:any[]=[];let release!:()=>void;let calls=0;
  const enc=new TextEncoder();
  const chunk=(content:string)=>`data: ${JSON.stringify({choices:[{delta:{content}}]})}\n\n`;
  const memory=new ConversationMemory();
  const adapter=openAICompatibleAdapter({endpoint:'https://llm.example/v1',apiKey:()=>'k',label:'Example',tools:false,memory,
    fetch:async(_url,init)=>{bodies.push(JSON.parse(String(init?.body)));calls++;
      if(calls===1)return new Response(new ReadableStream({start(c){c.enqueue(enc.encode(chunk('first reply')));release=()=>{c.enqueue(enc.encode('data: [DONE]\n\n'));c.close();};}}),{status:200});
      return new Response(new ReadableStream({start(c){c.enqueue(enc.encode(chunk('after steers')+'data: [DONE]\n\n'));c.close();}}),{status:200});}});
  let send!:(text:string)=>boolean;
  const log:string[]=[];
  const run=adapter.run({chat:{id:'c'} as any,cwd:'/w',prompt:'start',model:'m',permissionMode:'workspace',signal:new AbortController().signal,onThreadReady(){},onTurnAccepted(){},onDelta:t=>log.push(t),onReasoning(){},onEvent(){},onSteerable:fn=>{send=fn;}});
  await until(()=>typeof release==='function');
  assert.deepEqual(['one','two','three'].map(send),[true,true,true]);
  release();const result=await run;
  assert.equal(result.status,'completed');assert.equal(calls,2);
  const sent=bodies[1].messages.filter((m:any)=>m.role!=='system');
  assert.deepEqual(sent.map((m:any)=>[m.role,m.content]),[['user','start'],['assistant','first reply'],['user','one'],['user','two'],['user','three']]);
  assert.equal(send('late'),false);
  const next=await adapter.run({chat:{id:'c'} as any,cwd:'/w',prompt:'next',model:'m',permissionMode:'workspace',resumeThreadId:result.threadId,signal:new AbortController().signal,onThreadReady(){},onTurnAccepted(){},onDelta(){},onReasoning(){},onEvent(){}});
  assert.equal(next.status,'completed');
  const history=bodies[2].messages.filter((m:any)=>m.role!=='system').map((m:any)=>[m.role,m.content]);
  assert.deepEqual(history,[['user','start'],['assistant','first reply'],['user','one'],['user','two'],['user','three'],['assistant','after steers'],['user','next']]);
});
