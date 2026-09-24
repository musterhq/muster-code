/**
 * CR-20: a terminal backed by a (remote) Codex app-server's `process/*` API instead of a local node-pty.
 *
 * The app-server owns the PTY: `process/spawn {tty:true}` starts it, `process/writeStdin` / `process/resizePty` /
 * `process/kill` drive it, and `process/outputDelta` / `process/exited` notifications stream it back. The handle is
 * scoped to the connection. Muster imposes no timeout on the process (no `timeoutMs`): it lives until the user closes
 * it or the shell exits.
 */
import {randomUUID} from 'node:crypto';

/** The slice of an app-server JSON-RPC connection a remote terminal needs. */
export interface AppServerConnection {
  call(method:string,params:Record<string,unknown>):Promise<Record<string,unknown>>;
  /** Subscribes to server notifications; returns an unsubscribe function. */
  onNotification(listener:(method:string,params:Record<string,unknown>)=>void):()=>void;
}

/** The surface TerminalSessions uses from a PTY, shared by node-pty and remote processes. `pid` is only set for local PTYs. */
export interface TerminalPty {
  readonly pid:number|undefined;
  write(data:string):void;
  resize(cols:number,rows:number):void;
  kill(signal?:string):void;
  pause():void;
  resume():void;
  onData(listener:(data:string)=>void):void;
  onExit(listener:(event:{exitCode:number;signal?:number})=>void):void;
}

export interface RemoteSpawn {command:string[];cwd:string;cols:number;rows:number;env?:Record<string,string>}

const decode=(value:unknown):Buffer=>typeof value==='string'?Buffer.from(value,'base64'):Buffer.alloc(0);

/** Starts a PTY on the app-server. Resolves once `process/spawn` is accepted; rejects (and unsubscribes) when it is not. */
export async function spawnRemoteTerminal(connection:AppServerConnection,input:RemoteSpawn):Promise<TerminalPty> {
  if(!Array.isArray(input.command)||!input.command.length||input.command.some(part=>typeof part!=='string'||part.includes('\0')))throw new Error('Invalid remote terminal command.');
  const processHandle=`muster-terminal-${randomUUID()}`;
  const dataListeners:((data:string)=>void)[]=[],exitListeners:((event:{exitCode:number})=>void)[]=[];
  const buffered:string[]=[];let exited:{exitCode:number}|undefined;
  // A decoder per stream keeps multi-byte characters that straddle two deltas intact.
  const decoders=new Map<string,TextDecoder>();
  let paused=false;const held:string[]=[];
  const deliver=(text:string)=>{
    if(!text)return;
    if(paused){held.push(text);return;}
    if(!dataListeners.length){buffered.push(text);return;}
    for(const listener of dataListeners)listener(text);
  };
  const finish=(exitCode:number)=>{
    if(exited)return;
    for(const decoder of decoders.values())deliver(decoder.decode());
    exited={exitCode};off();
    for(const listener of exitListeners)listener(exited);
  };
  const off=connection.onNotification((method,params)=>{
    if(params?.processHandle!==processHandle)return;
    if(method==='process/outputDelta'){
      const stream=typeof params.stream==='string'?params.stream:'stdout';
      let decoder=decoders.get(stream);if(!decoder){decoder=new TextDecoder('utf-8');decoders.set(stream,decoder);}
      deliver(decoder.decode(decode(params.deltaBase64),{stream:true}));
      if(params.capReached===true)deliver('\r\n[remote output cap reached]\r\n');
    }else if(method==='process/exited'){
      finish(typeof params.exitCode==='number'&&Number.isInteger(params.exitCode)?params.exitCode:-1);
    }
  });
  try{
    await connection.call('process/spawn',{command:input.command,processHandle,cwd:input.cwd,tty:true,streamStdin:true,streamStdoutStderr:true,size:{rows:input.rows,cols:input.cols},...(input.env?{env:input.env}:{})});
  }catch(error){off();throw new Error(`The remote terminal could not start (${error instanceof Error?error.message:'app-server error'}).`);}
  const send=(method:string,params:Record<string,unknown>)=>{void connection.call(method,{processHandle,...params}).catch(()=>{/* The process exited between the keystroke and the call. */});};
  return {
    pid:undefined,
    write(data){if(!exited)send('process/writeStdin',{deltaBase64:Buffer.from(data,'utf8').toString('base64')});},
    resize(cols,rows){if(!exited)send('process/resizePty',{size:{rows,cols}});},
    kill(){if(!exited)send('process/kill',{});},
    pause(){paused=true;},
    resume(){paused=false;const pending=held.splice(0);for(const text of pending)deliver(text);},
    onData(listener){dataListeners.push(listener);const pending=buffered.splice(0);for(const text of pending)listener(text);},
    onExit(listener){exitListeners.push(listener);if(exited)listener(exited);},
  };
}
