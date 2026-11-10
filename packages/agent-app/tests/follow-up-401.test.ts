/** #401: a suggested next prompt after a turn (provider-emitted on Claude Code, one bounded request on HTTP routes), and
 *  the record of what each turn ran with that the transcript's model markers are drawn from. */
import assert from 'node:assert/strict';
import {test,mock,type TestContext} from 'node:test';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ChildProcess} from 'node:child_process';
import {claudeCodeAdapter,type Spawn} from '../src/runtime/adapters/claude-code.ts';
import {openAICompatibleAdapter} from '../src/runtime/adapters/http-chat.ts';
import type {AdapterRunInput} from '../src/runtime/adapters/types.ts';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter,ProviderInput,ProviderResult} from '../src/runtime/provider.ts';

const flush=async()=>{for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));};
async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-401-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<500;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('condition not reached');}

function claudeHarness(withSuggestion:boolean){
  const child=new EventEmitter() as EventEmitter&{stdout:PassThrough;stderr:PassThrough;stdin:PassThrough;kill(signal?:string):boolean};
  child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();
  const kills:string[]=[];child.kill=(signal?:string)=>{kills.push(signal??'SIGTERM');return true;};
  let args:string[]=[];const suggestions:string[]=[];
  const input:AdapterRunInput={chat:{id:'chat',mode:'agent'} as AdapterRunInput['chat'],cwd:'/work',prompt:'go',model:'claude-code/sonnet',permissionMode:'workspace',signal:new AbortController().signal,
    onThreadReady(){},onTurnAccepted(){},onDelta(){},onReasoning(){},onEvent(){},...(withSuggestion?{onSuggestion:(text:string)=>{suggestions.push(text);}}:{})};
  let settled=false;
  const running=claudeCodeAdapter({binary:'/bin/claude',spawn:((_command:string,spawnArgs:string[])=>{args=spawnArgs;return child as unknown as ChildProcess;}) as unknown as Spawn}).run(input).then(result=>{settled=true;return result;});
  const emit=(...rows:unknown[])=>{for(const row of rows)child.stdout.write(JSON.stringify(row)+'\n');};
  return {child,kills,emit,running,suggestions,args:()=>args,settled:()=>settled};
}

// Spec: MUS-SPEC-02-401A (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-401a)
test('Claude Code: the turn settles at its result and the suggestion that follows reaches the chat',async t=>{
  mock.timers.enable({apis:['setTimeout']});t.after(()=>mock.timers.reset());
  const h=claudeHarness(true);
  h.emit({type:'system',subtype:'init',session_id:'s'},{type:'assistant',message:{id:'m1',content:[{type:'text',text:'Done.'}]}},{type:'result',subtype:'success',is_error:false,result:'Done.'});
  await flush();
  assert.ok(h.args().includes('--prompt-suggestions'),'Claude Code is asked for its own suggestion');
  assert.equal(h.settled(),true,'the turn settles at its result, without waiting for the process to exit');
  const result=await h.running;
  assert.equal(result.status,'completed');assert.equal(result.finalMessage,'Done.');
  h.emit({type:'prompt_suggestion',suggestion:'run the tests again',uuid:'u',session_id:'s'});await flush();
  assert.deepEqual(h.suggestions,['run the tests again'],'the suggestion that follows the result reaches the chat once');
  assert.deepEqual(h.kills,[],'the process may finish on its own first');
  mock.timers.tick(60_000);await flush();
  assert.ok(h.kills.length>=1,'a process that lingers after the bounded wait is ended');
  const plain=claudeHarness(false);
  await flush();
  assert.equal(plain.args().includes('--prompt-suggestions'),false,'a run not asked for a suggestion does not request one');
  plain.emit({type:'result',subtype:'success',is_error:false,result:'ok'});plain.child.stdout.end();setImmediate(()=>plain.child.emit('close',0));
  assert.equal((await plain.running).status,'completed');
});

const info:ProviderAdapter['info']=()=>[{id:'hybrow',name:'Hybrow',available:true,identityMasked:'Hidden',bindingId:'gateway',models:[
  {id:'gpt-5.5',name:'GPT-5.5',efforts:['low','medium','high'],defaultEffort:'medium'},
  {id:'fable-5',name:'Fable 5',efforts:['low','medium','high'],defaultEffort:'low'}]}];
const userItems=async(service:ReturnType<typeof createAgentService>,id:string)=>(await service.invoke('chat.timeline',{id})).items.filter(item=>item.kind==='user');

// Spec: MUS-SPEC-02-401B (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-401b)
test('a follow-up suggestion is offered on its turn only when the setting is on, and a newer message drops a late one',async t=>{
  const dataDir=await directory(t);
  const inputs:ProviderInput[]=[];let gate:PromiseWithResolvers<ProviderResult>|undefined;
  const provider:ProviderAdapter={info,async run(input){inputs.push(input);gate=Promise.withResolvers();return gate.promise;},stop:async()=>true,dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  const idle=async()=>until(async()=>(await service.invoke('app.snapshot',undefined)).chats.find(entry=>entry.id===chat.id)?.status==='completed');
  await service.invoke('chat.send',{id:chat.id,text:'first',requestId:'r1'});
  await until(()=>inputs.length===1);gate!.resolve({status:'completed',finalMessage:'one'});await idle();
  assert.equal(inputs[0]!.onSuggestion,undefined,'with the setting at its default (off) the run is not asked for a suggestion');
  await service.invoke('settings.set',{key:'chat.suggestFollowUps',value:true} as never);
  await service.invoke('chat.send',{id:chat.id,text:'second',requestId:'r2'});
  await until(()=>inputs.length===2);gate!.resolve({status:'completed',finalMessage:'two'});await idle();
  assert.equal(typeof inputs[1]!.onSuggestion,'function','with the setting on the run is asked for one');
  inputs[1]!.onSuggestion!('  "Run the tests again"\nand more');
  await until(async()=>(await userItems(service,chat.id))[1]?.data?.followUp!==undefined);
  assert.equal((await userItems(service,chat.id))[1]!.data!.followUp,'Run the tests again','one short line, without quotes, on the turn it follows');
  await service.invoke('chat.send',{id:chat.id,text:'third',requestId:'r3'});
  await until(()=>inputs.length===3);gate!.resolve({status:'completed',finalMessage:'three'});await idle();
  inputs[1]!.onSuggestion!('a stale idea');await flush();
  const items=await userItems(service,chat.id);
  assert.equal(items[2]!.data?.followUp,undefined,'a suggestion for an older turn never lands on the newer message');
  assert.equal(items[1]!.data?.followUp,'Run the tests again','and does not replace the older one either');
});

// Spec: MUS-SPEC-02-401C (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-401c)
test('an HTTP route asks its own model for one short follow-up after the turn, without holding the turn',async()=>{
  const requests:Array<Record<string,any>>=[];const held=Promise.withResolvers<void>();
  const stream=()=>new Response(new ReadableStream({start(c){const enc=new TextEncoder();c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"Here is the plan."}}]}\n\n'));c.enqueue(enc.encode('data: [DONE]\n\n'));c.close();}}),{status:200,headers:{'content-type':'text/event-stream'}});
  const adapter=openAICompatibleAdapter({endpoint:'https://fixture.example/v1',apiKey:()=>undefined,label:'Fixture',tools:false,fetch:(async(_url:string,init:RequestInit)=>{
    const body=JSON.parse(String(init.body));requests.push(body);
    if(body.stream)return stream();
    await held.promise;
    return new Response(JSON.stringify({choices:[{message:{content:'Write the migration next\nsecond line'}}]}),{status:200,headers:{'content-type':'application/json'}});
  }) as typeof fetch});
  const suggestions:string[]=[];
  const base=(chatId:string):AdapterRunInput=>({chat:{id:chatId,mode:'chat'} as unknown as AdapterRunInput['chat'],cwd:'/work',prompt:'plan the schema change',model:'fixture-model',permissionMode:'workspace',signal:new AbortController().signal,onThreadReady(){},onTurnAccepted(){},onDelta(){},onReasoning(){},onEvent(){}});
  const result=await adapter.run({...base('a'),onSuggestion:text=>{suggestions.push(text);}} as AdapterRunInput);
  assert.equal(result.status,'completed','the turn settles while the suggestion request is still open');
  await flush();
  assert.equal(requests.length,2,'one extra request after the turn');
  const ask=requests[1]!;
  assert.equal(ask.model,'fixture-model','to the chat\'s own model');
  assert.ok(!ask.stream,'not streamed');
  assert.ok(typeof ask.max_tokens==='number'&&ask.max_tokens<=60,'with a small output cap');
  held.resolve();await until(()=>suggestions.length===1);
  assert.deepEqual(suggestions,['Write the migration next']);
  requests.length=0;
  await adapter.run(base('b'));await flush();
  assert.equal(requests.length,1,'no extra request when no suggestion is asked for');
});

// Spec: MUS-SPEC-02-401D (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-401d)
test('each message records the model, provider and effort its turn ran with',async t=>{
  const dataDir=await directory(t);
  const provider:ProviderAdapter={info,run:async()=>({status:'completed',finalMessage:'ok'}),stop:async()=>true,dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  const idle=async()=>until(async()=>(await service.invoke('app.snapshot',undefined)).chats.find(entry=>entry.id===chat.id)?.status==='completed');
  await service.invoke('chat.send',{id:chat.id,text:'first',requestId:'r1',effort:'high'});await idle();
  await service.invoke('chat.selectProvider',{id:chat.id,providerId:'hybrow',model:'fable-5'});
  await service.invoke('chat.send',{id:chat.id,text:'second',requestId:'r2'});
  await until(async()=>(await userItems(service,chat.id)).length===2);await idle();
  const [first,second]=await userItems(service,chat.id);
  assert.deepEqual(first!.data?.ranWith,{providerId:'hybrow',model:'gpt-5.5',effort:'high'});
  assert.deepEqual(second!.data?.ranWith,{providerId:'hybrow',model:'fable-5',effort:'high'},'the composer\'s chosen effort carries to the next message');
});
