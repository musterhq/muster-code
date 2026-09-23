import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import type {Commands,Snapshot} from '../shared/protocol.ts';
import {isScopedComputerCommand,type ScopedComputerRef} from '../shared/scoped-computer-protocol.ts';
import type {AgentService} from './service-loader.ts';
import type {ProcessSessions,ProcessAuthorize} from '../runtime/process-sessions.ts';
import type {ScopedComputers} from '../runtime/scoped-computers.ts';

/** Resolve authority from the store; renderer paths and PIDs are never accepted. */
export async function commandAuthority(snapshot:Snapshot,appData:string,input:Parameters<ProcessAuthorize>[0]) {
  const chat=snapshot.chats.find(item=>item.id===input.chatId);
  if(!chat)throw new Error('This conversation no longer exists.');
  if(input.operation==='terminal')return terminalCwd(snapshot,appData,chat,input.folderId);
  if(input.operation!=='start')return {};
  if(chat.archived)throw new Error('Restore this conversation before starting a command.');
  if(chat.status==='running'||chat.status==='stopping')throw new Error('Wait for the current agent attempt before starting a host command.');
  if(chat.mode!=='agent'||chat.permissionMode!=='full')throw new Error('Host commands require explicitly acknowledged Full access in Agent mode.');
  if(chat.recovery?.kind==='recovery-needed')throw new Error('Resolve the uncertain provider attempt before starting more work.');
  const folder=chat.folderId?snapshot.folders.find(item=>item.id===chat.folderId):undefined;
  if(chat.folderId&&!folder)throw new Error('The command folder no longer exists.');
  // The ID is authoritative, but also constrain it before using it as a path segment.
  if(!/^[a-zA-Z0-9:_-]{1,160}$/.test(chat.id))throw new Error('Invalid command conversation.');
  const cwd=folder?.path??path.join(appData,'command-workspaces',chat.id);
  if(!folder)await mkdir(cwd,{recursive:true,mode:0o700});
  return {cwd,fullAccessAcknowledged:true};
}
/** A user-driven PTY needs no Full access (the user types every command); it opens in
 * the requested registered folder, the chat's folder, or the chat's scratch directory. */
async function terminalCwd(snapshot:Snapshot,appData:string,chat:Snapshot['chats'][number],folderId?:string) {
  if(chat.archived)throw new Error('Restore this conversation before opening a terminal.');
  const id=folderId??chat.folderId;
  const folder=id?snapshot.folders.find(item=>item.id===id):undefined;
  if(id&&!folder)throw new Error('The terminal folder no longer exists.');
  if(folder)return {cwd:folder.path};
  if(!/^[a-zA-Z0-9:_-]{1,160}$/.test(chat.id))throw new Error('Invalid terminal conversation.');
  const cwd=path.join(appData,'command-workspaces',chat.id);
  await mkdir(cwd,{recursive:true,mode:0o700});
  return {cwd};
}
export function computerAuthority(snapshot:Snapshot,scope:ScopedComputerRef) {
  const record=scope.kind==='project'?snapshot.projects.find(item=>item.id===scope.id):scope.kind==='chat'?snapshot.chats.find(item=>item.id===scope.id):undefined;
  if(!record)throw new Error('This computer scope no longer exists.');
  return {...scope,label:'name' in record?record.name:record.title};
}

/** One mutation boundary prevents permission/provider changes overtaking a
 * command's asynchronous receipt write and launch. Stop always remains usable. */
export class DesktopWorkspaces {
  private gates=new Map<string,Promise<unknown>>();
  private closing=false;
  private disposal?:Promise<void>;
  constructor(private service:AgentService,readonly processes:ProcessSessions,readonly computers:ScopedComputers) {}
  private serial<T>(id:string,action:()=>Promise<T>):Promise<T> {
    if(typeof id!=='string'||id.length>256)throw new Error('Invalid conversation.');
    const pending=(this.gates.get(id)??Promise.resolve()).catch(()=>{}).then(()=>{
      if(this.closing)throw new Error('Muster is stopping background work.');
      return action();
    });
    this.gates.set(id,pending);
    void pending.finally(()=>{if(this.gates.get(id)===pending)this.gates.delete(id);}).catch(()=>{});
    return pending;
  }
  async invoke<K extends keyof Commands>(command:K,input:Commands[K]['input']):Promise<Commands[K]['output']> {
    if(this.closing)throw new Error('Muster is stopping background work.');
    return await this.dispatch(command,input) as Commands[K]['output'];
  }
  private async dispatch(command:keyof Commands,input:unknown):Promise<unknown> {
    const p=input as any;
    switch(command) {
      case 'processes.summary': return this.processes.summary();
      case 'processes.start': return this.serial(p?.chatId,()=>this.processes.start(p));
      case 'processes.list': return this.processes.list(p);
      case 'processes.attach': return this.processes.attach(p);
      case 'processes.detach': return this.processes.detach(p);
      case 'processes.stop': return this.processes.stop(p);
      case 'processes.outputPage': return this.processes.outputPage(p);
      case 'processes.ports': return this.processes.ports(p);
      case 'processes.stopListener': return this.processes.stopListener(p);
      // Terminals are user-driven: no Full-access gate and no per-chat serial gate.
      case 'terminal.create': return this.processes.terminals.create({chatId:p?.chatId,...(p?.folderId!==undefined?{folderId:p.folderId}:{}),cols:p?.cols,rows:p?.rows,...(p?.host!==undefined?{host:p.host}:{})});
      case 'terminal.input': return this.processes.terminals.input({id:p?.id,data:p?.data});
      case 'terminal.resize': return this.processes.terminals.resize({id:p?.id,cols:p?.cols,rows:p?.rows});
      case 'terminal.kill': return this.processes.terminals.kill({id:p?.id});
      case 'terminal.list': return this.processes.terminals.list({chatId:p?.chatId});
      case 'terminal.snapshot': return this.processes.terminals.snapshot({id:p?.id});
    }
    if(isScopedComputerCommand(command))return this.computers.dispatch(command,p);
    const policyChange=command==='chat.setPermissionMode'||command==='chat.selectProvider'||(command==='chat.update'&&(p?.mode!==undefined||p?.model!==undefined));
    if(policyChange||command==='chat.send')return this.serial(p?.id,async()=>{
      if(policyChange&&this.processes.hasRunning(p.id))throw new Error('Stop this conversation’s background commands before changing access, mode or provider.');
      return this.service.invoke(command,p);
    });
    return this.service.invoke(command,p);
  }
  dispose():Promise<void> {
    if(this.disposal)return this.disposal;
    this.closing=true;
    this.disposal=(async()=>{
      // Close admission synchronously; adapters then checkpoint their own work.
      await Promise.allSettled([...this.gates.values()]);
      const outcomes=await Promise.allSettled([this.processes.dispose(),this.computers.dispose()]);
      const failure=outcomes.find(result=>result.status==='rejected');
      if(failure?.status==='rejected')throw failure.reason;
    })().catch(error=>{this.disposal=undefined;throw error;});
    return this.disposal;
  }
}
