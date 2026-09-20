/** Owned non-interactive commands. This protocol accepts neither PIDs nor cwd/env. */
export type ProcessStatus='starting'|'running'|'stopping'|'exited'|'failed'|'stopped'|'lost';
export type ProcessPurpose='command'|'test'|'build'|'server'|'task';
export interface ProcessRef {chatId:string;processId:string}
export interface ProcessSnapshot extends ProcessRef {
  generation:number;sequence:number;status:ProcessStatus;
  label:string;purpose:ProcessPurpose;command?:string;args?:string[];
  startedAt:string;updatedAt:string;output:string;truncated:boolean;
  exitCode:number|null;signal?:string;error?:string;
}
export interface ProcessListSnapshot {chatId:string;sessions:ProcessSnapshot[]}
export interface ProcessStart {chatId:string;requestId:string;command:string;args?:string[];label?:string;purpose?:ProcessPurpose}
export interface ProcessLease {chatId:string;leaseId:string}
/** Global visibility never carries commands, arguments, output or environment. */
export type ProcessMetadata=Pick<ProcessSnapshot,'chatId'|'processId'|'label'|'purpose'|'status'|'startedAt'|'updatedAt'>;
export interface ProcessSummarySnapshot {revision:number;sessions:ProcessMetadata[]}
export type ProcessEvent={type:'processSession';leaseId:string;session:ProcessSnapshot}|{type:'processMetadata';summary:ProcessSummarySnapshot};
export interface ProcessCommands {
  'processes.summary':{input:Record<string,never>;output:ProcessSummarySnapshot};
  'processes.start':{input:ProcessStart;output:ProcessSnapshot};
  'processes.list':{input:{chatId:string};output:ProcessListSnapshot};
  'processes.attach':{input:ProcessLease;output:ProcessListSnapshot};
  'processes.detach':{input:ProcessLease;output:void};
  'processes.stop':{input:ProcessRef;output:ProcessSnapshot};
}
/** Replacements include removals; late initial reads cannot resurrect old rows. */
export function mergeProcessSummary(current:ProcessSummarySnapshot|null,next:ProcessSummarySnapshot):ProcessSummarySnapshot {
  return current&&current.revision>=next.revision?current:next;
}
/** Full snapshots make subscribe-before-attach races harmless: no output replay.
 * An older snapshot can never rewind a report already received through IPC.
 */
export function mergeProcessSnapshot(current:readonly ProcessSnapshot[],next:ProcessSnapshot):ProcessSnapshot[]{
  const index=current.findIndex(item=>item.processId===next.processId&&item.chatId===next.chatId);
  if(index<0)return [...current,next];
  const prior=current[index];
  if(next.generation<prior.generation || (next.generation===prior.generation&&next.sequence<=prior.sequence))return current as ProcessSnapshot[];
  const result=current.slice();result[index]=next;return result;
}
export function isActiveProcess(status:ProcessStatus):boolean {return status==='starting'||status==='running'||status==='stopping';}
