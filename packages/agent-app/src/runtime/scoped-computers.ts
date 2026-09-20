import {createHash,randomUUID} from 'node:crypto';
import {constants,existsSync} from 'node:fs';
import {lstat,mkdir,open,realpath,rename,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import {dirname,isAbsolute,join,sep} from 'node:path';
import type {ScopedComputerExecution,ScopedComputerRef,ScopedComputerStatus} from '../shared/scoped-computer-protocol.ts';

type Scope={kind:'session'|'workspace';id:string};
export interface ComputerDescriptor {owner:Scope;root:string;workDir:string;manifestPath:string;envAllowlist:readonly string[];toolPolicy:readonly string[];limits:{networkAccess:string;maxProcesses?:number};policyDigest:string}
export interface ComputerHandle {id:string;ownerDigest:string;image:string;createdAt:string}
export interface ComputerBackend {
  readonly lifecycleVersion:1;
  recoverProvisioning(descriptor:ComputerDescriptor):Promise<ComputerHandle|null>;
  provision(descriptor:ComputerDescriptor):Promise<ComputerHandle>;
  inspect(handle:ComputerHandle,descriptor:ComputerDescriptor):Promise<{running:boolean;exitCode:number|null}>;
  stop(handle:ComputerHandle,descriptor:ComputerDescriptor):Promise<void>;
  destroy(handle:ComputerHandle,descriptor:ComputerDescriptor):Promise<void>;
  run(handle:ComputerHandle,descriptor:ComputerDescriptor,command:string,options:{maxBufferBytes:number;env:Record<string,string>;clientSignal:AbortSignal}):Promise<{stdout:string;stderr:string;exitCode:number;stdoutTruncated:boolean;stderrTruncated:boolean}>;
}
export interface ComputerCore {
  LocalDockerSandbox:new(options:{dockerBin:string;dockerHost:string;managementTimeoutMs:number;durableProvisioning:true})=>ComputerBackend;
  resolveScopedRuntime(scopes:Scope[],config:{rootDir:string;grants:{scope:Scope;envAllowlist:string[];toolPolicy:string[];limits:{networkAccess:'none';maxProcesses:256}}[]}):ComputerDescriptor;
  ensureRuntime(descriptor:ComputerDescriptor):Promise<unknown>;
}
export interface ScopedComputerOptions {
  appData:string;
  /** Resolve from the service's authoritative store on EVERY call; throw for unavailable references. */
  resolveScope:(ref:ScopedComputerRef)=>Promise<ScopedComputerRef&{label:string}>|ScopedComputerRef&{label:string};
  loadCore?:()=>Promise<ComputerCore>;
  /** Trusted main-process configuration only; never supplied by renderer IPC. */
  dockerHost?:string;
  dockerBin?:string;
}
interface Receipt {requestId:string;executionId:string;fingerprint:string;state:ScopedComputerExecution['state'];exitCode:number|null;computerStopped:boolean}
interface RecordData {version:1;id:string;scope:ScopedComputerRef;handle:ComputerHandle|null;receipts:Receipt[];active?:{executionId:string;requestId:string}}
interface Context {id:string;scope:ScopedComputerRef;label:string;descriptor:ComputerDescriptor;recordPath:string;core:ComputerCore;backend:ComputerBackend}
interface Execution {clientAbort:AbortController;context:Context;scopeKey:string;requestId:string;result:ScopedComputerExecution;done:Promise<void>;stopKind?:'cancelled'|'timed-out';settled?:boolean;timer?:ReturnType<typeof setTimeout>}
class ComputerInputError extends Error {}
const MAX_OUTPUT=64*1024;
const MAX_RECEIPTS=128;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const refKey=(scope:ScopedComputerRef)=>JSON.stringify([scope.kind,scope.id]);
function validateRef(ref:ScopedComputerRef):void {
  if(!ref||!['chat','project'].includes(ref.kind)||typeof ref.id!=='string'||!ref.id||ref.id.length>256||/[\0\r\n]/.test(ref.id))throw new ComputerInputError('Select an existing chat or project for this computer.');
}
function safeReason(error:unknown):string {
  const name=error instanceof Error?error.name:'';
  if(name==='SandboxOwnershipError')return 'The container ownership could not be verified. Its workspace has been preserved.';
  if(name==='SandboxPolicyError')return 'This container uses an incompatible saved policy. Its workspace has been preserved; review its configuration before reuse.';
  if(name==='ComputerDependencyError')return 'The scoped container runtime is not included in this build.';
  if(name==='ComputerIntegrityError')return 'Saved computer ownership or workspace paths could not be verified. No container action was taken.';
  return 'The local Docker computer could not be reached. Start Docker Desktop and try again. Its saved workspace is preserved.';
}
function integrity():never {const error=new Error('Computer integrity check failed.');error.name='ComputerIntegrityError';throw error;}
async function readJSON(path:string):Promise<unknown|null> {
  let file;
  try {file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;integrity();}
  try {const stat=await file.stat();if(!stat.isFile()||stat.size>64*1024)integrity();const raw=await file.readFile('utf8');if(raw.length>64*1024)integrity();return JSON.parse(raw);}catch{integrity();}finally{await file.close();}
}
async function saveJSON(path:string,data:unknown):Promise<void> {
  const temp=`${path}.${randomUUID()}.tmp`;
  await writeFile(temp,JSON.stringify(data),{mode:0o600,flag:'wx',flush:true});await rename(temp,path);
}

/** A local Docker boundary with app-owned durable paths and no renderer-supplied handles or mounts. */
export class ScopedComputers {
  private closed=false;
  private initialized?:Promise<{root:string;installation:string}>;
  private dependency?:Promise<{core:ComputerCore;backend:ComputerBackend}>;
  private locks=new Map<string,Promise<unknown>>();
  private executions=new Map<string,Execution>();
  private pending=new Set<Promise<unknown>>();
  private observedActiveScopes=new Map<string,Context>();
  private disposal?:Promise<void>;
  constructor(private options:ScopedComputerOptions) {if(!isAbsolute(options.appData))throw new ComputerInputError('Computer app data must be an absolute path.');}

  private async init() {
    return this.initialized??=(async()=>{
      await mkdir(this.options.appData,{recursive:true,mode:0o700});
      const root=join(await realpath(this.options.appData),'scoped-computers');
      await mkdir(root,{recursive:true,mode:0o700});if(!(await lstat(root)).isDirectory()||(await lstat(root)).isSymbolicLink())integrity();
      const path=join(root,'installation.json');
      let installation=await readJSON(path) as {id?:unknown}|null;
      if(!installation){try{await writeFile(path,JSON.stringify({id:randomUUID()}),{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}installation=await readJSON(path) as {id?:unknown};}
      if(typeof installation?.id!=='string'||!/^[a-f0-9-]{36}$/.test(installation.id))integrity();
      return {root,installation:installation.id};
    })();
  }
  private async getDependency() {
    if(!this.dependency)this.dependency=(async()=>{
      let core:ComputerCore;
      try {core=await (this.options.loadCore?.()??Promise.resolve(createRequire(__filename)(join(__dirname,'scoped-computer-core.cjs'))));
        if(typeof core.LocalDockerSandbox!=='function'||typeof core.resolveScopedRuntime!=='function'||typeof core.ensureRuntime!=='function')throw Error();
      }catch{const error=new Error('Missing scoped computer dependency');error.name='ComputerDependencyError';throw error;}
      const socket=[join(homedir(),'.docker/run/docker.sock'),'/var/run/docker.sock'].find(existsSync)??join(homedir(),'.docker/run/docker.sock');
      const dockerHost=this.options.dockerHost??`unix://${socket}`;
      if(!/^unix:\/\/\/[^\0\r\n?#]+$/.test(dockerHost))throw new ComputerInputError('A local Docker socket is required.');
      const backend=new core.LocalDockerSandbox({dockerBin:this.options.dockerBin??['/usr/local/bin/docker','/opt/homebrew/bin/docker'].find(existsSync)??'docker',dockerHost,managementTimeoutMs:3000,durableProvisioning:true});
      if(backend.lifecycleVersion!==1||typeof backend.recoverProvisioning!=='function'){const error=new Error('Missing bounded computer lifecycle');error.name='ComputerDependencyError';throw error;}
      return {core,backend};
    })().catch(error=>{this.dependency=undefined;throw error;});
    return this.dependency;
  }
  private async authority(scope:ScopedComputerRef) {
    validateRef(scope);const authorized=await this.options.resolveScope({...scope});
    if(!authorized||authorized.kind!==scope.kind||authorized.id!==scope.id)throw new ComputerInputError('This computer scope is no longer available.');
    return {...scope,label:String(authorized.label).slice(0,256)};
  }
  private async context(scope:ScopedComputerRef,label:string):Promise<Context> {
    const {root,installation}=await this.init();const {core,backend}=await this.getDependency();
    const owner:Scope={kind:scope.kind==='chat'?'session':'workspace',id:`${installation}:${scope.kind}:${scope.id}`};
    const id=`computer_${hash(owner.id).slice(0,32)}`;
    const descriptor=core.resolveScopedRuntime([owner],{rootDir:join(root,'runtimes'),grants:[{scope:owner,envAllowlist:[],toolPolicy:['computer.exec'],limits:{networkAccess:'none',maxProcesses:256}}]});
    if(descriptor.owner.kind!==owner.kind||descriptor.owner.id!==owner.id||descriptor.root!==join(root,'runtimes')||!descriptor.workDir.startsWith(descriptor.root+sep)||descriptor.envAllowlist.length||descriptor.limits.networkAccess!=='none')integrity();
    // Reject planted workspace/control symlinks before a Docker bind mount or registry read.
    for(const path of [descriptor.root,dirname(descriptor.workDir),descriptor.workDir,join(descriptor.workDir,'workspace'),join(descriptor.workDir,'.sandbox')]) {
      try {const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink())integrity();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    const context={id,scope,label,descriptor,recordPath:join(root,`${id}.json`),core,backend};
    const registry=await readJSON(join(descriptor.workDir,'.sandbox','sandbox-registry.json')) as {containerName?:unknown;ownerDigest?:unknown}|null;
    if(registry&&(registry.containerName!==this.expectedHandle(context).id||registry.ownerDigest!==this.expectedHandle(context).ownerDigest))integrity();
    return context;
  }
  private expectedHandle(context:Context) {
    const slug=context.descriptor.workDir.split('/').filter(Boolean).at(-1)!;
    return {id:`muster-sbx-${slug}`.toLowerCase().replace(/[^a-z0-9_.-]/g,'-'),ownerDigest:`sha256:${hash(`${context.descriptor.owner.kind}:${context.descriptor.owner.id}`)}`};
  }
  private async record(context:Context):Promise<RecordData|null> {
    let data=await readJSON(context.recordPath) as RecordData|null;
    if(!data||!data.handle){
      // Recovery only finalizes a matching durable provisioning intent; it never starts a container.
      const recovered=await context.backend.recoverProvisioning(context.descriptor);
      const registry=await readJSON(join(context.descriptor.workDir,'.sandbox','sandbox-registry.json')) as {containerName:string;ownerDigest:string;image:string;createdAt:string}|null;
      const handle=recovered??(registry?{id:registry.containerName,ownerDigest:registry.ownerDigest,image:registry.image,createdAt:registry.createdAt}:null);
      if(!data&&!handle)return null;
      data={version:1,id:context.id,scope:context.scope,receipts:[],...data,handle};
    }
    const expected=this.expectedHandle(context);
    if(data.version!==1||data.id!==context.id||refKey(data.scope)!==refKey(context.scope))integrity();
    if(data.handle&&(data.handle.id!==expected.id||data.handle.ownerDigest!==expected.ownerDigest||typeof data.handle.image!=='string'||typeof data.handle.createdAt!=='string'))integrity();
    if(data.active&&(typeof data.active.executionId!=='string'||typeof data.active.requestId!=='string'))integrity();
    data.receipts??=[];
    if(!Array.isArray(data.receipts)||data.receipts.length>MAX_RECEIPTS)integrity();
    const requests=new Set<string>(),identities=new Set<string>();
    for(const receipt of data.receipts){
      if(!receipt||typeof receipt.requestId!=='string'||!receipt.requestId||receipt.requestId.length>128||typeof receipt.executionId!=='string'||typeof receipt.fingerprint!=='string'||!['running','completed','failed','cancelled','timed-out','recovery-needed'].includes(receipt.state)||requests.has(receipt.requestId)||identities.has(receipt.executionId))integrity();
      requests.add(receipt.requestId);identities.add(receipt.executionId);
    }
    if(data.active&&!identities.has(data.active.executionId)){
      if(data.receipts.length>=MAX_RECEIPTS)integrity();
      data.receipts.push({...data.active,fingerprint:'legacy-unknown',state:'recovery-needed',exitCode:null,computerStopped:false});
    }
    if(data.active)this.observedActiveScopes.set(refKey(context.scope),context);else this.observedActiveScopes.delete(refKey(context.scope));
    return data;
  }
  private async saveRecord(context:Context,data:RecordData):Promise<void>{
    await saveJSON(context.recordPath,data);
    if(data.active)this.observedActiveScopes.set(refKey(context.scope),context);else this.observedActiveScopes.delete(refKey(context.scope));
  }
  private receiptResult(context:Context,receipt:Receipt):ScopedComputerExecution {
    return {executionId:receipt.executionId,computerId:context.id,state:receipt.state==='running'?'recovery-needed':receipt.state,stdout:'',stderr:'',stdoutTruncated:false,stderrTruncated:false,exitCode:receipt.exitCode,computerStopped:receipt.computerStopped,reason:receipt.state==='running'?'The previous execution did not record completion. Stop this computer before more work.':'The durable execution receipt is restored. Output from the previous app session is not retained.'};
  }
  private status(context:Pick<Context,'id'|'scope'|'label'>,state:ScopedComputerStatus['state'],reason?:string,activeExecutionId?:string):ScopedComputerStatus {
    return {id:context.id,scope:context.scope,label:context.label,provider:'local-docker',state,reason,activeExecutionId,workspacePreserved:true,limits:{network:'none',memoryMiB:512,cpus:1,processes:256}};
  }
  private queue<T>(key:string,action:()=>Promise<T>):Promise<T> {
    const prior=this.locks.get(key)??Promise.resolve();
    const pending=prior.catch(()=>{}).then(action);
    this.locks.set(key,pending);this.pending.add(pending);void pending.finally(()=>{this.pending.delete(pending);if(this.locks.get(key)===pending)this.locks.delete(key);}).catch(()=>{});return pending;
  }
  private withScope<T>(scope:ScopedComputerRef,action:(authorized:ScopedComputerRef&{label:string})=>Promise<T>):Promise<T> {
    if(this.closed)return Promise.reject(new ComputerInputError('Scoped computers are shutting down.'));
    validateRef(scope);
    return this.queue(refKey(scope),async()=>{
      if(this.closed)throw new ComputerInputError('Scoped computers are shutting down.');
      let authority:ScopedComputerRef&{label:string};
      try {authority=await this.authority(scope);}catch {throw new ComputerInputError('This chat or project is no longer available.');}
      if(this.closed)throw new ComputerInputError('Scoped computers are shutting down.');
      try {return await action(authority);}catch(error){if(error instanceof ComputerInputError)throw error;throw new ComputerInputError(safeReason(error));}
    });
  }
  inspect(scope:ScopedComputerRef):Promise<ScopedComputerStatus> {return this.withScope(scope,async authorized=>{
    let context:Context|undefined;
    try {context=await this.context(scope,authorized.label);const record=await this.record(context);
      if(!record?.handle)return this.status(context,'not-created');
      if(record.active&&(!this.executions.has(record.active.executionId)||this.executions.get(record.active.executionId)?.result.state==='recovery-needed'))return this.status(context,'recovery-needed','The app closed during an execution. Stop this computer to confirm it is quiescent before starting more work.',record.active.executionId);
      const state=await context.backend.inspect(record.handle,context.descriptor);return this.status(context,state.running?'running':'stopped',undefined,record.active?.executionId);
    }catch(error){return this.status(context??{id:'',scope,label:authorized.label},'unavailable',safeReason(error));}
  });}
  start(scope:ScopedComputerRef):Promise<ScopedComputerStatus> {return this.withScope(scope,async authorized=>{
    const context=await this.context(scope,authorized.label);const old=await this.record(context);
    if(old?.active)return this.status(context,'recovery-needed','An execution still owns this computer. Wait for it to finish or stop the computer first.',old.active.executionId);
    try {await context.core.ensureRuntime(context.descriptor);if(this.closed)throw new ComputerInputError('Scoped computers are shutting down.');const handle=await context.backend.provision(context.descriptor);const expected=this.expectedHandle(context);if(handle.id!==expected.id||handle.ownerDigest!==expected.ownerDigest)integrity();
      await saveJSON(context.recordPath,{version:1,id:context.id,scope,handle,receipts:old?.receipts??[]} satisfies RecordData);
      if(this.closed)await context.backend.stop(handle,context.descriptor);
      const actual=await context.backend.inspect(handle,context.descriptor);return this.status(context,actual.running?'running':'stopped');
    }catch(error){return this.status(context,'unavailable',safeReason(error));}
  });}
  async stop(scope:ScopedComputerRef):Promise<ScopedComputerStatus> {
    const {status,execution}=await this.withScope(scope,async authorized=>{
      const status=await this.stopContext(await this.context(scope,authorized.label));
      const execution=status.activeExecutionId?this.executions.get(status.activeExecutionId):undefined;
      if(execution){execution.stopKind??='cancelled';execution.clientAbort.abort();}
      return {status,execution};
    });
    // perform() must reacquire the scope lock to checkpoint completion. Never
    // await it inside withScope/stopContext, or cancellation deadlocks itself.
    if(!execution)return status;
    await execution.done;
    if(execution.result.state==='recovery-needed')return {...status,state:'unknown',reason:execution.result.reason,activeExecutionId:execution.result.executionId};
    const {activeExecutionId:_active,...settled}=status;return settled;
  }
  private async stopContext(context:Context):Promise<ScopedComputerStatus> {
    const record=await this.record(context);if(!record?.handle)return this.status(context,'not-created');
    try {await context.backend.stop(record.handle,context.descriptor);const actual=await context.backend.inspect(record.handle,context.descriptor);if(actual.running)return this.status(context,'unknown','Docker still reports this computer as running. Stop was not confirmed.',record.active?.executionId);
      const execution=record.active&&this.executions.get(record.active.executionId);
      const receipt=record.receipts.find(item=>item.executionId===record.active?.executionId);
      if(receipt){receipt.state=execution&&execution.stopKind==='timed-out'?'timed-out':'cancelled';receipt.computerStopped=true;}
      if(execution){execution.stopKind??='cancelled';execution.result.computerStopped=true;execution.clientAbort.abort();if(execution.settled){execution.result.state=execution.stopKind;delete record.active;}}
      else delete record.active;
      await this.saveRecord(context,record);
      return this.status(context,'stopped',undefined,execution?record.active?.executionId:undefined);
    }catch(error){return this.status(context,'unknown',safeReason(error),record.active?.executionId);}
  }
  destroy(scope:ScopedComputerRef):Promise<ScopedComputerStatus> {return this.withScope(scope,async authorized=>{
    const context=await this.context(scope,authorized.label);const record=await this.record(context);if(!record?.handle)return this.status(context,'not-created');
    if(record.active)return this.status(context,'recovery-needed','Stop the active execution before removing its container.',record.active.executionId);
    try {await context.backend.destroy(record.handle,context.descriptor);record.handle=null;await this.saveRecord(context,record);return this.status(context,'not-created','Container removed. The durable workspace is retained.');}
    catch(error){return this.status(context,'unknown',safeReason(error));}
  });}
  exec(input:{scope:ScopedComputerRef;command:string;requestId:string;timeoutMs?:number}):Promise<{executionId:string}> {return this.withScope(input.scope,async authorized=>{
    if(typeof input.command!=='string'||!input.command.trim()||input.command.length>16*1024||input.command.includes('\0'))throw new ComputerInputError('Enter a container command of up to 16 KiB.');
    if(typeof input.requestId!=='string'||!input.requestId||input.requestId.length>128)throw new ComputerInputError('A valid execution request identity is required.');
    const timeout=input.timeoutMs??30_000;if(!Number.isInteger(timeout)||timeout<100||timeout>600_000)throw new ComputerInputError('Execution timeout must be between 100 ms and 10 minutes.');
    const key=refKey(input.scope),fingerprint=hash(JSON.stringify([input.command,timeout]));
    const context=await this.context(input.scope,authorized.label),record=await this.record(context);
    const replay=record?.receipts.find(receipt=>receipt.requestId===input.requestId);
    if(replay){if(replay.fingerprint!==fingerprint)throw new ComputerInputError('This request identity already belongs to a different command or timeout. Use a new request identity for new work.');return {executionId:replay.executionId};}
    if(!record?.handle)throw new ComputerInputError('Start this scoped computer before running a command.');
    if(record.active)throw new ComputerInputError('This computer has an active or unresolved execution. Wait for completion or stop it first.');
    if(record.receipts.length>=MAX_RECEIPTS)throw new ComputerInputError('This computer has reached its durable execution receipt limit. New commands are blocked to preserve retry safety; use a new scope for new work.');
    if(!(await context.backend.inspect(record.handle,context.descriptor)).running)throw new ComputerInputError('Start this scoped computer before running a command.');
    for(const [id,old] of this.executions){if(this.executions.size<100)break;if(old.settled&&old.result.state!=='recovery-needed')this.executions.delete(id);}
    if(this.executions.size>=100)throw new ComputerInputError('Too many unresolved executions. Stop an existing computer before starting more work.');
    if(this.closed)throw new ComputerInputError('Scoped computers are shutting down.');
    const executionId=randomUUID();record.active={executionId,requestId:input.requestId};record.receipts.push({executionId,requestId:input.requestId,fingerprint,state:'running',exitCode:null,computerStopped:false});await this.saveRecord(context,record);
    if(this.closed){delete record.active;record.receipts.at(-1)!.state='cancelled';await this.saveRecord(context,record);throw new ComputerInputError('Scoped computers are shutting down.');}
    const execution:Execution={clientAbort:new AbortController(),context,scopeKey:key,requestId:input.requestId,result:{executionId,computerId:context.id,state:'running',stdout:'',stderr:'',stdoutTruncated:false,stderrTruncated:false,exitCode:null,computerStopped:false},done:Promise.resolve()};
    this.executions.set(executionId,execution);
    execution.timer=setTimeout(()=>{void this.stopOwnedExecution(execution,'timed-out').catch(()=>{execution.clientAbort.abort();});},timeout);execution.timer.unref?.();
    execution.done=this.perform(context,record,input.command,execution);this.pending.add(execution.done);void execution.done.finally(()=>this.pending.delete(execution.done)).catch(()=>{});
    return {executionId};
  });}
  private async perform(context:Context,record:RecordData,command:string,execution:Execution):Promise<void> {
    let result:Awaited<ReturnType<ComputerBackend['run']>>|undefined,error:unknown;
    try {
      // Core's PID-marker cancellation is unused: only an ownership-checked whole-container stop cancels work here.
      result=await context.backend.run(record.handle!,context.descriptor,command,{maxBufferBytes:MAX_OUTPUT,env:{},clientSignal:execution.clientAbort.signal});
    }catch(cause){error=cause;}
    if(execution.timer)clearTimeout(execution.timer);
    await this.queue(execution.scopeKey,async()=>{
      if(result){
        const bounded=(text:string)=>{const data=Buffer.from(text);return data.length<=MAX_OUTPUT?text:data.subarray(0,MAX_OUTPUT).toString('utf8').replace(/\uFFFD$/,'');};
        Object.assign(execution.result,{stdout:bounded(result.stdout),stderr:bounded(result.stderr),stdoutTruncated:result.stdoutTruncated||Buffer.byteLength(result.stdout)>MAX_OUTPUT,stderrTruncated:result.stderrTruncated||Buffer.byteLength(result.stderr)>MAX_OUTPUT,exitCode:result.exitCode});
      }
      if(execution.stopKind&&execution.result.computerStopped)execution.result.state=execution.stopKind;
      else if(error||execution.stopKind||result?.exitCode===-1){execution.result.state='recovery-needed';execution.result.reason=error?safeReason(error):'The execution did not confirm completion. Stop this computer before starting more work.';}
      else execution.result.state=result?.exitCode===0?'completed':'failed';
      {
        try {const latest=await this.record(context);if(latest?.active?.executionId===execution.result.executionId){const receipt=latest.receipts.find(item=>item.executionId===execution.result.executionId);if(receipt)Object.assign(receipt,{state:execution.result.state,exitCode:execution.result.exitCode,computerStopped:execution.result.computerStopped});if(execution.result.state!=='recovery-needed')delete latest.active;await this.saveRecord(context,latest);}}
        catch {execution.result.state='recovery-needed';execution.result.reason='The execution ended, but its durable completion could not be recorded. Stop the computer before more work.';}
      }
      execution.settled=true;
      for(const [id,old] of this.executions){if(this.executions.size<=100)break;if(old.result.state!=='running'&&old.result.state!=='recovery-needed')this.executions.delete(id);}
    });
  }
  execution(scope:ScopedComputerRef,executionId:string):Promise<ScopedComputerExecution> {return this.withScope(scope,async authorized=>{
    const found=this.executions.get(executionId);if(found&&found.scopeKey===refKey(scope))return {...found.result};
    const context=await this.context(scope,authorized.label),record=await this.record(context);
    const receipt=record?.receipts.find(item=>item.executionId===executionId);if(receipt)return this.receiptResult(context,receipt);
    throw new ComputerInputError('This execution is not available in the selected scope.');
  });}
  async cancel(scope:ScopedComputerRef,executionId:string):Promise<ScopedComputerExecution> {
    let owned:Execution|undefined;
    const result=await this.withScope<ScopedComputerExecution>(scope,async authorized=>{
    const execution=this.executions.get(executionId);
    if(execution&&execution.scopeKey!==refKey(scope))throw new ComputerInputError('This execution is not available in the selected scope.');
    const context=await this.context(scope,authorized.label),record=await this.record(context);
    const receipt=record?.receipts.find(item=>item.executionId===executionId);const current=execution?.result??(receipt?this.receiptResult(context,receipt):undefined);
    if(!current)throw new ComputerInputError('This execution is not available in the selected scope.');
    // The matching persisted attempt must still own this scope under the same lifecycle lock.
    if(record?.active?.executionId!==executionId||!['running','recovery-needed'].includes(current.state))return {...current};
    owned=execution;
    if(execution)execution.stopKind??='cancelled';const status=await this.stopContext(context);
    if(status.state!=='stopped'){execution?.clientAbort.abort();return {...current,state:'recovery-needed',reason:status.reason??'The computer could not be confirmed stopped.'};}
    if(execution){execution.result.computerStopped=true;execution.result.state=execution.stopKind!;return {...execution.result};}
    return {...current,state:'cancelled',computerStopped:true,reason:'The entire scoped computer is stopped. Its workspace is preserved.'};
    });
    if(owned){await owned.done;return {...owned.result};}
    return result;
  }
  private stopOwnedExecution(execution:Execution,kind:'cancelled'|'timed-out'):Promise<void> {
    return this.queue(execution.scopeKey,async()=>{
      const record=await this.record(execution.context);
      if(record?.active?.executionId!==execution.result.executionId)return;
      execution.stopKind??=kind;
      const status=await this.stopContext(execution.context);
      if(status.state!=='stopped'){execution.result.state='recovery-needed';execution.result.reason=status.reason;}
      // Closing the owned CLI is not proof that the container command stopped.
      execution.clientAbort.abort();
    });
  }
  hasActiveWork():boolean {return this.pending.size>0||this.observedActiveScopes.size>0||[...this.executions.values()].some(execution=>!execution.settled||execution.result.state==='recovery-needed');}
  dispose():Promise<void> {
    if(this.disposal)return this.disposal;this.closed=true;
    // Stop active owned work, preserving containers and workspace data. Completion writes remain awaited.
    this.disposal=(async()=>{
      await Promise.allSettled([...this.locks.values()]);
      for(const execution of this.executions.values())if(execution.timer)clearTimeout(execution.timer);
      const executions=[...this.executions.values()].filter(execution=>!execution.settled||execution.result.state==='recovery-needed');
      const keys=new Set(executions.map(execution=>execution.scopeKey));
      const stops:Promise<unknown>[]=executions.map(execution=>this.stopOwnedExecution(execution,'cancelled').catch(()=>{execution.clientAbort.abort();}));
      for(const [key,context] of this.observedActiveScopes)if(!keys.has(key))stops.push(this.queue(key,()=>this.stopContext(context)));
      await Promise.allSettled(stops);
      while(this.pending.size)await Promise.allSettled([...this.pending]);
      if(this.observedActiveScopes.size||[...this.executions.values()].some(execution=>execution.result.state==='recovery-needed'))throw new ComputerInputError('Some scoped computer work could not be confirmed stopped. Check Docker and retry quitting; saved ownership is preserved.');
    })().catch(error=>{this.disposal=undefined;throw error;});return this.disposal;
  }
}
