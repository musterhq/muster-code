/**
 * Paperclip in Muster (#115). One app, one sidebar: Muster's own Projects and, when Settings › Integrations links a
 * Paperclip (this Mac, or a custom URL with a board API token), that server's projects appear beside them, tagged
 * "Paperclip", with their tasks as chats. Everything here is normalised so the UI never branches on where a row came from
 * beyond its `source` tag:
 * - `local`: Muster's own Projects data (project tasks and attempts, members, mailbox, schedulers, the turn ledger).
 * - `paperclip`: the linked server. The runtime talks to it; the token lives in the encrypted secret store and never
 *   reaches the renderer.
 */
import type { MemoryConnection, MemoryRecord } from './memory-protocol.ts';

export type PaperclipMode = 'off' | 'local' | 'custom';
export const PAPERCLIP_LOCAL_URL = 'http://127.0.0.1:3100';
export type WorkspaceSource = 'paperclip' | 'local';

/** The token never reaches the renderer: only whether one is stored. */
export interface PaperclipConfigView { mode: PaperclipMode; baseUrl: string; hasToken: boolean; secureStorage: boolean; companyId: string | null }
/** `token`: omitted keeps the stored one, '' removes it. */
export interface PaperclipConfigInput { mode: PaperclipMode; baseUrl?: string; token?: string; companyId?: string | null }
export interface PaperclipTestResult {
  ok: boolean; stage: 'config' | 'network' | 'auth' | 'service' | 'ok'; message: string; latencyMs?: number;
  version?: string; deploymentMode?: string; companies?: WorkspaceCompany[];
}

export type WorkspaceStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled';
export const WORKSPACE_STATUSES: readonly WorkspaceStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'];
export const STATUS_LABEL: Record<WorkspaceStatus, string> = { backlog: 'Backlog', todo: 'Todo', in_progress: 'In Progress', in_review: 'In Review', blocked: 'Blocked', done: 'Done', cancelled: 'Cancelled' };
export type WorkspacePriority = 'critical' | 'high' | 'medium' | 'low';
export const PRIORITY_NAME: Record<WorkspacePriority, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };

export interface WorkspaceCompany { id: string; name: string; prefix: string }
export interface WorkspaceTask {
  id: string; key: string; title: string; status: WorkspaceStatus; priority: WorkspacePriority; source: WorkspaceSource;
  projectId: string | null; parentId: string | null; goalId: string | null;
  assigneeId: string | null; assigneeLabel: string | null;
  createdAt: string; updatedAt: string; startedAt: string | null; completedAt: string | null;
  /** An agent run is working on it right now. */
  live: boolean;
  blockedByIds: string[];
  /** Who opened it (board, an agent, you). */
  origin: string | null;
}
export type AgentState = 'active' | 'idle' | 'running' | 'paused' | 'error' | 'pending' | 'terminated';
export interface WorkspaceAgent {
  id: string; name: string; role: string; title: string | null; model: string | null; adapter: string | null; source: WorkspaceSource;
  status: AgentState; reportsTo: string | null; lastActiveAt: string | null; error: string | null;
  /** What the agent is for, in a sentence or two (Paperclip `capabilities`, a Muster project's goal). */
  capabilities: string | null;
  /** Muster agents pause through their Project's scheduler; Paperclip agents pause one by one. */
  pausable: boolean;
}
export interface WorkspaceProject {
  id: string; name: string; status: string; description: string; source: WorkspaceSource;
  /** Normalised git remote (`github.com/org/repo`) when the project names one. Memory recall keys on it. */
  repo: string | null; cwd: string | null; taskCount: number; openCount: number; paused: boolean;
  /** The Muster memory bank this project's work recalls from (matched by repository), and how many notes it holds. */
  memory: { label: string; count: number } | null;
}
export type RunState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
export interface WorkspaceRun {
  id: string; agentId: string | null; taskId: string | null; status: RunState; trigger: string | null; source: WorkspaceSource;
  createdAt: string; startedAt: string | null; finishedAt: string | null; error: string | null; cancellable: boolean;
  /** Muster runs open their chat. */
  chatId?: string;
}
export type InboxKind = 'review' | 'blocked' | 'approval' | 'question' | 'failed_run' | 'agent_error' | 'mention' | 'mail' | 'budget' | 'other';
/** `group` is the project it belongs to (the Inbox groups by it); `source` says whether it came from Paperclip or Muster. */
/** `chatIds`: a Muster task's run chats. The Inbox lists and counts the task, not those chats again. */
export interface WorkspaceInboxItem { id: string; kind: InboxKind; title: string; why: string; severity: 'high' | 'medium' | 'low'; at: string; taskId: string | null; agentId: string | null; runId: string | null; group?: string; source?: WorkspaceSource; projectId?: string | null; chatIds?: string[] }
export interface WorkspaceGoal { id: string; title: string; status: string; level: string | null }
export type LiveChannel = 'socket' | 'poll' | 'events' | 'off';
/** The linked Paperclip as the snapshot saw it. `stale`: the last read failed and its rows are the last good copy. */
export interface PaperclipLink { origin: string; company: WorkspaceCompany | null; companies: WorkspaceCompany[]; live: LiveChannel; stale?: string }
export interface WorkspaceSnapshot {
  paperclip: PaperclipLink | null;
  tasks: WorkspaceTask[]; agents: WorkspaceAgent[]; projects: WorkspaceProject[]; goals: WorkspaceGoal[];
  runs: WorkspaceRun[]; inbox: WorkspaceInboxItem[];
  counts: { liveRuns: number; inbox: number; failedRuns: number; openTasks: number };
  fetchedAt: string;
}
/** `runId`: the agent turn that wrote it, so the thread can show that turn's Receipt under the message. */
export interface WorkspaceComment { id: string; author: { kind: 'agent' | 'user' | 'system'; id: string | null; label: string }; body: string; createdAt: string; runId?: string | null }

/** One agent turn in the Ledger. Muster entries are hash-chained (`prevHash` → `hash`); Paperclip runs carry Paperclip's own usage and no chain. */
export interface LedgerFile { path: string; status: 'added' | 'modified' | 'deleted'; before: string | null; after: string | null; added: number | null; removed: number | null }
export interface LedgerEntry {
  id: string; seq: number | null; source: WorkspaceSource; chatId: string | null; runId: string; taskId: string | null; projectId: string | null;
  trigger: string; agent: string; provider: string | null; model: string | null;
  tokens: { input: number; cached: number; output: number; reasoning: number } | null; costUsd: number | null;
  tools: { name: string; count: number }[]; approvals: number;
  /** Shell commands that ran tests (npm test, pytest, go test…). */
  tests: number;
  /** Null when the folder has no review baseline (not a Git repository) or the files could not be read. */
  files: LedgerFile[] | null;
  startedAt: string | null; endedAt: string; durationMs: number | null; outcome: string;
  prevHash: string | null; hash: string | null;
}
export interface LedgerView { entries: LedgerEntry[]; chain: { ok: boolean; entries: number; head: string; brokenAt: number | null } }
/** System cards in a task thread, between agent turns. */
export type ThreadCard =
  | { kind: 'delegated'; id: string; at: string; from: string | null; to: string | null; taskId: string; key: string; title: string; brief: string }
  /** `memory`: the Muster notes carried to the next agent with the work. */
  | { kind: 'handoff'; id: string; at: string; from: string | null; to: string | null; summary: string; memory: { text: string; source: string }[] }
  | { kind: 'needs'; id: string; at: string; from: string | null; prompt: string; detail: string | null; status: 'pending' | 'resolved' | 'cancelled'; resolution: string | null;
      /** Answerable here when set: a Paperclip confirmation, accepted or rejected in place. */ interactionId: string | null; acceptLabel: string | null; rejectLabel: string | null }
  | { kind: 'approval'; id: string; at: string; title: string; status: string };
export interface WorkspaceTaskDetail {
  task: WorkspaceTask; description: string; comments: WorkspaceComment[]; runs: WorkspaceRun[];
  /** Who the composer addresses; null when nobody can receive a message (a task you own with no agent). */
  addressee: { id: string; label: string } | null;
  /** The composer's reason when it is disabled, or a hint under it. */
  composerNote: string | null;
  subtasks: string[]; blocking: string[];
  /** Per-turn Receipts for this task's runs, newest first. */
  receipts: LedgerEntry[];
  cards: ThreadCard[];
  /** Everyone the composer can @-mention. */
  mentionable: { id: string; name: string }[];
}
export interface WorkspaceMemory {
  /** Which bank the recall reads and why it was chosen. */
  scope: { kind: 'repository' | 'project' | 'personal'; label: string; folderId: string | null };
  repo: string | null; query: string; records: MemoryRecord[]; engine: MemoryConnection; note: string;
}
export type WorkspaceListKind = 'artifacts' | 'audit' | 'routines';
export interface WorkspaceRow {
  id: string; title: string; detail: string; status: string | null; at: string | null; source: WorkspaceSource; projectId?: string | null;
  /** Routines, mapped onto the automation model: next occurrence, last run outcome, overlap and catch-up policy. */
  nextRunAt?: string | null; lastRun?: { status: string; at: string | null } | null; overlap?: 'skip' | 'queue'; catchUp?: 'one' | 'none'; paused?: boolean;
}
export interface WorkspaceList { kind: WorkspaceListKind; rows: WorkspaceRow[]; note: string }
/** The sidebar Inbox badge: needs-you and problem items only (mail and reviews never badge). */
/** `chatIds`: run chats already counted in `inbox` through their task, so the sidebar does not count them twice. */
export interface WorkspaceBadge { connected: boolean; inbox: number; liveRuns: number; mail: number; chatIds: string[] }
/** What an import made or updated. Re-running updates the same rows (each is recorded as imported from Paperclip <id>). */
export interface PaperclipImportReport {
  company: string; projects: { created: number; updated: number }; tasks: { created: number; updated: number; skipped: number };
  comments: number; agents: number; history: number; needsYou: number; notes: string[];
}
export interface TaskCreateInput { title: string; description: string; projectId: string | null; assigneeId: string | null }

export interface PaperclipCommands {
  'paperclip.config.get': { input: Record<string, never>; output: PaperclipConfigView };
  'paperclip.config.set': { input: PaperclipConfigInput; output: PaperclipConfigView };
  /** Tries a connection without saving it. Omitted fields fall back to the saved config (and saved token). */
  'paperclip.test': { input: { mode?: PaperclipMode; baseUrl?: string; token?: string }; output: PaperclipTestResult };
  /** Muster's projects, tasks, agents, runs and needs-you items, plus the linked Paperclip's (ETag-revalidated), in one read. */
  'paperclip.snapshot': { input: { refresh?: boolean }; output: WorkspaceSnapshot };
  'paperclip.task': { input: { id: string }; output: WorkspaceTaskDetail };
  'paperclip.comment': { input: { taskId: string; body: string }; output: WorkspaceComment };
  'paperclip.task.update': { input: { taskId: string; status: WorkspaceStatus }; output: WorkspaceTask };
  'paperclip.task.create': { input: TaskCreateInput; output: WorkspaceTask };
  'paperclip.agent.pause': { input: { id: string }; output: { ok: true } };
  'paperclip.agent.resume': { input: { id: string }; output: { ok: true } };
  /** Pauses every Paperclip agent or every Muster project scheduler. Returns how many changed. */
  'paperclip.pauseAll': { input: { source: WorkspaceSource }; output: { changed: number } };
  'paperclip.resumeAll': { input: { source: WorkspaceSource }; output: { changed: number } };
  'paperclip.run.cancel': { input: { id: string }; output: { ok: true } };
  /** What memory would be recalled for a task: its repository's bank (matched by git remote), else its project's, else personal. Read-only. */
  'paperclip.memory': { input: { taskId: string }; output: WorkspaceMemory };
  'paperclip.list': { input: { kind: WorkspaceListKind }; output: WorkspaceList };
  /** A Muster screen showing workspace data is visible (true) or not (false). Paperclip polling (the socket's fallback) runs only while one is. */
  'paperclip.watch': { input: { visible: boolean }; output: { live: LiveChannel } };
  'paperclip.badge': { input: Record<string, never>; output: WorkspaceBadge };
  /** The Ledger: Muster's hash-chained turn entries (verified on read) and the linked Paperclip's runs. */
  'paperclip.ledger': { input: { limit?: number }; output: LedgerView };
  /** Answers a Needs-you card from the thread or the Inbox (Paperclip confirmations: accept, or reject with a reason). */
  'paperclip.interaction.respond': { input: { taskId: string; interactionId: string; accept: boolean; reason?: string }; output: { ok: true } };
  /** Copies a Paperclip company into Muster's Projects with GET requests only. Idempotent. Nothing starts running. */
  'paperclip.import': { input: { mode?: PaperclipMode; baseUrl?: string; token?: string; companyId?: string }; output: PaperclipImportReport };
  /** Starts a Muster task's first run on its Roster agent's runner, in a new worktree of the project's folder (never the checkout itself). */
  'paperclip.task.start': { input: { taskId: string }; output: { chatId: string; runId: string; worktree: string; branch: string } };
}
/** Coalesced: at most one per second while watched (every 5 s otherwise, for the badge). `taskIds` lets an open thread refetch only when it changed. */
export type PaperclipEvent = { type: 'projectsWorkspaceChanged'; scopes: ('tasks' | 'runs' | 'agents' | 'inbox' | 'config')[]; taskIds: string[] };
export const PAPERCLIP_COMMANDS = {
  'paperclip.config.get': true, 'paperclip.config.set': true, 'paperclip.test': true, 'paperclip.snapshot': true, 'paperclip.task': true,
  'paperclip.comment': true, 'paperclip.task.update': true, 'paperclip.task.create': true, 'paperclip.agent.pause': true, 'paperclip.agent.resume': true,
  'paperclip.pauseAll': true, 'paperclip.resumeAll': true, 'paperclip.run.cancel': true, 'paperclip.memory': true, 'paperclip.list': true,
  'paperclip.watch': true, 'paperclip.badge': true, 'paperclip.ledger': true, 'paperclip.interaction.respond': true, 'paperclip.import': true, 'paperclip.task.start': true,
} as const satisfies Record<keyof PaperclipCommands, true>;

export const OPEN_STATUSES: readonly WorkspaceStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked'];
