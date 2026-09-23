/**
 * CHAT-01 import conversations: fixture stores that replicate the real on-disk formats (built here,
 * never copied from a user's home), discovery, import mapping, idempotent re-import, redaction,
 * folder matching, "continue in Muster" and streaming of a large session.
 */
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,mkdir,realpath,rm,utimes,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateRawSync} from 'node:zlib';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter,ProviderInput} from '../src/runtime/provider.ts';
import {isCommandName} from '../src/main/commands.ts';
import {IMPORT_COMMANDS,importTitle,type ImportListPage,type ImportRunResult} from '../src/shared/domains/import-protocol.ts';
import type {TimelineItem} from '../src/shared/protocol.ts';
import {discoverClaudeSessions,discoverCodexSessions,fileLines,parseApplyPatch,readChatGptExport,readClaudeTranscript,readCodexRollout,readZipMember,stripInjectedContext,type ImportedEvent} from '../src/runtime/conversation-import.ts';
import {folderForCwd} from '../src/runtime/domains/import.ts';

const CODEX_ID='019a0000-0000-7000-8000-000000000001', LEGACY_ID='019a0000-0000-7000-8000-000000000002', ARCHIVED_ID='019a0000-0000-7000-8000-000000000003', SUBAGENT_ID='019a0000-0000-7000-8000-000000000004';
const CLAUDE_ID='5afe91ca-0000-4000-8000-000000000001', CLAUDE_ID_2='5afe91ca-0000-4000-8000-000000000002';
const SECRET='sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';

async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-import-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
const line=(value:unknown)=>JSON.stringify(value)+'\n';
async function writeLines(path:string,rows:unknown[],at?:Date){await mkdir(join(path,'..'),{recursive:true});await writeFile(path,rows.map(line).join(''));if(at)await utimes(path,at,at);}
function useEnv(t:TestContext,codexHome:string,claudeDir:string){
  const previous={codex:process.env.CODEX_HOME,claude:process.env.CLAUDE_CONFIG_DIR,xdg:process.env.XDG_DATA_HOME};
  // OpenCode reads $XDG_DATA_HOME/opencode: point it at an empty fixture folder, never the real home.
  process.env.CODEX_HOME=codexHome;process.env.CLAUDE_CONFIG_DIR=claudeDir;process.env.XDG_DATA_HOME=join(codexHome,'..','xdg-data');
  t.after(()=>{if(previous.codex===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous.codex;if(previous.claude===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=previous.claude;if(previous.xdg===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=previous.xdg;});
}
type Service=ReturnType<typeof createAgentService>;
const call=<T>(service:Service,command:string,input?:unknown)=>(service.invoke as unknown as (c:string,i:unknown)=>Promise<T>)(command,input);
const items=async(service:Service,chatId:string)=>(await service.invoke('chat.timeline',{id:chatId})).items;
const codexProvider=(inputs:ProviderInput[]=[]):ProviderAdapter=>({
  info:()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture'}]},{id:'codex',driver:'codex-app-server',name:'Codex',available:true,identityMasked:'fixture',models:[{id:'gpt-6',name:'GPT-6'}]}],
  run:async input=>{inputs.push(input);return {status:'completed',finalMessage:'ok'};},stop:async()=>true,dispose(){},
});

/** The Codex CLI rollout layout as of 2026-09: `{timestamp, ordinal, type, payload}` lines. */
function codexRollout(cwd:string,id:string):unknown[]{
  const at=(second:number)=>new Date(Date.UTC(2026,8,20,10,0,second)).toISOString();
  const wrap=(type:string,payload:unknown,second:number)=>({timestamp:at(second),ordinal:second,type,payload});
  return [
    wrap('session_meta',{session_id:id,id,timestamp:at(0),cwd,originator:'codex_cli_rs',cli_version:'0.128.0',source:'cli',model_provider:'openai',base_instructions:{text:'You are Codex.',provenance:{type:'model',model:'gpt-6-codex'}},history_mode:'sqlite'},0),
    wrap('response_item',{type:'message',role:'user',content:[{type:'input_text',text:'<environment_context>\n  <cwd>'+cwd+'</cwd>\n</environment_context>'}]},1),
    wrap('response_item',{type:'message',role:'developer',content:[{type:'input_text',text:'# AGENTS.md instructions'}]},1),
    wrap('turn_context',{turn_id:'t1',cwd,model:'gpt-6-codex',approval_policy:'never',sandbox_policy:{type:'workspace-write'}},2),
    wrap('response_item',{type:'message',role:'user',content:[{type:'input_text',text:'Fix the login bug in auth.ts'}]},2),
    wrap('event_msg',{type:'user_message',message:'Fix the login bug in auth.ts'},2),
    wrap('response_item',{type:'reasoning',summary:[{type:'summary_text',text:'**Looking at auth.ts**'}],content:null,encrypted_content:'ZZZ'},3),
    wrap('response_item',{type:'function_call',name:'exec_command',arguments:JSON.stringify({cmd:'ls -la src',workdir:cwd}),call_id:'call_1'},4),
    wrap('response_item',{type:'function_call_output',call_id:'call_1',output:JSON.stringify({output:'total 0\nauth.ts',metadata:{exit_code:0,duration_seconds:0.02}})},5),
    wrap('response_item',{type:'function_call',name:'exec_command',arguments:JSON.stringify({cmd:'npm test'}),call_id:'call_2'},6),
    wrap('response_item',{type:'function_call_output',call_id:'call_2',output:'Chunk ID: 1\nWall time: 1.0 seconds\nProcess exited with code 1\nOriginal token count: 4\nOutput:\n1 failing'},7),
    wrap('response_item',{type:'custom_tool_call',status:'completed',call_id:'call_3',name:'apply_patch',input:'*** Begin Patch\n*** Update File: src/auth.ts\n@@ export function login() {\n-  return false;\n+  return token.length > 0;\n*** Add File: src/auth.test.ts\n+test("login");\n+// GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n*** End Patch'},8),
    wrap('response_item',{type:'custom_tool_call_output',call_id:'call_3',output:'Success. Updated the following files:\nM src/auth.ts\nA src/auth.test.ts'},9),
    wrap('response_item',{type:'function_call',name:'list_prs',namespace:'github',arguments:'{"state":"open"}',call_id:'call_4'},10),
    wrap('response_item',{type:'function_call_output',call_id:'call_4',output:'[]'},11),
    wrap('response_item',{type:'web_search_call',status:'completed',action:{type:'search',query:'typescript login token'}},12),
    wrap('response_item',{type:'function_call',name:'exec_command',arguments:JSON.stringify({cmd:'sleep 100'}),call_id:'call_5'},13),
    wrap('event_msg',{type:'turn_aborted',turn_id:'t1',reason:'interrupted'},14),
    wrap('response_item',{type:'message',role:'assistant',content:[{type:'output_text',text:'Fixed the login check. Your key '+SECRET+' should be rotated.'}],phase:'final_answer'},15),
    wrap('event_msg',{type:'agent_message',message:'Fixed the login check.'},15),
    wrap('event_msg',{type:'token_count',info:null,rate_limits:{primary:null}},16),
  ];
}
/** The pre-session_meta layout: a flat header line, then bare response items and state records. */
function legacyRollout(cwd:string,id:string):unknown[]{
  return [
    {id,timestamp:'2026-01-05T09:00:00.000Z',instructions:'You are Codex.',git:{branch:'main'},cwd},
    {record_type:'state',approval_policy:'on-request'},
    {type:'message',role:'user',content:[{type:'input_text',text:'Legacy prompt about the parser'}]},
    {type:'message',role:'assistant',content:[{type:'output_text',text:'Legacy answer.'}]},
  ];
}
function claudeTranscript(cwd:string,sessionId:string):unknown[]{
  const at=(second:number)=>new Date(Date.UTC(2026,8,21,12,0,second)).toISOString();
  const base=(second:number,extra:Record<string,unknown>)=>({parentUuid:null,isSidechain:false,userType:'external',entrypoint:'cli',cwd,sessionId,version:'2.1.0',gitBranch:'main',uuid:`u-${second}`,timestamp:at(second),...extra});
  return [
    {type:'permission-mode',permissionMode:'default',sessionId},
    base(1,{type:'user',message:{role:'user',content:'Add retries to the fetch helper <system-reminder>hidden</system-reminder>'}}),
    base(2,{type:'assistant',message:{model:'claude-fable-5-1',id:'m1',type:'message',role:'assistant',content:[{type:'thinking',thinking:'Look at fetch.ts first.',signature:'sig'}]}}),
    base(3,{type:'assistant',message:{model:'claude-fable-5-1',id:'m1',type:'message',role:'assistant',content:[{type:'tool_use',id:'toolu_1',name:'Bash',input:{command:'grep -n fetch src/*.ts',description:'Find fetch helpers'}}]}}),
    base(4,{type:'user',message:{role:'user',content:[{tool_use_id:'toolu_1',type:'tool_result',content:'src/fetch.ts:3:export async function fetchJson()',is_error:false}]},toolUseResult:{stdout:'src/fetch.ts:3:export async function fetchJson()',stderr:'',interrupted:false}}),
    base(5,{type:'assistant',message:{model:'claude-fable-5-1',id:'m2',type:'message',role:'assistant',content:[{type:'tool_use',id:'toolu_2',name:'Edit',input:{file_path:cwd+'/src/fetch.ts',old_string:'return fetch(url);',new_string:'return retry(() => fetch(url));'}}]}}),
    base(6,{type:'user',message:{role:'user',content:[{tool_use_id:'toolu_2',type:'tool_result',content:'The file has been updated.'}]},toolUseResult:{filePath:cwd+'/src/fetch.ts'}}),
    base(7,{type:'user',isMeta:true,message:{role:'user',content:'<command-name>/clear</command-name>'}}),
    {...base(8,{type:'user',message:{role:'user',content:'sidechain prompt'}}),isSidechain:true},
    base(9,{type:'assistant',message:{model:'claude-fable-5-1',id:'m3',type:'message',role:'assistant',content:[{type:'text',text:'Added retries with backoff. Set API_KEY=abcd1234efgh5678 in .env to test.'}]}}),
    base(10,{type:'user',message:{role:'user',content:[{type:'text',text:'[Request interrupted by user]'}]}}),
    {type:'ai-title',aiTitle:'Fetch helper retries',sessionId},
  ];
}
/** A minimal zip (deflate, no zip64): enough for readZipMember to find conversations.json. */
function zipOf(entries:Array<{name:string;data:Buffer}>):Buffer{
  const locals:Buffer[]=[],central:Buffer[]=[];let offset=0;
  for(const entry of entries){
    const name=Buffer.from(entry.name,'utf8'),packed=deflateRawSync(entry.data);
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(8,8);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(entry.data.length,22);local.writeUInt16LE(name.length,26);
    const record=Buffer.alloc(46);record.writeUInt32LE(0x02014b50,0);record.writeUInt16LE(20,4);record.writeUInt16LE(20,6);record.writeUInt16LE(8,10);record.writeUInt32LE(packed.length,20);record.writeUInt32LE(entry.data.length,24);record.writeUInt16LE(name.length,28);record.writeUInt32LE(offset,42);
    locals.push(local,name,packed);central.push(record,name);offset+=local.length+name.length+packed.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,directory,end]);
}
function chatGptExport():unknown[]{
  const message=(id:string,role:string,text:string,at:number,parent:string|null,children:string[])=>[id,{id,parent,children,message:{id,author:{role},create_time:at,content:{content_type:'text',parts:[text]},metadata:{}}}] as const;
  const mapping=Object.fromEntries([
    ['root',{id:'root',parent:null,children:['sys'],message:null}],
    ['sys',{id:'sys',parent:'root',children:['u1'],message:{id:'sys',author:{role:'system'},content:{content_type:'text',parts:['']},metadata:{is_visually_hidden_from_conversation:true}}}],
    message('u1','user','What is a monad?',1_700_000_000,'sys',['a1','a2']),
    message('a1','assistant','Old branch answer.',1_700_000_010,'u1',[]),
    message('a2','assistant','A monad is a monoid in the category of endofunctors.',1_700_000_020,'u1',['u2']),
    message('u2','user','Show code',1_700_000_030,'a2',['a3']),
    ['a3',{id:'a3',parent:'u2',children:[],message:{id:'a3',author:{role:'assistant'},create_time:1_700_000_040,content:{content_type:'code',language:'haskell',text:'return :: a -> m a'},metadata:{}}}],
  ]);
  return [{id:'conv-1',conversation_id:'conv-1',title:'Monads',create_time:1_700_000_000,update_time:1_700_000_040,current_node:'a3',mapping},{id:'conv-2',title:'Empty one',create_time:1_600_000_000,update_time:1_600_000_000,current_node:'x',mapping:{x:{id:'x',parent:null,children:[],message:null}}}];
}

async function fixtures(t:TestContext){
  const root=await directory(t);
  const project=join(root,'project'), other=join(root,'other');await mkdir(project,{recursive:true});await mkdir(other,{recursive:true});
  const codexHome=join(root,'codex'), claudeDir=join(root,'claude');
  await writeLines(join(codexHome,'sessions','2026','09','20',`rollout-2026-09-20T10-00-00-${CODEX_ID}.jsonl`),codexRollout(project,CODEX_ID),new Date('2026-09-20T10:05:00Z'));
  await writeLines(join(codexHome,'sessions','2026','01','05',`rollout-2026-01-05T09-00-00-${LEGACY_ID}.jsonl`),legacyRollout(other,LEGACY_ID),new Date('2026-01-05T09:10:00Z'));
  await writeLines(join(codexHome,'archived_sessions',`rollout-2026-08-01T08-00-00-${ARCHIVED_ID}.jsonl`),[{timestamp:'2026-08-01T08:00:00.000Z',ordinal:0,type:'session_meta',payload:{id:ARCHIVED_ID,timestamp:'2026-08-01T08:00:00.000Z',cwd:join(root,'gone'),source:'vscode'}},{timestamp:'2026-08-01T08:00:01.000Z',ordinal:1,type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Archived question'}]}}],new Date('2026-08-01T08:10:00Z'));
  await writeLines(join(codexHome,'sessions','2026','09','19',`rollout-2026-09-19T10-00-00-${SUBAGENT_ID}.jsonl`),[{timestamp:'2026-09-19T10:00:00.000Z',ordinal:0,type:'session_meta',payload:{id:SUBAGENT_ID,timestamp:'2026-09-19T10:00:00.000Z',cwd:project,source:{subagent:'review'}}},{timestamp:'2026-09-19T10:00:01.000Z',ordinal:1,type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Review this'}]}}],new Date('2026-09-19T10:10:00Z'));
  await writeLines(join(codexHome,'session_index.jsonl'),[{id:CODEX_ID,thread_name:'Login fix',updated_at:'2026-09-20T10:05:00.000Z'}]);
  const slug='-'+project.replace(/[^A-Za-z0-9]/g,'-');
  await writeLines(join(claudeDir,'projects',slug,`${CLAUDE_ID}.jsonl`),claudeTranscript(project,CLAUDE_ID),new Date('2026-09-21T12:30:00Z'));
  await writeLines(join(claudeDir,'projects',slug,CLAUDE_ID,'subagents','agent-1.jsonl'),[{type:'user',isSidechain:true,message:{role:'user',content:'nested'}}]);
  await writeLines(join(claudeDir,'projects','-Users-someone-else',`${CLAUDE_ID_2}.jsonl`),[{type:'user',isSidechain:false,cwd:join(root,'elsewhere'),sessionId:CLAUDE_ID_2,timestamp:'2026-07-01T00:00:00.000Z',message:{role:'user',content:'Older question'}},{type:'summary',summary:'Older summary',leafUuid:'x'}],new Date('2026-07-01T00:05:00Z'));
  const exportZip=join(root,'chatgpt-export.zip');
  await writeFile(exportZip,zipOf([{name:'user.json',data:Buffer.from('{}')},{name:'conversations.json',data:Buffer.from(JSON.stringify(chatGptExport()))}]));
  return {root,project,other,codexHome,claudeDir,exportZip};
}

test('import commands are allowlisted for the renderer',()=>{
  for(const command of Object.keys(IMPORT_COMMANDS))assert.equal(isCommandName(command),true,command);
  assert.equal(importTitle('  Fix   the\nlogin bug ','x'),'Fix the login bug');
  assert.equal(importTitle('','Codex session'),'Codex session');
});

test('parseApplyPatch maps adds, updates and moves to app-server style changes',()=>{
  const changes=parseApplyPatch('*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@ ctx\n-old\n+new\n*** Add File: c.ts\n+line1\n+line2\n*** Delete File: d.ts\n*** End Patch');
  assert.deepEqual(changes,[{path:'a.ts',kind:{type:'update',move_path:'b.ts'},diff:'-old\n+new'},{path:'c.ts',kind:{type:'add'},diff:'line1\nline2'},{path:'d.ts',kind:{type:'delete'},diff:''}]);
});

test('folderForCwd picks the deepest sidebar folder containing the session cwd',()=>{
  const folders=[{id:'a',path:'/Users/me/code',name:'code'},{id:'b',path:'/Users/me/code/app',name:'app'},{id:'c',path:'/Users/me/codex',name:'codex'}];
  assert.equal(folderForCwd(folders,'/Users/me/code/app/src')?.id,'b');
  assert.equal(folderForCwd(folders,'/Users/me/code')?.id,'a');
  assert.equal(folderForCwd(folders,'/Users/me/codex-two'),undefined);
  assert.equal(folderForCwd(folders,undefined),undefined);
});

test('readCodexRollout streams the current and the legacy layout into normalized events',async t=>{
  const f=await fixtures(t);
  const events:ImportedEvent[]=[];
  for await(const event of readCodexRollout(join(f.codexHome,'sessions','2026','09','20',`rollout-2026-09-20T10-00-00-${CODEX_ID}.jsonl`)))events.push(event);
  const meta=events.find(event=>event.type==='meta');
  assert.equal(meta?.type,'meta');assert.equal(meta!.meta.cwd,f.project);assert.equal(meta!.meta.sessionId,CODEX_ID);assert.equal(meta!.meta.model,'gpt-6-codex');
  const rows=events.filter((event):event is Extract<ImportedEvent,{type:'item'}>=>event.type==='item').map(event=>event.item);
  assert.deepEqual(rows.filter(item=>item.kind==='user').map(item=>item.text),['Fix the login bug in auth.ts'],'injected context and event_msg duplicates are not prompts');
  assert.equal(rows.find(item=>item.kind==='reasoning')?.text,'**Looking at auth.ts**');
  const tools=rows.filter(item=>item.kind==='tool');
  assert.deepEqual(tools.map(item=>[item.data?.type,item.ref]),[['commandExecution','call_1'],['commandExecution','call_2'],['fileChange','call_3'],['mcpToolCall','call_4'],['webSearch',undefined],['commandExecution','call_5']]);
  assert.equal(tools[0]!.data?.command,'ls -la src');assert.equal(tools[0]!.data?.cwd,f.project);
  assert.deepEqual((tools[2]!.data?.changes as Array<{path:string;kind:{type:string}}>).map(change=>[change.path,change.kind.type]),[['src/auth.ts','update'],['src/auth.test.ts','add']]);
  assert.deepEqual([tools[3]!.data?.server,tools[3]!.data?.tool],['github','list_prs']);
  const results=events.filter((event):event is Extract<ImportedEvent,{type:'result'}>=>event.type==='result');
  assert.deepEqual(results.map(result=>[result.ref,result.status,result.data?.exitCode]),[['call_1','completed',0],['call_2','failed',1],['call_3','completed',undefined],['call_4','completed',undefined]]);
  assert.equal(results[1]!.output,'1 failing','the exit-code header is stripped from exec_command output');
  assert.ok(rows.some(item=>item.kind==='notice'&&item.data?.kind==='interrupted'));
  assert.equal(rows.at(-1)?.kind,'assistant');

  const legacy:ImportedEvent[]=[];
  for await(const event of readCodexRollout(join(f.codexHome,'sessions','2026','01','05',`rollout-2026-01-05T09-00-00-${LEGACY_ID}.jsonl`)))legacy.push(event);
  assert.equal(legacy[0]?.type,'meta');assert.equal((legacy[0] as {meta:{sessionId?:string}}).meta.sessionId,LEGACY_ID);
  assert.deepEqual(legacy.slice(1).map(event=>event.type==='item'?[event.item.kind,event.item.text]:event.type),[['user','Legacy prompt about the parser'],['assistant','Legacy answer.']]);
});

test('discovery lists Codex and Claude sessions newest first, skipping subagent and nested transcripts',async t=>{
  const f=await fixtures(t);
  const codex=await discoverCodexSessions(f.codexHome);
  assert.deepEqual(codex.map(session=>[session.sessionId,session.title,session.cwd,session.archived??false]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))),[
    [CODEX_ID,'Login fix',f.project,false],[LEGACY_ID,'Legacy prompt about the parser',f.other,false],[ARCHIVED_ID,'Archived question',join(f.root,'gone'),true],
  ]);
  const claude=await discoverClaudeSessions(f.claudeDir);
  assert.deepEqual(claude.map(session=>[session.sessionId,session.title,session.cwd]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))),[[CLAUDE_ID,'Fetch helper retries',f.project],[CLAUDE_ID_2,'Older summary',join(f.root,'elsewhere')]]);
});

test('import.list pages newest first with search, folder matching and imported markers; import.run creates, maps and redacts',async t=>{
  const f=await fixtures(t);useEnv(t,f.codexHome,f.claudeDir);
  const inputs:ProviderInput[]=[];
  const progress:Array<{done:number;total:number}>=[];
  const service=createAgentService({dataDir:join(f.root,'data'),provider:codexProvider(inputs),onEvent(event){if(event.type==='importProgress')progress.push({done:event.done,total:event.total});}});
  t.after(()=>service.dispose());
  const sources=await call<{sources:Array<{id:string;available:boolean;location?:string}>}>(service,'import.sources');
  assert.deepEqual(sources.sources.map(source=>[source.id,source.available]),[['codex',true],['claude-code',true],['opencode',false],['chatgpt',true]]);
  assert.equal(sources.sources[0]!.location,join(f.codexHome,'sessions'));

  const page=await call<ImportListPage>(service,'import.list',{source:'codex'});
  assert.deepEqual(page.items.map(item=>item.sessionId),[CODEX_ID,ARCHIVED_ID,LEGACY_ID],'newest first');
  assert.equal(page.total,3);assert.equal(page.items[0]!.messageCount,null,'counted on import');assert.equal(page.items[0]!.folderId,undefined);
  const paged=await call<ImportListPage>(service,'import.list',{source:'codex',offset:1,limit:1});
  assert.deepEqual([paged.items.map(item=>item.sessionId),paged.total,paged.offset,paged.limit],[[ARCHIVED_ID],3,1,1]);
  const searched=await call<ImportListPage>(service,'import.list',{source:'codex',query:'parser'});
  assert.deepEqual(searched.items.map(item=>item.sessionId),[LEGACY_ID]);
  await assert.rejects(call(service,'import.list',{source:'nope'}),/Choose a source/);

  const result=await call<ImportRunResult>(service,'import.run',{ids:[`codex:${CODEX_ID}`,`codex:${ARCHIVED_ID}`,'codex:missing'],addFolders:true,continueInMuster:false});
  assert.deepEqual([result.created,result.updated,result.failed.map(failure=>failure.id)],[2,0,['codex:missing']]);
  assert.deepEqual(result.foldersAdded,[await realpath(f.project)],'a cwd that exists becomes a sidebar folder; a missing one is left alone');
  assert.ok(result.redacted>=2,'the API key in the answer and the token in the patch are masked');
  const snapshot=await service.invoke('app.snapshot',undefined);
  const imported=snapshot.chats.find(entry=>entry.id===result.chats[0]!.chatId)!;
  assert.equal(imported.title,'Login fix');assert.equal(imported.titleSource,'generated');
  assert.equal(imported.folderId,snapshot.folders.find(folder=>folder.path===result.foldersAdded[0])?.id);
  assert.equal(imported.updatedAt,'2026-09-20T10:05:00.000Z','sidebar recency follows the session');
  assert.equal(imported.providerThreadId,undefined);
  const archived=snapshot.chats.find(entry=>entry.id===result.chats[1]!.chatId)!;
  assert.equal(archived.folderId,undefined);
  const rows=await items(service,imported.id);
  assert.equal(rows[0]!.kind,'notice');assert.equal(rows[0]!.data?.kind,'imported');assert.equal(rows[0]!.data?.source,'codex');assert.equal(rows[0]!.data?.sessionId,CODEX_ID);assert.match(rows[0]!.text,/^Imported from Codex · 2 messages · originally in /);
  assert.deepEqual(rows.map(row=>row.kind),['notice','user','reasoning','tool','tool','tool','tool','tool','tool','notice','assistant']);
  const [ls,test1,patch,mcp,search,sleep]=rows.filter(row=>row.kind==='tool');
  assert.deepEqual([ls!.status,ls!.data?.output,ls!.data?.exitCode,ls!.text],['completed','total 0\nauth.ts',0,'ls -la src\ntotal 0\nauth.ts']);
  assert.deepEqual([test1!.status,test1!.data?.exitCode],['failed',1]);
  assert.equal(patch!.data?.type,'fileChange');assert.match(JSON.stringify(patch!.data?.changes),/GITHUB_TOKEN=(?:\*\*\*|\[redacted\])/,'the token inside the patch is masked by the shared redactor');assert.doesNotMatch(JSON.stringify(patch!.data),/ghp_abcdefghijklmnopqrstuvwxyz/);
  assert.equal(mcp!.data?.type,'mcpToolCall');assert.equal(search!.data?.type,'webSearch');
  assert.equal(sleep!.status,'interrupted','a call that never got a result settles');
  const answer=rows.at(-1)!;
  assert.doesNotMatch(answer.text,new RegExp(SECRET));assert.match(answer.text,/\[redacted\]/);
  assert.equal(answer.createdAt,'2026-09-20T10:00:15.000Z','original timestamps are kept');
  assert.ok(progress.length>=3&&progress.at(-1)!.done===3);

  // Listing again marks the imported sessions and their folder.
  const relisted=await call<ImportListPage>(service,'import.list',{source:'codex',refresh:true});
  assert.equal(relisted.items[0]!.importedChatId,imported.id);assert.equal(relisted.items[0]!.messageCount,2);assert.equal(relisted.items[0]!.folderId,imported.folderId);

  // Re-import updates the same chat: same id, no duplicated rows; a user rename survives.
  await service.invoke('chat.update',{id:imported.id,title:'My login chat'});
  const again=await call<ImportRunResult>(service,'import.run',{ids:[`codex:${CODEX_ID}`]});
  assert.deepEqual([again.created,again.updated,again.chats[0]!.chatId],[0,1,imported.id]);
  const after=await items(service,imported.id);
  assert.equal(after.length,rows.length);assert.equal((await service.invoke('app.snapshot',undefined)).chats.find(entry=>entry.id===imported.id)!.title,'My login chat');
  assert.equal((await service.invoke('app.snapshot',undefined)).chats.filter(entry=>entry.title==='Login fix'||entry.title==='My login chat').length,1);

  // Without a native thread the first send seeds a digest of the imported history.
  await service.invoke('chat.send',{id:imported.id,text:'What did we change?',requestId:'r1'});
  for(let i=0;i<500&&!inputs.length;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(inputs.length,1);
  assert.match(inputs[0]!.prompt,/<earlier-conversation>[\s\S]*Fix the login bug in auth\.ts[\s\S]*<\/earlier-conversation>/);
  assert.doesNotMatch(inputs[0]!.prompt,new RegExp(SECRET));
});

test('Claude Code transcripts import with tool rows, patches, reasoning and the stored title',async t=>{
  const f=await fixtures(t);useEnv(t,f.codexHome,f.claudeDir);
  const service=createAgentService({dataDir:join(f.root,'data'),provider:codexProvider(),onEvent(){}});
  t.after(()=>service.dispose());
  const folder=await service.invoke('folder.add',{path:f.project});
  const page=await call<ImportListPage>(service,'import.list',{source:'claude-code'});
  assert.deepEqual(page.items.map(item=>[item.sessionId,item.title,item.folderId]),[[CLAUDE_ID,'Fetch helper retries',folder.id],[CLAUDE_ID_2,'Older summary',undefined]]);
  const result=await call<ImportRunResult>(service,'import.run',{ids:[`claude-code:${CLAUDE_ID}`]});
  assert.equal(result.created,1);assert.deepEqual(result.foldersAdded,[]);
  const chat=(await service.invoke('app.snapshot',undefined)).chats.find(entry=>entry.id===result.chats[0]!.chatId)!;
  assert.equal(chat.title,'Fetch helper retries');assert.equal(chat.folderId,folder.id);
  const rows=await items(service,chat.id);
  assert.deepEqual(rows.map(row=>row.kind),['notice','user','reasoning','tool','tool','assistant','notice']);
  assert.equal(rows[1]!.text,'Add retries to the fetch helper','system reminders are stripped');
  assert.equal(rows[2]!.text,'Look at fetch.ts first.');
  const [grep,edit]=rows.filter(row=>row.kind==='tool');
  assert.deepEqual([grep!.data?.type,grep!.data?.command,grep!.status,grep!.data?.output],['commandExecution','grep -n fetch src/*.ts','completed','src/fetch.ts:3:export async function fetchJson()']);
  assert.deepEqual(edit!.data?.changes,[{path:f.project+'/src/fetch.ts',kind:{type:'update'},oldContent:'return fetch(url);',newContent:'return retry(() => fetch(url));'}]);
  assert.equal(edit!.status,'completed');
  assert.match(rows[5]!.text,/API_KEY=\[redacted\]/);
  assert.equal(rows[6]!.data?.kind,'interrupted');
  assert.equal(rows.filter(row=>row.text.includes('sidechain')||row.text.includes('/clear')).length,0);
});

test('a ChatGPT export lists from a chosen zip and imports the active branch',async t=>{
  const f=await fixtures(t);useEnv(t,f.codexHome,f.claudeDir);
  assert.ok(readZipMember(f.exportZip,name=>name==='conversations.json'));
  assert.equal(readZipMember(f.exportZip,name=>name==='nope.json'),undefined);
  const conversations=await readChatGptExport(f.exportZip);
  assert.deepEqual(conversations.map(conversation=>[conversation.id,conversation.messages.length]),[['conv-1',4],['conv-2',0]]);
  const service=createAgentService({dataDir:join(f.root,'data'),provider:codexProvider(),onEvent(){}});
  t.after(()=>service.dispose());
  await assert.rejects(call(service,'import.list',{source:'chatgpt'}),/Choose a ChatGPT export/);
  await assert.rejects(call(service,'import.list',{source:'chatgpt',path:join(f.root,'missing.zip')}),/no longer there/);
  const page=await call<ImportListPage>(service,'import.list',{source:'chatgpt',path:f.exportZip});
  assert.deepEqual(page.items.map(item=>[item.sessionId,item.title,item.messageCount,item.cwd]),[['conv-1','Monads',4,undefined],['conv-2','Empty one',0,undefined]]);
  assert.equal((await call<{path:string|null}>(service,'import.pickExport')).path,null,'no Electron dialog outside the app');
  const result=await call<ImportRunResult>(service,'import.run',{ids:['chatgpt:conv-1'],path:f.exportZip});
  assert.equal(result.created,1);
  const rows=await items(service,result.chats[0]!.chatId);
  assert.deepEqual(rows.map(row=>[row.kind,row.text.slice(0,20)]),[['notice','Imported from ChatGP'],['user','What is a monad?'],['assistant','A monad is a monoid '],['user','Show code'],['assistant','```haskell\nreturn ::']]);
  assert.equal(rows[1]!.createdAt,new Date(1_700_000_000*1000).toISOString());
  const chat=(await service.invoke('app.snapshot',undefined)).chats.find(entry=>entry.id===result.chats[0]!.chatId)!;
  assert.equal(chat.folderId,undefined);assert.equal(chat.title,'Monads');
});

test('Continue in Muster resumes the Codex thread natively when a Codex provider is signed in',async t=>{
  const f=await fixtures(t);useEnv(t,f.codexHome,f.claudeDir);
  const service=createAgentService({dataDir:join(f.root,'data'),provider:codexProvider(),onEvent(){}});
  t.after(()=>service.dispose());
  const result=await call<ImportRunResult>(service,'import.run',{ids:[`codex:${CODEX_ID}`,`codex:${LEGACY_ID}`],continueInMuster:true});
  assert.deepEqual(result.chats.map(chat=>chat.continued),['native','native']);
  const chat=(await service.invoke('app.snapshot',undefined)).chats.find(entry=>entry.id===result.chats[0]!.chatId)!;
  assert.deepEqual([chat.providerId,chat.providerBindingId,chat.providerThreadId,chat.providerThreadProviderId,chat.providerThreadBindingId],['codex','codex',CODEX_ID,'codex','codex']);
  assert.equal(chat.model,'claude/claude-fable-5','the session model is not in the provider catalog, so the default stays');
  // The same session imported again without continuation drops the thread binding and falls back to the digest.
  const again=await call<ImportRunResult>(service,'import.run',{ids:[`codex:${CODEX_ID}`],continueInMuster:false});
  assert.equal(again.chats[0]!.continued,'digest');
  assert.equal((await service.invoke('app.snapshot',undefined)).chats.find(entry=>entry.id===chat.id)!.providerThreadId,undefined);
});

test('a large session streams in bounded batches without holding it in memory',async t=>{
  const f=await fixtures(t);useEnv(t,f.codexHome,f.claudeDir);
  const big='019a0000-0000-7000-8000-00000000beef';
  const rows:string[]=[];
  rows.push(JSON.stringify({timestamp:'2026-09-22T00:00:00.000Z',ordinal:0,type:'session_meta',payload:{id:big,timestamp:'2026-09-22T00:00:00.000Z',cwd:f.project,source:'cli'}}));
  for(let i=0;i<3000;i++){
    rows.push(JSON.stringify({timestamp:'2026-09-22T00:00:01.000Z',ordinal:i*2+1,type:'response_item',payload:{type:'message',role:i%2?'assistant':'user',content:[{type:i%2?'output_text':'input_text',text:`message ${i} `.repeat(40)}]}}));
    rows.push(JSON.stringify({timestamp:'2026-09-22T00:00:02.000Z',ordinal:i*2+2,type:'response_item',payload:{type:'function_call',name:'exec_command',arguments:JSON.stringify({cmd:`echo ${i}`}),call_id:`c${i}`}}));
    rows.push(JSON.stringify({timestamp:'2026-09-22T00:00:03.000Z',ordinal:i*2+3,type:'response_item',payload:{type:'function_call_output',call_id:`c${i}`,output:JSON.stringify({output:'x'.repeat(40_000),metadata:{exit_code:0}})}}));
  }
  const path=join(f.codexHome,'sessions','2026','09','22',`rollout-2026-09-22T00-00-00-${big}.jsonl`);
  await mkdir(join(path,'..'),{recursive:true});await writeFile(path,rows.join('\n')+'\n');
  const service=createAgentService({dataDir:join(f.root,'data'),provider:codexProvider(),onEvent(){}});
  t.after(()=>service.dispose());
  const result=await call<ImportRunResult>(service,'import.run',{ids:[`codex:${big}`]});
  assert.equal(result.created,1);assert.equal(result.chats[0]!.messageCount,3000);
  const timeline=await items(service,result.chats[0]!.chatId);
  assert.equal(timeline.length,1+6000);
  const tool=timeline.find((row:TimelineItem)=>row.kind==='tool')!;
  assert.equal(tool.data?.outputTruncated,true);assert.ok((tool.data?.output as string).length<20_000,'tool output is clipped');
});

test('stripInjectedContext keeps what the user typed and drops host-injected lead-ins',()=>{
  assert.equal(stripInjectedContext('<recommended_plugins>\nHere is a list of plugins…\n</recommended_plugins>\n\nWrite two paragraphs about tides'),'Write two paragraphs about tides');
  assert.equal(stripInjectedContext('<apps_instructions>use apps</apps_instructions><environment_context><cwd>/x</cwd></environment_context>\nReal ask'),'Real ask');
  assert.equal(stripInjectedContext('<permissions instructions>\nsandbox\n</permissions instructions>\nDo it'),'Do it');
  assert.equal(stripInjectedContext('<skills_instructions>a</skills_instructions>\n<user_instructions>b</user_instructions>'),'','nothing typed: empty');
  assert.equal(stripInjectedContext('# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nbe nice\n</INSTRUCTIONS>'),'');
  assert.equal(stripInjectedContext('# AGENTS.md instructions for /repo\nuntagged body'),'','an untagged AGENTS.md preamble is the whole message');
  assert.equal(stripInjectedContext('Project: Muster\nRecalled notes: x\n\nCurrent user request:\nFix the build\n\nFiles: a.ts'),'Fix the build\n\nFiles: a.ts','Muster\'s own preamble');
  assert.equal(stripInjectedContext('<system-reminder>hidden</system-reminder>Add retries'),'Add retries');
  assert.equal(stripInjectedContext('<environment_context>never closes'),'','an unterminated injected block runs to the end');
  // The user's own markup is kept as typed.
  assert.equal(stripInjectedContext('<div>center this</div> please'),'<div>center this</div> please');
  assert.equal(stripInjectedContext('<context>my notes</context>\nsummarize'),'<context>my notes</context>\nsummarize');
  assert.equal(stripInjectedContext('plain prompt'),'plain prompt');
});

test('injected lead-ins never become an imported title or user message (Codex and Claude Code)',async t=>{
  const root=await directory(t);
  const id='019a0000-0000-7000-8000-00000000c0de';
  const codexHome=join(root,'codex'), path=join(codexHome,'sessions','2026','09','23',`rollout-2026-09-23T10-00-00-${id}.jsonl`);
  await writeLines(path,[
    {timestamp:'2026-09-23T10:00:00.000Z',type:'session_meta',payload:{id,timestamp:'2026-09-23T10:00:00.000Z',cwd:root,originator:'muster',source:'vscode'}},
    {timestamp:'2026-09-23T10:00:01.000Z',type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'<recommended_plugins>\nHere is a list of plugins you can install\n</recommended_plugins>'}]}},
    {timestamp:'2026-09-23T10:00:02.000Z',type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'<environment_context>x</environment_context>\n\nWrite two paragraphs about tides'}]}},
  ]);
  const [session]=await discoverCodexSessions(codexHome);
  assert.equal(session!.title,'Write two paragraphs about tides');
  assert.equal(session!.originator,'muster');
  const users:string[]=[];
  for await(const event of readCodexRollout(path))if(event.type==='item'&&event.item.kind==='user')users.push(event.item.text);
  assert.deepEqual(users,['Write two paragraphs about tides']);

  const transcript=join(root,'claude.jsonl');
  await writeLines(transcript,[{type:'user',sessionId:'s',cwd:root,timestamp:'2026-09-23T10:00:00.000Z',message:{role:'user',content:'<command-message>init</command-message>\n<command-name>/init</command-name>'}},{type:'user',sessionId:'s',cwd:root,timestamp:'2026-09-23T10:00:01.000Z',message:{role:'user',content:'Context packet\n\nCurrent user request:\nRename the helper'}}]);
  const claudeUsers:string[]=[];
  for await(const event of readClaudeTranscript(transcript))if(event.type==='item'&&event.item.kind==='user')claudeUsers.push(event.item.text);
  assert.deepEqual(claudeUsers,['Rename the helper']);
});

test('a session Muster itself runs is listed as already in Muster and is never imported again',async t=>{
  const f=await fixtures(t);useEnv(t,f.codexHome,f.claudeDir);
  const provider:ProviderAdapter={...codexProvider(),run:async input=>{input.onThreadReady?.(CODEX_ID);return {status:'completed',finalMessage:'ok'};}};
  const service=createAgentService({dataDir:join(f.root,'data'),provider,onEvent(){}});
  t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chat.id,text:'Write two paragraphs',requestId:'own-1'});
  for(let i=0;i<500&&(await service.invoke('app.snapshot',undefined)).chats.find(entry=>entry.id===chat.id)?.providerThreadId!==CODEX_ID;i++)await new Promise(resolve=>setImmediate(resolve));
  const page=await call<ImportListPage>(service,'import.list',{source:'codex',refresh:true});
  const own=page.items.find(item=>item.sessionId===CODEX_ID)!;
  assert.equal(own.musterChatId,chat.id);
  assert.equal(page.items.find(item=>item.sessionId===LEGACY_ID)!.musterChatId,undefined);
  const result=await call<ImportRunResult>(service,'import.run',{ids:[`codex:${CODEX_ID}`]});
  assert.deepEqual([result.created,result.failed.map(failure=>failure.error)],[0,['This conversation is already a Muster chat.']]);
  assert.equal((await service.invoke('app.snapshot',undefined)).chats.length,1,'no duplicate chat');
});

test('re-importing a chat the user continued in Muster is refused instead of deleting the new turns',async t=>{
  const f=await fixtures(t);useEnv(t,f.codexHome,f.claudeDir);
  const service=createAgentService({dataDir:join(f.root,'data'),provider:codexProvider(),onEvent(){}});
  t.after(()=>service.dispose());
  const first=await call<ImportRunResult>(service,'import.run',{ids:[`codex:${CODEX_ID}`],continueInMuster:false});
  const chatId=first.chats[0]!.chatId;
  await service.invoke('chat.send',{id:chatId,text:'Keep going',requestId:'cont-1'});
  for(let i=0;i<500&&!(await items(service,chatId)).some(row=>row.kind==='assistant'&&row.text==='ok');i++)await new Promise(resolve=>setImmediate(resolve));
  const before=(await items(service,chatId)).length;
  const again=await call<ImportRunResult>(service,'import.run',{ids:[`codex:${CODEX_ID}`]});
  assert.equal(again.updated,0);assert.match(again.failed[0]!.error,/continued in Muster/);
  assert.equal((await items(service,chatId)).length,before,'the continued turns are still there');
});

test('transcript lines longer than the cap are skipped without being buffered whole',async t=>{
  const root=await directory(t), path=join(root,'lines.jsonl');
  await writeFile(path,`short\n${'x'.repeat(5000)}\nafter\r\n${'y'.repeat(3000)}`);
  const lines:string[]=[];
  for await(const value of fileLines(path,undefined,1000))lines.push(value);
  assert.deepEqual(lines,['short','after'],'the long lines (middle and last) are dropped, CRLF is trimmed');
  const all:string[]=[];
  for await(const value of fileLines(path))all.push(value.length>10?`len:${value.length}`:value);
  assert.deepEqual(all,['short','len:5000','after','len:3000']);
});
