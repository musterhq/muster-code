/** Security review of PR #320: one test per finding (H1-H5, M1-M6). */
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,mkdir,readFile,rm,stat,symlink,writeFile,link} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {executeTool,shellInvocation,MAX_TIMELINE_OUTPUT,type ToolContext} from '../src/runtime/adapters/http-tools.ts';
import {agentCommandEnvironment} from '../src/runtime/command-environment.ts';
import {openAICompatibleAdapter,refusesTools,refusedTools} from '../src/runtime/adapters/http-chat.ts';
import {ConversationMemory} from '../src/runtime/adapters/shared.ts';
import {applyFolderAliases,mergeDuplicateFolders,recordFolderAliases,pendingFolderAliases} from '../src/runtime/folder-merge.ts';
import {normalizeFsPath,pathKey,isInsidePath} from '../src/shared/path-normalize.ts';
import type {AdapterRunInput} from '../src/runtime/adapters/types.ts';

const win=process.platform==='win32';
async function sandbox(t:TestContext){
  const root=await mkdtemp(join(tmpdir(),'muster-sec320-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>{}));
  const ws=join(root,'ws'),outside=join(root,'outside');await mkdir(ws);await mkdir(outside);return {root,ws,outside};
}
const events:Array<[string,Record<string,unknown>]>=[];
const ctx=(cwd:string,access:ToolContext['access'],extra:Partial<ToolContext>={}):ToolContext=>({cwd,access,signal:new AbortController().signal,emit:(method,params)=>{events.push([method,params]);},threadId:'t',turnId:'u',...extra});
const call=(name:string,args:object,id='1')=>({id,name,arguments:JSON.stringify(args)});
const canLink=async(root:string)=>{try{await symlink(join(root,'x'),join(root,'probe-link'));return true;}catch{return false;}};

test('H1: a dangling symlink to a file outside cannot be written through (no file appears outside)',async t=>{
  const {root,ws,outside}=await sandbox(t);if(!await canLink(root))return t.skip('no symlink privilege');
  await symlink(join(outside,'planted.txt'),join(ws,'notes.txt'));
  const result=await executeTool(call('write_file',{path:'notes.txt',content:'PWNED'}),ctx(ws,'workspace'));
  assert.equal(result.ok,false);assert.match(result.content,/link/);
  assert.equal(existsSync(join(outside,'planted.txt')),false);
});
test('H1: a dangling directory link, a live link and a link in the middle of the path are refused; Full access may follow them',async t=>{
  const {root,ws,outside}=await sandbox(t);if(!await canLink(root))return t.skip('no symlink privilege');
  await symlink(join(outside,'newdir'),join(ws,'d'),win?'junction':undefined);
  const dir=await executeTool(call('write_file',{path:'d/x.txt',content:'X'}),ctx(ws,'workspace'));
  assert.equal(dir.ok,false);assert.equal(existsSync(join(outside,'newdir','x.txt')),false);
  await writeFile(join(outside,'secret.txt'),'S');await symlink(join(outside,'secret.txt'),join(ws,'live.txt'));
  assert.equal((await executeTool(call('read_file',{path:'live.txt'}),ctx(ws,'workspace'))).ok,false);
  assert.equal((await executeTool(call('edit_file',{path:'live.txt',old_string:'S',new_string:'T'}),ctx(ws,'workspace'))).ok,false);
  assert.equal(await readFile(join(outside,'secret.txt'),'utf8'),'S');
  assert.equal((await executeTool(call('read_file',{path:join(ws,'live.txt')}),ctx(ws,'full'))).ok,true,'Full access is not confined');
});
test('H1: a hard link to an outside file is not rewritten outside Full access',async t=>{
  const {ws,outside}=await sandbox(t);
  await writeFile(join(outside,'victim.txt'),'keep');
  try{await link(join(outside,'victim.txt'),join(ws,'hl.txt'));}catch{return t.skip('no hard links');}
  const result=await executeTool(call('write_file',{path:'hl.txt',content:'changed'}),ctx(ws,'workspace'));
  assert.equal(result.ok,false);assert.equal(await readFile(join(outside,'victim.txt'),'utf8'),'keep');
});
test('H2: aborting a command ends what it started, not just the shell',{skip:win&&'POSIX process groups'},async t=>{
  const {ws,outside}=await sandbox(t);
  const abort=new AbortController(),marker=join(outside,'grandchild.txt');
  const running=executeTool(call('run_command',{command:`sh -c 'sleep 2; echo survived > "${marker}"' & wait`}),ctx(ws,'full',{signal:abort.signal}));
  setTimeout(()=>abort.abort(),300);
  const result=await running;assert.match(result.content,/stopped/);
  await new Promise(resolve=>setTimeout(resolve,2800));
  assert.equal(existsSync(marker),false,'the background job was killed with the shell');
});
test('H2: a timeout also ends the whole tree',{skip:win&&'POSIX process groups'},async t=>{
  const {ws,outside}=await sandbox(t);const marker=join(outside,'late.txt');
  const result=await executeTool(call('run_command',{command:`(sleep 3; echo late > "${marker}") & sleep 30`,timeout_sec:1}),ctx(ws,'full'));
  assert.match(result.content,/stopped after 1s/);await new Promise(resolve=>setTimeout(resolve,3500));
  assert.equal(existsSync(marker),false);
});
test('H3: the command environment is an allowlist without provider keys, tokens or Muster internals',async t=>{
  const source={PATH:'/usr/bin',HOME:'/h',OPENAI_API_KEY:'sk-x',GH_TOKEN:'g',AWS_SECRET_ACCESS_KEY:'a',MUSTER_TERMINAL_MCP_LAUNCHER:'/l',STRIPE_SECRET_KEY:'s',GITHUB_PAT:'p',PGPASSWORD:'pw',DATABASE_URL:'postgres://u:p@h/d',LITELLM_MASTER_KEY:'m',JAVA_HOME:'C:\\jdk',RANDOM_APP_VAR:'v',SystemRoot:'C:\\Windows'};
  const posix=agentCommandEnvironment({PROJECT_TOKEN:'lent'},source,'linux');
  assert.deepEqual(Object.keys(posix).sort(),['HOME','NO_COLOR','PATH','PROJECT_TOKEN','TERM'].sort(),'allowlist, plus the run\'s own lent variables');
  const windows=agentCommandEnvironment(undefined,source,'win32');
  for(const key of ['OPENAI_API_KEY','GH_TOKEN','AWS_SECRET_ACCESS_KEY','MUSTER_TERMINAL_MCP_LAUNCHER','STRIPE_SECRET_KEY','GITHUB_PAT','PGPASSWORD','DATABASE_URL','LITELLM_MASTER_KEY'])assert.equal(key in windows,false,key);
  assert.equal(windows.SystemRoot,'C:\\Windows');assert.equal(windows.RANDOM_APP_VAR,'v','Windows keeps the system variables programs need');assert.equal(windows.JAVA_HOME,'C:\\jdk','toolchain variables still reach Windows programs');
  if(!win){
    const {ws}=await sandbox(t);process.env.OPENAI_API_KEY='sk-test-leak';t.after(()=>{delete process.env.OPENAI_API_KEY;});
    const result=await executeTool(call('run_command',{command:'echo "[${OPENAI_API_KEY}]"'}),ctx(ws,'full',{env:{LENT_ONE:'1'}}));
    assert.equal(result.content.trim(),'[]');
    assert.equal((await executeTool(call('run_command',{command:'echo $LENT_ONE'}),ctx(ws,'full',{env:{LENT_ONE:'1'}}))).content.trim(),'1');
  }
});
test('H4: every command and file change asks `authorize` first; a refusal stops it and leaves a failed row',async t=>{
  const {ws}=await sandbox(t);const asked:Array<[string,Record<string,unknown>]>=[];
  const refuse=ctx(ws,'full',{authorize:async(method,params)=>{asked.push([method,params]);return false;}});
  const shell=await executeTool(call('run_command',{command:'echo ran > ran.txt'},'c1'),refuse);
  const write=await executeTool(call('write_file',{path:'f.txt',content:'x'},'c2'),refuse);
  assert.deepEqual([shell.ok,write.ok],[false,false]);assert.equal(existsSync(join(ws,'ran.txt')),false);assert.equal(existsSync(join(ws,'f.txt')),false);
  assert.deepEqual(asked.map(([method])=>method),['item/commandExecution/requestApproval','item/fileChange/requestApproval']);
  assert.equal(asked[0]![1].command,'echo ran > ran.txt');assert.equal(asked[0]![1].itemId,'c1');assert.equal(asked[0]![1].policyOnly,true);
  assert.deepEqual((asked[1]![1].changes as Array<{path:string}>).map(change=>change.path),[join(ws,'f.txt')]);
  const allow=ctx(ws,'workspace',{authorize:async()=>true});
  assert.equal((await executeTool(call('write_file',{path:'ok.txt',content:'y'}),allow)).ok,true);
});
test('H4: a Project tool rule reaches the HTTP route through the service (deny blocks, nothing is written)',async t=>{
  // The provider adapter turns `authorize` into the service's onRequest; the service answers with domainHooks.toolPolicy and the R5 guard.
  const {createProviderAdapter}=await import('../src/runtime/provider.ts');
  const {ws}=await sandbox(t);const requests:Array<[string,Record<string,unknown>]>=[];
  let seen:AdapterRunInput|undefined;
  const adapter={kind:'http' as const,run:async(input:AdapterRunInput)=>{seen=input;const ok=await input.authorize!('item/fileChange/requestApproval',{changes:[{path:join(ws,'.env')}],policyOnly:true});return {status:'completed' as const,finalMessage:String(ok),dispatchState:'dispatched' as const};}};
  const provider=createProviderAdapter({instances:()=>[{info:{id:'local-x',name:'X',available:true,identityMasked:'x',models:[{id:'m',name:'M'}]},command:'',env:{},sessionsRoot:'',adapter}] as never});
  const noop=()=>{};
  const run=(decision:unknown)=>provider.run({chat:{id:'c',mode:'agent',providerId:'local-x',model:'m',permissionMode:'full'} as never,cwd:ws,prompt:'p',onDelta:noop,onReasoning:noop,onEvent:noop,onRequest:async(method:string,params:Record<string,unknown>)=>{requests.push([method,params]);return decision as never;}} as never);
  assert.equal((await run({decision:'decline'})).finalMessage,'false');
  assert.equal((await run({decision:'accept'})).finalMessage,'true');
  assert.equal((await run(undefined)).finalMessage,'true','no objection from the service means go ahead');
  assert.equal(requests[0]![0],'item/fileChange/requestApproval');assert.ok(seen);
});
test('H5 helper: only a 400/422 body about tools disables tools (a context overflow does not); the refusal expires',()=>{
  assert.equal(refusesTools('{"error":{"message":"llama3.1 does not support tools"}}'),true);
  assert.equal(refusesTools('{"error":"tools are not supported by this model"}'),true);
  assert.equal(refusesTools('{"error":{"message":"maximum context length is 8192 tokens"}}'),false);
  assert.equal(refusesTools('{"error":{"message":"invalid image"}}'),false);
  assert.equal(refusedTools('https://never.example/v1','m'),false);
});
test('H5: a 400 that is not about tools leaves tools on and reports the error',async()=>{
  const adapter=openAICompatibleAdapter({endpoint:'https://overflow.example/v1',apiKey:()=>'k',label:'Overflow',memory:new ConversationMemory(),fetch:(async()=>new Response(JSON.stringify({error:{message:'maximum context length exceeded'}}),{status:400})) as typeof fetch});
  const input:AdapterRunInput={chat:{id:'c',mode:'agent'} as never,cwd:'/w',prompt:'p',model:'m',permissionMode:'full',signal:new AbortController().signal,onThreadReady(){},onTurnAccepted(){},onDelta(){},onReasoning(){},onEvent(){}};
  const result=await adapter.run(input);assert.equal(result.status,'failed');assert.equal(refusedTools('https://overflow.example/v1','m'),false);
});

const sse=(events:unknown[])=>new Response(new ReadableStream({start(c){for(const e of events)c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`));c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));c.close();}}));
const baseInput=(cwd:string,extra:Partial<AdapterRunInput>={}):AdapterRunInput=>({chat:{id:'c',mode:'agent'} as never,cwd,prompt:'go',model:'m',permissionMode:'read-only',signal:new AbortController().signal,onThreadReady(){},onTurnAccepted(){},onDelta(){},onReasoning(){},onEvent(){},...extra});
test('M1: a round runs at most 16 tool calls and a stream may not open an unbounded number of them',async t=>{
  const {ws}=await sandbox(t);await writeFile(join(ws,'a.txt'),'a');
  const bodies:Array<{messages:Array<{role:string;tool_calls?:unknown[]}>}>=[];
  const many=(count:number)=>sse([{choices:[{delta:{tool_calls:Array.from({length:count},(_,index)=>({index,id:`c${index}`,function:{name:'read_file',arguments:'{"path":"a.txt"}'}}))}}]}]);
  let n=0;const adapter=openAICompatibleAdapter({endpoint:'https://caps.example/v1',apiKey:()=>'k',label:'Caps',memory:new ConversationMemory(),fetch:(async(_u:string|URL|Request,init?:RequestInit)=>{bodies.push(JSON.parse(String(init?.body)));return ++n===1?many(40):sse([{choices:[{delta:{content:'done'}}]}]);}) as typeof fetch});
  assert.equal((await adapter.run(baseInput(ws))).status,'completed');
  assert.equal(bodies[1]!.messages.find(m=>m.role==='assistant')!.tool_calls!.length,16);
  const flood=openAICompatibleAdapter({endpoint:'https://flood.example/v1',apiKey:()=>'k',label:'Flood',memory:new ConversationMemory(),fetch:(async()=>many(500)) as typeof fetch});
  const failed=await flood.run(baseInput(ws));assert.equal(failed.status,'failed');assert.match(failed.errorMessage??'',/too many or oversized/);
});
test('M2: read_file reads a limited slice of a big file; edit_file refuses huge files',async t=>{
  const {ws}=await sandbox(t);await writeFile(join(ws,'big.log'),Buffer.alloc(8*1024*1024,'a'));
  const result=await executeTool(call('read_file',{path:'big.log'}),ctx(ws,'read-only'));
  assert.equal(result.ok,true);assert.ok(result.content.length<300*1024);assert.match(result.content,/first 262144 are shown/);
  const edit=await executeTool(call('edit_file',{path:'big.log',old_string:'a',new_string:'b'}),ctx(ws,'workspace'));
  assert.equal(edit.ok,false);assert.match(edit.content,/regular file under/);
});
test('M3: the timeline gets a short, secret-redacted output; the model still gets the real one',async t=>{
  const {ws}=await sandbox(t);const secret='sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
  await writeFile(join(ws,'.env'),`OPENAI_API_KEY=${secret}\n`+'x'.repeat(50_000));
  events.length=0;
  const read=await executeTool(call('read_file',{path:'.env'}),ctx(ws,'read-only'));
  assert.match(read.content,/OPENAI_API_KEY/);
  const shown=(events.find(([method])=>method==='item/completed')![1].item as {aggregatedOutput:string}).aggregatedOutput;
  assert.ok(shown.length<=MAX_TIMELINE_OUTPUT);assert.doesNotMatch(shown,/sk-proj/);
  if(!win){
    events.length=0;
    await executeTool(call('run_command',{command:`printf 'token=%s' ${secret}; head -c 20000 /dev/zero | tr '\\0' z`}),ctx(ws,'full'));
    const out=(events.find(([method,params])=>method==='item/completed'&&(params.item as {type:string}).type==='commandExecution')![1].item as {aggregatedOutput:string}).aggregatedOutput;
    assert.ok(out.length<=MAX_TIMELINE_OUTPUT+80);assert.doesNotMatch(out,/sk-proj-abcdef/);
  }
});
test('M4: the merge migration also remaps automations, project member grants, worktree rows and annotations in their own databases',async t=>{
  const {root}=await sandbox(t);
  const main=new DatabaseSync(':memory:');
  main.exec(`CREATE TABLE folders (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL, position INTEGER);
    CREATE TABLE automations (id TEXT PRIMARY KEY, target TEXT NOT NULL, schedule TEXT NOT NULL);
    CREATE TABLE automation_versions (automation_id TEXT, version INTEGER, config TEXT);`);
  main.prepare('INSERT INTO folders (id,path,name,created_at) VALUES (?,?,?,?)').run('keep','\\\\?\\E:\\Dev\\app','app','2026-01-01');
  main.prepare('INSERT INTO folders (id,path,name,created_at) VALUES (?,?,?,?)').run('dupe','e:/dev/app','app','2026-02-01');
  main.prepare('INSERT INTO automations VALUES (?,?,?)').run('a',JSON.stringify({kind:'new',folderId:'dupe'}),'{}');
  main.prepare('INSERT INTO automation_versions VALUES (?,?,?)').run('a',1,JSON.stringify({target:{folderId:'dupe'}}));
  const merged=mergeDuplicateFolders(main);assert.deepEqual(merged.moved,{dupe:'keep'});assert.deepEqual(merged.names,['e:/dev/app']);
  assert.match((main.prepare('SELECT target FROM automations').get() as {target:string}).target,/"folderId":"keep"/);
  assert.match((main.prepare('SELECT config FROM automation_versions').get() as {config:string}).config,/"folderId":"keep"/);
  recordFolderAliases(main,merged.moved!);assert.deepEqual(pendingFolderAliases(main),{dupe:'keep'});
  const team=new DatabaseSync(join(root,'muster-project-team.sqlite'));team.exec('CREATE TABLE project_members(project_id TEXT, id TEXT, folder_ids TEXT)');team.prepare('INSERT INTO project_members VALUES (?,?,?)').run('p','m',JSON.stringify(['dupe','other']));team.close();
  const gov=new DatabaseSync(join(root,'muster-project-governance.sqlite'));gov.exec('CREATE TABLE task_worktrees(folder_id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT)');gov.prepare('INSERT INTO task_worktrees VALUES (?,?,?)').run('dupe','p','t');gov.close();
  const notes=new DatabaseSync(join(root,'annotations.sqlite'));notes.exec('CREATE TABLE annotations(id TEXT PRIMARY KEY, folderId TEXT NOT NULL, path TEXT)');notes.prepare('INSERT INTO annotations VALUES (?,?,?)').run('n','dupe','a.ts');notes.close();
  assert.equal(applyFolderAliases(root,{dupe:'keep'}),true);assert.equal(applyFolderAliases(root,{dupe:'keep'}),true,'idempotent');
  const read=(file:string,sql:string)=>{const db=new DatabaseSync(join(root,file));try{return db.prepare(sql).get() as Record<string,string>;}finally{db.close();}};
  assert.equal(read('muster-project-team.sqlite','SELECT folder_ids AS v FROM project_members')!.v,'["keep","other"]');
  assert.equal(read('muster-project-governance.sqlite','SELECT folder_id AS v FROM task_worktrees')!.v,'keep');
  assert.equal(read('annotations.sqlite','SELECT folderId AS v FROM annotations')!.v,'keep');
});
test('M5: device-namespace paths are left alone, and the case fold is ASCII only',()=>{
  for(const raw of ['\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\proj','\\\\.\\PhysicalDrive0','\\\\?\\GLOBALROOT\\Device\\x'])assert.equal(normalizeFsPath(raw,'win32'),raw);
  assert.equal(normalizeFsPath('\\\\.\\C:\\x','win32'),'C:\\x');
  assert.equal(isInsidePath('C:\\work','C:\\wor\u212A\\x','win32'),false,'the Kelvin sign is not a k');
  assert.notEqual(pathKey('C:\\work','win32'),pathKey('C:\\wor\u212A','win32'));
});
test('M5: Windows path parts that resolve differently are refused outside Full access',{skip:!win&&'Windows only'},async t=>{
  const {ws}=await sandbox(t);
  for(const bad of ['a.txt.','a.txt ','a.txt:stream','NUL','con.txt'])assert.equal((await executeTool(call('write_file',{path:bad,content:'x'}),ctx(ws,'workspace'))).ok,false,bad);
});
test('M6: PowerShell gets the command as -EncodedCommand (UTF-16LE base64), so quoting cannot change the target',()=>{
  const command='Remove-Item "C:\\My Folder\\tmp" -Recurse';
  if(!win){assert.deepEqual(shellInvocation(command),{file:'/bin/sh',args:['-c',command]});return;}
  const {file,args}=shellInvocation(command);assert.equal(file,'powershell.exe');
  const encoded=args[args.indexOf('-EncodedCommand')+1]!;
  assert.ok(Buffer.from(encoded,'base64').toString('utf16le').endsWith(command));assert.ok(!args.includes(command));
});
