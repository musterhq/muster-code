import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter,ProviderInput,ProviderResult} from '../src/runtime/provider.ts';

const info:ProviderAdapter['info']=()=>[
  {id:'openai-direct',name:'Direct',available:true,bindingId:'direct-account',identityMasked:'Hidden',models:[{id:'gpt-5.6-terra',name:'Terra'},{id:'gpt-5.6-mini',name:'Mini'}]},
  {id:'hybrow',name:'Gateway',available:true,bindingId:'gateway-account',identityMasked:'Hidden',models:[{id:'claude/claude-fable-5',name:'Fable'}]},
];
async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<500;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('condition not reached');}
/** Each provider keeps its own conversations: a run on a thread it never saw remembers nothing. */
function providers(){
  const inputs:ProviderInput[]=[];
  const provider:ProviderAdapter={info,async run(input){
    inputs.push(input);
    const threadId=input.chat.providerThreadId??`${input.chat.providerId}-thread-${inputs.length}`;
    input.onThreadReady?.(threadId);
    const reply=`reply-${inputs.length}`;input.onDelta?.(reply);
    return {status:'completed',finalMessage:reply,threadId,turnId:`turn-${inputs.length}`} as ProviderResult;
  },async stop(){return true;},async release(){},dispose(){}};
  return {provider,inputs};
}
async function setup(t:TestContext){
  const dataDir=await mkdtemp(join(tmpdir(),'muster-switch-724-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const run=providers(),service=createAgentService({dataDir,provider:run.provider,onEvent(){}});t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.selectProvider',{id:chat.id,providerId:'openai-direct',model:'gpt-5.6-terra'});
  const items=async()=>(await service.invoke('chat.timeline',{id:chat.id})).items;
  const send=async(text:string)=>{const before=(await items()).filter(i=>i.kind==='assistant').length;await service.invoke('chat.send',{id:chat.id,text,requestId:crypto.randomUUID()});
    await until(async()=>{const c=(await service.invoke('app.snapshot',undefined)).chats.find(x=>x.id===chat.id)!;return c.status==='completed'&&(await items()).filter(i=>i.kind==='assistant').length>before;});};
  return {service,run,chat,items,send};
}

// Spec: MUS-SPEC-03-724A (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-724a)
test('switching a chat to a model on another provider keeps the conversation: the first message there carries the earlier one',async t=>{
  const {service,run,chat,items,send}=await setup(t);
  await send('My project codename is HELIOTROPE. Remember it.');
  await send('Draft the release notes for HELIOTROPE.');
  await service.invoke('chat.selectProvider',{id:chat.id,providerId:'hybrow',model:'claude/claude-fable-5'});
  await send('What is the codename?');
  const switched=run.inputs.at(-1)!;
  assert.equal(switched.chat.providerId,'hybrow');
  assert.equal(switched.chat.providerThreadId,undefined,'the other provider starts its own conversation');
  assert.match(switched.prompt,/<earlier-conversation>[\s\S]*HELIOTROPE[\s\S]*<\/earlier-conversation>/,'the earlier conversation travels with the first message');
  assert.match(switched.prompt,/What is the codename\?$/);
  assert.ok((await items()).some(i=>i.kind==='notice'&&/summary of the earlier messages/.test(i.text)),'the notice says the conversation is carried over');
  assert.ok(!(await items()).some(i=>i.kind==='notice'&&/fresh provider conversation; displayed history is retained/.test(i.text)),'no notice claims a blank start');
  await send('And the next step?');
  assert.equal(run.inputs.at(-1)!.prompt,'And the next step?','only the first message on the new provider carries the summary');
  assert.equal(run.inputs.at(-1)!.chat.providerThreadId,switched.chat.providerThreadId??run.inputs.at(-1)!.chat.providerThreadId);
  assert.match(String(run.inputs.at(-1)!.chat.providerThreadId),/^hybrow-thread-/,'later messages continue the new provider conversation');
});

// Spec: MUS-SPEC-03-724B (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-724b)
test('another model on the same provider account continues the same provider conversation without a summary',async t=>{
  const {service,run,chat,send}=await setup(t);
  await send('My project codename is HELIOTROPE.');
  const thread=(await service.invoke('app.snapshot',undefined)).chats.find(x=>x.id===chat.id)!.providerThreadId;
  assert.ok(thread);
  await service.invoke('chat.selectProvider',{id:chat.id,providerId:'openai-direct',model:'gpt-5.6-mini'});
  await send('What is the codename?');
  const next=run.inputs.at(-1)!;
  assert.equal(next.chat.model,'gpt-5.6-mini');
  assert.equal(next.chat.providerThreadId,thread,'the same provider thread continues');
  assert.equal(next.prompt,'What is the codename?','no summary is needed when the thread continues');
});
