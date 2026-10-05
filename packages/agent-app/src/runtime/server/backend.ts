/**
 * The virtual layer under "Muster Server" (#unify). The Inbox, Projects, Roster, Ledger, approvals, link and import all consume
 * ONE interface, `ServerBackend`, and never learn which server is behind it. Two implementations:
 * - `PaperclipBackend` wraps the Paperclip REST client and mappers (a Paperclip instance is a supported, "Paperclip-compatible" backend).
 * - `MusterServerBackend` speaks packages/server's `/rpc` plus its `/events` WebSocket.
 * The backend is detected from the URL (`detect.ts`), so a person only ever says "Muster Server".
 *
 * Rows a backend returns are already normalised to the shared workspace shapes and tagged `source: 'paperclip'` (the wire name of "the
 * linked server"; code identifiers keep the old word, nothing the person reads does).
 */
import type {
  ApprovalDecision, LedgerEntry, TaskCreateInput, TaskStartResult, WorkspaceAgent, WorkspaceApproval, WorkspaceComment, WorkspaceCompany, WorkspaceGoal, WorkspaceInboxItem,
  WorkspaceListKind, WorkspacePriority, WorkspaceProject, WorkspaceRow, WorkspaceRun, WorkspaceStatus, WorkspaceTask, WorkspaceTaskDetail, PaperclipAnswer,
} from '../../shared/domains/paperclip-protocol.ts';
import type { ServerBackendKind } from '../../shared/domains/paperclip-protocol.ts';
import type { FetchLike, LiveSocket, SocketFactory } from '../paperclip-client.ts';

export type { ServerBackendKind } from '../../shared/domains/paperclip-protocol.ts';
export type Json = Record<string, unknown>;
export interface ServerEndpoint { baseUrl: string; token?: string }
/** What one read of the server returns: the linked server's slice of the workspace snapshot. */
export interface ServerPart { tasks: WorkspaceTask[]; agents: WorkspaceAgent[]; projects: WorkspaceProject[]; runs: WorkspaceRun[]; inbox: WorkspaceInboxItem[]; goals: WorkspaceGoal[]; approvals: WorkspaceApproval[]; labels: { id: string; name: string; color: string | null }[] }
export interface ServerHealth { version?: string; deploymentMode?: string; /** One line for the connection details, e.g. "Paperclip-compatible". Never shown anywhere else. */ compatibility: string | null }
/** Read-only access in the shape the importer was built on (Paperclip's REST reads). A Muster Server answers it from its own data. */
export interface ImportReader {
  get(path: string): Promise<unknown>;
  issuePages(companyId: string, query: string): AsyncIterable<Json[]>;
  commentPages(issueId: string): AsyncIterable<Json[]>;
}
export interface LiveHandlers { onOpen(): void; onEvent(type: string, payload: Record<string, unknown>): void; onDown(): void }
export interface TaskDetailContext {
  agents: ReadonlyMap<string, WorkspaceAgent>; part: ServerPart | undefined;
  /** Notes to carry with a hand-off between agents (the desktop's own memory). */
  memory(taskId: string): Promise<{ text: string; source: string }[]>;
}
export interface TaskChanges { status?: WorkspaceStatus; priority?: WorkspacePriority; assigneeAgentId?: string | null }

export interface ServerBackend {
  readonly kind: ServerBackendKind;
  readonly endpoint: ServerEndpoint;
  /** Bumped whenever a read returned something new, so callers can skip rebuilding views. */
  readonly generation: number;
  /** Forget cached reads (a live event said something changed, so the next read cannot be served stale). */
  invalidate(prefix?: string): void;
  health(): Promise<ServerHealth>;
  /** The orgs (companies) this server serves. */
  companies(): Promise<WorkspaceCompany[]>;
  /** The org's tasks, agents, projects, runs, Inbox, approvals. `previous` lets a backend hand back the same part when nothing changed. */
  read(company: WorkspaceCompany, previous?: { generation: number; companyId: string; part: ServerPart }, options?: { fresh?: boolean }): Promise<ServerPart>;
  taskDetail(taskId: string, context: TaskDetailContext): Promise<WorkspaceTaskDetail>;
  comment(taskId: string, body: string, agents: ReadonlyMap<string, WorkspaceAgent>): Promise<WorkspaceComment>;
  updateTask(taskId: string, changes: TaskChanges, agents: ReadonlyMap<string, WorkspaceAgent>): Promise<WorkspaceTask>;
  createTask(input: TaskCreateInput, company: WorkspaceCompany, agents: ReadonlyMap<string, WorkspaceAgent>): Promise<WorkspaceTask>;
  pauseAgent(id: string): Promise<void>;
  resumeAgent(id: string): Promise<void>;
  cancelRun(id: string): Promise<void>;
  decideApproval(id: string, decision: ApprovalDecision, note: string | null): Promise<void>;
  respond(taskId: string, interactionId: string, input: { accept: boolean; reason?: string; answers?: PaperclipAnswer[] }): Promise<void>;
  /** Starts a task's first run on the server (a Muster Server runs its own agents; a Paperclip server's tasks start there). */
  startTask?(taskId: string): Promise<TaskStartResult>;
  receipts(company: WorkspaceCompany, limit: number, agents: ReadonlyMap<string, WorkspaceAgent>): Promise<LedgerEntry[]>;
  /** Run receipts, recent activity and budgets for the Dashboard. */
  dashboard(company: WorkspaceCompany, agents: ReadonlyMap<string, WorkspaceAgent>): Promise<{ receipts: LedgerEntry[]; activity: WorkspaceRow[]; budgets?: unknown }>;
  rows(kind: WorkspaceListKind, company: WorkspaceCompany): Promise<WorkspaceRow[]>;
  /** One run by id, with its tool use read from the server. `null`: the server has no such run. Optional: a backend that cannot read a single run leaves it out. */
  runDetail?(runId: string, agents: ReadonlyMap<string, WorkspaceAgent>): Promise<{ run: WorkspaceRun; receipt: LedgerEntry } | null>;
  /** The server's own web page for a run or a task ("Open in server"), or null when it has no such page. */
  linkFor?(company: WorkspaceCompany, target: { runId?: string; agentId?: string | null; taskKey?: string }): string | null;
  importReader(): ImportReader;
  openLive(company: WorkspaceCompany, handlers: LiveHandlers, factory?: SocketFactory): LiveSocket;
}

export interface BackendOptions {
  fetch?: FetchLike; cache?: boolean; orgName?: string;
  /** A 401: returns the sentence to show instead of the generic one (a sign-in key the server revoked). */
  onUnauthorized?: (hadToken: boolean, status: number) => string | undefined;
  /** A hosted server's browser session (a Cookie, bound to `origin`): what its live socket accepts. */
  session?: { cookie: string; origin: string };
}
