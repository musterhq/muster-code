import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ChildProcess} from 'node:child_process';
import {mkdtemp,rm,mkdir,writeFile,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openAICompatibleAdapter,anthropicAdapter} from '../src/runtime/adapters/http-chat.ts';
import {claudeCodeAdapter,claudeArgs,claudeToolItem,type Spawn} from '../src/runtime/adapters/claude-code.ts';
import {openCodeAdapter,openCodeCapabilities} from '../src/runtime/adapters/opencode.ts';
import {createAdapterCatalog} from '../src/runtime/adapters/index.ts';
import {ConversationMemory,Validator} from '../src/runtime/adapters/shared.ts';
import type {AdapterRunInput} from '../src/runtime/adapters/types.ts';
import {createProviderAdapter,type ProviderInput} from '../src/runtime/provider.ts';
import {configuredProviderInstances,invalidateProviderInstances,mcpServerNames,accountHash} from '../src/runtime/provider-instances.ts';
import {reconcileProviderTurn} from '../src/runtime/provider-reconciliation.ts';
import {CustomProviders} from '../src/runtime/custom-providers.ts';

const sse=(events:unknown[],extra='')=>new Response(new ReadableStream({start(c){for(const e of events)c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`));if(extra)c.enqueue(new TextEncoder().encode(extra));c.close();}}),{status:200,headers:{'content-type':'text/event-stream'}});
function capture(extra:Partial<AdapterRunInput>={}) {
  const log={threads:[] as string[],accepted:[] as string[],deltas:'',reasoning:'',events:[] as Array<[string,Record<string,unknown>]>};
  const input:AdapterRunInput={chat:{id:'chat',mode:'agent'} as AdapterRunInput['chat'],cwd:'/work',prompt:'hello',model:'m',permissionMode:'workspace',signal:new AbortController().signal,
    onThreadReady:id=>log.threads.push(id),onTurnAccepted:i=>log.accepted.push(i.turnId),onDelta:t=>{log.deltas+=t;},onReasoning:t=>{log.reasoning+=t;},onEvent:(m,p)=>log.events.push([m,p]),...extra};
  return {input,log};
}
/** A child process double: tests write stream-json lines to stdout and close it. */
function fakeChild() {
  const child=new EventEmitter() as EventEmitter&{stdout:PassThrough;stderr:PassThrough;stdin:PassThrough;killed:string[];kill(signal?:string):boolean};
  child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.killed=[];
  child.kill=(signal='SIGTERM')=>{child.killed.push(signal);return true;};
  let stdin='';child.stdin.on('data',d=>{stdin+=d;});
  const emit=(...lines:unknown[])=>{for(const line of lines)child.stdout.write(JSON.stringify(line)+'\n');};
  const close=(code:number)=>{child.stdout.end();child.stderr.end();setImmediate(()=>child.emit('close',code));};
  return {child,emit,close,stdin:()=>stdin};
}

test('OpenAI-compatible adapter streams text, reports usage and resends history on the next turn',async()=>{
  const bodies:Record<string,unknown>[]=[];const headers:Record<string,string>[]=[];
  const adapter=openAICompatibleAdapter({endpoint:'https://llm.example/v1',apiKey:()=>'secret',label:'Example',memory:new ConversationMemory(),
    fetch:async(_url,init)=>{bodies.push(JSON.parse(String(init?.body)));headers.push(init?.headers as Record<string,string>);
      return sse([{choices:[{delta:{reasoning_content:'think'}}]},{choices:[{delta:{content:'Hel'}}]},{choices:[{delta:{content:'lo'}}]},{choices:[],usage:{prompt_tokens:5,completion_tokens:2,total_tokens:7}}],'data: [DONE]\n\n');}});
  const first=capture({instructions:'Be brief.'});
  const result=await adapter.run(first.input);
  assert.equal(result.status,'completed');assert.equal(result.finalMessage,'Hello');assert.equal(first.log.deltas,'Hello');assert.equal(first.log.reasoning,'think');
  assert.equal(headers[0]?.authorization,'Bearer secret');assert.equal(bodies[0]?.stream,true);
  assert.deepEqual(bodies[0]?.messages,[{role:'system',content:'Be brief.'},{role:'user',content:'hello'}]);
  assert.equal(first.log.events[0]?.[0],'thread/tokenUsage/updated');
  assert.equal(JSON.stringify(first.log.events[0]?.[1].tokenUsage),JSON.stringify({last:{inputTokens:5,outputTokens:2,totalTokens:7}}));
  const second=capture({resumeThreadId:result.threadId,prompt:'again'});
  await adapter.run(second.input);
  assert.equal(second.log.threads[0],result.threadId);
  assert.deepEqual(bodies[1]?.messages,[{role:'user',content:'hello'},{role:'assistant',content:'Hello'},{role:'user',content:'again'}]);
});

test('HTTP rejection is reported as not dispatched with a secret-free reason',async()=>{
  const adapter=openAICompatibleAdapter({endpoint:'https://llm.example/v1',apiKey:()=>'k',label:'Example',fetch:async()=>new Response(JSON.stringify({error:{message:'bad key sk-abcdefghijklmnop'}}),{status:401})});
  const {input,log}=capture();
  const result=await adapter.run(input);
  assert.equal(result.status,'failed');assert.equal(result.dispatchState,'not-dispatched');assert.equal(result.statusCode,401);
  assert.match(result.errorMessage??'',/HTTP 401: bad key \[redacted\]/);assert.equal(log.accepted.length,0);
});

test('Anthropic adapter maps Messages API deltas and usage',async()=>{
  let sent:Record<string,unknown>={},hdrs:Record<string,string>={};
  const adapter=anthropicAdapter({apiKey:()=>'ak',fetch:async(url,init)=>{assert.equal(url,'https://api.anthropic.com/v1/messages');sent=JSON.parse(String(init?.body));hdrs=init?.headers as Record<string,string>;
    return sse([{type:'message_start',message:{usage:{input_tokens:9,output_tokens:1}}},{type:'content_block_delta',delta:{type:'text_delta',text:'Hi'}},{type:'content_block_delta',delta:{type:'text_delta',text:' there'}},{type:'message_delta',usage:{output_tokens:4}},{type:'message_stop'}]);}});
  const {input,log}=capture({instructions:'sys',model:'claude-x'});
  const result=await adapter.run(input);
  assert.equal(result.finalMessage,'Hi there');assert.equal(log.deltas,'Hi there');assert.equal(sent.system,'sys');assert.equal(sent.model,'claude-x');assert.equal(hdrs['x-api-key'],'ak');
  assert.equal(JSON.stringify(log.events[0]?.[1].tokenUsage),JSON.stringify({last:{inputTokens:9,outputTokens:4}}));
});

test('Claude Code adapter runs in the chat folder and maps stream-json to timeline items',async()=>{
  const fake=fakeChild();let call:{command:string;args:string[];cwd:string;env:NodeJS.ProcessEnv}|undefined;
  const spawn:Spawn=(command,args,options)=>{call={command,args,cwd:options.cwd,env:options.env};return fake.child as unknown as ChildProcess;};
  const adapter=claudeCodeAdapter({binary:'/bin/claude',env:{ANTHROPIC_API_KEY:'x',HOME:'/h'},spawn});
  const {input,log}=capture({permissionMode:'read-only',model:'claude-code/sonnet',reasoningEffort:'high'});
  const running=adapter.run(input);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(call?.command,'/bin/claude');assert.equal(call?.cwd,'/work');assert.equal(call?.env.ANTHROPIC_API_KEY,undefined);
  assert.deepEqual(call?.args.slice(0,8),['-p','--output-format','stream-json','--verbose','--include-partial-messages','--permission-mode','plan','--model']);
  assert.ok(call?.args.includes('--effort'));assert.ok(call?.args.includes('--session-id'));assert.equal(fake.stdin(),'hello');
  fake.emit({type:'system',subtype:'init',session_id:'s'},
    {type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Looking'}}},
    {type:'assistant',message:{content:[{type:'text',text:'Looking'},{type:'tool_use',id:'t1',name:'Bash',input:{command:'ls'}}],usage:{input_tokens:10,output_tokens:3}}},
    {type:'user',message:{content:[{type:'tool_result',tool_use_id:'t1',content:'a.txt'}]}},
    {type:'assistant',parent_tool_use_id:'task1',message:{content:[{type:'tool_use',id:'t2',name:'Read',input:{file_path:'/work/a.txt'}}]}},
    {type:'result',subtype:'success',is_error:false,result:'Done'});
  fake.close(0);
  const result=await running;
  assert.equal(result.status,'completed');assert.equal(result.finalMessage,'Done');assert.equal(log.deltas,'Looking');
  const sessionId=call!.args[call!.args.indexOf('--session-id')+1];
  assert.equal(result.threadId,sessionId);assert.equal(log.threads[0],sessionId);assert.equal(log.accepted.length,1);
  const methods=log.events.map(([m,p])=>`${m}:${String((p.item as Record<string,unknown>|undefined)?.type??'')}:${String((p.item as Record<string,unknown>|undefined)?.status??'')}`);
  assert.deepEqual(methods,['item/started:commandExecution:','thread/tokenUsage/updated::','item/completed:commandExecution:completed','item/started:fileRead:','item/completed:fileRead:interrupted']);
  assert.equal((log.events[2]?.[1].item as Record<string,unknown>).aggregatedOutput,'a.txt');
  assert.equal(log.events[3]?.[1].threadId,`${sessionId}:task1`);
});

test('Claude Code resume, permission mapping, stop and failures',async()=>{
  const base=capture({resumeThreadId:'saved',permissionMode:'full',model:'claude-code/default'}).input;
  const args=claudeArgs(base,'unused');
  assert.ok(args.includes('--resume'));assert.ok(!args.includes('--session-id'));assert.ok(!args.includes('--model'));assert.equal(args[args.indexOf('--permission-mode')+1],'bypassPermissions');
  assert.equal(claudeArgs({...base,permissionMode:'workspace'},'x')[6],'acceptEdits');
  assert.equal(claudeToolItem('e','Edit',{file_path:'/w/a',old_string:'a',new_string:'b'},'/w').type,'fileChange');
  assert.equal(claudeToolItem('m','mcp__github__search',{q:1},'/w').server,'github');
  assert.equal(claudeToolItem('t','TodoWrite',{todos:[{content:'x',status:'pending'}]},'/w').type,'todoList');

  const fake=fakeChild();const controller=new AbortController();
  const adapter=claudeCodeAdapter({binary:'/bin/claude',spawn:()=>fake.child as unknown as ChildProcess,killGraceMs:5});
  const running=adapter.run(capture({signal:controller.signal}).input);
  fake.emit({type:'system',subtype:'init'});await new Promise(resolve=>setImmediate(resolve));
  controller.abort();assert.deepEqual(fake.child.killed,['SIGINT']);fake.close(130);
  const stopped=await running;assert.equal(stopped.status,'failed');assert.equal(stopped.dispatchState,'dispatched');assert.equal(stopped.errorMessage,'Stopped.');

  const broken=fakeChild();
  const failing=claudeCodeAdapter({binary:'/bin/claude',spawn:()=>broken.child as unknown as ChildProcess}).run(capture().input);
  broken.child.stderr.write('Invalid API key · Please run /login\n');broken.close(1);
  const failed=await failing;assert.equal(failed.dispatchState,'not-dispatched');assert.match(failed.errorMessage??'',/run \/login/);
});

test('OpenCode adapter requires JSON output and maps its events',async()=>{
  const replies=new Map([['run --help','Usage: opencode run [message..]\n  --format  format: default | json'],['models','anthropic/claude-x\nopenai/gpt-y\n']]);
  const probeSpawn:Spawn=(_c,args)=>{const f=fakeChild();setImmediate(()=>{f.child.stdout.write(replies.get(args.join(' '))??'');f.close(0);});return f.child as unknown as ChildProcess;};
  const caps=await openCodeCapabilities('/bin/opencode',probeSpawn);
  assert.deepEqual(caps.models.map(m=>m.id),['opencode/anthropic/claude-x','opencode/openai/gpt-y']);
  replies.set('run --help','Usage: opencode run [message..]');
  await assert.rejects(openCodeCapabilities('/bin/opencode',probeSpawn),/no JSON run output/);

  const fake=fakeChild();let args:string[]=[];
  const adapter=openCodeAdapter({binary:'/bin/opencode',spawn:(_c,a)=>{args=a;return fake.child as unknown as ChildProcess;}});
  const {input,log}=capture({permissionMode:'read-only',model:'opencode/openai/gpt-y'});
  const running=adapter.run(input);
  assert.deepEqual(args.slice(0,6),['run','--format','json','--agent','plan','--model']);
  fake.emit({type:'text',sessionID:'ses_1',part:{type:'text',text:'Hi'}},
    {type:'tool_use',sessionID:'ses_1',part:{type:'tool',tool:'bash',callID:'c1',state:{status:'completed',input:{command:'pwd'},output:'/work'}}});
  fake.close(0);
  const result=await running;
  assert.equal(result.status,'completed');assert.equal(result.threadId,'ses_1');assert.equal(log.deltas,'Hi');
  assert.deepEqual(log.events.map(([m])=>m),['item/started','item/completed']);
  assert.equal((log.events[1]?.[1].item as Record<string,unknown>).aggregatedOutput,'/work');
});

test('catalog marks a provider available only after its adapter validates, and never falls back',async()=>{
  const spawn:Spawn=(_c,args)=>{const f=fakeChild();setImmediate(()=>{if(args[0]==='--version'){f.child.stdout.write('2.1.0 (Claude Code)\n');f.close(0);}else f.close(1);});return f.child as unknown as ChildProcess;};
  const fetch=(async(url:string)=>String(url).includes('anthropic')?new Response('{}',{status:401}):new Response(JSON.stringify({data:[{id:'gpt-5.1'},{id:'text-embedding-3'},{id:'gpt-4o-audio'}]}))) as typeof globalThis.fetch;
  const catalog=createAdapterCatalog({env:{MUSTER_CLAUDE_COMMAND:'/bin/claude',OPENAI_API_KEY:'o',ANTHROPIC_API_KEY:'a',PATH:''},home:'/nonexistent',spawn,fetch,
    customs:()=>[{id:'custom_ok',name:'Local',endpoint:'http://localhost:1/v1',apiKeyEnv:'',models:[{id:'llama',name:'llama'}],checkedAt:'2026-01-01'},{id:'custom_unchecked',name:'Later',endpoint:'http://localhost:2/v1',apiKeyEnv:'',models:[],checkedAt:null}]});
  const before=catalog.instances();
  assert.deepEqual(before.filter(r=>r.info.id!=='opencode').map(r=>`${r.info.id}:${r.info.available}`),['claude-code:false','env-openai:false','env-anthropic:false','custom_ok:true']);
  await catalog.ready();
  const after=Object.fromEntries(catalog.instances().map(r=>[r.info.id,r.info]));
  assert.equal(after['claude-code']?.available,true);assert.match(after['claude-code']?.detail??'',/Claude Code 2\.1\.0/);
  assert.deepEqual(after['env-openai']?.models.map(m=>m.id),['gpt-5.1']);assert.match(after['env-openai']?.detail??'',/Chat only · no tools/);
  assert.equal(after['env-anthropic']?.available,false);assert.equal(after['env-anthropic']?.status,'error');assert.match(after['env-anthropic']?.error??'',/HTTP 401/);
  assert.match(after.custom_ok?.detail??'',/Chat only · no tools/);assert.equal(after.custom_unchecked,undefined);
});

test('provider adapter delegates adapter routes, enforces bindings, and stops them',async()=>{
  let release:()=>void=()=>{};const seen:AdapterRunInput[]=[];
  const route={info:{id:'claude-code',name:'Claude Code',available:true,bindingId:'b1',identityMasked:'x',models:[{id:'claude-code/opus',name:'Opus'}]},command:'',env:{},sessionsRoot:'',
    adapter:{kind:'cli' as const,run:(input:AdapterRunInput)=>new Promise<import('../src/runtime/adapters/types.ts').AdapterRunResult>(resolve=>{seen.push(input);input.onThreadReady('sess');input.onTurnAccepted({threadId:'sess',turnId:'turn'});input.onDelta('partial');
      release=()=>resolve({status:'completed',finalMessage:'ok',threadId:'sess',turnId:'turn',dispatchState:'dispatched'});input.signal.addEventListener('abort',()=>resolve({status:'failed',finalMessage:'',threadId:'sess',turnId:'turn',dispatchState:'dispatched',errorMessage:'Stopped.'}));})}};
  const adapter=createProviderAdapter({instances:()=>[route]});
  const deltas:string[]=[];const accepted:string[]=[];
  const request=(chat:Partial<ProviderInput['chat']>):ProviderInput=>({chat:{id:'c',mode:'ask',providerId:'claude-code',model:'claude-code/opus',...chat} as ProviderInput['chat'],cwd:'/work',prompt:'p',onDelta:t=>deltas.push(t),onReasoning(){},onEvent(){},onTurnAccepted:i=>accepted.push(i.turnId),async onRequest(){return undefined;}});
  try {
    await assert.rejects(adapter.run(request({providerBindingId:'other'})),/account or profile changed/);
    const running=adapter.run(request({providerBindingId:'b1',providerThreadId:'sess',providerThreadProviderId:'claude-code',providerThreadBindingId:'b1'}));
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(seen[0]?.permissionMode,'read-only');assert.equal(seen[0]?.resumeThreadId,'sess');assert.match(seen[0]?.instructions??'',/Answer and inspect only/);
    assert.ok(adapter.hasActiveWork?.('c'));await assert.rejects(adapter.release!('c'),/Wait/);
    await assert.rejects(adapter.run(request({})),/already owns/);
    assert.equal(await adapter.stop('c'),true);
    const stopped=await running;
    assert.equal(stopped.status,'failed');assert.equal(stopped.recovery?.kind,'cancelled');assert.deepEqual(deltas,['partial']);assert.deepEqual(accepted,['turn']);
    assert.equal(adapter.hasActiveWork?.('c'),false);
    const next=adapter.run(request({}));await new Promise(resolve=>setImmediate(resolve));release();
    const done=await next;assert.equal(done.status,'completed');assert.equal(done.recovery,undefined);assert.equal(seen[1]?.resumeThreadId,undefined);
  } finally {adapter.dispose();}
});

test('adapter attempts reconcile as ended without querying a provider',async()=>{
  let queried=false;
  const result=await reconcileProviderTurn({threadId:'t',turnId:'u',cwd:'/w',providerId:'claude-code',providerBindingId:'b'},async()=>{queried=true;return {};});
  assert.equal(result.resolved,true);assert.equal(result.terminalStatus,'interrupted');assert.equal(queried,false);
});

test('MCP server names come from config.toml tables only, never values',()=>{
  const names=mcpServerNames(['model="x"','[mcp_servers.github]','command="npx"','env={TOKEN="secret"}','[mcp_servers.github.env]','TOKEN="secret"','[mcp_servers."docs.site"]','url="https://x"','[mcp_servers.off]','enabled = false','[[profiles]]','[mcp_servers.linear]'].join('\n'));
  assert.deepEqual(names,['github','docs.site','linear']);
  assert.ok(!names.join().includes('secret'));
});

test('extra CODEX_HOME accounts become separate providers with their own binding and MCP detail',async t=>{
  const root=await mkdtemp(join(tmpdir(),'muster-accounts-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'runtime'),cli=join(root,'cli'),catalog=join(root,'catalog.json'),main=join(root,'main'),work=join(root,'work');
  await mkdir(join(directory,'resources'),{recursive:true});await writeFile(cli,'#!/bin/sh\n',{mode:0o700});
  await copyFile(join(import.meta.dirname,'../resources/codex-profile.cjs'),join(directory,'resources/codex-profile.cjs'));
  await writeFile(join(directory,'resources','codex-launch.sh'),'#!/bin/sh\n',{mode:0o700});
  await writeFile(catalog,JSON.stringify({models:[{slug:'gpt-5.6-terra'}]}));
  const idToken=`x.${Buffer.from(JSON.stringify({email:'work@example.com'})).toString('base64url')}.y`;
  for(const [home,account] of [[main,'A'],[work,'B']] as const){
    await mkdir(home);await writeFile(join(home,'openai-direct.config.toml'),`model_provider="openai"\nmodel_catalog_json=${JSON.stringify(catalog)}\n`);
    await writeFile(join(home,'auth.json'),JSON.stringify({tokens:{account_id:account,access_token:'T',id_token:idToken}}));
  }
  await writeFile(join(work,'config.toml'),'[mcp_servers.github]\ncommand="gh"\n[mcp_servers.figma]\nurl="https://f"\n');
  const accountsFile=join(root,'provider-accounts.json');
  await writeFile(accountsFile,JSON.stringify({accounts:[{codexHome:work,label:'Work'},{codexHome:'relative/ignored'}]}));
  invalidateProviderInstances();
  const routes=configuredProviderInstances({directory,home:root,accountsFile,env:{CODEX_HOME:main,MUSTER_CODEX_COMMAND:cli}});
  const direct=routes.find(r=>r.info.id==='openai-direct')!,extra=routes.find(r=>r.info.id===`openai-direct_${accountHash(work)}`)!;
  assert.ok(direct&&extra);assert.equal(routes.some(r=>r.info.id.startsWith('hybrow_')),false);
  assert.equal(direct.info.available,true);assert.equal(extra.info.available,true);
  assert.equal(extra.info.name,'OpenAI (ChatGPT sign-in) · Work');assert.equal(extra.info.identityMasked,'w***@example.com');
  assert.notEqual(extra.info.bindingId,direct.info.bindingId);assert.equal(extra.env.CODEX_HOME,work);
  assert.match(extra.info.detail??'',/Inherits 2 MCP servers from Codex config \(github, figma\)/);
  assert.match(direct.info.detail??'',/No MCP servers are configured/);

  const calls:Record<string,unknown>[]=[];
  const adapter=createProviderAdapter({instances:()=>routes,core:{CODEX_RUN_LIFECYCLE_VERSION:1,async runCodexAppServer(input){calls.push(input);return {status:'completed',finalMessage:'',threadId:'t',turnId:'u'};},async callCodexConversation(){return {};},async interruptActiveCodexTurn(){return true;},clearCodexAppServerSessions(){}}});
  try {
    const request=(providerId:string,bindingId:string):ProviderInput=>({chat:{id:'c',mode:'agent',providerId,providerBindingId:bindingId,model:'gpt-5.6-terra'} as ProviderInput['chat'],cwd:'/w',prompt:'p',onDelta(){},onReasoning(){},onEvent(){},async onRequest(){return undefined;}});
    await adapter.run(request(extra.info.id,extra.info.bindingId!));
    assert.equal((calls[0]?.env as Record<string,string>).CODEX_HOME,work);
    await assert.rejects(adapter.run(request(extra.info.id,direct.info.bindingId!)),/account or profile changed/);
  } finally {adapter.dispose();}
});

test('custom connections become runnable once checked, and list() does not repeat claimed rows',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'muster-custom-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const store=new CustomProviders(dataDir,{},(async()=>new Response(JSON.stringify({data:[{id:'llama'}]}))) as typeof fetch);
  try {
    const saved=store.save({name:'Local',endpoint:'http://localhost:9/v1'});
    assert.equal(saved.available,false);
    const checked=await store.check(saved.id);
    assert.equal(checked.available,true);assert.match(checked.detail??'',/Chat only · no tools/);
    const catalog=createAdapterCatalog({env:{PATH:''},home:'/nonexistent'});
    assert.deepEqual(catalog.instances().filter(r=>r.info.custom).map(r=>r.info.id),[saved.id]);
    assert.deepEqual(store.list().map(r=>r.id),[]);
  } finally {store.close();}
});

test('a failed provider check is retried after 30s while a passing one keeps its TTL',async()=>{
  let now=0,calls=0,fail=true;
  const check=new Validator(async()=>{calls++;if(fail)throw new Error('cold start');return 'ok';},10*60_000,()=>now);
  check.current('k');assert.equal((await check.settled()).status,'error');assert.equal(calls,1);
  now=10_000;check.current('k');await check.settled();assert.equal(calls,1);
  fail=false;now=31_000;check.current('k');assert.equal((await check.settled()).status,'ok');assert.equal(calls,2);
  now=300_000;check.current('k');await check.settled();assert.equal(calls,2);
});

test('Claude Code edits: honest pre-run patch, then the applied structuredPatch with real line numbers',async()=>{
  const {claudeResultPatch}=await import('../src/runtime/adapters/claude-code.ts');
  const edit=claudeToolItem('e','Edit',{file_path:'/w/a.ts',old_string:'const a = 1;',new_string:'const a = 2;\nconst b = 3;'},'/w');
  assert.equal((edit.changes as {diff:string}[])[0].diff,'@@ @@\n-const a = 1;\n+const a = 2;\n+const b = 3;','no invented line 1 before the edit is applied');
  const write=claudeToolItem('w','Write',{file_path:'/w/n.ts',content:'one\ntwo\n'},'/w');
  assert.equal((write.changes as {diff:string}[])[0].diff,'@@ -0,0 +1,2 @@\n+one\n+two','a new file starts at line 1; the final newline is not a blank added line');
  assert.equal(claudeResultPatch({filePath:'/w/a.ts',structuredPatch:[{oldStart:40,oldLines:3,newStart:40,newLines:4,lines:[' x','-const a = 1;','+const a = 2;','+const b = 3;',' y']}]}),'@@ -40,3 +40,4 @@\n x\n-const a = 1;\n+const a = 2;\n+const b = 3;\n y');
  assert.equal(claudeResultPatch({type:'create',filePath:'/w/n.ts',content:'one\ntwo\n',structuredPatch:[]}),'@@ -0,0 +1,2 @@\n+one\n+two');
  assert.equal(claudeResultPatch({structuredPatch:[]}),undefined);
});
