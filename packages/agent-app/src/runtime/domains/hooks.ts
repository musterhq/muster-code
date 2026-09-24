/** Hook registry behind DomainContext.hooks, plus the bounded runners the service calls. */
import { isAbsolute } from 'node:path';
import type { Chat } from '../../shared/protocol.ts';
import type { ChatDefaults, ChatDefaultsResolver, CommandCompleted, DomainHooks, PromptContributor, ProviderEventInfo, ReasoningEffort, RunEnvironmentResolver, RunOptions, RunOptionsContributor, RunSettled, RunStarted } from './types.ts';

export const PROMPT_CONTRIBUTOR_TIMEOUT_MS = 2_000;
export const PROMPT_CONTRIBUTION_MAX_BYTES = 8 * 1024;
export const RUN_STARTED_TIMEOUT_MS = 5_000;
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
  let defaults: ChatDefaultsResolver | undefined, environment: RunEnvironmentResolver | undefined;
  const add = <T>(set: Set<T>, fn: T) => { set.add(fn); return () => { set.delete(fn); }; };
  const hooks: DomainHooks = {
    addPromptContributor: fn => add(prompts, fn),
    addRunOptionsContributor: fn => add(runOptions, fn),
    onRunStarted: fn => add(started, fn),
    onRunSettled: fn => add(settled, fn),
    onProviderEvent: fn => add(providerEvents, fn),
    setChatDefaults(fn) { defaults = fn; },
    setRunEnvironmentResolver(fn) { environment = fn; },
    onCommand: fn => add(commands, fn),
  };
  return {
    hooks,
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
      const merged: RunOptions = {}, instructions: string[] = [];
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
      }
      if (instructions.length) merged.developerInstructions = instructions.join('\n\n');
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
    /** Observers run synchronously after the command resolved; a throwing observer never fails the command. */
    commandCompleted(event: CommandCompleted): void {
      for (const fn of commands) { try { fn(event); } catch { /* observers are best-effort */ } }
    },
    chatDefaults(input: { folderId?: string; projectId?: string }): ChatDefaults {
      try { return defaults?.(input) ?? {}; } catch { return {}; }
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
