/** #427: sub-agents start on every route that has a sub-agent tool, in every chat type; a route without one says so in one line.
 *  Fakes only: a fake Codex core, Claude Code argv, the Codex profile launcher's override builder, and a fake provider in the service. */
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {createRequire} from 'node:module';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service.ts';
import {createProviderAdapter,type CoreClient,type ProviderAdapter,type ProviderInput,type ProviderResult} from '../src/runtime/provider.ts';
import {claudeArgs} from '../src/runtime/adapters/claude-code.ts';
import {asksForSubagents,subagentSupport,subagentsUnavailableText} from '../src/runtime/subagent-routes.ts';
import {TASK_PROTOCOL} from '../src/runtime/governance/task-tools.ts';

const profile=createRequire(import.meta.url)('../resources/codex-profile.cjs') as {profileOverrides(name:string,text:string):string[]};
async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-427-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function until(check:()=>boolean|Promise<boolean>,what='condition'){for(let i=0;i<400;i++){if(await check())return;await delay(5);}assert.fail(`${what} not reached`);}

/** Every provider route the app offers, by driver. */
const ROUTES={
  'Codex (ChatGPT sign-in)':'codex-app-server','Codex (gateway profile)':'codex-app-server','Claude Code':'claude-code-cli',
  'HTTP / router / API key':'openai-chat-completions','Anthropic API key':'anthropic-messages','OpenCode':'opencode-cli',
  'Gemini CLI':'gemini-cli','Cursor CLI':'cursor-cli','Grok CLI':'grok-acp',
} as const;
/** Every chat type, as the provider sees it. */
const CHAT_TYPES:Record<string,Partial<ProviderInput['chat']>>={
  'normal chat':{},
  'Project chat':{projectId:'p1',folderId:'f1'},
  'Paperclip check-out chat':{projectId:'p-paperclip',folderId:'f-worktree',permissionMode:'workspace'},
  'task run':{projectId:'p1',folderId:'f1',permissionMode:'workspace',title:'Task: ship it'},
  'imported chat':{providerThreadId:'imported-thread',providerThreadProviderId:'fixture',providerThreadBindingId:'fixture-binding'},
};
const EXPECTED={'codex-app-server':'tracked','claude-code-cli':'tracked','opencode-cli':'native','openai-chat-completions':'none','anthropic-messages':'none','gemini-cli':'none','cursor-cli':'none','grok-acp':'none'} as const;

test('#427 matrix: how each route starts sub-agents, the same in every chat type',()=>{
  const rows:string[]=[];
  for(const [route,driver] of Object.entries(ROUTES)){
    assert.equal(subagentSupport(driver),EXPECTED[driver],route);
    for(const type of Object.keys(CHAT_TYPES)) rows.push(`${route} × ${type}: ${subagentSupport(driver)}`);
  }
  assert.equal(rows.length,Object.keys(ROUTES).length*Object.keys(CHAT_TYPES).length);
});

const complete:ProviderResult={status:'completed',finalMessage:'done',dispatchState:'dispatched',threadId:'thread',turnId:'turn'};
function fakeCore(){
  const launches:Record<string,unknown>[]=[];
  const core:CoreClient={CODEX_RUN_LIFECYCLE_VERSION:1,
    async runCodexAppServer(args){launches.push(args);return complete;},
    async callCodexConversation(){return {};},async interruptActiveCodexTurn(){return false;},clearCodexAppServerSessions(){},hasLiveCodexConversation(){return true;}};
  return {core,launches};
}
test('#427 Codex: every chat type launches with multi-agent on and the chat’s own model as the sub-agent model',async t=>{
  for(const [type,fields] of Object.entries(CHAT_TYPES)){
    const {core,launches}=fakeCore();const adapter=createProviderAdapter({core,available:()=>true,command:'/unused'});t.after(()=>adapter.dispose());
    const chat={id:`c-${randomUUID()}`,mode:'agent',providerId:'fixture',model:'fixture-model',...fields} as ProviderInput['chat'];
    const result=await adapter.run({chat,cwd:'/unused',prompt:'use sub-agents to check both packages',onDelta(){},onReasoning(){},onEvent(){},async onRequest(){return undefined;}});
    assert.equal(result.status,'completed',type);
    const overrides=launches[0]!.configOverrides as string[];
    assert.ok(overrides.includes('features.multi_agent=true'),`${type}: multi-agent is on`);
    assert.ok(overrides.includes('agents.default_subagent_model="fixture-model"'),`${type}: sub-agents default to the chat's model`);
    assert.ok(!overrides.some(value=>/^features\.multi_agent=false/.test(value)),`${type}: nothing turns it off again`);
    assert.doesNotMatch(String(launches[0]!.developerInstructions??''),/do not (spawn|use) sub-?agents/i,`${type}: agent-mode instructions never forbid sub-agents`);
  }
});

test('#427 Codex gateway: a default sub-agent model the provider does not serve falls back to the chat’s model instead of failing',async t=>{
  const dir=await directory(t),catalog=join(dir,'gateway.json');
  await writeFile(catalog,JSON.stringify({models:[{slug:'kimi-k3'},{slug:'glm-5'}]}));
  const text=(executor:string,provider='hybrow')=>`model_provider = "${provider}"\nmodel_catalog_json = ${JSON.stringify(catalog)}\n[agents]\ndefault_subagent_model = "${executor}"\ndefault_subagent_reasoning_effort = "medium"\n`;
  // An OpenAI model named on a router that only serves its catalog: no "Executor model does not match" failure, and no override.
  const mismatched=profile.profileOverrides('hybrow-gateway',text('gpt-5.6-luna'));
  assert.ok(!mismatched.some(value=>value.startsWith('agents.default_subagent')),'the unserved executor is left out, so Muster’s chat-model override applies');
  assert.ok(mismatched.includes('model_provider="hybrow"'));
  // A catalog model is the user's explicit, served choice: kept.
  assert.ok(profile.profileOverrides('hybrow-gateway',text('glm-5')).includes('agents.default_subagent_model="glm-5"'));
  // OpenAI's own route with a non-OpenAI executor: left out too.
  assert.ok(!profile.profileOverrides('openai-direct',text('claude/fable','openai')).some(value=>value.startsWith('agents.default_subagent_model')));
  assert.ok(profile.profileOverrides('openai-direct',text('gpt-5.6-luna','openai')).includes('agents.default_subagent_model="gpt-5.6-luna"'));
});

test('#427 Claude Code: the Task/Agent tools are allowed in every permission mode and chat type',()=>{
  for(const permissionMode of ['read-only','workspace','full'] as const) for(const [type,fields] of Object.entries(CHAT_TYPES)){
    const args=claudeArgs({chat:{id:'c',...fields} as never,cwd:'/w',prompt:'p',model:'claude-code/sonnet',permissionMode} as never,'s');
    const at=args.indexOf('--allowedTools');
    assert.ok(at>=0,`${permissionMode} ${type}`);
    assert.deepEqual(args.slice(at+1,at+3),['Task','Agent'],`${permissionMode} ${type}`);
  }
});

test('#427 task runs: the task protocol allows sub-agents',()=>{
  assert.match(TASK_PROTOCOL,/Sub-agents are allowed/);
  assert.doesNotMatch(TASK_PROTOCOL,/(do not|never) (spawn|use) sub-?agents/i);
});

async function serviceOn(t:TestContext,driver:string,name:string){
  const dataDir=await directory(t),inputs:ProviderInput[]=[];
  const provider:ProviderAdapter={info:()=>[{id:'route',name,driver,available:true,identityMasked:'fixture',models:[{id:'m',name:'M'}]}],
    async run(input){inputs.push(input);return {status:'completed',finalMessage:'ok',threadId:'t1',turnId:`u${inputs.length}`,dispatchState:'dispatched'};},stop:async()=>true,dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const folder=await service.invoke('folder.add',{path:dataDir});
  const project=await service.invoke('project.create',{name:'Docs',goal:'g',folderIds:[folder.id]});
  return {service,inputs,folder,project};
}
async function sendAndSettle(service:Awaited<ReturnType<typeof serviceOn>>['service'],chatId:string,text:string){
  await service.invoke('chat.send',{id:chatId,text,requestId:randomUUID()});
  await until(async()=>{const status=(await service.invoke('app.snapshot',undefined)).chats.find(chat=>chat.id===chatId)?.status;return status!=='running'&&status!=='stopping';},'run settled');
  return (await service.invoke('chat.select',{id:chatId})).filter(item=>item.data?.kind==='subagents-unavailable');
}
test('#427 routes without a sub-agent tool show one plain line, in normal and Project chats; routes with one show nothing',async t=>{
  for(const [route,driver] of Object.entries(ROUTES)){
    const {service,folder,project}=await serviceOn(t,driver,route);
    for(const chat of [await service.invoke('chat.create',{folderId:folder.id}),await service.invoke('chat.create',{folderId:folder.id,projectId:project.id})]){
      const first=await sendAndSettle(service,chat.id,'Spawn two sub-agents to review the API and the UI.');
      if(subagentSupport(driver)==='none'){
        assert.equal(first.length,1,`${route}: one notice`);
        assert.equal(first[0]!.text,subagentsUnavailableText(route));
        assert.equal((await sendAndSettle(service,chat.id,'Use sub-agents again please.')).length,1,`${route}: said once per chat, not on every message`);
      } else assert.equal(first.length,0,`${route}: no notice where sub-agents work`);
    }
  }
  assert.equal(asksForSubagents('Please refactor the parser.'),false);
  assert.ok(asksForSubagents('run parallel agents on this'));
});
