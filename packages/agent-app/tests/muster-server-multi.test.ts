/** Several Muster Servers side by side in one list (#803): add, rename, disconnect, re-authenticate and remove each on its own; projects from
 *  every connected server at once, labelled; the old single-server setup migrating into the list; one unreachable server not blocking the
 *  rest. Servers are faked through an injected fetch; nothing here talks to a real one. */
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test,type TestContext} from 'node:test';
import {createMusterServerDomain} from '../src/runtime/domains/muster-server.ts';
import {createPaperclipDomain} from '../src/runtime/domains/paperclip.ts';
import {LEGACY_MUSTER_SERVER_SECRET} from '../src/runtime/server/config.ts';
import type {DomainContext} from '../src/runtime/domains/types.ts';
import type {MusterServerEntryView,MusterServerProject} from '../src/shared/domains/muster-server-protocol.ts';

const json=(status:number,value:unknown)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
interface FakeServer {origin:string;user:{username:string;displayName:string;role:string};password:string;token:string;projects:Array<{id:string;name:string}>}
/** Many fake Muster Servers behind one fetch: each issues its own token and answers only to it. `down` makes one unreachable. */
function fakeServers(list:FakeServer[]){
  const byOrigin=new Map(list.map(s=>[s.origin,s]));
  const down=new Set<string>();
  const calls:{origin:string;path:string;auth?:string}[]=[];
  const fetch=async(input:string|URL,init:RequestInit={})=>{
    const url=new URL(String(input)),headers=Object.fromEntries(Object.entries((init.headers??{}) as Record<string,string>).map(([k,v])=>[k.toLowerCase(),v]));
    calls.push({origin:url.origin,path:url.pathname,auth:headers.authorization});
    if(down.has(url.origin))throw new TypeError('fetch failed');
    const server=byOrigin.get(url.origin);
    if(!server)throw new TypeError('fetch failed');
    const body=JSON.parse(String(init.body??'{}')) as Record<string,any>;
    if(url.pathname==='/healthz')return json(200,{ok:true,name:'Muster Server',version:'0.3.0',runtime:'running'});
    if(url.pathname==='/api/health')return json(404,{ok:false});
    if(url.pathname==='/api/auth/token')return body.password===server.password?json(200,{ok:true,token:server.token}):json(401,{ok:false,error:'Wrong username or password.'});
    if(url.pathname==='/rpc'){
      if(headers.authorization!==`Bearer ${server.token}`)return json(401,{ok:false,error:'Not signed in.'});
      if(body.command==='server.me')return json(200,{ok:true,value:{user:server.user,server:{version:'0.3.0'}}});
      if(body.command==='project.list')return json(200,{ok:true,value:server.projects.map(p=>({...p,goal:'',archived:false}))});
      if(body.command==='server.health')return json(200,{ok:true,value:{version:'0.3.0'}});
    }
    return json(404,{ok:false,error:'not found'});
  };
  return {calls,down,fetch:fetch as never};
}
const ALPHA:FakeServer={origin:'https://alpha.example.com',user:{username:'olivia',displayName:'Olivia Owner',role:'owner'},password:'alpha-password-1',token:'mst_alpha_issued_token_0123456789',projects:[{id:'a1',name:'Support desk'}]};
const BETA:FakeServer={origin:'https://beta.example.com',user:{username:'mel',displayName:'Mel Member',role:'member'},password:'beta-password-1',token:'mst_beta_issued_token_0123456789',projects:[{id:'b1',name:'Billing'},{id:'b2',name:'Payroll'}]};
const GAMMA:FakeServer={origin:'https://gamma.example.com',user:{username:'gus',displayName:'Gus Guest',role:'viewer'},password:'gamma-password-1',token:'mst_gamma_issued_token_0123456789',projects:[{id:'g1',name:'Research'}]};

function secretsFake(initial:Record<string,string>={}){const values=new Map(Object.entries(initial));return {values,store:{status:(id:string)=>({stored:values.has(id),updatedAt:null,secureStorage:true}),get:(id:string)=>values.get(id),set(id:string,v:string){values.set(id,v);return this.status(id);},clear(id:string){values.delete(id);return this.status(id);}}};}
async function home(t:TestContext){const dir=await mkdtemp(join(tmpdir(),'muster-multi-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
const ctxOf=(dataDir:string,events:unknown[]=[])=>({dataDir,db:(()=>{const memory=new DatabaseSync(':memory:');return ()=>memory;})(),store:{snapshot:()=>({folders:[]})},emit(e:unknown){events.push(e);},hooks:{},async invoke(command:string){if(command==='mailbox.list')return {messages:[],unacked:0,pending:0};if(command==='project.list')return [];throw new Error(`unexpected ${command}`);}}) as unknown as DomainContext;
const NO_TIMERS={setTimeout:(()=>0) as never,clearTimeout:(()=>undefined) as never};
function runtime(t:TestContext,dir:string,servers:ReturnType<typeof fakeServers>,secrets=secretsFake()){
  const events:unknown[]=[],ctx=ctxOf(dir,events);
  const ms=createMusterServerDomain(ctx,{fetch:servers.fetch,secrets:()=>secrets.store as never});
  const pc=createPaperclipDomain(ctx,{fetch:servers.fetch,secrets:()=>secrets.store as never,timers:NO_TIMERS});
  t.after(()=>{pc.dispose?.();ms.dispose?.();});
  const call=<T>(command:string,input:Record<string,unknown>={})=>Promise.resolve((ms.handlers[command]??pc.handlers[command])!(input as never)) as Promise<T>;
  return {events,secrets,call,list:async()=>(await call<{servers:MusterServerEntryView[]}>('musterServer.list')).servers};
}
const connectPassword=(r:ReturnType<typeof runtime>,s:FakeServer,extra:Record<string,unknown>={})=>r.call('musterServer.connect',{url:s.origin,method:'password',username:s.user.username,password:s.password,...extra});

// Spec: MUS-SPEC-13-803A (docs/spec/clauses/13-muster-server.md#mus-spec-13-803a)
test('three Muster Servers added one after another are all listed, each with its own token',async t=>{
  const dir=await home(t),servers=fakeServers([ALPHA,BETA,GAMMA]),r=runtime(t,dir,servers);
  assert.deepEqual(await r.list(),[],'a new install lists no servers');
  await r.call('musterServer.connect',{url:ALPHA.origin,method:'token',token:ALPHA.token});
  await connectPassword(r,BETA);
  await connectPassword(r,GAMMA);
  await r.call('musterServer.check',{});
  const list=await r.list();
  assert.deepEqual(list.map(s=>[s.name,s.url,s.account,s.state]),[
    ['alpha.example.com','https://alpha.example.com','Olivia Owner (@olivia)','online'],
    ['beta.example.com','https://beta.example.com','Mel Member (@mel)','online'],
    ['gamma.example.com','https://gamma.example.com','Gus Guest (@gus)','online'],
  ],'adding a server never replaces the one before it');
  assert.equal(new Set(list.map(s=>s.id)).size,3,'every server has its own id');
  assert.deepEqual([...r.secrets.values.values()].sort(),[ALPHA.token,BETA.token,GAMMA.token].sort(),'three tokens, one per server, in the secret store');
  assert.equal(new Set(r.secrets.values.keys()).size,3);
  const onDisk=await readFile(join(dir,'servers.json'),'utf8');
  for(const s of [ALPHA,BETA,GAMMA]){assert.equal(onDisk.includes(s.token),false,'no token in the server list file');assert.equal(onDisk.includes(s.password),false,'no password anywhere');}
  for(const call of servers.calls.filter(c=>c.auth))assert.equal(call.auth,`Bearer ${[ALPHA,BETA,GAMMA].find(s=>s.origin===call.origin)!.token}`,'each server only ever receives its own token');
  // Connecting to an address that is already in the list signs that entry in again instead of adding a copy.
  await connectPassword(r,BETA);
  assert.equal((await r.list()).length,3);
});

// Spec: MUS-SPEC-13-803B (docs/spec/clauses/13-muster-server.md#mus-spec-13-803b)
test('rename, disconnect, re-authenticate and remove act on one server and leave the others working',async t=>{
  const dir=await home(t),servers=fakeServers([ALPHA,BETA,GAMMA]),r=runtime(t,dir,servers);
  for(const s of [ALPHA,BETA,GAMMA])await connectPassword(r,s);
  const [a,b,g]=await r.list();
  await r.call('musterServer.rename',{serverId:b!.id,name:'Finance team'});
  assert.deepEqual((await r.list()).map(s=>s.name),['alpha.example.com','Finance team','gamma.example.com'],'only the renamed server changes');
  await assert.rejects(r.call('musterServer.rename',{serverId:b!.id,name:'   '}),/name/i,'a blank name is refused');

  await r.call('musterServer.disconnect',{serverId:a!.id});
  let list=await r.list();
  assert.deepEqual(list.map(s=>[s.name,s.url]),[['alpha.example.com','https://alpha.example.com'],['Finance team','https://beta.example.com'],['gamma.example.com','https://gamma.example.com']],'a disconnected server keeps its name and address in the list');
  assert.equal(list[0]!.state,'disconnected');
  assert.equal(list[0]!.account,null,'and forgets who was signed in');
  assert.equal([...r.secrets.values.values()].includes(ALPHA.token),false,'its token is forgotten');
  assert.deepEqual([...r.secrets.values.values()].sort(),[BETA.token,GAMMA.token].sort(),'the other tokens stay');
  await r.call('musterServer.check',{});
  assert.deepEqual((await r.list()).map(s=>s.state),['disconnected','online','online'],'the other two are still online');
  const {projects}=await r.call<{projects:MusterServerProject[]}>('musterServer.projects');
  assert.deepEqual(projects.map(p=>p.name).sort(),['Billing','Payroll','Research'],'the others still list their projects');

  // Re-authenticate signs the same entry back in (same id, same name), not a new one.
  await connectPassword(r,ALPHA,{serverId:a!.id});
  list=await r.list();
  assert.deepEqual(list.map(s=>s.id),[a!.id,b!.id,g!.id]);
  assert.equal(list[0]!.account,'Olivia Owner (@olivia)');

  const out=await r.call<{servers:MusterServerEntryView[]}>('musterServer.remove',{serverId:g!.id});
  assert.deepEqual(out.servers.map(s=>s.id),[a!.id,b!.id],'removed from the list');
  assert.equal([...r.secrets.values.values()].includes(GAMMA.token),false,'its token is deleted from the secret store');
  assert.equal(JSON.parse(await readFile(join(dir,'servers.json'),'utf8')).servers.length,2,'and from the file');
  const after=await r.call<{projects:MusterServerProject[]}>('musterServer.projects');
  assert.deepEqual(after.projects.map(p=>[p.serverName,p.name]).sort(),[['Finance team','Billing'],['Finance team','Payroll'],['alpha.example.com','Support desk']]);
  await assert.rejects(r.call('musterServer.remove',{serverId:g!.id}),/no longer in the list|Unknown server/i);
});

// Spec: MUS-SPEC-13-803C (docs/spec/clauses/13-muster-server.md#mus-spec-13-803c)
test('projects from every connected server are listed at once and labelled with their server',async t=>{
  const dir=await home(t),servers=fakeServers([ALPHA,BETA]),r=runtime(t,dir,servers);
  await connectPassword(r,ALPHA);await connectPassword(r,BETA);
  const [a,b]=await r.list();
  const all=await r.call<{projects:MusterServerProject[];errors:unknown[]}>('musterServer.projects');
  assert.deepEqual(all.projects.map(p=>[p.serverId,p.serverName,p.name,p.openUrl]),[
    [a!.id,'alpha.example.com','Support desk','https://alpha.example.com/?project=a1'],
    [b!.id,'beta.example.com','Billing','https://beta.example.com/?project=b1'],
    [b!.id,'beta.example.com','Payroll','https://beta.example.com/?project=b2'],
  ]);
  assert.deepEqual(all.errors,[]);
  const one=await r.call<{projects:MusterServerProject[]}>('musterServer.projects',{serverId:b!.id});
  assert.deepEqual(one.projects.map(p=>p.name),['Billing','Payroll'],'one server, when asked for one');
  // Projects, Roster and Inbox sync from one server at a time, and say which.
  const list=await r.list();
  assert.deepEqual(list.map(s=>s.workspace),[true,false],'the first server added feeds Projects, Roster and Inbox');
  let ws=await r.call<{serverId:string;serverName:string;baseUrl:string;hasToken:boolean}>('paperclip.config.get');
  assert.deepEqual([ws.serverId,ws.serverName,ws.baseUrl,ws.hasToken],[a!.id,'alpha.example.com','https://alpha.example.com',true]);
  await r.call('musterServer.useForWorkspace',{serverId:b!.id});
  ws=await r.call('paperclip.config.get');
  assert.deepEqual([ws.serverId,ws.serverName,ws.baseUrl,ws.hasToken],[b!.id,'beta.example.com','https://beta.example.com',true],'choosing another server moves the sync there');
  assert.deepEqual((await r.list()).map(s=>s.workspace),[false,true]);
  assert.equal((await r.list()).every(s=>s.account),true,'switching the sync signs nobody out');
  assert.ok(r.events.some(e=>(e as {type:string}).type==='projectsWorkspaceChanged'),'the screens are told to read the other server');
});

// Spec: MUS-SPEC-13-803D (docs/spec/clauses/13-muster-server.md#mus-spec-13-803d)
test('an existing single-server setup moves into the list on first launch with nothing lost',async t=>{
  const dir=await home(t),servers=fakeServers([ALPHA]);
  const old={version:2,mode:'custom',baseUrl:ALPHA.origin,companyId:'muster-server',backend:'muster-server',tokenOrigin:ALPHA.origin,tokenSecret:LEGACY_MUSTER_SERVER_SECRET,
    user:ALPHA.user,serverVersion:'0.3.0',connectedAt:'2026-10-01T00:00:00.000Z',signedIn:null,signInNotice:null,sessionOrigin:null,
    orgs:{'muster-server':{enabled:true,sidebar:'all'}},me:{id:'u-olivia',name:'Olivia Owner',origin:ALPHA.origin}};
  const text=JSON.stringify(old,null,2);
  await writeFile(join(dir,'server.json'),text);
  const secrets=secretsFake({[LEGACY_MUSTER_SERVER_SECRET]:ALPHA.token});
  const r=runtime(t,dir,servers,secrets);
  const list=await r.list();
  assert.equal(list.length,1,'the one server becomes the first entry');
  assert.deepEqual([list[0]!.url,list[0]!.account,list[0]!.kind,list[0]!.workspace,list[0]!.state==='disconnected'],[ALPHA.origin,'Olivia Owner (@olivia)','muster-server',true,false]);
  const file=JSON.parse(await readFile(join(dir,'servers.json'),'utf8'));
  assert.equal(file.servers[0].config.tokenSecret,LEGACY_MUSTER_SERVER_SECRET,'the token stays in its keychain entry: nothing is copied or re-encrypted');
  assert.deepEqual(file.servers[0].config.orgs,old.orgs,'org ticks and sidebar choices are kept');
  assert.deepEqual(file.servers[0].config.me,old.me,'who this Mac is signed in as is kept');
  assert.equal(file.workspace,file.servers[0].id);
  assert.equal(await readFile(join(dir,'server.json'),'utf8'),text,'server.json is left as it was (a downgrade still finds it)');
  const ws=await r.call<{baseUrl:string;hasToken:boolean;user:{username:string};companyId:string}>('paperclip.config.get');
  assert.deepEqual([ws.baseUrl,ws.hasToken,ws.user.username,ws.companyId],[ALPHA.origin,true,'olivia','muster-server'],'Projects, Roster and Inbox read the same server, signed in');
  const {projects}=await r.call<{projects:MusterServerProject[]}>('musterServer.projects');
  assert.deepEqual(projects.map(p=>p.name),['Support desk']);
  assert.ok(servers.calls.filter(c=>c.auth).every(c=>c.origin===ALPHA.origin&&c.auth===`Bearer ${ALPHA.token}`),'the very same token, to its own origin, no new sign-in');
  // A second start reads servers.json and does not migrate again (or duplicate the entry).
  const again=runtime(t,dir,servers,secrets);
  assert.deepEqual((await again.list()).map(s=>s.id),[list[0]!.id]);
});

// Spec: MUS-SPEC-13-803E (docs/spec/clauses/13-muster-server.md#mus-spec-13-803e)
test('an unreachable server shows its own error and a retry, and the others stay usable',async t=>{
  const dir=await home(t),servers=fakeServers([ALPHA,BETA]),r=runtime(t,dir,servers);
  await connectPassword(r,ALPHA);await connectPassword(r,BETA);
  const [a,b]=await r.list();
  servers.down.add(BETA.origin);
  await r.call('musterServer.check',{});
  let list=await r.list();
  assert.deepEqual(list.map(s=>s.state),['online','unreachable']);
  assert.equal(list[0]!.error,null);
  assert.match(list[1]!.error??'',/beta\.example\.com/,'the error names the server that failed');
  const partial=await r.call<{projects:MusterServerProject[];errors:Array<{serverId:string;serverName:string;message:string}>}>('musterServer.projects');
  assert.deepEqual(partial.projects.map(p=>p.name),['Support desk'],'the reachable server still lists its projects');
  assert.deepEqual(partial.errors.map(e=>[e.serverId,e.serverName]),[[b!.id,'beta.example.com']],'only the failing server reports an error');
  assert.equal((await r.list())[0]!.state,'online','one failing server does not mark the others');
  // Retry checks just that server.
  servers.down.delete(BETA.origin);
  const before=servers.calls.filter(c=>c.origin===ALPHA.origin).length;
  await r.call('musterServer.check',{serverId:b!.id});
  assert.equal(servers.calls.filter(c=>c.origin===ALPHA.origin).length,before,'retrying one server does not touch the others');
  list=await r.list();
  assert.deepEqual(list.map(s=>[s.id,s.state,s.error]),[[a!.id,'online',null],[b!.id,'online',null]]);
  assert.deepEqual((await r.call<{projects:MusterServerProject[]}>('musterServer.projects')).projects.map(p=>p.name),['Support desk','Billing','Payroll']);
});
