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
  turnContext?: string }
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
}

export type DomainHandler = (input: Record<string, unknown>) => unknown;
/** SBX-13: sleep/wake, fanned out by the runtime's power coordinator (see power-events.ts). */
export type DomainPowerEvent = { state: 'suspend'; at: number } | { state: 'resume'; at: number; sleptMs: number; suspendedAt: number | null };
export interface DomainModule { handlers: Record<string, DomainHandler>; dispose?(): void | Promise<void>; power?(event: DomainPowerEvent): void | Promise<void> }
export type DomainFactory = (context: DomainContext) => DomainModule;
