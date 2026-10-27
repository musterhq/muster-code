/** #739: when the engine runs a smaller window than the router lists (Codex runs an unknown router model at 258,400 even when told
 *  1M), the meter, Muster's own trigger and the compaction point Codex is given all follow the engine's window. */
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service.ts';
import {createProviderAdapter,type CoreClient,type ProviderAdapter,type ProviderInput} from '../src/runtime/provider.ts';
import {contextView} from '../src/renderer/contextView.ts';
import type {ProviderInfo,TimelineItem} from '../src/shared/protocol.ts';

const LISTED=1_000_000, ENGINE=258_400;
async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-739-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function until(check:()=>Promise<boolean>,what:string){for(let i=0;i<600;i++){if(await check())return;await delay(5);}assert.fail(`${what} not reached`);}

// Spec: MUS-SPEC-04-5A (docs/spec/clauses/04-context-window-and-compaction.md#mus-spec-04-5a)
test('#739 a Codex chat on a router model listed at 1M that Codex runs at 258,400: the meter reads the real fill and Muster compacts before the window is full',async t=>{
  const dataDir=await directory(t);
  const model={id:'advisor',name:'Advisor',contextWindow:LISTED,contextWindowSource:'listing' as const};
  const inputs:ProviderInput[]=[];let usage=151_000;
  const provider:ProviderAdapter={info:()=>[{id:'gw',name:'Router',driver:'codex-app-server',available:true,identityMasked:'x',models:[model]}],
    async run(input){inputs.push(input);
      input.onEvent('thread/tokenUsage/updated',{tokenUsage:{last:{inputTokens:usage,outputTokens:0,totalTokens:usage},modelContextWindow:ENGINE}});
      return {status:'completed',finalMessage:'ok',threadId:`thread-${inputs.length}`,turnId:`turn-${inputs.length}`,dispatchState:'dispatched'};},
    async compact(){},stop:async()=>true,dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const folder=await service.invoke('folder.add',{path:dataDir});
  const chat=await service.invoke('chat.create',{folderId:folder.id});
  const send=async(text:string)=>{await service.invoke('chat.send',{id:chat.id,text,requestId:randomUUID()});
    await until(async()=>{const status=(await service.invoke('app.snapshot',undefined)).chats.find(entry=>entry.id===chat.id)?.status;return status!=='running'&&status!=='stopping';},'run settled');};
  const auto=async()=>(await service.invoke('chat.select',{id:chat.id})).filter((item:TimelineItem)=>item.data?.kind==='compaction'&&item.data?.auto);

  await send('Check how much this chat covered.');
  const view=contextView(await service.invoke('chat.contextTelemetry',{id:chat.id}),model);
  assert.equal(view.windowTokens,ENGINE,'the meter divides by the window Codex runs, not the 1M listing');
  assert.equal(view.percent,58,'151K of 258,400 reads 58%, not 15%');
  assert.equal(view.compactAt,Math.floor(ENGINE*0.85),'the meter marks where compaction starts in the real window');
  assert.equal(inputs[0]!.engineWindow,undefined,'the first turn has no report yet');

  await send('Next step.');
  assert.equal(inputs[1]!.engineWindow,ENGINE,'the next launch is told the window Codex reported');
  assert.equal((await auto()).length,0,'151K is under the safety net');

  usage=250_000;
  await send('A long piece of work.');
  await send('And the next one.');
  const rows=await auto();
  assert.equal(rows.length,1,'past 95% of 258,400 Muster compacts before the next turn, not at 950K');
  assert.match(rows[0]!.text,/250K of 258K tokens/);
});

// Spec: MUS-SPEC-04-5B (docs/spec/clauses/04-context-window-and-compaction.md#mus-spec-04-5b)
test('#739 the compaction point Codex is launched with is never above the window Codex reported',async t=>{
  const launches:string[][]=[];
  const core:CoreClient={CODEX_RUN_LIFECYCLE_VERSION:1,async runCodexAppServer(args){launches.push(args.configOverrides as string[]);return {status:'completed',finalMessage:'ok',dispatchState:'dispatched',threadId:'t',turnId:'u'};},
    async callCodexConversation(){return {};},async interruptActiveCodexTurn(){return false;},clearCodexAppServerSessions(){},hasLiveCodexConversation(){return true;}};
  const home=await directory(t);
  const info:ProviderInfo={id:'gw',name:'Router',driver:'codex-app-server',available:true,identityMasked:'x',bindingId:'gw',models:[{id:'advisor',name:'Advisor',contextWindow:LISTED,contextWindowSource:'listing'}]};
  const adapter=createProviderAdapter({core,instances:()=>[{info,command:'/unused',env:{},sessionsRoot:join(home,'sessions')}]});t.after(()=>adapter.dispose());
  const run=(id:string,engineWindow?:number)=>adapter.run({chat:{id,mode:'agent',providerId:'gw',model:'advisor'} as ProviderInput['chat'],cwd:'/unused',prompt:'p',...(engineWindow?{engineWindow}:{}),onDelta(){},onReasoning(){},onEvent(){},async onRequest(){return undefined;}});
  const limit=(overrides:string[])=>overrides.find(value=>value.startsWith('model_auto_compact_token_limit='));
  await run('first');
  assert.equal(limit(launches[0]!),'model_auto_compact_token_limit=850000','before any report: 85% of the listed 1M');
  await run('small',ENGINE);
  assert.equal(limit(launches[1]!),`model_auto_compact_token_limit=${Math.floor(ENGINE*0.85)}`,'Codex reported 258,400: it compacts at 85% of that, not at 850K');
  await run('adopted',950_000);
  assert.equal(limit(launches[2]!),'model_auto_compact_token_limit=850000','Codex took the 1M window (it reports 95% of it): nothing changes');
});
