import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm,mkdir,writeFile,symlink} from 'node:fs/promises';
import {existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';
import {isCommandName} from '../src/main/commands.ts';
import {ARTIFACTS_COMMANDS,sideChatLabel,type Canvas,type CanvasVersion,type SideChat} from '../src/shared/domains/artifacts-protocol.ts';
import {CanvasStore} from '../src/runtime/canvases.ts';
import {CANVAS_MCP,CanvasToolHost,canvasMcpServerSource,runCanvasTool} from '../src/runtime/canvas-agent-tools.ts';
import {pluginUiEntry,sideChatBinding,sideChatContext} from '../src/runtime/domains/artifacts.ts';
import {createArtifactsDomain} from '../src/runtime/domains/artifacts.ts';
import {canvasDiffRows} from '../src/renderer/canvasDiff.ts';
import {DatabaseSync} from 'node:sqlite';

const provider:ProviderAdapter={info:()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture'}]}],run:async()=>({status:'completed',finalMessage:'ok'}),stop:async()=>true,dispose(){}};
async function directory(t:TestContext,prefix='muster-canvas-'){const path=await mkdtemp(join(tmpdir(),prefix));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
type Service=ReturnType<typeof createAgentService>;
const call=<T>(service:Service,command:string,input?:unknown)=>(service.invoke as unknown as (c:string,i:unknown)=>Promise<T>)(command,input);

test('artifact commands are allowlisted for the renderer',()=>{
  for(const command of Object.keys(ARTIFACTS_COMMANDS))assert.equal(isCommandName(command),true,command);
  assert.equal(isCommandName('files.external.inspect'),true);
  assert.equal(isCommandName('computer.accessibilityText'),true);
});

test('WRK-12 canvas: create, co-edit with version guard, history, diff, restore, delete; survives restart',async t=>{
  const dataDir=await directory(t);
  const events:Array<{type:string}>=[];
  let service=createAgentService({dataDir,provider,onEvent:event=>events.push(event)});
  t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  const created=await call<Canvas>(service,'artifacts.canvas.create',{title:'Plan',kind:'markdown',content:'# Plan\n\n- one\n',chatId:chat.id});
  assert.equal(created.version,1);assert.equal(created.updatedBy,'user');
  assert.ok(events.some(event=>event.type==='canvasChanged'));
  const saved=await call<{conflict:boolean;canvas:Canvas}>(service,'artifacts.canvas.update',{id:created.id,content:'# Plan\n\n- one\n- two\n',baseVersion:1});
  assert.equal(saved.conflict,false);assert.equal(saved.canvas.version,2);
  // A stale base (the agent saved in between) is refused, never overwritten.
  const stale=await call<{conflict:boolean;canvas:Canvas}>(service,'artifacts.canvas.update',{id:created.id,content:'lost?',baseVersion:1});
  assert.equal(stale.conflict,true);assert.equal(stale.canvas.content,'# Plan\n\n- one\n- two\n');
  // Unchanged content writes no version.
  assert.equal((await call<{canvas:Canvas}>(service,'artifacts.canvas.update',{id:created.id,content:'# Plan\n\n- one\n- two\n',baseVersion:2})).canvas.version,2);
  const versions=(await call<{versions:CanvasVersion[]}>(service,'artifacts.canvas.versions',{id:created.id})).versions;
  assert.deepEqual(versions.map(version=>version.version),[2,1]);
  const first=await call<{content:string}>(service,'artifacts.canvas.version',{id:created.id,version:1});
  const diff=canvasDiffRows(first.content,saved.canvas.content);
  assert.equal(diff.added,1);assert.equal(diff.removed,0);
  const restored=await call<Canvas>(service,'artifacts.canvas.restore',{id:created.id,version:1});
  assert.equal(restored.version,3);assert.equal(restored.content,'# Plan\n\n- one\n');
  const after=(await call<{versions:CanvasVersion[]}>(service,'artifacts.canvas.versions',{id:created.id})).versions;
  assert.equal(after[0]?.restoredFrom,1,'restore appends a version instead of rewriting history');
  await assert.rejects(call(service,'artifacts.canvas.update',{id:created.id,content:'x'.repeat(1024*1024+1)}),/larger than 1 MB/);
  await assert.rejects(call(service,'artifacts.canvas.create',{kind:'pdf'}),/markdown, code or html/);
  await assert.rejects(call(service,'artifacts.canvas.get',{id:'../../etc'}),/Choose a canvas/);

  await service.dispose();
  service=createAgentService({dataDir,provider,onEvent(){}});
  assert.equal((await call<Canvas>(service,'artifacts.canvas.get',{id:created.id})).version,3);
  assert.equal((await call<{canvases:unknown[]}>(service,'artifacts.canvas.list',{chatId:chat.id})).canvases.length,1);
  await call(service,'artifacts.canvas.delete',{id:created.id});
  await assert.rejects(call(service,'artifacts.canvas.get',{id:created.id}),/no longer exists/);
});

test('WRK-12 agent tools: a chat creates, reads and updates only its own canvases, with the version guard',()=>{
  const store=new CanvasStore(()=>db);const db=new DatabaseSync(':memory:');
  const changed:Array<{id:string;created:boolean}>=[];
  const target={store,chatId:'chat-a',changed:(canvas:Canvas,created:boolean)=>changed.push({id:canvas.id,created})};
  const made=runCanvasTool(target,'canvas_create',{title:'Spec',content:'v1',kind:'markdown'});
  assert.equal(made.isError,undefined);
  const id=store.list('chat-a')[0]!.id;
  assert.deepEqual(changed,[{id,created:true}]);
  assert.match(runCanvasTool(target,'canvas_read',{id}).content[0]!.text,/version 1[\s\S]*---\nv1/);
  store.update(id,{content:'user edit'},'user');
  const conflict=runCanvasTool(target,'canvas_update',{id,content:'agent',base_version:1});
  assert.equal(conflict.isError,true);assert.match(conflict.content[0]!.text,/retry with base_version 2[\s\S]*user edit/);
  const ok=runCanvasTool(target,'canvas_update',{id,content:'merged',base_version:2,note:'Merge'});
  assert.equal(ok.isError,undefined);assert.equal(store.get(id).updatedBy,'agent');
  assert.equal(store.versions(id)[0]!.note,'Merge');
  const other=runCanvasTool({...target,chatId:'chat-b'},'canvas_read',{id});
  assert.equal(other.isError,true);assert.match(other.content[0]!.text,/another chat/);
  assert.match(runCanvasTool(target,'canvas_list',{}).content[0]!.text,/Spec/);
  assert.equal(runCanvasTool(target,'canvas_delete',{id}).isError,true);
  assert.match(canvasMcpServerSource(),new RegExp(CANVAS_MCP));
});

test('WRK-12 canvas host: bearer token required; per-chat calls routed; launcher is 0700',async t=>{
  const dir=await directory(t);
  const store=new CanvasStore(()=>db);const db=new DatabaseSync(':memory:');
  const host=new CanvasToolHost({dir,execPath:process.execPath,resolve:chatId=>({store,chatId,changed(){}})});
  t.after(()=>host.dispose());
  const launcher=await host.start();
  assert.equal(statSync(launcher).mode&0o777,0o700);
  const endpoint=JSON.parse(await (await import('node:fs/promises')).readFile(join(dir,'canvas-endpoint.json'),'utf8')) as {url:string;token:string};
  assert.equal(statSync(join(dir,'canvas-endpoint.json')).mode&0o777,0o600);
  const denied=await fetch(endpoint.url,{method:'POST',headers:{authorization:'Bearer '+'0'.repeat(64)},body:'{}'});
  assert.equal(denied.status,403);
  const response=await fetch(endpoint.url,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${endpoint.token}`},body:JSON.stringify({chatId:'chat-1',tool:'canvas_create',arguments:{title:'T',content:'hello'}})});
  assert.equal(response.status,200);
  assert.equal(((await response.json()) as {isError?:boolean}).isError,undefined);
  assert.equal(store.list('chat-1').length,1);
  assert.equal(host.call('bad id!','canvas_list',{}).isError,true);
});

test('WRK-12 run options: agent-mode chats get the muster_canvas server; other modes do not',async t=>{
  const dataDir=await directory(t);
  const db=new DatabaseSync(':memory:');
  let contributor:((chat:never)=>Promise<unknown>)|undefined;
  const domain=createArtifactsDomain({dataDir,db:()=>db,store:{chat:()=>({id:'c1'})} as never,emit(){},emitSnapshot(){},folderFor:()=>{throw new Error('x');},invoke:async()=>{throw new Error('x');},
    hooks:{addRunOptionsContributor:(fn:never)=>{contributor=fn;return()=>{};},addPromptContributor:()=>()=>{},onRunStarted:()=>()=>{},onRunSettled:()=>()=>{},setChatDefaults(){},setRunEnvironmentResolver(){}} as never});
  t.after(()=>domain.dispose?.());
  assert.equal(await contributor!({id:'c1',mode:'plan'} as never),null);
  const options=await contributor!({id:'c1',mode:'agent'} as never) as {configOverrides:Record<string,string>;developerInstructions:string};
  assert.ok(existsSync(options.configOverrides[`mcp_servers.${CANVAS_MCP}.command`]!));
  assert.equal(options.configOverrides[`mcp_servers.${CANVAS_MCP}.env.MUSTER_CHAT_ID`],'c1');
  assert.match(options.developerInstructions,/canvas_create/);
});

test('WRK-13 side chat: bound, hidden until promoted, keeps the main chat active, carries its context',async t=>{
  const dataDir=await directory(t),folderPath=await directory(t,'muster-side-folder-');
  const events:Array<{type:string;sideChats?:SideChat[]}>=[];
  const service=createAgentService({dataDir,provider,onEvent:event=>events.push(event as never)});
  t.after(()=>service.dispose());
  const folder=await service.invoke('folder.add',{path:folderPath});
  const main=await service.invoke('chat.create',{folderId:folder.id});
  await service.invoke('chat.select',{id:main.id});
  const side=await call<SideChat>(service,'artifacts.sideChat.create',{parentChatId:main.id,binding:{kind:'file',folderId:folder.id,path:'src/a.ts',line:4,endLine:9,excerpt:'const a = 1;',extra:'dropped'}});
  assert.equal(side.label,'a.ts:4-9');assert.equal(side.parentChatId,main.id);
  assert.deepEqual(side.binding,{kind:'file',folderId:folder.id,path:'src/a.ts',line:4,endLine:9,excerpt:'const a = 1;'});
  const snapshot=await service.invoke('app.snapshot',undefined);
  assert.equal(snapshot.activeChatId,main.id,'a side chat never takes over the main conversation');
  assert.equal(snapshot.chats.find(chat=>chat.id===side.chatId)?.title,'Side: a.ts:4-9');
  assert.ok(events.some(event=>event.type==='sideChatsChanged'&&event.sideChats?.some(item=>item.chatId===side.chatId&&!item.promotedAt)));
  const promoted=await call<SideChat>(service,'artifacts.sideChat.promote',{chatId:side.chatId});
  assert.ok(promoted.promotedAt);
  assert.equal((await service.invoke('app.snapshot',undefined)).chats.find(chat=>chat.id===side.chatId)?.title,'a.ts:4-9');
  await assert.rejects(call(service,'artifacts.sideChat.discard',{chatId:side.chatId}),/promoted/);
  const other=await call<SideChat>(service,'artifacts.sideChat.create',{binding:{kind:'diff',folderId:folder.id,path:'b.ts'}});
  await call(service,'artifacts.sideChat.discard',{chatId:other.chatId});
  assert.equal((await service.invoke('app.snapshot',undefined)).chats.some(chat=>chat.id===other.chatId),false);
  await assert.rejects(call(service,'artifacts.sideChat.create',{binding:{kind:'file',folderId:folder.id,path:'../etc/passwd'}}),/inside the folder/);
  await assert.rejects(call(service,'artifacts.sideChat.create',{binding:{kind:'terminal'}}),/file, diff, pull request or canvas/);
});

test('WRK-13 side chat context and labels',()=>{
  const context=sideChatContext({kind:'file',folderId:'f',path:'src/a.ts',line:2,excerpt:'x ``` y'});
  assert.match(context,/side chat/);assert.match(context,/src\/a\.ts \(lines 2\)/);
  assert.match(context,/````\nx ``` y\n````/,'the fence outgrows backticks in the selection');
  assert.equal(sideChatLabel({kind:'pullRequest',folderId:'f',prNumber:12}),'PR #12');
  assert.equal(sideChatLabel({kind:'diff',folderId:'f',path:'a/b.ts'}),'Diff: b.ts');
  assert.equal(sideChatBinding({kind:'file',folderId:'f',path:'a.ts',excerpt:'z'.repeat(9000)}).excerpt?.length,6000);
});

test('EXT-10 plugin UI entry stays inside the plugin folder and must be HTML',async t=>{
  const root=await directory(t,'muster-plugin-'),outside=await directory(t,'muster-outside-');
  await mkdir(join(root,'ui'));await writeFile(join(root,'ui','index.html'),'<h1>hi</h1>');await writeFile(join(root,'ui','app.js'),'1');
  await writeFile(join(outside,'evil.html'),'x');await symlink(join(outside,'evil.html'),join(root,'ui','link.html'));
  const plugin=(ui:string)=>({id:root,path:root,name:'demo',displayName:'Demo',apps:[{name:'Board',ui}]});
  const entry=await pluginUiEntry(plugin('ui/index.html'),'Board');
  assert.equal(entry.entry,'ui/index.html');assert.equal(entry.title,'Demo · Board');
  await assert.rejects(pluginUiEntry(plugin('ui/link.html'),'Board'),/outside the plugin/);
  await assert.rejects(pluginUiEntry(plugin('../x.html'),'Board'),/inside the folder/);
  await assert.rejects(pluginUiEntry(plugin('ui/app.js'),'Board'),/\.html file/);
  await assert.rejects(pluginUiEntry(plugin('ui/missing.html'),'Board'),/missing/);
  await assert.rejects(pluginUiEntry({...plugin('ui/index.html'),apps:[{name:'Board'}]},'Board'),/does not ship a UI/);
});

test('WRK-13 side chat turns carry the bound resource and selection as context',async t=>{
  const dataDir=await directory(t),folderPath=await directory(t,'muster-side-send-');
  const prompts:string[]=[];
  const recording:ProviderAdapter={...provider,run:async(input:{prompt:string})=>{prompts.push(input.prompt);return {status:'completed',finalMessage:'ok'};}} as ProviderAdapter;
  const service=createAgentService({dataDir,provider:recording,onEvent(){}});
  t.after(()=>service.dispose());
  const folder=await service.invoke('folder.add',{path:folderPath});
  const side=await call<SideChat>(service,'artifacts.sideChat.create',{binding:{kind:'file',folderId:folder.id,path:'src/a.ts',excerpt:'const answer = 42;'}});
  await service.invoke('chat.send',{id:side.chatId,text:'Why 42?',requestId:'side-send-1'} as never);
  for(let i=0;i<200&&!prompts.length;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(prompts.length,1);
  assert.match(prompts[0]!,/<context source="side-chat">[\s\S]*src\/a\.ts[\s\S]*const answer = 42;/);
  assert.match(prompts[0]!,/Why 42\?/);
});
