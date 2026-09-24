import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runBrowserTool,type AgentBrowserHost,type AgentPage} from '../src/main/agent-tools/browser-actions.ts';
import {BrowserBridge,agentBrowserOwner,launcherScript} from '../src/main/agent-tools/browser-bridge.ts';
import {handleMcpMessage} from '../src/main/agent-tools/browser-mcp.ts';
import {BROWSER_TOOL_SPECS,electronKey,formatSnapshot} from '../src/main/agent-tools/browser-tools.ts';
import {BROWSER_TOOLS,computerAction,computerUseTarget,elicitationPolicy,elicitationResult,elicitationText,isElicitationRequest,maskComputerArguments} from '../src/shared/computer-use.ts';
import {computerRunOptions} from '../src/runtime/domains/computer.ts';
import {computerPermissions} from '../src/main/computer-capture.ts';

/** A page whose scripts answer from a queue; input events are recorded. */
function fakeHost(options:{attached?:boolean;results?:unknown[]}={}) {
  const events:unknown[]=[],typed:string[]=[],scripts:string[]=[];
  const results=options.results??[];
  let open=false,url='about:blank';
  const page:AgentPage={attached:options.attached??true,fill:true,state:()=>({owner:'o',url,title:'Fixture'} as never),contents:{
    executeJavaScriptInIsolatedWorld:(_world,list)=>{scripts.push(list[0]!.code);return Promise.resolve(results.length?results.shift():{url,title:'Fixture',outline:'- button "Send" [ref=e1]',text:'hello'});},
    sendInputEvent:event=>{events.push(event);},insertText:text=>{typed.push(text);return Promise.resolve();},isLoading:()=>false,getZoomFactor:()=>1,
  }};
  const host:AgentBrowserHost={has:()=>open,open:target=>{open=true;if(target)url=target;return page.state();},page:()=>page,back:()=>page.state(),reload:()=>page.state(),console:()=>[{level:'error',message:'boom',source:'app.js',line:3,at:1}],screenshot:async()=>({dataUrl:'data:image/jpeg;base64,/9j/AAAA',width:640,height:400})};
  return {host,events,typed,scripts};
}

test('tool specs and the shared tool list agree',()=>{
  assert.deepEqual(BROWSER_TOOL_SPECS.map(spec=>spec.name),[...BROWSER_TOOLS]);
  assert.equal(electronKey('enter'),'Enter');assert.equal(electronKey('x'),'x');assert.equal(electronKey('nope'),undefined);
  assert.match(formatSnapshot({title:'T',url:'https://a.test',outline:'- link "Home" [ref=e1]',text:'hi'}),/Page: T — https:\/\/a\.test[\s\S]*\[ref=e1\][\s\S]*hi/);
});

test('browser_navigate opens the page and answers with a snapshot; clicks send trusted input at the element centre',async()=>{
  const {host,events}=fakeHost({results:[{url:'https://a.test',title:'A',outline:'- button "Send" [ref=e1]',text:''},{x:10.4,y:20.6},{url:'https://a.test',title:'A',outline:'',text:'sent'}]});
  const opened=await runBrowserTool(host,'browser_navigate',{url:'https://a.test'},{readOnly:false});
  assert.equal(opened.action,'Opened https://a.test');
  assert.match((opened.result.content[0] as {text:string}).text,/Page: A — https:\/\/a\.test/);
  const clicked=await runBrowserTool(host,'browser_click',{ref:'e1',element:'Send'},{readOnly:false});
  assert.equal(clicked.action,'Clicked “Send”');
  assert.deepEqual(events.map(event=>(event as {type:string}).type),['mouseMove','mouseDown','mouseUp']);
  assert.deepEqual((events[1] as {x:number;y:number}),{type:'mouseDown',x:10,y:21,button:'left',clickCount:1} as never);
});

test('read-only chats may look but not act; typed secrets are masked in the action',async()=>{
  const {host,typed}=fakeHost({results:[{url:'u',title:'t',outline:'',text:''},{ok:true,password:true},{url:'u',title:'t',outline:'',text:''}]});
  host.open('https://a.test');
  const denied=await runBrowserTool(host,'browser_type',{text:'hunter2'},{readOnly:true});
  assert.equal(denied.result.isError,true);assert.equal(denied.action,'');
  const shot=await runBrowserTool(host,'browser_screenshot',{},{readOnly:true});
  assert.equal(shot.action,'Took a screenshot');
  assert.deepEqual(shot.result.content[0],{type:'image',data:'/9j/AAAA',mimeType:'image/jpeg'});
  await runBrowserTool(host,'browser_snapshot',{},{readOnly:false});
  const secret=await runBrowserTool(host,'browser_type',{ref:'e2',element:'Password',text:'hunter2'},{readOnly:false});
  assert.equal(secret.action,'Typed •••••• into “Password”');
  assert.deepEqual(typed,['hunter2']);
  const unknown=await runBrowserTool(host,'browser_fly',{},{readOnly:false});
  assert.equal(unknown.result.isError,true);
});

test('the bridge queues one chat at a time, refuses unknown chats, and honours a user-held lease',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'muster-bridge-'));
  const emitted:unknown[]=[];let lease:'agent'|'user'='agent';const frames:number[]=[];
  const {host}=fakeHost();
  const browser={
    agentOpen:(owner:string,_profile:string,url?:string)=>host.open(url),hasTab:()=>host.has(),agentPage:()=>host.page(),back:()=>host.back(),reload:()=>host.reload(),console:()=>host.console(),
    frame:async(_owner:string,width?:number)=>{frames.push(width??0);return {dataUrl:'data:image/jpeg;base64,AA',width:320,height:200,url:'https://a.test',title:'A'};},
  };
  const bridge=new BrowserBridge({dir,browser,execPath:'/usr/bin/env',script:'/x/browser-mcp.cjs',emit:event=>emitted.push(event),lease:async()=>lease,snapshot:async()=>({chats:[{id:'c1',mode:'agent',permissionMode:'full'}],folders:[],projects:[],version:1} as never)});
  const launcher=await bridge.start();
  assert.ok(fs.readFileSync(launcher,'utf8').includes("'/x/browser-mcp.cjs'"));
  assert.match(fs.readFileSync(path.join(dir,'browser-endpoint.json'),'utf8'),/"token":"[a-f0-9]{64}"/);
  assert.equal((await bridge.call('missing','browser_snapshot',{})).isError,true);
  assert.equal((await bridge.call('c1','browser_fly',{})).isError,true);
  const first=await bridge.call('c1','browser_navigate',{url:'https://a.test'});
  assert.notEqual(first.isError,true);
  assert.equal(emitted.filter(event=>(event as {type:string}).type==='computerBrowserOpened').length,1);
  assert.equal((emitted.find(event=>(event as {type:string}).type==='computerBrowserOpened') as {owner:string}).owner,agentBrowserOwner('c1'));
  await new Promise(resolve=>setTimeout(resolve,20));
  const frame=emitted.find(event=>(event as {type:string}).type==='computerFrame') as {frame:{action:string;chatId:string}}|undefined;
  assert.equal(frame?.frame.action,'Opened https://a.test');assert.equal(frame?.frame.chatId,'c1');
  lease='user';
  const blocked=await bridge.call('c1','browser_snapshot',{});
  assert.equal(blocked.isError,true);assert.match((blocked.content[0] as {text:string}).text,/taken control/);
  bridge.dispose();
  assert.ok(!fs.existsSync(path.join(dir,'browser-endpoint.json')));
  fs.rmSync(dir,{recursive:true,force:true});
});

test('launcher quotes paths for sh',()=>{
  assert.equal(launcherScript("/App/It's.app/electron",'/a b/mcp.cjs','/e.json'),"#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '/App/It'\\''s.app/electron' '/a b/mcp.cjs' '/e.json'\n");
});

test('the stdio MCP server answers initialize, lists tools and forwards calls',async()=>{
  const out:string[]=[];const calls:unknown[]=[];
  const options={write:(line:string)=>out.push(line),call:async(tool:string,args:unknown)=>{calls.push([tool,args]);return {content:[{type:'text' as const,text:'ok'}]};}};
  await handleMcpMessage({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26'}},options);
  await handleMcpMessage({jsonrpc:'2.0',id:2,method:'tools/list'},options);
  await handleMcpMessage({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'browser_click',arguments:{ref:'e1'}}},options);
  await handleMcpMessage({jsonrpc:'2.0',method:'notifications/initialized'},options);
  await handleMcpMessage({jsonrpc:'2.0',id:4,method:'nope'},options);
  const replies=out.map(line=>JSON.parse(line));
  assert.equal(replies[0].result.protocolVersion,'2025-03-26');assert.equal(replies[0].result.serverInfo.name,'muster_browser');
  assert.equal(replies[1].result.tools.length,BROWSER_TOOL_SPECS.length);
  assert.deepEqual(calls,[['browser_click',{ref:'e1'}]]);assert.equal(replies[2].result.content[0].text,'ok');
  assert.equal(replies.length,4);assert.equal(replies[3].error.code,-32601);
});

test('computer-use detection covers the IDE server names, the browser bridge and bare tool names',()=>{
  assert.equal(computerUseTarget({type:'mcpToolCall',server:'unified-computer-use',tool:'click'}),'computer');
  assert.equal(computerUseTarget({type:'mcpToolCall',server:'visualize',tool:'save_screenshot'}),'computer');
  assert.equal(computerUseTarget({type:'mcpToolCall',server:'muster_browser',tool:'browser_click'}),'browser');
  assert.equal(computerUseTarget({type:'dynamicToolCall',tool:'browser_navigate'}),'browser');
  assert.equal(computerUseTarget({type:'mcpToolCall',tool:'listApps'}),'computer');
  assert.equal(computerUseTarget({type:'mcpToolCall',server:'github',tool:'search'}),undefined);
  assert.equal(computerUseTarget({type:'commandExecution',command:'click'}),undefined);
  const action=computerAction({type:'mcpToolCall',server:'computer-use',tool:'click',arguments:JSON.stringify({app:'Mail',element:'Send'})});
  assert.equal(action?.label,'Clicked “Send” in Mail');assert.equal(action?.app,'Mail');
  assert.equal(computerAction({type:'mcpToolCall',server:'muster_browser',tool:'browser_navigate',arguments:{url:'https://news.ycombinator.com/x'}})?.label,'Opened news.ycombinator.com');
  assert.equal(computerAction({type:'mcpToolCall',server:'computer-use',tool:'type',arguments:{app:'Safari',text:'secret',element:'Password'}})?.label,'Typed •••••• in Safari');
  assert.deepEqual(maskComputerArguments({text:'pw',element:'Password'}),{text:'••••••',element:'Password'});
  assert.deepEqual(maskComputerArguments({text:'hi',element:'Search'}),{text:'hi',element:'Search'});
});

test('elicitations: method detection, prompt text, access-level policy and the round-trip answer',()=>{
  assert.ok(isElicitationRequest('mcpServer/elicitation/request'));assert.ok(isElicitationRequest('openai/form'));assert.ok(!isElicitationRequest('item/commandExecution/requestApproval'));
  assert.equal(elicitationText({message:'Allow Mail control?'}),'Allow Mail control?');
  assert.equal(elicitationText({elicitation:{prompt:'Nested'}}),'Nested');
  assert.match(elicitationText({requestedSchema:{type:'object'}}),/"type": "object"/);
  assert.equal(elicitationText({}),'An MCP server asks for permission.');
  assert.equal(elicitationPolicy('full'),'accept');assert.equal(elicitationPolicy('workspace'),'ask');assert.equal(elicitationPolicy('read-only'),'decline');assert.equal(elicitationPolicy('workspace','muster_browser'),'accept','the in-app browser runs without a card in workspace mode');assert.equal(elicitationPolicy('workspace','computer-use'),'ask','desktop computer use still asks');assert.equal(elicitationPolicy('read-only','muster_browser'),'decline');assert.equal(elicitationPolicy(undefined),'decline');
  assert.deepEqual(elicitationResult(true),{action:'accept',content:{}});assert.deepEqual(elicitationResult(false),{action:'decline',content:null});
});

test('turn options keep computer use on and add the browser MCP only when the launcher exists',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'muster-launcher-'));const launcher=path.join(dir,'muster-browser-mcp');fs.writeFileSync(launcher,'#!/bin/sh\n');
  const on=computerRunOptions({id:'c1',mode:'agent',permissionMode:'full'},launcher)!;
  assert.match(on.developerInstructions,/muster_browser/);assert.match(on.developerInstructions,/computer-use/);assert.ok(!/read-only/.test(on.developerInstructions));
  assert.equal(on.configOverrides?.['mcp_servers.muster_browser.command'],launcher);assert.equal(on.configOverrides?.['mcp_servers.muster_browser.env.MUSTER_CHAT_ID'],'c1');
  const off=computerRunOptions({id:'c1',mode:'agent',permissionMode:'read-only'},path.join(dir,'missing'))!;
  assert.ok(!off.configOverrides);assert.match(off.developerInstructions,/read-only/);assert.ok(!/muster_browser/.test(off.developerInstructions));
  assert.equal(computerRunOptions({id:'c1',mode:'ask'},launcher),null);
  fs.rmSync(dir,{recursive:true,force:true});
});

test('permission probe reports what macOS allows and is granted elsewhere',()=>{
  assert.deepEqual(computerPermissions({isTrustedAccessibilityClient:()=>false,getMediaAccessStatus:()=>'denied'},'darwin'),{platform:'darwin',accessibility:'denied',screen:'denied'});
  assert.deepEqual(computerPermissions({isTrustedAccessibilityClient:()=>{throw new Error('x');}},'darwin'),{platform:'darwin',accessibility:'unknown',screen:'unknown'});
  assert.deepEqual(computerPermissions({},'linux'),{platform:'linux',accessibility:'granted',screen:'granted'});
});
