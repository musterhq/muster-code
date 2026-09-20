/** References are validated against the runtime's authoritative project/chat store. */
export interface ScopedComputerRef {kind:'chat'|'project';id:string}
export type ScopedComputerState = 'not-created'|'running'|'stopped'|'unavailable'|'recovery-needed'|'unknown';
export interface ScopedComputerStatus {
  id:string;
  scope:ScopedComputerRef;
  label:string;
  provider:'local-docker';
  state:ScopedComputerState;
  reason?:string;
  activeExecutionId?:string;
  workspacePreserved:true;
  limits:{network:'none';memoryMiB:512;cpus:1;processes:256};
}
export interface ScopedComputerExecution {
  executionId:string;
  computerId:string;
  state:'running'|'completed'|'failed'|'cancelled'|'timed-out'|'recovery-needed';
  stdout:string;
  stderr:string;
  stdoutTruncated:boolean;
  stderrTruncated:boolean;
  exitCode:number|null;
  /** Cancellation and timeout stop this entire scoped container, preserving its workspace. */
  computerStopped:boolean;
  reason?:string;
}
export interface ScopedComputerCommands {
  'computer.inspect':{input:{scope:ScopedComputerRef};output:ScopedComputerStatus};
  'computer.start':{input:{scope:ScopedComputerRef};output:ScopedComputerStatus};
  'computer.stop':{input:{scope:ScopedComputerRef};output:ScopedComputerStatus};
  'computer.destroy':{input:{scope:ScopedComputerRef};output:ScopedComputerStatus};
  'computer.exec':{input:{scope:ScopedComputerRef;command:string;requestId:string;timeoutMs?:number};output:{executionId:string}};
  'computer.execution':{input:{scope:ScopedComputerRef;executionId:string};output:ScopedComputerExecution};
  'computer.cancel':{input:{scope:ScopedComputerRef;executionId:string};output:ScopedComputerExecution};
}
