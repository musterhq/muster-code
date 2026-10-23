import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter,ProviderInput,ProviderResult} from '../src/runtime/provider.ts';
import {PluginReloads,installedPlugin,lastTurn,mentions,pluginReloadNotice,turnAbout,RELOAD_IDLE_WINDOW_MS} from '../src/runtime/plugin-reload.ts';
import type {TimelineItem} from '../src/shared/protocol.ts';

const info:ProviderAdapter['info']=()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture'}]}];
async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-reload-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<2000;i++){if(await check())return;await new Promise(resolve=>setImmediate(resolve));}assert.fail('condition not reached');}
const settle=async()=>{for(let i=0;i<50;i++)await new Promise(resolve=>setImmediate(resolve));};

/** Each run waits for `finish(chatId)`; stop() settles the chat's run as cancelled, like a real interrupt. */
function gatedProvider(){
  const inputs:ProviderInput[]=[],stops:string[]=[],marks:number[]=[];const gates=new Map<string,PromiseWithResolvers<ProviderResult>>();
  const provider:ProviderAdapter={info,dispose(){},
    run:async input=>{inputs.push(input);const gate=Promise.withResolvers<ProviderResult>();gates.set(input.chat.id,gate);return gate.promise;},
    stop:async chatId=>{stops.push(chatId);const gate=gates.get(chatId);gates.delete(chatId);gate?.resolve({status:'failed',finalMessage:'',dispatchState:'dispatched',recovery:{kind:'cancelled',retryable:false,reason:'Stopped.'}});return true;},
    markStale:()=>{marks.push(Date.now());return 0;}};
  return {provider,inputs,stops,marks,finish(chatId:string){const gate=gates.get(chatId)!;gates.delete(chatId);gate.resolve({status:'completed',finalMessage:'done'});},open:(chatId:string)=>gates.has(chatId)};
}

test('installedPlugin reads marketplace installs and added MCP servers, nothing else',()=>{
  const ext=installedPlugin('extensions.install',{id:'notion',name:'notion',version:'1.2.0',installedAt:'2026-10-18T00:00:00Z',manifest:{displayName:'Notion',capabilities:{apps:['notion'],mcpServers:[]}}});
  assert.equal(ext?.name,'Notion');assert.equal(ext?.connectors,true);assert.deepEqual(ext?.aliases,['Notion','notion']);
  const mcp=installedPlugin('mcp.servers.add',{id:'m1',name:'linear',configKey:'linear',enabled:true});
  assert.equal(mcp?.key,'mcp:m1');assert.equal(mcp?.connectors,false);
  assert.equal(installedPlugin('mcp.servers.add',{id:'m2',name:'off',enabled:false}),null);
  assert.equal(installedPlugin('extensions.uninstall',{id:'notion'}),null);
  assert.equal(installedPlugin('extensions.install',undefined),null);
});

test('a turn is about a plugin only when it names it and ended recently',()=>{
  assert.equal(mentions('Can you file this in Google Drive?',['google-drive']),true);
  assert.equal(mentions('use the linear connector',['linear']),true);
  assert.equal(mentions('a nonlinear problem',['linear']),false);
  const items=[{id:'1',kind:'user',text:'summarise my Linear issues'},{id:'2',kind:'assistant',text:'I can’t reach that tool.'},{id:'3',kind:'user',text:'nudge',data:{steered:true}}] as unknown as TimelineItem[];
  const turn=lastTurn(items);assert.equal(turn.prompt?.id,'1');assert.equal(turn.reply,'I can’t reach that tool.');
  const plugin=installedPlugin('mcp.servers.add',{id:'m1',name:'linear'})!;
  const now=Date.parse('2026-10-18T12:00:00Z');
  assert.equal(turnAbout(plugin,turn,new Date(now-60_000).toISOString(),now),true);
  assert.equal(turnAbout(plugin,turn,new Date(now-RELOAD_IDLE_WINDOW_MS-1).toISOString(),now),false);
  assert.equal(turnAbout(installedPlugin('mcp.servers.add',{id:'m2',name:'slack'})!,turn,new Date(now).toISOString(),now),false);
  const reloads=new PluginReloads();
  assert.equal(reloads.claim(plugin,'c1'),true);assert.equal(reloads.claim(plugin,'c1'),false);assert.equal(reloads.claim(plugin,'c2'),true);
  assert.equal(pluginReloadNotice('Linear'),'Linear installed — restarted the session and re-sent your last message');
});

test('an MCP server added mid-run restarts the running chat once and re-sends its prompt through the queue with the new tools',async t=>{
  const dataDir=await directory(t),fake=gatedProvider();
  const service=createAgentService({dataDir,provider:fake.provider,onEvent(){}});
  t.after(()=>service.dispose());
  const running=await service.invoke('chat.create',{}),busy=await service.invoke('chat.create',{}),unrelated=await service.invoke('chat.create',{}),asked=await service.invoke('chat.create',{});
  // An idle chat that never talked about the plugin.
  await service.invoke('chat.send',{id:unrelated.id,text:'write a haiku',requestId:'u1'});await until(()=>fake.open(unrelated.id));fake.finish(unrelated.id);
  // An idle chat whose last turn asked for the plugin the agent could not see yet.
  await service.invoke('chat.send',{id:asked.id,text:'list my open issues with fake_tools',requestId:'a1'});await until(()=>fake.open(asked.id));fake.finish(asked.id);
  await service.invoke('chat.send',{id:running.id,text:'triage the bug backlog in fake_tools',requestId:'r1'});await until(()=>fake.open(running.id));
  // A running chat doing unrelated work: it is never interrupted.
  await service.invoke('chat.send',{id:busy.id,text:'refactor the parser',requestId:'b1'});await until(()=>fake.open(busy.id));
  const chatOf=async(id:string)=>(await service.invoke('app.snapshot',undefined)).chats.find(chat=>chat.id===id)!;
  await until(async()=>(await chatOf(unrelated.id)).status==='completed'&&(await chatOf(asked.id)).status==='completed');
  const before=fake.inputs.length;
  assert.ok(!Object.keys(fake.inputs.at(-1)!.configOverrides??{}).some(key=>key.startsWith('mcp_servers.fake_tools')));

  await service.invoke('mcp.servers.add',{name:'fake_tools',transport:'http',url:'https://example.com/mcp'});
  await until(()=>fake.inputs.length===before+2);
  await settle();
  // One stop for the running chat about the plugin; idle chats and unrelated running work are never interrupted.
  assert.deepEqual(fake.stops,[running.id]);
  assert.ok(fake.marks.length>=1,'warm sessions are marked for a fresh app-server');
  const resent=fake.inputs.slice(before);
  assert.deepEqual(resent.map(input=>input.chat.id).sort(),[running.id,asked.id].sort());
  const runningInput=resent.find(input=>input.chat.id===running.id)!,askedInput=resent.find(input=>input.chat.id===asked.id)!;
  assert.match(runningInput.prompt,/triage the bug backlog/);
  assert.equal((await service.invoke('chat.timeline',{id:busy.id})).items.some(item=>item.data?.kind==='plugin-reloaded'),false);
  assert.match(askedInput.prompt,/list my open issues with fake_tools/);
  // The tool list of the restarted session includes the new server.
  for(const input of resent)assert.equal(input.configOverrides?.['mcp_servers.fake_tools.url'],'https://example.com/mcp');
  // The queue carried the re-send and is empty again; it is not left paused by the interrupt.
  const after=await chatOf(running.id);assert.deepEqual(after.queue??[],[]);assert.equal(after.queuePaused,undefined);
  const notices=(await service.invoke('chat.timeline',{id:running.id})).items.filter(item=>item.kind==='notice'&&item.data?.kind==='plugin-reloaded');
  assert.equal(notices.length,1);assert.equal(notices[0]!.text,'fake_tools installed — restarted the session and re-sent your last message');
  assert.equal((await service.invoke('chat.timeline',{id:unrelated.id})).items.some(item=>item.data?.kind==='plugin-reloaded'),false);

  // Once per install: another, unrelated install does not re-send these chats again.
  fake.finish(running.id);fake.finish(asked.id);fake.finish(busy.id);
  await until(async()=>(await chatOf(running.id)).status==='completed'&&(await chatOf(asked.id)).status==='completed');
  const settled=fake.inputs.length;
  await service.invoke('mcp.servers.add',{name:'other_tools',transport:'http',url:'https://example.com/other'});
  await settle();
  assert.equal(fake.inputs.length,settled);
  assert.deepEqual(fake.stops,[running.id]);
});
