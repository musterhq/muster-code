/** #424: every provider route either offers Muster's in-app browser, wired to the chat's own browser tab (the one the
 *  right pane shows), or says plainly that it has none. #387: the bridge starts on first use, retries once, and errors clearly. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {computerRunOptions} from '../src/runtime/domains/computer.ts';
import {adapterBrowser} from '../src/runtime/provider.ts';
import {claudeArgs} from '../src/runtime/adapters/claude-code.ts';
import {openCodeMcpEnv,openCodeToolItem} from '../src/runtime/adapters/opencode.ts';
import {acpMcpServers,grokToolItem} from '../src/runtime/adapters/grok-cli.ts';
import {executeTool,toolInstructions,toolSpecs} from '../src/runtime/adapters/http-tools.ts';
import {BROWSER_MCP,BROWSER_NOTE,NO_BROWSER_NOTE,browserToolName,browserToolStyle,computerUseTarget} from '../src/shared/computer-use.ts';
import {agentBrowserOwner} from '../src/shared/browser-protocol.ts';
import {agentBrowserBinding} from '../src/renderer/computerUse.ts';
import {BrowserBridge,BROWSER_CALLER_KEY,callSession} from '../src/main/agent-tools/browser-bridge.ts';
import {callWithRetry} from '../src/main/agent-tools/browser-mcp.ts';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'muster-route-matrix-'));
const launcher=path.join(dir,'muster-browser-mcp');fs.writeFileSync(launcher,'#!/bin/sh\n',{mode:0o700});
test.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
const chat={id:'chat-7',mode:'agent' as const,permissionMode:'workspace' as const,folderId:'f1',projectId:null};
const options=computerRunOptions(chat,launcher)!;

/** Route → how its model reaches the browser. 'mcp' and 'native' must drive the chat's own tab; 'none' must say so. */
const MATRIX:{route:string;driver:string|undefined;offered:'mcp'|'native'|'none'}[]=[
  {route:'Codex (ChatGPT sign-in, gateways)',driver:'codex-app-server',offered:'mcp'},
  {route:'Claude Code',driver:'claude-code-cli',offered:'mcp'},
  {route:'OpenCode',driver:'opencode-cli',offered:'mcp'},
  {route:'Grok CLI (ACP)',driver:'grok-acp',offered:'mcp'},
  {route:'HTTP / router / API key (OpenAI-compatible: OmniRoute, OpenRouter, custom)',driver:'openai-chat-completions',offered:'native'},
  {route:'Anthropic API key (chat only)',driver:'anthropic-messages',offered:'none'},
  {route:'Gemini CLI',driver:'gemini-cli',offered:'none'},
  {route:'Cursor CLI',driver:'cursor-cli',offered:'none'},
];

test('route matrix: the browser tool is offered where the route can load it, under its exact name, and wired to the chat\'s tab',async t=>{
  const rows:string[]=[];
  const paneOwner=agentBrowserBinding(chat.id,chat)!.owner;
  assert.equal(paneOwner,agentBrowserOwner(chat.id),'the pane shows the tab the bridge drives for this chat');
  for(const row of MATRIX){
    const style=browserToolStyle(row.driver);
    let chatIdSent:string|undefined,named='';
    if(row.driver==='codex-app-server'){
      // Codex gets the computer domain's overrides as they are.
      assert.ok(options.developerInstructions.includes(BROWSER_NOTE));
      assert.equal(options.configOverrides![`mcp_servers.${BROWSER_MCP}.command`],launcher);
      chatIdSent=String(options.configOverrides![`mcp_servers.${BROWSER_MCP}.env.MUSTER_CHAT_ID`]);named='browser_navigate';
    } else {
      const run=adapterBrowser(row.driver,'agent',options.developerInstructions,options.configOverrides);
      const text=run.instructions??'';
      if(row.offered==='none'){
        assert.ok(text.includes(NO_BROWSER_NOTE),`${row.route}: says plainly there is no browser`);
        assert.ok(!text.includes('browser_navigate'),`${row.route}: names no browser tool`);
        assert.equal(run.mcpServers?.[BROWSER_MCP],undefined);assert.equal(run.browserTools,undefined);
      } else if(row.offered==='native'){
        assert.equal(run.mcpServers?.[BROWSER_MCP],undefined,'HTTP routes load no MCP servers');
        assert.equal(run.browserTools,true);
        assert.ok(!text.includes(BROWSER_NOTE),'the MCP wording is replaced');
        named=browserToolName(style,'browser_navigate');
        // Native function tools, gated by the access level, calling the same bridge with the chat id.
        assert.ok(toolSpecs('workspace',true).some(tool=>tool.function.name==='browser_click'));
        assert.ok(!toolSpecs('read-only',true).some(tool=>tool.function.name==='browser_click'),'read-only offers no clicking');
        assert.ok(toolSpecs('read-only',true).some(tool=>tool.function.name==='browser_snapshot'));
        assert.match(toolInstructions('workspace','/w',true),/browser_navigate, browser_snapshot/);
        const calls:unknown[][]=[];const events:{item:Record<string,unknown>}[]=[];
        (globalThis as Record<symbol,unknown>)[BROWSER_CALLER_KEY]=async(...args:unknown[])=>{calls.push(args);return {content:[{type:'text',text:'Page: App — https://app.test/'}]};};
        try {
          const result=await executeTool({id:'k1',name:'browser_navigate',arguments:'{"url":"https://app.test/"}'},{chatId:chat.id,browser:true,cwd:dir,access:'workspace',signal:new AbortController().signal,emit:(_method,params)=>events.push(params as never),threadId:'t',turnId:'u'});
          assert.equal(result.ok,true);assert.match(result.content,/Page: App/);
          chatIdSent=String(calls[0]![0]);
          assert.equal(computerUseTarget(events.at(-1)!.item),'browser','the timeline row is a muster_browser row the PiP follows');
          const denied=await executeTool({id:'k2',name:'browser_click',arguments:'{"ref":"e1"}'},{chatId:chat.id,browser:true,cwd:dir,access:'read-only',signal:new AbortController().signal,emit:()=>{},threadId:'t',turnId:'u'});
          assert.equal(denied.ok,false);assert.equal(calls.length,1,'a read-only click never reaches the browser');
        } finally {delete (globalThis as Record<symbol,unknown>)[BROWSER_CALLER_KEY];}
      } else {
        const server=run.mcpServers?.[BROWSER_MCP];
        assert.ok(server,`${row.route}: the browser server is attached`);
        chatIdSent=server!.env?.MUSTER_CHAT_ID;named=browserToolName(style,'browser_navigate');
        assert.ok(text.includes(named),`${row.route}: the instructions name ${named}`);
        if(row.driver==='claude-code-cli'){
          const args=claudeArgs({chat:chat as never,cwd:dir,prompt:'p',model:'claude-code/default',permissionMode:'workspace',mcpServers:run.mcpServers,instructions:run.instructions,signal:new AbortController().signal} as never,'s1','/private/config.json');
          assert.equal(args[args.indexOf('--mcp-config')+1],'/private/config.json');assert.ok(args.includes(`mcp__${BROWSER_MCP}`),'allowed without a prompt');
        }
        if(row.driver==='opencode-cli'){
          const env=JSON.parse(openCodeMcpEnv(run.mcpServers,'{"model":"x/y"}').OPENCODE_CONFIG_CONTENT!);
          assert.equal(env.model,'x/y','the user\'s inline config is kept');
          assert.equal(env.mcp[BROWSER_MCP].type,'local');assert.equal(env.mcp[BROWSER_MCP].environment.MUSTER_CHAT_ID,chat.id);
          assert.equal(computerUseTarget(openCodeToolItem({callID:'1',tool:'muster_browser_browser_click',state:{input:{ref:'e1'}}},dir)),'browser');
        }
        if(row.driver==='grok-acp'){
          const servers=acpMcpServers(run.mcpServers);
          assert.deepEqual(servers.find(entry=>entry.name===BROWSER_MCP)!.env,[{name:'MUSTER_CHAT_ID',value:chat.id}]);
          assert.equal(computerUseTarget(grokToolItem({toolCallId:'1',kind:'other',title:'muster_browser: browser_click',rawInput:{ref:'e1'}},dir)),'browser');
        }
      }
    }
    if(row.offered!=='none'){
      assert.equal(chatIdSent,chat.id,`${row.route}: calls carry this chat's id`);
      assert.equal(agentBrowserOwner(chatIdSent!),paneOwner,`${row.route}: the bridge drives the tab the pane shows`);
    }
    rows.push(`${row.route.padEnd(80)} ${row.offered==='none'?'no browser (stated plainly)':`${row.offered.padEnd(6)} ${named} -> ${agentBrowserOwner(chatIdSent!)}`}`);
  }
  t.diagnostic('\n'+rows.join('\n'));
  // Ask and Plan chats get no browser on any route.
  assert.equal(computerRunOptions({...chat,mode:'ask'},launcher),null);
});

test('bridge: one tab per sub-agent session, a hung call answers with a clear error, and the start is retried once',async()=>{
  assert.equal(callSession({session:'reviewer'}),'reviewer');assert.equal(callSession({session:'no spaces'}),undefined);assert.equal(callSession({},'env-key'),'env-key');
  const opened:string[]=[];let release!:()=>void;const hung=new Promise<void>(resolve=>{release=resolve;});
  const page=(owner:string)=>({attached:false,fill:true,state:()=>({owner,url:'https://a.test/',title:'A'} as never),contents:{
    executeJavaScriptInIsolatedWorld:async()=>{if(owner.endsWith('--slow'))await hung;return {url:'https://a.test/',title:'A',outline:'',text:''};},sendInputEvent(){},insertText:async()=>{},isLoading:()=>false,getZoomFactor:()=>1}});
  const tabs=new Set<string>();
  const browser={agentOpen:(owner:string)=>{tabs.add(owner);opened.push(owner);return page(owner).state();},hasTab:(owner:string)=>tabs.has(owner),agentPage:page,back:(owner:string)=>page(owner).state(),reload:(owner:string)=>page(owner).state(),console:()=>[],frame:async()=>undefined};
  const bridgeDir=fs.mkdtempSync(path.join(dir,'b-'));
  const bridge=new BrowserBridge({dir:bridgeDir,browser,execPath:'/usr/bin/env',script:'/x/browser-mcp.cjs',emit:()=>{},lease:async()=>'agent',snapshot:async()=>({chats:[chat],folders:[],projects:[],version:1} as never)});
  const slow=bridge.call(chat.id,'browser_navigate',{url:'https://a.test/',session:'slow'},undefined,200);
  const main=await bridge.call(chat.id,'browser_navigate',{url:'https://a.test/'});
  assert.notEqual(main.isError,true,'the chat\'s own tab is not stuck behind a sub-agent\'s');
  const late=await slow;
  assert.equal(late.isError,true);assert.match((late.content[0] as {text:string}).text,/did not finish browser_navigate within 1 s/);
  assert.deepEqual(opened.sort(),[agentBrowserOwner(chat.id),agentBrowserOwner(chat.id,'slow')].sort(),'each session has its own tab');
  release();
  // First start fails (the directory is a file), the retry succeeds once it is fixed.
  const blocked=path.join(dir,'blocked');fs.writeFileSync(blocked,'x');
  const retry=new BrowserBridge({dir:blocked,browser,execPath:'/usr/bin/env',script:'/x/browser-mcp.cjs',emit:()=>{},lease:async()=>'agent',snapshot:async()=>({chats:[],folders:[],projects:[],version:1} as never)});
  const started=retry.ensureStarted(50);setTimeout(()=>{fs.rmSync(blocked);},10);
  assert.ok(fs.existsSync(await started),'the retry started the bridge');
  const broken=new BrowserBridge({dir:path.join(blocked+'2','x'),browser,execPath:'/usr/bin/env',script:'/x/browser-mcp.cjs',emit:()=>{},lease:async()=>'agent',snapshot:async()=>({chats:[],folders:[],projects:[],version:1} as never)});
  fs.writeFileSync(blocked+'2','x');
  await assert.rejects(broken.ensureStarted(10),/Muster's browser could not start: .*restart Muster/);
  retry.dispose();broken.dispose();bridge.dispose();
});

// Spec: MUS-SPEC-09-465C (docs/spec/clauses/09-browser-and-previews.md#mus-spec-09-465c)
test('MCP server: connection resets retry read-only tools with backoff but never repeat a click',async()=>{
  let reads=0;
  const reset=async()=>{if(++reads<3)throw new Error('fetch failed: ECONNRESET');return {content:[{type:'text' as const,text:'ok'}]};};
  assert.equal(((await callWithRetry(reset,'browser_snapshot',{},1)).content[0] as {text:string}).text,'ok');assert.equal(reads,3);
  let clicks=0;
  const resetClick=async()=>{clicks++;throw new Error('fetch failed: ECONNRESET');};
  await assert.rejects(callWithRetry(resetClick,'browser_click',{},1),/ECONNRESET/);assert.equal(clicks,1);
  let refused=0;
  const down=async()=>{if(++refused<3)throw new Error('fetch failed: ECONNREFUSED');return {content:[{type:'text' as const,text:'up'}]};};
  assert.equal(((await callWithRetry(down,'browser_click',{},1)).content[0] as {text:string}).text,'up');assert.equal(refused,3);
  let always=0;
  await assert.rejects(callWithRetry(async()=>{always++;throw new Error('ECONNREFUSED');},'browser_snapshot',{},1));assert.equal(always,4);
});

test('MCP server: a refused connection is retried once; a timeout is not',async()=>{
  let attempts=0;
  const flaky=async()=>{if(++attempts===1)throw new Error('fetch failed: ECONNREFUSED');return {content:[{type:'text' as const,text:'ok'}]};};
  assert.equal(((await callWithRetry(flaky,'browser_snapshot',{},5)).content[0] as {text:string}).text,'ok');assert.equal(attempts,2);
  let timed=0;
  const slow=async()=>{timed++;const error=new Error('The operation was aborted due to timeout');error.name='TimeoutError';throw error;};
  await assert.rejects(callWithRetry(slow,'browser_snapshot',{},5),/no answer within 110 s/);assert.equal(timed,1);
});
