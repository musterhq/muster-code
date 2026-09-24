/** References are validated against the runtime's authoritative project/chat store. */
export interface ScopedComputerRef {kind:'chat'|'project';id:string}
export type ScopedComputerState = 'not-created'|'running'|'stopped'|'unavailable'|'recovery-needed'|'unknown';
/** 'none': no network interface. 'egress': outbound internet (Docker bridge); requires explicit confirmation. */
export type ScopedComputerNetwork = 'none'|'egress';
/** What went wrong, so the UI can offer the matching fix instead of one generic Docker message. */
export type ScopedComputerProblem = 'docker-missing'|'daemon-down'|'image'|'ownership'|'policy'|'integrity'|'dependency'|'workspace-missing';
export const SCOPED_COMPUTER_MAX_TIMEOUT_MS = 2*60*60*1000;
export const SCOPED_COMPUTER_DEFAULT_TIMEOUT_MS = 30*60*1000;
export const SCOPED_COMPUTER_MAX_RUNNING = 2;
/** SBX-08: kernel-enforced (cgroup) ceilings passed to `docker run`; changing one recreates the container, files kept. */
export interface ScopedComputerLimits {memoryMiB:number;cpus:number;processes:number}
export const SCOPED_COMPUTER_DEFAULT_LIMITS:Readonly<ScopedComputerLimits> = {memoryMiB:512,cpus:1,processes:256};
export const SCOPED_COMPUTER_LIMIT_BOUNDS = {memoryMiB:{min:256,max:16384,step:256},cpus:{min:0.25,max:8,step:0.25},processes:{min:32,max:4096,step:32}} as const;
/** Live cgroup usage from `docker stats`; null fields were not reported. */
export interface ScopedComputerUsage {computerId:string;running:boolean;memoryBytes:number|null;memoryLimitBytes:number|null;cpuPercent:number|null;pids:number|null;sampledAt:string}
/** SBX-16: versioned, read-only tool/skill layers mounted into the container. Sources are chosen by the main process only. */
export type ScopedComputerLayerId = 'skills'|'tools';
export interface ScopedComputerLayer {id:ScopedComputerLayerId;label:string;/** Content hash of the snapshot (12 hex). */version:string;/** In-container mount point (read-only). */target:string}
export interface ScopedComputerLayerSource {id:ScopedComputerLayerId;label:string;available:boolean;reason?:string}
/** SBX-15: supervised services. 'never' (default) is not restarted; 'on-failure' after a nonzero exit or a reboot that killed it; 'always' after any exit and every reboot. */
export type ScopedComputerRestartPolicy = 'never'|'on-failure'|'always';
export interface ScopedComputerServiceSpec {name:string;command:string;/** Inside /workspace; default /workspace. */cwd?:string;env?:Record<string,string>;restart:ScopedComputerRestartPolicy;/** 'browser' is the SBX-11 in-sandbox browser service. */role?:'browser'}
export type ScopedComputerServiceState = 'starting'|'running'|'stopped'|'exited'|'failed'|'lost'|'backoff';
export interface ScopedComputerService extends ScopedComputerServiceSpec {
  id:string;state:ScopedComputerServiceState;
  /** The boot generation this service last started in; below the computer's current generation means it predates the last reboot. */
  bootGeneration:number;restarts:number;lastExitCode:number|null;startedAt?:string;endedAt?:string;reason?:string;
  /** Bounded tail of the latest run's output (not persisted across app restarts). */
  output:string;
}
export interface ScopedComputerServices {computerId:string;bootGeneration:number;services:ScopedComputerService[]}
/** SBX-16: written next to the archive and embedded in it as muster-export.json. */
export interface ScopedComputerExportManifest {format:'muster-sandbox-export/1';computerId:string;label:string;scope:ScopedComputerRef['kind'];image:string;network:ScopedComputerNetwork;limits:ScopedComputerLimits;layers:ScopedComputerLayer[];exportedAt:string;files:number;directories:number;symlinks:number;bytes:number;archiveBytes:number;archiveSha256:string}
export interface ScopedComputerStatus {
  id:string;
  scope:ScopedComputerRef;
  label:string;
  provider:'local-docker';
  state:ScopedComputerState;
  reason?:string;
  problem?:ScopedComputerProblem;
  /** A container exists that this installation owns but never finished registering, or its workspace vanished. */
  repair?:'unregistered-container'|'workspace-missing';
  activeExecutionId?:string;
  workspacePreserved:true;
  /** Chat sandboxes are scratch (disposable); project sandboxes are durable. */
  durability:'scratch'|'durable';
  image:string;
  user:string;
  limits:{network:ScopedComputerNetwork;memoryMiB:number;cpus:number;processes:number;maxRunning:number;maxTimeoutMs:number};
  /** Read-only layers this container was created with. */
  layers?:ScopedComputerLayer[];
  /** Increments whenever the container (re)boots; services compare against it. */
  bootGeneration?:number;
}
export interface ScopedComputerExecution {
  executionId:string;
  computerId:string;
  state:'running'|'completed'|'failed'|'cancelled'|'timed-out'|'recovery-needed';
  /** The most recent output (a bounded tail); `…Truncated` means earlier output was dropped. */
  stdout:string;
  stderr:string;
  stdoutTruncated:boolean;
  stderrTruncated:boolean;
  exitCode:number|null;
  /** True only when the whole container had to be stopped; cancel and timeout normally end just this command. */
  computerStopped:boolean;
  reason?:string;
  command?:string;
  startedAt?:string;
  endedAt?:string;
}
/** A persisted run (the last 50 per sandbox), restored after an app restart as ended. */
export interface ScopedComputerRun extends ScopedComputerExecution {command:string;startedAt:string;restored?:boolean}
export interface ScopedComputerFile {name:string;path:string;kind:'file'|'directory'|'symlink';size:number;modifiedAt:string}
export type ScopedComputerEvent =
  |{type:'computerOutput';computerId:string;execId:string;stream:'stdout'|'stderr';data:string}
  |{type:'computerExecution';computerId:string;execution:ScopedComputerExecution}
  |{type:'computerProgress';computerId:string;phase:'pull'|'provision'|'done';message:string}
  |{type:'computerServices';computerId:string;bootGeneration:number;services:ScopedComputerService[]};
type Scoped<T={}> = {scope:ScopedComputerRef}&T;
export interface ScopedComputerCommands {
  'computer.inspect':{input:Scoped;output:ScopedComputerStatus};
  'computer.start':{input:Scoped;output:ScopedComputerStatus};
  'computer.stop':{input:Scoped;output:ScopedComputerStatus};
  'computer.destroy':{input:Scoped;output:ScopedComputerStatus};
  'computer.exec':{input:Scoped<{command:string;requestId:string;timeoutMs?:number}>;output:{executionId:string}};
  /** Same admission as exec; output arrives as `computerOutput` events keyed by execId. */
  'computer.execStream':{input:Scoped<{command:string;requestId:string;timeoutMs?:number}>;output:{execId:string}};
  'computer.input':{input:Scoped<{execId:string;data?:string;eof?:boolean}>;output:void};
  'computer.execution':{input:Scoped<{executionId:string}>;output:ScopedComputerExecution};
  'computer.cancel':{input:Scoped<{executionId:string}>;output:ScopedComputerExecution};
  'computer.history':{input:Scoped;output:ScopedComputerRun[]};
  /** Recreates the container (workspace files kept). 'egress' requires confirmed:true. */
  'computer.setNetwork':{input:Scoped<{network:ScopedComputerNetwork;confirmed?:boolean}>;output:ScopedComputerStatus};
  'computer.repair':{input:Scoped<{action:'adopt'|'recreate'}>;output:ScopedComputerStatus};
  'computer.files.list':{input:Scoped<{path?:string}>;output:{path:string;entries:ScopedComputerFile[];truncated:boolean}};
  /** Host files are chosen in a main-process dialog; renderer-supplied host paths are never accepted. */
  'computer.files.import':{input:Scoped<{into?:string}>;output:{imported:string[]}};
  'computer.files.export':{input:Scoped<{path:string}>;output:{savedTo:string}|null};
  'computer.workspace.size':{input:Scoped;output:{bytes:number;files:number;truncated:boolean}};
  'computer.workspace.delete':{input:Scoped<{confirmed:boolean;removeContainer?:boolean}>;output:ScopedComputerStatus};
  /** Recreates the container when a limit changes (workspace files kept). */
  'computer.setLimits':{input:Scoped<{limits:Partial<ScopedComputerLimits>}>;output:ScopedComputerStatus};
  'computer.usage':{input:Scoped;output:ScopedComputerUsage};
  'computer.layers.sources':{input:Scoped;output:{sources:ScopedComputerLayerSource[];active:ScopedComputerLayer[]}};
  /** Snapshots each chosen source into an immutable versioned layer and recreates the container with it mounted read-only. */
  'computer.layers.set':{input:Scoped<{layers:ScopedComputerLayerId[]}>;output:ScopedComputerStatus};
  'computer.services.list':{input:Scoped;output:ScopedComputerServices};
  'computer.services.register':{input:Scoped<{service:ScopedComputerServiceSpec;start?:boolean}>;output:ScopedComputerService};
  'computer.services.start':{input:Scoped<{serviceId:string}>;output:ScopedComputerService};
  'computer.services.stop':{input:Scoped<{serviceId:string}>;output:ScopedComputerService};
  'computer.services.remove':{input:Scoped<{serviceId:string}>;output:ScopedComputerServices};
  /** Whole-workspace archive (.tar.gz) plus a size/type manifest; the destination is chosen in a main-process dialog. */
  'computer.export':{input:Scoped;output:{savedTo:string;manifestPath:string;manifest:ScopedComputerExportManifest}|null};
}
export type ScopedComputerCommand = keyof ScopedComputerCommands;
export const SCOPED_COMPUTER_COMMANDS = {'computer.inspect':true, 'computer.start':true, 'computer.stop':true, 'computer.destroy':true, 'computer.exec':true, 'computer.execStream':true, 'computer.input':true, 'computer.execution':true, 'computer.cancel':true, 'computer.history':true, 'computer.setNetwork':true, 'computer.repair':true, 'computer.files.list':true, 'computer.files.import':true, 'computer.files.export':true, 'computer.workspace.size':true, 'computer.workspace.delete':true, 'computer.setLimits':true, 'computer.usage':true, 'computer.layers.sources':true, 'computer.layers.set':true, 'computer.services.list':true, 'computer.services.register':true, 'computer.services.start':true, 'computer.services.stop':true, 'computer.services.remove':true, 'computer.export':true} as const satisfies Record<ScopedComputerCommand, true>;
export const isScopedComputerCommand = (command:string):command is ScopedComputerCommand => Object.hasOwn(SCOPED_COMPUTER_COMMANDS, command);
