/** #426: compaction never stops silently at 100%. Per-model windows and thresholds, Muster's own trigger on every route and chat
 *  type, compaction during a running turn, failure rows with Retry / fresh thread, context-overflow refusals, Codex overrides. */
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service.ts';
import {createProviderAdapter,NO_LIVE_SESSION,type CoreClient,type ProviderAdapter,type ProviderInput,type ProviderResult} from '../src/runtime/provider.ts';
import {AUTO_COMPACT_RATIO,DEFAULT_CONTEXT_WINDOW,NATIVE_SAFETY_RATIO,compactionThreshold,effectiveContextWindow,musterCompactAt} from '../src/shared/context-window.ts';
import {codexWindowOverrides,userCompactionKeys} from '../src/runtime/codex-window-overrides.ts';
import {fetchModelList} from '../src/runtime/adapters/http-chat.ts';
import {catalogModels} from '../src/runtime/provider-instances.ts';
import {contextView} from '../src/renderer/contextView.ts';
import {COMPACTION_TEXT} from '../src/runtime/context-telemetry.ts';
import type {ProviderInfo,TimelineItem} from '../src/shared/protocol.ts';

async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-426-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function until(check:()=>boolean|Promise<boolean>,what='condition'){for(let i=0;i<600;i++){if(await check())return;await delay(5);}assert.fail(`${what} not reached`);}

test('#426 window and threshold: a 1M model and a 200K model compact at different token counts',()=>{
  const big=musterCompactAt('openai-chat-completions',{contextWindow:1_000_000},null),small=musterCompactAt('openai-chat-completions',{contextWindow:200_000},null);
  assert.equal(big.at,Math.floor(1_000_000*AUTO_COMPACT_RATIO));assert.equal(small.at,Math.floor(200_000*AUTO_COMPACT_RATIO));
  assert.ok(small.at<300_000&&big.at>300_000,'300K tokens compacts the 200K model, never the 1M one');
  // #739: a report below the declared window is what the engine runs; a larger report keeps the declared window.
  assert.deepEqual(effectiveContextWindow({contextWindow:1_000_000},200_000),{tokens:200_000,source:'reported'});
  assert.deepEqual(effectiveContextWindow({contextWindow:200_000},1_000_000),{tokens:200_000,source:'catalog'});
  assert.deepEqual(effectiveContextWindow(undefined,200_000),{tokens:200_000,source:'reported'});
  assert.deepEqual(effectiveContextWindow({},null),{tokens:DEFAULT_CONTEXT_WINDOW,source:'default'},'no window at all uses the default');
  assert.equal(musterCompactAt('gemini-cli',undefined,null).at,Infinity,'#668: a guessed window never compacts ahead of time');
  // A catalog's own auto_compact_token_limit is the threshold.
  assert.deepEqual(compactionThreshold({tokens:272_000,source:'catalog'},200_000),{tokens:200_000,source:'catalog-limit'});
  assert.equal(catalogModels('gateway',[{slug:'m',context_window:272_000,auto_compact_token_limit:200_000}]).models[0]!.autoCompactTokenLimit,200_000);
  assert.equal(catalogModels('gateway',[{slug:'m',context_window:272_000}]).models[0]!.contextWindowSource,'catalog');
  // Routes that compact natively get a late safety net, still on the model's window.
  assert.equal(musterCompactAt('codex-app-server',{contextWindow:1_000_000},null).at,Math.floor(1_000_000*NATIVE_SAFETY_RATIO));
  assert.equal(musterCompactAt('claude-code-cli',{contextWindow:200_000},null).at,Math.floor(200_000*NATIVE_SAFETY_RATIO));
});

test('#426 a router model without a catalog uses its listed context_length; the meter uses the same window',async()=>{
  const body=JSON.stringify({data:[{id:'router/big',context_length:1_000_000},{id:'router/none'}]});
  const [listed,unlisted]=await fetchModelList('http://r/v1/models',{},'Router',async()=>new Response(body));
  assert.deepEqual([listed!.contextWindow,listed!.contextWindowSource],[1_000_000,'listing']);
  assert.deepEqual(effectiveContextWindow(listed,null),{tokens:1_000_000,source:'listing'});
  assert.equal(effectiveContextWindow(unlisted,null).source,'default');
  const view=contextView({usedTokens:200_000,windowTokens:null,source:'live',compacted:false,updatedAt:null},listed);
  assert.equal(view.windowTokens,1_000_000);assert.equal(view.percent,20,'a 1M model is not shown full at 200K');
  assert.equal(view.compactAt,Math.floor(1_000_000*AUTO_COMPACT_RATIO));assert.match(view.source,/router’s model list/);
  assert.equal(contextView({usedTokens:null,windowTokens:null,source:null,compacted:false,updatedAt:null}).windowTokens,null,'no default window is shown without usage');
});

test('#426 Codex: the catalog window and threshold go in as overrides, never over the user’s own config.toml',async t=>{
  assert.deepEqual(codexWindowOverrides({contextWindow:1_000_000},new Set()),['model_context_window=1000000',`model_auto_compact_token_limit=${Math.floor(1_000_000*AUTO_COMPACT_RATIO)}`]);
  assert.deepEqual(codexWindowOverrides({contextWindow:272_000,autoCompactTokenLimit:220_000},new Set()),['model_context_window=272000','model_auto_compact_token_limit=220000']);
  assert.deepEqual(codexWindowOverrides({contextWindow:272_000},new Set(['model_auto_compact_token_limit'])),['model_context_window=272000']);
  assert.deepEqual(codexWindowOverrides({},new Set()),[],'nothing declared: Codex keeps its own metadata');
  const home=await directory(t);
  await writeFile(join(home,'config.toml'),'model = "x"\nmodel_auto_compact_token_limit = 150000\n[profiles.a]\nmodel_context_window = 5\n');
  assert.deepEqual([...userCompactionKeys(home)],['model_auto_compact_token_limit'],'only top-level keys the user set');
  // Through the provider adapter: the launch carries them.
  const launches:Record<string,unknown>[]=[];
  const core:CoreClient={CODEX_RUN_LIFECYCLE_VERSION:1,async runCodexAppServer(args){launches.push(args);return {status:'completed',finalMessage:'ok',dispatchState:'dispatched',threadId:'t',turnId:'u'};},
    async callCodexConversation(){return {};},async interruptActiveCodexTurn(){return false;},clearCodexAppServerSessions(){},hasLiveCodexConversation(){return true;}};
  const info:ProviderInfo={id:'gw',name:'Gateway',driver:'codex-app-server',available:true,identityMasked:'x',bindingId:'gw',models:[{id:'big',name:'Big',contextWindow:1_000_000,contextWindowSource:'listing'}]};
  const adapter=createProviderAdapter({core,instances:()=>[{info,command:'/unused',env:{},sessionsRoot:join(home,'sessions')}]});t.after(()=>adapter.dispose());
  await adapter.run({chat:{id:'c',mode:'agent',providerId:'gw',model:'big'} as ProviderInput['chat'],cwd:'/unused',prompt:'p',onDelta(){},onReasoning(){},onEvent(){},async onRequest(){return undefined;}});
  const overrides=launches[0]!.configOverrides as string[];
  assert.ok(overrides.includes('model_context_window=1000000'));
  assert.ok(!overrides.some(value=>value.startsWith('model_auto_compact_token_limit=')),'the user’s config.toml limit is kept');
});

/** Every provider route, by driver. */
const ROUTES:Record<string,string>={'Codex':'codex-app-server','Claude Code':'claude-code-cli','HTTP / router / API key':'openai-chat-completions','OpenCode':'opencode-cli','Gemini CLI':'gemini-cli','Cursor CLI':'cursor-cli','Grok CLI':'grok-acp'};
type Fake={inputs:ProviderInput[];usage:number;compacts:number;failCompact?:string;gate?:Promise<void>;result?:Partial<ProviderResult>;events?:(input:ProviderInput)=>void};
async function serviceOn(t:TestContext,driver:string,window:number|undefined,fake:Fake){
  const dataDir=await directory(t);
  const provider:ProviderAdapter={info:()=>[{id:'route',name:'Route',driver,available:true,identityMasked:'x',models:[{id:'m',name:'Model',...(window?{contextWindow:window}:{})}]}],
    async run(input){fake.inputs.push(input);fake.events?.(input);
      input.onEvent('thread/tokenUsage/updated',{tokenUsage:{last:{inputTokens:fake.usage,outputTokens:0,totalTokens:fake.usage}}});
      await fake.gate;
      return {status:'completed',finalMessage:'ok',threadId:`thread-${fake.inputs.length}`,turnId:`turn-${fake.inputs.length}`,dispatchState:'dispatched',...fake.result};},
    async compact(){fake.compacts++;if(fake.failCompact)throw new Error(fake.failCompact);if(driver!=='codex-app-server')throw new Error(NO_LIVE_SESSION);},
    stop:async()=>true,dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const folder=await service.invoke('folder.add',{path:dataDir});
  const project=await service.invoke('project.create',{name:'P',goal:'g',folderIds:[folder.id]});
  return {service,folder,project};
}
type Service=Awaited<ReturnType<typeof serviceOn>>['service'];
const rows=async(service:Service,chatId:string):Promise<TimelineItem[]>=>(await service.invoke('chat.select',{id:chatId})).filter(item=>item.data?.kind==='compaction');
async function settled(service:Service,chatId:string){await until(async()=>{const status=(await service.invoke('app.snapshot',undefined)).chats.find(chat=>chat.id===chatId)?.status;return status!=='running'&&status!=='stopping';},'run settled');}
async function send(service:Service,chatId:string,text:string){await service.invoke('chat.send',{id:chatId,text,requestId:randomUUID()});await settled(service,chatId);}

test('#426 matrix: Muster compacts before the next turn at the model’s threshold on every route, in normal and Project chats',async t=>{
  const matrix:string[]=[];
  for(const [route,driver] of Object.entries(ROUTES)){
    const native=driver==='codex-app-server'||driver==='claude-code-cli';
    // 90% of a 200K window: past the 85% threshold, short of the 95% native safety net.
    const fake:Fake={inputs:[],usage:180_000,compacts:0};
    const {service,folder,project}=await serviceOn(t,driver,200_000,fake);
    for(const [type,chat] of [['normal',await service.invoke('chat.create',{folderId:folder.id})],['Project',await service.invoke('chat.create',{folderId:folder.id,projectId:project.id})]] as const){
      await send(service,chat.id,'First, a long piece of work.');
      await send(service,chat.id,'Next step.');
      const auto=(await rows(service,chat.id)).filter(row=>row.data?.auto);
      if(native){ assert.equal(auto.length,0,`${route} ${type}: native compaction is trusted below the safety net`); matrix.push(`${route} × ${type}: native (safety net at 95%)`); continue; }
      assert.equal(auto.length,1,`${route} ${type}: one automatic compaction`);
      assert.equal(auto[0]!.status,'completed');assert.match(auto[0]!.text,/compacted automatically at 180K of 200K tokens/);
      const next=fake.inputs.at(-1)!;
      assert.equal(next.chat.providerThreadId??null,null,`${route} ${type}: the next turn starts a fresh provider thread`);
      assert.match(next.prompt,/First, a long piece of work\./,`${route} ${type}: seeded with a summary of the earlier messages`);
      matrix.push(`${route} × ${type}: Muster compaction at 85%`);
    }
    // At 96% the safety net fires on native routes too.
    if(native){
      fake.usage=192_000;const chat=await service.invoke('chat.create',{folderId:folder.id});
      await send(service,chat.id,'one');await send(service,chat.id,'two');
      assert.equal((await rows(service,chat.id)).filter(row=>row.data?.auto).length,1,`${route}: safety net at 95%`);
    }
  }
  t.diagnostic(matrix.join('\n'));
});

test('#426 the same usage compacts a 200K model but not a 1M model',async t=>{
  for(const [window,expected] of [[200_000,1],[1_000_000,0]] as const){
    const fake:Fake={inputs:[],usage:300_000,compacts:0};
    const {service,folder}=await serviceOn(t,'openai-chat-completions',window,fake);
    const chat=await service.invoke('chat.create',{folderId:folder.id});
    await send(service,chat.id,'a');await send(service,chat.id,'b');
    assert.equal((await rows(service,chat.id)).filter(row=>row.data?.auto).length,expected,`${window}`);
  }
});

// Spec: MUS-SPEC-04-2C (docs/spec/clauses/04-context-window-and-compaction.md#mus-spec-04-2c)
test('#668 a router combo with no listed window keeps working at 300K tokens: no automatic compaction, turns complete',async t=>{
  const fake:Fake={inputs:[],usage:300_000,compacts:0};
  const {service,folder}=await serviceOn(t,'openai-chat-completions',undefined,fake);
  const chat=await service.invoke('chat.create',{folderId:folder.id});
  await send(service,chat.id,'First, a long piece of work.');await send(service,chat.id,'Next step.');await send(service,chat.id,'And one more.');
  assert.equal((await rows(service,chat.id)).filter(row=>row.data?.auto).length,0,'no automatic compaction on a guessed window');
  assert.equal(fake.compacts,0,'the provider was never asked to compact');
  assert.equal(fake.inputs.length,3,'every message reached the model');
  assert.equal(fake.inputs.at(-1)!.chat.providerThreadId,'thread-2','the conversation continues on the same thread');
  const row=(await service.invoke('app.snapshot',undefined)).chats.find(c=>c.id===chat.id)!;
  assert.equal(row.status,'completed');
});

test('#426 /compact during a running turn compacts when the turn settles, before any queued message',async t=>{
  let release!:()=>void;
  const fake:Fake={inputs:[],usage:1000,compacts:0};
  const {service,folder}=await serviceOn(t,'codex-app-server',200_000,fake);
  const chat=await service.invoke('chat.create',{folderId:folder.id});
  await send(service,chat.id,'first');
  fake.gate=new Promise<void>(resolve=>{release=resolve;});
  await service.invoke('chat.send',{id:chat.id,text:'second',requestId:randomUUID()});
  await until(()=>fake.inputs.length===2,'second turn running');
  await service.invoke('chat.compact',{id:chat.id});
  let waiting=(await rows(service,chat.id)).at(-1)!;
  assert.equal(waiting.status,'running');assert.match(waiting.text,/after the current turn/);
  assert.equal(fake.compacts,0,'not while the turn runs');
  release();await settled(service,chat.id);
  await until(async()=>(await rows(service,chat.id)).at(-1)?.status==='completed','deferred compaction settled');
  waiting=(await rows(service,chat.id)).find(row=>row.id===waiting.id)!;
  assert.equal(waiting.text,'Context compacted','the same row reports the result');
  assert.equal(fake.compacts,1);
});

test('#426 a failed compaction says why and offers Retry and a fresh thread with a summary',async t=>{
  const fake:Fake={inputs:[],usage:1000,compacts:0,failCompact:'thread is busy with another request'};
  const {service,folder,project}=await serviceOn(t,'codex-app-server',200_000,fake);
  const chat=await service.invoke('chat.create',{folderId:folder.id,projectId:project.id});
  await send(service,chat.id,'work');
  await assert.rejects(service.invoke('chat.compact',{id:chat.id}),/busy/);
  const failed=(await rows(service,chat.id)).at(-1)!;
  assert.equal(failed.status,'failed');assert.match(failed.text,/thread is busy with another request/);assert.deepEqual(failed.data?.actions,['retry','fresh']);
  await service.invoke('chat.compact',{id:chat.id,fresh:true});
  const fresh=(await rows(service,chat.id)).at(-1)!;
  assert.equal(fresh.status,'completed');assert.match(fresh.text,/saved transcript/);
  assert.equal(fake.compacts,1,'the fresh path never asks the provider');
  await send(service,chat.id,'continue');
  assert.match(fake.inputs.at(-1)!.prompt,/work/,'the fresh thread carries the summary');
});

test('#426 a context-overflow refusal is a settled failure with compaction actions, never a stuck chat',async t=>{
  const fake:Fake={inputs:[],usage:1000,compacts:0,result:{status:'failed',finalMessage:'',errorMessage:'context_length_exceeded: maximum context length is 200000 tokens'}};
  const {service,folder}=await serviceOn(t,'openai-chat-completions',200_000,fake);
  const chat=await service.invoke('chat.create',{folderId:folder.id});
  await send(service,chat.id,'huge');
  const snapshot=(await service.invoke('app.snapshot',undefined)).chats.find(entry=>entry.id===chat.id)!;
  assert.equal(snapshot.recovery?.kind,'failed','not an unconfirmed attempt that blocks the composer');
  assert.match(snapshot.recovery!.reason,/no longer fits its context window/);
  const row=(await rows(service,chat.id)).at(-1)!;
  assert.equal(row.data?.reason,'context-overflow');assert.deepEqual(row.data?.actions,['retry','fresh']);
  await service.invoke('chat.compact',{id:chat.id,fresh:true});
  fake.result=undefined;await send(service,chat.id,'again');
  assert.equal(fake.inputs.length,2,'the chat continues');
});

test('#426 Codex native auto-compaction shows Compacting… then its result, once',async t=>{
  const fake:Fake={inputs:[],usage:1000,compacts:0,events(input){
    input.onEvent('item/started',{threadId:'t',item:{type:'contextCompaction',id:'cc'}});
    input.onEvent('item/completed',{threadId:'t',item:{type:'contextCompaction',id:'cc'}});
    input.onEvent('thread/compacted',{threadId:'t'});
  }};
  const {service,folder}=await serviceOn(t,'codex-app-server',200_000,fake);
  const chat=await service.invoke('chat.create',{folderId:folder.id});
  await send(service,chat.id,'go');
  const all=await rows(service,chat.id);
  assert.equal(all.length,1);assert.equal(all[0]!.status,'completed');assert.equal(all[0]!.text,COMPACTION_TEXT);
});

test('#426 imported chat: /compact and the automatic trigger both work from the imported transcript',async t=>{
  const root=await directory(t),codexHome=join(root,'codex'),id='019a0000-0000-7000-8000-0000000004a6';
  const previous={codex:process.env.CODEX_HOME,claude:process.env.CLAUDE_CONFIG_DIR,xdg:process.env.XDG_DATA_HOME};
  process.env.CODEX_HOME=codexHome;process.env.CLAUDE_CONFIG_DIR=join(root,'claude');process.env.XDG_DATA_HOME=join(root,'xdg');
  t.after(()=>{for(const [key,value] of [['CODEX_HOME',previous.codex],['CLAUDE_CONFIG_DIR',previous.claude],['XDG_DATA_HOME',previous.xdg]] as const){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const {mkdir}=await import('node:fs/promises');
  await mkdir(join(codexHome,'sessions','2026','01','05'),{recursive:true});
  await writeFile(join(codexHome,'sessions','2026','01','05',`rollout-2026-01-05T09-00-00-${id}.jsonl`),[
    {id,timestamp:'2026-01-05T09:00:00.000Z',instructions:'x',cwd:root},
    {type:'message',role:'user',content:[{type:'input_text',text:'Imported question about the parser'}]},
    {type:'message',role:'assistant',content:[{type:'output_text',text:'Imported answer.'}]},
  ].map(row=>JSON.stringify(row)).join('\n')+'\n');
  const fake:Fake={inputs:[],usage:180_000,compacts:0};
  const {service}=await serviceOn(t,'openai-chat-completions',200_000,fake);
  const result=await (service.invoke as unknown as (c:string,i:unknown)=>Promise<{chats:{chatId:string}[]}>)('import.run',{ids:[`codex:${id}`],addFolders:false,continueInMuster:false});
  const chatId=result.chats[0]!.chatId;
  await service.invoke('chat.update',{id:chatId,providerId:'route',model:'m'} as never).catch(()=>undefined);
  await service.invoke('chat.compact',{id:chatId});
  const manual=(await rows(service,chatId)).at(-1)!;
  assert.equal(manual.status,'completed');assert.match(manual.text,/saved transcript/);
  await send(service,chatId,'Follow-up on the import.');
  assert.match(fake.inputs.at(-1)!.prompt,/Imported question about the parser/,'the imported conversation rides into the fresh thread');
  // The turn reported 180K of 200K: the next message compacts first.
  await send(service,chatId,'And another.');
  assert.equal((await rows(service,chatId)).filter(row=>row.data?.auto).length,1);
});

test('one /compact leaves one compaction row even when the provider also reports thread/compacted',async t=>{
  const fake:Fake={inputs:[],usage:1000,compacts:0};
  const {service,folder}=await serviceOn(t,'codex-app-server',200_000,fake);
  const chat=await service.invoke('chat.create',{folderId:folder.id});
  let report:ProviderInput['onEvent']|undefined;
  fake.events=input=>{report=input.onEvent;};
  await send(service,chat.id,'first');
  // The report lands while the request is still in flight.
  const compactNow=service.invoke('chat.compact',{id:chat.id});
  report!('thread/compacted',{threadId:'thread-1'});
  await compactNow;
  const compactionRows=await rows(service,chat.id);
  assert.equal(compactionRows.length,1,'a single row');
  assert.equal(compactionRows[0]!.status,'completed');
  assert.equal(compactionRows[0]!.data?.manual,true);
});

// #583: Codex answers thread/compact/start at once and reports the compaction itself afterwards.
for(const reports of [['item/started','item/completed','thread/compacted'],['item/started','item/completed'],['thread/compacted']]){
  test(`one /compact leaves one manual row when ${reports.join(', ')} arrive after the request returns`,async t=>{
    const fake:Fake={inputs:[],usage:1000,compacts:0};
    const {service,folder}=await serviceOn(t,'codex-app-server',200_000,fake);
    const chat=await service.invoke('chat.create',{folderId:folder.id});
    let report:ProviderInput['onEvent']|undefined;
    fake.events=input=>{report=input.onEvent;};
    await send(service,chat.id,'first');
    await service.invoke('chat.compact',{id:chat.id});
    for(const method of reports)report!(method,method==='thread/compacted'?{threadId:'thread-1',turnId:'compact-1'}:{threadId:'thread-1',turnId:'compact-1',item:{type:'contextCompaction',id:'cc-1'}});
    const compactionRows=await rows(service,chat.id);
    assert.deepEqual(compactionRows.map(row=>[row.text,row.status,!!row.data?.manual,!!row.data?.auto]),[['Context compacted','completed',true,false]]);
    // The report is consumed: a later compaction the provider starts on its own still gets its own row.
    report!('item/started',{threadId:'thread-1',turnId:'auto-1',item:{type:'contextCompaction',id:'cc-2'}});
    report!('item/completed',{threadId:'thread-1',turnId:'auto-1',item:{type:'contextCompaction',id:'cc-2'}});
    assert.deepEqual((await rows(service,chat.id)).map(row=>[row.status,!!row.data?.manual]),[['completed',true],['completed',false]]);
  });
}
