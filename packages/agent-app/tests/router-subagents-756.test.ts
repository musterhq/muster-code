/** #756: a router model keeps its sub-agent and core tools when a chat uses a connector. Without tool search every connector
 *  schema rides inline (500+ tools) and a router keeps only 128, so Muster loads just the connectors the chat named. */
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service.ts';
import {createProviderAdapter,type CoreClient} from '../src/runtime/provider.ts';
import type {ProviderInfo} from '../src/shared/protocol.ts';

const FIGMA='connector_68df038e0ba48191908c8434991bbac2',GITHUB='connector_76869538009648d5b282a4bb21c3d157',DRIVE='connector_5f3c8c41a1e54ad7a76272c89e2554fa';
async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-756-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function until(check:()=>Promise<boolean>){for(let i=0;i<600;i++){if(await check())return;await delay(5);}assert.fail('run did not settle');}

/** A Codex home whose connector cache lists Figma, GitHub and Google Drive (as Codex writes it), and a router chat on it. */
async function routerChat(t:TestContext,toolSearch?:boolean){
  const home=await directory(t),dataDir=await directory(t);
  await mkdir(join(home,'cache','codex_apps_tools'),{recursive:true});
  const tool=(id:string,name:string,n:number)=>Array.from({length:n},(_,i)=>({server_name:'codex_apps',connector_id:id,connector_name:name,tool_name:`t${i}`}));
  await writeFile(join(home,'cache','codex_apps_tools','a.json'),JSON.stringify({schema_version:1,tools:[...tool(FIGMA,'Figma',46),...tool(GITHUB,'GitHub',91),...tool(DRIVE,'Google Drive',45)]}));
  const launches:string[][]=[];
  const core:CoreClient={CODEX_RUN_LIFECYCLE_VERSION:1,async runCodexAppServer(args){launches.push(args.configOverrides as string[]);return {status:'completed',finalMessage:'ok',dispatchState:'dispatched',threadId:'t',turnId:`u${launches.length}`};},
    async callCodexConversation(){return {};},async interruptActiveCodexTurn(){return false;},clearCodexAppServerSessions(){},hasLiveCodexConversation(){return true;}};
  const info:ProviderInfo={id:'router',name:'Router',driver:'codex-app-server',available:true,identityMasked:'x',bindingId:'router',models:[{id:'advisor',name:'Advisor',...(toolSearch===undefined?{}:{toolSearch})}]};
  const provider=createProviderAdapter({core,instances:()=>[{info,command:'/unused',env:{CODEX_HOME:home},sessionsRoot:join(home,'sessions')}]});
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>{service.dispose();provider.dispose();});
  const folder=await service.invoke('folder.add',{path:dataDir});
  const chat=await service.invoke('chat.create',{folderId:folder.id});
  const send=async(text:string)=>{await service.invoke('chat.send',{id:chat.id,text,requestId:randomUUID()});
    await until(async()=>{const status=(await service.invoke('app.snapshot',undefined)).chats.find(entry=>entry.id===chat.id)?.status;return status!=='running'&&status!=='stopping';});
    return launches.at(-1)!;};
  return {send};
}
const apps=(overrides:string[])=>overrides.filter(value=>value.startsWith('apps.')||value.startsWith('features.apps'));

// Spec: MUS-SPEC-14-756A (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-756a)
test('a router chat that asks for Figma loads only the Figma connector and keeps sub-agents on, turn after turn',async t=>{
  const {send}=await routerChat(t);
  const first=await send('Check the latest frames in my Figma file and spawn two sub-agents to review them');
  assert.ok(first.includes('features.multi_agent=true'),'sub-agents stay on');
  assert.deepEqual(apps(first),['apps._default.enabled=false',`apps.${FIGMA}.enabled=true`],'only Figma, never the whole connector catalog');
  const later=await send('Now open a draft in Google Drive with the summary');
  assert.deepEqual(apps(later),['apps._default.enabled=false',`apps.${FIGMA}.enabled=true`,`apps.${DRIVE}.enabled=true`],'named connectors add up; GitHub never loads');
  const plain=await send('Thanks, carry on');
  assert.deepEqual(apps(plain),apps(later),'a follow-up without a connector name keeps the same connectors');
  assert.deepEqual(apps(await (await routerChat(t)).send('Refactor the parser and spawn sub-agents for the tests')),['features.apps=false'],'no connector asked: none load');
  assert.deepEqual(apps(await (await routerChat(t,true)).send('Check the latest frames in my Figma file')),[],'tool search defers the whole catalog: nothing is scoped');
});
