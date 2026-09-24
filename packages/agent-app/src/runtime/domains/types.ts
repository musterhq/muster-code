/** The seam later waves build on: each domain gets this context and returns command handlers. */
import type { DatabaseSync } from 'node:sqlite';
import type { AgentEvent, Chat, ChatStatus, Commands, Folder, Project, ProviderInfo } from '../../shared/protocol.ts';
import type { AgentStore } from '../store.ts';
import type { NativeThreadBridge } from '../codex-native.ts';

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export interface PromptContribution { label: string; text: string }
export type PromptContributor = (input: { chat: Chat; folder?: Folder; project?: Project; prompt: string; signal: AbortSignal }) => Promise<PromptContribution | null>;
export interface RunOptions { reasoningEffort?: ReasoningEffort; configOverrides?: Record<string, unknown>; developerInstructions?: string }
export type RunOptionsContributor = (chat: Chat) => Promise<RunOptions | null>;
export interface RunStarted { chat: Chat; runId: string; cwd: string }
export interface RunSettled { chat: Chat; runId: string; status: ChatStatus }
/** A raw provider event for a chat's run (token usage, compaction, items). Observers must not throw or block. */
export interface ProviderEventInfo { chat: Chat; method: string; params: Record<string, unknown> }
export interface ChatDefaults { providerId?: string; model?: string; effort?: ReasoningEffort; mode?: Chat['mode']; permissionMode?: Chat['permissionMode'] }
export type ChatDefaultsResolver = (input: { folderId?: string; projectId?: string }) => ChatDefaults | undefined;
/** A domain command that completed without throwing. Observers must not throw or block. */
export interface CommandCompleted { command: string; input: Record<string, unknown>; output: unknown }
export type RunEnvironmentResolver = (chat: Chat, defaultCwd: string) => Promise<{ cwd: string }>;

/** The add and on hooks return an unsubscribe function; the set hooks replace a single resolver (undefined clears it). */
export interface DomainHooks {
  addPromptContributor(fn: PromptContributor): () => void;
  addRunOptionsContributor(fn: RunOptionsContributor): () => void;
  onRunStarted(fn: (run: RunStarted) => Promise<void> | void): () => void;
  onRunSettled(fn: (run: RunSettled) => Promise<void> | void): () => void;
  onProviderEvent(fn: (event: ProviderEventInfo) => void): () => void;
  setChatDefaults(fn: ChatDefaultsResolver | undefined): void;
  setRunEnvironmentResolver(fn: RunEnvironmentResolver | undefined): void;
  /** Observes successful domain commands (e.g. Projects logging memory and environment writes to activity). Optional so bare test contexts need not provide it. */
  onCommand?(fn: (event: CommandCompleted) => void): () => void;
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
  /** Codex app-server native thread APIs (goals, queue, projects) behind a capability probe. Absent in bare test contexts. */
  native?: NativeThreadBridge;
}

export type DomainHandler = (input: Record<string, unknown>) => unknown;
/** SBX-13: sleep/wake, fanned out by the runtime's power coordinator (see power-events.ts). */
export type DomainPowerEvent = { state: 'suspend'; at: number } | { state: 'resume'; at: number; sleptMs: number; suspendedAt: number | null };
export interface DomainModule { handlers: Record<string, DomainHandler>; dispose?(): void | Promise<void>; power?(event: DomainPowerEvent): void | Promise<void> }
export type DomainFactory = (context: DomainContext) => DomainModule;
