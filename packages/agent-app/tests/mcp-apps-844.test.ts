/** #844: MCP Apps. A tool that declares a `ui://` resource (spec 2026-01-26) is drawn under its tool row in the sandboxed
 *  frame; the app talks to Muster over the postMessage JSON-RPC bridge and may call tools on its own server only, under the
 *  chat's access level and approvals. The server here is a real child process (tests/fixtures/mcp-apps-server.mjs). */
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';
import type {TimelineItem} from '../src/shared/protocol.ts';
import {showsVisual} from '../src/renderer/components/activityGrouping.ts';
import {ReportRegistry} from '../src/main/report-origin.ts';
import {MCP_APPS_PROTOCOL,createMcpAppBridge,mcpAppNetwork,mcpAppOf,type McpAppView} from '../src/shared/mcp-apps.ts';

const SERVER=fileURLToPath(new URL('./fixtures/mcp-apps-server.mjs',import.meta.url));
type Service=ReturnType<typeof createAgentService>;
const call=<T>(service:Service,command:string,input?:unknown)=>(service.invoke as unknown as (c:string,i:unknown)=>Promise<T>)(command,input);
const mcpItem=(id:string,tool:string,args:Record<string,unknown>={})=>({id,type:'mcpToolCall',server:'board',tool,arguments:args,status:'completed',result:{content:[{type:'text',text:`${tool} done`}],structuredContent:{tool}}});

/** The agent service with the fake server added in Settings, and a run that reports the given finished MCP tool rows. */
async function setup(t:TestContext,tools:Array<[string,string,Record<string,unknown>?]>=[['m1','show_board',{board:'roadmap'}],['m2','plain']],permissionMode:'read-only'|'workspace'|'full'='workspace'){
  const dataDir=await mkdtemp(join(tmpdir(),'muster-mcp-apps-'));
  const log=join(dataDir,'calls.jsonl');
  let finished=false;
  const provider:ProviderAdapter={info:()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'m',name:'Fixture'}]}],stop:async()=>true,dispose(){},async run(input){
    for(const [id,tool,args] of tools){const item=mcpItem(id,tool,args);input.onEvent('item/started',{item:{...item,status:'inProgress',result:null}});input.onEvent('item/completed',{item});}
    finished=true;return {status:'completed',finalMessage:'done'};
  }};
  const service=createAgentService({dataDir,provider,onEvent(){}});
  t.after(async()=>{await service.dispose();await rm(dataDir,{recursive:true,force:true});});
  await call(service,'mcp.servers.add',{name:'board',transport:'stdio',command:process.execPath,args:[SERVER],env:{FAKE_LOG:log}});
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode,...(permissionMode==='full'?{acknowledgeFullAccess:true}:{})});
  await service.invoke('chat.send',{id:chat.id,text:'show the board',requestId:randomUUID()});
  const rows=async()=>(await service.invoke('chat.select',{id:chat.id})) as TimelineItem[];
  const row=async(providerId:string)=>(await rows()).find(item=>item.kind==='tool'&&item.data?.providerItemId===providerId);
  const until=async(check:()=>Promise<unknown>,ms=8000)=>{for(let waited=0;waited<ms;waited+=20){if(await check())return;await delay(20);}assert.fail('condition not reached');};
  const calls=()=>existsSync(log)?readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as {name:string;arguments:Record<string,unknown>}):[];
  return {service,chat,rows,row,until,calls,finished:()=>finished,setMode:(mode:'read-only'|'workspace'|'full')=>service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:mode,...(mode==='full'?{acknowledgeFullAccess:true}:{})})};
}
const appRow=async(env:Awaited<ReturnType<typeof setup>>,providerId='m1')=>{await env.until(async()=>!!mcpAppOf((await env.row(providerId))?.data));return (await env.row(providerId))!;};
const approvalCard=async(env:Awaited<ReturnType<typeof setup>>)=>(await env.rows()).find(item=>item.kind==='approval'&&item.status==='pending');

// Spec: MUS-SPEC-21-844A (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-844a)
test('a tool that declares a ui:// resource gets its app row, read from its own server',async t=>{
  const env=await setup(t,[['m1','show_board',{board:'roadmap'}],['m2','plain'],['m3','wrong_ui'],['m4','web_ui']]);
  const row=await appRow(env);
  assert.ok(env.finished(),'the run finished without waiting for the server');
  assert.deepEqual(mcpAppOf(row.data),{uri:'ui://board/app.html',server:'board',tool:'show_board'});
  assert.equal(showsVisual(row),true,'the app is a visual row of its own');
  await env.until(async()=>!!mcpAppOf((await env.row('m3'))?.data));
  const plain=(await env.row('m2'))!,web=(await env.row('m4'))!;
  assert.equal(mcpAppOf(plain.data),undefined,'a tool without a UI resource is not marked');
  assert.equal(mcpAppOf(web.data),undefined,'a resource that is not ui:// is never an app');
  assert.equal(showsVisual(plain),false);

  const app=await call<McpAppView>(env.service,'mcp.apps.open',{chatId:env.chat.id,itemId:row.id});
  assert.match(app.html,/<h1>Board<\/h1>/,'the HTML is the ui:// resource from the same server');
  assert.equal(app.uri,'ui://board/app.html');assert.equal(app.server,'board');assert.equal(app.tool,'show_board');
  assert.deepEqual(app.toolInput,{board:'roadmap'},'the tool arguments');
  assert.deepEqual(app.toolResult,{content:[{type:'text',text:'show_board done'}],structuredContent:{tool:'show_board'}},'the tool result');

  // Fallback (MUS-SPEC-21-844H, runtime side): a resource that is not an MCP app, or a server that is gone, fails with a message.
  await assert.rejects(call(env.service,'mcp.apps.open',{chatId:env.chat.id,itemId:(await env.row('m3'))!.id}),/not an MCP app/i);
  await assert.rejects(call(env.service,'mcp.apps.open',{chatId:env.chat.id,itemId:plain.id}),/no app/i);
  await assert.rejects(call(env.service,'mcp.apps.open',{chatId:'nope',itemId:row.id}),/not found|no app/i);
  const [server]=await call<Array<{id:string}>>(env.service,'mcp.servers.list');
  await call(env.service,'mcp.servers.remove',{id:server!.id});
  await assert.rejects(call(env.service,'mcp.apps.open',{chatId:env.chat.id,itemId:row.id}),/server/i,'a server that is gone');
});

// Spec: MUS-SPEC-21-844C (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-844c)
test("the app calls a read-only tool on its own server through the host, never another server's or an app-hidden tool",async t=>{
  const env=await setup(t);
  const row=await appRow(env);
  const result=await call<{content:Array<{text:string}>;structuredContent:unknown}>(env.service,'mcp.apps.callTool',{chatId:env.chat.id,itemId:row.id,name:'count',arguments:{column:'todo'}});
  assert.equal(result.content[0]!.text,'count ok');
  assert.deepEqual(result.structuredContent,{name:'count',arguments:{column:'todo'}});
  assert.equal(await approvalCard(env),undefined,'a read-only tool needs no card');
  await call(env.service,'mcp.apps.callTool',{chatId:env.chat.id,itemId:row.id,name:'count',arguments:{},server:'other'});
  assert.deepEqual(env.calls().map(entry=>entry.name),['count','count'],'naming another server still calls the app\'s own server');
  await assert.rejects(call(env.service,'mcp.apps.callTool',{chatId:env.chat.id,itemId:row.id,name:'secret_admin',arguments:{}}),/not available to the app/i);
  await assert.rejects(call(env.service,'mcp.apps.callTool',{chatId:env.chat.id,itemId:row.id,name:'drop_tables',arguments:{}}),/not available to the app|no tool/i);
  assert.deepEqual(env.calls().map(entry=>entry.name),['count','count'],'refused calls never reach the server');
  await assert.rejects(call(env.service,'mcp.apps.callTool',{chatId:env.chat.id,itemId:(await env.row('m2'))!.id,name:'count',arguments:{}}),/no app/i,'a row without an app cannot call tools');
});

// Spec: MUS-SPEC-21-844D (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-844d)
test("a read-only chat refuses the app's mutating tool call and the server never runs it",async t=>{
  const env=await setup(t,undefined,'read-only');
  const row=await appRow(env);
  await assert.rejects(call(env.service,'mcp.apps.callTool',{chatId:env.chat.id,itemId:row.id,name:'move_card',arguments:{card:1}}),/read.only/i);
  assert.equal(await approvalCard(env),undefined,'no card in read-only access');
  assert.deepEqual(env.calls(),[],'the server never got the call');
  const read=await call<{content:Array<{text:string}>}>(env.service,'mcp.apps.callTool',{chatId:env.chat.id,itemId:row.id,name:'count',arguments:{}});
  assert.equal(read.content[0]!.text,'count ok','a read-only tool still runs');
});

// Spec: MUS-SPEC-21-844E (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-844e)
test("the app's mutating tool call waits on the same approval card, and full access runs it without one",async t=>{
  const env=await setup(t);
  const row=await appRow(env);
  const approved=call<{content:Array<{text:string}>}>(env.service,'mcp.apps.callTool',{chatId:env.chat.id,itemId:row.id,name:'move_card',arguments:{card:7,to:'done'}});
  await env.until(async()=>!!await approvalCard(env));
  const card=(await approvalCard(env))!;
  assert.equal(card.data?.kind,'mcp');assert.equal(card.data?.server,'board');assert.equal(card.data?.tool,'move_card');
  assert.match(String(card.data?.args),/"card": 7/);
  assert.deepEqual(env.calls(),[],'nothing runs before the answer');
  await env.service.invoke('approval.respond',{id:card.id,approved:true,decision:'accept'});
  assert.equal((await approved).content[0]!.text,'move_card ok');
  assert.deepEqual(env.calls(),[{name:'move_card',arguments:{card:7,to:'done'}}]);

  const declined=call(env.service,'mcp.apps.callTool',{chatId:env.chat.id,itemId:row.id,name:'move_card',arguments:{card:8}});
  await env.until(async()=>!!await approvalCard(env));
  await env.service.invoke('approval.respond',{id:(await approvalCard(env))!.id,approved:false,decision:'decline'});
  await assert.rejects(declined,/declined|not approved/i);
  assert.equal(env.calls().length,1,'a declined call never reaches the server');

  await env.setMode('full');
  const cards=(await env.rows()).filter(item=>item.kind==='approval').length;
  const full=await call<{content:Array<{text:string}>}>(env.service,'mcp.apps.callTool',{chatId:env.chat.id,itemId:row.id,name:'move_card',arguments:{card:9}});
  assert.equal(full.content[0]!.text,'move_card ok');
  assert.equal((await env.rows()).filter(item=>item.kind==='approval').length,cards,'full access posts no card');
});

// Spec: MUS-SPEC-21-844G (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-844g)
test('an app has no network until the person allows it, and then only its declared https domains',async t=>{
  const env=await setup(t,[['m1','show_board'],['m5','no_domains']]);
  const row=await appRow(env);
  const reports=new ReportRegistry();
  const serve=(app:McpAppView)=>{const {url}=reports.register({html:app.html,scripts:true,network:mcpAppNetwork(app)});return reports.respond(url).headers['content-security-policy']!;};
  const first=await call<McpAppView>(env.service,'mcp.apps.open',{chatId:env.chat.id,itemId:row.id});
  assert.equal(first.networkRequested,true);assert.equal(first.networkAllowed,false);
  assert.equal(mcpAppNetwork(first),false);
  const closed=serve(first);
  assert.match(closed,/connect-src 'none'/);assert.doesNotMatch(closed,/https:/,'no remote scripts, styles or images');

  await call(env.service,'mcp.apps.allowNetwork',{chatId:env.chat.id,itemId:row.id});
  const allowed=await call<McpAppView>(env.service,'mcp.apps.open',{chatId:env.chat.id,itemId:row.id});
  assert.equal(allowed.networkAllowed,true);
  const open=serve(allowed);
  assert.match(open,/connect-src https:\/\/api\.example\.com(;|$)/,'connect only to the declared domain');
  assert.match(open,/script-src 'unsafe-inline' https:\/\/cdn\.example\.com(;|$)/);
  assert.match(open,/img-src data: blob: https:\/\/cdn\.example\.com(;|$)/);
  assert.doesNotMatch(open,/insecure\.example\.com|http:\/\/|https:(;| )/,'never http, never any https host');
  for(const rule of [`frame-src 'none'`,`worker-src 'none'`,`form-action 'none'`,`object-src 'none'`]) assert.match(open,new RegExp(rule));

  await env.until(async()=>!!mcpAppOf((await env.row('m5'))?.data));
  const offline=(await env.row('m5'))!;
  assert.equal(mcpAppOf(offline.data)?.uri,'ui://board/offline.html','the deprecated flat ui/resourceUri key is still read');
  await assert.rejects(call(env.service,'mcp.apps.allowNetwork',{chatId:env.chat.id,itemId:offline.id}),/did not ask for network/i);
});

// ---- the bridge (no frame) ----------------------------------------------------------------------------------------------
function bridgeHarness(overrides:Partial<Parameters<typeof createMcpAppBridge>[0]>={}){
  const sent:any[]=[],links:string[]=[],composer:string[]=[],tools:Array<[string,unknown]>=[];
  const bridge=createMcpAppBridge({post:message=>sent.push(message),toolInput:{board:'roadmap'},toolResult:{content:[{type:'text',text:'3 cards'}],structuredContent:{cards:3}},
    callTool:async(name,args)=>{tools.push([name,args]);return {content:[{type:'text',text:'ok'}]};},openLink:url=>links.push(url),toComposer:text=>composer.push(text),
    hostContext:()=>({theme:'dark',displayMode:'inline'}),...overrides});
  return {bridge,sent,links,composer,tools};
}

// Spec: MUS-SPEC-21-844B (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-844b)
test('the bridge answers ui/initialize, then sends the tool input and result only after the app says it is initialized',async()=>{
  const {bridge,sent}=bridgeHarness();
  await bridge.receive({jsonrpc:'2.0',id:1,method:'ui/initialize',params:{appCapabilities:{},protocolVersion:MCP_APPS_PROTOCOL}},{userActive:false});
  assert.equal(sent.length,1);
  const init=sent[0];
  assert.equal(init.jsonrpc,'2.0');assert.equal(init.id,1);
  assert.equal(MCP_APPS_PROTOCOL,'2026-01-26');
  assert.equal(init.result.protocolVersion,'2026-01-26');
  assert.equal(init.result.hostInfo.name,'Muster');
  assert.ok(init.result.hostCapabilities.openLinks,'can open links');
  assert.ok(init.result.hostCapabilities.serverTools,'can call server tools');
  assert.equal(init.result.hostContext.theme,'dark');assert.equal(init.result.hostContext.displayMode,'inline');
  await bridge.receive({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{height:200}},{userActive:false});
  assert.equal(sent.length,1,'nothing is sent before initialized');
  await bridge.receive({jsonrpc:'2.0',method:'ui/notifications/initialized'},{userActive:false});
  assert.deepEqual(sent.slice(1).map(message=>message.method),['ui/notifications/tool-input','ui/notifications/tool-result']);
  assert.deepEqual(sent[1].params,{arguments:{board:'roadmap'}});
  assert.deepEqual(sent[2].params,{content:[{type:'text',text:'3 cards'}],structuredContent:{cards:3}});
  await bridge.receive({jsonrpc:'2.0',method:'ui/notifications/initialized'},{userActive:false});
  assert.equal(sent.length,3,'input and result are sent once');
  await bridge.receive({jsonrpc:'2.0',id:2,method:'ping'},{userActive:false});
  assert.deepEqual(sent.at(-1),{jsonrpc:'2.0',id:2,result:{}});
  await bridge.receive({jsonrpc:'2.0',id:3,method:'sampling/createMessage',params:{}},{userActive:false});
  assert.equal(sent.at(-1).id,3);assert.equal(sent.at(-1).error.code,-32601);
  await bridge.receive('not json-rpc',{userActive:false});
  await bridge.receive({muster:'report-height',height:10},{userActive:false});
  assert.equal(sent.length,5,'non-JSON-RPC messages are ignored');
});

// Spec: MUS-SPEC-21-844F (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-844f)
test('ui/open-link opens the in-app browser only after a click, and ui/message fills the composer without sending',async()=>{
  const {bridge,sent,links,composer,tools}=bridgeHarness();
  await bridge.receive({jsonrpc:'2.0',id:1,method:'ui/open-link',params:{url:'https://example.com/card/7'}},{userActive:false});
  assert.deepEqual(links,[],'no click, no link');
  assert.equal(sent.at(-1).error.code,-32000);
  await bridge.receive({jsonrpc:'2.0',id:2,method:'ui/open-link',params:{url:'https://example.com/card/7'}},{userActive:true});
  assert.deepEqual(links,['https://example.com/card/7'],'a click opens it in the in-app browser');
  assert.deepEqual(sent.at(-1),{jsonrpc:'2.0',id:2,result:{}});
  await bridge.receive({jsonrpc:'2.0',id:3,method:'ui/open-link',params:{url:'javascript:alert(1)'}},{userActive:true});
  await bridge.receive({jsonrpc:'2.0',id:4,method:'ui/open-link',params:{url:'file:///etc/passwd'}},{userActive:true});
  assert.deepEqual(links,['https://example.com/card/7'],'only http(s) links');
  assert.ok(sent.at(-1).error);
  await bridge.receive({jsonrpc:'2.0',id:5,method:'ui/message',params:{role:'user',content:{type:'text',text:'Move card 7 to done'}}},{userActive:false});
  assert.deepEqual(composer,['Move card 7 to done'],'the text goes to the composer');
  assert.deepEqual(sent.at(-1),{jsonrpc:'2.0',id:5,result:{}});
  await bridge.receive({jsonrpc:'2.0',id:6,method:'ui/message',params:{role:'user',content:[{type:'text',text:'a'},{type:'image',data:'x'},{type:'text',text:'b'}]}},{userActive:false});
  assert.deepEqual(composer.at(-1),'a\nb','text blocks only');
  assert.deepEqual(tools,[],'nothing was sent as a tool call or a turn');
  await bridge.receive({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'count',arguments:{x:1}}},{userActive:false});
  assert.deepEqual(tools,[['count',{x:1}]]);
  assert.deepEqual(sent.at(-1),{jsonrpc:'2.0',id:7,result:{content:[{type:'text',text:'ok'}]}});
  const refused=bridgeHarness({callTool:async()=>{throw new Error('This chat is read-only.');}});
  await refused.bridge.receive({jsonrpc:'2.0',id:8,method:'tools/call',params:{name:'move_card',arguments:{}}},{userActive:false});
  assert.equal(refused.sent.at(-1).error.message,'This chat is read-only.');
});
