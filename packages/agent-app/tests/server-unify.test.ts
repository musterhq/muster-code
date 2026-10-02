/** One Muster Server (#287): backend detection from the URL, the config migration (an existing Paperclip or Muster Server link keeps working with
 *  no re-auth, the token bound to its origin), and the Muster Server backend's normalisation of a server's own workspace. Servers are faked. */
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {createPaperclipDomain} from '../src/runtime/domains/paperclip.ts';
import {createMusterServerDomain} from '../src/runtime/domains/muster-server.ts';
import {classify,detectBackend} from '../src/runtime/server/detect.ts';
import {loadServerConfig,LEGACY_MUSTER_SERVER_SECRET,LEGACY_PAPERCLIP_SECRET,SERVER_SECRET} from '../src/runtime/server/config.ts';
import {signInMethods} from '../src/runtime/server/auth.ts';
import {MusterServerBackend,SERVER_ORG_ID} from '../src/runtime/server/muster-server-backend.ts';
import type {DomainContext} from '../src/runtime/domains/types.ts';

const json=(status:number,value:unknown)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const PAPERCLIP_HEALTH={status:'ok',version:'2026.1001.0',deploymentMode:'authenticated'};
const MUSTER_HEALTH={ok:true,name:'Muster Server',version:'0.2.10',runtime:'running'};

test('detection: Paperclip answers /api/health, a Muster Server answers /healthz; nothing else is accepted',async()=>{
  assert.deepEqual(classify({status:200,body:PAPERCLIP_HEALTH},{status:404,body:{ok:false}},'https://x'),{ok:true,kind:'paperclip',version:'2026.1001.0',deploymentMode:'authenticated',origin:'https://x'});
  assert.deepEqual(classify({status:404,body:{ok:false,error:'Not found.'}},{status:200,body:MUSTER_HEALTH},'https://x'),{ok:true,kind:'muster-server',version:'0.2.10',origin:'https://x'});
  const html={status:200,body:null};
  const page=classify(html,html,'https://x');assert.equal(page.ok,false);assert.match((page as {message:string}).message,/isn’t a Muster Server API/);
  const down=classify(null,null,'https://x');assert.equal(down.ok,false);assert.equal((down as {stage:string}).stage,'network');
  // A body that has a runtime state is a Muster Server even if it also says status ok.
  assert.equal((classify({status:200,body:{status:'ok'}},{status:200,body:MUSTER_HEALTH},'https://x') as {kind:string}).kind,'muster-server');
  // Probes send no credentials and say they are probes.
  const seen:{url:string;headers:Record<string,string>}[]=[];
  const found=await detectBackend('https://muster.example.com/',async(input,init)=>{seen.push({url:input,headers:init?.headers as Record<string,string>});return input.endsWith('/healthz')?json(200,MUSTER_HEALTH):json(404,{ok:false});});
  assert.equal((found as {kind:string}).kind,'muster-server');
  assert.deepEqual(seen.map(s=>new URL(s.url).pathname).sort(),['/api/health','/healthz']);
  assert.ok(seen.every(s=>!s.headers.authorization&&s.headers['x-muster-probe']==='detect'));
});

test('sign-in methods follow the backend: Paperclip approves in the browser, a Muster Server takes a password',()=>{
  assert.deepEqual(signInMethods('paperclip'),['browser']);
  assert.deepEqual(signInMethods('muster-server'),['password']);
  assert.deepEqual(signInMethods(null),[]);
});

// ---------------------------------------------------------------- migration
const box={isEncryptionAvailable:()=>true,encryptString:(t:string)=>Buffer.from(`enc:${Buffer.from(t).toString('base64')}`),decryptString:(b:Buffer)=>Buffer.from(b.toString().slice(4),'base64').toString()};
async function home(t:TestContext){const dir=await mkdtemp(join(tmpdir(),'muster-unify-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
function secretsFake(initial:Record<string,string>={}){const values=new Map(Object.entries(initial));return {values,store:{status:(id:string)=>({stored:values.has(id),updatedAt:null,secureStorage:true}),get:(id:string)=>values.get(id),set(id:string,v:string){values.set(id,v);return this.status(id);},clear(id:string){values.delete(id);return this.status(id);}}};}
function fakePaperclip(){
  const calls:{path:string;auth?:string}[]=[];
  const fetch=async(input:string,init:RequestInit={})=>{
    const url=new URL(input),headers=init.headers as Record<string,string>;
    if(headers['x-muster-probe'])return url.pathname==='/api/health'?json(200,PAPERCLIP_HEALTH):json(404,{});
    calls.push({path:url.pathname,auth:headers.authorization});
    if(headers.authorization!=='Bearer pcp_board_existing')return json(401,{error:'no'});
    if(url.pathname==='/api/health')return json(200,PAPERCLIP_HEALTH);
    if(url.pathname==='/api/companies')return json(200,[{id:'c1',name:'RagnarDataOps',issuePrefix:'RAG',status:'active'}]);
    return json(200,[]);
  };
  return {calls,fetch:fetch as never};
}
import {DatabaseSync} from 'node:sqlite';
const ctxOf=(dataDir:string)=>({dataDir,db:(()=>{const memory=new DatabaseSync(':memory:');return ()=>memory;})(),store:{snapshot:()=>({folders:[]})},emit(){},hooks:{},async invoke(command:string){if(command==='mailbox.list')return {messages:[],unacked:0,pending:0};if(command==='project.list')return [];throw new Error(`unexpected ${command}`);}}) as unknown as DomainContext;

test('upgrade: an existing paperclip.json link keeps its token, origin binding and company with no re-auth; the old file is left alone',async t=>{
  const dir=await home(t);
  const legacy={mode:'custom',baseUrl:'https://pc.example.com',companyId:'c1',tokenOrigin:'https://pc.example.com'};
  await writeFile(join(dir,'paperclip.json'),JSON.stringify(legacy));
  const secrets=secretsFake({[LEGACY_PAPERCLIP_SECRET]:'pcp_board_existing'}),server=fakePaperclip();
  const domain=createPaperclipDomain(ctxOf(dir),{fetch:server.fetch,secrets:()=>secrets.store as never,timers:{setTimeout:(()=>0) as never,clearTimeout:(()=>undefined) as never}});
  t.after(()=>domain.dispose?.());
  const view=await domain.handlers['paperclip.config.get']!({}) as {mode:string;baseUrl:string;hasToken:boolean;backend:string;compatibility:string;companyId:string};
  assert.deepEqual([view.mode,view.baseUrl,view.hasToken,view.backend,view.companyId],['custom','https://pc.example.com',true,'paperclip','c1'],'linked, signed in, no questions asked');
  assert.equal(view.compatibility,'Paperclip-compatible');
  const snap=await domain.handlers['paperclip.snapshot']!({}) as {paperclip:{company:{name:string}}};
  assert.equal(snap.paperclip.company.name,'RagnarDataOps');
  assert.ok(server.calls.length>0&&server.calls.every(c=>c.auth==='Bearer pcp_board_existing'),'the very same token is sent, to its own origin only');
  const migrated=JSON.parse(await readFile(join(dir,'server.json'),'utf8'));
  assert.equal(migrated.version,2);assert.equal(migrated.tokenSecret,LEGACY_PAPERCLIP_SECRET,'the token stays where it was: nothing is copied or re-encrypted');
  assert.equal(migrated.tokenOrigin,'https://pc.example.com');assert.equal(migrated.backend,'paperclip');
  assert.ok(!JSON.stringify(migrated).includes('pcp_board'),'no token in the config file');
  assert.deepEqual(JSON.parse(await readFile(join(dir,'paperclip.json'),'utf8')),legacy,'the old file is untouched (a downgrade still works)');
  // Origin binding survives: another address never gets the token.
  const moved=await domain.handlers['paperclip.config.set']!({mode:'custom',baseUrl:'https://other.example.net',companyId:null}) as {hasToken:boolean};
  assert.equal(moved.hasToken,false);assert.equal(secrets.values.has(LEGACY_PAPERCLIP_SECRET),false);
});

test('upgrade: a This Mac link and an off link migrate too; a second start reads server.json and does not migrate again',async t=>{
  const dir=await home(t);
  await writeFile(join(dir,'paperclip.json'),JSON.stringify({mode:'local',baseUrl:'http://127.0.0.1:3100',companyId:null,tokenOrigin:null}));
  const first=loadServerConfig(dir);
  assert.equal(first.migrated,true);assert.deepEqual([first.config.mode,first.config.backend],['local','paperclip']);
  await writeFile(join(dir,'paperclip.json'),JSON.stringify({mode:'off'}));
  const second=loadServerConfig(dir);
  assert.equal(second.migrated,false,'server.json wins once it exists');assert.equal(second.config.mode,'local');
  const empty=loadServerConfig(await home(t));
  assert.deepEqual([empty.migrated,empty.config.mode,empty.config.backend],[false,'off',null],'a new install has nothing to migrate');
});

test('upgrade: an existing muster-server.json sign-in carries over as a Muster Server connection (same token entry, same origin)',async t=>{
  const dir=await home(t);
  await writeFile(join(dir,'muster-server.json'),JSON.stringify({version:1,url:'https://muster.example.com',tokenOrigin:'https://muster.example.com',user:{username:'olivia',displayName:'Olivia Owner',role:'owner'},serverVersion:'0.2.10',connectedAt:'2026-10-01T00:00:00.000Z'}));
  const secrets=secretsFake({[LEGACY_MUSTER_SERVER_SECRET]:'mst_existing_token_value_123456'});
  const domain=createMusterServerDomain(ctxOf(dir),{fetch:(async()=>json(404,{})) as never,secrets:()=>secrets.store as never});
  const status=await domain.handlers['musterServer.status']!({}) as {connected:boolean;url:string;user:{username:string}};
  assert.deepEqual([status.connected,status.url,status.user.username],[true,'https://muster.example.com','olivia']);
  const cfg=loadServerConfig(dir).config;
  assert.deepEqual([cfg.backend,cfg.mode,cfg.tokenSecret],['muster-server','custom',LEGACY_MUSTER_SERVER_SECRET]);
});

test('upgrade: with both linked, the Paperclip link (which fed the in-app views) wins and the other token stays in the keychain',async t=>{
  const dir=await home(t);
  await writeFile(join(dir,'paperclip.json'),JSON.stringify({mode:'custom',baseUrl:'https://pc.example.com',companyId:null,tokenOrigin:'https://pc.example.com'}));
  await writeFile(join(dir,'muster-server.json'),JSON.stringify({version:1,url:'https://muster.example.com',tokenOrigin:'https://muster.example.com',user:null,serverVersion:null,connectedAt:null}));
  const cfg=loadServerConfig(dir).config;
  assert.deepEqual([cfg.backend,cfg.baseUrl],['paperclip','https://pc.example.com']);
  assert.deepEqual(cfg.migratedFrom,['paperclip.json']);
});

test('upgrade: a link from the sign-in build keeps who signed in and the notice',async t=>{
  const dir=await home(t);
  await writeFile(join(dir,'paperclip.json'),JSON.stringify({mode:'custom',baseUrl:'https://pc.example.com',companyId:null,tokenOrigin:'https://pc.example.com',signedIn:{name:'Test Founder',email:'f@example.test'},signInNotice:null}));
  const cfg=loadServerConfig(dir).config;
  assert.deepEqual(cfg.signedIn,{name:'Test Founder',email:'f@example.test'});
});

test('a new token goes under server-token; the connection reads it back only for its own origin',async t=>{
  const dir=await home(t),secrets=secretsFake(),server=fakePaperclip();
  const domain=createPaperclipDomain(ctxOf(dir),{fetch:server.fetch,secrets:()=>secrets.store as never,timers:{setTimeout:(()=>0) as never,clearTimeout:(()=>undefined) as never}});
  t.after(()=>domain.dispose?.());
  await domain.handlers['paperclip.config.set']!({mode:'custom',baseUrl:'https://pc.example.com',token:'pcp_board_existing'});
  assert.equal(secrets.values.get(SERVER_SECRET),'pcp_board_existing');
  const test_=await domain.handlers['paperclip.test']!({mode:'custom',baseUrl:'https://pc.example.com'}) as {ok:boolean;backend:string;compatibility:string;message:string;signIn:string[]};
  assert.deepEqual([test_.ok,test_.backend,test_.compatibility],[true,'paperclip','Paperclip-compatible']);
  assert.match(test_.message,/^Connected to Muster Server 2026\.1001\.0 \(authenticated\)\. 1 org\.$/,'the test result never says Paperclip');
  assert.deepEqual(test_.signIn,['browser']);
});

// ---------------------------------------------------------------- the Muster Server backend over a faked /rpc
const task=(id:string,extra:Record<string,unknown>={})=>({id,key:`SUP-${id}`,title:`Task ${id}`,status:'todo',priority:'medium',source:'local',projectId:'p1',parentId:null,goalId:null,assigneeId:'member:m1',assigneeLabel:'Ada',createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z',startedAt:null,completedAt:null,live:false,blockedByIds:[],origin:null,...extra});
const SNAPSHOT={paperclip:null,goals:[],labels:[],fetchedAt:'',counts:{liveRuns:0,inbox:0,failedRuns:0,openTasks:1},
  projects:[{id:'p1',name:'Support desk',status:'in_progress',description:'Answer',source:'local',repo:null,cwd:'/srv/support',taskCount:1,openCount:1,paused:false,memory:null}],
  tasks:[task('1')],agents:[{id:'member:m1',name:'Ada',role:'agent',title:null,model:null,adapter:null,source:'local',status:'idle',reportsTo:null,lastActiveAt:null,error:null,capabilities:null,pausable:true,projectId:'p1',memberId:'m1'}],
  runs:[{id:'r1',agentId:'member:m1',taskId:'1',status:'running',trigger:'dispatch',source:'local',createdAt:'2026-10-01T00:00:00Z',startedAt:null,finishedAt:null,error:null,cancellable:true,chatId:'chat-secret'}],
  inbox:[{id:'gate:g1',kind:'approval',title:'Run “Nightly”?',why:'Waiting',severity:'medium',at:'2026-10-01T00:00:00Z',taskId:null,agentId:null,runId:null,source:'local',projectId:'p1'},
    {id:'mail:1',kind:'mail',title:'mail',why:'',severity:'low',at:'2026-10-01T00:00:00Z',taskId:null,agentId:null,runId:null},
    {id:'task:1',kind:'review',title:'SUP-1 · Task 1',why:'Waiting for your review.',severity:'medium',at:'2026-10-01T00:00:00Z',taskId:'1',agentId:null,runId:null,source:'local',projectId:'p1',chatIds:['chat-secret']}]};
function fakeRpc(handlers:Record<string,(input:any)=>unknown>){
  const calls:{command:string;input:any;auth?:string}[]=[];
  const fetch=async(input:string,init:RequestInit={})=>{
    const {command,input:body}=JSON.parse(String(init.body));calls.push({command,input:body,auth:(init.headers as Record<string,string>).authorization});
    const handler=handlers[command];if(!handler)return json(400,{ok:false,error:`Unknown command "${command}".`});
    return json(200,{ok:true,value:handler(body)});
  };
  return {calls,fetch:fetch as never};
}

test('the Muster Server backend shows the server\'s workspace as the linked server: tagged, chats and mail stripped, gates decidable',async()=>{
  const rpc=fakeRpc({'paperclip.snapshot':()=>SNAPSHOT,'automations.gate.decide':()=>({ok:true}),'approval.respond':()=>undefined,'paperclip.agent.pause':()=>({ok:true}),'paperclip.run.cancel':()=>({ok:true})});
  const backend=new MusterServerBackend({baseUrl:'https://muster.example.com',token:'mst_token'},{fetch:rpc.fetch,orgName:'Acme'});
  const [company]=await backend.companies();assert.deepEqual([company.id,company.name],[SERVER_ORG_ID,'Acme']);
  const part=await backend.read(company);
  assert.ok(part.tasks.every(x=>x.source==='paperclip')&&part.agents.every(x=>x.source==='paperclip')&&part.projects.every(x=>x.source==='paperclip'));
  assert.equal(part.runs[0]!.source,'paperclip');assert.equal('chatId' in part.runs[0]!,false,'a run chat is on the server: nothing here would open it');
  assert.deepEqual(part.inbox.map(i=>i.id),['gate:g1','task:1'],'the server\'s mailbox does not appear');
  assert.equal(part.inbox.find(i=>i.id==='task:1')!.chatIds,undefined);
  const gate=part.inbox.find(i=>i.id==='gate:g1')!;assert.equal(gate.approvalId,'gate:g1');assert.deepEqual(gate.approvalVerbs,['approve','reject']);
  assert.equal(part.approvals.length,1);
  assert.ok(rpc.calls.every(c=>c.auth==='Bearer mst_token'));
  // An unchanged server is the same part (no rebuild); a changed one bumps the generation.
  const before=backend.generation;
  assert.equal(await backend.read(company,{generation:before,companyId:company.id,part}),part);assert.equal(backend.generation,before);
  rpc.calls.length=0;
  await backend.decideApproval('gate:g1','approve',null);
  assert.deepEqual(rpc.calls.at(-1),{command:'automations.gate.decide',input:{id:'g1',approve:true},auth:'Bearer mst_token'});
  await backend.decideApproval('item-7','reject',null);
  assert.deepEqual(rpc.calls.at(-1)!.input,{id:'item-7',approved:false});
  await assert.rejects(backend.decideApproval('gate:g1','request_revision',null),/approved or declined/);
  await backend.pauseAgent('member:m1');await backend.cancelRun('r1');
  assert.deepEqual(rpc.calls.slice(-2).map(c=>[c.command,c.input]),[['paperclip.agent.pause',{id:'member:m1'}],['paperclip.run.cancel',{id:'r1'}]]);
});

test('a Muster Server task thread: a pending approval or question becomes a card answered in place; governance and secret cards stay on the server',async()=>{
  const pendingApproval={id:'it-a',kind:'approval',text:'Run npm test?',status:'pending',createdAt:'2026-10-01T00:00:00Z'};
  const pendingQuestion={id:'it-q',kind:'question',text:'Which branch?',status:'pending',createdAt:'2026-10-01T00:00:01Z',data:{questions:[{id:'branch',question:'Which branch?',options:[{label:'main',description:'default'},{label:'dev'}],isOther:true}]}};
  const detail={task:task('1'),description:'d',comments:[],runs:[{id:'r1',agentId:'member:m1',taskId:'1',status:'running',trigger:'dispatch',source:'local',createdAt:'',startedAt:null,finishedAt:null,error:null,cancellable:true,chatId:'c'}],addressee:null,composerNote:null,subtasks:[],blocking:[],receipts:[],mentionable:[],
    cards:[{kind:'needs',id:'n1',at:'1',from:'Ada',prompt:'ok?',detail:null,status:'pending',resolution:null,interactionId:null,acceptLabel:null,rejectLabel:null,chatId:'c',pending:pendingApproval},
      {kind:'needs',id:'n2',at:'2',from:'Ada',prompt:'q',detail:null,status:'pending',resolution:null,interactionId:null,acceptLabel:null,rejectLabel:null,chatId:'c',pending:pendingQuestion},
      {kind:'secret',id:'s',at:'3',proposal:{},secureStorage:true},{kind:'stage',id:'st',at:'4',stage:{}},{kind:'ask',id:'a',at:'5',interaction:{}},{kind:'suggestion',id:'sg',at:'6',suggestion:{}}]};
  const rpc=fakeRpc({'paperclip.task':()=>detail,'approval.respond':()=>undefined,'question.respond':()=>undefined});
  const backend=new MusterServerBackend({baseUrl:'https://muster.example.com',token:'mst_token'},{fetch:rpc.fetch});
  const out=await backend.taskDetail('1',{agents:new Map(),part:undefined,memory:async()=>[]});
  assert.deepEqual(out.cards.map(c=>c.kind),['needs','needs'],'no secret entry or governance control is routed from this window');
  const [approval,question]=out.cards as Array<Extract<typeof out.cards[number],{kind:'needs'}>>;
  assert.deepEqual([approval.interactionId,approval.acceptLabel,approval.rejectLabel,approval.pending,approval.chatId],['chat-approval:it-a','Approve','Reject',undefined,undefined]);
  assert.equal(question.interactionId,'chat-question:it-q');
  assert.deepEqual(question.questions![0]!.options.map(o=>o.id),['main','dev']);assert.equal(question.questions![0]!.allowOther,true);
  assert.equal(out.task.source,'paperclip');assert.equal('chatId' in out.runs[0]!,false);
  await backend.respond('1','chat-approval:it-a',{accept:true});
  await backend.respond('1','chat-question:it-q',{accept:true,answers:[{questionId:'branch',optionIds:['main'],otherText:'and tags'}]});
  assert.deepEqual(rpc.calls.slice(-2).map(c=>[c.command,c.input]),[['approval.respond',{id:'it-a',approved:true}],['question.respond',{id:'it-q',answers:{branch:{answers:['main','and tags']}}}]]);
  await assert.rejects(backend.respond('1','interaction-1',{accept:true}),/no longer waiting/);
});

test('the Muster Server import reader answers the importer\'s Paperclip-shaped reads from the server\'s own data',async()=>{
  const rpc=fakeRpc({'paperclip.snapshot':()=>SNAPSHOT,'paperclip.task':(i:{id:string})=>({task:task(i.id),description:`Body of ${i.id}`,comments:[{id:'cm1',author:{kind:'agent',id:'member:m1',label:'Ada'},body:'Done',createdAt:'2026-10-01T01:00:00Z'},{id:'cm2',author:{kind:'user',id:null,label:'You'},body:'Thanks',createdAt:'2026-10-01T02:00:00Z'}],cards:[],runs:[],receipts:[],mentionable:[]})});
  const reader=new MusterServerBackend({baseUrl:'https://muster.example.com',token:'mst_token'},{fetch:rpc.fetch,orgName:'Acme'}).importReader();
  assert.deepEqual(await reader.get('/companies'),[{id:SERVER_ORG_ID,name:'Acme',issuePrefix:''}]);
  const projects=await reader.get(`/companies/${SERVER_ORG_ID}/projects`) as Array<{id:string;name:string;codebase:{localFolder:string}}>;
  assert.deepEqual([projects[0]!.id,projects[0]!.name,projects[0]!.codebase.localFolder],['p1','Support desk','/srv/support']);
  const agents=await reader.get(`/companies/${SERVER_ORG_ID}/agents`) as Array<{id:string;name:string}>;assert.equal(agents[0]!.name,'Ada');
  const pages:unknown[][]=[];for await(const page of reader.issuePages(SERVER_ORG_ID,'includeBlockedBy=true'))pages.push(page);
  const issue=pages[0]![0] as {id:string;identifier:string;description:string;assigneeAgentId:string;status:string};
  assert.deepEqual([issue.identifier,issue.description,issue.assigneeAgentId,issue.status],['SUP-1','Body of 1','member:m1','todo']);
  const compact:unknown[][]=[];for await(const page of reader.issuePages(SERVER_ORG_ID,'view=compact'))compact.push(page);
  assert.equal((compact[0]![0] as {description:string}).description,'','a plan only counts: no bodies are read for it');
  const comments:Array<{authorType:string;authorAgentId?:string}>=[];for await(const page of reader.commentPages('1'))comments.push(...(page as unknown as typeof comments));
  assert.deepEqual(comments.map(c=>[c.authorType,c.authorAgentId]),[['agent','member:m1'],['user',undefined]]);
  await assert.rejects(reader.get('/issues/nope'),/nothing at/);
});
