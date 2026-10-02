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
import type { TimelineItem } from '../protocol.ts';
import type { Interaction, Suggestion } from './agent-tools-protocol.ts';
import type { ExecutionPolicy, RunMeta, SecretProposal, TaskMonitor, TaskStageState, Watchdog } from './project-governance-protocol.ts';
import type { TaskLabel, TaskPrSummary } from './work-protocol.ts';

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
  /** A heads-up that does not stop the test: a token that would travel over plain http to another machine. */
  warning?: string;
}

export type WorkspaceStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled';
export const WORKSPACE_STATUSES: readonly WorkspaceStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'];
export const STATUS_LABEL: Record<WorkspaceStatus, string> = { backlog: 'Backlog', todo: 'Todo', in_progress: 'In Progress', in_review: 'In Review', blocked: 'Blocked', done: 'Done', cancelled: 'Cancelled' };
export type WorkspacePriority = 'critical' | 'high' | 'medium' | 'low';
export const WORKSPACE_PRIORITIES: readonly WorkspacePriority[] = ['critical', 'high', 'medium', 'low'];
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
  /** Hidden from lists (Hide task). Open it by key or from its parent. */
  hidden?: boolean;
  /** Under an active hold (paused or cancelled with its parent). */
  held?: boolean;
  /** Labels: Muster's own (with an id) or Paperclip's (name and colour), and the state of pull requests linked to a Muster task. */
  labels?: { id?: string; name: string; color: string | null }[];
  pr?: TaskPrSummary | null;
  /** An imported task whose issue no longer exists in Paperclip (cancelled here, kept for the record). */
  removedInPaperclip?: boolean;
}
export type AgentState = 'active' | 'idle' | 'running' | 'paused' | 'error' | 'pending' | 'terminated';
export interface WorkspaceAgent {
  id: string; name: string; role: string; title: string | null; model: string | null; adapter: string | null; source: WorkspaceSource;
  status: AgentState; reportsTo: string | null; lastActiveAt: string | null; error: string | null;
  /** What the agent is for, in a sentence or two (Paperclip `capabilities`, a Muster project's goal). */
  capabilities: string | null;
  /** Muster agents pause through their Project's scheduler; Paperclip agents pause one by one. */
  pausable: boolean;
  /** A Muster Roster member: the project it belongs to, its member id, runner and instructions. */
  projectId?: string | null; memberId?: string | null; runner?: { providerId: string; model: string } | null; instructions?: string;
  /** Star and hide (G35): Roster lists put starred agents first and fold hidden ones away. */
  starred?: boolean; hidden?: boolean;
}
export interface WorkspaceProject {
  id: string; name: string; status: string; description: string; source: WorkspaceSource;
  /** Normalised git remote (`github.com/org/repo`) when the project names one. Memory recall keys on it. */
  repo: string | null; cwd: string | null; taskCount: number; openCount: number; paused: boolean;
  /** The Muster memory bank this project's work recalls from (matched by repository), and how many notes it holds. */
  memory: { label: string; count: number } | null;
  /** The target date (`YYYY-MM-DD`) of a Muster project, and whether it is starred or hidden in lists (Wave 2). */
  targetDate?: string | null; starred?: boolean; hidden?: boolean;
  /** The Paperclip org (company) this project belongs to: a linked Paperclip project, or one imported from it. Muster-made projects have none. */
  org?: string | null;
  /** An imported project whose name or goal you changed here: a later import keeps your version. */
  editedHere?: boolean;
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
export interface WorkspaceInboxItem { id: string; kind: InboxKind; /** A Paperclip approval this row stands for: decided from the row. */ approvalId?: string; approvalVerbs?: ApprovalDecision[]; title: string; why: string; severity: 'high' | 'medium' | 'low'; at: string; taskId: string | null; agentId: string | null; runId: string | null; group?: string; source?: WorkspaceSource; projectId?: string | null; chatIds?: string[] }
export interface WorkspaceGoal { id: string; title: string; status: string; level: string | null; parentId?: string | null; ownerAgentId?: string | null }
/** A Paperclip approval waiting on the board (a hire, a CEO strategy, a budget override, a board request). Decided only by you. */
export interface WorkspaceApproval {
  id: string; type: string; status: 'pending' | 'revision_requested'; title: string; detail: string;
  requestedBy: string | null; agentId: string | null; issueIds: string[]; at: string;
  /** The decisions Paperclip offers for it. */
  verbs: ApprovalDecision[];
}
export type ApprovalDecision = 'approve' | 'reject' | 'request_revision';
export type LiveChannel = 'socket' | 'poll' | 'events' | 'off';
/** The linked Paperclip as the snapshot saw it. `stale`: the last read failed; `cached` then says whether its rows are the
 *  last good copy (true) or missing because nothing was read yet (false). */
export interface PaperclipLink { origin: string; company: WorkspaceCompany | null; companies: WorkspaceCompany[]; live: LiveChannel; stale?: string; cached?: boolean }
export interface WorkspaceSnapshot {
  paperclip: PaperclipLink | null;
  tasks: WorkspaceTask[]; agents: WorkspaceAgent[]; projects: WorkspaceProject[]; goals: WorkspaceGoal[];
  runs: WorkspaceRun[]; inbox: WorkspaceInboxItem[];
  /** The linked Paperclip's pending approvals, and its labels (for New task). */
  approvals?: WorkspaceApproval[];
  /** The whole linked company's agents, whatever slice of them a page shows: what a company-wide Pause would stop, and what is paused. */
  agentCounts?: { active: number; paused: number; /** What Resume can wake: only what Muster's Pause stopped. */ resumable: { paperclip: number; local: number; projects: Record<string, number> } };
  labels?: { id: string; name: string; color: string | null }[];
  counts: { liveRuns: number; inbox: number; failedRuns: number; openTasks: number };
  fetchedAt: string;
}
/** `runId`: the agent turn that wrote it, so the thread can show that turn's Receipt under the message. */
export interface WorkspaceComment { id: string; author: { kind: 'agent' | 'user' | 'system'; id: string | null; label: string }; body: string; createdAt: string; runId?: string | null }

/** One agent turn in the Ledger. Muster entries are hash-chained (`prevHash` → `hash`); Paperclip runs carry Paperclip's own usage and no chain.
 *  `history` entries are imported history (#190): turns that ran before the Ledger existed, rebuilt from saved chats and
 *  imported Paperclip activity. They are never part of the chain (no seq, no hash), so `verify()` covers live receipts only. */
export type LedgerSource = WorkspaceSource | 'history';
export interface LedgerFile { path: string; status: 'added' | 'modified' | 'deleted'; before: string | null; after: string | null; added: number | null; removed: number | null }
export interface LedgerEntry {
  id: string; seq: number | null; source: LedgerSource; chatId: string | null; runId: string; taskId: string | null; projectId: string | null;
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
      /** Answerable here when set: a Paperclip confirmation, accepted or rejected in place. */ interactionId: string | null; acceptLabel: string | null; rejectLabel: string | null;
      /** A Muster run waiting on you: its chat, and the pending question or approval item there, answered in place
       *  (question.respond / approval.respond) so the waiting run continues. */
      chatId?: string | null; pending?: TimelineItem | null;
      /** A Paperclip ask_user_questions interaction: its questions, answered in place through Paperclip's respond endpoint. */
      questions?: PaperclipQuestion[]; submitLabel?: string | null }
  /** `approvalId`: set while it is pending in the linked Paperclip, so Approve / Reject / Request revision act on it. */
  | { kind: 'approval'; id: string; at: string; title: string; status: string; approvalId?: string; detail?: string; requestedBy?: string | null; verbs?: ApprovalDecision[] }
  /** A Paperclip task document (a plan is the document with key `plan`): its latest body and revision history. */
  | { kind: 'document'; id: string; at: string; key: string; title: string; format: string; body: string; revision: number; revisions: { number: number; summary: string; at: string; by: string | null }[] }
  /** A pull request, branch or artifact an agent produced for the task. */
  | { kind: 'workproduct'; id: string; at: string; type: string; title: string; status: string; provider: string | null; url: string | null; summary: string }
  /** A review or approval stage of the task's execution policy (C16): who decides, the history, and the controls when it is you. */
  | { kind: 'stage'; id: string; at: string; stage: TaskStageState }
  /** A question or confirmation card an agent raised with its tools (G6); answered in the thread. */
  | { kind: 'ask'; id: string; at: string; interaction: Interaction }
  /** Subtasks an agent proposed but may not create (C7). */
  | { kind: 'suggestion'; id: string; at: string; suggestion: Suggestion }
  /** An agent asking for a secret by name (G23). You enter the value in the card; the agent never sees it. */
  | { kind: 'secret'; id: string; at: string; proposal: SecretProposal; secureStorage: boolean };
/** One question of a Paperclip ask_user_questions interaction. */
export interface PaperclipQuestion { id: string; prompt: string; helpText: string | null; multi: boolean; allowOther: boolean; options: { id: string; label: string; description: string | null }[] }
/** An answer for Paperclip's `/interactions/:id/respond`. */
export interface PaperclipAnswer { questionId: string; optionIds: string[]; otherText?: string | null }
/** A Muster task's governance: execution policy and stage, hold, hiding, why its runs started, follow-up check, stopped-subtree finding. */
export interface TaskGovernanceView {
  stage: TaskStageState | null; policy: ExecutionPolicy | null; effectivePolicy: ExecutionPolicy | null;
  hold: { id: string; mode: 'pause' | 'cancel'; rootKey: string; rootTitle: string; reason: string } | null;
  hidden: boolean; runs: RunMeta[]; monitor: TaskMonitor | null; watchdog: Watchdog | null;
  /** Agents that can review (active Roster agents). */
  agents: { memberId: string; name: string }[];
}
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
  governance?: TaskGovernanceView;
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
  /** Outputs: the file path, the task it came from and the agent that made it, when known (Wave 2). */
  path?: string; taskId?: string | null; agent?: string | null;
}
export interface WorkspaceList { kind: WorkspaceListKind; rows: WorkspaceRow[]; note: string }
/** The sidebar Inbox badge: needs-you and problem items only (mail and reviews never badge). */
/** `chatIds`: run chats already counted in `inbox` through their task, so the sidebar does not count them twice. */
export interface WorkspaceBadge {
  connected: boolean; inbox: number; liveRuns: number; mail: number; chatIds: string[];
  /** The linked company's name, and the org of each project an import made (Muster project id to org): the sidebar groups by these without reading the whole workspace. */
  company?: string | null; orgs?: Record<string, string>;
}
/** What an import made or updated. Re-running updates the same rows (each is recorded as imported from Paperclip <id>). */
export interface PaperclipImportReport {
  company: string; projects: { created: number; updated: number }; tasks: { created: number; updated: number; skipped: number };
  comments: number; agents: number; history: number; needsYou: number; notes: string[];
  /** Imported tasks whose issue was deleted in Paperclip: cancelled here and flagged "Removed in Paperclip". */
  removed: number;
  /** Fields you changed in Muster since the last import: kept, with what Paperclip says now. */
  conflicts: ImportConflict[];
  /** Issues with no project in Paperclip: they have nowhere to go in Muster and are not imported. */
  noProject: number;
  /** How long the import took and how many issues it read. */
  tookMs: number; issues: number;
}
export interface ImportConflict { scope: 'project' | 'task'; label: string; field: string; kept: string; paperclip: string }
/** `start`: Assign & start — the owner's first run starts at once, in a new worktree of the project's folder. */
export interface TaskCreateInput {
  title: string; description: string; projectId: string | null; assigneeId: string | null; priority?: WorkspacePriority; parentId?: string | null; start?: boolean;
  /** Paperclip projects only: labels (ids from the snapshot's `labels`), a goal, and tasks that block this one. */
  labelIds?: string[]; goalId?: string | null; blockedByIds?: string[];
}
export interface TaskStartResult { chatId: string; runId: string; worktree: string; branch: string }

/** The Dashboard (#132): aggregated in SQL over the Ledger (live receipts + imported history) and project tasks and runs,
 *  plus the linked Paperclip's runs when there is one. `spend.usd` is null when nothing was priced (never a fake $0). */
export interface DashboardDay { day: string; succeeded: number; failed: number; other: number }
export interface DashboardData {
  days: string[];
  runs: DashboardDay[];
  tasksByDay: { day: string; counts: Partial<Record<WorkspaceStatus, number>> }[];
  /** `tokens`: input + output tokens this month, priced or not (a token budget works without prices). */
  spend: { usd: number | null; pricedTurns: number; unpricedTurns: number; since: string; source: string; tokens: number };
  activity: { id: string; actor: string; summary: string; at: string; projectId: string | null; projectName: string | null; source: WorkspaceSource; refId: string | null }[];
  /** The linked Paperclip's budget policies (company, project, agent) with this month's utilisation, and open incidents. */
  budgets?: { policies: PaperclipBudgetPolicy[]; incidents: number; company: string };
  generatedAt: string;
}
/** A Paperclip budget policy. `status` is Paperclip's own (ok, warning, hard_stop). Amounts are US dollars. */
export interface PaperclipBudgetPolicy { id: string; scope: 'company' | 'project' | 'agent'; scopeId: string; name: string; limitUsd: number; observedUsd: number; percent: number; warnPercent: number; hardStop: boolean; status: string; paused: boolean }

/** Import planning: each Paperclip project with the Muster project it would fill. `suggestion` matches by an earlier
 *  import, the same folder, the same repository remote, or the same name. */
export interface ImportPlanProject {
  id: string; name: string; repo: string | null; localFolder: string | null; taskCount: number;
  /** `new`: becomes its own Paperclip project in Muster. `imported`: an earlier import's project, updated in place.
   *  `detached`: an earlier import filled one of your own projects: that project is left alone and this one is imported separately.
   *  `ask`: an earlier import's project cannot be told from one of yours by its records: you say which (see `owners`). */
  existing: 'new' | 'imported' | 'detached' | 'ask';
  /** For `ask`: what you have added to the older project since (tasks, Roster members, chats): a hint that it is yours. */
  added?: { tasks: number; members: number; chats: number };
}
/** `local`: Paperclip runs on this Mac, so its folders are linked; a remote server's paths are never touched. */
export interface ImportPlan { company: { id: string; name: string } | null; companies: WorkspaceCompany[]; projects: ImportPlanProject[]; local: boolean }
/** Per Paperclip project: 'skip' leaves it out of the import. Imports never write into a project you made in Muster. */
export type ImportTargets = Record<string, 'skip' | 'import'>;

export interface PaperclipCommands {
  'paperclip.config.get': { input: Record<string, never>; output: PaperclipConfigView };
  'paperclip.config.set': { input: PaperclipConfigInput; output: PaperclipConfigView };
  /** Tries a connection without saving it. Omitted fields fall back to the saved config (and saved token). */
  'paperclip.test': { input: { mode?: PaperclipMode; baseUrl?: string; token?: string }; output: PaperclipTestResult };
  /** Muster's projects, tasks, agents, runs and needs-you items, plus the linked Paperclip's (ETag-revalidated), in one read. */
  'paperclip.snapshot': { input: { refresh?: boolean }; output: WorkspaceSnapshot };
  'paperclip.task': { input: { id: string }; output: WorkspaceTaskDetail };
  'paperclip.comment': { input: { taskId: string; body: string }; output: WorkspaceComment };
  /** Only the fields you pass are changed. `assigneeId`: an agent id, or null to unassign (Paperclip tasks only for priority and assignee). */
  'paperclip.task.update': { input: { taskId: string; status?: WorkspaceStatus; priority?: WorkspacePriority; assigneeId?: string | null }; output: WorkspaceTask };
  'paperclip.task.create': { input: TaskCreateInput; output: WorkspaceTask & { started?: TaskStartResult; startError?: string } };
  /** `projectId`: one project's runs and spend (the Budget tab). */
  'paperclip.dashboard': { input: { utcOffsetMinutes?: number; projectId?: string }; output: DashboardData };
  /** What an import would fill: Paperclip projects and suggested Muster matches. GET only; changes nothing. */
  'paperclip.import.plan': { input: { mode?: PaperclipMode; baseUrl?: string; token?: string; companyId?: string }; output: ImportPlan };
  'paperclip.agent.pause': { input: { id: string }; output: { ok: true } };
  'paperclip.agent.resume': { input: { id: string }; output: { ok: true } };
  /** Pauses every Paperclip agent or every Muster project scheduler. Returns how many changed. */
  /** `projectId` (Muster only): just that project's Roster members. Paperclip's agents belong to the company, so its Pause is always company-wide. */
  'paperclip.pauseAll': { input: { source: WorkspaceSource; projectId?: string }; output: { changed: number } };
  /** Wakes only what Pause paused (company-wide or for that project), never an agent that was paused on purpose or is waiting for approval. */
  'paperclip.resumeAll': { input: { source: WorkspaceSource; projectId?: string }; output: { changed: number } };
  'paperclip.run.cancel': { input: { id: string }; output: { ok: true } };
  /** Decides a Paperclip approval (approve, reject, request revision) with an optional note. Only ever sent when you press the button. */
  'paperclip.approval.decide': { input: { id: string; decision: ApprovalDecision; note?: string }; output: { ok: true } };
  /** What memory would be recalled for a task: its repository's bank (matched by git remote), else its project's, else personal. Read-only. */
  'paperclip.memory': { input: { taskId: string }; output: WorkspaceMemory };
  'paperclip.list': { input: { kind: WorkspaceListKind }; output: WorkspaceList };
  /** A Muster screen showing workspace data is visible (true) or not (false). Paperclip polling (the socket's fallback) runs only while one is. */
  'paperclip.watch': { input: { visible: boolean }; output: { live: LiveChannel } };
  'paperclip.badge': { input: Record<string, never>; output: WorkspaceBadge };
  /** The Ledger: Muster's hash-chained turn entries (verified on read) and the linked Paperclip's runs. */
  'paperclip.ledger': { input: { limit?: number }; output: LedgerView };
  /** Imports past turns into the Ledger as imported history (once per chat; running it again adds nothing). Also runs on its own, in the background, after startup. */
  'paperclip.ledger.backfill': { input: Record<string, never>; output: { chats: number; turns: number } };
  /** Inbox Dismiss: hides one item until it changes (`at` is the item's time, so a new failure shows again). The chat or task itself is kept. */
  'paperclip.inbox.dismiss': { input: { id: string; at: string }; output: { ok: true } };
  'paperclip.inbox.dismissed': { input: Record<string, never>; output: { items: { id: string; at: string }[] } };
  /** Brings a dismissed item back (the undo of Dismiss). */
  'paperclip.inbox.restore': { input: { id: string }; output: { ok: true } };
  /** Answers a Needs-you card from the thread or the Inbox (Paperclip confirmations: accept, or reject with a reason;
   *  questions: `answers`, sent to Paperclip's respond endpoint). Only ever sent when you answer. */
  'paperclip.interaction.respond': { input: { taskId: string; interactionId: string; accept: boolean; reason?: string; answers?: PaperclipAnswer[] }; output: { ok: true } };
  /** Copies a Paperclip company into Muster's Projects with GET requests only. Idempotent. Nothing starts running. */
  /** `owners`: for a project the plan marked `ask`, whether it is `mine` (left alone) or `made` by the earlier import (updated). An unanswered one is skipped, never guessed. */
  'paperclip.import': { input: { mode?: PaperclipMode; baseUrl?: string; token?: string; companyId?: string; targets?: ImportTargets; owners?: Record<string, 'mine' | 'made'> }; output: PaperclipImportReport };
  /** Starts a Muster task's first run on its Roster agent's runner, in a new worktree of the project's folder (never the checkout itself). */
  'paperclip.task.start': { input: { taskId: string }; output: TaskStartResult };
}
/** Coalesced: at most one per second while watched (every 5 s otherwise, for the badge). `taskIds` lets an open thread refetch only when it changed. */
export type PaperclipEvent = { type: 'projectsWorkspaceChanged'; scopes: ('tasks' | 'runs' | 'agents' | 'inbox' | 'config')[]; taskIds: string[] };
export const PAPERCLIP_COMMANDS = {
  'paperclip.config.get': true, 'paperclip.config.set': true, 'paperclip.test': true, 'paperclip.snapshot': true, 'paperclip.task': true,
  'paperclip.comment': true, 'paperclip.task.update': true, 'paperclip.task.create': true, 'paperclip.agent.pause': true, 'paperclip.agent.resume': true,
  'paperclip.pauseAll': true, 'paperclip.resumeAll': true, 'paperclip.approval.decide': true, 'paperclip.run.cancel': true, 'paperclip.memory': true, 'paperclip.list': true,
  'paperclip.watch': true, 'paperclip.badge': true, 'paperclip.ledger': true, 'paperclip.ledger.backfill': true, 'paperclip.inbox.dismiss': true, 'paperclip.inbox.dismissed': true, 'paperclip.inbox.restore': true, 'paperclip.interaction.respond': true, 'paperclip.import': true, 'paperclip.task.start': true, 'paperclip.dashboard': true, 'paperclip.import.plan': true,
} as const satisfies Record<keyof PaperclipCommands, true>;

/** How much of a monthly budget is used: in dollars when the budget and the spend are priced, else in tokens when a
 *  token budget is set (models with no price still count). Null when no budget applies. */
export function budgetUse(budget: { usd: number | null; tokens: number | null }, spend: { usd: number | null; tokens: number }): { unit: 'usd' | 'tokens'; used: number; limit: number; ratio: number } | null {
  if (budget.usd !== null && budget.usd > 0 && spend.usd !== null) return { unit: 'usd', used: spend.usd, limit: budget.usd, ratio: spend.usd / budget.usd };
  if (budget.tokens !== null && budget.tokens > 0) return { unit: 'tokens', used: spend.tokens, limit: budget.tokens, ratio: spend.tokens / budget.tokens };
  return null;
}

export const OPEN_STATUSES: readonly WorkspaceStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked'];
