/** Projects domain contract. Add commands here; the allowlist and service dispatch pick them up. */
import type { ProjectEventsPage } from '../project-events.ts';
import type { BoundedList, ChatPermissionMode, ProjectActivity, ProjectDecision, TaskStatus as LegacyTaskStatus } from '../protocol.ts';
import { PROJECT_TEAM_COMMANDS, type ProjectTeamCommands } from './project-team-protocol.ts';
export * from './project-team-protocol.ts';

/** A Project with its admin state. `folderIds` lists the primary folder first; archived Projects refuse task dispatch. */
export interface ProjectDetails { id: string; name: string; goal: string; folderIds: string[]; primaryFolderId: string | null; archived: boolean; archivedAt: string | null }
export interface ProjectImpactItem { id: string; title: string; status: string }
/** What archiving or deleting a Project touches. Lists are capped at 50; totals are exact. */
export interface ProjectImpact {
  projectId: string;
  chats: { total: number; running: number; items: ProjectImpactItem[] };
  tasks: { total: number; running: number; open: number; items: ProjectImpactItem[] };
}

/** Full task lifecycle. The legacy `status` field keeps the five-state view older callers understand; `state` is the truth. */
export type TaskState = 'todo' | 'running' | 'needs-input' | 'blocked' | 'review' | 'implemented' | 'verified' | 'failed' | 'cancelled';
export const TASK_STATES: readonly TaskState[] = ['todo', 'running', 'needs-input', 'blocked', 'review', 'implemented', 'verified', 'failed', 'cancelled'];
export const LEGACY_STATUS: Record<TaskState, LegacyTaskStatus> = { todo: 'todo', running: 'running', 'needs-input': 'running', blocked: 'blocked', review: 'implemented', implemented: 'implemented', verified: 'verified', failed: 'blocked', cancelled: 'blocked' };
export interface TaskOwner { kind: 'user' | 'agent'; id: string }
/** 0 urgent, 1 high, 2 normal, 3 low. */
export type TaskPriority = 0 | 1 | 2 | 3;
export const PRIORITY_LABEL: Record<TaskPriority, string> = { 0: 'Urgent', 1: 'High', 2: 'Normal', 3: 'Low' };
export type AttemptStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
export interface TaskAttempt { id: string; chatId: string; runId: string | null; trigger: 'user' | 'scheduler' | 'coordinator'; startedAt: string; endedAt: string | null; status: AttemptStatus; contextVersion: number | null; error?: string }
export type VerificationKind = 'tests' | 'review' | 'manual';
export interface TaskVerification { kind: VerificationKind; command?: string; commitSha?: string; folderId?: string; reviewer?: string; notes: string; verifiedAt: string }
export interface ProjectTaskRecord {
  id: string; projectId: string; title: string; status: LegacyTaskStatus; state: TaskState; dependencies: string[]; acceptance: string; evidence: string[];
  runChatId?: string; runRequestId?: string; runError?: string; revision: number; createdAt: string; updatedAt: string;
  owner: TaskOwner; priority: TaskPriority; artifacts: string[]; attempts: TaskAttempt[]; verification: TaskVerification | null;
  /** Most access a run of this task may get; the dispatch clamps it to the Project's permission mode. Null inherits the Project's. */
  permissionMode: ChatPermissionMode | null;
  /** Per-run wall-clock budget in minutes; null inherits the Project scheduler's. */
  budgetMinutes: number | null;
  /** The dependency whose reopening re-blocked this task; cleared when it is verified again. */
  blockedBy: string | null;
}
/** A task as the Project screen shows it: the record plus facts derived at read time. */
export interface ProjectTaskView extends ProjectTaskRecord { ready: boolean; verificationStale: boolean; waitingChatId: string | null }
export interface SchedulerSettings { autoDispatch: boolean; paused: boolean; concurrency: number; budgetMinutes: number; permissionMode: ChatPermissionMode; updatedAt: string | null }
export interface ProjectInstructions { version: number; text: string; updatedAt: string | null }
export interface ContextSummary { version: number; goalVersion: number; instructionsVersion: number; decisions: number; headSha: string | null; label: string; sources?: ProjectSourceRef[] }

/** PRJ-16: Project knowledge sources, versioned apart from memory. Docs carry text; URLs and files are referenced, never fetched or pasted wholesale. */
export type ProjectSourceKind = 'doc' | 'url' | 'file';
export interface ProjectSourceVersion { version: number; ref: string; digest: string; note: string; createdAt: string }
export interface ProjectSource { id: string; projectId: string; kind: ProjectSourceKind; title: string; ref: string; text: string; version: number; enabled: boolean; createdAt: string; updatedAt: string; history: ProjectSourceVersion[] }
/** How a run context names a source: enough to find it, with the version the run saw. */
export interface ProjectSourceRef { id: string; kind: ProjectSourceKind; title: string; ref: string; version: number }

/** PRJ-18: a bounded handoff packet. Large artifacts and sources are referenced by path/URL, not pasted. */
export interface HandoffMemoryRef { id: string; kind: string; text: string; scope: string; observedAt?: string; source: 'local' | 'hindsight' }
export interface HandoffAck { chatId: string; version: number; acknowledgedAt: string; via: 'run-start' | 'explicit' }
export interface HandoffPacket {
  id: string; projectId: string; taskId: string | null; version: number; taskRevision: number | null; createdAt: string;
  task: { title: string; acceptance: string; state: TaskState } | null;
  goalVersion: number; instructionsVersion: number; headSha: string | null;
  decisions: { id: string; title: string }[];
  artifacts: string[]; sources: ProjectSourceRef[]; memory: HandoffMemoryRef[];
  /** The packet as an agent receives it. */
  text: string;
  acks: HandoffAck[];
  /** True once a newer packet exists for the same task, or the task changed after this packet was built. */
  stale: boolean;
}
export type CoordinatorOp =
  | { op: 'create'; ref?: string; title: string; acceptance?: string; dependsOn?: string[]; owner?: 'user' | 'agent'; priority?: TaskPriority }
  | { op: 'update'; id: string; title?: string; acceptance?: string; dependsOn?: string[]; owner?: 'user' | 'agent'; priority?: TaskPriority }
  | { op: 'status'; id: string; state: 'todo' | 'blocked' | 'review' | 'implemented' | 'cancelled'; reason?: string }
  | { op: 'decision'; title: string; rationale?: string; scope?: string; relatedTaskIds?: string[] };
export interface CoordinatorProposal { key: string; itemId: string; createdAt: string; ops: CoordinatorOp[]; state: 'pending' | 'applied' | 'dismissed' | 'invalid'; error?: string }
export interface CoordinatorState { chatId: string | null; proposals: CoordinatorProposal[] }
export interface ProjectWorkState {
  tasks: BoundedList<ProjectTaskView>; decisions: BoundedList<ProjectDecision>; activity: BoundedList<ProjectActivity>;
  scheduler: SchedulerSettings; instructions: ProjectInstructions; context: ContextSummary; coordinator: CoordinatorState;
  /** Tasks the scheduler holds a dispatch lease for right now. */
  dispatching: string[];
  /** PRJ-07: the change-feed sequence this read reflects; replay project.events after it. */
  eventSeq?: number;
}
export interface TaskEdit { title?: string; acceptance?: string; priority?: TaskPriority; owner?: TaskOwner; artifacts?: string[]; dependencies?: string[]; permissionMode?: ChatPermissionMode | null; budgetMinutes?: number | null }

export interface ProjectsCommands extends ProjectTeamCommands {
  'project.list': { input: undefined; output: ProjectDetails[] };
  /** Rename, change the goal, replace the folder set or set the primary folder. Removing a folder with a running chat is refused. */
  'project.update': { input: { id: string; name?: string; goal?: string; folderIds?: string[]; primaryFolderId?: string | null }; output: ProjectDetails };
  'project.linkFolder': { input: { id: string; folderId: string; primary?: boolean }; output: ProjectDetails };
  'project.unlinkFolder': { input: { id: string; folderId: string }; output: ProjectDetails };
  /** Read-only preview shown before archive or delete. */
  'project.preview': { input: { id: string }; output: ProjectImpact };
  'project.archive': { input: { id: string }; output: ProjectDetails };
  'project.restore': { input: { id: string }; output: ProjectDetails };
  /** Refused while any Project chat or task is running. Chats keep their data and leave the Project. */
  'project.delete': { input: { id: string }; output: { deleted: true; detachedChats: number } };
  /** Everything the Project screen shows in one read: tasks with derived readiness, stale verification and waiting chats. */
  'project.work': { input: { projectId: string; activityLimit?: number }; output: ProjectWorkState };
  'project.tasks.add': { input: { projectId: string; title: string; acceptance: string; dependencies: string[]; owner?: TaskOwner; priority?: TaskPriority; permissionMode?: ChatPermissionMode | null; budgetMinutes?: number | null }; output: ProjectTaskView };
  'project.tasks.edit': { input: { projectId: string; id: string; revision: number; patch: TaskEdit }; output: ProjectTaskView };
  /** Refused while the task runs or while another task depends on it. */
  'project.tasks.delete': { input: { projectId: string; id: string; revision: number }; output: { deleted: true } };
  /** Manual transitions. Running and needs-input come only from real runs; verified only through project.tasks.verify. */
  'project.tasks.setState': { input: { projectId: string; id: string; revision: number; state: TaskState; reason?: string }; output: ProjectTaskView };
  /** Structured verification. Requires implemented or review; records the folder HEAD so a later commit marks it stale. */
  'project.tasks.verify': { input: { projectId: string; id: string; revision: number; kind: VerificationKind; notes: string; command?: string; reviewer?: string }; output: ProjectTaskView };
  /** Starts one agent run for a task at the clamped permission mode and records the attempt. */
  'project.tasks.dispatch': { input: { projectId: string; id: string; revision: number; folderId?: string }; output: { chatId: string; runId: string } };
  'project.decisions.add': { input: { projectId: string; title: string; rationale: string; scope: string; relatedTaskIds: string[] }; output: ProjectDecision };
  'project.decisions.edit': { input: { projectId: string; id: string; title?: string; rationale?: string; scope?: string; relatedTaskIds?: string[] }; output: ProjectDecision };
  'project.decisions.replace': { input: { projectId: string; id: string; replacementId: string }; output: ProjectDecision };
  /** Versioned Project rules. `baseVersion` must match the stored version. */
  'project.instructions.set': { input: { projectId: string; text: string; baseVersion: number }; output: ProjectInstructions };
  'project.scheduler.set': { input: { projectId: string; autoDispatch?: boolean; paused?: boolean; concurrency?: number; budgetMinutes?: number; permissionMode?: ChatPermissionMode; acknowledgeFullAccess?: boolean }; output: SchedulerSettings };
  /** Creates (or returns) the pinned coordinator chat for a Project. */
  'project.coordinator.start': { input: { projectId: string }; output: { chatId: string } };
  'project.coordinator.apply': { input: { projectId: string; key: string }; output: CoordinatorProposal };
  'project.coordinator.dismiss': { input: { projectId: string; key: string }; output: CoordinatorProposal };
  'project.sources.list': { input: { projectId: string }; output: { sources: ProjectSource[] } };
  /** Adds a source, or saves a new version of one. `baseVersion` must match when updating. Running Project chats get a notice. */
  'project.sources.save': { input: { projectId: string; id?: string; kind: ProjectSourceKind; title: string; ref: string; text?: string; note?: string; enabled?: boolean; baseVersion?: number }; output: ProjectSource };
  'project.sources.remove': { input: { projectId: string; id: string }; output: { removed: true } };
  /** Builds (or returns the unchanged) handoff packet for a task, or for the Project when no task is given. */
  'project.handoff.build': { input: { projectId: string; taskId?: string }; output: HandoffPacket };
  'project.handoff.latest': { input: { projectId: string; taskId?: string }; output: { packet: HandoffPacket | null } };
  /** A recipient confirms which packet version it works from. Refused for a stale packet so old context cannot overwrite newer task state. */
  'project.handoff.ack': { input: { projectId: string; packetId: string; chatId: string; version: number }; output: HandoffAck };
  /** PRJ-07: missed-event replay. Events after `after` in order; `reset` means reload project.work instead. */
  'project.events': { input: { projectId: string; after: number; limit?: number }; output: ProjectEventsPage };
}
export type ProjectsEvent = never;
export const PROJECTS_COMMANDS = { ...PROJECT_TEAM_COMMANDS, 'project.list': true, 'project.update': true, 'project.linkFolder': true, 'project.unlinkFolder': true, 'project.preview': true, 'project.archive': true, 'project.restore': true, 'project.delete': true,
  'project.work': true, 'project.tasks.add': true, 'project.tasks.edit': true, 'project.tasks.delete': true, 'project.tasks.setState': true, 'project.tasks.verify': true, 'project.tasks.dispatch': true,
  'project.decisions.add': true, 'project.decisions.edit': true, 'project.decisions.replace': true, 'project.instructions.set': true, 'project.scheduler.set': true,
  'project.coordinator.start': true, 'project.coordinator.apply': true, 'project.coordinator.dismiss': true,
  'project.sources.list': true, 'project.sources.save': true, 'project.sources.remove': true, 'project.handoff.build': true, 'project.handoff.latest': true, 'project.handoff.ack': true, 'project.events': true } as const satisfies Record<keyof ProjectsCommands, true>;

const RANK: Record<ChatPermissionMode, number> = { 'read-only': 0, workspace: 1, full: 2 };
/** The dispatch never exceeds the Project's permission mode. */
export function clampPermission(task: ChatPermissionMode | null, project: ChatPermissionMode): ChatPermissionMode { return task && RANK[task] < RANK[project] ? task : project; }

/** A task is ready when it can start now and every dependency is verified. */
export function isReady(task: Pick<ProjectTaskRecord, 'state' | 'dependencies'>, byId: ReadonlyMap<string, Pick<ProjectTaskRecord, 'state'>>): boolean {
  return (task.state === 'todo' || task.state === 'failed') && task.dependencies.every(id => byId.get(id)?.state === 'verified');
}

/** Tasks laid out by depth (longest dependency chain) for the graph view. Rows keep priority then creation order. */
export interface GraphNode { id: string; col: number; row: number }
export interface GraphEdge { from: string; to: string }
export function layoutTaskGraph(tasks: readonly Pick<ProjectTaskRecord, 'id' | 'dependencies' | 'priority' | 'createdAt'>[]): { nodes: GraphNode[]; edges: GraphEdge[]; cols: number; rows: number } {
  const byId = new Map(tasks.map(t => [t.id, t])), depth = new Map<string, number>(), visiting = new Set<string>();
  const walk = (id: string): number => {
    const known = depth.get(id); if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const d = byId.get(id)!.dependencies.filter(dep => byId.has(dep)).reduce((m, dep) => Math.max(m, walk(dep) + 1), 0);
    visiting.delete(id); depth.set(id, d); return d;
  };
  for (const t of tasks) walk(t.id);
  const cols: string[][] = [];
  for (const t of [...tasks].sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt))) (cols[depth.get(t.id)!] ??= []).push(t.id);
  const nodes = cols.flatMap((ids, col) => (ids ?? []).map((id, row) => ({ id, col, row })));
  const edges = tasks.flatMap(t => t.dependencies.filter(dep => byId.has(dep)).map(dep => ({ from: dep, to: t.id })));
  return { nodes, edges, cols: cols.length, rows: Math.max(0, ...cols.map(c => c?.length ?? 0)) };
}

/** Extracts every fenced ```muster-tasks block from coordinator text. Each block is a JSON array of ops (or one op). */
export function parseCoordinatorBlocks(text: string): { ops: CoordinatorOp[]; error?: string }[] {
  const out: { ops: CoordinatorOp[]; error?: string }[] = [];
  for (const match of text.matchAll(/```muster-tasks[^\n]*\n([\s\S]*?)```/g)) {
    try { const raw: unknown = JSON.parse(match[1]!); const list = Array.isArray(raw) ? raw : [raw]; if (!list.length || list.length > 50) throw new Error('A block holds 1–50 operations.'); out.push({ ops: list.map(validateOp) }); }
    catch (err) { out.push({ ops: [], error: err instanceof Error ? err.message : 'Unreadable block.' }); }
  }
  return out;
}
const str = (v: unknown, field: string, max: number, optional = false): string | undefined => { if (v === undefined && optional) return undefined; if (typeof v !== 'string' || v.length > max || (!optional && !v.trim())) throw new Error(`Invalid ${field}.`); return v; };
const strs = (v: unknown, field: string): string[] | undefined => { if (v === undefined) return undefined; if (!Array.isArray(v) || v.length > 50 || v.some(x => typeof x !== 'string' || x.length > 128)) throw new Error(`Invalid ${field}.`); return v as string[]; };
const prio = (v: unknown): TaskPriority | undefined => { if (v === undefined) return undefined; if (v !== 0 && v !== 1 && v !== 2 && v !== 3) throw new Error('Priority must be 0–3.'); return v; };
const ownerKind = (v: unknown): 'user' | 'agent' | undefined => { if (v === undefined) return undefined; if (v !== 'user' && v !== 'agent') throw new Error('Owner must be "user" or "agent".'); return v; };
const compact = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
function validateOp(raw: unknown): CoordinatorOp {
  if (!raw || typeof raw !== 'object') throw new Error('Each operation must be an object.');
  const o = raw as Record<string, unknown>;
  if (o.op === 'create') return compact<CoordinatorOp>({ op: 'create', ref: str(o.ref, 'ref', 64, true), title: str(o.title, 'title', 500)!.trim(), acceptance: str(o.acceptance, 'acceptance', 4000, true), dependsOn: strs(o.dependsOn, 'dependsOn'), owner: ownerKind(o.owner), priority: prio(o.priority) });
  if (o.op === 'update') return compact<CoordinatorOp>({ op: 'update', id: str(o.id, 'task id', 128)!, title: str(o.title, 'title', 500, true), acceptance: str(o.acceptance, 'acceptance', 4000, true), dependsOn: strs(o.dependsOn, 'dependsOn'), owner: ownerKind(o.owner), priority: prio(o.priority) });
  if (o.op === 'status') { const state = o.state; if (state !== 'todo' && state !== 'blocked' && state !== 'review' && state !== 'implemented' && state !== 'cancelled') throw new Error('Coordinator status must be todo, blocked, review, implemented or cancelled.'); return compact<CoordinatorOp>({ op: 'status', id: str(o.id, 'task id', 128)!, state, reason: str(o.reason, 'reason', 2000, true) }); }
  if (o.op === 'decision') return compact<CoordinatorOp>({ op: 'decision', title: str(o.title, 'decision title', 500)!.trim(), rationale: str(o.rationale, 'rationale', 8000, true), scope: str(o.scope, 'scope', 500, true), relatedTaskIds: strs(o.relatedTaskIds, 'relatedTaskIds') });
  throw new Error(`Unknown operation ${JSON.stringify(o.op)}.`);
}
