import {createHash,randomUUID} from 'node:crypto';
import {constants,existsSync} from 'node:fs';
import {cp,lstat,mkdir,open,readdir,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import {basename,dirname,isAbsolute,join,sep} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {SCOPED_COMPUTER_DEFAULT_LIMITS,SCOPED_COMPUTER_DEFAULT_TIMEOUT_MS,SCOPED_COMPUTER_MAX_RUNNING,type ScopedComputerExportManifest,type ScopedComputerLayer,type ScopedComputerLayerId,type ScopedComputerLayerSource,type ScopedComputerLimits,type ScopedComputerService,type ScopedComputerServices,type ScopedComputerServiceSpec,type ScopedComputerUsage,SCOPED_COMPUTER_MAX_TIMEOUT_MS,type ScopedComputerCommand,type ScopedComputerEvent,type ScopedComputerExecution,type ScopedComputerFile,type ScopedComputerNetwork,type ScopedComputerProblem,type ScopedComputerRef,type ScopedComputerRun,type ScopedComputerStatus} from '../shared/scoped-computer-protocol.ts';
import {createDockerRunner,ENSURE_USER_SCRIPT,SANDBOX_IMAGE,SANDBOX_USER,type DockerResult,type SandboxProcess,type SandboxRunner,type SandboxStream} from './sandbox-exec.ts';
import {registerAgentSandboxHost,type AgentSandboxHost,type SandboxAgentTarget} from './sandbox-registry.ts';
import {SandboxToolHost} from './sandbox-agent-tools.ts';
import {BROWSER_SERVICE_COMMAND,BROWSER_SERVICE_NAME,countTree,ExtrasInputError,grantLimits,LAYER_IDS,LAYER_TARGETS,layerPath,MAX_SERVICES,mergeLimits,parseStats,restartDelay,serviceShell,snapshotLayer,validateServiceSpec,validLimits,writeWorkspaceArchive} from './scoped-computer-extras.ts';

type Scope={kind:'session'|'workspace';id:string};
type NetworkAccess='none'|'unrestricted';
export interface ComputerDescriptor {owner:Scope;root:string;workDir:string;manifestPath:string;envAllowlist:readonly string[];toolPolicy:readonly string[];limits:{networkAccess:string;maxProcesses?:number;memoryMib?:number;cpus?:number;readOnlyMounts?:readonly {source:string;target:string}[]};policyDigest:string}
export interface ComputerHandle {id:string;ownerDigest:string;image:string;createdAt:string}
type BackendOptions={dockerBin:string;dockerHost:string;managementTimeoutMs:number;durableProvisioning:true;image?:string};
export interface ComputerBackend {
  readonly lifecycleVersion:1;
  recoverProvisioning(descriptor:ComputerDescriptor):Promise<ComputerHandle|null>;
  provision(descriptor:ComputerDescriptor):Promise<ComputerHandle>;
  /** Also the ownership gate: the core verifies registry, owner digest and live container label first. */
  inspect(handle:ComputerHandle,descriptor:ComputerDescriptor):Promise<{running:boolean;exitCode:number|null}>;
  stop(handle:ComputerHandle,descriptor:ComputerDescriptor):Promise<void>;
  destroy(handle:ComputerHandle,descriptor:ComputerDescriptor):Promise<void>;
  run(handle:ComputerHandle,descriptor:ComputerDescriptor,command:string,options:{maxBufferBytes:number;env:Record<string,string>;clientSignal:AbortSignal}):Promise<{stdout:string;stderr:string;exitCode:number;stdoutTruncated:boolean;stderrTruncated:boolean}>;
}
export interface ComputerCore {
  LocalDockerSandbox:new(options:BackendOptions)=>ComputerBackend;
  resolveScopedRuntime(scopes:Scope[],config:{rootDir:string;grants:{scope:Scope;envAllowlist:string[];toolPolicy:string[];limits:{networkAccess:NetworkAccess;maxProcesses:number;memoryMib?:number;cpus?:number;readOnlyMounts?:{source:string;target:string}[]}}[]}):ComputerDescriptor;
  ensureRuntime(descriptor:ComputerDescriptor):Promise<unknown>;
}
type BundledSandboxCore = {
  LocalDockerSandbox:new(options:BackendOptions)=>any;
  resolveScopedRuntime:ComputerCore['resolveScopedRuntime'];
  ensureRuntime:ComputerCore['ensureRuntime'];
};
/** Adapt the reviewed QM-derived sandbox provider's provision/run/stop contract
 * to Agent Mode's durable execution receipt lifecycle. Keep the raw provider
 * boundary here so packaging cannot silently couple the two APIs. */
export function adaptBundledComputerCore(core:ComputerCore|BundledSandboxCore,dockerBin='docker'):ComputerCore {
  if(typeof core.LocalDockerSandbox!=='function'||typeof core.resolveScopedRuntime!=='function'||typeof core.ensureRuntime!=='function')throw new Error('Invalid scoped computer bundle exports');
  const Provider=core.LocalDockerSandbox as BundledSandboxCore['LocalDockerSandbox'];
  return {
    LocalDockerSandbox:class {
      readonly lifecycleVersion=1 as const;
      private readonly backend:any;
      private readonly nativeLifecycle:boolean;
      constructor(options:BackendOptions){
        this.backend=new Provider({...options,dockerBin:options.dockerBin||dockerBin});
        this.nativeLifecycle=this.backend.lifecycleVersion===1&&typeof this.backend.recoverProvisioning==='function';
      }
      async recoverProvisioning(descriptor:ComputerDescriptor):Promise<ComputerHandle|null>{return this.nativeLifecycle?this.backend.recoverProvisioning(descriptor):null;}
      provision(descriptor:ComputerDescriptor){return this.backend.provision(descriptor);}
      inspect(handle:ComputerHandle,descriptor:ComputerDescriptor){return this.backend.inspect(handle,descriptor);}
      stop(handle:ComputerHandle,descriptor:ComputerDescriptor){return this.backend.stop(handle,descriptor);}
      destroy(handle:ComputerHandle,descriptor:ComputerDescriptor){return this.backend.destroy(handle,descriptor);}
      async run(handle:ComputerHandle,descriptor:ComputerDescriptor,command:string,options:{maxBufferBytes:number;env:Record<string,string>;clientSignal:AbortSignal}) {
        return this.nativeLifecycle
          ? this.backend.run(handle,descriptor,command,options)
          : this.backend.run(handle,descriptor,command,{maxBufferBytes:options.maxBufferBytes,env:options.env,signal:options.clientSignal});
      }
    },
    resolveScopedRuntime:core.resolveScopedRuntime,
    ensureRuntime:core.ensureRuntime,
  } as ComputerCore;
}
export interface ScopedComputerOptions {
  appData:string;
  /** Resolve from the service's authoritative store on EVERY call; throw for unavailable references. */
  resolveScope:(ref:ScopedComputerRef)=>Promise<ScopedComputerRef&{label:string}>|ScopedComputerRef&{label:string};
  loadCore?:()=>Promise<ComputerCore>;
  /** Trusted main-process configuration only; never supplied by renderer IPC. */
  dockerHost?:string;
  dockerBin?:string;
  image?:string;
  runner?:SandboxRunner;
  onEvent?:(event:ScopedComputerEvent)=>void;
  /** Main-process dialogs; the renderer never supplies host paths. */
  pickImportPaths?:()=>Promise<string[]|null>;
  pickExportPath?:(name:string)=>Promise<string|null>;
  /** How long a killed process group may take to exit before the whole container is stopped. */
  killGraceMs?:number;
  /** SBX-16: trusted main-process layer sources (versioned by content when snapshotted); the renderer only picks ids. */
  layerSources?:()=>Promise<{id:ScopedComputerLayerId;label:string;path:string}[]>;
  /** SBX-16: main-process save dialog for a whole-workspace archive. */
  pickArchivePath?:(name:string)=>Promise<string|null>;
  /** SBX-15: base delay of supervised restarts (doubles per restart within a minute). */
  serviceBackoffMs?:number;
  tarBin?:string;
}
interface Receipt {requestId:string;executionId:string;fingerprint:string;state:ScopedComputerExecution['state'];exitCode:number|null;computerStopped:boolean}
interface RecordData {version:1;id:string;scope:ScopedComputerRef;handle:ComputerHandle|null;receipts:Receipt[];active?:{executionId:string;requestId:string;pgid?:number;ephemeral?:boolean};network?:ScopedComputerNetwork;limits?:ScopedComputerLimits;layers?:ScopedComputerLayer[]}
interface Context {id:string;scope:ScopedComputerRef;label:string;descriptor:ComputerDescriptor;recordPath:string;historyPath:string;core:ComputerCore;backend:ComputerBackend;network:ScopedComputerNetwork;limits:ScopedComputerLimits;layers:(ScopedComputerLayer&{source:string})[]}
/** SBX-15 persisted service entry; `pgid` lets a service that outlived the app be found (and stopped) again. */
interface ServiceEntry extends Omit<ScopedComputerService,'output'> {pgid?:number;/** What the user asked for; restart policies only act on services meant to be running. */desired:'running'|'stopped'}
interface ServicesFile {version:1;generation:number;containerStartedAt?:string;services:ServiceEntry[]}
interface ServiceRun {proc:SandboxProcess;generation:number}
interface Execution {clientAbort:AbortController;context:Context;scopeKey:string;requestId:string;container:string;result:ScopedComputerExecution&{command:string;startedAt:string};done:Promise<void>;proc?:SandboxProcess;pgid?:number|null;pending:Record<SandboxStream,string>;flushTimer?:ReturnType<typeof setTimeout>;stopKind?:'cancelled'|'timed-out';settled?:boolean;timer?:ReturnType<typeof setTimeout>}
class ComputerInputError extends Error {}
const MAX_OUTPUT=64*1024;
const MAX_RECEIPTS=128;
const MAX_HISTORY=50;
const HISTORY_TAIL=4*1024;
const SERVICE_TAIL=16*1024;
const SERVICE_STATES=new Set<ScopedComputerService['state']>(['starting','running','stopped','exited','failed','lost','backoff']);
const MAX_IMPORT_BYTES=2*1024**3;
const MAX_WALK=100_000;
const DAEMON=/Cannot connect to the Docker daemon|failed to connect to the docker API|Is the docker daemon running|error during connect/i;
const IMAGE=/pull access denied|manifest unknown|failed to resolve reference|No such image|toomanyrequests|TLS handshake timeout|i\/o timeout|dial tcp/i;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const refKey=(scope:ScopedComputerRef)=>JSON.stringify([scope.kind,scope.id]);
const tail=(text:string,max:number)=>{if(text.length<=max&&Buffer.byteLength(text)<=max)return text;const data=Buffer.from(text);return data.subarray(Math.max(0,data.length-max)).toString('utf8').replace(/^�+/,'');};
function validateRef(ref:ScopedComputerRef):void {
  if(!ref||!['chat','project'].includes(ref.kind)||typeof ref.id!=='string'||!ref.id||ref.id.length>256||/[\0\r\n]/.test(ref.id))throw new ComputerInputError('Select an existing chat or project for this computer.');
}
function classify(error:unknown):{reason:string;problem?:ScopedComputerProblem;repair?:ScopedComputerStatus['repair']} {
  const name=error instanceof Error?error.name:'',message=error instanceof Error?error.message:'',text=`${message}\n${String((error as {stderr?:unknown})?.stderr??'')}`;
  if(name==='SandboxOwnershipError'&&/exists but is not registered/.test(message))return {problem:'ownership',repair:'unregistered-container',reason:'A container from an interrupted start was found. Adopt it, or remove it and create a fresh one.'};
  if(name==='SandboxOwnershipError')return {problem:'ownership',reason:'The container ownership could not be verified. Its workspace has been preserved.'};
  if(name==='SandboxPolicyError')return {problem:'policy',reason:'This container uses an incompatible saved policy. Its workspace has been preserved; review its configuration before reuse.'};
  if(name==='ComputerDependencyError')return {problem:'dependency',reason:'The scoped container runtime is not included or is incompatible with this build.'};
  if(name==='ComputerIntegrityError')return {problem:'integrity',reason:'Saved computer ownership or workspace paths could not be verified. No container action was taken.'};
  if(name==='DockerMissingError'||/: exit -1\b/.test(message))return {problem:'docker-missing',reason:'Docker is not installed or could not be started. Install Docker Desktop to use sandboxes.'};
  if(DAEMON.test(text))return {problem:'daemon-down',reason:'Docker Desktop is not running. Start it, then try again. Workspace files are kept.'};
  if(name==='ComputerImageError'||IMAGE.test(text))return {problem:'image',reason:'The Linux image could not be downloaded. Check your internet connection and try Start again.'};
  return {reason:'The local Docker computer could not be reached. Start Docker Desktop and try again. Its saved workspace is preserved.'};
}
const safeReason=(error:unknown)=>classify(error).reason;
function dockerError(result:DockerResult,name='SandboxProviderError'):Error {const error=Object.assign(new Error(`docker exit ${result.code}`),{stderr:result.stderr});error.name=result.code===-1?'DockerMissingError':name;return error;}
function integrity():never {const error=new Error('Computer integrity check failed.');error.name='ComputerIntegrityError';throw error;}
async function readJSON(path:string,limit=64*1024,strict=true):Promise<unknown|null> {
  let file;
  try {file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'||!strict)return null;integrity();}
  try {const stat=await file.stat();if(!stat.isFile()||stat.size>limit)integrity();const raw=await file.readFile('utf8');if(raw.length>limit)integrity();return JSON.parse(raw);}catch{if(!strict)return null;integrity();}finally{await file.close();}
}
async function saveJSON(path:string,data:unknown):Promise<void> {
  const temp=`${path}.${randomUUID()}.tmp`;
  await writeFile(temp,JSON.stringify(data),{mode:0o600,flag:'wx',flush:true});await rename(temp,path);
}
/** Size of a tree without following links; stops counting at MAX_WALK entries. */
async function measure(path:string):Promise<{bytes:number;files:number;truncated:boolean}> {
  let bytes=0,files=0,seen=0;const stack=[path];
  while(stack.length){
    const current=stack.pop()!;let entries;
    try {entries=await readdir(current,{withFileTypes:true});}catch(error){if(current===path&&(error as NodeJS.ErrnoException).code==='ENOTDIR'){const stat=await lstat(path);return {bytes:stat.size,files:1,truncated:false};}if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    for(const entry of entries){
      if(++seen>MAX_WALK)return {bytes,files,truncated:true};
      const child=join(current,entry.name);
      if(entry.isDirectory())stack.push(child);else{files++;if(entry.isFile())bytes+=(await lstat(child)).size;}
    }
  }
  return {bytes,files,truncated:false};
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
  private readonly image:string;
  private readonly dockerBin:string;
  private runnerInstance?:SandboxRunner;
  private toolHost?:Promise<string>;
  private toolHostInstance?:SandboxToolHost;
  /** SBX-15: live service clients, restart timers and recent restart times, keyed `${computerId}:${serviceId}`. */
  private serviceRuns=new Map<string,ServiceRun>();
  private serviceTimers=new Map<string,ReturnType<typeof setTimeout>>();
  private serviceRestarts=new Map<string,number[]>();
  private serviceOutputs=new Map<string,string>();
  private generations=new Map<string,number>();
  constructor(private options:ScopedComputerOptions) {
    if(!isAbsolute(options.appData))throw new ComputerInputError('Computer app data must be an absolute path.');
    this.image=options.image??SANDBOX_IMAGE;
    this.dockerBin=options.dockerBin??['/usr/local/bin/docker','/opt/homebrew/bin/docker'].find(existsSync)??'docker';
    registerAgentSandboxHost(this);
  }
  private get runner():SandboxRunner {return this.runnerInstance??=this.options.runner??createDockerRunner(this.dockerBin);}
  private emit(event:ScopedComputerEvent):void {try {this.options.onEvent?.(event);}catch {}}
  private progress(context:Pick<Context,'id'>,phase:'pull'|'provision'|'done',message:string):void {this.emit({type:'computerProgress',computerId:context.id,phase,message});}

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
      try {core=adaptBundledComputerCore(await (this.options.loadCore?.()??Promise.resolve(createRequire(__filename)(join(__dirname,'scoped-computer-core.cjs')))),this.dockerBin);
        if(typeof core.LocalDockerSandbox!=='function'||typeof core.resolveScopedRuntime!=='function'||typeof core.ensureRuntime!=='function')throw Error();
      }catch{const error=new Error('Missing scoped computer dependency');error.name='ComputerDependencyError';throw error;}
      const socket=[join(homedir(),'.docker/run/docker.sock'),'/var/run/docker.sock'].find(existsSync)??join(homedir(),'.docker/run/docker.sock');
      const dockerHost=this.options.dockerHost??`unix://${socket}`;
      if(!/^unix:\/\/\/[^\0\r\n?#]+$/.test(dockerHost))throw new ComputerInputError('A local Docker socket is required.');
      const backend=new core.LocalDockerSandbox({dockerBin:this.dockerBin,dockerHost,managementTimeoutMs:3000,durableProvisioning:true,image:this.image});
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
    const id=`computer_${hash(owner.id).slice(0,32)}`,recordPath=join(root,`${id}.json`);
    // The saved network policy is part of the descriptor's policy digest, so it is read before resolving.
    const saved=await readJSON(recordPath) as {network?:unknown;limits?:unknown;layers?:unknown}|null;
    const network:ScopedComputerNetwork=saved?.network==='egress'?'egress':'none',networkAccess:NetworkAccess=network==='egress'?'unrestricted':'none';
    // Limits and layers are part of the policy digest too (SBX-08/16). Layer paths are recomputed, never read back.
    if(saved?.limits!==undefined&&!validLimits(saved.limits))integrity();
    const limits:ScopedComputerLimits=saved?.limits?{...saved.limits as ScopedComputerLimits}:{...SCOPED_COMPUTER_DEFAULT_LIMITS};
    const layers=this.savedLayers(root,saved?.layers);
    const descriptor=core.resolveScopedRuntime([owner],{rootDir:join(root,'runtimes'),grants:[{scope:owner,envAllowlist:[],toolPolicy:['computer.exec'],limits:{networkAccess,...grantLimits(limits,layers)}}]});
    if(descriptor.owner.kind!==owner.kind||descriptor.owner.id!==owner.id||descriptor.root!==join(root,'runtimes')||!descriptor.workDir.startsWith(descriptor.root+sep)||descriptor.envAllowlist.length||descriptor.limits.networkAccess!==networkAccess||(descriptor.limits.maxProcesses!==undefined&&descriptor.limits.maxProcesses!==limits.processes))integrity();
    // Reject planted workspace/control symlinks before a Docker bind mount or registry read.
    for(const path of [descriptor.root,dirname(descriptor.workDir),descriptor.workDir,join(descriptor.workDir,'workspace'),join(descriptor.workDir,'.sandbox')]) {
      try {const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink())integrity();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    const context={id,scope,label,descriptor,recordPath,historyPath:join(root,`${id}.history.json`),core,backend,network,limits,layers};
    const registry=await readJSON(this.registryPath(context)) as {containerName?:unknown;ownerDigest?:unknown}|null;
    if(registry&&(registry.containerName!==this.expectedHandle(context).id||registry.ownerDigest!==this.expectedHandle(context).ownerDigest))integrity();
    return context;
  }
  private savedLayers(root:string,value:unknown):(ScopedComputerLayer&{source:string})[] {
    if(value===undefined)return [];
    if(!Array.isArray(value)||value.length>LAYER_IDS.length)integrity();
    const seen=new Set<string>();
    return (value as unknown[]).map(item=>{
      const layer=item as Partial<ScopedComputerLayer>;
      if(!layer||!LAYER_IDS.includes(layer.id as ScopedComputerLayerId)||seen.has(layer.id!)||typeof layer.version!=='string'||!/^[0-9a-f]{12}$/.test(layer.version)||typeof layer.label!=='string')integrity();
      seen.add(layer.id!);const id=layer.id as ScopedComputerLayerId;
      return {id,label:layer.label.slice(0,128),version:layer.version,target:LAYER_TARGETS[id],source:layerPath(join(root,'layers'),id,layer.version)};
    });
  }
  private registryPath(context:Context){return join(context.descriptor.workDir,'.sandbox','sandbox-registry.json');}
  private workspacePath(context:Context){return join(context.descriptor.workDir,'workspace');}
  private expectedHandle(context:Context) {
    const slug=context.descriptor.workDir.split('/').filter(Boolean).at(-1)!;
    return {id:`muster-sbx-${slug}`.toLowerCase().replace(/[^a-z0-9_.-]/g,'-'),ownerDigest:`sha256:${hash(`${context.descriptor.owner.kind}:${context.descriptor.owner.id}`)}`};
  }
  private async record(context:Context):Promise<RecordData|null> {
    let data=await readJSON(context.recordPath) as RecordData|null;
    if(!data||!data.handle){
      // Recovery only finalizes a matching durable provisioning intent; it never starts a container.
      const recovered=await context.backend.recoverProvisioning(context.descriptor);
      const registry=await readJSON(this.registryPath(context)) as {containerName:string;ownerDigest:string;image:string;createdAt:string}|null;
      const handle=recovered??(registry?{id:registry.containerName,ownerDigest:registry.ownerDigest,image:registry.image,createdAt:registry.createdAt}:null);
      if(!data&&!handle)return null;
      data={version:1,id:context.id,scope:context.scope,receipts:[],...data,handle};
    }
    const expected=this.expectedHandle(context);
    if(data.version!==1||data.id!==context.id||refKey(data.scope)!==refKey(context.scope))integrity();
    if(data.handle&&(data.handle.id!==expected.id||data.handle.ownerDigest!==expected.ownerDigest||typeof data.handle.image!=='string'||typeof data.handle.createdAt!=='string'))integrity();
    if(data.active&&(typeof data.active.executionId!=='string'||typeof data.active.requestId!=='string'||(data.active.pgid!==undefined&&(!Number.isInteger(data.active.pgid)||data.active.pgid<2))||(data.active.ephemeral!==undefined&&data.active.ephemeral!==true)))integrity();
    if(data.network!==undefined&&data.network!=='none'&&data.network!=='egress')integrity();
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
    await saveJSON(context.recordPath,{...data,network:context.network,limits:context.limits,layers:context.layers.map(({id,label,version,target})=>({id,label,version,target}))});
    if(data.active)this.observedActiveScopes.set(refKey(context.scope),context);else this.observedActiveScopes.delete(refKey(context.scope));
  }
  /** History is advisory (never authority): a damaged file reads as empty instead of blocking the sandbox. */
  private async readHistory(context:Context):Promise<ScopedComputerRun[]> {
    const data=await readJSON(context.historyPath,2*1024*1024,false) as {runs?:unknown}|null;
    return Array.isArray(data?.runs)?(data.runs as ScopedComputerRun[]).filter(run=>run&&typeof run.executionId==='string'&&typeof run.command==='string'&&typeof run.stdout==='string'&&typeof run.stderr==='string').slice(-MAX_HISTORY):[];
  }
  private async writeHistory(context:Context,execution:Execution):Promise<void> {
    const r=execution.result,runs=await this.readHistory(context);
    const run:ScopedComputerRun={...r,stdout:tail(r.stdout,HISTORY_TAIL),stderr:tail(r.stderr,HISTORY_TAIL),stdoutTruncated:r.stdoutTruncated||r.stdout.length>HISTORY_TAIL,stderrTruncated:r.stderrTruncated||r.stderr.length>HISTORY_TAIL,command:r.command.slice(0,4096)};
    const index=runs.findIndex(item=>item.executionId===r.executionId);if(index===-1)runs.push(run);else runs[index]=run;
    await saveJSON(context.historyPath,{version:1,runs:runs.slice(-MAX_HISTORY)});
  }
  private receiptResult(context:Context,receipt:Receipt,run?:ScopedComputerRun):ScopedComputerExecution {
    const unresolved=receipt.state==='running'||receipt.state==='recovery-needed';
    return {executionId:receipt.executionId,computerId:context.id,state:receipt.state==='running'?'recovery-needed':receipt.state,stdout:run?.stdout??'',stderr:run?.stderr??'',stdoutTruncated:run?.stdoutTruncated??false,stderrTruncated:run?.stderrTruncated??false,exitCode:receipt.exitCode,computerStopped:receipt.computerStopped,...(run?{command:run.command,startedAt:run.startedAt,...(run.endedAt?{endedAt:run.endedAt}:{})}:{}),
      reason:unresolved?'Muster closed while this command was running. End it or stop the sandbox before running more.':run?'Restored from this sandbox’s history.':'The durable execution receipt is restored. Output from the previous app session is not retained.'};
  }
  private status(context:Pick<Context,'id'|'scope'|'label'>&{network?:ScopedComputerNetwork;limits?:ScopedComputerLimits;layers?:ScopedComputerLayer[]},state:ScopedComputerStatus['state'],reason?:string,activeExecutionId?:string,extra:Pick<ScopedComputerStatus,'problem'|'repair'>={}):ScopedComputerStatus {
    const limits=context.limits??SCOPED_COMPUTER_DEFAULT_LIMITS,generation=this.generations.get(context.id);
    return {id:context.id,scope:context.scope,label:context.label,provider:'local-docker',state,reason,activeExecutionId,workspacePreserved:true,durability:context.scope.kind==='chat'?'scratch':'durable',image:this.image,user:SANDBOX_USER,
      limits:{network:context.network??'none',memoryMiB:limits.memoryMiB,cpus:limits.cpus,processes:limits.processes,maxRunning:SCOPED_COMPUTER_MAX_RUNNING,maxTimeoutMs:SCOPED_COMPUTER_MAX_TIMEOUT_MS},
      ...(context.layers?.length?{layers:context.layers.map(({id,label,version,target})=>({id,label,version,target}))}:{}),...(generation!==undefined?{bootGeneration:generation}:{}),...extra};
  }
  private failure(context:Pick<Context,'id'|'scope'|'label'>&{network?:ScopedComputerNetwork},state:ScopedComputerStatus['state'],error:unknown,activeExecutionId?:string):ScopedComputerStatus {
    const {reason,problem,repair}=classify(error);return this.status(context,repair==='unregistered-container'?'not-created':state,reason,activeExecutionId,{...(problem?{problem}:{}),...(repair?{repair}:{})});
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
  /** A container this installation owns (label matches) that never reached the registry: a crash mid-provision. */
  private async orphan(context:Context):Promise<{running:boolean;networkMode:string;image:string}|null> {
    try {if(!(await lstat(join(context.descriptor.workDir,'.sandbox'))).isDirectory())return null;}catch {return null;}
    if(await readJSON(this.registryPath(context)))return null;
    const expected=this.expectedHandle(context);
    const result=await this.runner.docker(['inspect','-f','{{index .Config.Labels "muster.owner"}}|{{.State.Running}}|{{.HostConfig.NetworkMode}}|{{.Config.Image}}',expected.id],{timeoutMs:10_000});
    if(result.code!==0)return null;
    const [owner,running,networkMode,image]=result.stdout.trim().split('|');
    return owner===expected.ownerDigest&&image?{running:running==='true',networkMode:networkMode??'',image}:null;
  }
  private async workspaceMissing(context:Context):Promise<boolean> {try {await lstat(this.workspacePath(context));return false;}catch(error){return (error as NodeJS.ErrnoException).code==='ENOENT';}}

  inspect(scope:ScopedComputerRef):Promise<ScopedComputerStatus> {return this.withScope(scope,async authorized=>{
    let context:Context|undefined;
    try {context=await this.context(scope,authorized.label);const record=await this.record(context);
      if(!record?.handle){
        if(await this.orphan(context))return this.status(context,'not-created','A container from an interrupted start was found. Adopt it, or remove it and create a fresh one.',undefined,{problem:'ownership',repair:'unregistered-container'});
        return this.status(context,'not-created');
      }
      if(record.active&&(!this.executions.has(record.active.executionId)||this.executions.get(record.active.executionId)?.result.state==='recovery-needed'))return this.status(context,'recovery-needed','Muster closed while a command was running. End that command or stop the sandbox before running more.',record.active.executionId);
      if(await this.workspaceMissing(context))return this.status(context,'unavailable','This sandbox’s workspace folder was deleted outside Muster. Recreate the container to continue.',record.active?.executionId,{problem:'workspace-missing',repair:'workspace-missing'});
      const state=await context.backend.inspect(record.handle,context.descriptor);return this.status(context,state.running?'running':'stopped',undefined,record.active?.executionId);
    }catch(error){return this.failure(context??{id:'',scope,label:authorized.label},'unavailable',error);}
  });}
  start(scope:ScopedComputerRef):Promise<ScopedComputerStatus> {return this.withScope(scope,async authorized=>{
    const context=await this.context(scope,authorized.label);return this.provision(context,await this.record(context));
  });}
  private async provision(context:Context,old:RecordData|null):Promise<ScopedComputerStatus> {
    if(old?.active)return this.status(context,'recovery-needed','An execution still owns this computer. Wait for it to finish or stop the computer first.',old.active.executionId);
    try {
      if(old?.handle&&(await context.backend.inspect(old.handle,context.descriptor)).running)return this.status(context,'running');
      await this.admit(context);await this.ensureImage(context);
      this.progress(context,'provision','Starting the Linux container…');
      await context.core.ensureRuntime(context.descriptor);if(this.closed)throw new ComputerInputError('Scoped computers are shutting down.');const handle=await context.backend.provision(context.descriptor);const expected=this.expectedHandle(context);if(handle.id!==expected.id||handle.ownerDigest!==expected.ownerDigest)integrity();
      await this.saveRecord(context,{version:1,id:context.id,scope:context.scope,handle,receipts:old?.receipts??[]});
      if(this.closed)await context.backend.stop(handle,context.descriptor);
      const actual=await context.backend.inspect(handle,context.descriptor);
      if(actual.running)await this.runner.docker(['exec',handle.id,'sh','-c',ENSURE_USER_SCRIPT],{timeoutMs:20_000});
      if(actual.running)await this.syncBoot(context,handle).catch(()=>{});
      this.progress(context,'done','');
      return this.status(context,actual.running?'running':'stopped');
    }catch(error){this.progress(context,'done','');if(error instanceof ComputerInputError)throw error;return this.failure(context,'unavailable',error);}
  }
  /** Global admission: at most SCOPED_COMPUTER_MAX_RUNNING of this installation's sandboxes run at once. */
  private async admit(context:Context):Promise<void> {
    const {root}=await this.init(),names=new Set<string>();
    for(const file of await readdir(root))if(/^computer_[0-9a-f]{32}\.json$/.test(file)&&file!==`${context.id}.json`){
      const data=await readJSON(join(root,file),64*1024,false) as RecordData|null;if(typeof data?.handle?.id==='string')names.add(data.handle.id);
    }
    if(names.size<SCOPED_COMPUTER_MAX_RUNNING)return;
    const result=await this.runner.docker(['ps','--filter','label=muster.sandbox=1','--format','{{.Names}}'],{timeoutMs:10_000});
    if(result.code!==0)throw dockerError(result);
    const running=result.stdout.split('\n').map(name=>name.trim()).filter(name=>names.has(name));
    if(running.length>=SCOPED_COMPUTER_MAX_RUNNING)throw new ComputerInputError(`${SCOPED_COMPUTER_MAX_RUNNING} sandboxes are already running. Stop one before starting another.`);
  }
  /** The first start downloads the pinned image with visible progress and one bounded retry. */
  private async ensureImage(context:Context):Promise<void> {
    const found=await this.runner.docker(['image','inspect','--format','{{.Id}}',this.image],{timeoutMs:15_000});
    if(found.code===0)return;
    if(found.code===-1||DAEMON.test(found.stderr))throw dockerError(found);
    for(let attempt=1;;attempt++){
      const layers=new Set<string>(),complete=new Set<string>();let last=0;
      this.progress(context,'pull',attempt===1?'Downloading the Linux image (first start only)…':'Retrying the Linux image download…');
      const result=await this.runner.docker(['pull',this.image],{timeoutMs:20*60_000,maxBytes:64*1024,onLine:line=>{
        const match=/^([0-9a-f]{12}): (.*)$/.exec(line.trim());if(!match)return;layers.add(match[1]);if(/Pull complete|Already exists/.test(match[2]))complete.add(match[1]);
        const now=Date.now();if(now-last<250)return;last=now;this.progress(context,'pull',`Downloading the Linux image · ${complete.size} of ${layers.size} layers`);
      }});
      if(result.code===0)return;
      if(attempt>=2||result.code===-1||DAEMON.test(result.stderr))throw dockerError(result,'ComputerImageError');
      await delay(1500);
    }
  }
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
    }catch(error){return this.failure(context,'unknown',error,record.active?.executionId);}
  }
  destroy(scope:ScopedComputerRef):Promise<ScopedComputerStatus> {return this.withScope(scope,async authorized=>{
    const context=await this.context(scope,authorized.label);const record=await this.record(context);if(!record?.handle)return this.status(context,'not-created');
    if(record.active)return this.status(context,'recovery-needed','Stop the active execution before removing its container.',record.active.executionId);
    try {await context.backend.destroy(record.handle,context.descriptor);record.handle=null;await this.saveRecord(context,record);return this.status(context,'not-created','Container removed. The durable workspace is retained.');}
    catch(error){return this.failure(context,'unknown',error);}
  });}
  /** `ephemeral` (agent tool calls): no durable receipt, so a long agent turn never hits the receipt cap; the active gate still holds. */
  exec(input:{scope:ScopedComputerRef;command:string;requestId:string;timeoutMs?:number;ephemeral?:boolean}):Promise<{executionId:string}> {return this.withScope(input.scope,async authorized=>{
    if(typeof input.command!=='string'||!input.command.trim()||input.command.length>16*1024||input.command.includes('\0'))throw new ComputerInputError('Enter a container command of up to 16 KiB.');
    if(typeof input.requestId!=='string'||!input.requestId||input.requestId.length>128)throw new ComputerInputError('A valid execution request identity is required.');
    const timeout=input.timeoutMs??SCOPED_COMPUTER_DEFAULT_TIMEOUT_MS;if(!Number.isInteger(timeout)||timeout<100||timeout>SCOPED_COMPUTER_MAX_TIMEOUT_MS)throw new ComputerInputError('Execution timeout must be between 100 ms and 2 hours.');
    const key=refKey(input.scope),fingerprint=hash(JSON.stringify([input.command,timeout]));
    const context=await this.context(input.scope,authorized.label),record=await this.record(context);
    const replay=input.ephemeral?undefined:record?.receipts.find(receipt=>receipt.requestId===input.requestId);
    if(replay){if(replay.fingerprint!==fingerprint)throw new ComputerInputError('This request identity already belongs to a different command or timeout. Use a new request identity for new work.');return {executionId:replay.executionId};}
    if(!record?.handle)throw new ComputerInputError('Start this scoped computer before running a command.');
    if(record.active)await this.resolveStaleAgentExecution(context,record);
    if(record.active)throw new ComputerInputError('This computer has an active or unresolved execution. Wait for completion or stop it first.');
    if(!input.ephemeral&&record.receipts.length>=MAX_RECEIPTS)throw new ComputerInputError('This computer has reached its durable execution receipt limit. New commands are blocked to preserve retry safety; use a new scope for new work.');
    // Ownership gate (registry, owner digest, live label) immediately before every exec.
    if(!(await context.backend.inspect(record.handle,context.descriptor)).running)throw new ComputerInputError('Start this scoped computer before running a command.');
    for(const [id,old] of this.executions){if(this.executions.size<100)break;if(old.settled&&old.result.state!=='recovery-needed')this.executions.delete(id);}
    if(this.executions.size>=100)throw new ComputerInputError('Too many unresolved executions. Stop an existing computer before starting more work.');
    if(this.closed)throw new ComputerInputError('Scoped computers are shutting down.');
    const executionId=randomUUID(),startedAt=new Date().toISOString();record.active={executionId,requestId:input.requestId,...(input.ephemeral?{ephemeral:true as const}:{})};if(!input.ephemeral)record.receipts.push({executionId,requestId:input.requestId,fingerprint,state:'running',exitCode:null,computerStopped:false});await this.saveRecord(context,record);
    if(this.closed){delete record.active;record.receipts.at(-1)!.state='cancelled';await this.saveRecord(context,record);throw new ComputerInputError('Scoped computers are shutting down.');}
    const execution:Execution={clientAbort:new AbortController(),context,scopeKey:key,requestId:input.requestId,container:record.handle.id,pending:{stdout:'',stderr:''},result:{executionId,computerId:context.id,state:'running',stdout:'',stderr:'',stdoutTruncated:false,stderrTruncated:false,exitCode:null,computerStopped:false,command:input.command,startedAt},done:Promise.resolve()};
    this.executions.set(executionId,execution);
    await this.writeHistory(context,execution).catch(()=>{});
    try {execution.proc=this.runner.exec(execution.container,input.command,{onOutput:(stream,data)=>this.output(execution,stream,data)});}catch {}
    execution.clientAbort.signal.addEventListener('abort',()=>execution.proc?.detach(),{once:true});
    void execution.proc?.pgid.then(pgid=>{execution.pgid=pgid;if(pgid)return this.queue(key,async()=>{const latest=await this.record(context);if(latest?.active?.executionId!==executionId)return;latest.active.pgid=pgid;await this.saveRecord(context,latest);});}).catch(()=>{});
    execution.timer=setTimeout(()=>{void this.terminate(execution,'timed-out').catch(()=>{});},timeout);execution.timer.unref?.();
    execution.done=this.perform(context,execution);this.pending.add(execution.done);void execution.done.finally(()=>this.pending.delete(execution.done)).catch(()=>{});
    return {executionId};
  });}
  private output(execution:Execution,stream:SandboxStream,data:string):void {
    const r=execution.result,next=tail(r[stream]+data,MAX_OUTPUT);
    if(next.length<r[stream].length+data.length)r[stream==='stdout'?'stdoutTruncated':'stderrTruncated']=true;
    r[stream]=next;execution.pending[stream]=tail(execution.pending[stream]+data,MAX_OUTPUT);
    // Coalesce chunks into ~30 events/s so a chatty build never floods IPC.
    execution.flushTimer??=setTimeout(()=>this.flush(execution),32);
  }
  private flush(execution:Execution):void {
    if(execution.flushTimer)clearTimeout(execution.flushTimer);execution.flushTimer=undefined;
    for(const stream of ['stdout','stderr'] as const){const data=execution.pending[stream];if(!data)continue;execution.pending[stream]='';this.emit({type:'computerOutput',computerId:execution.context.id,execId:execution.result.executionId,stream,data});}
  }
  private async perform(context:Context,execution:Execution):Promise<void> {
    const outcome=execution.proc?await execution.proc.done:{exitCode:null,error:'spawn-failed'};
    if(execution.timer)clearTimeout(execution.timer);
    this.flush(execution);
    await this.queue(execution.scopeKey,async()=>{
      const r=execution.result;
      Object.assign(r,{exitCode:outcome.exitCode,endedAt:new Date().toISOString()});
      // Escalation already marked it uncertain (the container stop was not confirmed): keep the guard.
      if(r.state==='recovery-needed'){}
      else if(execution.stopKind){r.state=execution.stopKind;r.reason=execution.stopKind==='timed-out'?'Stopped at its time limit. The sandbox kept running.':r.computerStopped?'Cancelled by stopping the whole sandbox; its workspace is kept.':'Cancelled. The sandbox kept running.';}
      else if(outcome.error){r.state='failed';r.reason=outcome.error==='docker-missing'?classify(Object.assign(new Error(),{name:'DockerMissingError'})).reason:'The command could not be started in the sandbox.';}
      else r.state=outcome.exitCode===0?'completed':'failed';
      try {const latest=await this.record(context);if(latest?.active?.executionId===r.executionId){const receipt=latest.receipts.find(item=>item.executionId===r.executionId);if(receipt)Object.assign(receipt,{state:r.state,exitCode:r.exitCode,computerStopped:r.computerStopped});if(r.state!=='recovery-needed')delete latest.active;await this.saveRecord(context,latest);}}
      catch {r.state='recovery-needed';r.reason='The execution ended, but its durable completion could not be recorded. Stop the computer before more work.';}
      await this.writeHistory(context,execution).catch(()=>{});
      execution.settled=true;
      this.emit({type:'computerExecution',computerId:context.id,execution:{...r}});
      for(const [id,old] of this.executions){if(this.executions.size<=100)break;if(old.result.state!=='running'&&old.result.state!=='recovery-needed')this.executions.delete(id);}
    });
  }
  /** Ends one execution: TERM/KILL its process group inside the container after the ownership gate.
   * Only if the group cannot be confirmed gone is the whole container stopped. */
  private async terminate(execution:Execution,kind:'cancelled'|'timed-out'):Promise<void> {
    let owned=false,killed=false;
    await this.queue(execution.scopeKey,async()=>{
      const record=await this.record(execution.context);
      if(execution.settled||record?.active?.executionId!==execution.result.executionId||!record.handle)return;
      owned=true;execution.stopKind??=kind;
      try {
        if(!(await execution.context.backend.inspect(record.handle,execution.context.descriptor)).running)return;
        const pgid=execution.pgid??await Promise.race([execution.proc?.pgid??Promise.resolve(null),delay(2000,null)]);
        if(pgid)killed=(await this.runner.killGroup(execution.container,pgid)).code===0;
      }catch {}
    });
    if(!owned||execution.settled)return;
    if(killed&&await Promise.race([execution.done.then(()=>true),delay(this.options.killGraceMs??5000,false)]))return;
    await this.queue(execution.scopeKey,async()=>{
      const record=await this.record(execution.context);
      if(record?.active?.executionId===execution.result.executionId&&!execution.settled){
        const status=await this.stopContext(execution.context);
        if(status.state!=='stopped'){execution.result.state='recovery-needed';execution.result.reason=status.reason;}
      }
      // Closing the owned CLI is not proof that the container command stopped.
      execution.clientAbort.abort();
    }).catch(()=>execution.clientAbort.abort());
    await execution.done;
  }
  input(scope:ScopedComputerRef,execId:string,data?:unknown,eof?:unknown):Promise<void> {return this.withScope(scope,async()=>{
    const execution=typeof execId==='string'?this.executions.get(execId):undefined;
    if(!execution||execution.scopeKey!==refKey(scope))throw new ComputerInputError('This execution is not available in the selected scope.');
    if(execution.settled||!execution.proc)throw new ComputerInputError('This command has already finished.');
    if(data!==undefined){if(typeof data!=='string'||data.length>64*1024)throw new ComputerInputError('Input must be text of up to 64 KiB.');execution.proc.write(data);}
    if(eof===true)execution.proc.end();
  });}
  execution(scope:ScopedComputerRef,executionId:string):Promise<ScopedComputerExecution> {return this.withScope(scope,async authorized=>{
    const found=this.executions.get(executionId);if(found&&found.scopeKey===refKey(scope))return {...found.result};
    const context=await this.context(scope,authorized.label),record=await this.record(context);
    const receipt=record?.receipts.find(item=>item.executionId===executionId);if(receipt)return this.receiptResult(context,receipt,(await this.readHistory(context)).find(run=>run.executionId===executionId));
    throw new ComputerInputError('This execution is not available in the selected scope.');
  });}
  history(scope:ScopedComputerRef):Promise<ScopedComputerRun[]> {return this.withScope(scope,async authorized=>{
    const context=await this.context(scope,authorized.label),key=refKey(scope);
    return (await this.readHistory(context)).map(run=>{
      const live=this.executions.get(run.executionId);
      if(live&&live.scopeKey===key)return {...live.result};
      return run.state==='running'?{...run,state:'recovery-needed' as const,restored:true,reason:'Ended when Muster closed. Output up to that point is shown.'}:run;
    });
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
      if(execution&&!execution.settled&&execution.result.state==='running'){owned=execution;return {...current};}
      // Restored from a previous session: end its process group by the persisted id when the container still runs it.
      if(!execution&&record.active.pgid&&record.handle)try {
        const alive=(await context.backend.inspect(record.handle,context.descriptor)).running;
        if(!alive||(await this.runner.killGroup(record.handle.id,record.active.pgid)).code===0){
          if(receipt)Object.assign(receipt,{state:'cancelled',computerStopped:!alive});delete record.active;await this.saveRecord(context,record);
          const runs=await this.readHistory(context),run=runs.find(item=>item.executionId===executionId);
          if(run){Object.assign(run,{state:'cancelled',endedAt:new Date().toISOString()});await saveJSON(context.historyPath,{version:1,runs}).catch(()=>{});}
          return {...current,state:'cancelled',computerStopped:!alive,reason:alive?'The previous command was ended. The sandbox kept running.':'The previous command is no longer running.'};
        }
      }catch {}
      if(execution)execution.stopKind??='cancelled';const status=await this.stopContext(context);
      if(status.state!=='stopped'){execution?.clientAbort.abort();return {...current,state:'recovery-needed',reason:status.reason??'The computer could not be confirmed stopped.'};}
      if(execution){execution.result.computerStopped=true;execution.result.state=execution.stopKind!;return {...execution.result};}
      return {...current,state:'cancelled',computerStopped:true,reason:'The entire scoped computer is stopped. Its workspace is preserved.'};
    });
    if(owned){await this.terminate(owned,'cancelled');return {...owned.result};}
    return result;
  }
  setNetwork(scope:ScopedComputerRef,network:unknown,confirmed?:unknown):Promise<ScopedComputerStatus> {return this.withScope(scope,async authorized=>{
    if(network!=='none'&&network!=='egress')throw new ComputerInputError('Choose no network or internet access.');
    if(network==='egress'&&confirmed!==true)throw new ComputerInputError('Confirm internet access before enabling it for this sandbox.');
    const context=await this.context(scope,authorized.label),record=await this.record(context);
    if(record?.active)throw new ComputerInputError('Stop the running command before changing the network policy.');
    if(context.network===network)return record?.handle?this.status(context,(await context.backend.inspect(record.handle,context.descriptor)).running?'running':'stopped'):this.status(context,'not-created');
    let wasRunning=false;
    try {
      // The network is part of the container's policy digest: the old container is removed under its old policy.
      if(record?.handle){wasRunning=(await context.backend.inspect(record.handle,context.descriptor)).running;await context.backend.destroy(record.handle,context.descriptor);record.handle=null;}
    }catch(error){return this.failure(context,'unknown',error);}
    await this.saveRecord({...context,network},record??{version:1,id:context.id,scope,handle:null,receipts:[]});
    const reopened=await this.context(scope,authorized.label);
    return wasRunning?this.provision(reopened,await this.record(reopened)):this.status(reopened,'not-created',`Network set to ${network==='egress'?'internet access':'no network'}. Start the sandbox to create it with this policy.`);
  });}
  repair(scope:ScopedComputerRef,action:unknown):Promise<ScopedComputerStatus> {return this.withScope(scope,async authorized=>{
    if(action!=='adopt'&&action!=='recreate')throw new ComputerInputError('Choose Adopt or Remove and recreate.');
    const context=await this.context(scope,authorized.label),record=await this.record(context),expected=this.expectedHandle(context);
    if(record?.active)throw new ComputerInputError('Stop the running command before repairing this sandbox.');
    if(action==='adopt'){
      if(record?.handle)throw new ComputerInputError('This sandbox is already registered; nothing to adopt.');
      const orphan=await this.orphan(context);if(!orphan)throw new ComputerInputError('No interrupted container was found for this sandbox.');
      const networkMode=context.network==='egress'?'bridge':'none';
      if(orphan.networkMode!==networkMode)throw new ComputerInputError('That container uses a different network policy. Remove and recreate it instead.');
      const handle={id:expected.id,ownerDigest:expected.ownerDigest,image:orphan.image,createdAt:new Date().toISOString()};
      // Same registry shape and policy binding the core writes after `docker run`; the core re-verifies it and the live label next.
      await mkdir(join(context.descriptor.workDir,'.sandbox'),{recursive:true,mode:0o700});
      await saveJSON(this.registryPath(context),{containerName:handle.id,ownerDigest:handle.ownerDigest,image:handle.image,createdAt:handle.createdAt,policyDigest:`sha256:${hash(`${handle.image}\n${networkMode}\n${context.descriptor.policyDigest}`)}`});
      try {
        const actual=await context.backend.inspect(handle,context.descriptor);
        await this.saveRecord(context,{version:1,id:context.id,scope,handle,receipts:record?.receipts??[]});
        if(actual.running)await this.runner.docker(['exec',handle.id,'sh','-c',ENSURE_USER_SCRIPT],{timeoutMs:20_000});
        return this.status(context,actual.running?'running':'stopped','Recovered the container from the interrupted start.');
      }catch(error){await rm(this.registryPath(context),{force:true});return this.failure(context,'unavailable',error);}
    }
    try {
      if(record?.handle){await context.backend.destroy(record.handle,context.descriptor);record.handle=null;await this.saveRecord(context,record);}
      else if(await this.orphan(context)){const removed=await this.runner.docker(['rm','-f',expected.id],{timeoutMs:30_000});if(removed.code!==0)throw dockerError(removed);}
    }catch(error){return this.failure(context,'unknown',error);}
    return this.provision(context,await this.record(context));
  });}
  /** Relative workspace path, refusing `..`, absolute paths and any symlink along the way. */
  private async workspaceEntry(context:Context,path:unknown):Promise<{absolute:string;relative:string}> {
    if(path===undefined||path===null)path='';
    if(typeof path!=='string'||path.length>1024||path.includes('\0'))throw new ComputerInputError('Choose a file inside the sandbox workspace.');
    const parts=path.split('/').filter(part=>part&&part!=='.');if(parts.includes('..'))throw new ComputerInputError('Choose a file inside the sandbox workspace.');
    let absolute=this.workspacePath(context);
    for(const part of parts){absolute=join(absolute,part);let stat;try {stat=await lstat(absolute);}catch {throw new ComputerInputError('That file no longer exists in the workspace.');}if(stat.isSymbolicLink())throw new ComputerInputError('Links inside the workspace are not followed.');}
    return {absolute,relative:parts.join('/')};
  }
  filesList(scope:ScopedComputerRef,path?:unknown):Promise<{path:string;entries:ScopedComputerFile[];truncated:boolean}> {return this.withScope(scope,async authorized=>{
    const context=await this.context(scope,authorized.label),{absolute,relative}=await this.workspaceEntry(context,path);
    let names;try {names=await readdir(absolute,{withFileTypes:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'&&!relative)return {path:'',entries:[],truncated:false};throw new ComputerInputError('That folder could not be read.');}
    const entries:ScopedComputerFile[]=[];
    for(const entry of names.slice(0,1000)){
      try {const stat=await lstat(join(absolute,entry.name));entries.push({name:entry.name,path:relative?`${relative}/${entry.name}`:entry.name,kind:stat.isSymbolicLink()?'symlink':stat.isDirectory()?'directory':'file',size:stat.isFile()?stat.size:0,modifiedAt:stat.mtime.toISOString()});}catch {}
    }
    entries.sort((a,b)=>Number(b.kind==='directory')-Number(a.kind==='directory')||a.name.localeCompare(b.name));
    return {path:relative,entries,truncated:names.length>1000};
  });}
  async filesImport(scope:ScopedComputerRef,into?:unknown):Promise<{imported:string[]}> {
    if(!this.options.pickImportPaths)throw new ComputerInputError('Importing files is not available in this build.');
    await this.withScope(scope,async authorized=>{await this.workspaceEntry(await this.context(scope,authorized.label),into);});
    const sources=await this.options.pickImportPaths();if(!sources?.length)return {imported:[]};
    return this.withScope(scope,async authorized=>{
      const context=await this.context(scope,authorized.label),{absolute,relative}=await this.workspaceEntry(context,into);
      await mkdir(absolute,{recursive:true,mode:0o700});
      let total=0;for(const source of sources){if(!isAbsolute(source))throw new ComputerInputError('Choose files to import.');const size=await measure(source);total+=size.bytes;if(size.truncated||total>MAX_IMPORT_BYTES)throw new ComputerInputError('That selection is too large to import (limit 2 GB or 100,000 items).');}
      const imported:string[]=[];
      // Copied on the host into the bind mount, so files keep the ownership mapping every other workspace file has.
      for(const source of sources){
        const name=basename(source);let target=name;for(let n=2;existsSync(join(absolute,target));n++)target=`${name} ${n}`;
        await cp(source,join(absolute,target),{recursive:true,errorOnExist:true,force:false,verbatimSymlinks:true});
        imported.push(relative?`${relative}/${target}`:target);
      }
      return {imported};
    });
  }
  async filesExport(scope:ScopedComputerRef,path:unknown):Promise<{savedTo:string}|null> {
    if(!this.options.pickExportPath)throw new ComputerInputError('Exporting files is not available in this build.');
    const name=await this.withScope(scope,async authorized=>{const {relative}=await this.workspaceEntry(await this.context(scope,authorized.label),path);if(!relative)throw new ComputerInputError('Choose a file or folder to export.');return basename(relative);});
    const destination=await this.options.pickExportPath(name);if(!destination)return null;
    if(!isAbsolute(destination))throw new ComputerInputError('Choose where to save the export.');
    return this.withScope(scope,async authorized=>{
      const context=await this.context(scope,authorized.label),{absolute,relative}=await this.workspaceEntry(context,path),record=await this.record(context);
      if(record?.handle)try {
        // docker cp reads inside the container's view (never following links out) after the ownership gate.
        await context.backend.inspect(record.handle,context.descriptor);
        const copied=await this.runner.docker(['cp',`${record.handle.id}:/workspace/${relative}`,destination],{timeoutMs:10*60_000});
        if(copied.code===0)return {savedTo:destination};
      }catch {}
      await cp(absolute,destination,{recursive:true,force:true,verbatimSymlinks:true});
      return {savedTo:destination};
    });
  }
  workspaceSize(scope:ScopedComputerRef):Promise<{bytes:number;files:number;truncated:boolean}> {return this.withScope(scope,async authorized=>measure(this.workspacePath(await this.context(scope,authorized.label))));}
  workspaceDelete(scope:ScopedComputerRef,confirmed:unknown,removeContainer?:unknown):Promise<ScopedComputerStatus> {return this.withScope(scope,async authorized=>{
    if(confirmed!==true)throw new ComputerInputError('Confirm deleting the workspace files first.');
    const context=await this.context(scope,authorized.label),record=await this.record(context);
    if(record?.active)throw new ComputerInputError('Stop the running command before deleting workspace files.');
    try {if(removeContainer===true&&record?.handle){await context.backend.destroy(record.handle,context.descriptor);record.handle=null;await this.saveRecord(context,record);}}
    catch(error){return this.failure(context,'unknown',error);}
    const workspace=this.workspacePath(context);let names:string[]=[];try {names=await readdir(workspace);}catch {}
    // rm never follows links; the folder itself stays so a running container's mount remains valid.
    for(const name of names)await rm(join(workspace,name),{recursive:true,force:true});
    if(removeContainer===true)await rm(context.historyPath,{force:true});
    if(!record?.handle)return this.status(context,'not-created',removeContainer===true?'Sandbox disposed: container removed and workspace files deleted.':'Workspace files deleted.');
    try {return this.status(context,(await context.backend.inspect(record.handle,context.descriptor)).running?'running':'stopped','Workspace files deleted.');}catch(error){return this.failure(context,'unknown',error);}
  });}
  // --- SBX-08/15/16: resources, supervised services, read-only layers and archive export --------------------------
  /** Rethrows a helper's validation message as user-facing input (withScope hides any other error's text). */
  private checked<T>(action:()=>T):T {try {return action();}catch(error){if(error instanceof ExtrasInputError)throw new ComputerInputError(error.message);throw error;}}
  /**
   * Applies a policy change (limits or layers) the same way the network switch does: the old container is removed under
   * its old policy, the new policy is saved, and the sandbox is recreated if it was running. Workspace files are kept.
   */
  private async reconfigure(scope:ScopedComputerRef,label:string,context:Context,record:RecordData|null,patch:Partial<Pick<Context,'limits'|'layers'>>,what:string):Promise<ScopedComputerStatus> {
    if(record?.active)throw new ComputerInputError(`Stop the running command before changing the sandbox ${what}.`);
    let wasRunning=false;
    try {
      if(record?.handle){wasRunning=(await context.backend.inspect(record.handle,context.descriptor)).running;this.forgetServiceRuns(context);await context.backend.destroy(record.handle,context.descriptor);record.handle=null;}
    }catch(error){return this.failure(context,'unknown',error);}
    await this.saveRecord({...context,...patch},record??{version:1,id:context.id,scope,handle:null,receipts:[]});
    const reopened=await this.context(scope,label);
    return wasRunning?this.provision(reopened,await this.record(reopened)):this.status(reopened,'not-created',`Saved the new ${what}. Start the sandbox to create it with them.`);
  }
  setLimits(scope:ScopedComputerRef,patch:unknown):Promise<ScopedComputerStatus> {return this.withScope(scope,async authorized=>{
    const context=await this.context(scope,authorized.label),record=await this.record(context);
    const next=this.checked(()=>mergeLimits(context.limits,patch));
    if(next.memoryMiB===context.limits.memoryMiB&&next.cpus===context.limits.cpus&&next.processes===context.limits.processes)
      return record?.handle?this.status(context,(await context.backend.inspect(record.handle,context.descriptor)).running?'running':'stopped'):this.status(context,'not-created');
    return this.reconfigure(scope,authorized.label,context,record,{limits:next},'limits');
  });}
  /** Live cgroup usage, read only after the ownership gate confirms this scope's container. */
  usage(scope:ScopedComputerRef):Promise<ScopedComputerUsage> {return this.withScope(scope,async authorized=>{
    const context=await this.context(scope,authorized.label),record=await this.record(context),sampledAt=new Date().toISOString();
    const idle={computerId:context.id,running:false,memoryBytes:null,memoryLimitBytes:null,cpuPercent:null,pids:null,sampledAt};
    if(!record?.handle||!(await context.backend.inspect(record.handle,context.descriptor)).running)return idle;
    const stats=await this.runner.docker(['stats','--no-stream','--format','{{json .}}',record.handle.id],{timeoutMs:15_000});
    if(stats.code!==0)throw dockerError(stats);
    return {...idle,running:true,...parseStats(stats.stdout)};
  });}
  private async layerSourceList():Promise<{id:ScopedComputerLayerId;label:string;path:string}[]> {
    const sources=await this.options.layerSources?.()??[];
    return sources.filter(source=>LAYER_IDS.includes(source.id)&&typeof source.path==='string'&&isAbsolute(source.path));
  }
  layersSources(scope:ScopedComputerRef):Promise<{sources:ScopedComputerLayerSource[];active:ScopedComputerLayer[]}> {return this.withScope(scope,async authorized=>{
    const context=await this.context(scope,authorized.label),found=await this.layerSourceList();
    const sources:ScopedComputerLayerSource[]=[];
    for(const id of LAYER_IDS){
      const source=found.find(item=>item.id===id);
      const stat=source?await lstat(source.path).catch(()=>null):null;
      const available=!!stat&&stat.isDirectory()&&!stat.isSymbolicLink();
      sources.push({id,label:source?.label??(id==='skills'?'Skills':'Tools'),available,...(available?{}:{reason:source?'Its folder is missing.':'Nothing to mount yet.'})});
    }
    return {sources,active:context.layers.map(({id,label,version,target})=>({id,label,version,target}))};
  });}
  layersSet(scope:ScopedComputerRef,ids:unknown):Promise<ScopedComputerStatus> {return this.withScope(scope,async authorized=>{
    if(!Array.isArray(ids)||ids.length>LAYER_IDS.length||ids.some(id=>!LAYER_IDS.includes(id))||new Set(ids).size!==ids.length)throw new ComputerInputError('Choose which layers to mount.');
    const context=await this.context(scope,authorized.label),record=await this.record(context),{root}=await this.init(),found=await this.layerSourceList();
    const layers:(ScopedComputerLayer&{source:string})[]=[];
    for(const id of [...ids as ScopedComputerLayerId[]].sort()){
      const source=found.find(item=>item.id===id);if(!source)throw new ComputerInputError(`No ${id} are available to mount.`);
      try {layers.push(await snapshotLayer(join(root,'layers'),id,source.label.slice(0,128),source.path));}
      catch(error){if(error instanceof ExtrasInputError)throw new ComputerInputError(error.message);throw error;}
    }
    const same=layers.length===context.layers.length&&layers.every(layer=>context.layers.some(item=>item.id===layer.id&&item.version===layer.version));
    if(same)return record?.handle?this.status(context,(await context.backend.inspect(record.handle,context.descriptor)).running?'running':'stopped'):this.status(context,'not-created');
    return this.reconfigure(scope,authorized.label,context,record,{layers},'layers');
  });}
  exportArchive(scope:ScopedComputerRef):Promise<{savedTo:string;manifestPath:string;manifest:ScopedComputerExportManifest}|null> {
    const pick=this.options.pickArchivePath??this.options.pickExportPath;
    if(!pick)return Promise.reject(new ComputerInputError('Exporting is not available in this build.'));
    return (async()=>{
      const label=await this.withScope(scope,async authorized=>authorized.label);
      const destination=await pick(`${label.replace(/[^A-Za-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,64)||'sandbox'}-sandbox.tar.gz`);
      if(!destination)return null;
      if(!isAbsolute(destination))throw new ComputerInputError('Choose where to save the export.');
      return this.withScope(scope,async authorized=>{
        const context=await this.context(scope,authorized.label),{root}=await this.init(),workspace=this.workspacePath(context);
        const counts=await countTree(workspace);
        if(counts.truncated||counts.bytes>MAX_IMPORT_BYTES)throw new ComputerInputError('This workspace is too large to export as one archive (limit 2 GB or 100,000 items). Export folders individually.');
        await mkdir(workspace,{recursive:true,mode:0o700});
        const manifest:ScopedComputerExportManifest={format:'muster-sandbox-export/1',computerId:context.id,label:context.label,scope:context.scope.kind,image:this.image,network:context.network,limits:{...context.limits},
          layers:context.layers.map(({id,label,version,target})=>({id,label,version,target})),exportedAt:new Date().toISOString(),files:counts.files,directories:counts.directories,symlinks:counts.symlinks,bytes:counts.bytes,archiveBytes:0,archiveSha256:''};
        try {const written=await writeWorkspaceArchive(workspace,destination,manifest,root,this.options.tarBin);return {savedTo:destination,...written};}
        catch {throw new ComputerInputError('The archive could not be written. Check the destination and free space, then try again.');}
      });
    })();
  }

  private servicesPath(context:Pick<Context,'id'|'recordPath'>){return join(dirname(context.recordPath),`${context.id}.services.json`);}
  private serviceKey(context:Pick<Context,'id'>,serviceId:string){return `${context.id}:${serviceId}`;}
  /** Advisory like history: a damaged file reads as no services (nothing is auto-run from it). */
  private async readServices(context:Context):Promise<ServicesFile> {
    const data=await readJSON(this.servicesPath(context),512*1024,false) as Partial<ServicesFile>|null;
    const file:ServicesFile={version:1,generation:Number.isInteger(data?.generation)&&data!.generation!>=0?data!.generation!:0,...(typeof data?.containerStartedAt==='string'?{containerStartedAt:data.containerStartedAt}:{}),services:[]};
    for(const raw of Array.isArray(data?.services)?data!.services!.slice(0,MAX_SERVICES):[]){
      try {
        const spec=validateServiceSpec(raw);const entry=raw as ServiceEntry;
        if(typeof entry.id!=='string'||!/^svc_[0-9a-f]{12}$/.test(entry.id))continue;
        file.services.push({...spec,id:entry.id,state:SERVICE_STATES.has(entry.state)?entry.state:'stopped',desired:entry.desired==='running'?'running':'stopped',bootGeneration:Number(entry.bootGeneration)||0,restarts:Number(entry.restarts)||0,lastExitCode:typeof entry.lastExitCode==='number'?entry.lastExitCode:null,
          ...(entry.startedAt?{startedAt:String(entry.startedAt)}:{}),...(entry.endedAt?{endedAt:String(entry.endedAt)}:{}),...(entry.reason?{reason:String(entry.reason).slice(0,512)}:{}),...(Number.isInteger(entry.pgid)&&entry.pgid!>1?{pgid:entry.pgid}:{})});
      }catch {}
    }
    this.generations.set(context.id,file.generation);
    return file;
  }
  private serviceView(context:Context,entry:ServiceEntry):ScopedComputerService {
    const {pgid:_pgid,desired:_desired,...visible}=entry;
    return {...visible,output:this.serviceOutputs.get(this.serviceKey(context,entry.id))??''};
  }
  private servicesView(context:Context,file:ServicesFile):ScopedComputerServices {return {computerId:context.id,bootGeneration:file.generation,services:file.services.map(entry=>this.serviceView(context,entry))};}
  private async writeServices(context:Context,file:ServicesFile):Promise<void> {
    await saveJSON(this.servicesPath(context),file);this.generations.set(context.id,file.generation);
    const view=this.servicesView(context,file);this.emit({type:'computerServices',computerId:context.id,bootGeneration:view.bootGeneration,services:view.services});
  }
  /** Drops this computer's live service clients so their exit handlers become no-ops (the container is going away). */
  private forgetServiceRuns(context:Pick<Context,'id'>):void {
    for(const [key,run] of this.serviceRuns)if(key.startsWith(`${context.id}:`)){this.serviceRuns.delete(key);run.proc.detach();}
    for(const [key,timer] of this.serviceTimers)if(key.startsWith(`${context.id}:`)){clearTimeout(timer);this.serviceTimers.delete(key);}
  }
  private async groupAlive(container:string,pgid:number):Promise<boolean> {
    const probe=await this.runner.docker(['exec','--user',SANDBOX_USER,container,'sh','-c','kill -0 -"$1" 2>/dev/null','muster-probe',String(pgid)],{timeoutMs:10_000});
    return probe.code===0;
  }
  /** Starts one service in this scope's container (caller holds the scope lock and writes the file). */
  private launchService(context:Context,handle:ComputerHandle,file:ServicesFile,entry:ServiceEntry,reason?:string):void {
    const key=this.serviceKey(context,entry.id),scopeKey=refKey(context.scope);
    Object.assign(entry,{state:'running',bootGeneration:file.generation,startedAt:new Date().toISOString(),lastExitCode:null});
    delete entry.endedAt;delete entry.pgid;if(reason)entry.reason=reason;else delete entry.reason;
    this.serviceOutputs.set(key,'');
    const run={generation:file.generation} as ServiceRun;
    try {run.proc=this.runner.exec(handle.id,serviceShell(entry),{onOutput:(_stream,data)=>{if(this.serviceRuns.get(key)===run)this.serviceOutputs.set(key,tail((this.serviceOutputs.get(key)??'')+data,SERVICE_TAIL));}});}
    catch {entry.state='failed';entry.reason='The service could not be started in the sandbox.';return;}
    this.serviceRuns.set(key,run);
    void run.proc.pgid.then(pgid=>{if(pgid)return this.queue(scopeKey,async()=>{
      if(this.serviceRuns.get(key)!==run)return;const latest=await this.readServices(context),current=latest.services.find(item=>item.id===entry.id);
      if(current&&current.state==='running'){current.pgid=pgid;await this.writeServices(context,latest);}
    });}).catch(()=>{});
    void run.proc.done.then(outcome=>this.queue(scopeKey,()=>this.serviceExited(context,entry.id,run,outcome))).catch(()=>{});
  }
  private async serviceExited(context:Context,serviceId:string,run:ServiceRun,outcome:{exitCode:number|null;error?:string}):Promise<void> {
    const key=this.serviceKey(context,serviceId);
    if(this.closed||this.serviceRuns.get(key)!==run)return;
    this.serviceRuns.delete(key);
    const file=await this.readServices(context),entry=file.services.find(item=>item.id===serviceId);if(!entry)return;
    Object.assign(entry,{endedAt:new Date().toISOString(),lastExitCode:outcome.exitCode});delete entry.pgid;
    let up=false;try {const record=await this.record(context);if(record?.handle)up=(await context.backend.inspect(record.handle,context.descriptor)).running;}catch {}
    if(!up){entry.state='lost';entry.reason='The sandbox stopped while this service was running.';await this.writeServices(context,file);return;}
    const failed=outcome.exitCode!==0;
    entry.state=failed?'failed':'exited';entry.reason=outcome.error?'The service could not be started in the sandbox.':failed?`Exited with code ${outcome.exitCode??'unknown'}.`:'Exited.';
    if(entry.desired==='running'&&(entry.restart==='always'||(entry.restart==='on-failure'&&failed)))this.scheduleRestart(context,entry);
    await this.writeServices(context,file);
  }
  private scheduleRestart(context:Context,entry:ServiceEntry):void {
    const key=this.serviceKey(context,entry.id),recent=(this.serviceRestarts.get(key)??[]).filter(at=>Date.now()-at<60_000);
    const wait=restartDelay(recent,Date.now(),this.options.serviceBackoffMs??1000);
    if(wait===null){entry.state='failed';entry.desired='stopped';entry.reason=`${entry.reason??''} Restarted ${recent.length} times within a minute, so supervision stopped. Fix the command, then start it again.`.trim();return;}
    entry.state='backoff';entry.reason=`${entry.reason??''} Restarting in ${Math.max(1,Math.round(wait/1000))} s.`.trim();
    const timer:ReturnType<typeof setTimeout>=setTimeout(()=>{
      void this.queue(refKey(context.scope),async()=>{
        // Still armed only if nothing (stop, remove, reboot, a manual start) cancelled it meanwhile; boot sync skips armed services.
        if(this.closed||this.serviceTimers.get(key)!==timer)return;
        this.serviceTimers.delete(key);
        const fresh=await this.context(context.scope,context.label),file=await this.readServices(fresh),current=file.services.find(item=>item.id===entry.id);
        if(!current||current.state!=='backoff'||current.desired!=='running')return;
        const record=await this.record(fresh);
        if(!record?.handle||!(await fresh.backend.inspect(record.handle,fresh.descriptor)).running){current.state='lost';current.reason='The sandbox stopped before the restart.';await this.writeServices(fresh,file);return;}
        recent.push(Date.now());this.serviceRestarts.set(key,recent);current.restarts++;
        this.launchService(fresh,record.handle,file,current,'Restarted by its restart policy.');
        await this.writeServices(fresh,file);
      }).catch(()=>{});
    },wait);
    timer.unref?.();this.serviceTimers.set(key,timer);
  }
  /**
   * Boot generation (SBX-15): a changed container start time is a reboot, so the counter increments and each service is
   * restarted or marked lost by its policy. With the same boot (Muster itself restarted), a service whose process group is
   * still alive is kept as running; one that is gone is handled like a failure.
   */
  private async syncBoot(context:Context,handle:ComputerHandle):Promise<ServicesFile> {
    const file=await this.readServices(context);
    const probe=await this.runner.docker(['inspect','-f','{{.State.StartedAt}}',handle.id],{timeoutMs:10_000});
    const startedAt=probe.code===0?probe.stdout.trim():'';
    if(!startedAt)return file;
    const rebooted=file.containerStartedAt!==startedAt;
    if(rebooted){file.generation++;file.containerStartedAt=startedAt;}
    let changed=rebooted;
    for(const entry of file.services){
      const key=this.serviceKey(context,entry.id),live=this.serviceRuns.get(key);
      if(!rebooted&&(live||this.serviceTimers.has(key)))continue;
      if(live){this.serviceRuns.delete(key);live.proc.detach();}
      if(rebooted){const timer=this.serviceTimers.get(key);if(timer){clearTimeout(timer);this.serviceTimers.delete(key);}}
      const wasUp=['running','starting','backoff','lost'].includes(entry.state);
      if(!rebooted&&!live&&entry.state==='running'&&entry.pgid&&await this.groupAlive(handle.id,entry.pgid)){
        if(!entry.reason){entry.reason='Running since before Muster restarted. Earlier output is not shown.';changed=true;}
        continue;
      }
      const restart=entry.desired==='running'&&(entry.restart==='always'||(entry.restart==='on-failure'&&(!entry.startedAt||!['exited','stopped'].includes(entry.state))));
      if(restart){if(entry.startedAt)entry.restarts++;this.launchService(context,handle,file,entry,!entry.startedAt?undefined:rebooted?'Restarted after the sandbox restarted.':'Restarted: it was no longer running.');changed=true;}
      else if(wasUp&&entry.state!=='lost'){Object.assign(entry,{state:'lost',endedAt:new Date().toISOString(),reason:rebooted?'Stopped when the sandbox restarted. Its restart policy is never.':'No longer running. Its restart policy is never.'});delete entry.pgid;changed=true;}
    }
    if(changed)await this.writeServices(context,file);
    return file;
  }
  private async runningHandle(context:Context):Promise<ComputerHandle|null> {
    const record=await this.record(context);
    return record?.handle&&(await context.backend.inspect(record.handle,context.descriptor)).running?record.handle:null;
  }
  servicesList(scope:ScopedComputerRef):Promise<ScopedComputerServices> {return this.withScope(scope,async authorized=>{
    const context=await this.context(scope,authorized.label);
    let handle:ComputerHandle|null=null;try {handle=await this.runningHandle(context);}catch {}
    return this.servicesView(context,handle?await this.syncBoot(context,handle):await this.readServices(context));
  });}
  private async registerService(context:Context,spec:ScopedComputerServiceSpec,start:boolean):Promise<ScopedComputerService> {
    const handle=await this.runningHandle(context).catch(()=>null);
    if(start&&!handle&&spec.restart==='never')throw new ComputerInputError('Start the sandbox before starting this service, or give it a restart policy so it starts with the sandbox.');
    const file=handle?await this.syncBoot(context,handle):await this.readServices(context);
    if(file.services.length>=MAX_SERVICES)throw new ComputerInputError(`A sandbox can have up to ${MAX_SERVICES} services.`);
    if(file.services.some(item=>item.name.toLowerCase()===spec.name.toLowerCase()))throw new ComputerInputError('A service with that name is already registered.');
    if(spec.role==='browser'&&file.services.some(item=>item.role==='browser'))throw new ComputerInputError('The sandbox browser service is already registered.');
    const entry:ServiceEntry={...spec,id:`svc_${randomUUID().replace(/-/g,'').slice(0,12)}`,state:'stopped',desired:start?'running':'stopped',bootGeneration:file.generation,restarts:0,lastExitCode:null,...(start&&!handle?{reason:'Starts when the sandbox starts.'}:{})};
    file.services.push(entry);
    if(start&&handle)this.launchService(context,handle,file,entry);
    await this.writeServices(context,file);
    return this.serviceView(context,entry);
  }
  servicesRegister(scope:ScopedComputerRef,spec:unknown,start?:unknown):Promise<ScopedComputerService> {return this.withScope(scope,async authorized=>{
    const valid=this.checked(()=>validateServiceSpec(spec));
    if(valid.role==='browser')throw new ComputerInputError('Turn on the sandbox browser from the chat’s environment settings.');
    return this.registerService(await this.context(scope,authorized.label),valid,start===true);
  });}
  servicesStart(scope:ScopedComputerRef,serviceId:unknown):Promise<ScopedComputerService> {return this.withScope(scope,async authorized=>{
    const context=await this.context(scope,authorized.label),handle=await this.runningHandle(context);
    if(!handle)throw new ComputerInputError('Start the sandbox before starting a service.');
    const file=await this.syncBoot(context,handle),entry=file.services.find(item=>item.id===serviceId);
    if(!entry)throw new ComputerInputError('This service is not registered in the selected sandbox.');
    const key=this.serviceKey(context,entry.id);
    entry.desired='running';this.serviceRestarts.delete(key);
    const timer=this.serviceTimers.get(key);if(timer){clearTimeout(timer);this.serviceTimers.delete(key);}
    if(!this.serviceRuns.has(key)&&!(entry.state==='running'&&entry.pgid))this.launchService(context,handle,file,entry);
    await this.writeServices(context,file);
    return this.serviceView(context,entry);
  });}
  private async stopService(context:Context,entry:ServiceEntry):Promise<void> {
    const key=this.serviceKey(context,entry.id),run=this.serviceRuns.get(key);
    entry.desired='stopped';
    const timer=this.serviceTimers.get(key);if(timer){clearTimeout(timer);this.serviceTimers.delete(key);}
    const record=await this.record(context);
    const pgid=run?await Promise.race([run.proc.pgid,delay(2000,null)]):entry.pgid;
    if(run)this.serviceRuns.delete(key);
    if(record?.handle&&pgid)try {if((await context.backend.inspect(record.handle,context.descriptor)).running)await this.runner.killGroup(record.handle.id,pgid);}catch {}
    run?.proc.detach();
    if(['running','starting','backoff'].includes(entry.state)){Object.assign(entry,{state:'stopped',endedAt:new Date().toISOString(),reason:'Stopped.'});}
    delete entry.pgid;
  }
  servicesStop(scope:ScopedComputerRef,serviceId:unknown):Promise<ScopedComputerService> {return this.withScope(scope,async authorized=>{
    const context=await this.context(scope,authorized.label),file=await this.readServices(context),entry=file.services.find(item=>item.id===serviceId);
    if(!entry)throw new ComputerInputError('This service is not registered in the selected sandbox.');
    await this.stopService(context,entry);await this.writeServices(context,file);
    return this.serviceView(context,entry);
  });}
  servicesRemove(scope:ScopedComputerRef,serviceId:unknown):Promise<ScopedComputerServices> {return this.withScope(scope,async authorized=>{
    const context=await this.context(scope,authorized.label),file=await this.readServices(context),entry=file.services.find(item=>item.id===serviceId);
    if(!entry)throw new ComputerInputError('This service is not registered in the selected sandbox.');
    await this.stopService(context,entry);
    file.services=file.services.filter(item=>item.id!==entry.id);
    const key=this.serviceKey(context,entry.id);this.serviceOutputs.delete(key);this.serviceRestarts.delete(key);
    await this.writeServices(context,file);
    return this.servicesView(context,file);
  });}
  /** SBX-11: runs (or removes) the headless browser service inside this scope's container. */
  browserService(scope:ScopedComputerRef,enabled:boolean):Promise<{state:ScopedComputerService['state']|'not-registered';reason?:string}> {return this.withScope(scope,async authorized=>{
    const context=await this.context(scope,authorized.label),file=await this.readServices(context),existing=file.services.find(item=>item.role==='browser');
    if(!enabled){
      if(existing){await this.stopService(context,existing);file.services=file.services.filter(item=>item!==existing);await this.writeServices(context,file);}
      return {state:'not-registered'};
    }
    if(existing){
      const handle=await this.runningHandle(context).catch(()=>null);
      if(handle&&!this.serviceRuns.has(this.serviceKey(context,existing.id))&&existing.state!=='running'){existing.desired='running';this.launchService(context,handle,file,existing);await this.writeServices(context,file);}
      return {state:existing.state,...(existing.reason?{reason:existing.reason}:{})};
    }
    const service=await this.registerService(context,{name:BROWSER_SERVICE_NAME,command:BROWSER_SERVICE_COMMAND,cwd:'/workspace',env:{},restart:'on-failure',role:'browser'},true);
    return {state:service.state,...(service.reason?{reason:service.reason}:{})};
  });}
  browserServiceStatus(scope:ScopedComputerRef):Promise<{state:ScopedComputerService['state']|'not-registered';reason?:string}> {return this.withScope(scope,async authorized=>{
    const entry=(await this.readServices(await this.context(scope,authorized.label))).services.find(item=>item.role==='browser');
    return entry?{state:entry.state,...(entry.reason?{reason:entry.reason}:{})}:{state:'not-registered'};
  });}
  /**
   * SBX-13: an agent (ephemeral) command left active by a previous app session has no caller any more: its MCP request
   * died with the old provider process. End its process group (or confirm it is gone) and release the scope so the
   * resumed chat's next turn is not blocked. User-started commands keep the explicit recovery flow.
   */
  private async resolveStaleAgentExecution(context:Context,record:RecordData):Promise<void> {
    const active=record.active;
    if(!active?.ephemeral||this.executions.has(active.executionId)||!record.handle)return;
    let gone=false;
    try {
      if(!(await context.backend.inspect(record.handle,context.descriptor)).running)gone=true;
      else if(active.pgid)gone=!(await this.groupAlive(record.handle.id,active.pgid))||(await this.runner.killGroup(record.handle.id,active.pgid)).code===0;
    }catch {return;}
    if(!gone)return;
    delete record.active;await this.saveRecord(context,record);
  }
  /** Single IPC entry for every `computer.*` command; inputs are re-validated by each method. */
  // --- Agent execution (SBX-01): the sandbox domain routes a chat's commands and edits here through the muster_sandbox MCP tools.
  /** Resolves once the execution has settled (or immediately for a restored receipt). */
  private async awaitExecution(scope:ScopedComputerRef,executionId:string):Promise<ScopedComputerExecution> {
    const found=this.executions.get(executionId);if(found)await found.done.catch(()=>{});
    return this.execution(scope,executionId);
  }
  agentWorkspace(scope:ScopedComputerRef):Promise<{hostPath:string;running:boolean;reason?:string}> {return this.withScope(scope,async authorized=>{
    const context=await this.context(scope,authorized.label),record=await this.record(context),hostPath=this.workspacePath(context);
    if(!record?.handle)return {hostPath,running:false,reason:'The container has not been created.'};
    // SBX-13: an agent command orphaned by an app restart must not block the resumed chat's next turn.
    if(record.active)await this.resolveStaleAgentExecution(context,record).catch(()=>{});
    if(record.active)return {hostPath,running:false,reason:'A command is still running in the sandbox.'};
    try {return {hostPath,running:(await context.backend.inspect(record.handle,context.descriptor)).running,reason:'The container is stopped.'};}
    catch(error){return {hostPath,running:false,reason:safeReason(error)};}
  });}
  /** Like workspaceEntry, but the leaf (and missing parents) may not exist yet; existing parts must be real directories. */
  private async workspaceTarget(context:Context,path:unknown):Promise<{absolute:string;relative:string}> {
    if(typeof path!=='string'||!path.trim()||path.length>1024||path.includes('\0'))throw new ComputerInputError('Give a path inside /workspace.');
    const parts=path.replace(/^\/workspace\/?/,'').split('/').filter(part=>part&&part!=='.');if(!parts.length||parts.includes('..'))throw new ComputerInputError('Give a path inside /workspace.');
    let absolute=this.workspacePath(context);
    for(const part of parts.slice(0,-1)){absolute=join(absolute,part);try {const stat=await lstat(absolute);if(stat.isSymbolicLink()||!stat.isDirectory())throw new ComputerInputError(`${part} is not a folder.`);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
    absolute=join(absolute,parts.at(-1)!);
    try {if((await lstat(absolute)).isSymbolicLink())throw new ComputerInputError('Links inside the workspace are not followed.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    return {absolute,relative:parts.join('/')};
  }
  /** The tool-facing view of one scope. Files are handled on the host side of the bind mount, like the Sandbox tab does. */
  agentTarget(scope:ScopedComputerRef):SandboxAgentTarget {
    const MAX_READ=256*1024;
    return {
      exec:async(command,timeoutMs)=>{
        const {executionId}=await this.exec({scope,command,requestId:`agent-${randomUUID()}`,timeoutMs,ephemeral:true});
        const result=await this.awaitExecution(scope,executionId);
        return {state:result.state,exitCode:result.exitCode,stdout:result.stdout,stderr:result.stderr,truncated:result.stdoutTruncated||result.stderrTruncated,...(result.reason?{reason:result.reason}:{})};
      },
      read:path=>this.withScope(scope,async authorized=>{
        const {absolute}=await this.workspaceEntry(await this.context(scope,authorized.label),path);
        let file;try {file=await open(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);}catch {throw new ComputerInputError('That file could not be opened.');}
        try {const stat=await file.stat();if(!stat.isFile())throw new ComputerInputError('That path is not a file.');const buffer=Buffer.alloc(Math.min(stat.size,MAX_READ));const {bytesRead}=await file.read(buffer,0,buffer.length,0);return {text:buffer.subarray(0,bytesRead).toString('utf8'),truncated:stat.size>MAX_READ};}
        finally {await file.close();}
      }),
      write:(path,content)=>this.withScope(scope,async authorized=>{
        if(Buffer.byteLength(content)>16*1024*1024)throw new ComputerInputError('Writes are limited to 16 MiB.');
        const {absolute}=await this.workspaceTarget(await this.context(scope,authorized.label),path);
        await mkdir(dirname(absolute),{recursive:true});
        const temp=`${absolute}.${randomUUID()}.tmp`;await writeFile(temp,content,{flag:'wx',flush:true});await rename(temp,absolute);
      }),
      list:path=>this.filesList(scope,path||'').then(result=>result.entries.map(entry=>({name:entry.name,kind:entry.kind,size:entry.size}))),
    };
  }
  agentToolsLauncher(resolve:(chatId:string)=>Promise<ScopedComputerRef>):Promise<string> {
    return this.toolHost??=(async()=>{
      const {root}=await this.init();
      const host=new SandboxToolHost({dir:join(root,'agent-tools'),execPath:process.execPath,resolve:async chatId=>this.agentTarget(await resolve(chatId))});
      try {const launcher=await host.start();this.toolHostInstance=host;return launcher;}catch(error){host.dispose();throw error;}
    })().catch(error=>{this.toolHost=undefined;throw error;});
  }
  dispatch(command:ScopedComputerCommand,input:unknown):Promise<unknown> {
    const p=(input??{}) as Record<string,any>;
    switch(command){
      case 'computer.inspect': return this.inspect(p.scope);
      case 'computer.start': return this.start(p.scope);
      case 'computer.stop': return this.stop(p.scope);
      case 'computer.destroy': return this.destroy(p.scope);
      case 'computer.exec': return this.exec(p as any);
      case 'computer.execStream': return this.exec(p as any).then(result=>({execId:result.executionId}));
      case 'computer.input': return this.input(p.scope,p.execId,p.data,p.eof);
      case 'computer.execution': return this.execution(p.scope,p.executionId);
      case 'computer.cancel': return this.cancel(p.scope,p.executionId);
      case 'computer.history': return this.history(p.scope);
      case 'computer.setNetwork': return this.setNetwork(p.scope,p.network,p.confirmed);
      case 'computer.repair': return this.repair(p.scope,p.action);
      case 'computer.files.list': return this.filesList(p.scope,p.path);
      case 'computer.files.import': return this.filesImport(p.scope,p.into);
      case 'computer.files.export': return this.filesExport(p.scope,p.path);
      case 'computer.workspace.size': return this.workspaceSize(p.scope);
      case 'computer.workspace.delete': return this.workspaceDelete(p.scope,p.confirmed,p.removeContainer);
      case 'computer.setLimits': return this.setLimits(p.scope,p.limits);
      case 'computer.usage': return this.usage(p.scope);
      case 'computer.layers.sources': return this.layersSources(p.scope);
      case 'computer.layers.set': return this.layersSet(p.scope,p.layers);
      case 'computer.services.list': return this.servicesList(p.scope);
      case 'computer.services.register': return this.servicesRegister(p.scope,p.service,p.start);
      case 'computer.services.start': return this.servicesStart(p.scope,p.serviceId);
      case 'computer.services.stop': return this.servicesStop(p.scope,p.serviceId);
      case 'computer.services.remove': return this.servicesRemove(p.scope,p.serviceId);
      case 'computer.export': return this.exportArchive(p.scope);
    }
    return Promise.reject(new ComputerInputError('Unknown computer command.'));
  }
  /** SBX-13: after a sleep Docker Desktop's VM may have restarted. Re-inspects every computer with in-flight work so its
   *  saved state (running, stopped, recovery-needed) is re-derived from Docker rather than trusted from before the sleep. */
  async recheckAfterWake():Promise<ScopedComputerStatus[]> {
    if(this.closed)return [];
    const settled=await Promise.allSettled([...this.observedActiveScopes.values()].map(context=>this.inspect(context.scope)));
    return settled.flatMap(result=>result.status==='fulfilled'?[result.value]:[]);
  }
  hasActiveWork():boolean {return this.pending.size>0||this.observedActiveScopes.size>0||[...this.executions.values()].some(execution=>!execution.settled||execution.result.state==='recovery-needed');}
  dispose():Promise<void> {
    if(this.disposal)return this.disposal;this.closed=true;
    this.toolHostInstance?.dispose();this.toolHostInstance=undefined;this.toolHost=undefined;registerAgentSandboxHost(undefined);
    // Services outlive the app inside their container: only the local clients close; the next launch finds them by process group.
    for(const timer of this.serviceTimers.values())clearTimeout(timer);this.serviceTimers.clear();
    const services=[...this.serviceRuns.values()];this.serviceRuns.clear();for(const run of services)run.proc.detach();
    // End active owned commands (their process groups; the container only as a fallback). Completion writes remain awaited.
    this.disposal=(async()=>{
      await Promise.allSettled([...this.locks.values()]);
      for(const execution of this.executions.values())if(execution.timer)clearTimeout(execution.timer);
      const executions=[...this.executions.values()].filter(execution=>!execution.settled||execution.result.state==='recovery-needed');
      const keys=new Set(executions.map(execution=>execution.scopeKey));
      const stops:Promise<unknown>[]=executions.map(execution=>execution.settled?this.queue(execution.scopeKey,()=>this.stopContext(execution.context)):this.terminate(execution,'cancelled').catch(()=>{execution.clientAbort.abort();}));
      for(const [key,context] of this.observedActiveScopes)if(!keys.has(key))stops.push(this.queue(key,()=>this.stopContext(context)));
      await Promise.allSettled(stops);
      while(this.pending.size)await Promise.allSettled([...this.pending]);
      if(this.observedActiveScopes.size||[...this.executions.values()].some(execution=>execution.result.state==='recovery-needed'))throw new ComputerInputError('Some scoped computer work could not be confirmed stopped. Check Docker and retry quitting; saved ownership is preserved.');
    })().catch(error=>{this.disposal=undefined;throw error;});return this.disposal;
  }
}
