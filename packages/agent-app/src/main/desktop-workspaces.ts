import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import type {Commands,Snapshot} from '../shared/protocol.ts';
import type {ScopedComputerRef} from '../shared/scoped-computer-protocol.ts';
import type {AgentService} from './service-loader.ts';
import type {ProcessSessions,ProcessAuthorize} from '../runtime/process-sessions.ts';
import type {ScopedComputers} from '../runtime/scoped-computers.ts';

/** Resolve authority from the store; renderer paths and PIDs are never accepted. */
export async function commandAuthority(snapshot:Snapshot,appData:string,input:Parameters<ProcessAuthorize>[0]) {
  const chat=snapshot.chats.find(item=>item.id===input.chatId);
  if(!chat)throw new Error('This conversation no longer exists.');
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
      case 'computer.inspect': return this.computers.inspect(p?.scope);
      case 'computer.start': return this.computers.start(p?.scope);
      case 'computer.stop': return this.computers.stop(p?.scope);
      case 'computer.destroy': return this.computers.destroy(p?.scope);
      case 'computer.exec': return this.computers.exec(p);
      case 'computer.execution': return this.computers.execution(p?.scope,p?.executionId);
      case 'computer.cancel': return this.computers.cancel(p?.scope,p?.executionId);
    }
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
