/** Owned non-interactive commands. This protocol accepts neither PIDs nor cwd/env. */
export type ProcessStatus='starting'|'running'|'stopping'|'exited'|'failed'|'stopped'|'lost';
export type ProcessPurpose='command'|'test'|'build'|'server'|'task';
export interface ProcessRef {chatId:string;processId:string}
export interface ProcessSnapshot extends ProcessRef {
  generation:number;sequence:number;status:ProcessStatus;
  label:string;purpose:ProcessPurpose;command?:string;args?:string[];
  startedAt:string;updatedAt:string;output:string;truncated:boolean;
  exitCode:number|null;signal?:string;error?:string;
  /** Who started it. Commands launched from the Commands tab are the user's; the agent must never stop them. */
  owner?:TerminalOwner;
  /** PER-06: set while a build/test waits for the resource scheduler (memory pressure or another heavy job). */
  queued?:string;
}
export interface ProcessListSnapshot {chatId:string;sessions:ProcessSnapshot[]}
export interface ProcessStart {chatId:string;requestId:string;command:string;args?:string[];label?:string;purpose?:ProcessPurpose}
export interface ProcessLease {chatId:string;leaseId:string}
/** Global visibility never carries commands, arguments, output or environment. */
export type ProcessMetadata=Pick<ProcessSnapshot,'chatId'|'processId'|'label'|'purpose'|'status'|'startedAt'|'updatedAt'>;
export interface ProcessSummarySnapshot {revision:number;sessions:ProcessMetadata[]}
/** Interactive PTYs are user-driven: they need no Full access and never persist a PID.
 * 'ended' means the PTY died with a previous Muster process (no detached daemon). */
export type TerminalStatus='running'|'exited'|'ended';
export type TerminalOwner='user'|'agent';
export interface TerminalInfo {id:string;chatId:string;title:string;cwd:string;shell:string;owner:TerminalOwner;status:TerminalStatus;startedAt:string;exitCode:number|null;end?:number}
/** CR-20: `host` opts a terminal into a registered remote Codex app-server (process/spawn); local node-pty is the default. */
export type TerminalHost={kind:'local'}|{kind:'remote';id:string};
export interface TerminalCreate {chatId:string;folderId?:string;cols:number;rows:number;host?:TerminalHost}
/** Replay of the bounded ring (5,000 lines / 8 MiB); omitted counts describe the dropped head.
 * `end`/`start` count UTF-16 units ever written, so a viewer that missed events (hidden window) resyncs. */
export interface TerminalReplay {data:string;truncatedBytes:number;omittedLines:number;end:number}
/** PER-05: one page of the durable output log. `itemId` pages an agent tool row's output instead of a command. */
export interface ProcessOutputPageInput {chatId:string;processId?:string;itemId?:string;before?:number;bytes?:number}
export interface ProcessOutputPage {start:number;end:number;size:number;text:string;capped:boolean}
/** S3-E: a TCP port a shell, command or agent process of this conversation listens on.
 * The renderer gets an opaque id (never a PID or command line); stopping resolves it again in main. */
export type ListenerSource={kind:'terminal';id:string}|{kind:'process';processId:string}|{kind:'agent'};
export interface ListeningPort {id:string;port:number;address:string;name:string;owner:TerminalOwner;source:ListenerSource}
/** `supported:false` when this platform has no lsof (ports are then simply not shown). */
export interface ProcessPortsSnapshot {chatId:string;ports:ListeningPort[];supported:boolean;scannedAt:string}
export type ProcessEvent={type:'processSession';leaseId:string;session:ProcessSnapshot}|{type:'processMetadata';summary:ProcessSummarySnapshot}|{type:'terminalData';id:string;data:string;start:number}|{type:'terminalExit';id:string;code:number|null};
export interface ProcessCommands {
  'processes.summary':{input:Record<string,never>;output:ProcessSummarySnapshot};
  'processes.start':{input:ProcessStart;output:ProcessSnapshot};
  'processes.list':{input:{chatId:string};output:ProcessListSnapshot};
  'processes.attach':{input:ProcessLease;output:ProcessListSnapshot};
  'processes.detach':{input:ProcessLease;output:void};
  'processes.stop':{input:ProcessRef;output:ProcessSnapshot};
  'processes.outputPage':{input:ProcessOutputPageInput;output:ProcessOutputPage};
  'processes.ports':{input:{chatId:string};output:ProcessPortsSnapshot};
  'processes.stopListener':{input:{chatId:string;id:string};output:void};
  'terminal.create':{input:TerminalCreate;output:TerminalInfo};
  'terminal.input':{input:{id:string;data:string};output:void};
  'terminal.resize':{input:{id:string;cols:number;rows:number};output:void};
  'terminal.kill':{input:{id:string};output:void};
  'terminal.list':{input:{chatId:string};output:TerminalInfo[]};
  'terminal.snapshot':{input:{id:string};output:TerminalReplay};
}
export const PROCESS_COMMANDS = {'processes.summary':true, 'processes.start':true, 'processes.list':true, 'processes.attach':true, 'processes.detach':true, 'processes.stop':true, 'processes.outputPage':true, 'processes.ports':true, 'processes.stopListener':true, 'terminal.create':true, 'terminal.input':true, 'terminal.resize':true, 'terminal.kill':true, 'terminal.list':true, 'terminal.snapshot':true} as const satisfies Record<keyof ProcessCommands, true>;
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
