import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import {createProviderAdapter,PROCESS_OWNERSHIP_RULE,type CoreClient,type ProviderAdapter,type ProviderInput,type ProviderResult} from '../src/runtime/provider.ts';
import {ContextLedger,CONTEXT_REFRESH_TURNS,estimateTokens,leanCodexFeatureOverrides,requestsConnectors} from '../src/runtime/context-budget.ts';
import {BROWSER_TOOL_SPECS} from '../src/main/agent-tools/browser-tools.ts';
import {BROWSER_MCP_LAUNCHER_ENV} from '../src/runtime/domains/computer.ts';
import {MAILBOX_TOOL_SPECS} from '../src/runtime/mailbox-agent-tools.ts';

/** Budget for everything Muster itself adds to a default chat's turn (instructions, prompt preamble, its own MCP tools). */
const MUSTER_TURN_BUDGET_TOKENS = 6000;
const REQUEST = 'Write two paragraphs about git worktrees. No tools.';

async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-budget-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function until(check:()=>boolean){for(let i=0;i<1000;i++){if(check())return;await new Promise(resolve=>setImmediate(resolve));}assert.fail('condition not reached');}

test('connector requests are explicit; ordinary coding prose does not load ChatGPT apps',()=>{
  for(const yes of ['Summarise my unread Gmail','Put this in a Google Doc','file it in Notion','check [$gmail](app://connector_2128)','post it to Slack','use the GitHub connector'])assert.equal(requestsConnectors(yes),true,yes);
  for(const no of [REQUEST,'Push this branch to GitHub and open a PR','Explain the notion of ownership in Rust','Fix the database connection pool','Build a small teams page'])assert.equal(requestsConnectors(no),false,no);
});

test('lean Codex features: apps stay off for models without deferred tool search until a chat asks for a connector',()=>{
  assert.deepEqual(leanCodexFeatureOverrides({toolSearch:false,connectorsRequested:false}),['features.recommended_plugins=false','features.goals=false','features.apps=false']);
  assert.deepEqual(leanCodexFeatureOverrides({connectorsRequested:false}),['features.recommended_plugins=false','features.goals=false','features.apps=false'],'unknown catalog support counts as no deferral');
  assert.deepEqual(leanCodexFeatureOverrides({toolSearch:true,connectorsRequested:false}),['features.recommended_plugins=false','features.goals=false'],'deferred tools are cheap: keep connectors');
  assert.deepEqual(leanCodexFeatureOverrides({toolSearch:false,connectorsRequested:true}),['features.recommended_plugins=false','features.goals=false']);
  assert.ok(leanCodexFeatureOverrides({toolSearch:true,connectorsRequested:true,policy:'never'}).includes('features.apps=false'));
  assert.ok(!leanCodexFeatureOverrides({toolSearch:false,connectorsRequested:false,policy:'always'}).includes('features.apps=false'));
});

test('the Codex route sends the lean overrides; a connector request keeps apps on for the rest of the chat',async()=>{
  const runs:Record<string,unknown>[]=[];
  const core:CoreClient={CODEX_RUN_LIFECYCLE_VERSION:1,async runCodexAppServer(args){runs.push(args);return {status:'completed',finalMessage:'ok',threadId:'thread',turnId:`turn-${runs.length}`,dispatchState:'dispatched'} as ProviderResult;},async callCodexConversation(){return {};},async interruptActiveCodexTurn(){return false;},clearCodexAppServerSessions(){}};
  const adapter=createProviderAdapter({core,available:()=>true,command:'/unused'});
  const input=(prompt:string,connectorsRequested=false):ProviderInput=>({chat:{id:'c1',mode:'agent',providerId:'fixture'} as ProviderInput['chat'],cwd:'/unused',prompt,...(connectorsRequested?{connectorsRequested}:{}),onDelta(){},onReasoning(){},onEvent(){},async onRequest(){return undefined;}});
  const overrides=()=>runs.at(-1)!.configOverrides as string[];
  await adapter.run(input(REQUEST));
  assert.ok(overrides().includes('features.apps=false'));assert.ok(overrides().includes('features.recommended_plugins=false'));assert.ok(overrides().includes('features.goals=false'));
  await adapter.run(input('Summarise my Gmail',true));
  assert.ok(!overrides().includes('features.apps=false'));
  await adapter.run(input('thanks'));
  assert.ok(!overrides().includes('features.apps=false'),'sticky: the thread keeps its connectors instead of restarting the app-server again');
  adapter.dispose();
});

test('static context is sent once per provider thread and again after a new thread, a compaction or the refresh interval',()=>{
  const ledger=new ContextLedger(),project={label:'project',text:'Project: P\nShared goal: ship'},memory={label:'Memory (1)',text:'note'};
  assert.deepEqual(ledger.pending('c',null,[project,memory]),[project,memory]);
  ledger.delivered('c','t1',[project,memory]);
  assert.deepEqual(ledger.pending('c','t1',[project,memory]),[]);
  const changed={label:'Memory (1)',text:'another note'};
  assert.deepEqual(ledger.pending('c','t1',[project,changed]),[changed]);
  assert.deepEqual(ledger.pending('c','t2',[project]),[project],'a different thread holds none of it');
  ledger.forget('c');
  assert.deepEqual(ledger.pending('c','t1',[project]),[project],'after compaction everything goes out again');
  ledger.delivered('c','t1',[project]);
  for(let turn=1;turn<CONTEXT_REFRESH_TURNS;turn++)ledger.delivered('c','t1',[]);
  assert.deepEqual(ledger.pending('c','t1',[project]),[project],'periodic refresh for providers that trim history silently');
});

test(`budget: Muster adds under ${MUSTER_TURN_BUDGET_TOKENS} tokens to a default chat turn, and does not repeat static context`,async t=>{
  const dataDir=await directory(t);
  // The desktop app always runs the in-app browser bridge; count its tools and note like the live app does.
  const launcher=join(dataDir,'browser-mcp.sh');await writeFile(launcher,'#!/bin/sh\n',{mode:0o755});
  const previous=process.env[BROWSER_MCP_LAUNCHER_ENV];process.env[BROWSER_MCP_LAUNCHER_ENV]=launcher;
  t.after(()=>{if(previous===undefined)delete process.env[BROWSER_MCP_LAUNCHER_ENV];else process.env[BROWSER_MCP_LAUNCHER_ENV]=previous;});
  const inputs:ProviderInput[]=[];
  const provider:ProviderAdapter={info:()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture',toolSearch:false}]}],
    async run(input){inputs.push(input);return {status:'completed',finalMessage:'ok',threadId:'thread-1',turnId:`turn-${inputs.length}`,dispatchState:'dispatched'};},stop:async()=>true,dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const folder=await service.invoke('folder.add',{path:dataDir});
  const project=await service.invoke('project.create',{name:'Docs',goal:'Explain git internals to new engineers. '.repeat(8),folderIds:[folder.id]});
  const chat=await service.invoke('chat.create',{folderId:folder.id,projectId:project.id});
  const settled=async()=>{for(let i=0;i<1000;i++){const status=(await service.invoke('app.snapshot',undefined)).chats.find(entry=>entry.id===chat.id)?.status;if(status!=='running'&&status!=='stopping')return;await new Promise(resolve=>setImmediate(resolve));}assert.fail('run did not settle');};
  const send=async(text:string)=>{const before=inputs.length;await service.invoke('chat.send',{id:chat.id,text,requestId:randomUUID()});await until(()=>inputs.length>before);await settled();return inputs.at(-1)!;};

  const first=await send(REQUEST);
  const preamble=first.prompt.slice(0,first.prompt.length-REQUEST.length);
  const browserTools=JSON.stringify(BROWSER_TOOL_SPECS.map(({name,description,inputSchema})=>({name,description,inputSchema})));
  // The provider adapter prepends its agent-mode process rule to the contributors' instructions.
  // A project chat also gets the muster_mailbox tools (SBX-12/17); their schemas count against the same budget.
  const mailboxTools=first.configOverrides?.['mcp_servers.muster_mailbox.command']?JSON.stringify(MAILBOX_TOOL_SPECS):'';
  const parts={developerInstructions:estimateTokens(`${PROCESS_OWNERSHIP_RULE}\n\n${first.developerInstructions??''}`),promptPreamble:estimateTokens(preamble),browserToolSchemas:estimateTokens(browserTools),mailboxToolSchemas:estimateTokens(mailboxTools)};
  const total=Object.values(parts).reduce((a,b)=>a+b,0);
  t.diagnostic(`Muster-added context, first turn: ${JSON.stringify(parts)} = ${total} tokens (chars/4)`);
  assert.ok(first.configOverrides?.['mcp_servers.muster_browser.command'],'the browser bridge is registered, so its schemas count');
  assert.ok(mailboxTools,'a project chat gets the mailbox tools, so their schemas count');
  assert.match(first.prompt,/Shared goal: Explain git internals/);
  assert.ok(total<MUSTER_TURN_BUDGET_TOKENS,`Muster adds ${total} tokens per default turn (budget ${MUSTER_TURN_BUDGET_TOKENS}): ${JSON.stringify(parts)}`);

  const second=await send('And a third paragraph.');
  assert.doesNotMatch(second.prompt,/Shared goal:/,'the thread already holds the unchanged project context');
  assert.equal(second.developerInstructions,first.developerInstructions,'developer instructions are thread-level and stable, so the provider keeps them once');
  assert.ok(estimateTokens(second.prompt)<estimateTokens(first.prompt));
});

test(`budget: a full mailbox inbox block rides within the ${MUSTER_TURN_BUDGET_TOKENS}-token turn budget and is sent once`,async t=>{
  const dataDir=await directory(t);
  const inputs:ProviderInput[]=[];
  const provider:ProviderAdapter={info:()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture',toolSearch:false}]}],
    async run(input){inputs.push(input);return {status:'completed',finalMessage:'ok',threadId:'thread-1',turnId:`turn-${inputs.length}`,dispatchState:'dispatched'};},stop:async()=>true,dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const folder=await service.invoke('folder.add',{path:dataDir});
  const project=await service.invoke('project.create',{name:'Docs',goal:'Explain git internals.',folderIds:[folder.id]});
  const chat=await service.invoke('chat.create',{folderId:folder.id,projectId:project.id});
  // Worst case: more than a turn's worth of maximum-length mail.
  for(let index=0;index<10;index++)await service.invoke('mailbox.send',{to:{kind:'chat',id:chat.id},subject:'S'.repeat(200),body:`${index} `+'word '.repeat(1590)});
  const settled=async()=>{for(let i=0;i<1000;i++){const status=(await service.invoke('app.snapshot',undefined)).chats.find(entry=>entry.id===chat.id)?.status;if(status!=='running'&&status!=='stopping')return;await new Promise(resolve=>setImmediate(resolve));}assert.fail('run did not settle');};
  const send=async(text:string)=>{const before=inputs.length;await service.invoke('chat.send',{id:chat.id,text,requestId:randomUUID()});await until(()=>inputs.length>before);await settled();return inputs.at(-1)!;};
  const first=await send(REQUEST);
  const preamble=first.prompt.slice(0,first.prompt.length-REQUEST.length);
  const inbox=/<context source="mailbox">[\s\S]*?<\/context>/.exec(first.prompt)?.[0]??'';
  assert.ok(inbox,'the inbox block is in the prompt');
  const parts={developerInstructions:estimateTokens(`${PROCESS_OWNERSHIP_RULE}\n\n${first.developerInstructions??''}`),promptPreamble:estimateTokens(preamble),mailboxToolSchemas:estimateTokens(JSON.stringify(MAILBOX_TOOL_SPECS)),browserToolSchemas:estimateTokens(JSON.stringify(BROWSER_TOOL_SPECS.map(({name,description,inputSchema})=>({name,description,inputSchema}))))};
  const total=Object.values(parts).reduce((a,b)=>a+b,0);
  t.diagnostic(`Full inbox turn: inbox block ${estimateTokens(inbox)} tokens; ${JSON.stringify(parts)} = ${total}`);
  assert.ok(estimateTokens(inbox)<1200,`inbox block is ${estimateTokens(inbox)} tokens`);
  assert.ok(total<MUSTER_TURN_BUDGET_TOKENS,`Muster adds ${total} tokens with a full inbox (budget ${MUSTER_TURN_BUDGET_TOKENS})`);
  for(let i=0;i<200&&(await service.invoke('mailbox.list',{chatId:chat.id})).pending>4;i++)await new Promise(resolve=>setTimeout(resolve,5));
  const second=await send('continue');
  assert.doesNotMatch(second.prompt,/^0 word/m,'delivered mail is not repeated');
  assert.match(second.prompt,/<context source="mailbox">[\s\S]*#\d+ message from the user/,'the queued remainder follows next turn');
});
