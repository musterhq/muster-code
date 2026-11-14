/** Hook registry behind DomainContext.hooks, plus the bounded runners the service calls. */
import { isAbsolute } from 'node:path';
import type { AgentEvent, Chat, Folder, ProviderInfo } from '../../shared/protocol.ts';
import type { AttentionChange, AutomatedWorktreeResolver, TaskHistoryBriefResolver, ChatDefaults, ChatRemoval, ChatDefaultsResolver, CommandCompleted, DomainHooks, PromptContributor, ProviderEventInfo, ReasoningEffort, RunEnvironmentResolver, RemoteFolderRouter, ToolPolicyResolver, RunOptions, RunOptionsContributor, RunSettled, RunStarted, RemoteAgentResolver, RemoteAgentRun } from './types.ts';

export const PROMPT_CONTRIBUTOR_TIMEOUT_MS = 2_000;
export const PROMPT_CONTRIBUTION_MAX_BYTES = 8 * 1024;
export const RUN_STARTED_TIMEOUT_MS = 5_000;
/** Stopping an archived chat's sandbox waits at most this long (docker stop takes up to ~10 s). */
export const CHAT_ARCHIVE_TIMEOUT_MS = 30_000;
const EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];

/** Settles with the work's value, or undefined on throw or timeout (the signal aborts then). */
export function bounded<T>(work: (signal: AbortSignal) => Promise<T> | T, ms: number): Promise<T | undefined> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(undefined); }, ms); });
  let run: Promise<T | undefined>;
  try { run = Promise.resolve(work(controller.signal)).catch(() => undefined); } catch { run = Promise.resolve(undefined); }
  return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
}

function capBytes(text: string, max: number): string {
  const bytes = Buffer.from(text, 'utf8');
  return bytes.length <= max ? text : `${bytes.subarray(0, max).toString('utf8').replace(/�+$/, '')}\n[truncated]`;
}

export function createDomainHooks() {
  const prompts = new Set<PromptContributor>(), runOptions = new Set<RunOptionsContributor>();
  const started = new Set<(run: RunStarted) => Promise<void> | void>(), settled = new Set<(run: RunSettled) => Promise<void> | void>();
  const providerEvents = new Set<(event: ProviderEventInfo) => void>();
  const commands = new Set<(event: CommandCompleted) => void>();
  const removals = new Set<(event: ChatRemoval) => Promise<void> | void>();
  const attentionObservers = new Set<(event: AttentionChange) => void>();
  const agentEvents = new Set<(event: AgentEvent) => void>();
  let defaults: ChatDefaultsResolver | undefined, environment: RunEnvironmentResolver | undefined, toolPolicy: ToolPolicyResolver | undefined, commitIdentity: ((folderId: string) => { name: string; email: string } | null) | undefined, worktreeRecorder: ((projectId: string, taskId: string, folderId: string) => void) | undefined;
  let automated: AutomatedWorktreeResolver | undefined;
  let contextWindow: ((providerId: string, model: string) => number | undefined) | undefined;
  let historyBrief: TaskHistoryBriefResolver | undefined;
  let remoteRouter: RemoteFolderRouter | undefined;
  let remoteAgent: RemoteAgentResolver | undefined;
  let sendData: ((chatId: string, requestId: string) => Record<string, unknown> | undefined) | undefined;
  const add = <T>(set: Set<T>, fn: T) => { set.add(fn); return () => { set.delete(fn); }; };
  const hooks: DomainHooks = {
    addPromptContributor: fn => add(prompts, fn),
    addRunOptionsContributor: fn => add(runOptions, fn),
    onRunStarted: fn => add(started, fn),
    onRunSettled: fn => add(settled, fn),
    onProviderEvent: fn => add(providerEvents, fn),
    setChatDefaults(fn) { defaults = fn; },
    setRunEnvironmentResolver(fn) { environment = fn; },
    setToolPolicy(fn) { toolPolicy = fn; },
    setContextWindowResolver(fn) { contextWindow = fn; },
    setCommitIdentity(fn) { commitIdentity = fn; },
    setTaskWorktreeRecorder(fn) { worktreeRecorder = fn; },
    noteTaskWorktree(projectId, taskId, folderId) { try { worktreeRecorder?.(projectId, taskId, folderId); } catch { /* best effort */ } },
    setAutomatedWorktree(fn) { automated = fn; },
    automatedWorktree(projectId, taskId) { return automated ? automated(projectId, taskId) : Promise.resolve(null); },
    setTaskHistoryBrief(fn) { historyBrief = fn; },
    async taskHistoryBrief(input) { try { return historyBrief ? await historyBrief(input) : null; } catch { return null; } },
    commitIdentity(folderId) { try { return commitIdentity?.(folderId) ?? null; } catch { return null; } },
    onCommand: fn => add(commands, fn),
    onChatRemoval: fn => add(removals, fn),
    setRemoteFolderRouter(fn) { remoteRouter = fn; },
    setRemoteAgentResolver(fn) { remoteAgent = fn; },
    onAttention: fn => add(attentionObservers, fn),
    setSendData(fn) { sendData = fn; },
    onAgentEvent: fn => add(agentEvents, fn),
  };
  return {
    hooks,
    /** The user's own context window for a model, if they set one. */
    contextWindowOverride(providerId: string, model: string): number | undefined { try { return contextWindow?.(providerId, model); } catch { return undefined; } },
    hasRunHooks: () => prompts.size + runOptions.size + started.size > 0,
    /** Each contributor gets 2s and 8KB; results are wrapped as <context source="label">. */
    async contributePrompt(input: Omit<Parameters<PromptContributor>[0], 'signal'>): Promise<{ text: string; sources: string[]; blocks: { label: string; text: string }[] }> {
      const results = await Promise.all([...prompts].map(fn => bounded(signal => fn({ ...input, signal }), PROMPT_CONTRIBUTOR_TIMEOUT_MS)));
      const blocks: string[] = [], sources: string[] = [], parts: { label: string; text: string }[] = [];
      for (const result of results) {
        if (!result || typeof result.label !== 'string' || typeof result.text !== 'string' || !result.text.trim()) continue;
        const label = result.label.replace(/[\x00-\x1f"<>&]/g, '').trim().slice(0, 64) || 'extension';
        const block = `<context source="${label}">\n${capBytes(result.text, PROMPT_CONTRIBUTION_MAX_BYTES).replace(/<\/context/gi, '<\\/context')}\n</context>`;
        blocks.push(block); parts.push({ label, text: block });
        sources.push(label);
      }
      return { text: blocks.join('\n\n'), sources, blocks: parts };
    },
    /** Later contributors win for reasoning; overrides merge; instructions concatenate. */
    async resolveRunOptions(chat: Chat): Promise<RunOptions> {
      const results = await Promise.all([...runOptions].map(fn => bounded(() => fn(chat), PROMPT_CONTRIBUTOR_TIMEOUT_MS)));
      const merged: RunOptions = {}, instructions: string[] = [], turnNotes: string[] = [];
      for (const result of results) {
        if (!result) continue;
        if (result.reasoningEffort && EFFORTS.includes(result.reasoningEffort)) merged.reasoningEffort = result.reasoningEffort;
        if (result.configOverrides && typeof result.configOverrides === 'object') {
          for (const [key, value] of Object.entries(result.configOverrides)) {
            const scalar = typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
            const stringArray = Array.isArray(value) && value.every(entry => typeof entry === 'string');
            if (/^[A-Za-z0-9_.-]{1,128}$/.test(key) && (scalar || stringArray)) (merged.configOverrides ??= {})[key] = value;
          }
        }
        if (typeof result.developerInstructions === 'string' && result.developerInstructions.trim()) instructions.push(capBytes(result.developerInstructions.trim(), PROMPT_CONTRIBUTION_MAX_BYTES));
        if (typeof result.turnContext === 'string' && result.turnContext.trim()) turnNotes.push(capBytes(result.turnContext.trim(), PROMPT_CONTRIBUTION_MAX_BYTES));
        if (result.ownsSilentEnd === true) merged.ownsSilentEnd = true;
      }
      if (instructions.length) merged.developerInstructions = instructions.join('\n\n');
      if (turnNotes.length) merged.turnContext = turnNotes.join('\n\n');
      return merged;
    },
    async runStarted(run: RunStarted): Promise<void> {
      await Promise.all([...started].map(fn => bounded(() => fn(run), RUN_STARTED_TIMEOUT_MS)));
    },
    /** Synchronous fan-out; an observer that throws is skipped, never the run. */
    providerEvent(event: ProviderEventInfo): void {
      for (const fn of providerEvents) { try { fn(event); } catch { /* observers never break a run */ } }
    },
    runSettled(run: RunSettled): void {
      for (const fn of settled) void bounded(() => fn(run), 60_000);
    },
    /** #44: extra data for a sent message's transcript row; a resolver that throws adds nothing. */
    sendData(chatId: string, requestId: string): Record<string, unknown> {
      try { return sendData?.(chatId, requestId) ?? {}; } catch { return {}; }
    },
    /** #44: synchronous fan-out of approval and question cards opening and closing; an observer that throws is skipped. */
    attention(event: AttentionChange): void {
      for (const fn of attentionObservers) { try { fn(event); } catch { /* observers never break a request */ } }
    },
    /** #326: synchronous fan-out of every runtime event; a throwing observer is skipped. */
    agentEvent(event: AgentEvent): void {
      for (const fn of agentEvents) { try { fn(event); } catch { /* observers never break the runtime */ } }
    },
    /** Observers run synchronously after the command resolved; a throwing observer never fails the command. */
    commandCompleted(event: CommandCompleted): void {
      for (const fn of commands) { try { fn(event); } catch { /* observers are best-effort */ } }
    },
    /** #654: deleting awaits every observer and rejects with the first failure; archiving is bounded and never rejects. */
    async chatRemoval(event: ChatRemoval): Promise<void> {
      if (event.kind === 'delete') { await Promise.all([...removals].map(async fn => fn(event))); return; }
      await Promise.all([...removals].map(fn => bounded(() => fn(event), CHAT_ARCHIVE_TIMEOUT_MS)));
    },
    /** The tool-policy verdict for an approval request, or null. A resolver that throws decides nothing. */
    toolPolicy(chat: Chat, method: string, params: Record<string, unknown>) {
      // Fail closed: a rule check that throws must not wave the call through.
      try { return toolPolicy?.(chat, method, params) ?? null; } catch { return {effect: 'deny' as const, message: 'The Project tool rules could not be checked, so this was declined. Try again; if it keeps happening, check the Project’s rules.'}; }
    },
    chatDefaults(input: { folderId?: string; projectId?: string }): ChatDefaults {
      try { return defaults?.(input) ?? {}; } catch { return {}; }
    },
    /** #147: a file or Git command for a folder on an SSH host. Never falls back to a local path. */
    remoteFolder(command: string, input: Record<string, unknown>, folder: Folder): Promise<unknown> {
      if (!remoteRouter) return Promise.reject(new Error('Folders on SSH hosts are not available right now.'));
      return remoteRouter(command, input, folder);
    },
    /** #147 phase 2: a chat's run on its folder's SSH host. Never falls back to running on this computer. */
    remoteAgent(input: { chat: Chat; folder: Folder; provider: ProviderInfo }): Promise<RemoteAgentRun> {
      if (!remoteAgent) return Promise.reject(new Error('Agents on SSH hosts are not available right now.'));
      return remoteAgent(input);
    },
    async runEnvironment(chat: Chat, defaultCwd: string): Promise<string> {
      if (!environment) return defaultCwd;
      const result = await environment(chat, defaultCwd);
      if (!result || typeof result.cwd !== 'string' || !isAbsolute(result.cwd)) throw new Error('The run environment did not provide a usable folder.');
      return result.cwd;
    },
  };
}
export type DomainHookRuntime = ReturnType<typeof createDomainHooks>;
