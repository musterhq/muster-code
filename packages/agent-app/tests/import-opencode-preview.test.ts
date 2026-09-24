/**
 * W6-E.b1/b2: the import preview (first few messages, redacted and clipped, read before importing) and the
 * OpenCode source (its JSON storage layout, built here as a fixture; never read from a real home).
 */
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,mkdir,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';
import {isCommandName} from '../src/main/commands.ts';
import {IMPORT_PREVIEW_CHARS,IMPORT_PREVIEW_MESSAGES,IMPORT_SOURCES,type ImportListPage,type ImportPreview,type ImportRunResult} from '../src/shared/domains/import-protocol.ts';
import {discoverOpenCodeSessions,openCodeDataDir,readOpenCodeSession,type ImportedEvent} from '../src/runtime/conversation-import.ts';

const SECRET='sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
const T0=Date.UTC(2026,8,22,9,0,0);
async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-opencode-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function json(path:string,value:unknown){await mkdir(join(path,'..'),{recursive:true});await writeFile(path,JSON.stringify(value));}

/** One OpenCode store: a titled session with tools, an untitled one, a child (subagent) session. */
async function openCodeStore(root:string,cwd:string){
  const data=join(root,'opencode'),storage=join(data,'storage');
  const session=(id:string,extra:Record<string,unknown>,updated:number)=>json(join(storage,'session','prj_1',`${id}.json`),{id,projectID:'prj_1',directory:cwd,version:'1.0.0',time:{created:T0,updated},...extra});
  const message=(sessionID:string,id:string,role:string,at:number,extra:Record<string,unknown>={})=>json(join(storage,'message',sessionID,`${id}.json`),{id,sessionID,role,time:{created:at},...extra});
  const part=(messageID:string,id:string,value:Record<string,unknown>)=>json(join(storage,'part',messageID,`${id}.json`),{id,messageID,...value});
  await session('ses_a',{title:'Refactor the parser'},T0+60_000);
  await message('ses_a','msg_01','user',T0+1000);
  await part('msg_01','prt_01',{type:'text',text:`Refactor parser.ts; my key is ${SECRET}`});
  await part('msg_01','prt_02',{type:'text',text:'<synthetic context>',synthetic:true});
  await part('msg_01','prt_03',{type:'file',filename:'notes.md',url:'file:///x/notes.md'});
  await message('ses_a','msg_02','assistant',T0+2000,{modelID:'claude-fable-5',providerID:'anthropic'});
  await part('msg_02','prt_01',{type:'step-start'});
  await part('msg_02','prt_02',{type:'reasoning',text:'Look at parser.ts first'});
  await part('msg_02','prt_03',{type:'tool',tool:'bash',callID:'call_1',state:{status:'completed',input:{command:'ls src',description:'List'},output:'parser.ts'}});
  await part('msg_02','prt_04',{type:'tool',tool:'edit',callID:'call_2',state:{status:'error',input:{filePath:'src/parser.ts',oldString:'a',newString:'b'},error:'no match'}});
  await part('msg_02','prt_05',{type:'text',text:'Done: parser refactored.'});
  for(let i=3;i<=12;i++){await message('ses_a',`msg_${String(i).padStart(2,'0')}`,i%2?'user':'assistant',T0+i*1000);await part(`msg_${String(i).padStart(2,'0')}`,'prt_01',{type:'text',text:`turn ${i} `+'x'.repeat(i===4?IMPORT_PREVIEW_CHARS*2:5)});}
  await session('ses_b',{title:'New session - 2026-09-22T09:00:00.000Z'},T0+30_000);
  await message('ses_b','msg_b1','user',T0+1000);
  await part('msg_b1','prt_01',{type:'text',text:'Why is CI red?'});
  await session('ses_child',{title:'Subagent run',parentID:'ses_a'},T0+90_000);
  return {data,storage};
}
async function collect(events:AsyncIterable<ImportedEvent>){const rows:ImportedEvent[]=[];for await(const event of events)rows.push(event);return rows;}

test('the preview command is allowlisted and OpenCode is an import source',()=>{
  assert.equal(isCommandName('import.preview'),true);
  assert.deepEqual([...IMPORT_SOURCES],['codex','claude-code','opencode','chatgpt']);
  assert.equal(openCodeDataDir({},'/home/me'),join('/home/me','.local','share','opencode'));
  assert.equal(openCodeDataDir({XDG_DATA_HOME:'/xdg'},'/home/me'),join('/xdg','opencode'));
});

test('OpenCode discovery lists top-level sessions, titles untitled ones from the first prompt, and skips child sessions',async t=>{
  const root=await directory(t),{data}=await openCodeStore(root,join(root,'project'));
  const sessions=(await discoverOpenCodeSessions(data)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  assert.deepEqual(sessions.map(session=>[session.sessionId,session.title]),[['ses_a','Refactor the parser'],['ses_b','Why is CI red?']]);
  assert.equal(sessions[0]!.cwd,join(root,'project'));
  assert.equal(sessions[0]!.updatedAt,new Date(T0+60_000).toISOString());
  assert.deepEqual(await discoverOpenCodeSessions(join(root,'missing')),[],'no store, no sessions');
});

test('an OpenCode session streams user text, reasoning, tools with results and replies; symlinks and outside paths are refused',async t=>{
  const root=await directory(t),{data,storage}=await openCodeStore(root,join(root,'project'));
  // A part file that is a symlink is never followed (it could point anywhere on disk).
  await writeFile(join(root,'outside.json'),JSON.stringify({id:'prt_99',type:'text',text:'LEAKED'}));
  await symlink(join(root,'outside.json'),join(storage,'part','msg_02','prt_99.json'));
  const events=await collect(readOpenCodeSession(join(storage,'session','prj_1','ses_a.json'),data));
  const meta=events.find(event=>event.type==='meta');
  assert.equal(meta?.type==='meta'&&meta.meta.cwd,join(root,'project'));
  const items=events.flatMap(event=>event.type==='item'?[event.item]:[]);
  assert.equal(items[0]!.kind,'user');
  assert.equal(items[0]!.text,`Refactor parser.ts; my key is ${SECRET}\n[file: notes.md]`,'synthetic parts are dropped, attachments named');
  assert.deepEqual(items.slice(1,5).map(item=>[item.kind,item.text]),[['reasoning','Look at parser.ts first'],['tool','ls src'],['tool','src/parser.ts'],['assistant','Done: parser refactored.']]);
  const results=events.flatMap(event=>event.type==='result'?[[event.ref,event.status,event.output]]:[]);
  assert.deepEqual(results,[['call_1','completed','parser.ts'],['call_2','failed','no match']]);
  assert.equal(items.some(item=>item.text.includes('LEAKED')),false);
  await assert.rejects(collect(readOpenCodeSession(join(root,'outside.json'),data)),/outside the OpenCode store/);
});

const provider=():ProviderAdapter=>({info:()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'m',name:'M'}]}],run:async()=>({status:'completed',finalMessage:'ok'}),stop:async()=>true,dispose(){}});
function useXdg(t:TestContext,path:string){const previous=process.env.XDG_DATA_HOME;process.env.XDG_DATA_HOME=path;t.after(()=>{if(previous===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=previous;});}

test('import.preview shows the first messages redacted and clipped without importing; OpenCode lists and imports',async t=>{
  const root=await directory(t);await mkdir(join(root,'project'),{recursive:true});
  await openCodeStore(root,join(root,'project'));useXdg(t,root);
  const service=createAgentService({dataDir:join(root,'data'),provider:provider(),onEvent(){}});
  t.after(()=>service.dispose());
  const call=<T>(command:string,input?:unknown)=>(service.invoke as unknown as (c:string,i:unknown)=>Promise<T>)(command,input);
  const sources=await call<{sources:Array<{id:string;available:boolean}>}>('import.sources');
  assert.equal(sources.sources.find(source=>source.id==='opencode')?.available,true);
  const page=await call<ImportListPage>('import.list',{source:'opencode'});
  assert.deepEqual(page.items.map(item=>item.id),['opencode:ses_a','opencode:ses_b']);

  const preview=await call<ImportPreview>('import.preview',{id:'opencode:ses_a'});
  assert.equal(preview.title,'Refactor the parser');
  assert.equal(preview.messages.length,IMPORT_PREVIEW_MESSAGES);
  assert.equal(preview.more,true);
  assert.deepEqual(preview.messages.slice(0,2).map(message=>message.role),['user','assistant']);
  assert.equal(preview.messages[0]!.text.includes(SECRET),false,'secrets are redacted in the preview');
  assert.equal(preview.redacted,1);
  const long=preview.messages.find(message=>message.text.startsWith('turn 4'))!;
  assert.ok(long.text.length<=IMPORT_PREVIEW_CHARS+32&&long.text.endsWith('[truncated]'),'long messages are clipped');
  const short=await call<ImportPreview>('import.preview',{id:'opencode:ses_b'});
  assert.deepEqual([short.messages.length,short.more],[1,false]);
  assert.equal((await service.invoke('app.snapshot',undefined)).chats.length,0,'a preview never imports');
  await assert.rejects(call('import.preview',{id:'opencode:nope'}),/no longer available/);
  await assert.rejects(call('import.preview',{id:'bogus'}),/Unknown conversation/);

  const result=await call<ImportRunResult>('import.run',{ids:['opencode:ses_a'],addFolders:false,continueInMuster:false});
  assert.deepEqual([result.created,result.failed.length],[1,0]);
  const timeline=(await service.invoke('chat.timeline',{id:result.chats[0]!.chatId})).items;
  assert.match(timeline[0]!.text,/^Imported from OpenCode/);
  assert.equal(timeline.some(item=>item.kind==='tool'&&item.status==='failed'),true,'tool results settle their rows');
  assert.equal(timeline.some(item=>item.text.includes(SECRET)),false);
});
