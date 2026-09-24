import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';

/** Unprivileged identity every sandbox command runs as (the image's `node` user; created at provision when absent). */
export const SANDBOX_USER='1000:1000';
/** Pinned by digest so a moved tag can never silently change what runs; update deliberately. */
export const SANDBOX_IMAGE='node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6';
/** Idempotent, runs once as the container's root at provision. `-M`: cap-drop ALL forbids chown of a new home. */
export const ENSURE_USER_SCRIPT='getent passwd 1000 >/dev/null 2>&1 || useradd -M -U -u 1000 -d /workspace -s /bin/sh sandbox';
const MARK='__MUSTER_PGID__:';
// docker exec starts every process as a session (and group) leader, so $$ names the whole group.
const WRAPPER=`printf '${MARK}%s\\n' "$$" >&2; exec sh -lc "$1"`;
const KILL=`kill -TERM -"$1" 2>/dev/null || exit 0; i=0; while kill -0 -"$1" 2>/dev/null && [ $i -lt 20 ]; do sleep 0.1; i=$((i+1)); done; kill -KILL -"$1" 2>/dev/null; exit 0`;

export type SandboxStream='stdout'|'stderr';
export interface DockerResult {code:number;stdout:string;stderr:string;timedOut?:boolean}
export interface SandboxProcess {
  /** The in-container process group, once the wrapper reports it (null if it never did). */
  readonly pgid:Promise<number|null>;
  write(data:string):boolean;
  end():void;
  /** Closes only the local docker client; the in-container group is unaffected. */
  detach():void;
  readonly done:Promise<{exitCode:number|null;error?:string}>;
}
export interface SandboxRunner {
  exec(container:string,command:string,options:{onOutput:(stream:SandboxStream,data:string)=>void}):SandboxProcess;
  /** TERM, then KILL after ~2s, only that exec's process group; never the container. */
  killGroup(container:string,pgid:number):Promise<DockerResult>;
  docker(args:string[],options?:{timeoutMs?:number;maxBytes?:number;onLine?:(line:string)=>void}):Promise<DockerResult>;
}
const validName=(name:string)=>/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(name);

export function createDockerRunner(dockerBin:string):SandboxRunner {
  const docker:SandboxRunner['docker']=(args,options={})=>new Promise(resolve=>{
    const max=options.maxBytes??1024*1024;let stdout='',stderr='',line='',timedOut=false,settled=false;
    const child=spawn(dockerBin,args,{stdio:['ignore','pipe','pipe']});
    const timer=options.timeoutMs?setTimeout(()=>{timedOut=true;child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),1500).unref();},options.timeoutMs):undefined;timer?.unref();
    const lines=(text:string)=>{if(!options.onLine)return;line+=text;const parts=line.split(/\r?\n|\r/);line=parts.pop()??'';for(const part of parts)if(part)options.onLine(part);};
    child.stdout.setEncoding('utf8').on('data',(text:string)=>{lines(text);if(stdout.length<max)stdout+=text.slice(0,max-stdout.length);});
    child.stderr.setEncoding('utf8').on('data',(text:string)=>{lines(text);if(stderr.length<max)stderr+=text.slice(0,max-stderr.length);});
    const finish=(code:number)=>{if(settled)return;settled=true;if(timer)clearTimeout(timer);if(line&&options.onLine)options.onLine(line);resolve({code,stdout,stderr,...(timedOut?{timedOut}:{})});};
    child.on('error',()=>finish(-1));child.on('close',code=>finish(code??-1));
  });
  return {
    docker,
    killGroup(container,pgid){
      if(!validName(container)||!Number.isInteger(pgid)||pgid<2)return Promise.resolve({code:-1,stdout:'',stderr:'invalid process group'});
      return docker(['exec','--user',SANDBOX_USER,container,'sh','-c',KILL,'muster-kill',String(pgid)],{timeoutMs:15_000});
    },
    exec(container,command,{onOutput}){
      if(!validName(container))throw new Error('Invalid sandbox container name.');
      const child=spawn(dockerBin,['exec','-i','--user',SANDBOX_USER,'-w','/workspace',container,'sh','-c',WRAPPER,'muster-exec',command],{stdio:['pipe','pipe','pipe']});
      let resolvePgid!:(pgid:number|null)=>void,head='',marked=false;
      const pgid=new Promise<number|null>(resolve=>{resolvePgid=resolve;});
      const decoders={stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')};
      child.stdout.on('data',(chunk:Buffer)=>{const text=decoders.stdout.write(chunk);if(text)onOutput('stdout',text);});
      child.stderr.on('data',(chunk:Buffer)=>{
        let text=decoders.stderr.write(chunk);
        if(!marked){
          head+=text;const newline=head.indexOf('\n');
          if(newline===-1&&head.length<256)return;
          marked=true;const first=newline===-1?head:head.slice(0,newline);
          if(first.startsWith(MARK)&&/^\d+$/.test(first.slice(MARK.length))){resolvePgid(Number(first.slice(MARK.length)));text=newline===-1?'':head.slice(newline+1);}
          else{resolvePgid(null);text=head;}
          head='';
        }
        if(text)onOutput('stderr',text);
      });
      child.stdin.on('error',()=>{});
      const done=new Promise<{exitCode:number|null;error?:string}>(resolve=>{
        let spawnError:string|undefined,settled=false;
        child.on('error',error=>{spawnError=(error as NodeJS.ErrnoException).code==='ENOENT'?'docker-missing':'spawn-failed';setTimeout(()=>{if(!settled){settled=true;resolvePgid(null);resolve({exitCode:null,error:spawnError});}},50);});
        child.on('close',(code,signal)=>{
          if(settled)return;settled=true;
          const rest=decoders.stdout.end();if(rest)onOutput('stdout',rest);
          const tail=(marked?'':head)+decoders.stderr.end();if(tail)onOutput('stderr',tail);
          resolvePgid(null);
          resolve(spawnError?{exitCode:null,error:spawnError}:{exitCode:code??(signal?128+(({SIGTERM:15,SIGKILL:9,SIGINT:2} as Record<string,number>)[signal]??0):null)});
        });
      });
      return {
        pgid,done,
        write:data=>!child.stdin.destroyed&&child.stdin.writable?child.stdin.write(data):false,
        end:()=>{if(!child.stdin.destroyed)child.stdin.end();},
        detach:()=>{if(child.exitCode===null&&!child.killed){child.kill('SIGTERM');setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');},1500).unref();}},
      };
    },
  };
}
