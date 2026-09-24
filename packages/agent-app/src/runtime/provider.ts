import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {configuredProviderInstances,providerListingsSettled,providerNode,type ProviderInstance,revalidateProviderInstances} from './provider-instances.ts';
import {createAdapterCatalog,type AdapterCatalog} from './adapters/index.ts';
import {readOwnedCommandOutputs} from './command-output-recovery.ts';
import {coreBudgetOptions, classifyProviderFailure, lifecycleDiagnostic, requestWhileOwned, providerAccessPolicy, type ProviderBudgets, type ProviderRecovery} from './provider-run-lifecycle.ts';
import {currentProviderUsage, formatResetEta} from './provider-usage.ts';
import {connectorPolicy, leanCodexFeatureOverrides} from './context-budget.ts';
import type { Chat, ProviderInfo } from '../shared/protocol.ts';
import {NativeUnavailableError} from './codex-native.ts';

/** Identity of the test-only route `createProviderAdapter({available})` builds. */
export const FIXTURE_PROVIDER = {id: 'fixture', bindingId: 'fixture-binding', model: 'fixture-model'} as const;
/** The legacy-core turn ceiling is logged once, so a killed long turn is never a silent failure. */
let lifecycleWarned = false;

export class ProviderPreDispatchError extends Error {
  readonly dispatchState = 'not-dispatched' as const;
}
function beforeDispatch<T>(check: () => T): T {
  try { return check(); }
  catch (error) { throw new ProviderPreDispatchError(error instanceof Error ? error.message : 'Provider preflight failed.'); }
}
export interface ProviderInput {
  chat: Chat; cwd: string; prompt: string;
  budgets?: ProviderBudgets;
  /** Absolute local image paths; the core sends each as a localImage input. */
  images?: string[];
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  /** Extra `-c key=value` overrides from domain run-options contributors. Access policy keys are ignored. String[] values become a TOML array. */
  configOverrides?: Record<string, string | number | boolean | string[]>;
  developerInstructions?: string;
  /** The user's request names a ChatGPT connector; Codex apps stay loaded for this chat from then on. */
  connectorsRequested?: boolean;
  onThreadReady?(threadId: string): void;
  onTurnAccepted?(identity: {threadId: string; turnId: string; dispatchState: 'dispatched'}): void;
  onDelta(text: string): void;
  onReasoning(text: string): void;
  onEvent(method: string, params: Record<string, unknown>): void;
  onRequest(method: string, params: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
}
export interface ProviderResult { status: 'completed' | 'failed'; finalMessage: string; threadId?: string; errorMessage?: string; dispatchState?: 'not-dispatched' | 'dispatched' | 'unknown'; turnId?: string; recovery?: ProviderRecovery; failure?: {kind: 'rpc-rejected' | 'request-timeout' | 'aborted'; method?: string; statusCode?: number; retryAfterMs?: number; requestId?: string} }
export interface ProviderAdapter {
  run(input: ProviderInput): Promise<ProviderResult>;
  /** True means an owned stop request settled locally; inspect recovery for remote certainty. */
  stop(chatId: string): Promise<boolean>;
  dispose(): void;
  info(): ProviderInfo[];
  hasActiveWork?(chatId:string):boolean;
  release?(chatId:string):Promise<void>;
  /** Adds text to the chat's running turn. False when no turn is active (the caller queues instead);
   *  `refused` when the turn exists but cannot take input (a review or compact turn). */
  steer?(chatId: string, text: string): Promise<boolean | {refused: string}>;
  /** Codex `thread/compact/start` on the chat's idle live session. Rejects when no session holds the thread. */
  compact?(chatId: string): Promise<void>;
  /** Resolves once asynchronous provider checks (CLI probes, /models requests) have settled, so a listing is current. */
  ready?(): Promise<void>;
  /** Thread identity of the chat's live Codex app-server session (native thread APIs), or undefined. */
  nativeThread?(chatId: string): {threadId: string; providerId: string; bindingId: string} | undefined;
  /** Calls a method on the chat's live Codex session. Throws NativeUnavailableError when none holds the thread. */
  nativeCall?(chatId: string, method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  /** Host-level app-server call not tied to a chat (project/*), through a one-shot process. */
  nativeQuery?(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  /** Events the chat's live session reports while Muster has no run in flight: turns the app-server starts
   *  itself (native goal continuations, native queue dispatch) and goal/queue notifications. */
  onIdleEvent?(listener: (chatId: string, method: string, params: Record<string, unknown>) => void): () => void;
  /** SBX-13: after a sleep, idle warm sessions may hold dead sockets. Marks them for re-check (a fresh app-server that
   *  resumes the same thread) before the next send and re-probes provider availability. Returns how many were marked. */
  markStale?(): number;
}
export interface CoreClient {
  CODEX_RUN_LIFECYCLE_VERSION?: number;
  runCodexAppServer(input: Record<string, unknown>): Promise<ProviderResult>;
  callCodexConversation(key:string,method:string,params:Record<string,unknown>,options:Record<string,unknown>):Promise<Record<string,unknown>>;
  interruptActiveCodexTurn(owner: string, key: string): Promise<boolean>;
  steerActiveCodexTurn?(text: string, owner: string, key?: string): Promise<boolean>;
  clearCodexAppServerSessions(owner: string): void;
  queryCodexAppServer?(method: string, params: Record<string, unknown>, options: Record<string, unknown>): Promise<Record<string, unknown>>;
}
const OWNER = 'muster-agent-app';
/** Grace for a native interrupt to settle before the chat's app-server is closed. */
const STOP_GRACE_MS = 5_000;
interface OwnedSession {
  owner: string; key:string; providerId:string; bindingId:string; controller: AbortController; active: boolean; activity: boolean; terminalTurns: Set<string>; liveTurns: Set<string>; workOverflow?: boolean; retired?: boolean;
  turnId?: string; threadId?: string; completed: Promise<void>; finish(): void;
  /** Launch configuration of the app-server this session last ran on (sandbox, access, mode, model, instructions). */
  signature?: string;
  /** Conversation mode of the last turn dispatched on this session. */
  mode?: Chat['mode'];
  /** SBX-13: set on wake; the next run replaces this idle app-server instead of trusting it. */
  stale?: boolean;
  stop?: Promise<boolean>; closeTimer?: ReturnType<typeof setTimeout>;
  /** A turn the app-server started on its own while no Muster run was in flight (goal continuation, queued item). */
  idleTurnId?: string;
}
const key = (id: string, providerId:string, bindingId:string) => `agent:${id}:${providerId}:${bindingId}`;
/** Maps Codex `turn/steer` errors: no active turn → queue; review/compact → refuse with a reason; a turn-id mismatch → retry once. */
export function steerFailure(error: unknown): false | {refused: string} | 'retry' {
  const message = error instanceof Error ? error.message : String(error);
  if (/no active turn to steer/i.test(message)) return false;
  const kind = /cannot steer a (review|compact) turn/i.exec(message)?.[1]?.toLowerCase();
  if (kind) return {refused: `A ${kind} turn can’t be steered.`};
  return 'retry';
}

/** Bundled from the existing headless core client; no VSCode or private provider APIs. */
const modeInstructions = (mode: Chat['mode']) => mode === 'ask' ? 'Answer and inspect only. Do not modify files, execute mutations or request expanded access.' : mode === 'plan' ? 'Produce a reviewable plan. Do not change files or request expanded access. Do not spawn sub-agents to implement changes: implementation starts only after the user executes the plan. Put the complete plan in your final message.' : undefined;
/** Process ownership (F41/F50): the agent may only clean up what it started itself. */
export const PROCESS_OWNERSHIP_RULE = 'Process ownership: only stop, kill or restart processes you started yourself in this conversation. Never kill processes by port or name without confirming you started them; the user\'s terminals and dev servers are theirs even when they look orphaned. If a port you need is busy, pick another port. Stop long-running processes you started (dev servers, watchers) before ending your turn unless the user asked you to keep them running.';
const runInstructions = (mode: Chat['mode'], extra?: string) => [modeInstructions(mode), mode === 'agent' ? PROCESS_OWNERSHIP_RULE : undefined, extra].filter(Boolean).join('\n\n') || undefined;
/** Test runners construct many services; they opt into real CLI/API adapters by passing a catalog. */
const defaultCatalog = () => process.env.NODE_TEST_CONTEXT && process.env.MUSTER_PROVIDER_ADAPTERS !== '1' ? undefined : createAdapterCatalog();
interface AdapterRun {controller: AbortController; completed: Promise<void>}

export function createProviderAdapter(options: { core?: CoreClient; available?: () => boolean; command?: string; instances?:()=>ProviderInstance[]; catalog?: AdapterCatalog } = {}): ProviderAdapter {
  // Each warm chat keeps a node proxy + codex app-server (~300 MB) alive; core defaults (8 chats, 30 min) held 1-2.5 GB idle.
  process.env.MUSTER_NATIVE_SESSION_CACHE_SIZE ??= '3';
  process.env.MUSTER_NATIVE_SESSION_IDLE_MS ??= String(5 * 60_000);
  let core: CoreClient | undefined = options.core;
  let disposed = false;
  const instance = randomUUID();
  const sessions = new Map<string, OwnedSession>();
  const adapterRuns = new Map<string, AdapterRun>();
  /** Chats that asked for a ChatGPT connector: apps stay on for them, so a thread's tool list does not flip back and forth. */
  const connectorChats = new Set<string>();
  const idleListeners = new Set<(chatId: string, method: string, params: Record<string, unknown>) => void>();
  const catalog = options.catalog ?? (options.instances || options.available ? undefined : defaultCatalog());
  // Start CLI probes and model listings now so the first providers.list is already settled.
  catalog?.instances();
  const client = () => core ??= createRequire(__filename)(join(__dirname, 'core-client.cjs')) as CoreClient;
  // `available` is a test seam: one Codex-style route with a fixed identity, no configuration read.
  const instances = ():ProviderInstance[] => options.instances?.() ?? (options.available ? [{
    info:{id:FIXTURE_PROVIDER.id,name:'Fixture provider',driver:'codex-app-server',available:options.available(),identityMasked:'Account hidden',bindingId:FIXTURE_PROVIDER.bindingId,models:[{id:FIXTURE_PROVIDER.model,name:'Fixture model'}]},
    command:options.command??join(__dirname,'resources','codex-launch.sh'),env:{},sessionsRoot:join(process.env.CODEX_HOME||join(homedir(),'.codex'),'sessions'),
  }] : [...configuredProviderInstances(), ...catalog?.instances() ?? []]);
  const close = (session: OwnedSession) => core?.clearCodexAppServerSessions(session.owner);
  const cancel = (id: string, session: OwnedSession): Promise<boolean> => {
    if (session.stop) return session.stop;
    session.controller.abort();
    // One bounded grace period lets a native interruption finish. Closing an
    // owner is chat-scoped; it must never terminate another chat's turn.
    // Interrupts that must tear down running tools (dev servers, installs) can take a few seconds.
    session.closeTimer = setTimeout(() => { session.closeTimer = undefined; close(session); }, STOP_GRACE_MS);
    const interrupted = core && !(core.CODEX_RUN_LIFECYCLE_VERSION === 1 && session.active) ? core.interruptActiveCodexTurn(session.owner, session.key).catch(() => false) : Promise.resolve(!!core);
    session.stop = (async () => {
      const acknowledged = await interrupted;
      if (!acknowledged) close(session);
      // Retain ownership until the actual core call settles. Closing a local
      // process is not proof that remote accepted work was cancelled.
      await session.completed;
      if (session.closeTimer) clearTimeout(session.closeTimer);
      session.closeTimer = undefined;
      close(session);
      if (sessions.get(id) === session) sessions.delete(id);
      return true;
    })();
    return session.stop;
  };
  /** Claude Code, OpenCode and HTTP routes: one owned local attempt per chat, no app-server session. */
  async function runAdapter(route: ProviderInstance, input: ProviderInput, resumeThreadId: string | undefined): Promise<ProviderResult> {
    const access = beforeDispatch(() => providerAccessPolicy(input.chat));
    const model = input.chat.model || route.info.models[0]?.id;
    if (!model) throw new ProviderPreDispatchError('The selected provider reports no models.');
    let finish!: () => void;
    const owned: AdapterRun = {controller: new AbortController(), completed: new Promise<void>(resolve => { finish = resolve; })};
    adapterRuns.set(input.chat.id, owned);
    const live = () => !owned.controller.signal.aborted && !disposed;
    let activity = false;
    try {
      const result = await route.adapter!.run({
        chat: input.chat, cwd: input.cwd, prompt: input.prompt, model, permissionMode: access.permissionMode, signal: owned.controller.signal,
        ...(input.images?.length ? {images: input.images} : {}), ...(input.reasoningEffort ? {reasoningEffort: input.reasoningEffort} : {}),
        ...(resumeThreadId ? {resumeThreadId} : {}),
        instructions: runInstructions(input.chat.mode, input.developerInstructions),
        onThreadReady: threadId => { if (live()) input.onThreadReady?.(threadId); },
        onTurnAccepted: identity => { activity = true; if (live()) input.onTurnAccepted?.({...identity, dispatchState: 'dispatched'}); },
        onDelta: text => { activity = true; if (live()) input.onDelta(text); },
        onReasoning: text => { activity = true; if (live()) input.onReasoning(text); },
        onEvent: (method, params) => { activity = true; if (live()) input.onEvent(method, params); },
      });
      const cancelled = owned.controller.signal.aborted || disposed;
      const notDispatched = result.dispatchState === 'not-dispatched' && !activity;
      // A settled local process or HTTP stream leaves no remote turn running, so these
      // attempts are terminal: cancelled or failed, never 'recovery-needed'.
      const recovery: ProviderRecovery | undefined = cancelled ? {kind: 'cancelled', retryable: false, reason: 'Stopped. This attempt will not resume automatically.'}
        : result.status === 'completed' ? undefined
        : notDispatched && (result.statusCode === 429 || result.statusCode === 503) ? {kind: 'admission-rejected', retryable: true, reason: `${result.errorMessage ?? 'The provider is at capacity.'} No turn was dispatched; retry manually later.`}
        : {kind: 'failed', retryable: notDispatched, reason: result.errorMessage ? `The provider attempt failed: ${result.errorMessage}` : 'The provider attempt failed.'};
      return {status: cancelled ? 'failed' : result.status, finalMessage: result.finalMessage, dispatchState: result.dispatchState,
        ...(result.threadId ? {threadId: result.threadId} : {}), ...(result.turnId ? {turnId: result.turnId} : {}),
        ...(recovery ? {recovery, errorMessage: recovery.reason} : {}),
        ...(result.statusCode ? {failure: {kind: 'rpc-rejected' as const, statusCode: result.statusCode}} : {})};
    } catch (error) {
      const reason = `The provider attempt failed: ${error instanceof Error ? error.message : String(error)}`;
      return {status: 'failed', finalMessage: '', dispatchState: activity ? 'dispatched' : 'not-dispatched', errorMessage: reason, recovery: {kind: owned.controller.signal.aborted ? 'cancelled' : 'failed', retryable: !activity && !owned.controller.signal.aborted, reason}};
    } finally {
      if (adapterRuns.get(input.chat.id) === owned) adapterRuns.delete(input.chat.id);
      finish();
    }
  }
  return {
    info() { return instances().map(instance=>({...instance.info,available:!disposed&&instance.info.available})); },
    async ready() { await Promise.all([catalog?.ready(), options.instances || options.available ? undefined : providerListingsSettled()]); },
    markStale() {
      revalidateProviderInstances();
      let marked = 0;
      for (const session of sessions.values()) if (!session.active && !session.stop && !session.liveTurns.size && !session.workOverflow) { session.stale = true; marked++; }
      return marked;
    },
    async run(input) {
      if (disposed) throw new ProviderPreDispatchError('Provider adapter has been disposed.');
      let previous = sessions.get(input.chat.id);
      if (previous?.active || previous?.stop || adapterRuns.has(input.chat.id)) throw new ProviderPreDispatchError('This chat already owns a provider attempt. Wait for it to settle before continuing.');
      revalidateProviderInstances();
      if (!input.chat.providerId) throw new ProviderPreDispatchError('No model is connected for this chat. Connect a model, then pick it in the composer.');
      const route = beforeDispatch(() => instances().find(instance=>instance.info.id===input.chat.providerId));
      if (!route) throw new ProviderPreDispatchError(`The provider “${input.chat.providerId}” is not available on this Mac. Pick another model. No alternate provider was used.`);
      if (!route.info.available) throw new ProviderPreDispatchError('The selected provider is unavailable. No alternate provider was used.');
      if (input.chat.model && !route.info.models.some(model=>model.id===input.chat.model)) throw new ProviderPreDispatchError('This model is unavailable through the selected provider.');
      const bindingId=route.info.bindingId??route.info.id;
      if (input.chat.providerBindingId && input.chat.providerBindingId!==bindingId) throw new ProviderPreDispatchError('The selected provider account or profile changed. Select it again before running.');
      if (previous && (previous.providerId!==route.info.id || previous.bindingId!==bindingId)) {
        if (previous.liveTurns.size || previous.workOverflow) throw new ProviderPreDispatchError('Background provider work must finish before switching providers.');
        previous.controller.abort();close(previous);sessions.delete(input.chat.id);previous=undefined;
      }
      const resumeThread = input.chat.providerThreadProviderId===route.info.id && input.chat.providerThreadBindingId===bindingId ? input.chat.providerThreadId : undefined;
      if (route.adapter) {
        if (previous) {
          if (previous.liveTurns.size || previous.workOverflow) throw new ProviderPreDispatchError('Background provider work must finish before switching providers.');
          previous.controller.abort();close(previous);sessions.delete(input.chat.id);
        }
        return runAdapter(route, input, resumeThread);
      }
      if(previous && input.chat.providerThreadId && !resumeThread) {
        if(previous.liveTurns.size || previous.workOverflow) throw new ProviderPreDispatchError('Background provider work must finish before replacing a stale continuation.');
        previous.controller.abort();close(previous);sessions.delete(input.chat.id);previous=undefined;
      }
      const lifecycleSupported = beforeDispatch(() => client().CODEX_RUN_LIFECYCLE_VERSION === 1);
      if (!lifecycleSupported && !lifecycleWarned) { lifecycleWarned = true; console.warn(lifecycleDiagnostic(false)); }
      const budgetOptions = beforeDispatch(() => coreBudgetOptions(input.budgets, lifecycleSupported));
      const access = beforeDispatch(() => providerAccessPolicy(input.chat));
      // Retire the prior observer before changing callbacks or mode. The core
      // normally keeps this process warm; the same chat owner remains stable.
      previous?.controller.abort();
      // Root cause of F19/F45/F55: the core caches app-servers by launch config.
      // A permission/mode/model change produces a new config, so the core spawned
      // a second app-server and resumed the SAME thread while the previous warm
      // one still held it; that first turn failed instantly. (Retry worked only
      // because the failure closed every process of this owner.) Close the stale
      // process first so exactly one app-server owns the thread.
      const model0 = input.chat.model || route.info.models[0]?.id;
      if (!model0) throw new ProviderPreDispatchError('The selected provider reports no models.');
      // Mirrors the core's scope key (instruction-only changes are already evicted by the core).
      if (input.connectorsRequested) connectorChats.add(input.chat.id);
      // Context budget: Codex features Muster does not use, and connector (apps) tool schemas a model without deferred
      // tool search would otherwise receive inline on every request, stay off unless this chat asked for a connector.
      const featureOverrides = leanCodexFeatureOverrides({toolSearch: route.info.models.find(entry => entry.id === model0)?.toolSearch, connectorsRequested: connectorChats.has(input.chat.id), policy: connectorPolicy()});
      const signature = JSON.stringify([access, model0, input.reasoningEffort ?? 'medium', input.configOverrides ?? {}, featureOverrides, input.cwd, route.command, route.info.id, route.env]);
      if (previous && ((previous.signature !== undefined && previous.signature !== signature) || previous.stale) && !previous.liveTurns.size && !previous.workOverflow) close(previous);
      if (!previous && sessions.size >= 64) {
        // Bound retained observers without evicting known background work.
        for (const [id, idle] of sessions) {
          if (idle.active || idle.stop || idle.liveTurns.size || idle.workOverflow) continue;
          idle.controller.abort(); close(idle); sessions.delete(id); break;
        }
        if (sessions.size >= 64) throw new ProviderPreDispatchError('Provider session capacity reached. Stop an existing chat before starting another.');
      }
      let finish!: () => void;
      const completed = new Promise<void>(resolve => { finish = resolve; });
      const session: OwnedSession = { owner: previous?.owner ?? `${OWNER}:${instance}:${input.chat.id}:${route.info.id}:${bindingId}`, key:key(input.chat.id,route.info.id,bindingId), providerId:route.info.id,bindingId, controller: new AbortController(), active: true, activity: false, terminalTurns: new Set(), liveTurns: previous?.liveTurns ?? new Set(), workOverflow: previous?.workOverflow, threadId: resumeThread ?? previous?.threadId, completed, finish, signature, mode: input.chat.mode };
      sessions.set(input.chat.id, session);
      const lateCancellation = () => {
        if (!session.controller.signal.aborted && !disposed) return false;
        // Legacy core has no pre-dispatch AbortSignal. Its late client is
        // closed on first callback/settlement; new core checks signal before dispatch.
        if (sessions.get(input.chat.id) === session) close(session);
        return true;
      };
      try {
        const node = providerNode();
        const commands=new Map<string,{params:Record<string,unknown>;item:Record<string,unknown>;turnId:string;output:string}>();
        const model = model0;
        const reasoning = input.reasoningEffort ?? 'medium';
        const developerInstructions = runInstructions(input.chat.mode, input.developerInstructions);
        const extraOverrides = Object.entries(input.configOverrides ?? {}).filter(([name]) => /^[A-Za-z0-9_.-]{1,128}$/.test(name) && !/^(sandbox|approval_policy)/.test(name)).map(([name, value]) => `${name}=${JSON.stringify(value)}`);
        const result=await client().runCodexAppServer({
          prompt: input.prompt, cwd: input.cwd, command: route.command, model, reasoning,
          ...(input.images?.length ? { images: input.images } : {}),
          env: { MUSTER_PROVIDER_NODE: node.node, ...node.env, ...route.env }, transportOwner: session.owner, cacheKey: session.key,
          ...budgetOptions,
          ...(lifecycleSupported ? {
            signal: session.controller.signal,
            onThreadReady(threadId: string) { session.threadId = threadId; input.onThreadReady?.(threadId); },
            onTurnAccepted(identity: {threadId: string; turnId: string; dispatchState: 'dispatched'}) {
              session.threadId = identity.threadId; session.turnId = identity.turnId; session.activity = true;
              input.onTurnAccepted?.(identity);
            },
          } : {}),
          keepAlive: true, threadId: resumeThread,
          sandbox: access.sandbox,
          networkAccess: access.networkAccess, approvalPolicy: access.approvalPolicy,
          developerInstructions,
          // Codex keeps a turn's collaboration mode for later turns and for sub-agents spawned
          // in them. Leaving Plan must reset it explicitly, or "Execute plan" workers stay in
          // Plan mode and can only describe patches (F53).
          collaborationMode: input.chat.mode === 'plan' ? { mode: 'plan', settings: { model, reasoning_effort: reasoning } }
            : previous?.mode === 'plan' || (!previous && resumeThread) ? { mode: 'default', settings: { model, reasoning_effort: reasoning } } : undefined,
          configOverrides: [`agents.default_subagent_model=${JSON.stringify(model)}`, `agents.default_subagent_reasoning_effort=${JSON.stringify(reasoning)}`, ...featureOverrides, ...extraOverrides, `sandbox_workspace_write.network_access=${access.networkAccess}`],
          onDelta(text: string) { session.activity = true; if (!lateCancellation()) input.onDelta(text); },
          onReasoningDelta(text: string) { session.activity = true; if (!lateCancellation()) input.onReasoning(text); },
          onEvent(method:string,params:Record<string,unknown>){
            const turn = params.turn as Record<string, unknown> | undefined;
            const thread = params.thread as Record<string, unknown> | undefined;
            // A parent-thread turn that starts after this run's own turn ended (or between runs) was started
            // by the app-server itself: a native goal continuation or queued follow-up. Decide before
            // session.turnId moves on to it.
            const ownTurnEnded = !!session.threadId && !!session.turnId && session.terminalTurns.has(`${session.threadId}\0${session.turnId}`);
            if (method === 'turn/started' && session.threadId && params.threadId === session.threadId && typeof turn?.id === 'string' && (!session.active || ownTurnEnded)) session.idleTurnId = turn.id;
            const routeIdle = !session.active || !!session.idleTurnId;
            // A missing parent identity must not be guessed from a child's
            // turn. Older notifications without a root source remain unknown.
            if (method === 'thread/started' && !session.threadId && typeof thread?.id === 'string' &&
                typeof thread.source === 'string' && ['cli', 'vscode', 'exec', 'appServer'].includes(thread.source)) session.threadId = thread.id;
            if (method === 'turn/started' && session.threadId && params.threadId === session.threadId && typeof turn?.id === 'string') session.turnId = turn.id;
            if (typeof turn?.id === 'string' && typeof params.threadId === 'string') {
              const identity = `${params.threadId}\0${turn.id}`;
              if (method === 'turn/started') {
                if (session.liveTurns.size < 64) session.liveTurns.add(identity);
                else session.workOverflow = true;
              }
              if (method === 'turn/completed') {
                session.liveTurns.delete(identity);
                if (session.terminalTurns.size < 64) session.terminalTurns.add(identity);
              }
            }
            if (method.startsWith('item/') || method === 'turn/started') session.activity = true;
            if (lateCancellation()) return;
            if (routeIdle && sessions.get(input.chat.id) === session) {
              // Between Muster runs the warm session still reports turns the app-server starts itself.
              for (const listener of idleListeners) { try { listener(input.chat.id, method, params); } catch { /* observers must not break the stream */ } }
              if (method === 'turn/completed' && params.threadId === session.threadId && turn?.id === session.idleTurnId) session.idleTurnId = undefined;
            }
            input.onEvent(method,params);
            const item=params.item as Record<string,unknown>|undefined;
            if(method==='item/completed'&&item?.type==='commandExecution'&&typeof item.id==='string'&&typeof params.turnId==='string'){
              if(commands.size<64)commands.set(item.id,{params,item,turnId:params.turnId,output:typeof item.aggregatedOutput==='string'?item.aggregatedOutput:''});
            }
          }, onRequest(method: string, params: Record<string, unknown>) {
            session.activity = true;
            if (lateCancellation()) return Promise.resolve(undefined);
            return requestWhileOwned(session.controller.signal, () => input.onRequest(method, params));
          },
        });
        if(commands.size&&result.threadId&&!session.controller.signal.aborted&&!disposed){
          try{
            const response=await client().callCodexConversation(session.key,'thread/read',{threadId:result.threadId,includeTurns:false},{transportOwner:session.owner,requireOwner:true,timeoutMs:2500});
            const thread=response.thread as Record<string,unknown>|undefined;
            if(thread?.id===result.threadId&&typeof thread.path==='string'){
              const recovered=await readOwnedCommandOutputs({sessionsRoot:route.sessionsRoot,sessionPath:thread.path,threadId:result.threadId,commands:[...commands].map(([itemId,c])=>({itemId,turnId:c.turnId,output:c.output}))});
              for(const [itemId,output] of recovered){if(lateCancellation())break;const c=commands.get(itemId)!;input.onEvent('item/completed',{...c.params,item:{...c.item,aggregatedOutput:output,outputSource:'provider-session'}});}
            }
          }catch{/* Protocol output remains intact when an owned session is unavailable. */}
        }
        session.threadId = result.threadId ?? session.threadId;
        session.turnId = result.turnId ?? session.turnId;
        if (result.status === 'completed' && result.threadId && result.turnId) session.liveTurns.delete(`${result.threadId}\0${result.turnId}`);
        const terminal = !!result.threadId && !!result.turnId && session.terminalTurns.has(`${result.threadId}\0${result.turnId}`);
        // A resets-in-N-min ETA, when the provider is near capacity, is appended to an
        // admission-rejected reason so the user knows roughly when to retry instead of guessing.
        const resetEta = formatResetEta(currentProviderUsage(route.info.id, route.sessionsRoot, route.info.codex?.modelProvider));
        const recovery = classifyProviderFailure(result, { activity: session.activity, terminal, cancelled: session.controller.signal.aborted, resetEta });
        if (result.status === 'failed') session.retired = true;
        return { ...result, ...(session.controller.signal.aborted ? { status: 'failed' as const, errorMessage: recovery?.reason } : {}), ...(recovery ? { recovery } : {}) };
      } catch (error) {
        session.retired = true;
        close(session);
        const result: ProviderResult = { status: 'failed', finalMessage: '', errorMessage: error instanceof Error ? error.message : String(error), dispatchState: 'unknown', ...(session.threadId ? { threadId: session.threadId } : {}), ...(session.turnId ? { turnId: session.turnId } : {}) };
        return { ...result, recovery: classifyProviderFailure(result, { activity: session.activity, terminal: false, cancelled: session.controller.signal.aborted, resetEta: formatResetEta(currentProviderUsage(route.info.id, route.sessionsRoot, route.info.codex?.modelProvider)) }) };
      } finally {
        session.active = false;
        if (session.retired) session.controller.abort();
        if (session.controller.signal.aborted || disposed) close(session);
        if (session.retired && !session.stop && sessions.get(input.chat.id) === session) sessions.delete(input.chat.id);
        session.finish();
      }
    },
    nativeThread(id) {
      const session = sessions.get(id);
      if (disposed || !core || !session?.threadId || session.retired || session.controller.signal.aborted || session.stop) return undefined;
      return {threadId: session.threadId, providerId: session.providerId, bindingId: session.bindingId};
    },
    async nativeCall(id, method, params, timeoutMs = 15_000) {
      const session = sessions.get(id);
      if (disposed || !core || !session?.threadId || session.retired || session.controller.signal.aborted || session.stop) throw new NativeUnavailableError();
      try { return await core.callCodexConversation(session.key, method, params, {transportOwner: session.owner, requireOwner: true, timeoutMs}); }
      catch (error) {
        if (error instanceof Error && /no live app-server owner/i.test(error.message)) throw new NativeUnavailableError();
        throw error;
      }
    },
    async nativeQuery(method, params, timeoutMs = 15_000) {
      const route = instances().find(entry => !entry.adapter && entry.info.available);
      const query = client().queryCodexAppServer;
      if (disposed || !route || typeof query !== 'function') throw new NativeUnavailableError('No Codex app-server route is available.');
      return query(method, params, {command: route.command, timeoutMs});
    },
    onIdleEvent(listener) { idleListeners.add(listener); return () => { idleListeners.delete(listener); }; },
    hasActiveWork(id) { const session=sessions.get(id); return adapterRuns.has(id) || (!!session && (session.active || !!session.stop || session.liveTurns.size>0 || !!session.workOverflow)); },
    async release(id) {
      if(adapterRuns.has(id))throw new Error('Wait for this chat to finish before switching providers.');
      const session=sessions.get(id);if(!session)return;
      if(session.active || session.stop || session.liveTurns.size || session.workOverflow)throw new Error('Wait for this chat and its background agents before switching providers.');
      session.controller.abort();close(session);sessions.delete(id);
    },
    async steer(id, text) {
      const session = sessions.get(id);
      if (disposed || !session?.active || session.stop || session.controller.signal.aborted || !core) return false;
      // Codex `turn/steer` always names the turn it expects, so a steer never lands in a newer turn.
      if (session.threadId && session.turnId) {
        try {
          await core.callCodexConversation(session.key, 'turn/steer', {threadId: session.threadId, expectedTurnId: session.turnId, input: [{type: 'text', text}]}, {transportOwner: session.owner, requireOwner: true, timeoutMs: 15_000});
          return true;
        } catch (error) {
          const verdict = steerFailure(error);
          if (verdict !== 'retry') return verdict;
          // Mismatch or transport trouble: retry once against the core's own view of the active turn.
        }
      }
      if (!core.steerActiveCodexTurn) return false;
      try { return (await core.steerActiveCodexTurn(text, session.owner, session.key)) === true; } catch { return false; }
    },
    async compact(id) {
      const session = sessions.get(id);
      if (disposed || !core || !session?.threadId || session.retired || session.controller.signal.aborted) throw new Error('No live provider session holds this thread. Send a message first, then compact.');
      if (session.active || session.stop) throw new Error('Wait for the current run to finish before compacting.');
      await core.callCodexConversation(session.key, 'thread/compact/start', {threadId: session.threadId}, {transportOwner: session.owner, requireOwner: true, timeoutMs: 30_000});
    },
    async stop(id) {
      const owned = adapterRuns.get(id);
      if (owned) { owned.controller.abort(); await owned.completed; return true; }
      const session = sessions.get(id);
      // A turn the app-server started itself (native goal or queue) is interrupted natively; the session stays warm.
      if (session && core && !session.active && !session.stop && session.threadId && session.idleTurnId) {
        try {
          await core.callCodexConversation(session.key, 'turn/interrupt', {threadId: session.threadId, turnId: session.idleTurnId}, {transportOwner: session.owner, requireOwner: true, timeoutMs: STOP_GRACE_MS});
          return true;
        } catch { /* fall through to closing the owned session */ }
      }
      return session ? cancel(id, session) : false;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const owned of adapterRuns.values()) owned.controller.abort();
      for (const [id, session] of sessions) { void cancel(id, session); close(session); }
    },
  };
}
