import {randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {basename,dirname,isAbsolute} from 'node:path';
import {stripAnsi,TerminalRing} from './command-output-buffer.ts';
import {spawnRemoteTerminal,type AppServerConnection,type TerminalPty} from './remote-terminal.ts';
import {loginShell,resolveTerminalShell,shellArgs} from './terminal-shell.ts';
import type {ProcessEvent,TerminalCreate,TerminalInfo,TerminalReplay} from '../shared/process-protocol.ts';

export const MAX_TERMINALS=12;
const MAX_SAVED=24,SAVED_TAIL=64*1024,FLUSH_MS=16,PAUSE_AT=1<<20,MAX_INPUT=1<<20;
export type TerminalAuthorize=(input:{chatId:string;operation:'read'|'terminal';folderId?:string})=>Promise<{cwd?:string}>;
export interface TerminalLaunch {file:string;args:string[]}
/** CR-20: a remote Codex app-server terminals can run on. `cwd`/`shell` are paths on that host. */
export interface RemoteTerminalHost {connection:AppServerConnection;cwd?:string;shell?:string;title?:string}
export interface TerminalOptions {
  /** CR-18: the user's shell preference ('system', 'zsh', 'bash', 'fish' or an absolute path), read per new terminal. */
  shell?:()=>Promise<string|undefined>|string|undefined;
}
/** C3.b4: one terminal's newest output for the agent, ANSI stripped (redaction is the caller's job). */
export interface TerminalTail {id:string;title:string;status:TerminalInfo['status'];text:string;truncated:boolean}
type PtyModule=typeof import('node-pty');
interface Entry {info:TerminalInfo;ring:TerminalRing;pty?:TerminalPty;pending:string;paused:boolean;closing:boolean;done:Promise<void>;resolve:()=>void;timer?:ReturnType<typeof setTimeout>}

let loader:Promise<PtyModule>|undefined;
/** node-pty is native and external to the bundle; a missing build is reported, never faked. */
export function loadPty():Promise<PtyModule> {
  return loader??=import('node-pty').then(module=>{const value=(module as any).default?.spawn?(module as any).default:module;if(typeof value.spawn!=='function')throw new Error('invalid');return value as PtyModule;})
    .catch(()=>{loader=undefined;throw new Error('The terminal runtime (node-pty) is not available in this build of Muster.');});
}
const validId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9:_-]{1,160}$/.test(value);
const size=(value:unknown,max:number)=>Number.isInteger(value)&&(value as number)>=2&&(value as number)<=max;
export {loginShell};
/** The user's own shell: a login shell rebuilds PATH from their profile. App-injected
 * variables (provider tokens, Electron flags) are not inherited; colour is left on. */
export function terminalEnvironment(shell:string):NodeJS.ProcessEnv {
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH??'/usr/bin:/bin:/usr/sbin:/sbin',TERM:'xterm-256color',COLORTERM:'truecolor',TERM_PROGRAM:'Muster',SHELL:shell,LANG:process.env.LANG||'en_US.UTF-8'};
  for(const key of ['HOME','USER','LOGNAME','TMPDIR','LC_ALL','LC_CTYPE','SSH_AUTH_SOCK'])if(process.env[key])env[key]=process.env[key];
  return env;
}

/** Interactive PTYs owned by the main process. They die with Muster (no detached daemon);
 * their metadata and a short tail are saved so a restart can say so honestly. */
export class TerminalSessions {
  private entries=new Map<string,Entry>();
  private dirty=new Set<string>();
  private flushTimer?:ReturnType<typeof setTimeout>;
  private saveTimer?:ReturnType<typeof setTimeout>;
  private writing?:Promise<void>;
  private saveAgain=false;
  private closing=false;
  private readyPromise:Promise<void>;
  private remoteHosts=new Map<string,RemoteTerminalHost>();
  constructor(private filePath:string,private authorize:TerminalAuthorize,private emit:(event:ProcessEvent)=>void,private launch?:TerminalLaunch,private options:TerminalOptions={}) {
    this.readyPromise=this.restore().catch(()=>{/* An unreadable history only loses ended-terminal notes. */});
  }
  ready():Promise<void> {return this.readyPromise;}
  /** CR-20: makes a remote app-server available to `terminal.create {host:{kind:'remote',id}}`. */
  registerRemoteHost(id:string,host:RemoteTerminalHost):()=>void {
    if(!validId(id))throw new Error('Invalid remote host.');
    this.remoteHosts.set(id,host);
    return ()=>{if(this.remoteHosts.get(id)===host)this.remoteHosts.delete(id);};
  }
  private async restore():Promise<void> {
    let value:any;
    try{const stat=await fs.stat(this.filePath);if(stat.size>MAX_SAVED*SAVED_TAIL*2)return;value=JSON.parse(await fs.readFile(this.filePath,'utf8'));}catch{return;}
    if(value?.version!==1||!Array.isArray(value.terminals))return;
    for(const saved of value.terminals.slice(-MAX_SAVED)){
      const info=saved?.info;
      if(!info||!validId(info.id)||!validId(info.chatId)||typeof info.cwd!=='string'||typeof info.shell!=='string')continue;
      const ring=new TerminalRing();ring.append(typeof saved.tail==='string'?saved.tail.slice(-SAVED_TAIL):'');
      ring.truncatedBytes=Number.isSafeInteger(saved.truncatedBytes)?saved.truncatedBytes:0;ring.omittedLines=Number.isSafeInteger(saved.omittedLines)?saved.omittedLines:0;
      const status=info.status==='exited'?'exited':'ended';
      let resolve!:()=>void;const done=new Promise<void>(accept=>{resolve=accept;});resolve();
      this.entries.set(info.id,{info:{id:info.id,chatId:info.chatId,title:String(info.title??basename(info.shell)).slice(0,80),cwd:info.cwd.slice(0,4096),shell:info.shell.slice(0,4096),owner:'user',status,startedAt:String(info.startedAt??'').slice(0,64),exitCode:Number.isInteger(info.exitCode)?info.exitCode:null},ring,pending:'',paused:false,closing:false,done,resolve});
    }
  }
  private save():Promise<void> {
    this.saveAgain=true;
    if(this.writing)return this.writing;
    this.writing=(async()=>{
      while(this.saveAgain){
        this.saveAgain=false;
        const terminals=[...this.entries.values()].slice(-MAX_SAVED).map(entry=>({info:entry.info,tail:entry.ring.tail(SAVED_TAIL),truncatedBytes:entry.ring.truncatedBytes,omittedLines:entry.ring.omittedLines}));
        const temporary=`${this.filePath}.${process.pid}.tmp`;
        await fs.mkdir(dirname(this.filePath),{recursive:true,mode:0o700});
        await fs.writeFile(temporary,JSON.stringify({version:1,terminals}),{mode:0o600});await fs.rename(temporary,this.filePath);
      }
    })().finally(()=>{this.writing=undefined;});
    return this.writing;
  }
  private scheduleSave(delay=800):void {
    if(this.saveTimer||this.closing)return;
    this.saveTimer=setTimeout(()=>{this.saveTimer=undefined;void this.save().catch(()=>{});},delay);
  }
  private entry(id:unknown):Entry {
    if(!validId(id))throw new Error('Invalid terminal.');
    const entry=this.entries.get(id);if(!entry)throw new Error('This terminal is no longer available.');
    return entry;
  }
  /** Running user terminals as process groups (node-pty makes each shell a group leader). */
  userProcessGroups():{pgid:number;label:string;chatId:string;cwd:string}[] {
    return [...this.entries.values()].flatMap(entry=>entry.info.status==='running'&&entry.pty?.pid?[{pgid:entry.pty.pid,label:`terminal ${entry.info.title}`,chatId:entry.info.chatId,cwd:entry.info.cwd}]:[]);
  }
  /** S3-E: running shells with their row ids, so a listening port can name the shell it came from. */
  shellGroups():{pgid:number;chatId:string;id:string}[] {
    return [...this.entries.values()].flatMap(entry=>entry.info.status==='running'&&entry.pty?.pid?[{pgid:entry.pty.pid,chatId:entry.info.chatId,id:entry.info.id}]:[]);
  }
  running():number {return [...this.entries.values()].filter(entry=>entry.info.status==='running').length;}
  async create(input:TerminalCreate):Promise<TerminalInfo> {
    await this.ready();
    if(this.closing)throw new Error('Muster is stopping background work.');
    if(!validId(input?.chatId))throw new Error('Invalid terminal conversation.');
    if(input.folderId!==undefined&&!validId(input.folderId))throw new Error('Invalid terminal folder.');
    if(!size(input.cols,1000)||!size(input.rows,500))throw new Error('Invalid terminal size.');
    if(this.running()>=MAX_TERMINALS)throw new Error(`Close a terminal before opening another (maximum ${MAX_TERMINALS}).`);
    const host=input.host;
    if(host!==undefined&&!(host&&typeof host==='object'&&(host.kind==='local'||(host.kind==='remote'&&validId(host.id)))))throw new Error('Invalid terminal host.');
    const remote=host?.kind==='remote'?this.remoteHosts.get(host.id):undefined;
    if(host?.kind==='remote'&&!remote)throw new Error('That remote host is not connected.');
    let {cwd}=await this.authorize({chatId:input.chatId,operation:'terminal',...(input.folderId?{folderId:input.folderId}:{})});
    if(typeof cwd!=='string'||!isAbsolute(cwd)||cwd.includes('\0'))throw new Error('The terminal folder is unavailable.');
    let child:TerminalPty,file:string;
    if(remote){
      // The folder lives on the remote host; the local authorization still decides whether this chat may open a terminal.
      if(remote.cwd!==undefined){if(!isAbsolute(remote.cwd)||remote.cwd.includes('\0'))throw new Error('The remote folder is invalid.');cwd=remote.cwd;}
      file=remote.shell&&isAbsolute(remote.shell)&&!remote.shell.includes('\0')?remote.shell:'/bin/sh';
      child=await spawnRemoteTerminal(remote.connection,{command:[file,...shellArgs(file)],cwd,cols:input.cols,rows:input.rows,env:{TERM:'xterm-256color',COLORTERM:'truecolor',TERM_PROGRAM:'Muster'}});
    }else{
      if(!(await fs.stat(cwd).then(stat=>stat.isDirectory(),()=>false)))throw new Error('The terminal folder no longer exists.');
      const pty=await loadPty();
      if(this.closing)throw new Error('Muster is stopping background work.');
      let preference:string|undefined;
      try{preference=await this.options.shell?.();}catch{/* Unreadable settings: use the login shell. */}
      file=this.launch?.file??resolveTerminalShell(preference,loginShell).file;
      const args=this.launch?.args??shellArgs(file);
      try{child=pty.spawn(file,args,{name:'xterm-256color',cols:input.cols,rows:input.rows,cwd,env:terminalEnvironment(file)});}
      catch(error){throw new Error(`The terminal could not start (${error instanceof Error?error.message:'launch error'}).`);}
    }
    if(this.closing){try{child.kill();}catch{}throw new Error('Muster is stopping background work.');}
    let resolve!:()=>void;const done=new Promise<void>(accept=>{resolve=accept;});
    const info:TerminalInfo={id:`terminal:${randomUUID()}`,chatId:input.chatId,title:remote?.title?`${remote.title} · ${basename(file)}`.slice(0,80):basename(file),cwd,shell:file,owner:'user',status:'running',startedAt:new Date().toISOString(),exitCode:null};
    const entry:Entry={info,ring:new TerminalRing(),pty:child,pending:'',paused:false,closing:false,done,resolve};
    this.entries.set(info.id,entry);
    child.onData(data=>{
      entry.ring.append(data);entry.pending+=data;this.dirty.add(info.id);
      // Back-pressure: a flood (yes, cat of a huge file) pauses the PTY until the next frame is sent.
      if(entry.pending.length>PAUSE_AT&&!entry.paused){entry.paused=true;try{child.pause();}catch{}}
      this.flushTimer??=setTimeout(()=>this.flush(),FLUSH_MS);
      this.scheduleSave(5000);
    });
    child.onExit(({exitCode})=>{
      this.flushOne(info.id);clearTimeout(entry.timer);
      info.status=this.closing?'ended':'exited';info.exitCode=exitCode;entry.pty=undefined;
      this.emit({type:'terminalExit',id:info.id,code:exitCode});
      if(entry.closing)this.entries.delete(info.id);
      this.prune();this.scheduleSave();entry.resolve();
    });
    this.prune();this.scheduleSave();
    return {...info};
  }
  private flushOne(id:string):void {
    const entry=this.entries.get(id);this.dirty.delete(id);
    if(!entry||!entry.pending)return;
    const data=entry.pending;entry.pending='';
    this.emit({type:'terminalData',id,data,start:entry.ring.end-data.length});
    if(entry.paused){entry.paused=false;try{entry.pty?.resume();}catch{}}
  }
  private flush():void {
    clearTimeout(this.flushTimer);this.flushTimer=undefined;
    for(const id of [...this.dirty])this.flushOne(id);
  }
  /** Keep every live terminal, plus the newest finished ones for their notes. */
  private prune():void {
    const finished=[...this.entries.values()].filter(entry=>entry.info.status!=='running');
    for(const entry of finished.slice(0,Math.max(0,this.entries.size-MAX_SAVED)))this.entries.delete(entry.info.id);
  }
  async list(input:{chatId:string}):Promise<TerminalInfo[]> {
    await this.ready();
    if(!validId(input?.chatId))throw new Error('Invalid terminal conversation.');
    await this.authorize({chatId:input.chatId,operation:'read'});
    return [...this.entries.values()].filter(entry=>entry.info.chatId===input.chatId).map(entry=>({...entry.info,end:entry.ring.end}));
  }
  async snapshot(input:{id:string}):Promise<TerminalReplay> {
    await this.ready();
    const entry=this.entry(input?.id);this.flushOne(entry.info.id);
    return entry.ring.snapshot();
  }
  /** C3.b4: the newest output of this chat's terminals for the agent's read tool (read-only, newest terminal first, bounded). */
  agentTails(chatId:string,maxBytes=16*1024):TerminalTail[] {
    if(!validId(chatId))return [];
    const budget=Math.max(1024,Math.min(maxBytes,64*1024));
    return [...this.entries.values()].filter(entry=>entry.info.chatId===chatId).reverse().map(entry=>{
      this.flushOne(entry.info.id);
      const text=stripAnsi(entry.ring.tail(budget)).replace(/\r\n?/g,'\n');
      return {id:entry.info.id,title:entry.info.title,status:entry.info.status,text,truncated:entry.ring.byteLength>budget||entry.ring.truncatedBytes>0};
    });
  }
  input(input:{id:string;data:string}):void {
    const entry=this.entry(input?.id);
    if(typeof input.data!=='string'||input.data.length>MAX_INPUT)throw new Error('Invalid terminal input.');
    if(entry.info.status!=='running'||!entry.pty)throw new Error('This terminal has ended.');
    entry.pty.write(input.data);
  }
  resize(input:{id:string;cols:number;rows:number}):void {
    const entry=this.entry(input?.id);
    if(!size(input.cols,1000)||!size(input.rows,500))throw new Error('Invalid terminal size.');
    try{entry.pty?.resize(input.cols,input.rows);}catch{/* The PTY exited between the frame and this resize. */}
  }
  private signal(entry:Entry,signal:NodeJS.Signals):void {
    const pid=entry.pty?.pid;
    // A remote PTY has no local pid: the app-server's process/kill ends it.
    if(!pid){try{entry.pty?.kill(signal);}catch{}return;}
    // The PTY child leads its own session and process group; end the whole group.
    try{process.kill(-pid,signal);}catch{try{entry.pty?.kill(signal);}catch{}}
  }
  /** Close: hang up the shell (and its jobs), escalate to SIGKILL, and wait for the reap. */
  async kill(input:{id:string}):Promise<void> {
    const entry=this.entry(input?.id);
    if(entry.info.status!=='running'){this.entries.delete(entry.info.id);this.scheduleSave();return;}
    entry.closing=true;await this.hangUp(entry);
  }
  private async hangUp(entry:Entry):Promise<void> {
    if(entry.info.status!=='running')return;
    this.signal(entry,'SIGHUP');
    entry.timer??=setTimeout(()=>this.signal(entry,'SIGKILL'),1200);
    let deadline:ReturnType<typeof setTimeout>|undefined;
    await Promise.race([entry.done,new Promise<void>(resolve=>{deadline=setTimeout(resolve,3000);})]);clearTimeout(deadline);
    if(entry.info.status==='running')throw new Error('The terminal did not stop. Try closing it again.');
  }
  dispose():Promise<void> {
    this.closing=true;clearTimeout(this.saveTimer);this.saveTimer=undefined;
    return (async()=>{
      await this.ready();
      await Promise.allSettled([...this.entries.values()].map(entry=>this.hangUp(entry)));
      this.flush();
      for(const entry of this.entries.values())if(entry.info.status==='running')entry.info.status='ended';
      await this.save().catch(()=>{});
    })();
  }
}
