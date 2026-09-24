import {spawn,type ChildProcess} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {dirname,isAbsolute,join} from 'node:path';
import {appendCommandOutput,MAX_COMMAND_OUTPUT,safeTailStart,trimFinishedOutputs} from './command-output-buffer.ts';
import {TerminalSessions,type TerminalLaunch,type TerminalOptions} from './terminal-sessions.ts';
import {OutputLog} from './output-log.ts';
import type {UserProcessTarget} from './user-process-guard.ts';
import {attributeListeners,ListeningPorts,type OwnedGroup,type ProcessRow} from './listening-ports.ts';
import {sharedResourceScheduler,type ResourceLease,type ResourceScheduler} from './resource-scheduler.ts';
import {isActiveProcess,type ProcessEvent,type ProcessOutputPage,type ProcessOutputPageInput,type ProcessLease,type ProcessListSnapshot,type ProcessMetadata,type ProcessRef,type ProcessSnapshot,type ProcessStart,type ProcessSummarySnapshot,type ProcessPortsSnapshot} from '../shared/process-protocol.ts';

export const MAX_OWNED_PROCESSES=4;
export const MAX_PROCESS_HISTORY=32;
const MAX_RECEIPTS=2048,MAX_STATE_BYTES=24*1024*1024;
/** 'terminal' opens a user-driven PTY: it resolves a cwd but never requires Full access. */
export type ProcessAuthorize=(input:{chatId:string;operation:'read'|'start'|'stop'|'terminal';folderId?:string})=>Promise<{cwd?:string;fullAccessAcknowledged?:boolean}>;
interface Receipt {requestId:string;fingerprint:string;session:ProcessSnapshot}
interface Handle {child:ChildProcess;stopping:boolean;finished:boolean;done:Promise<void>;resolve:()=>void;timer?:ReturnType<typeof setTimeout>;closed?:{code:number|null;signal?:string}}
const validId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9:_-]{1,160}$/.test(value);
function chatId(value:unknown):asserts value is string {if(!validId(value))throw new Error('Invalid command conversation.');}
function validateStart(input:ProcessStart):void {
  chatId(input?.chatId);
  if(!validId(input.requestId))throw new Error('Invalid command request identity.');
  if(typeof input.command!=='string'||!input.command.trim()||input.command.length>32768||input.command.includes('\0'))throw new Error('Enter a command of at most 32 KB.');
  if(input.args!==undefined&&(!Array.isArray(input.args)||input.args.length>256||input.args.some(arg=>typeof arg!=='string'||arg.length>8192||arg.includes('\0'))||input.args.join('').length>32768))throw new Error('Invalid command arguments.');
  if(input.label!==undefined&&(typeof input.label!=='string'||input.label.length>160||input.label.includes('\0')))throw new Error('Invalid command label.');
  if(input.purpose!==undefined&&!['command','test','build','server','task'].includes(input.purpose))throw new Error('Invalid command purpose.');
}
const clone=(value:ProcessSnapshot):ProcessSnapshot=>({...value,...(value.args?{args:[...value.args]}:{})});
function receiptSnapshot(value:ProcessSnapshot):ProcessSnapshot {
  const {command:_command,args:_args,output:_output,...metadata}=value;
  return {...metadata,output:'',truncated:true};
}
/** Do not pass provider tokens, API keys, SSH agents or arbitrary app variables to a shell. */
function commandEnvironment():NodeJS.ProcessEnv {
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH??'/usr/bin:/bin',TERM:'dumb',NO_COLOR:'1'};
  for(const key of ['HOME','USER','LOGNAME','TMPDIR','LANG','LC_ALL'])if(process.env[key])env[key]=process.env[key];
  return env;
}

/** A single owner for four non-interactive process groups. No persisted PID is
 * trusted or exposed. Attach/detach controls observers, never process lifetime.
 */
export class ProcessSessions {
  private sessions=new Map<string,ProcessSnapshot>();
  private receipts=new Map<string,Receipt>();
  private handles=new Map<string,Handle>();
  private leases=new Map<string,string>();
  private pending=new Map<string,{fingerprint:string;promise:Promise<ProcessSnapshot>}>();
  private cancelled=new Set<string>();
  private dirty=new Set<string>();
  private flushTimer?:ReturnType<typeof setTimeout>;
  private saveTimer?:ReturnType<typeof setTimeout>;
  private writing?:Promise<void>;
  private saveRequested=false;
  private closing=false;
  private disposed=false;
  private readyPromise:Promise<void>;
  private initializationFailed=false;
  private disposal?:Promise<void>;
  private metadataRevision=0;
  private metadataQueued=false;
  private metadataStatuses=new Map<string,ProcessSnapshot['status']>();
  /** Interactive terminals share this owner's authority and event channel. */
  readonly terminals:TerminalSessions;
  /** PER-05: every output byte, durable and pageable beyond the in-memory tail. */
  readonly outputLog:OutputLog;
  /** PER-06: builds and tests take a heavy slot; they queue under memory/CPU pressure. */
  private resources:ResourceScheduler;
  private heavyLeases=new Map<string,ResourceLease>();
  private queuedWaits=new Map<string,AbortController>();
  private queuedRuns=new Set<Promise<void>>();
  /** S3-E: listening ports per shell / command / agent process (one cached lsof scan). */
  readonly listeningPorts:ListeningPorts;
  private portRoot:number;
  constructor(private filePath:string,private authorize:ProcessAuthorize,private emit:(event:ProcessEvent)=>void,terminalLaunch?:TerminalLaunch,options:{outputLog?:OutputLog;resources?:ResourceScheduler;ports?:ListeningPorts;portRoot?:number;terminal?:TerminalOptions}={}) {
    this.listeningPorts=options.ports??new ListeningPorts();this.portRoot=options.portRoot??process.pid;
    this.terminals=new TerminalSessions(join(dirname(filePath),'terminal-sessions.json'),authorize,emit,terminalLaunch,options.terminal);
    this.outputLog=options.outputLog??new OutputLog(join(dirname(filePath),'output-logs'));
    this.resources=options.resources??sharedResourceScheduler();
    this.readyPromise=this.restore().then(()=>{
      for(const session of this.sessions.values())this.metadataStatuses.set(session.processId,session.status);
      this.queueMetadata();
    }).catch(error=>{
      this.initializationFailed=true;this.sessions.clear();this.receipts.clear();
      throw error;
    });
    // Commands still surface the original read error, without an unhandled rejection.
    void this.readyPromise.catch(()=>{});
  }
  ready():Promise<void>{return this.readyPromise;}
  private async restore():Promise<void> {
    let raw:string;
    try {const stat=await fs.stat(this.filePath);if(stat.size>MAX_STATE_BYTES)throw new Error('Saved command history is too large.');raw=await fs.readFile(this.filePath,'utf8');}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw new Error('Saved command history could not be read. New commands are disabled to preserve request identities.');}
    let value:any;try{value=JSON.parse(raw);}catch{throw new Error('Saved command history is invalid. New commands are disabled to preserve request identities.');}
    if(value?.version!==1||!Array.isArray(value.sessions)||!Array.isArray(value.receipts)||value.sessions.length>MAX_PROCESS_HISTORY+MAX_OWNED_PROCESSES||value.receipts.length>MAX_RECEIPTS)throw new Error('Saved command history is invalid.');
    const decode=(input:any):ProcessSnapshot=>{
      if(!input||!validId(input.chatId)||!validId(input.processId)||!Number.isSafeInteger(input.generation)||input.generation<1||!Number.isSafeInteger(input.sequence)||input.sequence<0||!['starting','running','stopping','exited','failed','stopped','lost'].includes(input.status)||typeof input.output!=='string'||typeof input.label!=='string'||!['command','test','build','server','task'].includes(input.purpose))throw new Error('Saved command history is invalid.');
      return {chatId:input.chatId,processId:input.processId,generation:input.generation,sequence:input.sequence,status:input.status,label:input.label.slice(0,160),purpose:input.purpose,startedAt:String(input.startedAt).slice(0,64),updatedAt:String(input.updatedAt).slice(0,64),output:input.output.length>MAX_COMMAND_OUTPUT?input.output.slice(safeTailStart(input.output,input.output.length-MAX_COMMAND_OUTPUT)):input.output,truncated:!!input.truncated||input.output.length>MAX_COMMAND_OUTPUT,exitCode:Number.isInteger(input.exitCode)?input.exitCode:null,...(typeof input.command==='string'?{command:input.command.slice(0,32768)}:{}),...(Array.isArray(input.args)?{args:input.args.filter((arg:unknown)=>typeof arg==='string').slice(0,256).map((arg:string)=>arg.slice(0,8192))}:{}),...(typeof input.error==='string'?{error:input.error.slice(0,512)}:{}),...(typeof input.signal==='string'?{signal:input.signal.slice(0,32)}:{}),owner:input.owner==='agent'?'agent':'user'};
    };
    for(const input of value.sessions){const session=decode(input);this.sessions.set(session.processId,session);}
    for(const input of value.receipts){if(!validId(input?.requestId)||typeof input.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(input.fingerprint))throw new Error('Saved command receipts are invalid.');this.receipts.set(input.requestId,{requestId:input.requestId,fingerprint:input.fingerprint,session:decode(input.session)});}
    let changed=trimFinishedOutputs([...this.sessions.values()].filter(session=>!isActiveProcess(session.status)))>0;
    for(const session of this.sessions.values())if(isActiveProcess(session.status)){
      session.status='lost';session.generation++;session.sequence++;session.updatedAt=new Date().toISOString();session.error='The app restarted. This command cannot be reattached and was not restarted.';this.updateReceipt(session);changed=true;
    }
    // Pruned receipt summaries must never retain an apparently live process.
    for(const receipt of this.receipts.values())if(isActiveProcess(receipt.session.status)){receipt.session={...receipt.session,status:'lost',generation:receipt.session.generation+1,sequence:receipt.session.sequence+1,error:'The app restarted. The prior command is no longer supervised.'};changed=true;}
    if(changed)await this.save();
  }
  private save():Promise<void> {
    this.saveRequested=true;
    if(this.writing)return this.writing;
    this.writing=(async()=>{
      while(this.saveRequested){
        this.saveRequested=false;
        const data=JSON.stringify({version:1,sessions:[...this.sessions.values()],receipts:[...this.receipts.values()]});
        const temporary=`${this.filePath}.${process.pid}.tmp`;
        await fs.mkdir(dirname(this.filePath),{recursive:true,mode:0o700});
        await fs.writeFile(temporary,data,{mode:0o600});await fs.rename(temporary,this.filePath);await fs.chmod(this.filePath,0o600);
      }
    })().finally(()=>{this.writing=undefined;});
    return this.writing;
  }
  private scheduleSave():void {
    if(this.saveTimer||this.closing)return;
    this.saveTimer=setTimeout(()=>{this.saveTimer=undefined;void this.save().catch(()=>{
      for(const session of this.sessions.values())if(isActiveProcess(session.status)){session.error='Command history could not be saved. Live output remains available until the app closes.';this.publish(session);}
    });},400);
  }
  private updateReceipt(session:ProcessSnapshot):void {for(const receipt of this.receipts.values())if(receipt.session.processId===session.processId)receipt.session=receiptSnapshot(session);}
  private publish(session:ProcessSnapshot):void {
    session.sequence++;session.updatedAt=new Date().toISOString();this.updateReceipt(session);
    if(this.metadataStatuses.get(session.processId)!==session.status){this.metadataStatuses.set(session.processId,session.status);this.queueMetadata();}
    for(const [leaseId,owner] of this.leases)if(owner===session.chatId)this.emit({type:'processSession',leaseId,session:clone(session)});
  }
  private queueMetadata():void {
    if(this.metadataQueued)return;this.metadataQueued=true;
    queueMicrotask(()=>{
      this.metadataQueued=false;
      void this.summary().then(summary=>this.emit({type:'processMetadata',summary})).catch(()=>{});
    });
  }
  /** Capture revision and rows together before async authorization. A later
   * lifecycle report can safely overtake this read without being rewound by it.
   */
  async summary():Promise<ProcessSummarySnapshot> {
    await this.ready();
    const revision=++this.metadataRevision;
    const sessions:ProcessMetadata[]=[...this.sessions.values()].sort((a,b)=>Number(isActiveProcess(b.status))-Number(isActiveProcess(a.status))||b.updatedAt.localeCompare(a.updatedAt)).slice(0,MAX_PROCESS_HISTORY+MAX_OWNED_PROCESSES).map(({chatId,processId,label,purpose,status,startedAt,updatedAt})=>({chatId,processId,label,purpose,status,startedAt,updatedAt}));
    const owners=[...new Set(sessions.map(session=>session.chatId))];
    const accepted=new Set<string>();
    await Promise.all(owners.map(async owner=>{try{await this.authorize({chatId:owner,operation:'read'});accepted.add(owner);}catch{/* Deleted or unavailable owners contribute no global metadata. */}}));
    return {revision,sessions:sessions.filter(session=>accepted.has(session.chatId))};
  }
  private prune():void {
    const inactive=[...this.sessions.values()].filter(session=>!isActiveProcess(session.status)).sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt));
    for(const session of inactive.slice(0,Math.max(0,inactive.length-MAX_PROCESS_HISTORY))){this.sessions.delete(session.processId);this.metadataStatuses.delete(session.processId);this.queueMetadata();void this.outputLog.remove(session.chatId,session.processId);}
    // Finished commands share one output budget (in memory and in the saved file).
    trimFinishedOutputs(inactive.filter(session=>this.sessions.has(session.processId)));
  }
  /** Live process groups the user started (in-app terminals and Commands-tab commands).
   * Handed to the agent so it never treats them as its own orphans (F41/F50). Never sent to the renderer. */
  userProcessGroups():{pgid:number;label:string;chatId:string;cwd?:string}[] {
    const groups:{pgid:number;label:string;chatId:string;cwd?:string}[]=[];
    for(const [processId,handle] of this.handles){const session=this.sessions.get(processId);if(!handle.finished&&handle.child.pid&&session)groups.push({pgid:handle.child.pid,label:session.label,chatId:session.chatId});}
    return [...groups,...this.terminals.userProcessGroups()];
  }
  /** R5: user groups enriched with their listening ports, member PIDs and process names, for the kill guard. */
  async userProcessTargets():Promise<(UserProcessTarget&{chatId:string})[]> {
    const groups=this.userProcessGroups();
    if(!groups.length)return [];
    const owned=this.ownedGroups(),targets=new Map(groups.map(group=>[group.pgid,{...group,pids:[] as number[],pgids:[] as number[],ports:[] as number[],names:[] as string[]}]));
    let scan;try{scan=await this.listeningPorts.scan(false);}catch{return groups;}
    const key=(source:unknown)=>JSON.stringify(source);
    for(const row of attributeListeners(scan,{root:this.portRoot,groups:owned,workspaces:new Map()})){
      const leader=owned.find(group=>key(group.source)===key(row.source))?.pgid,target=leader===undefined?undefined:targets.get(leader);
      if(!target)continue;
      target.ports.push(row.port);target.pids.push(row.pid);if(row.pgid!==target.pgid)target.pgids.push(row.pgid);
    }
    for(const target of targets.values())for(const process of scan.processes.values())
      if(process.pgid===target.pgid||target.pgids.includes(process.pgid)){target.pids.push(process.pid);target.names.push(process.comm.slice(process.comm.lastIndexOf('/')+1));}
    return [...targets.values()];
  }
  /** Every live user-owned group with the row it belongs to (Terminal shells and Commands-tab commands). */
  private ownedGroups():OwnedGroup[] {
    const groups:OwnedGroup[]=[];
    for(const [processId,handle] of this.handles){const session=this.sessions.get(processId);if(!handle.finished&&handle.child.pid&&session)groups.push({pgid:handle.child.pid,chatId:session.chatId,source:{kind:'process',processId}});}
    for(const shell of this.terminals.shellGroups())groups.push({pgid:shell.pgid,chatId:shell.chatId,source:{kind:'terminal',id:shell.id}});
    return groups;
  }
  private async attributed(chat:string,fresh:boolean) {
    const scan=await this.listeningPorts.scan(fresh);
    const workspaces=new Map<string,string>();
    try{const authority=await this.authorize({chatId:chat,operation:'terminal'});if(authority.cwd&&isAbsolute(authority.cwd))workspaces.set(chat,authority.cwd);}catch{/* archived/removed: the agent's ports are not attributed */}
    const exec=process.execPath,bundle=exec.includes('.app/')?exec.slice(0,exec.indexOf('.app/')+5):dirname(exec);
    const exclude=(row:ProcessRow)=>row.comm.startsWith(bundle);
    return {scan,rows:attributeListeners(scan,{root:this.portRoot,groups:this.ownedGroups(),workspaces,exclude}).filter(row=>row.chatId===chat)};
  }
  /** S3-E: ports this conversation's shells, commands and agent processes listen on. */
  async ports(input:{chatId:string}):Promise<ProcessPortsSnapshot> {
    await this.allowed(input?.chatId,'read');
    const {scan,rows}=await this.attributed(input.chatId,false);
    return {chatId:input.chatId,supported:scan.supported,scannedAt:new Date(scan.at).toISOString(),ports:rows.sort((a,b)=>a.port-b.port).slice(0,64).map(row=>this.listeningPorts.toPort(row))};
  }
  /** Stops an agent-owned listener after the user confirmed it. It is re-verified from a fresh scan:
   * never a user-owned group, never a process outside this conversation, never Muster or its provider. */
  async stopListener(input:{chatId:string;id:string}):Promise<void> {
    await this.allowed(input?.chatId,'stop');
    if(typeof input.id!=='string'||!/^listener:[0-9a-f-]{36}$/.test(input.id))throw new Error('Invalid listener.');
    const key=this.listeningPorts.keyFor(input.id);if(!key)throw new Error('This server is no longer listening.');
    const {scan,rows}=await this.attributed(input.chatId,true);
    const row=rows.find(item=>item.pid===key.pid&&item.port===key.port);
    if(!row)throw new Error('This server is no longer listening.');
    if(row.owner!=='agent')throw new Error('Only servers the agent started can be stopped here. Stop your own shell or command from its row.');
    // Kill the whole command group (npm → vite) unless that group is the provider's own.
    const leader=scan.processes.get(row.pgid);
    const ownGroup=leader&&leader.pid!==this.portRoot&&leader.ppid!==this.portRoot&&row.pgid!==scan.processes.get(this.portRoot)?.pgid;
    try{process.kill(ownGroup?-row.pgid:row.pid,'SIGTERM');}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw new Error('The server could not be stopped.');}
  }
  hasRunning(chat:string):boolean {return [...this.sessions.values()].some(session=>session.chatId===chat&&isActiveProcess(session.status));}
  private async allowed(chat:unknown,operation:'read'|'start'|'stop') {
    chatId(chat);await this.ready();if(this.disposed||(operation==='start'&&this.closing))throw new Error('Command workspace is closing.');
    return this.authorize({chatId:chat,operation});
  }
  async list(input:{chatId:string}):Promise<ProcessListSnapshot> {
    await this.allowed(input?.chatId,'read');return {chatId:input.chatId,sessions:[...this.sessions.values()].filter(session=>session.chatId===input.chatId).map(clone)};
  }
  async attach(input:ProcessLease):Promise<ProcessListSnapshot> {
    await this.allowed(input?.chatId,'read');
    if(!validId(input.leaseId))throw new Error('Invalid command viewer identity.');
    const owner=this.leases.get(input.leaseId);if(owner&&owner!==input.chatId)throw new Error('Command viewer belongs to another conversation.');
    if(!owner&&this.leases.size>=32)throw new Error('Too many command viewers are attached.');
    this.leases.set(input.leaseId,input.chatId);
    return {chatId:input.chatId,sessions:[...this.sessions.values()].filter(session=>session.chatId===input.chatId).map(clone)};
  }
  async detach(input:ProcessLease):Promise<void> {
    await this.allowed(input?.chatId,'read');if(!validId(input.leaseId))throw new Error('Invalid command viewer identity.');
    const owner=this.leases.get(input.leaseId);if(owner&&owner!==input.chatId)throw new Error('Command viewer belongs to another conversation.');
    this.leases.delete(input.leaseId);
  }
  detachAll():void {this.leases.clear();}
  async start(input:ProcessStart):Promise<ProcessSnapshot> {
    validateStart(input);await this.allowed(input.chatId,'read');
    const fingerprint=createHash('sha256').update(JSON.stringify({chatId:input.chatId,command:input.command,args:input.args??null,label:input.label??'',purpose:input.purpose??'command'})).digest('hex');
    const prior=this.receipts.get(input.requestId),pending=this.pending.get(input.requestId);
    if(prior){
      if(prior.fingerprint!==fingerprint||prior.session.chatId!==input.chatId)throw new Error('This command request identity has already been used for different work.');
      if(pending)return pending.promise;
      return clone(this.sessions.get(prior.session.processId)??{...prior.session,error:prior.session.error??'Output history is no longer retained for this command.'});
    }
    if(pending){if(pending.fingerprint!==fingerprint)throw new Error('This command request identity is already in use.');return pending.promise;}
    const promise=this.launch(input,fingerprint);this.pending.set(input.requestId,{fingerprint,promise});
    try{return await promise;}finally{if(this.pending.get(input.requestId)?.promise===promise)this.pending.delete(input.requestId);}
  }
  private async launch(input:ProcessStart,fingerprint:string):Promise<ProcessSnapshot> {
    const authority=await this.allowed(input.chatId,'start');
    if(!authority.fullAccessAcknowledged)throw new Error('Host commands require explicitly acknowledged Full access in Agent mode. Workspace access cannot sandbox a host shell.');
    if(typeof authority.cwd!=='string'||!isAbsolute(authority.cwd)||authority.cwd.includes('\0'))throw new Error('The command workspace is unavailable.');
    if(process.platform==='win32')throw new Error('Owned process groups currently require macOS or Linux.');
    if(this.closing)throw new Error('Command workspace is closing.');
    if([...this.sessions.values()].filter(session=>isActiveProcess(session.status)).length>=MAX_OWNED_PROCESSES)throw new Error('Stop a running command before starting another (maximum 4).');
    if(this.receipts.size>=MAX_RECEIPTS)throw new Error('The durable command receipt limit has been reached. No command was started.');
    const now=new Date().toISOString();
    const session:ProcessSnapshot={chatId:input.chatId,processId:`process:${randomUUID()}`,generation:1,sequence:0,status:'starting',label:input.label?.trim()||'Command',purpose:input.purpose??'command',command:input.command,...(input.args?{args:[...input.args]}:{}),startedAt:now,updatedAt:now,output:'',truncated:false,exitCode:null,owner:'user'};
    this.sessions.set(session.processId,session);this.receipts.set(input.requestId,{requestId:input.requestId,fingerprint,session:receiptSnapshot(session)});this.publish(session);
    try{await this.save();}catch{session.status='failed';session.error='The command receipt could not be saved. The command was not started.';this.publish(session);throw new Error(session.error);}
    if(session.purpose==='build'||session.purpose==='test'){
      // PER-06: a heavy job that cannot start now is queued. The start call returns at once with
      // `queued` set; the job spawns (or is stopped) later, so the renderer and per-chat gate never block.
      const lease=this.resources.tryAcquire('heavy',session.label);
      if(lease)this.heavyLeases.set(session.processId,lease);
      else{
        const abort=new AbortController();this.queuedWaits.set(session.processId,abort);
        const queuedRun=this.resources.acquire('heavy',{label:session.label,signal:abort.signal,onQueued:reason=>{if(session.queued!==reason){session.queued=reason;this.publish(session);}}}).then(
          lease=>{this.heavyLeases.set(session.processId,lease);return true;},()=>false,
        ).then(async admitted=>{
          this.queuedWaits.delete(session.processId);delete session.queued;
          if(!admitted)this.cancelled.add(session.processId);
          await this.spawnOwned(input,session,authority.cwd!);
        }).catch(()=>{}).finally(()=>this.queuedRuns.delete(queuedRun));
        this.queuedRuns.add(queuedRun);
        return clone(session);
      }
    }
    return this.spawnOwned(input,session,authority.cwd!);
  }
  private async spawnOwned(input:ProcessStart,session:ProcessSnapshot,cwd:string):Promise<ProcessSnapshot> {
    const authority={cwd};
    if(this.closing||this.cancelled.has(session.processId)){this.releaseHeavy(session.processId);session.status='stopped';this.cancelled.delete(session.processId);this.publish(session);await this.save();return clone(session);}
    let child:ChildProcess;
    try{child=input.args?spawn(input.command,input.args,{cwd:authority.cwd,env:commandEnvironment(),stdio:['ignore','pipe','pipe'],detached:true}):spawn('/bin/sh',['-c',input.command],{cwd:authority.cwd,env:commandEnvironment(),stdio:['ignore','pipe','pipe'],detached:true});}
    catch{this.releaseHeavy(session.processId);session.status='failed';session.error='The command could not be started.';this.publish(session);await this.save();return clone(session);}
    let resolve!:()=>void;const done=new Promise<void>(accept=>{resolve=accept;});
    const handle:Handle={child,stopping:false,finished:false,done,resolve};this.handles.set(session.processId,handle);
    child.stdout?.setEncoding('utf8');child.stderr?.setEncoding('utf8');
    const output=(delta:string)=>{if(handle.finished)return;this.outputLog.append(session.chatId,session.processId,delta);Object.assign(session,appendCommandOutput(session,delta));this.dirty.add(session.processId);if(!this.flushTimer)this.flushTimer=setTimeout(()=>this.flushOutput(),80);};
    child.stdout?.on('data',output);child.stderr?.on('data',output);
    child.once('spawn',()=>{if(handle.finished)return;if(handle.stopping){try{this.signal(handle);}catch{handle.stopping=false;session.status='running';session.error='The owned command could not be stopped. You can retry Stop.';this.publish(session);}}else{session.status='running';this.publish(session);this.scheduleSave();}});
    child.once('error',(error:NodeJS.ErrnoException)=>this.finish(session,handle,'failed',null,undefined,`The command could not start (${error.code??'launch error'}).`));
    child.once('close',(code,signal)=>{
      handle.closed={code,signal:signal??undefined};
      // A shell leader may exit with redirected descendants still in its group.
      // End that captured group synchronously while handling its live lifecycle,
      // before releasing ownership or permitting a broader-policy transition.
      try{this.settleClosedGroup(session,handle);}catch{handle.stopping=false;session.status='stopping';session.error='The command leader exited, but its owned process group could not be stopped. Retry Stop.';this.publish(session);}
    });
    return clone(session);
  }
  private flushOutput():void {
    clearTimeout(this.flushTimer);this.flushTimer=undefined;
    for(const id of this.dirty){const session=this.sessions.get(id);if(session)this.publish(session);}this.dirty.clear();this.scheduleSave();
  }
  private finish(session:ProcessSnapshot,handle:Handle,status:ProcessSnapshot['status'],exitCode:number|null,signal?:string,error?:string):void {
    if(handle.finished)return;handle.finished=true;clearTimeout(handle.timer);this.handles.delete(session.processId);this.dirty.delete(session.processId);this.releaseHeavy(session.processId);
    session.status=status;session.exitCode=exitCode;if(signal)session.signal=signal;if(error)session.error=error;
    this.publish(session);this.prune();this.scheduleSave();handle.resolve();
  }
  private releaseHeavy(processId:string):void {this.heavyLeases.get(processId)?.release();this.heavyLeases.delete(processId);}
  /** PER-05: page backwards through a command's (or an agent tool row's) full durable output. */
  async outputPage(input:ProcessOutputPageInput):Promise<ProcessOutputPage> {
    await this.allowed(input?.chatId,'read');
    const before=input.before===undefined?undefined:Number(input.before),bytes=input.bytes===undefined?undefined:Number(input.bytes);
    if((before!==undefined&&(!Number.isSafeInteger(before)||before<0))||(bytes!==undefined&&(!Number.isSafeInteger(bytes)||bytes<1)))throw new Error('Invalid output page.');
    let key:string;
    if(input.processId!==undefined){
      if(!validId(input.processId))throw new Error('Invalid command identity.');
      const session=this.sessions.get(input.processId);
      if(session&&session.chatId!==input.chatId)throw new Error('This command does not belong to the selected conversation.');
      key=input.processId;
    }else if(input.itemId!==undefined&&validId(input.itemId))key=`item:${input.itemId}`;
    else throw new Error('Choose a command or tool output to read.');
    // Logs live under the owning chat's directory, so another chat's key never resolves.
    return this.outputLog.page(input.chatId,key,{before,bytes});
  }
  private signal(handle:Handle,signal:NodeJS.Signals='SIGTERM'):void {
    if(handle.finished||!handle.child.pid)return;
    try{process.kill(-handle.child.pid,signal);}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw new Error('The owned command could not be stopped.');}
  }
  private settleClosedGroup(session:ProcessSnapshot,handle:Handle):void {
    if(!handle.closed||handle.finished)return;
    this.signal(handle,'SIGKILL');
    this.finish(session,handle,handle.stopping?'stopped':handle.closed.code===0?'exited':'failed',handle.closed.code,handle.closed.signal);
  }
  private stopOwned(session:ProcessSnapshot):void {
    if(!isActiveProcess(session.status))return;
    const handle=this.handles.get(session.processId);
    if(!handle){this.cancelled.add(session.processId);this.queuedWaits.get(session.processId)?.abort();session.status='stopping';this.publish(session);return;}
    if(handle.closed){handle.stopping=true;try{this.settleClosedGroup(session,handle);}catch(error){handle.stopping=false;throw error;}return;}
    if(handle.stopping&&handle.timer)return;handle.stopping=true;session.status='stopping';this.publish(session);
    try{this.signal(handle);}catch(error){handle.stopping=false;session.status='running';session.error='The owned command could not be stopped. You can retry Stop.';this.publish(session);throw error;}
    handle.timer=setTimeout(()=>{handle.timer=undefined;if(!handle.finished){try{this.signal(handle,'SIGKILL');}catch{handle.stopping=false;session.error='The owned command did not stop. Retry Stop.';this.publish(session);}}},500);
  }
  async stop(input:ProcessRef):Promise<ProcessSnapshot> {
    await this.allowed(input?.chatId,'stop');if(!validId(input.processId))throw new Error('Invalid command identity.');
    const session=this.sessions.get(input.processId);
    if(!session||session.chatId!==input.chatId)throw new Error('This command does not belong to the selected conversation.');
    this.stopOwned(session);this.scheduleSave();return clone(session);
  }
  /** Quit: hang up every PTY (noting it ended with Muster) while owned commands stop. */
  async dispose():Promise<void> {
    await Promise.all([this.terminals.dispose(),this.disposeCommands()]);
  }
  private disposeCommands():Promise<void> {
    if(this.disposal)return this.disposal;this.closing=true;
    this.disposal=(async()=>{
      try{await this.ready();}catch(error){
        // Failed restore admitted no starts. Leave its bytes untouched and let
        // the user quit instead of trapping the app behind an unreadable file.
        if(this.initializationFailed&&!this.handles.size&&!this.pending.size){this.detachAll();this.disposed=true;return;}
        throw error;
      }
      this.detachAll();clearTimeout(this.saveTimer);this.saveTimer=undefined;
      const stopAll=()=>{for(const session of this.sessions.values())try{this.stopOwned(session);}catch{/* Continue releasing the other groups; unresolved ownership blocks shutdown below. */}};
      stopAll();
      await Promise.allSettled([...this.pending.values()].map(item=>item.promise));
      stopAll();
      await Promise.allSettled([...this.queuedRuns]);
      let deadline:ReturnType<typeof setTimeout>|undefined;
      await Promise.race([Promise.all([...this.handles.values()].map(handle=>handle.done)),new Promise<void>(resolve=>{deadline=setTimeout(resolve,1600);})]);clearTimeout(deadline);
      if(this.handles.size)throw new Error('Some owned commands could not be confirmed stopped. Retry quitting to stop them and save their history.');
      clearTimeout(this.flushTimer);this.flushTimer=undefined;this.dirty.clear();await this.outputLog.flush();await this.save();this.disposed=true;
    })().catch(error=>{this.disposal=undefined;throw error;});return this.disposal;
  }
}
