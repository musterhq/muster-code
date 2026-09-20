import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,mkdir,writeFile,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {configuredProviderInstances,type ProviderInstance} from '../src/runtime/provider-instances.ts';
import {createProviderAdapter,ProviderPreDispatchError,type ProviderAdapter,type ProviderInput,type CoreClient} from '../src/runtime/provider.ts';
import {createAgentService} from '../src/runtime/service.ts';
import {AgentStore} from '../src/runtime/store.ts';
import {reconcileProviderTurn} from '../src/runtime/provider-reconciliation.ts';

const routes=():ProviderInstance[]=>[
  {info:{id:'hybrow',name:'Gateway',available:true,bindingId:'gateway-account',identityMasked:'Hidden',models:[{id:'claude/claude-fable-5',name:'Fable'}]},command:'/fixture/gateway',env:{CODEX_HOME:'/fixture/gateway-home'},sessionsRoot:'/fixture/gateway-home/sessions'},
  {info:{id:'openai-direct',name:'Direct',available:true,bindingId:'direct-account',identityMasked:'Hidden',models:[{id:'gpt-5.6-terra',name:'Terra'}]},command:'/fixture/direct',env:{CODEX_HOME:'/fixture/direct-home'},sessionsRoot:'/fixture/direct-home/sessions'},
];
const completed={status:'completed' as const,finalMessage:'done',threadId:'native-thread',turnId:'native-turn'};
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
const request=(extra:Partial<ProviderInput['chat']>={}):ProviderInput=>({chat:{id:'chat',mode:'agent',...extra} as ProviderInput['chat'],cwd:'/fixture',prompt:'test',onDelta(){},onReasoning(){},onEvent(){},async onRequest(){return undefined;}});

test('adapter selects the exact route and scopes native continuation to provider and account',async()=>{
  const calls:Record<string,unknown>[]=[];const closed:string[]=[];let instances=routes();
  const core:CoreClient={CODEX_RUN_LIFECYCLE_VERSION:1,async runCodexAppServer(input){calls.push(input);return completed;},async callCodexConversation(){return{};},async interruptActiveCodexTurn(){return true;},clearCodexAppServerSessions(owner){closed.push(owner);}};
  const adapter=createProviderAdapter({core,instances:()=>instances});
  try {
    await adapter.run(request({providerId:'hybrow',model:'claude/claude-fable-5',providerBindingId:'gateway-account',providerThreadId:'legacy-unbound'}));
    assert.equal(calls[0]?.command,'/fixture/gateway');assert.equal(calls[0]?.threadId,undefined);
    await adapter.run(request({providerId:'openai-direct',model:'gpt-5.6-terra',providerBindingId:'direct-account',providerThreadId:'gateway-thread',providerThreadProviderId:'hybrow',providerThreadBindingId:'gateway-account'}));
    assert.equal(calls[1]?.command,'/fixture/direct');assert.equal(calls[1]?.model,'gpt-5.6-terra');assert.equal(calls[1]?.threadId,undefined);
    assert.equal((calls[1]?.env as Record<string,string>).CODEX_HOME,'/fixture/direct-home');
    assert.notEqual(calls[0]?.cacheKey,calls[1]?.cacheKey);assert.ok(closed.includes(calls[0]?.transportOwner as string));
    await adapter.run(request({providerId:'openai-direct',model:'gpt-5.6-terra',providerBindingId:'direct-account',providerThreadId:'direct-thread',providerThreadProviderId:'openai-direct',providerThreadBindingId:'direct-account'}));
    assert.equal(calls[2]?.threadId,'direct-thread');
    await assert.rejects(adapter.run(request({providerId:'openai-direct',model:'claude/claude-fable-5'})),/unavailable/);
    instances=routes();instances[1]!.info.bindingId='changed-account';
    await assert.rejects(adapter.run(request({providerId:'openai-direct',model:'gpt-5.6-terra',providerBindingId:'direct-account'})),/account or profile changed/);
    await adapter.run(request({providerId:'openai-direct',model:'gpt-5.6-terra',providerBindingId:'changed-account',providerThreadId:'direct-thread',providerThreadProviderId:'openai-direct',providerThreadBindingId:'direct-account'}));
    assert.equal(calls[3]?.threadId,undefined);assert.notEqual(calls[3]?.cacheKey,calls[2]?.cacheKey);
  } finally {adapter.dispose();}
});

test('atomic provider/model selection clears old native IDs, retains history/draft, and survives restart',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'muster-binding-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const store=new AgentStore(dataDir);const chat=store.createChat({model:'claude/claude-fable-5',mode:'agent'});
  store.updateChat(chat.id,{draft:'retained draft',providerId:'hybrow',providerBindingId:'gateway-account',providerThreadId:'old-thread',providerTurnId:'old-turn',providerThreadProviderId:'hybrow',providerThreadBindingId:'gateway-account'});
  store.appendItem(chat.id,'assistant','Existing answer','completed');store.close();
  const inputs:ProviderInput[]=[];let releaseCount=0;
  const provider:ProviderAdapter={info:()=>routes().map(r=>r.info),async run(input){inputs.push(input);input.onTurnAccepted?.({threadId:'new-direct-thread',turnId:'new-direct-turn',dispatchState:'dispatched'});return {...completed,threadId:'new-direct-thread',turnId:'new-direct-turn'};},async stop(){return true;},async release(){releaseCount++;},dispose(){}};
  let service=createAgentService({dataDir,provider,onEvent(){}});
  try {
    await assert.rejects(service.invoke('chat.selectProvider',{id:chat.id,providerId:'openai-direct',model:'claude/claude-fable-5'}),/unavailable/);
    assert.equal((await service.invoke('app.snapshot',undefined)).chats[0]?.providerThreadId,'old-thread');assert.equal(releaseCount,0);
    const selected=await service.invoke('chat.selectProvider',{id:chat.id,providerId:'openai-direct',model:'gpt-5.6-terra'});
    assert.equal(selected.providerId,'openai-direct');assert.equal(selected.model,'gpt-5.6-terra');assert.equal(selected.providerBindingId,'direct-account');
    assert.equal(selected.providerThreadId,undefined);assert.equal(selected.providerTurnId,undefined);assert.equal(selected.draft,'retained draft');assert.equal(releaseCount,1);
    assert.ok((await service.invoke('chat.timeline',{id:chat.id})).items.some(item=>item.text==='Existing answer'));
    await service.dispose();service=createAgentService({dataDir,provider,onEvent(){}});
    assert.equal((await service.invoke('app.snapshot',undefined)).chats[0]?.providerId,'openai-direct');
    await service.invoke('chat.send',{id:chat.id,text:'continue',requestId:randomUUID()});await flush();
    assert.equal(inputs[0]?.chat.providerId,'openai-direct');assert.equal(inputs[0]?.chat.providerThreadId,undefined);
    const saved=(await service.invoke('app.snapshot',undefined)).chats[0]!;
    assert.equal(saved.providerThreadProviderId,'openai-direct');assert.equal(saved.providerThreadBindingId,'direct-account');
  } finally {await service.dispose();}
});

test('selection rejects active/background/recovery work and a failed release leaves selection unchanged',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'muster-binding-guard-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const gate=Promise.withResolvers<typeof completed>();let background=false,failRelease=false;
  const provider:ProviderAdapter={info:()=>routes().map(r=>r.info),run:()=>gate.promise,async stop(){gate.resolve(completed);return true;},hasActiveWork:()=>background,async release(){if(failRelease)throw new Error('release blocked');},dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});const selection={id:chat.id,providerId:'openai-direct',model:'gpt-5.6-terra'};
  await service.invoke('chat.send',{id:chat.id,text:'busy',requestId:randomUUID()});
  await assert.rejects(service.invoke('chat.selectProvider',selection),/Wait/);gate.resolve(completed);await flush();
  background=true;await assert.rejects(service.invoke('chat.selectProvider',selection),/background/);background=false;
  failRelease=true;await assert.rejects(service.invoke('chat.selectProvider',selection),/release blocked/);
  assert.equal((await service.invoke('app.snapshot',undefined)).chats[0]?.providerId,'hybrow');
  await service.dispose();
  const store=new AgentStore(dataDir);store.updateChat(chat.id,{recovery:{kind:'recovery-needed',retryable:false,reason:'Uncertain'}});store.close();
  const restarted=createAgentService({dataDir,provider,onEvent(){}});try{await assert.rejects(restarted.invoke('chat.selectProvider',selection),/Resolve/);}finally{await restarted.dispose();}
});

test('unknown stored providers are retained and never silently fall back',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'muster-binding-unknown-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const store=new AgentStore(dataDir);const chat=store.createChat({model:'custom-model',mode:'agent'});store.updateChat(chat.id,{providerId:'removed-provider',draft:'preserve'});store.close();
  let calls=0;const provider:ProviderAdapter={info:()=>routes().map(r=>r.info),async run(){calls++;return completed;},async stop(){return true;},dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});try{
    assert.equal((await service.invoke('app.snapshot',undefined)).chats[0]?.providerId,'removed-provider');
    await assert.rejects(service.invoke('chat.send',{id:chat.id,text:'hello',requestId:randomUUID()}),/unavailable/);assert.equal(calls,0);
    assert.equal((await service.invoke('app.snapshot',undefined)).chats[0]?.draft,'preserve');
  }finally{await service.dispose();}
});

test('configured instances use validated catalogs and opaque account binding without leaking credentials',async t=>{
  const home=await mkdtemp(join(tmpdir(),'muster-binding-registry-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const directory=join(home,'runtime'),codexHome=join(home,'codex'),cli=join(home,'cli');
  await mkdir(join(directory,'resources'),{recursive:true});await mkdir(codexHome);
  await writeFile(cli,'#!/bin/sh\nexit 1\n',{mode:0o700});
  await copyFile(resolve('../builtin/resources/codex-profile.cjs'),join(directory,'resources/codex-profile.cjs'));
  for(const profile of ['hybrow-gateway','openai-direct'])await writeFile(join(directory,'resources',`codex-${profile}.sh`),'#!/bin/sh\nexit 1\n',{mode:0o700});
  const catalog=join(home,'catalog.json');await writeFile(catalog,JSON.stringify({models:[{slug:'gpt-5.6-terra',display_name:'Terra'},{slug:'claude/claude-fable-5'},{slug:'invented/model'}]}));
  await writeFile(join(codexHome,'openai-direct.config.toml'),`model_provider="openai"\nmodel_catalog_json=${JSON.stringify(catalog)}\n`);
  await writeFile(join(codexHome,'hybrow-gateway.config.toml'),`model_provider="hybrow"\nmodel_catalog_json=${JSON.stringify(catalog)}\n[model_providers.hybrow]\nbase_url="https://router.hybrowlabs.com/v1"\nwire_api="responses"\n[model_providers.hybrow.auth]\ncommand="existing-helper"\nargs=[]\n`);
  const authFile=join(codexHome,'auth.json');await writeFile(authFile,JSON.stringify({tokens:{account_id:'PRIVATE-ACCOUNT-A',access_token:'PRIVATE-ACCESS-TOKEN'}}));
  const options={directory,home,env:{CODEX_HOME:codexHome,MUSTER_CODEX_COMMAND:cli}};
  const first=configuredProviderInstances(options);assert.ok(first.every(route=>route.info.available));
  assert.deepEqual(first[0]?.info.models.map(model=>model.id),['claude/claude-fable-5']);assert.deepEqual(first[1]?.info.models.map(model=>model.id),['gpt-5.6-terra']);
  assert.doesNotMatch(JSON.stringify(first.map(route=>route.info)),/PRIVATE-|auth\.json|access_token/);
  await writeFile(authFile,JSON.stringify({tokens:{account_id:'PRIVATE-ACCOUNT-A',access_token:'REFRESHED-TOKEN'}}));
  assert.equal(configuredProviderInstances(options)[1]?.info.bindingId,first[1]?.info.bindingId);
  await writeFile(authFile,JSON.stringify({tokens:{account_id:'PRIVATE-ACCOUNT-B',access_token:'OTHER-TOKEN'}}));
  assert.notEqual(configuredProviderInstances(options)[1]?.info.bindingId,first[1]?.info.bindingId);
  await rm(cli);assert.ok(configuredProviderInstances(options).every(route=>!route.info.available));
});

test('reconciliation queries only the saved current binding; changed accounts never query',async()=>{
  let calls=0;const instances=routes();
  const query=async(_method:unknown,_params:unknown,options:{command:string})=>{calls++;assert.equal(options.command,'/fixture/direct');return{thread:{id:'thread',turns:[{id:'turn',status:'completed'}]}};};
  const input={threadId:'thread',turnId:'turn',cwd:'/fixture',providerId:'openai-direct',providerBindingId:'direct-account'};
  assert.equal((await reconcileProviderTurn(input,query,undefined,instances)).resolved,true);
  assert.equal((await reconcileProviderTurn({...input,providerBindingId:'old-account'},query,undefined,instances)).resolved,false);
  assert.equal((await reconcileProviderTurn({...input,providerBindingId:undefined},query,undefined,instances)).resolved,false);assert.equal(calls,1);
});

test('selection is serialized against sends and definite launch failure restores only an empty draft',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'muster-binding-serialized-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const released=Promise.withResolvers<void>();let calls=0;const launch=Promise.withResolvers<void>();
  const provider:ProviderAdapter={info:()=>routes().map(route=>route.info),release:()=>released.promise,async run(){calls++;if(calls===2)await launch.promise;throw new ProviderPreDispatchError('Selected route unavailable');},async stop(){return true;},dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});try{
    const chat=await service.invoke('chat.create',{}),selection={id:chat.id,providerId:'openai-direct',model:'gpt-5.6-terra'};
    const selecting=service.invoke('chat.selectProvider',selection);
    await assert.rejects(service.invoke('chat.selectProvider',selection),/Wait/);
    await assert.rejects(service.invoke('chat.send',{id:chat.id,text:'no dispatch',requestId:randomUUID()}),/selection/);assert.equal(calls,0);
    released.resolve();await selecting;
    await service.invoke('chat.send',{id:chat.id,text:'restore this',requestId:randomUUID()});await flush();
    assert.equal((await service.invoke('app.snapshot',undefined)).chats[0]?.draft,'restore this');
    await service.invoke('chat.send',{id:chat.id,text:'failed launch',requestId:randomUUID()});
    await service.invoke('chat.update',{id:chat.id,draft:'newer user draft'});launch.resolve();await flush();
    assert.equal((await service.invoke('app.snapshot',undefined)).chats[0]?.draft,'newer user draft');
  }finally{released.resolve();launch.resolve();await service.dispose();}
});
