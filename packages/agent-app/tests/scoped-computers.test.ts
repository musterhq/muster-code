import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {test,type TestContext} from 'node:test';
import {ScopedComputers,type ComputerBackend,type ComputerCore,type ComputerDescriptor,type ComputerHandle} from '../src/runtime/scoped-computers.ts';
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const a={kind:'chat' as const,id:'a'},b={kind:'project' as const,id:'b'};
async function fixture(t:TestContext,holdStoppedClient=false){
  const appData=await mkdtemp(join(tmpdir(),'scoped-computers-'));t.after(()=>rm(appData,{recursive:true,force:true}));
  const calls:{method:string;descriptor?:ComputerDescriptor;options?:unknown}[]=[];
  const running=new Map<string,boolean>();const commands=new Map<string,(result:any)=>void>();let failStop=false;
  class Backend implements ComputerBackend {
    readonly lifecycleVersion=1 as const;
    async recoverProvisioning(_descriptor:ComputerDescriptor){return null;}
    constructor(options:unknown){calls.push({method:'constructor',options});}
    async provision(descriptor:ComputerDescriptor){calls.push({method:'provision',descriptor});running.set(descriptor.workDir,true);await mkdir(join(descriptor.workDir,'workspace'),{recursive:true});return {id:`muster-sbx-${descriptor.workDir.split('/').at(-1)}`,ownerDigest:`sha256:${digest(`${descriptor.owner.kind}:${descriptor.owner.id}`)}`,image:'fixture',createdAt:'now'};}
    async inspect(_handle:ComputerHandle,descriptor:ComputerDescriptor){calls.push({method:'inspect',descriptor});return {running:running.get(descriptor.workDir)??false,exitCode:0};}
    async stop(_handle:ComputerHandle,descriptor:ComputerDescriptor){calls.push({method:'stop',descriptor});if(failStop)throw new Error('fixture secret access_token=must-not-leak');running.set(descriptor.workDir,false);if(!holdStoppedClient)commands.get(descriptor.workDir)?.({stdout:'',stderr:'',exitCode:137,stdoutTruncated:false,stderrTruncated:false});}
    async destroy(_handle:ComputerHandle,descriptor:ComputerDescriptor){calls.push({method:'destroy',descriptor});running.delete(descriptor.workDir);}
    async run(_handle:ComputerHandle,descriptor:ComputerDescriptor,command:string,options:any){calls.push({method:'run',descriptor,options});assert.equal(options.maxBufferBytes,65536);assert.deepEqual(options.env,{});assert.ok(options.clientSignal instanceof AbortSignal);assert.equal(options.signal,undefined);if(command==='large')return {stdout:'a'.repeat(80_000),stderr:'b'.repeat(80_000),exitCode:0,stdoutTruncated:false,stderrTruncated:false};return new Promise<any>(resolve=>{commands.set(descriptor.workDir,resolve);options.clientSignal.addEventListener('abort',()=>resolve({stdout:'',stderr:'',exitCode:-1,stdoutTruncated:false,stderrTruncated:false}),{once:true});});}
  }
  const core:ComputerCore={LocalDockerSandbox:Backend,resolveScopedRuntime(scopes,config){const owner=scopes[0],workDir=join(config.rootDir,owner.kind,digest(owner.id));assert.deepEqual(config.grants[0],{scope:owner,envAllowlist:[],toolPolicy:['computer.exec'],limits:{networkAccess:'none',maxProcesses:256}});return {owner,root:config.rootDir,workDir,manifestPath:join(workDir,'runtime-manifest.json'),envAllowlist:[],toolPolicy:['computer.exec'],limits:{networkAccess:'none',maxProcesses:256},policyDigest:'fixture'};},async ensureRuntime(descriptor){await mkdir(descriptor.workDir,{recursive:true});}};
  let authorized=true;const options={appData,loadCore:async()=>core,resolveScope:(scope:any)=>{if(!authorized||!['a','b'].includes(scope.id))throw Error('private detail');return {...scope,label:scope.id};},dockerHost:'unix:///tmp/fixture.sock'};
  const manager=new ScopedComputers(options);
  return {manager,options,appData,calls,running,commands,setFailStop:(value:boolean)=>{failStop=value;},revoke:()=>{authorized=false;}};
}
async function terminal(manager:ScopedComputers,scope:typeof a|typeof b,id:string){for(let i=0;i<30;i++){const result=await manager.execution(scope,id);if(result.state!=='running')return result;await delay(5);}throw Error('fixture did not settle');}

test('authority fails before dependency or path access; view never provisions',async t=>{
  const f=await fixture(t);await assert.rejects(f.manager.inspect({kind:'chat',id:'missing'}),/no longer available/);assert.equal(f.calls.length,0);
  assert.equal((await f.manager.inspect(a)).state,'not-created');assert.deepEqual(f.calls.map(call=>call.method),['constructor']);
  assert.deepEqual((f.calls[0].options as any).dockerHost,'unix:///tmp/fixture.sock');await f.manager.dispose();
});
test('scope workspaces survive stop, restart, and container removal without host-folder mounts',async t=>{
  const f=await fixture(t);const first=await f.manager.start(a);assert.equal(first.state,'running');await f.manager.start(b);
  const descriptors=f.calls.filter(call=>call.method==='provision').map(call=>call.descriptor!);assert.notEqual(descriptors[0].workDir,descriptors[1].workDir);assert.ok(descriptors.every(d=>d.workDir.includes('/scoped-computers/runtimes/')));
  const file=join(descriptors[0].workDir,'workspace','durable.txt');await writeFile(file,'retained');assert.equal((await f.manager.stop(a)).state,'stopped');
  const count=f.calls.filter(call=>call.method==='provision').length;assert.equal((await f.manager.inspect(a)).state,'stopped');assert.equal(f.calls.filter(call=>call.method==='provision').length,count);
  const reopened=new ScopedComputers(f.options);assert.equal((await reopened.inspect(a)).id,first.id);assert.equal((await reopened.start(a)).state,'running');assert.equal((await reopened.destroy(a)).state,'not-created');assert.equal(await readFile(file,'utf8'),'retained');
  await f.manager.dispose();await reopened.dispose();
});
test('bounded output, request replay, and execution identity stay in their scope',async t=>{
  const f=await fixture(t);await f.manager.start(a);const receipt=await f.manager.exec({scope:a,command:'large',requestId:'once'});const result=await terminal(f.manager,a,receipt.executionId);assert.equal(result.state,'completed');assert.equal(Buffer.byteLength(result.stdout),65536);assert.ok(result.stderrTruncated&&result.stdoutTruncated);
  assert.deepEqual(await f.manager.exec({scope:a,command:'large',requestId:'once'}),receipt);assert.equal(f.calls.filter(call=>call.method==='run').length,1);
  await assert.rejects(f.manager.execution(b,receipt.executionId),/not available/);await assert.rejects(f.manager.cancel(b,receipt.executionId),/not available/);await f.manager.dispose();
});
test('cancel stops the owned whole container and preserves workspace for restart',async t=>{
  const f=await fixture(t);await f.manager.start(a);const receipt=await f.manager.exec({scope:a,command:'wait',requestId:'waiting'});
  await assert.rejects(f.manager.exec({scope:a,command:'second',requestId:'other'}),/active or unresolved/);
  const cancelled=await f.manager.cancel(a,receipt.executionId);assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.computerStopped,true);await delay(10);
  assert.equal((await f.manager.inspect(a)).state,'stopped');assert.equal((await f.manager.start(a)).state,'running');await f.manager.dispose();
});
test('failed cancellation is never reported as confirmed and preserves the execution guard',async t=>{
  const f=await fixture(t);await f.manager.start(a);const receipt=await f.manager.exec({scope:a,command:'wait',requestId:'waiting'});f.setFailStop(true);
  const result=await f.manager.cancel(a,receipt.executionId);assert.equal(result.state,'recovery-needed');assert.equal(result.computerStopped,false);assert.ok(!JSON.stringify(result).includes('must-not-leak'));await assert.rejects(f.manager.exec({scope:a,command:'second',requestId:'other'}),/active or unresolved/);
  f.setFailStop(false);await f.manager.cancel(a,receipt.executionId);await f.manager.dispose();
});
test('controller restart reports uncertain work and requires an explicit stop',async t=>{
  const f=await fixture(t);await f.manager.start(a);const receipt=await f.manager.exec({scope:a,command:'wait',requestId:'waiting'});const reopened=new ScopedComputers(f.options);
  assert.equal((await reopened.inspect(a)).state,'recovery-needed');assert.equal((await reopened.start(a)).state,'recovery-needed');assert.deepEqual(await reopened.exec({scope:a,command:'wait',requestId:'waiting'}),receipt);await assert.rejects(reopened.exec({scope:a,command:'other',requestId:'other'}),/active or unresolved/);
  assert.equal((await reopened.stop(a)).state,'stopped');await f.manager.dispose();await reopened.dispose();
});
test('planted workspace symlink is rejected before further Docker operations',async t=>{
  const f=await fixture(t);await f.manager.start(a);const descriptor=f.calls.find(call=>call.method==='provision')!.descriptor!;await rm(join(descriptor.workDir,'workspace'),{recursive:true});await symlink(tmpdir(),join(descriptor.workDir,'workspace'));
  const count=f.calls.length;const status=await f.manager.inspect(a);assert.equal(status.state,'unavailable');assert.equal(f.calls.length,count);assert.match(status.reason!,/ownership or workspace paths/);await f.manager.dispose();
});
test('missing bundle is distinct from nonexistent scope and errors do not expose host details',async t=>{
  const f=await fixture(t);const manager=new ScopedComputers({...f.options,loadCore:async()=>{throw Error('secret endpoint');}});const status=await manager.inspect(a);assert.equal(status.state,'unavailable');assert.match(status.reason!,/not included/);assert.ok(!JSON.stringify(status).includes('secret endpoint'));await assert.rejects(manager.inspect({kind:'chat',id:'missing'}),/no longer available/);await manager.dispose();
});
test('timeout stops the whole container and never uses core PID cancellation',async t=>{
  const f=await fixture(t);await f.manager.start(a);const receipt=await f.manager.exec({scope:a,command:'wait',requestId:'timeout',timeoutMs:100});await delay(130);const result=await terminal(f.manager,a,receipt.executionId);assert.equal(result.state,'timed-out');assert.equal(result.computerStopped,true);assert.equal((await f.manager.inspect(a)).state,'stopped');await f.manager.dispose();
});
test('dispose closes admission, stops active work, and awaits durable completion writes',async t=>{
  const f=await fixture(t);await f.manager.start(a);await f.manager.exec({scope:a,command:'wait',requestId:'quit'});const disposing=f.manager.dispose();await assert.rejects(f.manager.start(b),/shutting down/);await disposing;const reopened=new ScopedComputers(f.options);const status=await reopened.inspect(a);assert.equal(status.state,'stopped');assert.equal(status.activeExecutionId,undefined);await reopened.dispose();
});
test('cached executions are still subject to current authoritative scope access',async t=>{
  const f=await fixture(t);await f.manager.start(a);const receipt=await f.manager.exec({scope:a,command:'large',requestId:'access'});await terminal(f.manager,a,receipt.executionId);f.revoke();await assert.rejects(f.manager.execution(a,receipt.executionId),/no longer available/);await f.manager.dispose();
});
test('cancelling a completed receipt cannot stop a later execution in the same scope',async t=>{
  const f=await fixture(t);await f.manager.start(a);const old=await f.manager.exec({scope:a,command:'large',requestId:'first'});await terminal(f.manager,a,old.executionId);const next=await f.manager.exec({scope:a,command:'wait',requestId:'second'});const count=f.calls.filter(call=>call.method==='stop').length;
  assert.equal((await f.manager.cancel(a,old.executionId)).state,'completed');assert.equal(f.calls.filter(call=>call.method==='stop').length,count);assert.equal((await f.manager.execution(a,next.executionId)).state,'running');await f.manager.dispose();
});
test('durable receipts survive restart and container destroy; changed request content is rejected',async t=>{
  const f=await fixture(t);await f.manager.start(a);const input={scope:a,command:'large',requestId:'durable'};const receipt=await f.manager.exec(input);await terminal(f.manager,a,receipt.executionId);await f.manager.dispose();
  const reopened=new ScopedComputers(f.options);assert.deepEqual(await reopened.exec(input),receipt);assert.equal((await reopened.execution(a,receipt.executionId)).state,'completed');await assert.rejects(reopened.exec({...input,command:'other'}),/different command or timeout/);await assert.rejects(reopened.exec({...input,timeoutMs:500}),/different command or timeout/);
  await reopened.destroy(a);assert.deepEqual(await reopened.exec(input),receipt);await reopened.start(a);assert.deepEqual(await reopened.exec(input),receipt);assert.equal(f.calls.filter(call=>call.method==='run').length,1);await reopened.dispose();
});
test('receipt capacity fails closed and cache eviction never permits redispatch',async t=>{
  const f=await fixture(t);await f.manager.start(a);let first:string|undefined;
  for(let i=0;i<128;i++){const receipt=await f.manager.exec({scope:a,command:'large',requestId:`receipt-${i}`});first??=receipt.executionId;await terminal(f.manager,a,receipt.executionId);}
  assert.deepEqual(await f.manager.exec({scope:a,command:'large',requestId:'receipt-0'}),{executionId:first});assert.equal((await f.manager.execution(a,first!)).state,'completed');await assert.rejects(f.manager.exec({scope:a,command:'large',requestId:'overflow'}),/receipt limit/);assert.equal(f.calls.filter(call=>call.method==='run').length,128);await f.manager.dispose();
});
test('accepted timeout stops captured owned work even after scope access is revoked',async t=>{
  const f=await fixture(t);await f.manager.start(a);await f.manager.exec({scope:a,command:'wait',requestId:'revoked',timeoutMs:100});assert.equal(f.manager.hasActiveWork(),true);f.revoke();await delay(160);assert.ok(f.calls.some(call=>call.method==='stop'));assert.equal(f.manager.hasActiveWork(),false);await assert.rejects(f.manager.inspect(a),/no longer available/);await f.manager.dispose();
});
test('failed bounded stop closes only the owned client, preserves recovery and allows cleanup retry',async t=>{
  const f=await fixture(t);await f.manager.start(a);const receipt=await f.manager.exec({scope:a,command:'wait',requestId:'shutdown'});f.setFailStop(true);await assert.rejects(f.manager.dispose(),/could not be confirmed stopped/);assert.equal(f.manager.hasActiveWork(),true);await assert.rejects(f.manager.start(a),/shutting down/);f.setFailStop(false);await f.manager.dispose();
  const reopened=new ScopedComputers(f.options);assert.equal((await reopened.inspect(a)).state,'stopped');assert.equal((await reopened.execution(a,receipt.executionId)).state,'cancelled');await reopened.dispose();
});
for(const operation of ['stop','cancel'] as const)test(`explicit ${operation} releases a stuck owned CLI and waits for durable settlement outside the scope lock`,{timeout:2000},async t=>{
  const f=await fixture(t,true);await f.manager.start(a);await f.manager.start(b);
  const first=await f.manager.exec({scope:a,command:'wait',requestId:'stuck-client',timeoutMs:600000});
  const other=await f.manager.exec({scope:b,command:'wait',requestId:'other-client',timeoutMs:600000});
  const result=operation==='stop'?await f.manager.stop(a):await f.manager.cancel(a,first.executionId);
  assert.equal(result.state,operation==='stop'?'stopped':'cancelled');
  const runOptions=f.calls.filter(call=>call.method==='run').map(call=>call.options as {clientSignal:AbortSignal});
  assert.equal(runOptions[0].clientSignal.aborted,true);assert.equal(runOptions[1].clientSignal.aborted,false);
  assert.equal((await f.manager.execution(b,other.executionId)).state,'running');
  const reopened=new ScopedComputers(f.options);
  assert.equal((await reopened.inspect(a)).activeExecutionId,undefined,'completion is durable before Stop/Cancel resolves');
  assert.equal((await reopened.execution(a,first.executionId)).state,'cancelled');
  assert.equal((await f.manager.start(a)).state,'running','no guard waits for the original ten-minute deadline');
  const next=await f.manager.exec({scope:a,command:'wait',requestId:'replacement'});
  const stops=f.calls.filter(call=>call.method==='stop').length;
  await f.manager.cancel(a,first.executionId);
  assert.equal(f.calls.filter(call=>call.method==='stop').length,stops,'old cancellation never stops replacement');
  assert.equal((await f.manager.execution(a,next.executionId)).state,'running');
  await f.manager.dispose();await reopened.dispose();
});
