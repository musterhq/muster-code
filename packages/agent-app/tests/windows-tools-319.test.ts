/**
 * #319: a Windows user imported a Codex chat from `\\?\E:\Development\redis-automation`, ran the router combo
 * "intelligent-planner" with Full access and the agent said it had no shell or file tools; the sidebar showed four
 * "redis-automation" folders. These tests pin the three causes: path spellings treated as different folders, HTTP
 * routes that offered no tools, and a tool-less thread that was resumed instead of replaced.
 */
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,mkdir,readFile,rm,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path,{join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {currentPathPlatform,isInsidePath,looksLikeWindowsPath,normalizeFsPath,pathKey,samePath} from '../src/shared/path-normalize.ts';
import {mergeDuplicateFolders} from '../src/runtime/folder-merge.ts';
import {AgentStore,STORE_MIGRATIONS} from '../src/runtime/store.ts';
import {folderForCwd} from '../src/runtime/domains/import.ts';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter,ProviderInput} from '../src/runtime/provider.ts';
import {openAICompatibleAdapter,refusedTools} from '../src/runtime/adapters/http-chat.ts';
import {toolSpecs,executeTool} from '../src/runtime/adapters/http-tools.ts';
import {createAdapterCatalog} from '../src/runtime/adapters/index.ts';
import {TOOLS_UNAVAILABLE_EVENT} from '../src/runtime/context-budget.ts';
import {ConversationMemory} from '../src/runtime/adapters/shared.ts';
import type {AdapterRunInput} from '../src/runtime/adapters/types.ts';
import type {ImportRunResult,ImportListPage} from '../src/shared/domains/import-protocol.ts';
import {toolBlindModel,toolCapableAlternative,TOOLS_BLIND_NOTICE} from '../src/renderer/components/composerMenus.ts';

const directory=async(t:TestContext)=>{const dir=await mkdtemp(join(tmpdir(),'muster-319-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;};

/* ---- 1. one shared path normaliser -------------------------------------------------------------------------------- */
test('normalizeFsPath: Windows spellings of one folder collapse to one stored form (tested with path.win32, on any OS)',()=>{
  const spellings=['\\\\?\\E:\\Development\\redis-automation','E:\\Development\\redis-automation','e:/Development/redis-automation/','e:\\development\\redis-automation\\','\\\\?\\e:\\Development\\\\redis-automation\\.','//?/E:/Development/redis-automation'];
  const stored=spellings.map(value=>normalizeFsPath(value,'win32'));
  assert.deepEqual(new Set(stored.slice(0,3).concat(stored[4]!,stored[5]!)),new Set(['E:\\Development\\redis-automation']));
  assert.equal(stored[3],'E:\\development\\redis-automation','the stored form keeps the user\'s case; only the key folds it');
  assert.equal(new Set(spellings.map(value=>pathKey(value,'win32'))).size,1);
  // Agrees with Node's own win32 rules for the plain forms.
  assert.equal(normalizeFsPath('e:/a/b/../c//d','win32'),path.win32.normalize('E:/a/b/../c//d'));
  assert.equal(normalizeFsPath('C:\\','win32'),'C:\\');
  assert.equal(normalizeFsPath('c:','win32'),'C:\\');
});
test('normalizeFsPath: UNC, extended UNC, drive-relative and posix',()=>{
  assert.equal(normalizeFsPath('\\\\?\\UNC\\server\\share\\dir\\','win32'),'\\\\server\\share\\dir');
  assert.equal(normalizeFsPath('//server/share/dir','win32'),'\\\\server\\share\\dir');
  assert.equal(pathKey('\\\\SERVER\\Share\\Dir','win32'),pathKey('\\\\?\\UNC\\server\\share\\dir','win32'));
  assert.equal(normalizeFsPath('/Users/me//repo/./app/','posix'),'/Users/me/repo/app');
  assert.notEqual(pathKey('/Users/Me','posix'),pathKey('/Users/me','posix'),'posix paths stay case sensitive');
  assert.equal(samePath('E:\\Dev\\App','e:/dev/app','win32'),true);
  assert.equal(samePath('/a/B','/a/b','posix'),false);
  assert.equal(isInsidePath('\\\\?\\E:\\Dev\\app','e:/dev/APP/src/x.ts','win32'),true);
  assert.equal(isInsidePath('E:\\Dev\\app','E:\\Dev\\app-old\\x','win32'),false,'a sibling that shares a prefix is not inside');
  assert.equal(isInsidePath('/work','/work/a','posix'),true);assert.equal(isInsidePath('/work','/workshop','posix'),false);
  assert.equal(looksLikeWindowsPath('\\\\?\\E:\\x'),true);assert.equal(looksLikeWindowsPath('/Users/x'),false);
  assert.ok(['win32','posix'].includes(currentPathPlatform()));
});

/* ---- 2. duplicate folders merge ------------------------------------------------------------------------------------ */
function legacyDatabase(){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE folders (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL, position INTEGER);
    CREATE TABLE chats (id TEXT PRIMARY KEY, folder_id TEXT, title TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, goal TEXT, folder_ids TEXT NOT NULL, primary_folder_id TEXT);
    CREATE TABLE project_members (project_id TEXT, id TEXT, folder_ids TEXT);
    CREATE TABLE canvases (id TEXT PRIMARY KEY, folder_id TEXT);
    CREATE TABLE task_worktrees (folder_id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT);`);
  return db;
}
test('mergeDuplicateFolders keeps the oldest folder id and moves chats, project links, canvases and worktree rows',()=>{
  const db=legacyDatabase();
  const add=db.prepare('INSERT INTO folders (id,path,name,created_at) VALUES (?,?,?,?)');
  add.run('old','\\\\?\\E:\\Development\\redis-automation','redis-automation','2026-01-01T00:00:00Z');
  add.run('b','E:\\Development\\redis-automation','redis-automation','2026-02-01T00:00:00Z');
  add.run('c','e:/development/redis-automation/','redis-automation','2026-03-01T00:00:00Z');
  add.run('d','\\\\?\\e:\\Development\\redis-automation\\','redis-automation','2026-04-01T00:00:00Z');
  add.run('other','E:\\Development\\other','other','2026-01-15T00:00:00Z');
  for(const [chat,folder] of [['c1','b'],['c2','c'],['c3','d'],['c4','old'],['c5','other']] as const)db.prepare('INSERT INTO chats VALUES (?,?,?)').run(chat,folder,chat);
  db.prepare('INSERT INTO projects VALUES (?,?,?,?,?)').run('p','P','',JSON.stringify(['b','other','c','d']),'c');
  db.prepare('INSERT INTO project_members VALUES (?,?,?)').run('p','m',JSON.stringify(['d']));
  db.prepare('INSERT INTO canvases VALUES (?,?)').run('cv','b');
  db.prepare('INSERT INTO task_worktrees VALUES (?,?,?)').run('b','p','t1');
  const result=mergeDuplicateFolders(db);
  assert.deepEqual([result.groups,result.merged],[1,3]);
  assert.deepEqual((db.prepare('SELECT id,path FROM folders ORDER BY id').all() as Array<{id:string;path:string}>).map(row=>[row.id,row.path]),[['old','E:\\Development\\redis-automation'],['other','E:\\Development\\other']]);
  assert.deepEqual((db.prepare('SELECT folder_id FROM chats ORDER BY id').all() as Array<{folder_id:string}>).map(row=>row.folder_id),['old','old','old','old','other']);
  const project=db.prepare('SELECT folder_ids,primary_folder_id FROM projects').get() as {folder_ids:string;primary_folder_id:string};
  assert.deepEqual([JSON.parse(project.folder_ids),project.primary_folder_id],[['old','other'],'old']);
  assert.equal((db.prepare('SELECT folder_ids FROM project_members').get() as {folder_ids:string}).folder_ids,'["old"]');
  assert.equal((db.prepare('SELECT folder_id FROM canvases').get() as {folder_id:string}).folder_id,'old');
  assert.equal((db.prepare('SELECT folder_id FROM task_worktrees').get() as {folder_id:string}).folder_id,'old');
  assert.deepEqual(mergeDuplicateFolders(db),{merged:0,groups:0,normalized:0},'running it again changes nothing');
});
test('opening a v2 database runs the merge migration; addFolder never creates a duplicate again',async t=>{
  assert.equal(STORE_MIGRATIONS.at(-1)?.name,'merge duplicate folders');
  const dir=await directory(t);
  const first=new AgentStore(dir);
  const db=first.database();
  const seed=db.prepare('INSERT INTO folders (id,path,name,created_at) VALUES (?,?,?,?)');
  seed.run('f1','\\\\?\\E:\\Development\\redis-automation','redis-automation','2026-01-01T00:00:00Z');
  seed.run('f2','E:\\Development\\redis-automation','redis-automation','2026-02-01T00:00:00Z');
  seed.run('f3','e:/Development/redis-automation','redis-automation','2026-03-01T00:00:00Z');
  seed.run('f4','\\\\?\\E:\\Development\\redis-automation\\','redis-automation','2026-04-01T00:00:00Z');
  db.prepare("INSERT INTO chats (id,folder_id,title,updated_at,model) VALUES ('chat-x','f3','Imported','2026-01-01','m')").run();
  db.exec('PRAGMA user_version = 2');
  first.close();
  const reopened=new AgentStore(dir);
  t.after(()=>reopened.close());
  assert.ok(reopened.schemaMigration.applied.some(step=>step.endsWith('merge duplicate folders')));
  const snapshot=reopened.snapshot();
  assert.deepEqual(snapshot.folders.map(folder=>[folder.id,folder.path]),[['f1','E:\\Development\\redis-automation']]);
  assert.equal(snapshot.chats.find(chat=>chat.id==='chat-x')?.folderId,'f1');
  for(const spelling of ['\\\\?\\E:\\Development\\redis-automation','e:\\development\\REDIS-automation\\','E:/Development/redis-automation'])assert.equal(reopened.addFolder(spelling,'x').id,'f1');
  assert.equal(reopened.snapshot().folders.length,1);
});

/* ---- 3. an imported `\\?\` cwd meets the existing folder -------------------------------------------------------------- */
test('folderForCwd matches a \\\\?\\ cwd, another drive-letter case and a subfolder to the existing folder',()=>{
  const folders=[{id:'a',path:'E:\\Development\\redis-automation',name:'redis-automation'},{id:'b',path:'E:\\Development\\redis-automation\\sub',name:'sub'},{id:'c',path:'E:\\Development\\redis-automation-old',name:'old'}];
  assert.equal(folderForCwd(folders,'\\\\?\\E:\\Development\\redis-automation')?.id,'a');
  assert.equal(folderForCwd(folders,'e:/development/REDIS-AUTOMATION/')?.id,'a');
  assert.equal(folderForCwd(folders,'\\\\?\\e:\\Development\\redis-automation\\sub\\deep')?.id,'b','the deepest folder wins');
  assert.equal(folderForCwd(folders,'\\\\?\\E:\\Development\\redis-automation-old\\x')?.id,'c');
  assert.equal(folderForCwd(folders,'E:\\Development\\unrelated'),undefined);
});
const rollout=(cwd:string,id:string,withTools:boolean)=>{
  const at=(second:number)=>new Date(Date.UTC(2026,8,20,10,0,second)).toISOString();
  const wrap=(type:string,payload:unknown,second:number)=>({timestamp:at(second),ordinal:second,type,payload});
  return [wrap('session_meta',{session_id:id,id,timestamp:at(0),cwd,originator:'codex_cli_rs',source:'cli',model_provider:'openai'},0),
    wrap('response_item',{type:'message',role:'user',content:[{type:'input_text',text:'Automate the redis failover drill'}]},1),
    ...(withTools?[wrap('response_item',{type:'function_call',name:'exec_command',arguments:JSON.stringify({cmd:'redis-cli ping'}),call_id:'c1'},2),wrap('response_item',{type:'function_call_output',call_id:'c1',output:'PONG'},3)]:[]),
    wrap('response_item',{type:'message',role:'assistant',content:[{type:'output_text',text:'I drafted the failover plan.'}],phase:'final_answer'},4)].map(row=>JSON.stringify(row)+'\n').join('');
};
const codexProvider=(inputs:ProviderInput[]=[]):ProviderAdapter=>({
  info:()=>[{id:'codex',driver:'codex-app-server',name:'Codex',available:true,identityMasked:'fixture',models:[{id:'gpt-6-codex',name:'GPT-6 Codex'}]}],
  run:async input=>{inputs.push(input);return {status:'completed',finalMessage:'ok'};},stop:async()=>true,dispose(){},
});
test('import.run maps a \\\\?\\ Codex cwd onto the existing folder instead of adding a fifth one',async t=>{
  const root=await directory(t),dataDir=join(root,'data'),codexHome=join(root,'codex');
  const cwd='\\\\?\\E:\\Development\\redis-automation',id='019a0000-0000-7000-8000-0000000003f9';
  await mkdir(join(codexHome,'sessions','2026','09','20'),{recursive:true});
  await writeFile(join(codexHome,'sessions','2026','09','20',`rollout-2026-09-20T10-00-00-${id}.jsonl`),rollout(cwd,id,true));
  const seed=new AgentStore(dataDir);const existing=seed.addFolder('e:/Development/redis-automation/','redis-automation');seed.close();
  const previous={codex:process.env.CODEX_HOME,xdg:process.env.XDG_DATA_HOME};process.env.CODEX_HOME=codexHome;process.env.XDG_DATA_HOME=join(root,'xdg');
  t.after(()=>{if(previous.codex===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous.codex;if(previous.xdg===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=previous.xdg;});
  const service=createAgentService({dataDir,provider:codexProvider(),onEvent(){}});t.after(()=>service.dispose());
  const call=<T>(command:string,input?:unknown)=>(service.invoke as unknown as (c:string,i:unknown)=>Promise<T>)(command,input);
  assert.equal(existing.path,'E:\\Development\\redis-automation');
  const page=await call<ImportListPage>('import.list',{source:'codex'});
  assert.equal(page.items[0]!.folderId,existing.id);
  const result=await call<ImportRunResult>('import.run',{ids:[`codex:${id}`],addFolders:true});
  assert.deepEqual(result.foldersAdded,[]);
  const snapshot=await service.invoke('app.snapshot',undefined);
  assert.equal(snapshot.folders.length,1);
  assert.equal(snapshot.chats.find(chat=>chat.id===result.chats[0]!.chatId)?.folderId,existing.id);
});

/* ---- 4. a router combo chat gets tools ---------------------------------------------------------------------------- */
const sse=(events:unknown[])=>new Response(new ReadableStream({start(c){for(const e of events)c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`));c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));c.close();}}),{status:200});
const toolCallStream=(name:string,args:object,id='call_1')=>sse([{choices:[{delta:{tool_calls:[{index:0,id,function:{name,arguments:JSON.stringify(args).slice(0,5)}}]}}]},{choices:[{delta:{tool_calls:[{index:0,function:{arguments:JSON.stringify(args).slice(5)}}]}}]},{choices:[],usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}}]);
function capture(extra:Partial<AdapterRunInput>={}){
  const log={events:[] as Array<[string,Record<string,unknown>]>,deltas:''};
  const input:AdapterRunInput={chat:{id:'chat',mode:'agent'} as AdapterRunInput['chat'],cwd:'/work',prompt:'run the failover drill',model:'intelligent-planner',permissionMode:'full',signal:new AbortController().signal,
    onThreadReady(){},onTurnAccepted(){},onDelta:text=>{log.deltas+=text;},onReasoning(){},onEvent:(method,params)=>log.events.push([method,params]),...extra};
  return {input,log};
}
test('an OmniRoute combo ("intelligent-planner") in a Full-access chat is offered tools and its shell call runs',async t=>{
  const cwd=await directory(t);
  const bodies:Array<Record<string,unknown>>=[];
  const catalog=createAdapterCatalog({env:{PATH:'',OMNIROUTE_PORT:'20128'},home:join(cwd,'home'),localProbes:true,customs:()=>[],codexEndpoints:()=>[],
    fetch:(async(url:string|URL|Request,init?:RequestInit)=>{
      const href=String(url);
      if(href.endsWith('/models'))return new Response(JSON.stringify({data:[{id:'intelligent-planner',owned_by:'combo'}]}));
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length===1?toolCallStream('run_command',{command:'echo failover-ok'}):sse([{choices:[{delta:{content:'Drill passed.'}}]}]);
    }) as typeof fetch});
  catalog.instances();await catalog.ready();
  const route=catalog.instances().find(instance=>instance.info.id==='local-omniroute');
  assert.ok(route?.adapter,'the local OmniRoute route is a runnable adapter');
  assert.match(route!.info.detail??'',/Shell and file tools/);
  assert.equal(route!.info.models[0]?.tools,undefined,'tool capable: not flagged');
  const {input,log}=capture({cwd});
  const result=await route!.adapter!.run(input);
  assert.equal(result.status,'completed');assert.equal(result.finalMessage,'Drill passed.');
  const names=(bodies[0]!.tools as Array<{function:{name:string}}>).map(tool=>tool.function.name);
  assert.deepEqual(names,['read_file','list_directory','write_file','edit_file','run_command']);
  assert.match(String((bodies[0]!.messages as Array<{content:string}>)[0]!.content),/You have these tools in this chat: .*run_command/);
  const followUp=(bodies[1]!.messages as Array<{role:string;content?:string;tool_calls?:unknown}>).slice(-2);
  assert.equal(followUp[0]!.role,'assistant');assert.ok(followUp[0]!.tool_calls);
  assert.equal(followUp[1]!.role,'tool');assert.match(followUp[1]!.content!,/failover-ok/);
  const completed=log.events.find(([method,params])=>method==='item/completed'&&(params.item as {type:string}).type==='commandExecution')![1].item as {command:string;exitCode:number;aggregatedOutput:string};
  assert.deepEqual([completed.command,completed.exitCode],['echo failover-ok',0]);
  const usage=log.events.find(([method])=>method==='thread/tokenUsage/updated')![1].tokenUsage as {last:{inputTokens:number}};
  assert.ok(usage.last.inputTokens>=0);
});
test('tools follow the access level: read-only has no writes or shell, workspace has no shell, and files stay inside the folder',async t=>{
  assert.deepEqual(toolSpecs('read-only').map(tool=>tool.function.name),['read_file','list_directory']);
  assert.deepEqual(toolSpecs('workspace').map(tool=>tool.function.name),['read_file','list_directory','write_file','edit_file']);
  const cwd=await directory(t),events:string[]=[];
  const ctx=(access:'read-only'|'workspace'|'full')=>({cwd,access,signal:new AbortController().signal,emit:(method:string)=>{events.push(method);},threadId:'t',turnId:'u'});
  const wrote=await executeTool({id:'1',name:'write_file',arguments:JSON.stringify({path:'notes/plan.md',content:'step 1'})},ctx('workspace'));
  assert.equal(wrote.ok,true);assert.equal(await readFile(join(cwd,'notes','plan.md'),'utf8'),'step 1');
  const edited=await executeTool({id:'2',name:'edit_file',arguments:JSON.stringify({path:'notes/plan.md',old_string:'step 1',new_string:'step 2'})},ctx('workspace'));
  assert.equal(edited.ok,true);assert.equal(await readFile(join(cwd,'notes','plan.md'),'utf8'),'step 2');
  const outside=await executeTool({id:'3',name:'write_file',arguments:JSON.stringify({path:join(cwd,'..','escape.txt'),content:'x'})},ctx('workspace'));
  assert.equal(outside.ok,false);assert.match(outside.content,/outside the working folder/);
  assert.equal(await stat(join(cwd,'..','escape.txt')).then(()=>true,()=>false),false);
  const shell=await executeTool({id:'4',name:'run_command',arguments:JSON.stringify({command:'echo hi'})},ctx('workspace'));
  assert.equal(shell.ok,false);assert.match(shell.content,/Full access/);
  const readOnlyWrite=await executeTool({id:'5',name:'write_file',arguments:JSON.stringify({path:'a.txt',content:'x'})},ctx('read-only'));
  assert.equal(readOnlyWrite.ok,false);
  const listed=await executeTool({id:'6',name:'list_directory',arguments:'{}'},ctx('read-only'));
  assert.match(listed.content,/notes\//);
});
test('a route that rejects tool definitions answers as plain chat, says so, and the model is flagged as tool-less',async t=>{
  const bodies:Array<Record<string,unknown>>=[];
  const endpoint='https://refuses.example/v1';
  const adapter=openAICompatibleAdapter({endpoint,apiKey:()=>'k',label:'Refuses',memory:new ConversationMemory(),
    fetch:(async(_url:string|URL|Request,init?:RequestInit)=>{const body=JSON.parse(String(init?.body));bodies.push(body);return body.tools?new Response(JSON.stringify({error:{message:'tools are not supported'}}),{status:400}):sse([{choices:[{delta:{content:'plain answer'}}]}]);}) as typeof fetch});
  const {input,log}=capture();
  const result=await adapter.run(input);
  assert.equal(result.status,'completed');assert.equal(result.finalMessage,'plain answer');
  assert.equal(bodies.length,2);assert.ok(bodies[0]!.tools);assert.equal(bodies[1]!.tools,undefined);
  assert.ok(log.events.some(([method])=>method===TOOLS_UNAVAILABLE_EVENT));
  assert.equal(refusedTools(endpoint,'intelligent-planner'),true);
  await adapter.run(capture().input);
  assert.equal(bodies.at(-1)!.tools,undefined,'the refusal is remembered; no failing request is repeated');
  assert.equal(bodies.length,3);
  void t;
});
test('the Anthropic API route is chat only and flagged per model so the composer can say so',()=>{
  const catalog=createAdapterCatalog({env:{PATH:'',ANTHROPIC_API_KEY:'sk-ant-x'},home:'/nonexistent',localProbes:false,customs:()=>[],codexEndpoints:()=>[],
    fetch:(async()=>new Response(JSON.stringify({data:[{id:'claude-x',display_name:'Claude X'}]}))) as typeof fetch});
  catalog.instances();
  return catalog.ready().then(()=>{
    const row=catalog.instances().find(instance=>instance.info.id==='env-anthropic')!;
    assert.deepEqual(row.info.models.map(model=>model.tools),[false]);
    assert.match(row.info.detail??'',/Chat only/);
  });
});

/* ---- 5. continuing a tool-less thread starts a tool-enabled session ------------------------------------------------ */
test('an imported thread with no tool use is not resumed; the first send starts a fresh session carrying the history',async t=>{
  const root=await directory(t),codexHome=join(root,'codex');
  const id='019a0000-0000-7000-8000-0000000003fa',toolId='019a0000-0000-7000-8000-0000000003fb';
  await mkdir(join(codexHome,'sessions','2026','09','20'),{recursive:true});
  await writeFile(join(codexHome,'sessions','2026','09','20',`rollout-2026-09-20T10-00-00-${id}.jsonl`),rollout(join(root,'p'),id,false));
  await writeFile(join(codexHome,'sessions','2026','09','20',`rollout-2026-09-20T11-00-00-${toolId}.jsonl`),rollout(join(root,'p'),toolId,true));
  const previous={codex:process.env.CODEX_HOME,xdg:process.env.XDG_DATA_HOME};process.env.CODEX_HOME=codexHome;process.env.XDG_DATA_HOME=join(root,'xdg');
  t.after(()=>{if(previous.codex===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous.codex;if(previous.xdg===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=previous.xdg;});
  const inputs:ProviderInput[]=[];
  const service=createAgentService({dataDir:join(root,'data'),provider:codexProvider(inputs),onEvent(){}});t.after(()=>service.dispose());
  const call=<T>(command:string,input?:unknown)=>(service.invoke as unknown as (c:string,i:unknown)=>Promise<T>)(command,input);
  const result=await call<ImportRunResult>('import.run',{ids:[`codex:${id}`,`codex:${toolId}`],continueInMuster:true});
  const byId=new Map(result.chats.map(chat=>[chat.id,chat]));
  assert.equal(byId.get(`codex:${id}`)!.continued,'digest');
  assert.equal(byId.get(`codex:${toolId}`)!.continued,'native','a thread that demonstrably ran tools still resumes natively');
  const toolless=byId.get(`codex:${id}`)!.chatId;
  const rows=(await service.invoke('chat.timeline',{id:toolless})).items;
  assert.ok(rows.some(row=>row.kind==='notice'&&row.data?.kind==='import-fresh-session'&&/fresh session with tools/.test(row.text)));
  const chat=(await service.invoke('app.snapshot',undefined)).chats.find(entry=>entry.id===toolless)!;
  assert.equal(chat.providerThreadId,undefined);
  await service.invoke('chat.send',{id:toolless,text:'continue the drill',requestId:'r1'});
  for(let i=0;i<500&&!inputs.length;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(inputs.length,1);
  assert.equal(inputs[0]!.chat.providerThreadId,undefined,'no provider thread is resumed');
  assert.match(inputs[0]!.prompt,/Automate the redis failover drill/,'the imported context rides along');
  assert.match(inputs[0]!.prompt,/continue the drill/);
});
test('a chat on a tool-less route moves to the same model on a route with tools, with a notice and the history',async t=>{
  const dataDir=await directory(t),inputs:ProviderInput[]=[];
  let chatOnly=false;
  const model=(tools?:false)=>({id:'intelligent-planner',name:'Intelligent planner',...(tools===false?{tools}:{})});
  const provider:ProviderAdapter={
    info:()=>[{id:'gateway-http',name:'Gateway (HTTP)',available:true,identityMasked:'fixture',models:[model(chatOnly?false:undefined)]},{id:'gateway-codex',name:'Gateway (Codex)',available:true,identityMasked:'fixture',models:[model()]}],
    run:async input=>{inputs.push(input);return {status:'completed',finalMessage:'done',threadId:`thread-${inputs.length}`,turnId:`turn-${inputs.length}`};},stop:async()=>true,dispose(){},
  };
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  const settle=async(count:number)=>{for(let i=0;i<500&&inputs.length<count;i++)await new Promise(resolve=>setImmediate(resolve));for(let i=0;i<200;i++)await new Promise(resolve=>setImmediate(resolve));};
  await service.invoke('chat.send',{id:chat.id,text:'first question about redis',requestId:'a'});await settle(1);
  assert.equal(inputs[0]!.chat.providerId,'gateway-http');
  chatOnly=true;
  await service.invoke('chat.send',{id:chat.id,text:'now run the drill',requestId:'b'});await settle(2);
  assert.equal(inputs[1]!.chat.providerId,'gateway-codex','moved to the route that has tools');
  assert.equal(inputs[1]!.chat.providerThreadId,undefined,'a fresh provider session');
  assert.match(inputs[1]!.prompt,/first question about redis/,'the earlier conversation is carried over');
  const notices=(await service.invoke('chat.timeline',{id:chat.id})).items.filter(item=>item.kind==='notice'&&item.data?.kind==='tools-session-restarted');
  assert.equal(notices.length,1);assert.match(notices[0]!.text,/can’t run commands or edit files on Gateway \(HTTP\).*Gateway \(Codex\).*has tools/);
});
test('with no tool-capable alternative the chat says it answers without tools',async t=>{
  const dataDir=await directory(t),inputs:ProviderInput[]=[];
  const provider:ProviderAdapter={info:()=>[{id:'only',name:'Only',available:true,identityMasked:'fixture',models:[{id:'m',name:'M',tools:false}]}],run:async input=>{inputs.push(input);return {status:'completed',finalMessage:'ok'};},stop:async()=>true,dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chat.id,text:'hello',requestId:'a'});
  for(let i=0;i<500&&!inputs.length;i++)await new Promise(resolve=>setImmediate(resolve));
  const notice=(await service.invoke('chat.timeline',{id:chat.id})).items.find(item=>item.data?.kind==='tools-unavailable');
  assert.match(notice?.text??'',/can’t run commands or edit files here, so this chat answers without tools/);
});

/* ---- 6. the composer capability notice ------------------------------------------------------------------------------ */
test('composer capability notice: a tool-less model is named, and a tool-capable one-click switch is offered',()=>{
  const providers=[
    {id:'anthropic',name:'Anthropic API',available:true,models:[{id:'claude-x',name:'Claude X',tools:false}]},
    {id:'codex',name:'Codex',available:true,models:[{id:'gpt-6',name:'GPT-6'},{id:'claude-x',name:'Claude X'}]},
    {id:'down',name:'Down',available:false,models:[{id:'claude-x',name:'Claude X'}]},
  ];
  assert.equal(TOOLS_BLIND_NOTICE,'This model can’t run commands or edit files');
  assert.equal(toolBlindModel(providers,'anthropic','claude-x'),'Claude X');
  assert.equal(toolBlindModel(providers,'codex','gpt-6'),null);
  assert.equal(toolBlindModel(providers,'anthropic',undefined),null);
  assert.deepEqual(toolCapableAlternative(providers,'anthropic','claude-x'),{providerId:'codex',model:'claude-x',name:'Claude X'},'the same model on a route with tools comes first');
  assert.deepEqual(toolCapableAlternative([providers[0]!,providers[1]!],'anthropic','nope'),{providerId:'codex',model:'gpt-6',name:'GPT-6'});
  assert.equal(toolCapableAlternative([providers[0]!],'anthropic','claude-x'),null);
});

/* ---- 7. Windows runner: a chat in a `\\?\` folder registers tools and its shell starts there ------------------------- */
test('Windows runner: a chat created in a \\\\?\\ folder gets tools, and the agent shell starts in that folder',{skip:process.platform!=='win32'&&'Windows only'},async t=>{
  const dir=await directory(t),extended='\\\\?\\'+dir;
  const requests:Array<Record<string,unknown>>=[];
  const adapter=openAICompatibleAdapter({endpoint:'https://router.example/v1',apiKey:()=>'k',label:'Router',memory:new ConversationMemory(),
    fetch:(async(_url:string|URL|Request,init?:RequestInit)=>{requests.push(JSON.parse(String(init?.body)));return requests.length===1?toolCallStream('run_command',{command:'(Get-Location).Path'}):sse([{choices:[{delta:{content:'ok'}}]}]);}) as typeof fetch});
  const events:Array<[string,Record<string,unknown>]>=[];
  const provider:ProviderAdapter={
    info:()=>[{id:'router',name:'Router',available:true,identityMasked:'fixture',models:[{id:'intelligent-planner',name:'Intelligent planner'}]}],
    run:async input=>{
      const result=await adapter.run({chat:input.chat,cwd:input.cwd,prompt:input.prompt,model:input.chat.model,permissionMode:'full',signal:new AbortController().signal,
        onThreadReady:id=>input.onThreadReady?.(id),onTurnAccepted:identity=>input.onTurnAccepted?.({...identity,dispatchState:'dispatched'}),onDelta:input.onDelta,onReasoning:input.onReasoning,onEvent:(method,params)=>{events.push([method,params]);input.onEvent(method,params);}});
      return {status:result.status,finalMessage:result.finalMessage,dispatchState:result.dispatchState,...(result.threadId?{threadId:result.threadId}:{}),...(result.turnId?{turnId:result.turnId}:{})};
    },stop:async()=>true,dispose(){},
  };
  const service=createAgentService({dataDir:join(dir,'data'),provider,onEvent(){}});t.after(()=>service.dispose());
  await mkdir(join(dir,'work'),{recursive:true});
  const folder=await service.invoke('folder.add',{path:'\\\\?\\'+join(dir,'work')});
  assert.ok(!folder.path.startsWith('\\\\?\\'),`stored without the extended prefix: ${folder.path}`);
  assert.equal((await service.invoke('folder.add',{path:join(dir,'work').toLowerCase()})).id,folder.id,'another spelling is the same folder');
  const chat=await service.invoke('chat.create',{folderId:folder.id});
  await service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'full',acknowledgeFullAccess:true});
  await service.invoke('chat.send',{id:chat.id,text:'where are you running?',requestId:'win-1'});
  for(let i=0;i<2000&&requests.length<2;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok((requests[0]!.tools as Array<{function:{name:string}}>).some(tool=>tool.function.name==='run_command'),'the shell tool is registered');
  const output=(requests[1]!.messages as Array<{role:string;content?:string}>).at(-1)!.content!;
  assert.match(output.toLowerCase(),/work/,`the shell ran inside the folder: ${output}`);
  assert.equal(extended.startsWith('\\\\?\\'),true);
});
