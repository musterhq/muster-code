/**
 * #654: no swap on top of the memory limit, a configurable disk limit for /workspace plus the writable layer, and
 * sandbox cleanup when a chat is deleted (destroyed) or archived (stopped).
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmod,mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {test,type TestContext} from 'node:test';
import {ScopedComputers,type ComputerBackend,type ComputerCore,type ComputerDescriptor,type ComputerHandle,type ScopedComputerOptions} from '../src/runtime/scoped-computers.ts';
import {grantLimits,savedLimits,validLimits} from '../src/runtime/scoped-computer-extras.ts';
import type {DockerResult,SandboxRunner,SandboxStream} from '../src/runtime/sandbox-exec.ts';
import {createDomainHooks} from '../src/runtime/domains/hooks.ts';
import {createSandboxDomain} from '../src/runtime/domains/sandbox.ts';
import type {DomainContext} from '../src/runtime/domains/types.ts';
import {registerAgentSandboxHost} from '../src/runtime/sandbox-registry.ts';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';
import type {Chat} from '../src/shared/protocol.ts';
import {SCOPED_COMPUTER_DEFAULT_LIMITS,type ScopedComputerRef} from '../src/shared/scoped-computer-protocol.ts';

// Loaded by path (not a static import) so the app typecheck does not pull in the vendored core's own sources.
const VENDOR_SANDBOX='../vendor/muster-sandbox/packages/core/src/local-docker-sandbox.ts';
const {LocalDockerSandbox,SANDBOX_DEFAULT_DISK_MIB,sandboxResourceArgs}=await import(VENDOR_SANDBOX) as {
  LocalDockerSandbox:new(options:{dockerBin:string})=>{provision(descriptor:unknown):Promise<{id:string}>};
  SANDBOX_DEFAULT_DISK_MIB:number;
  sandboxResourceArgs(descriptor:unknown,options?:{storageQuota?:boolean}):string[];
};
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const GiB=1024**3;
const descriptor=(limits:Record<string,unknown>,workDir='/tmp/x/runtimes/session/abc')=>({owner:{kind:'session',id:'i:chat:a'},root:'/tmp/x/runtimes',workDir,manifestPath:join(workDir,'runtime-manifest.json'),envAllowlist:[],toolPolicy:['computer.exec'],limits:{networkAccess:'none',...limits},policyDigest:'sha256:fixture'}) as any;
const flag=(args:string[],name:string)=>args[args.indexOf(name)+1];

/* ---------- docker run arguments (vendor core) ---------- */

test('docker run gets --memory-swap equal to --memory, so there is no swap on top', ()=>{
  for(const memoryMib of [undefined,256,2048]){
    const args=sandboxResourceArgs(descriptor(memoryMib?{memoryMib}:{}));
    assert.equal(flag(args,'--memory-swap'),flag(args,'--memory'));
    assert.equal(flag(args,'--memory'),`${memoryMib??512}m`);
    assert.ok(!args.includes('--storage-opt'),'no storage quota unless asked');
  }
  assert.equal(flag(sandboxResourceArgs(descriptor({}),{storageQuota:true}),'--storage-opt'),`size=${SANDBOX_DEFAULT_DISK_MIB}m`);
  assert.equal(SANDBOX_DEFAULT_DISK_MIB,10240);
  assert.equal(flag(sandboxResourceArgs(descriptor({maxDiskMb:2048}),{storageQuota:true}),'--storage-opt'),'size=2048m');
});

test('provision asks for a storage quota and retries without it when the driver refuses', async t=>{
  const dir=await mkdtemp(join(tmpdir(),'sbx-storage-opt-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const log=join(dir,'calls.log'),bin=join(dir,'docker');
  // A fake docker CLI: nothing exists yet; `run` with --storage-opt fails the way overlay2 on ext4 does.
  await writeFile(bin,`#!/bin/sh
echo "$*" >> "${log}"
case "$1" in
  inspect) echo "Error: No such object: $4" >&2; exit 1;;
  run) case "$*" in *--storage-opt*) echo "docker: Error response from daemon: --storage-opt is supported only for overlay over xfs with 'pquota' mount option." >&2; exit 125;; esac; echo deadbeef; exit 0;;
  *) exit 0;;
esac
`);await chmod(bin,0o755);
  const sandbox=new LocalDockerSandbox({dockerBin:bin});
  const first=descriptor({memoryMib:1024},join(dir,'runtimes','session','one'));
  const handle=await sandbox.provision(first);
  assert.match(handle.id,/^muster-sbx-one$/);
  const runs=(await readFile(log,'utf8')).trim().split('\n').filter(line=>line.startsWith('run ')||line.startsWith('rm '));
  assert.equal(runs.length,3,runs.join('\n'));
  assert.match(runs[0],/--storage-opt size=10240m/);assert.match(runs[0],/--memory 1024m --memory-swap 1024m/);
  assert.equal(runs[1],'rm -f muster-sbx-one');
  assert.doesNotMatch(runs[2],/--storage-opt/);assert.match(runs[2],/--memory 1024m --memory-swap 1024m/);
  assert.ok(existsSync(join(first.workDir,'.sandbox','sandbox-registry.json')));
  // The refusal is remembered: the next sandbox does not try again.
  await writeFile(log,'');await sandbox.provision(descriptor({},join(dir,'runtimes','session','two')));
  const next=(await readFile(log,'utf8')).trim().split('\n').filter(line=>line.startsWith('run '));
  assert.equal(next.length,1);assert.doesNotMatch(next[0],/--storage-opt/);assert.match(next[0],/--memory 512m --memory-swap 512m/);
});

/* ---------- limits plumbing ---------- */

test('the disk limit defaults to 10 GB, is configurable, and stays out of old records and policy digests', ()=>{
  assert.equal(SCOPED_COMPUTER_DEFAULT_LIMITS.diskGiB,10);
  assert.ok(validLimits({memoryMiB:512,cpus:1,processes:256}),'a record saved before the disk limit existed still loads');
  assert.ok(validLimits({memoryMiB:512,cpus:1,processes:256,diskGiB:20}));
  assert.ok(!validLimits({memoryMiB:512,cpus:1,processes:256,diskGiB:0}));
  assert.ok(!validLimits({memoryMiB:512,cpus:1,processes:256,diskGiB:1.5}));
  assert.deepEqual(savedLimits({...SCOPED_COMPUTER_DEFAULT_LIMITS}),{memoryMiB:512,cpus:1,processes:256});
  assert.deepEqual(savedLimits({...SCOPED_COMPUTER_DEFAULT_LIMITS,diskGiB:2}),{memoryMiB:512,cpus:1,processes:256,diskGiB:2});
  assert.equal('maxDiskMb' in grantLimits({...SCOPED_COMPUTER_DEFAULT_LIMITS},[]),false,'default disk leaves existing containers’ policy digest unchanged');
  assert.equal(grantLimits({...SCOPED_COMPUTER_DEFAULT_LIMITS,diskGiB:2},[]).maxDiskMb,2048);
});

/* ---------- ScopedComputers fixture ---------- */

class Runner implements SandboxRunner {
  sizeRw=0;kills:number[]=[];calls:string[][]=[];private next=100;
  procs:{command:string;pgid:number;finish:(code:number|null)=>void;ended:boolean;out:(stream:SandboxStream,data:string)=>void}[]=[];
  exec(_container:string,command:string,{onOutput}:{onOutput:(stream:SandboxStream,data:string)=>void}) {
    let resolve!:(value:{exitCode:number|null})=>void;const done=new Promise<{exitCode:number|null}>(r=>{resolve=r;});
    const proc={command,pgid:this.next++,ended:false,out:onOutput,finish:(code:number|null)=>{if(proc.ended)return;proc.ended=true;resolve({exitCode:code});}};this.procs.push(proc);
    if(command==='true')setImmediate(()=>proc.finish(0));
    return {pgid:Promise.resolve(proc.pgid),done,write:()=>true,end:()=>proc.finish(0),detach:()=>proc.finish(143)};
  }
  async killGroup(_container:string,pgid:number):Promise<DockerResult> {this.kills.push(pgid);this.procs.find(p=>p.pgid===pgid)?.finish(143);return {code:0,stdout:'',stderr:''};}
  async docker(args:string[]):Promise<DockerResult> {
    this.calls.push(args);
    if(args[0]==='image')return {code:0,stdout:'sha256:x',stderr:''};
    if(args[0]==='ps')return {code:0,stdout:'',stderr:''};
    if(args[0]==='inspect'&&args[1]==='--size')return {code:0,stdout:String(this.sizeRw),stderr:''};
    if(args[0]==='inspect'&&args.includes('{{.State.StartedAt}}'))return {code:0,stdout:'2026-10-18T00:00:00Z',stderr:''};
    if(args[0]==='inspect')return {code:1,stdout:'',stderr:'Error: No such object'};
    return {code:0,stdout:'',stderr:''};
  }
}
async function fixture(t:TestContext,extra:Partial<ScopedComputerOptions>={}) {
  const appData=await mkdtemp(join(tmpdir(),'sbx-disk-'));t.after(()=>rm(appData,{recursive:true,force:true}));
  const calls:{method:string;descriptor?:ComputerDescriptor}[]=[],grants:Record<string,unknown>[]=[];
  const running=new Map<string,boolean>(),runner=new Runner();
  const idFor=(d:ComputerDescriptor)=>`muster-sbx-${d.workDir.split('/').at(-1)}`;
  class Backend implements ComputerBackend {
    readonly lifecycleVersion=1 as const;
    constructor(){calls.push({method:'constructor'});}
    async recoverProvisioning(){return null;}
    async provision(d:ComputerDescriptor){calls.push({method:'provision',descriptor:d});running.set(d.workDir,true);await mkdir(join(d.workDir,'workspace'),{recursive:true});await mkdir(join(d.workDir,'.sandbox'),{recursive:true});return {id:idFor(d),ownerDigest:`sha256:${digest(`${d.owner.kind}:${d.owner.id}`)}`,image:'fixture',createdAt:'now'};}
    async inspect(_h:ComputerHandle,d:ComputerDescriptor){calls.push({method:'inspect',descriptor:d});return {running:running.get(d.workDir)??false,exitCode:0};}
    async stop(_h:ComputerHandle,d:ComputerDescriptor){calls.push({method:'stop',descriptor:d});running.set(d.workDir,false);for(const proc of runner.procs)proc.finish(137);}
    async destroy(_h:ComputerHandle,d:ComputerDescriptor){calls.push({method:'destroy',descriptor:d});running.delete(d.workDir);for(const proc of runner.procs)proc.finish(137);}
    async run():Promise<never>{throw new Error('unused');}
  }
  const core:ComputerCore={LocalDockerSandbox:Backend,resolveScopedRuntime(scopes,config){const owner=scopes[0],workDir=join(config.rootDir,owner.kind,digest(owner.id)),grant=config.grants[0];grants.push({...grant.limits});return {owner,root:config.rootDir,workDir,manifestPath:join(workDir,'runtime-manifest.json'),envAllowlist:[],toolPolicy:['computer.exec'],limits:{...grant.limits},policyDigest:`fixture-${JSON.stringify(grant.limits)}`};},async ensureRuntime(d){await mkdir(d.workDir,{recursive:true});}};
  const manager=new ScopedComputers({appData,loadCore:async()=>core,runner,killGraceMs:30,diskCheckMs:20,serviceBackoffMs:10,dockerHost:'unix:///tmp/fixture.sock',resolveScope:scope=>({...scope,label:scope.id}),...extra});
  t.after(()=>manager.dispose().catch(()=>{}));
  const workDir=()=>calls.find(call=>call.method==='provision')!.descriptor!.workDir;
  return {manager,appData,calls,grants,runner,running,workDir,count:(method:string)=>calls.filter(call=>call.method===method).length};
}
const chatScope={kind:'chat' as const,id:'a'};
async function settled(manager:ScopedComputers,scope:ScopedComputerRef,id:string){for(let i=0;i<400;i++){const r=await manager.execution(scope,id);if(r.state!=='running')return r;await delay(5);}throw new Error('did not settle');}

test('a limits change to the disk ceiling is applied like the others, and legacy records load with 10 GB', async t=>{
  const f=await fixture(t);
  const started=await f.manager.start(chatScope);assert.equal(started.limits.diskGiB,10);
  const record=join(f.appData,'scoped-computers',`${started.id}.json`);
  assert.deepEqual(JSON.parse(await readFile(record,'utf8')).limits,{memoryMiB:512,cpus:1,processes:256},'the default disk limit is not written');
  await assert.rejects(f.manager.setLimits(chatScope,{diskGiB:0}),/Disk must be between 1 and 512/);
  const changed=await f.manager.setLimits(chatScope,{diskGiB:2});
  assert.equal(changed.limits.diskGiB,2);assert.equal(f.count('destroy'),1,'the container is recreated');assert.equal(f.grants.at(-1)!.maxDiskMb,2048);
  assert.equal(JSON.parse(await readFile(record,'utf8')).limits.diskGiB,2);
});

test('sandbox_write past the disk limit is refused with a plain message; freeing writes still work', async t=>{
  const f=await fixture(t);await f.manager.start(chatScope);await f.manager.setLimits(chatScope,{diskGiB:1});
  const target=f.manager.agentTarget(chatScope);
  await target.write('small.txt','x'.repeat(1000));
  assert.equal(await readFile(join(f.workDir(),'workspace','small.txt'),'utf8'),'x'.repeat(1000));
  // The container's writable layer counts too: fill it to just under 1 GB.
  f.runner.sizeRw=GiB-2000;await delay(2100);
  await assert.rejects(target.write('big.txt','y'.repeat(4000)),/This write was refused: it would take the sandbox past its 1 GB disk limit \(it already uses 1\.00 GB\)\. Delete files in \/workspace, or raise the Disk limit/);
  assert.equal(existsSync(join(f.workDir(),'workspace','big.txt')),false,'nothing was written');
  await target.write('small.txt','x');assert.equal(await readFile(join(f.workDir(),'workspace','small.txt'),'utf8'),'x','a write that shrinks a file is allowed');
});

test('a command that grows the sandbox past its disk limit is stopped with a notice; new commands are refused', async t=>{
  const f=await fixture(t);await f.manager.start(chatScope);await f.manager.setLimits(chatScope,{diskGiB:1});
  const {executionId}=await f.manager.exec({scope:chatScope,command:'wait',requestId:'grow'});
  await delay(60);assert.equal((await f.manager.execution(chatScope,executionId)).state,'running','under the limit it keeps running');
  f.runner.sizeRw=GiB+1;
  const result=await settled(f.manager,chatScope,executionId);
  assert.equal(result.state,'cancelled');assert.equal(result.computerStopped,false);
  assert.match(result.reason??'',/^Stopped: the sandbox went past its 1 GB disk limit/);
  assert.match(result.stderr,/Stopped: the sandbox went past its 1 GB disk limit/);
  assert.equal(f.runner.kills.length,1,'only its process group was killed');assert.equal((await f.manager.inspect(chatScope)).state,'running');
  await assert.rejects(f.manager.exec({scope:chatScope,command:'true',requestId:'after'}),/over its 1 GB disk limit .*no new command was started/);
  f.runner.sizeRw=0;
  const ok=await f.manager.exec({scope:chatScope,command:'true',requestId:'freed'});assert.equal((await settled(f.manager,chatScope,ok.executionId)).state,'completed','after freeing space commands run again');
});

test('a background service that grows past the disk limit is stopped and not restarted', async t=>{
  const f=await fixture(t);await f.manager.start(chatScope);await f.manager.setLimits(chatScope,{diskGiB:1});
  const service=await f.manager.servicesRegister(chatScope,{name:'writer',command:'wait',restart:'always'},true);
  assert.equal(service.state,'running');
  f.runner.sizeRw=2*GiB;
  let state;for(let i=0;i<200;i++){state=(await f.manager.servicesList(chatScope)).services[0];if(state.state!=='running')break;await delay(10);}
  assert.equal(state!.state,'stopped');assert.match(state!.reason??'',/^Stopped: the sandbox went past its 1 GB disk limit \(it uses 2\.00 GB\)/);
  await delay(80);assert.equal((await f.manager.servicesList(chatScope)).services[0].state,'stopped','its restart policy does not bring it back');
});

test('the usage meter reports disk use against the limit', async t=>{
  const f=await fixture(t);await f.manager.start(chatScope);f.runner.sizeRw=3*1024**2;
  await writeFile(join(f.workDir(),'workspace','a.bin'),Buffer.alloc(1024));
  const usage=await f.manager.usage(chatScope);
  assert.equal(usage.diskBytes,3*1024**2+1024);assert.equal(usage.diskLimitBytes,10*GiB);
});

test('releaseScope: stop keeps the container and files; destroy removes the container, workspace and saved state', async t=>{
  const f=await fixture(t);
  await f.manager.releaseScope(chatScope,'destroy');assert.equal(f.calls.length,0,'a chat that never had a sandbox needs no core or Docker');
  const started=await f.manager.start(chatScope);const work=f.workDir();
  await writeFile(join(work,'workspace','keep.txt'),'kept');
  await f.manager.releaseScope(chatScope,'stop');
  assert.equal((await f.manager.inspect(chatScope)).state,'stopped');assert.equal(f.count('destroy'),0);assert.equal(await readFile(join(work,'workspace','keep.txt'),'utf8'),'kept');
  const {executionId}=await f.manager.start(chatScope).then(()=>f.manager.exec({scope:chatScope,command:'wait',requestId:'busy'}));
  await f.manager.releaseScope(chatScope,'destroy');
  assert.equal((await f.manager.execution(chatScope,executionId).catch(()=>({state:'gone'}))).state,'cancelled','the running command was ended first');
  assert.equal(f.count('destroy'),1);assert.equal(existsSync(work),false,'workspace and runtime folder are deleted');
  const left=await readdir(join(f.appData,'scoped-computers'));assert.ok(!left.some(name=>name.startsWith(started.id)),`no saved state left: ${left.join(', ')}`);
  assert.equal((await f.manager.inspect(chatScope)).state,'not-created');
});

/* ---------- sandbox domain: delete and archive ---------- */

const chat=(id:string,extra:Partial<Chat>={}):Chat=>({id,title:id,pinned:false,archived:false,draft:'',status:'idle',updatedAt:'now',model:'m',mode:'agent',permissionMode:'workspace',folderId:'f1',...extra} as Chat);
async function domainFixture(t:TestContext,chats:Chat[]) {
  const db=new DatabaseSync(':memory:');const store=new Map(chats.map(c=>[c.id,c]));
  t.after(()=>{db.close();registerAgentSandboxHost(undefined);});
  const released:[string,string,string][]=[];let fail=false;
  const host={async agentWorkspace(){return {hostPath:'/tmp/none',running:true};},async agentToolsLauncher(){return '/tmp/launcher';},
    async releaseScope(scope:ScopedComputerRef,mode:'stop'|'destroy'){if(fail)throw new Error('Docker Desktop is not running. Start it, then try again. Workspace files are kept.');released.push([scope.kind,scope.id,mode]);}};
  registerAgentSandboxHost(host);
  const runtime=createDomainHooks();
  const ctx={dataDir:'/tmp',db:()=>db,hooks:runtime.hooks,emit(){},emitSnapshot(){},folderFor:(id:string)=>({id,name:'p',path:'/tmp'}),
    store:{chat:(id:string)=>store.get(id),snapshot:()=>({chats:[...store.values()]})},
    invoke:async(_c:string,input:{id:string;permissionMode:Chat['permissionMode']})=>{store.set(input.id,{...store.get(input.id)!,permissionMode:input.permissionMode});return store.get(input.id);}} as unknown as DomainContext;
  const domain=createSandboxDomain(ctx);t.after(()=>domain.dispose?.());
  const envRow=(id:string)=>db.prepare('SELECT env FROM chat_environments WHERE chat_id = ?').get(id) as {env:string}|undefined;
  return {runtime,store,released,envRow,setFail:(value:boolean)=>{fail=value;},call:(command:string,input:unknown)=>domain.handlers[command]!(input as Record<string,unknown>) as Promise<any>};
}

test('deleting a sandboxed chat destroys its sandbox and clears its environment row; archiving only stops it', async t=>{
  const f=await domainFixture(t,[chat('c1'),chat('c2')]);
  for(const id of ['c1','c2'])await f.call('sandbox.chatEnvironment.set',{chatId:id,env:'sandbox',mode:'copy'});
  assert.equal(f.envRow('c1')?.env,'sandbox');
  await f.runtime.chatRemoval({chat:f.store.get('c2')!,kind:'archive'});
  assert.deepEqual(f.released,[['chat','c2','stop']]);assert.equal(f.envRow('c2')?.env,'sandbox','archiving keeps the environment');
  await f.runtime.chatRemoval({chat:f.store.get('c1')!,kind:'delete'});
  assert.deepEqual(f.released.at(-1),['chat','c1','destroy']);assert.equal(f.envRow('c1'),undefined,'the chat_environments row is gone');
});

test('a project sandbox is left alone while other chats in the project use it, and is never destroyed by a chat', async t=>{
  const f=await domainFixture(t,[chat('p1',{projectId:'proj'}),chat('p2',{projectId:'proj'}),chat('p3',{projectId:'proj',archived:true}),chat('solo')]);
  await f.runtime.chatRemoval({chat:f.store.get('p1')!,kind:'delete'});
  assert.deepEqual(f.released,[['chat','p1','destroy']],'p2 still uses the project sandbox');
  f.store.delete('p1');
  await f.runtime.chatRemoval({chat:f.store.get('p2')!,kind:'archive'});
  assert.deepEqual(f.released.at(-1),['project','proj','stop'],'the last live chat archived: the project sandbox stops');
  f.released.length=0;f.store.set('p2',{...f.store.get('p2')!,archived:true});
  await f.runtime.chatRemoval({chat:f.store.get('p2')!,kind:'delete'});
  assert.deepEqual(f.released,[['chat','p2','destroy'],['project','proj','stop']]);
  assert.ok(!f.released.some(([kind,,mode])=>kind==='project'&&mode==='destroy'));
});

test('a sandbox that cannot be removed keeps the chat on delete; archive never fails', async t=>{
  const f=await domainFixture(t,[chat('c1')]);await f.call('sandbox.chatEnvironment.set',{chatId:'c1',env:'sandbox',mode:'copy'});f.setFail(true);
  await assert.rejects(f.runtime.chatRemoval({chat:f.store.get('c1')!,kind:'delete'}),/This chat's sandbox could not be removed, so the chat was kept\. Docker Desktop is not running/);
  assert.equal(f.envRow('c1')?.env,'sandbox','nothing was forgotten');
  await f.runtime.chatRemoval({chat:f.store.get('c1')!,kind:'archive'});
});

/* ---------- service: delete and archive reach the sandbox ---------- */

test('chat.delete releases the chat sandbox before the chat is removed; archive stops it in the background', async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'sbx-service-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const provider:ProviderAdapter={info:()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'m',name:'M'}]}],run:async()=>({status:'completed',finalMessage:'ok'}),stop:async()=>true,dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const released:string[]=[];let fail=false;
  registerAgentSandboxHost({async agentWorkspace(){return {hostPath:dataDir,running:true};},async agentToolsLauncher(){return '/tmp/launcher';},
    async releaseScope(scope,mode){const exists=(await service.invoke('app.snapshot',undefined)).chats.some(c=>c.id===scope.id);if(fail)throw new Error('Docker Desktop is not running.');released.push(`${scope.kind}:${scope.id}:${mode}:${exists?'present':'missing'}`);}});
  t.after(()=>registerAgentSandboxHost(undefined));
  const kept=await service.invoke('chat.create',{}),gone=await service.invoke('chat.create',{});
  await service.invoke('chat.update',{id:kept.id,archived:true});
  for(let i=0;i<100&&!released.length;i++)await delay(5);
  assert.deepEqual(released,[`chat:${kept.id}:stop:present`]);
  fail=true;
  await assert.rejects(service.invoke('chat.delete',{id:gone.id}),/could not be removed, so the chat was kept/);
  assert.ok((await service.invoke('app.snapshot',undefined)).chats.some(c=>c.id===gone.id),'the chat is kept when its sandbox cannot be removed');
  fail=false;
  await service.invoke('chat.delete',{id:gone.id});
  assert.deepEqual(released.at(-1),`chat:${gone.id}:destroy:present`,'released while the chat still existed');
  assert.ok(!(await service.invoke('app.snapshot',undefined)).chats.some(c=>c.id===gone.id));
});
