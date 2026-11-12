/** The seam later waves build on: each domain gets this context and returns command handlers. */
import type { DatabaseSync } from 'node:sqlite';
import type { AgentEvent, Chat, ChatStatus, Commands, Folder, Project, ProviderInfo } from '../../shared/protocol.ts';
import type { AgentStore } from '../store.ts';
import type { NativeThreadBridge } from '../codex-native.ts';

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export interface PromptContribution { label: string; text: string }
export type PromptContributor = (input: { chat: Chat; folder?: Folder; project?: Project; prompt: string; signal: AbortSignal }) => Promise<PromptContribution | null>;
export interface RunOptions { reasoningEffort?: ReasoningEffort; configOverrides?: Record<string, unknown>; developerInstructions?: string;
  /** Notes for this turn only (a goal's token budget). Sent with the message, so a per-turn change never alters the
   *  developer instructions that key the warm app-server. */
  turnContext?: string;
  /** The domain follows up itself when the run ends after a tool call without a reply (a task run's comment backstop),
   *  so the chat does not also ask the agent to finish. */
  ownsSilentEnd?: boolean }
export type RunOptionsContributor = (chat: Chat) => Promise<RunOptions | null>;
export interface RunStarted { chat: Chat; runId: string; cwd: string }
export interface RunSettled { chat: Chat; runId: string; status: ChatStatus }
/** A raw provider event for a chat's run (token usage, compaction, items). Observers must not throw or block. */
export interface ProviderEventInfo { chat: Chat; method: string; params: Record<string, unknown> }
export interface ChatDefaults { providerId?: string; model?: string; effort?: ReasoningEffort; mode?: Chat['mode']; permissionMode?: Chat['permissionMode'] }
export type ChatDefaultsResolver = (input: { folderId?: string; projectId?: string }) => ChatDefaults | undefined;
/** A domain command that completed without throwing. Observers must not throw or block. */
export interface CommandCompleted { command: string; input: Record<string, unknown>; output: unknown }
/** #654: a chat is about to be deleted (still in the store) or was just archived. */
export interface ChatRemoval { chat: Chat; kind: 'delete' | 'archive' }
/** #147: answers a file or Git command for an `ssh://` folder instead of the local implementation. */
export type RemoteFolderRouter = (command: string, input: Record<string, unknown>, folder: Folder) => Promise<unknown>;
/** #147 phase 2: a chat's run on the SSH host of its folder, prepared before the run starts. */
export interface RemoteAgentRun {
  /** What the provider gets: the host, the folder there and the command that starts the route's CLI there. */
  run: { host: string; root: string; command: string };
  /** The run's Muster tool servers become the relay on the host (per-run token); local-only servers are left out. */
  tools(overrides: Record<string, unknown> | undefined, chatId: string): { overrides: Record<string, unknown>; dropped: string[]; close(): void };
  /** A line for the agent's instructions: where it runs and which of Muster's tools it lacks there. */
  note: string;
  /** How the CLI signs in for this run, for the chat's notice: the host's own login, or the person's key passed by Muster. */
  signIn: string;
  /** A failed run's message in plain words (the CLI's sign-in on the host), or undefined to keep the provider's. */
  failure(message: string): string | undefined;
  /** The connection to the host dropped while the run was going. */
  dropped(): boolean;
  dispose(): void;
}
/** Rejects with a sentence when the route cannot run on the host (an API route, the CLI missing there, the host unreachable). */
export type RemoteAgentResolver = (input: { chat: Chat; folder: Folder; provider: ProviderInfo }) => Promise<RemoteAgentRun>;
export type RunEnvironmentResolver = (chat: Chat, defaultCwd: string) => Promise<{ cwd: string }>;
/** G13: a per-agent tool policy decision for an approval request. null: no rule applies and the usual flow decides. */
export type ToolPolicyResolver = (chat: Chat, method: string, params: Record<string, unknown>) => { effect: 'allow' | 'ask' | 'deny'; message: string } | null;

/** A worktree made for one automated run: its folder (linked to the project) and how to take it back when nothing ran in it. */
export interface AutomatedWorktree { folderId: string; undo(): Promise<void> }
export type AutomatedWorktreeResolver = (projectId: string, taskId: string) => Promise<AutomatedWorktree | null>;
/** The brief of a server task's history for a run of it in `folder` (#434); null for a task that did not come from a server. */
export type TaskHistoryBriefResolver = (input: { projectId: string; taskId: string; folder: { id: string; path: string } | null }) => Promise<string | null>;

/** The add and on hooks return an unsubscribe function; the set hooks replace a single resolver (undefined clears it). */
export interface DomainHooks {
  addPromptContributor(fn: PromptContributor): () => void;
  addRunOptionsContributor(fn: RunOptionsContributor): () => void;
  onRunStarted(fn: (run: RunStarted) => Promise<void> | void): () => void;
  onRunSettled(fn: (run: RunSettled) => Promise<void> | void): () => void;
  onProviderEvent(fn: (event: ProviderEventInfo) => void): () => void;
  setChatDefaults(fn: ChatDefaultsResolver | undefined): void;
  setRunEnvironmentResolver(fn: RunEnvironmentResolver | undefined): void;
  /** #668: the user's own context window for a model (Settings › Models), read by Muster's compaction trigger. */
  setContextWindowResolver?(fn: ((providerId: string, model: string) => number | undefined) | undefined): void;
  /** Replaces the single tool-policy resolver (undefined clears it). Optional so bare test contexts need not provide it. */
  setToolPolicy?(fn: ToolPolicyResolver | undefined): void;
  /** Replaces the resolver of the git identity a Git-tab commit in a folder carries (an agent's task worktree). */
  setCommitIdentity?(fn: ((folderId: string) => { name: string; email: string } | null) | undefined): void;
  /** Records that a folder is the linked worktree Muster made for a task, the only kind of folder a Git-tab commit may carry an agent identity in. */
  setTaskWorktreeRecorder?(fn: ((projectId: string, taskId: string, folderId: string) => void) | undefined): void;
  noteTaskWorktree?(projectId: string, taskId: string, folderId: string): void;
  /** Replaces the single resolver of the worktree an automated run (the scheduler, a wake) of an imported project's task works in (undefined clears it). It resolves to null for a project that is not imported. */
  setAutomatedWorktree?(fn: AutomatedWorktreeResolver | undefined): void;
  /** The worktree an automated run of this task must use, made (or reused) on demand; null when the task may use its project's own folder. Rejects when the worktree cannot be made: the run must not fall back to the checkout. */
  automatedWorktree?(projectId: string, taskId: string): Promise<AutomatedWorktree | null>;
  /** Replaces the single resolver of an imported task's history brief (undefined clears it). */
  setTaskHistoryBrief?(fn: TaskHistoryBriefResolver | undefined): void;
  /** What a run of an imported task is told about the task's history on the server; null when there is none. Never throws. */
  taskHistoryBrief?(input: Parameters<TaskHistoryBriefResolver>[0]): Promise<string | null>;
  /** The identity a commit in this folder carries, or null. Never throws. */
  commitIdentity?(folderId: string): { name: string; email: string } | null;
  /** Observes successful domain commands (e.g. Projects logging memory and environment writes to activity). Optional so bare test contexts need not provide it. */
  onCommand?(fn: (event: CommandCompleted) => void): () => void;
  /** #654: release what a chat owns. On 'delete' a throw keeps the chat (its message is shown); 'archive' never fails the archive. Optional so bare test contexts need not provide it. */
  onChatRemoval?(fn: (event: ChatRemoval) => Promise<void> | void): () => void;
  /** #147: the single handler of file and Git commands for a folder on an SSH host (undefined clears it). */
  setRemoteFolderRouter?(fn: RemoteFolderRouter | undefined): void;
  /** #147 phase 2: prepares a chat's run on its folder's SSH host. */
  setRemoteAgentResolver?(fn: RemoteAgentResolver | undefined): void;
}

export interface DomainContext {
  dataDir: string;
  store: AgentStore;
  db(): DatabaseSync;
  emit(event: AgentEvent): void;
  emitSnapshot(): void;
  folderFor(id: string): Folder;
  invoke<K extends keyof Commands>(command: K, input: Commands[K]['input']): Promise<Commands[K]['output']>;
  hooks: DomainHooks;
  /** Runnable providers (sync, no discovery) and the built-in model new chats fall back to. Absent in bare test contexts. */
  modelCatalog?(): { providers: ProviderInfo[]; builtin: { providerId: string; model: string } };
  /** Settles once the first provider probe has (or a short grace period has passed); instant afterwards. */
  modelCatalogReady?(): Promise<void>;
  /** Settles when every provider check has finished, however long that takes (no grace period). */
  providersSettled?(): Promise<void>;
  /** Codex app-server native thread APIs (goals, queue, projects) behind a capability probe. Absent in bare test contexts. */
  native?: NativeThreadBridge;
  /** #844: whether an MCP app's own tool call may run: the chat's access level, the Project tool rules and, when needed, the
   *  approval card (waits for the answer). Absent in bare test contexts, where only read-only tools run. */
  appToolApproval?(chatId: string, request: { server: string; tool: string; arguments: Record<string, unknown>; readOnly: boolean; app: string }): Promise<{ allowed: true } | { allowed: false; reason: string }>;
}

export type DomainHandler = (input: Record<string, unknown>) => unknown;
/** SBX-13: sleep/wake, fanned out by the runtime's power coordinator (see power-events.ts). */
export type DomainPowerEvent = { state: 'suspend'; at: number } | { state: 'resume'; at: number; sleptMs: number; suspendedAt: number | null };
export interface DomainModule { handlers: Record<string, DomainHandler>; dispose?(): void | Promise<void>; power?(event: DomainPowerEvent): void | Promise<void> }
export type DomainFactory = (context: DomainContext) => DomainModule;
