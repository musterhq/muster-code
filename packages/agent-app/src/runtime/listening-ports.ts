import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {basename,sep} from 'node:path';
import type {ListenerSource,ListeningPort,TerminalOwner} from '../shared/process-protocol.ts';

/** S3-E / DF-F38: which TCP ports the conversation's shells, commands and agent processes listen on.
 * One global `lsof` + `ps` scan, cached briefly and shared by every caller; attribution is per chat. */
export interface RawListener {pid:number;name:string;port:number;address:string}
export interface ProcessRow {pid:number;ppid:number;pgid:number;comm:string}
/** A user-owned process group (PTY shell or Commands-tab command) and the row it belongs to. */
export interface OwnedGroup {pgid:number;chatId:string;source:Exclude<ListenerSource,{kind:'agent'}>}
export interface Scan {listeners:RawListener[];processes:Map<number,ProcessRow>;cwds:Map<number,string>;supported:boolean;at:number}
export interface AttributedListener extends RawListener {owner:TerminalOwner;chatId?:string;source:ListenerSource;pgid:number}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpcn`: p<pid>, c<command>, f<fd>, n<address:port>. One row per pid+port. */
export function parseLsofListen(text:string):RawListener[] {
  const out:RawListener[]=[],seen=new Set<string>();let pid=0,name='';
  for(const line of text.split('\n')){
    const tag=line[0],value=line.slice(1);
    if(tag==='p'){pid=Number(value);name='';}
    else if(tag==='c')name=value;
    else if(tag==='n'&&pid>0){
      const match=/^(.*):(\d{1,5})$/.exec(value.trim());if(!match)continue;
      const port=Number(match[2]);if(!(port>0&&port<65536))continue;
      const address=match[1].replace(/^\[|\]$/g,'')||'*';
      const key=`${pid}:${port}`;if(seen.has(key))continue;seen.add(key);
      out.push({pid,name,port,address});
    }
  }
  return out;
}
/** `ps -A -o pid=,ppid=,pgid=,comm=` */
export function parsePs(text:string):Map<number,ProcessRow> {
  const rows=new Map<number,ProcessRow>();
  for(const line of text.split('\n')){
    const match=/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);if(!match)continue;
    const pid=Number(match[1]);rows.set(pid,{pid,ppid:Number(match[2]),pgid:Number(match[3]),comm:match[4].trim()});
  }
  return rows;
}
/** `lsof -a -d cwd -Fpn -p <pids>` */
export function parseLsofCwd(text:string):Map<number,string> {
  const cwds=new Map<number,string>();let pid=0;
  for(const line of text.split('\n')){if(line[0]==='p')pid=Number(line.slice(1));else if(line[0]==='n'&&pid>0)cwds.set(pid,line.slice(1));}
  return cwds;
}
const within=(path:string,root:string)=>path===root||path.startsWith(root.endsWith(sep)?root:root+sep);
/** Walk up the parent chain (bounded) to decide ownership. */
function ancestors(pid:number,processes:Map<number,ProcessRow>):ProcessRow[] {
  const chain:ProcessRow[]=[];let row=processes.get(pid);
  for(let depth=0;row&&depth<64;depth++){chain.push(row);if(row.ppid===row.pid||row.ppid<=1)break;row=processes.get(row.ppid);}
  return chain;
}
/**
 * A listener belongs to the user when it (or an ancestor) is in a user-owned process group (a PTY
 * shell or a Commands-tab command). Otherwise it is the agent's when it descends from Muster itself
 * (provider CLIs and the commands they run) and runs inside that chat's workspace. Muster's own
 * helper processes and anything started outside Muster are never listed.
 */
export function attributeListeners(scan:Pick<Scan,'listeners'|'processes'|'cwds'>,input:{root:number;groups:readonly OwnedGroup[];workspaces:ReadonlyMap<string,string>;exclude?:(row:ProcessRow)=>boolean}):AttributedListener[] {
  const byGroup=new Map(input.groups.map(group=>[group.pgid,group]));
  const out:AttributedListener[]=[];
  for(const listener of scan.listeners){
    if(listener.pid===input.root)continue;
    const chain=ancestors(listener.pid,scan.processes),self=chain[0];
    const pgid=self?.pgid??listener.pid;
    const group=chain.map(row=>byGroup.get(row.pgid)??byGroup.get(row.pid)).find(Boolean);
    if(group){out.push({...listener,owner:'user',chatId:group.chatId,source:group.source,pgid});continue;}
    if(!chain.some(row=>row.ppid===input.root))continue;
    if(self&&input.exclude?.(self))continue;
    const cwd=scan.cwds.get(listener.pid);if(!cwd)continue;
    const chat=[...input.workspaces].filter(([,root])=>within(cwd,root)).sort((a,b)=>b[1].length-a[1].length)[0]?.[0];
    if(chat)out.push({...listener,owner:'agent',chatId:chat,source:{kind:'agent'},pgid});
  }
  return out;
}

type Run=(file:string,args:string[])=>Promise<string>;
const run:Run=(file,args)=>new Promise((resolve,reject)=>execFile(file,args,{timeout:3000,maxBuffer:4*1024*1024,windowsHide:true},(error,stdout)=>{
  // lsof exits 1 when nothing matches; that is an empty result, not a failure.
  if(error&&!(typeof stdout==='string'&&(error as {code?:unknown}).code===1))reject(error);else resolve(String(stdout??''));
}));
const LSOF=['/usr/sbin/lsof','/usr/bin/lsof'];

export class ListeningPorts {
  private cached?:Scan;
  private inflight?:Promise<Scan>;
  /** Opaque, per-run ids so the renderer never handles a PID. */
  private ids=new Map<string,string>();
  constructor(private options:{ttlMs?:number;exec?:Run;platform?:NodeJS.Platform;now?:()=>number}={}) {}
  private get now(){return this.options.now?.()??Date.now();}
  async scan(fresh=false):Promise<Scan> {
    const ttl=this.options.ttlMs??2500;
    if(!fresh&&this.cached&&this.now-this.cached.at<ttl)return this.cached;
    if(this.inflight)return this.inflight;
    this.inflight=this.read().finally(()=>{this.inflight=undefined;});
    this.cached=await this.inflight;return this.cached;
  }
  private async read():Promise<Scan> {
    const exec=this.options.exec??run,platform=this.options.platform??process.platform;
    const empty=(supported:boolean):Scan=>({listeners:[],processes:new Map(),cwds:new Map(),supported,at:this.now});
    if(platform==='win32')return empty(false);
    let listenText:string|undefined,lsof='';
    for(const candidate of LSOF){try{listenText=await exec(candidate,['-nP','-iTCP','-sTCP:LISTEN','-Fpcn']);lsof=candidate;break;}catch{/* try the next path */}}
    if(listenText===undefined)return empty(false);
    const listeners=parseLsofListen(listenText);
    if(!listeners.length)return empty(true);
    const processes=parsePs(await exec('/bin/ps',['-A','-o','pid=,ppid=,pgid=,comm=']).catch(()=>''));
    const pids=[...new Set(listeners.map(row=>row.pid))];
    const cwds=parseLsofCwd(await exec(lsof,['-a','-d','cwd','-Fpn','-p',pids.join(',')]).catch(()=>''));
    return {listeners,processes,cwds,supported:true,at:this.now};
  }
  idFor(pid:number,port:number):string {
    const key=`${pid}:${port}`;let id=this.ids.get(key);
    if(!id){id=`listener:${randomUUID()}`;this.ids.set(key,id);if(this.ids.size>512)this.ids.delete(this.ids.keys().next().value!);}
    return id;
  }
  keyFor(id:string):{pid:number;port:number}|undefined {
    for(const [key,value] of this.ids)if(value===id){const [pid,port]=key.split(':').map(Number);return {pid,port};}
    return undefined;
  }
  toPort(row:AttributedListener):ListeningPort {
    return {id:this.idFor(row.pid,row.port),port:row.port,address:row.address,name:basename(row.name||'process').slice(0,64),owner:row.owner,source:row.source};
  }
}
