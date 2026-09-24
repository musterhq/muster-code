import assert from 'node:assert/strict';
import {test,mock,type TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter,ProviderInput} from '../src/runtime/provider.ts';
import type {Commands} from '../src/shared/protocol.ts';
import {DOMAIN_COMMANDS,DOMAIN_NAMES} from '../src/shared/domains/index.ts';
import {DOMAIN_FACTORIES,createDomains} from '../src/runtime/domains/index.ts';
import {bounded,createDomainHooks} from '../src/runtime/domains/hooks.ts';
import type {DomainContext,DomainFactory} from '../src/runtime/domains/types.ts';

const info:ProviderAdapter['info']=()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture'}]}];
async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-domain-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<500;i++){if(await check())return;await new Promise(resolve=>setImmediate(resolve));}assert.fail('condition not reached');}
const call=(service:{invoke:Function},command:string,input:unknown)=>service.invoke(command as keyof Commands,input as never) as Promise<unknown>;

test('every named domain has a runtime module; duplicate commands fail at startup',t=>{
  assert.deepEqual(Object.keys(DOMAIN_FACTORIES).sort(),[...DOMAIN_NAMES].sort());
  const db=new DatabaseSync(':memory:');const dataDir=mkdtempSync(join(tmpdir(),'muster-domain-'));t.after(()=>{db.close();rmSync(dataDir,{recursive:true,force:true});});const context={dataDir,db:()=>db,hooks:createDomainHooks().hooks} as unknown as DomainContext;
  assert.equal(createDomains(context).handlers.size,Object.keys(DOMAIN_COMMANDS).length);
  const twice:DomainFactory=()=>({handlers:{'x.y':()=>1}});
  assert.throws(()=>createDomains(context,[twice,twice]),/registered twice/);
});

test('a domain handler is reachable and contributors shape the provider run',async t=>{
  const dataDir=await directory(t);const inputs:ProviderInput[]=[];const settled:string[]=[];let started=0;
  const provider:ProviderAdapter={info,run:async input=>{inputs.push(input);return {status:'completed',finalMessage:'ok'};},stop:async()=>true,dispose(){}};
  const domain:DomainFactory=context=>{
    context.hooks.addPromptContributor(async({prompt,folder})=>({label:'test "ctx"',text:`note for ${prompt} in ${folder?.name??'scratch'}`}));
    context.hooks.addPromptContributor(async()=>null);
    context.hooks.addPromptContributor(async()=>{throw new Error('broken contributor');});
    context.hooks.addRunOptionsContributor(async()=>({reasoningEffort:'high',configOverrides:{'features.demo':true,'bad key!':1},developerInstructions:'Be brief.'}));
    context.hooks.onRunStarted(()=>{started++;});
    context.hooks.onRunSettled(run=>{settled.push(run.status);});
    context.hooks.setChatDefaults(input=>input.folderId?{mode:'plan'}:undefined);
    return {handlers:{'test.echo':input=>({echo:input.value,folders:context.store.snapshot().folders.length})}};
  };
  const service=createAgentService({dataDir,provider,onEvent(){},domains:[domain]});
  assert.deepEqual(await call(service,'test.echo',{value:'hi'}),{echo:'hi',folders:0});
  await assert.rejects(call(service,'test.missing',{}),/Unsupported command/);
  const folder=await service.invoke('folder.add',{path:dataDir});
  const chat=await service.invoke('chat.create',{folderId:folder.id});
  assert.equal(chat.mode,'plan');assert.equal((await service.invoke('chat.create',{})).mode,'agent');
  await service.invoke('chat.send',{id:chat.id,text:'hello',requestId:'hello'});
  await until(()=>inputs.length===1&&settled.length===1);
  const input=inputs[0]!;
  assert.match(input.prompt,/<context source="test ctx">\nnote for hello in /);
  assert.match(input.prompt,/Current user request:\nhello$/);
  assert.equal(input.reasoningEffort,'high');{const {personality,...rest}=input.configOverrides ?? {};assert.deepEqual(rest,{'features.demo':true});assert.ok(personality===undefined||personality==='friendly','the settings domain adds the response style (unless the Codex config sets one)');}assert.equal(input.developerInstructions,'Be brief.');
  assert.equal(started,1);assert.deepEqual(settled,['completed']);
  const notice=(await service.invoke('chat.timeline',{id:chat.id})).items.find(item=>item.data?.kind==='context-sources')!;
  assert.deepEqual(notice.data?.sources,['test ctx']);
  await service.dispose();
});

test('contributors are bounded in time and size',async t=>{
  mock.timers.enable({apis:['setTimeout']});t.after(()=>mock.timers.reset());
  let aborted=false;
  const slow=bounded(signal=>new Promise(()=>{signal.addEventListener('abort',()=>{aborted=true;});}),2000);
  mock.timers.tick(2000);
  assert.equal(await slow,undefined);assert.equal(aborted,true);
  mock.timers.reset();
  const runtime=createDomainHooks();
  runtime.hooks.addPromptContributor(async()=>({label:'big',text:'é'.repeat(10_000)+'</context>'}));
  const result=await runtime.contributePrompt({chat:{} as never,prompt:'p'});
  assert.ok(Buffer.byteLength(result.text)<8*1024+200);assert.match(result.text,/\[truncated\]\n<\/context>$/);
  assert.equal(runtime.hasRunHooks(),true);assert.equal(createDomainHooks().hasRunHooks(),false);
});

test('chat.create honours the Project, then user default model, and chat.defaults reports exactly that',async t=>{
  const dataDir=await directory(t);const inputs:ProviderInput[]=[];
  let codexReady=true;
  const catalog:ProviderAdapter['info']=()=>[
    {id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture',efforts:['low','medium','high'],defaultEffort:'medium'}]},
    {id:'codex',name:'Codex',available:codexReady,identityMasked:'fixture',models:[{id:'gpt-6',name:'GPT-6',efforts:['low','high','xhigh'],defaultEffort:'high'}]},
  ];
  const provider:ProviderAdapter={info:catalog,run:async input=>{inputs.push(input);return {status:'completed',finalMessage:'ok'};},stop:async()=>true,dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});
  t.after(()=>service.dispose());
  const plain=await service.invoke('chat.create',{});
  assert.equal(plain.model,'claude/claude-fable-5');assert.equal(plain.providerId,'hybrow','no default set: unchanged built-in behaviour');
  assert.deepEqual(await call(service,'chat.defaults',{}),{providerId:'hybrow',model:'claude/claude-fable-5',effort:'medium',source:'runtime'});

  await call(service,'settings.set',{key:'general.defaultModel',value:{providerId:'hybrow',model:'claude/claude-fable-5',effort:'low'}});
  const project=await call(service,'project.create',{name:'P',goal:'',folderIds:[]}) as {id:string};
  await call(service,'settings.projectModel.set',{projectId:project.id,value:{providerId:'codex',model:'gpt-6',effort:'xhigh'}});
  assert.deepEqual(await call(service,'chat.defaults',{projectId:project.id}),{providerId:'codex',model:'gpt-6',effort:'xhigh',source:'project'});
  const inProject=await service.invoke('chat.create',{projectId:project.id});
  assert.equal(inProject.providerId,'codex');assert.equal(inProject.model,'gpt-6');assert.equal(inProject.providerBindingId,'codex');
  await service.invoke('chat.send',{id:inProject.id,text:'hi',requestId:'r1'});
  await until(()=>inputs.length===1);
  assert.equal(inputs[0]!.reasoningEffort,'xhigh','the default effort applies until the composer picks another');

  const outside=await service.invoke('chat.create',{});
  assert.equal(outside.model,'claude/claude-fable-5');assert.equal(outside.providerId,'hybrow');
  codexReady=false;
  assert.deepEqual(await call(service,'chat.defaults',{projectId:project.id}),{providerId:'hybrow',model:'claude/claude-fable-5',effort:'low',source:'user'},'the Project provider went away: silently the user default');
  assert.equal((await service.invoke('chat.create',{projectId:project.id})).providerId,'hybrow');
});

test('CHAT-01: the import domain registers every import command and lists nothing from an empty home',async t=>{
  assert.ok((DOMAIN_NAMES as readonly string[]).includes('import'));
  const db=new DatabaseSync(':memory:');const dataDir=mkdtempSync(join(tmpdir(),'muster-domain-'));t.after(()=>{db.close();rmSync(dataDir,{recursive:true,force:true});});
  const handlers=DOMAIN_FACTORIES['import']({dataDir,db:()=>db,hooks:createDomainHooks().hooks,store:{snapshot:()=>({folders:[],chats:[],projects:[],version:0})}} as unknown as DomainContext).handlers;
  assert.deepEqual(Object.keys(handlers).sort(),Object.keys(DOMAIN_COMMANDS).filter(command=>command.startsWith('import.')).sort());
  const previous={codex:process.env.CODEX_HOME,claude:process.env.CLAUDE_CONFIG_DIR,xdg:process.env.XDG_DATA_HOME};
  process.env.CODEX_HOME=join(dataDir,'no-codex');process.env.CLAUDE_CONFIG_DIR=join(dataDir,'no-claude');process.env.XDG_DATA_HOME=join(dataDir,'no-xdg');
  t.after(()=>{if(previous.codex===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous.codex;if(previous.claude===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=previous.claude;if(previous.xdg===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=previous.xdg;});
  const sources=await handlers['import.sources']!({}) as {sources:Array<{id:string;available:boolean}>};
  assert.deepEqual(sources.sources.map(source=>[source.id,source.available]),[['codex',false],['claude-code',false],['opencode',false],['chatgpt',true]]);
  const page=await handlers['import.list']!({source:'codex'}) as {items:unknown[];total:number};
  assert.deepEqual([page.items,page.total],[[],0]);
  await assert.rejects(Promise.resolve(handlers['import.run']!({ids:[]})),/Select at least one/);
});

test('CMP-19: the stashes domain registers every stash command',t=>{
  assert.ok((DOMAIN_NAMES as readonly string[]).includes('stashes'));
  const db=new DatabaseSync(':memory:');const dataDir=mkdtempSync(join(tmpdir(),'muster-domain-'));t.after(()=>{db.close();rmSync(dataDir,{recursive:true,force:true});});
  const handlers=DOMAIN_FACTORIES.stashes({dataDir,db:()=>db,hooks:createDomainHooks().hooks} as unknown as DomainContext).handlers;
  assert.deepEqual(Object.keys(handlers).sort(),Object.keys(DOMAIN_COMMANDS).filter(command=>command.startsWith('stashes.')).sort());
  assert.deepEqual(handlers['stashes.list']!({}),{stashes:[]});
});

test('git history, conflict and clone commands dispatch through the service seam',async t=>{
  const dataDir=await directory(t);
  const provider:ProviderAdapter={info,run:async()=>({status:'completed',finalMessage:'ok'}),stop:async()=>true,dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});
  t.after(()=>service.dispose());
  for(const name of ['git.log','git.commitDetail','git.compare','git.refDiff','git.blame','git.conflicts','git.conflictFile','git.conflictWrite','git.conflictMarkResolved','git.conflictContinue','git.clone.start','git.clone.cancel','git.clone.defaultDestination','git.clone.pickDestination'])assert.ok(name in DOMAIN_COMMANDS,name);
  const suggested=await call(service,'git.clone.defaultDestination',{url:'https://github.com/o/muster-seam.git'}) as {path:string;name:string};
  assert.equal(suggested.name,'muster-seam');assert.match(suggested.path,/Code[\/\\]muster-seam(-\d+)?$/);
  await assert.rejects(call(service,'git.clone.start',{url:'https://user:secret@github.com/o/r'}),/Remove the password/);
  await assert.rejects(call(service,'git.clone.pickDestination',{}),/desktop window/);
  // A folder that is not a repository reports the ordinary git error, not a crash.
  const folder=await service.invoke('folder.add',{path:dataDir});
  await assert.rejects(call(service,'git.conflicts',{folderId:folder.id}),/not a git repository|Open the repository root/i);
  await assert.rejects(call(service,'git.log',{folderId:'missing'}),/folder/i);
});
