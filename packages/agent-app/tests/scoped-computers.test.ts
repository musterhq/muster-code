import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {test,type TestContext} from 'node:test';
import {adaptBundledComputerCore,ScopedComputers,type ComputerBackend,type ComputerCore,type ComputerDescriptor,type ComputerHandle,type ScopedComputerOptions} from '../src/runtime/scoped-computers.ts';
import {ENSURE_USER_SCRIPT,SANDBOX_IMAGE,type DockerResult,type SandboxRunner,type SandboxStream} from '../src/runtime/sandbox-exec.ts';
import type {ScopedComputerEvent,ScopedComputerRef} from '../src/shared/scoped-computer-protocol.ts';
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const a={kind:'chat' as const,id:'a'},b={kind:'project' as const,id:'b'},c={kind:'project' as const,id:'c'};

/** In-memory docker: `exec` commands are scripted by name; killGroup ends only the matching group. */
class FakeRunner implements SandboxRunner {
  calls:string[][]=[];kills:{container:string;pgid:number}[]=[];
  procs:{container:string;command:string;pgid:number;finish:(code:number|null)=>void;ended:boolean}[]=[];
  running=new Set<string>();stubborn=false;imagePresent=true;pullCode=0;inspectError='';orphan='';private next=100;
  exec(container:string,command:string,{onOutput}:{onOutput:(stream:SandboxStream,data:string)=>void}) {
    let resolve!:(value:{exitCode:number|null})=>void;const done=new Promise<{exitCode:number|null}>(r=>{resolve=r;});
    const proc={container,command,pgid:this.next++,ended:false,finish:(code:number|null)=>{if(proc.ended)return;proc.ended=true;resolve({exitCode:code});}};this.procs.push(proc);
    setImmediate(()=>{
      if(command==='large'){onOutput('stdout','a'.repeat(80_000));onOutput('stderr','b'.repeat(80_000));proc.finish(0);}
      else if(command.startsWith('echo:')){onOutput('stdout',command.slice(5));setTimeout(()=>{onOutput('stderr','warn\n');proc.finish(0);},150);}
      else if(command==='fail')proc.finish(3);
    });
    return {pgid:Promise.resolve(proc.pgid),done,write:(data:string)=>{onOutput('stdout',data);return true;},end:()=>proc.finish(0),detach:()=>proc.finish(143)};
  }
  async killGroup(container:string,pgid:number):Promise<DockerResult> {this.kills.push({container,pgid});if(!this.stubborn)this.procs.find(p=>p.pgid===pgid&&p.container===container)?.finish(143);return {code:0,stdout:'',stderr:''};}
  endContainer(container:string){for(const proc of this.procs)if(proc.container===container)proc.finish(137);}
  async docker(args:string[],options:{onLine?:(line:string)=>void}={}):Promise<DockerResult> {
    this.calls.push(args);
    if(args[0]==='image')return this.inspectError?{code:1,stdout:'',stderr:this.inspectError}:this.imagePresent?{code:0,stdout:'sha256:x',stderr:''}:{code:1,stdout:'',stderr:'Error: No such image'};
    if(args[0]==='pull'){for(const line of ['aaaaaaaaaaaa: Pulling fs layer','bbbbbbbbbbbb: Pulling fs layer','aaaaaaaaaaaa: Pull complete'])options.onLine?.(line);await delay(260);options.onLine?.('bbbbbbbbbbbb: Pull complete');if(!this.pullCode)this.imagePresent=true;return {code:this.pullCode,stdout:'',stderr:this.pullCode?'pull access denied':''};}
    if(args[0]==='ps')return {code:0,stdout:[...this.running].join('\n'),stderr:''};
    if(args[0]==='inspect')return this.orphan?{code:0,stdout:this.orphan,stderr:''}:{code:1,stdout:'',stderr:'Error: No such object'};
    if(args[0]==='rm'){this.orphan='';return {code:0,stdout:'',stderr:''};}
    if(args[0]==='cp'){await writeFile(args[2],'from-container');return {code:0,stdout:'',stderr:''};}
    return {code:0,stdout:'',stderr:''};
  }
}
async function fixture(t:TestContext,extra:Partial<ScopedComputerOptions>={}){
  const appData=await mkdtemp(join(tmpdir(),'scoped-computers-'));t.after(()=>rm(appData,{recursive:true,force:true}));
  const calls:{method:string;descriptor?:ComputerDescriptor;options?:unknown}[]=[];
  const running=new Map<string,boolean>();const runner=new FakeRunner();let failStop=false;
  const idFor=(descriptor:ComputerDescriptor)=>`muster-sbx-${descriptor.workDir.split('/').at(-1)}`;
  class Backend implements ComputerBackend {
    readonly lifecycleVersion=1 as const;
    async recoverProvisioning(_descriptor:ComputerDescriptor){return null;}
    constructor(options:unknown){calls.push({method:'constructor',options});}
    async provision(descriptor:ComputerDescriptor){calls.push({method:'provision',descriptor});running.set(descriptor.workDir,true);runner.running.add(idFor(descriptor));await mkdir(join(descriptor.workDir,'workspace'),{recursive:true});return {id:idFor(descriptor),ownerDigest:`sha256:${digest(`${descriptor.owner.kind}:${descriptor.owner.id}`)}`,image:'fixture',createdAt:'now'};}
    async inspect(_handle:ComputerHandle,descriptor:ComputerDescriptor){calls.push({method:'inspect',descriptor});return {running:running.get(descriptor.workDir)??false,exitCode:0};}
    async stop(_handle:ComputerHandle,descriptor:ComputerDescriptor){calls.push({method:'stop',descriptor});if(failStop)throw new Error('fixture secret access_token=must-not-leak');running.set(descriptor.workDir,false);runner.running.delete(idFor(descriptor));runner.endContainer(idFor(descriptor));}
    async destroy(_handle:ComputerHandle,descriptor:ComputerDescriptor){calls.push({method:'destroy',descriptor});running.delete(descriptor.workDir);runner.running.delete(idFor(descriptor));runner.endContainer(idFor(descriptor));}
    async run():Promise<never>{throw new Error('streaming exec never uses the one-shot core run');}
  }
  const core:ComputerCore={LocalDockerSandbox:Backend,resolveScopedRuntime(scopes,config){const owner=scopes[0],workDir=join(config.rootDir,owner.kind,digest(owner.id)),grant=config.grants[0];assert.deepEqual(grant.envAllowlist,[]);assert.deepEqual(grant.toolPolicy,['computer.exec']);assert.ok(['none','unrestricted'].includes(grant.limits.networkAccess));return {owner,root:config.rootDir,workDir,manifestPath:join(workDir,'runtime-manifest.json'),envAllowlist:[],toolPolicy:['computer.exec'],limits:{...grant.limits},policyDigest:`fixture-${grant.limits.networkAccess}`};},async ensureRuntime(descriptor){await mkdir(descriptor.workDir,{recursive:true});}};
  let authorized=true;const events:ScopedComputerEvent[]=[];
  const options:ScopedComputerOptions={appData,loadCore:async()=>core,runner,killGraceMs:30,onEvent:event=>events.push(event),resolveScope:(scope:ScopedComputerRef)=>{if(!authorized||!['a','b','c'].includes(scope.id))throw Error('private detail');return {...scope,label:scope.id};},dockerHost:'unix:///tmp/fixture.sock',...extra};
  const manager=new ScopedComputers(options);
  return {manager,options,appData,calls,running,runner,events,count:(method:string)=>calls.filter(call=>call.method===method).length,setFailStop:(value:boolean)=>{failStop=value;},revoke:()=>{authorized=false;}};
}
async function terminal(manager:ScopedComputers,scope:ScopedComputerRef,id:string){for(let i=0;i<100;i++){const result=await manager.execution(scope,id);if(result.state!=='running')return result;await delay(5);}throw Error('fixture did not settle');}

test('authority fails before dependency or path access; view never provisions',async t=>{
  const f=await fixture(t);await assert.rejects(f.manager.inspect({kind:'chat',id:'missing'}),/no longer available/);assert.equal(f.calls.length,0);
  const status=await f.manager.inspect(a);assert.equal(status.state,'not-created');assert.deepEqual(f.calls.map(call=>call.method),['constructor']);assert.equal(f.runner.calls.length,0);
  assert.equal(status.durability,'scratch');assert.equal((await f.manager.inspect(b)).durability,'durable');
  assert.deepEqual(status.limits,{network:'none',memoryMiB:512,cpus:1,processes:256,maxRunning:2,maxTimeoutMs:7_200_000});assert.equal(status.user,'1000:1000');
  const options=f.calls[0].options as any;assert.equal(options.dockerHost,'unix:///tmp/fixture.sock');assert.equal(options.image,SANDBOX_IMAGE);assert.match(SANDBOX_IMAGE,/^node:24-bookworm-slim@sha256:[0-9a-f]{64}$/);await f.manager.dispose();
});
test('bundled QM sandbox contract adapts to Agent Mode lifecycle without changing its ownership calls',async()=>{
  const calls:any[]=[];const result={stdout:'ok',stderr:'',exitCode:0,timedOut:false,cancelled:false,stdoutTruncated:false,stderrTruncated:false};
  class Provider {constructor(options:unknown){calls.push(['constructor',options]);}async provision(...args:any[]){calls.push(['provision',...args]);return {id:'sandbox',ownerDigest:'owner',image:'node',createdAt:'now'};}async reattach(...args:any[]){calls.push(['reattach',...args]);return null;}async inspect(...args:any[]){calls.push(['inspect',...args]);return {running:true,exitCode:null};}async stop(...args:any[]){calls.push(['stop',...args]);}async destroy(...args:any[]){calls.push(['destroy',...args]);}async run(...args:any[]){calls.push(['run',...args]);return result;}}
  const adapted=adaptBundledComputerCore({LocalDockerSandbox:Provider,resolveScopedRuntime(){return {} as any;},ensureRuntime:async()=>({})} as any);
  const backend=new adapted.LocalDockerSandbox({dockerBin:'docker',dockerHost:'unix:///tmp/docker.sock',managementTimeoutMs:3000,durableProvisioning:true,image:SANDBOX_IMAGE});
  const descriptor={} as ComputerDescriptor,handle=await backend.provision(descriptor),controller=new AbortController();
  assert.deepEqual(await backend.recoverProvisioning(descriptor),null);assert.deepEqual(await backend.inspect(handle,descriptor),{running:true,exitCode:null});
  await backend.run(handle,descriptor,'printf ok',{maxBufferBytes:1024,env:{},clientSignal:controller.signal});await backend.stop(handle,descriptor);await backend.destroy(handle,descriptor);
  assert.equal(calls.filter(([method])=>method==='constructor').length,1);assert.equal(calls[0][1].image,SANDBOX_IMAGE,'the pinned image reaches the core provider');assert.deepEqual(calls.find(([method])=>method==='run')?.[4],{maxBufferBytes:1024,env:{},signal:controller.signal});
});
test('scope workspaces survive stop, restart, and container removal without host-folder mounts',async t=>{
  const f=await fixture(t);const first=await f.manager.start(a);assert.equal(first.state,'running');await f.manager.start(b);
  const descriptors=f.calls.filter(call=>call.method==='provision').map(call=>call.descriptor!);assert.notEqual(descriptors[0].workDir,descriptors[1].workDir);assert.ok(descriptors.every(d=>d.workDir.includes('/scoped-computers/runtimes/')));
  const file=join(descriptors[0].workDir,'workspace','durable.txt');await writeFile(file,'retained');assert.equal((await f.manager.stop(a)).state,'stopped');
  const count=f.count('provision');assert.equal((await f.manager.inspect(a)).state,'stopped');assert.equal(f.count('provision'),count);
  const reopened=new ScopedComputers(f.options);assert.equal((await reopened.inspect(a)).id,first.id);assert.equal((await reopened.start(a)).state,'running');assert.equal((await reopened.destroy(a)).state,'not-created');assert.equal(await readFile(file,'utf8'),'retained');
  await f.manager.dispose();await reopened.dispose();
});
test('provision creates the unprivileged user; exec streams through the pinned container name',async t=>{
  const f=await fixture(t);await f.manager.start(a);
  const ensure=f.runner.calls.find(args=>args[0]==='exec')!;assert.deepEqual(ensure.slice(2),['sh','-c',ENSURE_USER_SCRIPT]);assert.match(ensure[1],/^muster-sbx-/);
  const {execId}=await f.manager.dispatch('computer.execStream',{scope:a,command:'echo:hello\n',requestId:'stream'}) as {execId:string};
  await delay(60);const early=f.events.filter(event=>event.type==='computerOutput');
  assert.ok(early.some(event=>event.type==='computerOutput'&&event.execId===execId&&event.stream==='stdout'&&event.data==='hello\n'),'output streams before the command ends');
  assert.ok(!f.events.some(event=>event.type==='computerExecution'));
  const result=await terminal(f.manager,a,execId);assert.equal(result.state,'completed');assert.equal(result.stdout,'hello\n');assert.equal(result.stderr,'warn\n');assert.equal(result.command,'echo:hello\n');
  await delay(5);const done=f.events.find(event=>event.type==='computerExecution');assert.ok(done&&done.type==='computerExecution'&&done.execution.state==='completed');
  assert.equal(f.runner.procs[0].container,ensure[1]);await f.manager.dispose();
});
test('bounded output keeps the latest tail; request replay and execution identity stay in their scope',async t=>{
  const f=await fixture(t);await f.manager.start(a);const receipt=await f.manager.exec({scope:a,command:'large',requestId:'once'});const result=await terminal(f.manager,a,receipt.executionId);assert.equal(result.state,'completed');assert.equal(Buffer.byteLength(result.stdout),65536);assert.ok(result.stderrTruncated&&result.stdoutTruncated);
  assert.deepEqual(await f.manager.exec({scope:a,command:'large',requestId:'once'}),receipt);assert.equal(f.runner.procs.length,1);
  await assert.rejects(f.manager.execution(b,receipt.executionId),/not available/);await assert.rejects(f.manager.cancel(b,receipt.executionId),/not available/);await f.manager.dispose();
});
test('cancel ends only that command’s process group; the sandbox keeps running',async t=>{
  const f=await fixture(t);await f.manager.start(a);const receipt=await f.manager.exec({scope:a,command:'wait',requestId:'waiting'});
  await assert.rejects(f.manager.exec({scope:a,command:'second',requestId:'other'}),/active or unresolved/);
  const cancelled=await f.manager.cancel(a,receipt.executionId);assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.computerStopped,false);
  assert.deepEqual(f.runner.kills,[{container:f.runner.procs[0].container,pgid:f.runner.procs[0].pgid}]);assert.equal(f.count('stop'),0);
  assert.equal((await f.manager.inspect(a)).state,'running');const next=await f.manager.exec({scope:a,command:'fail',requestId:'next'});assert.equal((await terminal(f.manager,a,next.executionId)).state,'failed');await f.manager.dispose();
});
test('timeout ends the command, not the container, and accepts up to two hours',async t=>{
  const f=await fixture(t);await f.manager.start(a);
  await assert.rejects(f.manager.exec({scope:a,command:'wait',requestId:'too-long',timeoutMs:7_200_001}),/2 hours/);
  const receipt=await f.manager.exec({scope:a,command:'wait',requestId:'timeout',timeoutMs:100});await delay(150);const result=await terminal(f.manager,a,receipt.executionId);
  assert.equal(result.state,'timed-out');assert.equal(result.computerStopped,false);assert.equal(f.runner.kills.length,1);assert.equal((await f.manager.inspect(a)).state,'running');await f.manager.dispose();
});
test('a group that ignores the kill falls back to an ownership-checked whole-container stop',async t=>{
  const f=await fixture(t);await f.manager.start(a);f.runner.stubborn=true;const receipt=await f.manager.exec({scope:a,command:'wait',requestId:'stubborn'});
  const result=await f.manager.cancel(a,receipt.executionId);assert.equal(result.state,'cancelled');assert.equal(result.computerStopped,true);assert.equal(f.count('stop'),1);assert.equal((await f.manager.inspect(a)).state,'stopped');await f.manager.dispose();
});
test('failed fallback stop is never reported as confirmed and preserves the execution guard',async t=>{
  const f=await fixture(t);await f.manager.start(a);f.runner.stubborn=true;const receipt=await f.manager.exec({scope:a,command:'wait',requestId:'waiting'});f.setFailStop(true);
  const result=await f.manager.cancel(a,receipt.executionId);assert.equal(result.state,'recovery-needed');assert.equal(result.computerStopped,false);assert.ok(!JSON.stringify(result).includes('must-not-leak'));await assert.rejects(f.manager.exec({scope:a,command:'second',requestId:'other'}),/active or unresolved/);
  f.setFailStop(false);assert.equal((await f.manager.stop(a)).state,'stopped');assert.equal((await f.manager.start(a)).state,'running');await f.manager.exec({scope:a,command:'fail',requestId:'after'});await f.manager.dispose();
});
test('stdin reaches the running command and EOF completes it; other scopes cannot write',async t=>{
  const f=await fixture(t);await f.manager.start(a);await f.manager.start(b);const {executionId}=await f.manager.exec({scope:a,command:'cat',requestId:'stdin'});
  await assert.rejects(f.manager.dispatch('computer.input',{scope:b,execId:executionId,data:'x'}),/not available/);
  await f.manager.dispatch('computer.input',{scope:a,execId:executionId,data:'typed\n'});await f.manager.dispatch('computer.input',{scope:a,execId:executionId,eof:true});
  const result=await terminal(f.manager,a,executionId);assert.equal(result.state,'completed');assert.equal(result.stdout,'typed\n');
  await assert.rejects(f.manager.dispatch('computer.input',{scope:a,execId:executionId,data:'late'}),/already finished/);await f.manager.dispose();
});
test('history keeps the last runs with output tails and shows interrupted work as ended after restart',async t=>{
  const f=await fixture(t);await f.manager.start(a);const done=await f.manager.exec({scope:a,command:'echo:kept\n',requestId:'kept'});await terminal(f.manager,a,done.executionId);
  const live=await f.manager.exec({scope:a,command:'wait',requestId:'interrupted'});await delay(5);
  const reopened=new ScopedComputers(f.options);const runs=await reopened.history(a);
  assert.deepEqual(runs.map(run=>[run.command,run.state,!!run.restored]),[['echo:kept\n','completed',false],['wait','recovery-needed',true]]);assert.equal(runs[0].stdout,'kept\n');
  assert.equal((await reopened.inspect(a)).state,'recovery-needed');assert.equal((await reopened.execution(a,done.executionId)).stdout,'kept\n','restored receipts carry their output tail');
  const ended=await reopened.cancel(a,live.executionId);assert.equal(ended.state,'cancelled');assert.equal(ended.computerStopped,false);assert.equal(f.runner.kills.at(-1)!.pgid,f.runner.procs[1].pgid,'the persisted process group is ended precisely');
  assert.equal((await reopened.inspect(a)).state,'running');assert.equal((await reopened.history(a))[1].state,'cancelled');
  const next=await reopened.exec({scope:a,command:'fail',requestId:'after-restart'});await terminal(reopened,a,next.executionId);
  for(let i=0;i<52;i++){const r=await reopened.exec({scope:a,command:'fail',requestId:`many-${i}`});await terminal(reopened,a,r.executionId);}
  assert.equal((await reopened.history(a)).length,50);await f.manager.dispose();await reopened.dispose();
});
test('controller restart without a known process group still requires an explicit stop',async t=>{
  const f=await fixture(t);await f.manager.start(a);const receipt=await f.manager.exec({scope:a,command:'wait',requestId:'waiting'});await delay(5);
  const {root}={root:join(f.appData,'scoped-computers')};const file=(await readdir(root)).find(name=>/^computer_[0-9a-f]{32}\.json$/.test(name))!;
  const data=JSON.parse(await readFile(join(root,file),'utf8'));delete data.active.pgid;await writeFile(join(root,file),JSON.stringify(data));
  const reopened=new ScopedComputers(f.options);
  assert.equal((await reopened.inspect(a)).state,'recovery-needed');assert.equal((await reopened.start(a)).state,'recovery-needed');assert.deepEqual(await reopened.exec({scope:a,command:'wait',requestId:'waiting'}),receipt);await assert.rejects(reopened.exec({scope:a,command:'other',requestId:'other'}),/active or unresolved/);
  assert.equal((await reopened.stop(a)).state,'stopped');await f.manager.dispose();await reopened.dispose();
});
test('planted workspace symlink is rejected before further Docker operations',async t=>{
  const f=await fixture(t);await f.manager.start(a);const descriptor=f.calls.find(call=>call.method==='provision')!.descriptor!;await rm(join(descriptor.workDir,'workspace'),{recursive:true});await symlink(tmpdir(),join(descriptor.workDir,'workspace'));
  const count=f.calls.length;const status=await f.manager.inspect(a);assert.equal(status.state,'unavailable');assert.equal(f.calls.length,count);assert.match(status.reason!,/ownership or workspace paths/);assert.equal(status.problem,'integrity');await f.manager.dispose();
});
test('missing bundle is distinct from nonexistent scope and errors do not expose host details',async t=>{
  const f=await fixture(t);const manager=new ScopedComputers({...f.options,loadCore:async()=>{throw Error('secret endpoint');}});const status=await manager.inspect(a);assert.equal(status.state,'unavailable');assert.match(status.reason!,/not included/);assert.ok(!JSON.stringify(status).includes('secret endpoint'));await assert.rejects(manager.inspect({kind:'chat',id:'missing'}),/no longer available/);await manager.dispose();
});
test('dispose closes admission and ends active commands without stopping the sandbox',async t=>{
  const f=await fixture(t);await f.manager.start(a);await f.manager.exec({scope:a,command:'wait',requestId:'quit'});const disposing=f.manager.dispose();await assert.rejects(f.manager.start(b),/shutting down/);await disposing;
  assert.equal(f.runner.kills.length,1);assert.equal(f.count('stop'),0);
  const reopened=new ScopedComputers(f.options);const status=await reopened.inspect(a);assert.equal(status.state,'running');assert.equal(status.activeExecutionId,undefined);await reopened.dispose();
});
test('cached executions are still subject to current authoritative scope access',async t=>{
  const f=await fixture(t);await f.manager.start(a);const receipt=await f.manager.exec({scope:a,command:'large',requestId:'access'});await terminal(f.manager,a,receipt.executionId);f.revoke();await assert.rejects(f.manager.execution(a,receipt.executionId),/no longer available/);await f.manager.dispose();
});
test('cancelling a completed receipt cannot end a later execution in the same scope',async t=>{
  const f=await fixture(t);await f.manager.start(a);const old=await f.manager.exec({scope:a,command:'large',requestId:'first'});await terminal(f.manager,a,old.executionId);const next=await f.manager.exec({scope:a,command:'wait',requestId:'second'});
  assert.equal((await f.manager.cancel(a,old.executionId)).state,'completed');assert.equal(f.runner.kills.length,0);assert.equal(f.count('stop'),0);assert.equal((await f.manager.execution(a,next.executionId)).state,'running');await f.manager.dispose();
});
test('durable receipts survive restart and container destroy; changed request content is rejected',async t=>{
  const f=await fixture(t);await f.manager.start(a);const input={scope:a,command:'large',requestId:'durable'};const receipt=await f.manager.exec(input);await terminal(f.manager,a,receipt.executionId);await f.manager.dispose();
  const reopened=new ScopedComputers(f.options);assert.deepEqual(await reopened.exec(input),receipt);assert.equal((await reopened.execution(a,receipt.executionId)).state,'completed');await assert.rejects(reopened.exec({...input,command:'other'}),/different command or timeout/);await assert.rejects(reopened.exec({...input,timeoutMs:500}),/different command or timeout/);
  await reopened.destroy(a);assert.deepEqual(await reopened.exec(input),receipt);await reopened.start(a);assert.deepEqual(await reopened.exec(input),receipt);assert.equal(f.runner.procs.length,1);await reopened.dispose();
});
test('receipt capacity fails closed and cache eviction never permits redispatch',async t=>{
  const f=await fixture(t);await f.manager.start(a);let first:string|undefined;
  for(let i=0;i<128;i++){const receipt=await f.manager.exec({scope:a,command:'fail',requestId:`receipt-${i}`});first??=receipt.executionId;await terminal(f.manager,a,receipt.executionId);}
  assert.deepEqual(await f.manager.exec({scope:a,command:'fail',requestId:'receipt-0'}),{executionId:first});assert.equal((await f.manager.execution(a,first!)).state,'failed');await assert.rejects(f.manager.exec({scope:a,command:'fail',requestId:'overflow'}),/receipt limit/);assert.equal(f.runner.procs.length,128);await f.manager.dispose();
});
test('accepted timeout ends captured owned work even after scope access is revoked',async t=>{
  const f=await fixture(t);await f.manager.start(a);await f.manager.exec({scope:a,command:'wait',requestId:'revoked',timeoutMs:100});assert.equal(f.manager.hasActiveWork(),true);f.revoke();await delay(200);assert.equal(f.runner.kills.length,1);assert.equal(f.manager.hasActiveWork(),false);await assert.rejects(f.manager.inspect(a),/no longer available/);await f.manager.dispose();
});
test('explicit stop still stops the whole sandbox and settles its command durably',async t=>{
  const f=await fixture(t);await f.manager.start(a);await f.manager.start(b);
  const first=await f.manager.exec({scope:a,command:'wait',requestId:'stuck-client'});const other=await f.manager.exec({scope:b,command:'wait',requestId:'other-client'});
  assert.equal((await f.manager.stop(a)).state,'stopped');assert.equal((await f.manager.execution(b,other.executionId)).state,'running');
  const reopened=new ScopedComputers(f.options);assert.equal((await reopened.inspect(a)).activeExecutionId,undefined);assert.equal((await reopened.execution(a,first.executionId)).state,'cancelled');
  await f.manager.dispose();await reopened.dispose();
});
test('network policy: egress needs confirmation and recreates the container under the new policy',async t=>{
  const f=await fixture(t);await f.manager.start(a);await writeFile(join(f.calls.find(call=>call.method==='provision')!.descriptor!.workDir,'workspace','keep.txt'),'x');
  await assert.rejects(f.manager.setNetwork(a,'egress'),/Confirm internet access/);
  const status=await f.manager.setNetwork(a,'egress',true);assert.equal(status.state,'running');assert.equal(status.limits.network,'egress');
  const destroyed=f.calls.find(call=>call.method==='destroy')!.descriptor!;assert.equal(destroyed.limits.networkAccess,'none','the old container is removed under its old policy');
  assert.equal(f.calls.filter(call=>call.method==='provision').at(-1)!.descriptor!.limits.networkAccess,'unrestricted');
  assert.equal(await readFile(join(destroyed.workDir,'workspace','keep.txt'),'utf8'),'x');
  const reopened=new ScopedComputers(f.options);assert.equal((await reopened.inspect(a)).limits.network,'egress');
  await reopened.stop(a);const off=await reopened.setNetwork(a,'none');assert.equal(off.state,'not-created');assert.equal(off.limits.network,'none');await f.manager.dispose();await reopened.dispose();
});
test('at most two sandboxes run at once',async t=>{
  const f=await fixture(t);await f.manager.start(a);await f.manager.start(b);
  await assert.rejects(f.manager.start(c),/2 sandboxes are already running/);await f.manager.stop(a);assert.equal((await f.manager.start(c)).state,'running');
  assert.equal((await f.manager.start(b)).state,'running','an already-running sandbox is not re-admitted');await f.manager.dispose();
});
test('first start pulls the pinned image with progress; failures and a stopped daemon are distinct',async t=>{
  const f=await fixture(t);f.runner.imagePresent=false;
  assert.equal((await f.manager.start(a)).state,'running');assert.deepEqual(f.runner.calls.find(args=>args[0]==='pull'),['pull',SANDBOX_IMAGE]);
  const progress=f.events.filter(event=>event.type==='computerProgress').map(event=>event.type==='computerProgress'?event.message:'');
  assert.ok(progress.includes('Downloading the Linux image (first start only)…'));assert.ok(progress.includes('Downloading the Linux image · 2 of 2 layers'),'layer progress is reported (throttled)');
  const g=await fixture(t);g.runner.imagePresent=false;g.runner.pullCode=1;const failed=await g.manager.start(a);
  assert.equal(failed.problem,'image');assert.equal(g.runner.calls.filter(args=>args[0]==='pull').length,2,'one bounded retry');assert.equal(g.count('provision'),0);
  const h=await fixture(t);h.runner.inspectError='Cannot connect to the Docker daemon at unix:///x. Is the docker daemon running?';const down=await h.manager.start(a);
  assert.equal(down.problem,'daemon-down');assert.match(down.reason!,/Docker Desktop is not running/);
  await f.manager.dispose();await g.manager.dispose();await h.manager.dispose();
});
test('repair adopts an owned container left unregistered by a crash, or removes and recreates it',async t=>{
  for(const action of ['adopt','recreate'] as const){
    const f=await fixture(t);const started=await f.manager.start(a);const descriptor=f.calls.find(call=>call.method==='provision')!.descriptor!;
    // Crash between `docker run` and the registry write: container exists, no record, no registry.
    await rm(join(f.appData,'scoped-computers',`${started.id}.json`));await mkdir(join(descriptor.workDir,'.sandbox'),{recursive:true});
    const owner=`sha256:${digest(`${descriptor.owner.kind}:${descriptor.owner.id}`)}`;f.runner.orphan=`${owner}|true|none|${SANDBOX_IMAGE}`;
    const status=await f.manager.inspect(a);assert.equal(status.repair,'unregistered-container');assert.equal(status.state,'not-created');
    f.runner.orphan=`sha256:${'0'.repeat(64)}|true|none|x`;assert.equal((await f.manager.inspect(a)).repair,undefined,'a foreign label is never offered');f.runner.orphan=`${owner}|true|none|${SANDBOX_IMAGE}`;
    const repaired=await f.manager.repair(a,action);assert.equal(repaired.state,'running');
    if(action==='adopt'){const registry=JSON.parse(await readFile(join(descriptor.workDir,'.sandbox','sandbox-registry.json'),'utf8'));assert.equal(registry.ownerDigest,owner);assert.equal(registry.policyDigest,`sha256:${digest(`${SANDBOX_IMAGE}\nnone\nfixture-none`)}`);assert.equal(f.count('provision'),1);}
    else {assert.ok(f.runner.calls.some(args=>args[0]==='rm'&&args[1]==='-f'));assert.equal(f.count('provision'),2);}
    assert.equal((await f.manager.inspect(a)).state,'running');await f.manager.dispose();
  }
});
test('files: list without following links, import via main dialog, export via docker cp, size and delete',async t=>{
  const outside=await mkdtemp(join(tmpdir(),'scoped-import-'));t.after(()=>rm(outside,{recursive:true,force:true}));
  await writeFile(join(outside,'notes.txt'),'hello');await mkdir(join(outside,'dir'));await writeFile(join(outside,'dir','inner.txt'),'x');
  let picked:string[]|null=[join(outside,'notes.txt'),join(outside,'dir')];const saved=join(outside,'exported.txt');
  const f=await fixture(t,{pickImportPaths:async()=>picked,pickExportPath:async name=>{assert.equal(name,'notes.txt');return saved;}});
  assert.deepEqual(await f.manager.filesList(a),{path:'',entries:[],truncated:false});await f.manager.start(a);
  assert.deepEqual((await f.manager.filesImport(a)).imported,['notes.txt','dir']);assert.deepEqual((await f.manager.filesImport(a)).imported,['notes.txt 2','dir 2']);
  picked=null;assert.deepEqual(await f.manager.filesImport(a),{imported:[]});
  const workspace=join(f.calls.find(call=>call.method==='provision')!.descriptor!.workDir,'workspace');await symlink('/etc',join(workspace,'link'));
  const listed=await f.manager.filesList(a);assert.deepEqual(listed.entries.map(entry=>[entry.name,entry.kind]),[['dir','directory'],['dir 2','directory'],['link','symlink'],['notes.txt','file'],['notes.txt 2','file']]);
  assert.deepEqual((await f.manager.filesList(a,'dir')).entries.map(entry=>entry.path),['dir/inner.txt']);
  await assert.rejects(f.manager.filesList(a,'../..'),/inside the sandbox workspace/);await assert.rejects(f.manager.filesList(a,'link'),/not followed/);
  assert.deepEqual(await f.manager.filesExport(a,'notes.txt'),{savedTo:saved});assert.deepEqual(f.runner.calls.find(args=>args[0]==='cp'),['cp',`${[...f.runner.running][0]}:/workspace/notes.txt`,saved]);
  const size=await f.manager.workspaceSize(a);assert.equal(size.bytes,12);assert.equal(size.files,5);
  await assert.rejects(f.manager.workspaceDelete(a,false),/Confirm/);
  const cleared=await f.manager.workspaceDelete(a,true);assert.equal(cleared.state,'running');assert.deepEqual(await readdir(workspace),[]);
  const disposed=await f.manager.workspaceDelete(a,true,true);assert.equal(disposed.state,'not-created');assert.match(disposed.reason!,/disposed/);await f.manager.dispose();
});
