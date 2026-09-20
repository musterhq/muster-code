import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {configuredProviderInstances,type ProviderInstance} from './provider-instances.ts';
import {readOwnedCommandOutputs} from './command-output-recovery.ts';
import {coreBudgetOptions, classifyProviderFailure, requestWhileOwned, providerAccessPolicy, type ProviderBudgets, type ProviderRecovery} from './provider-run-lifecycle.ts';
import type { Chat, ProviderInfo } from '../shared/protocol.ts';

export const MODEL = 'claude/claude-fable-5';
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
}
export interface CoreClient {
  CODEX_RUN_LIFECYCLE_VERSION?: number;
  runCodexAppServer(input: Record<string, unknown>): Promise<ProviderResult>;
  callCodexConversation(key:string,method:string,params:Record<string,unknown>,options:Record<string,unknown>):Promise<Record<string,unknown>>;
  interruptActiveCodexTurn(owner: string, key: string): Promise<boolean>;
  clearCodexAppServerSessions(owner: string): void;
}
const OWNER = 'muster-agent-app';
interface OwnedSession {
  owner: string; key:string; providerId:string; bindingId:string; controller: AbortController; active: boolean; activity: boolean; terminalTurns: Set<string>; liveTurns: Set<string>; workOverflow?: boolean; retired?: boolean;
  turnId?: string; threadId?: string; completed: Promise<void>; finish(): void;
  stop?: Promise<boolean>; closeTimer?: ReturnType<typeof setTimeout>;
}
const key = (id: string, providerId:string, bindingId:string) => `agent:${id}:${providerId}:${bindingId}`;

/** Bundled from the existing headless core client; no VSCode or private provider APIs. */
export function createProviderAdapter(options: { core?: CoreClient; available?: () => boolean; command?: string; instances?:()=>ProviderInstance[] } = {}): ProviderAdapter {
  let core: CoreClient | undefined = options.core;
  let disposed = false;
  const instance = randomUUID();
  const sessions = new Map<string, OwnedSession>();
  const client = () => core ??= createRequire(__filename)(join(__dirname, 'core-client.cjs')) as CoreClient;
  const instances = ():ProviderInstance[] => options.instances?.() ?? (options.available ? [{
    info:{id:'hybrow',name:'Hybrow OmniRoute',available:options.available(),identityMasked:'Account hidden',bindingId:'fixture-hybrow',models:[{id:MODEL,name:'Claude Fable 5'}]},
    command:options.command??join(__dirname,'resources','codex-hybrow-gateway.sh'),env:{},sessionsRoot:join(process.env.CODEX_HOME||join(homedir(),'.codex'),'sessions'),
  }] : configuredProviderInstances());
  const close = (session: OwnedSession) => core?.clearCodexAppServerSessions(session.owner);
  const cancel = (id: string, session: OwnedSession): Promise<boolean> => {
    if (session.stop) return session.stop;
    session.controller.abort();
    // One bounded grace period lets a native interruption finish. Closing an
    // owner is chat-scoped; it must never terminate another chat's turn.
    session.closeTimer = setTimeout(() => { session.closeTimer = undefined; close(session); }, 1000);
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
  return {
    info() { return instances().map(instance=>({...instance.info,available:!disposed&&instance.info.available})); },
    async run(input) {
      if (disposed) throw new ProviderPreDispatchError('Provider adapter has been disposed.');
      let previous = sessions.get(input.chat.id);
      if (previous?.active || previous?.stop) throw new ProviderPreDispatchError('This chat already owns a provider attempt. Wait for it to settle before continuing.');
      const route = beforeDispatch(() => instances().find(instance=>instance.info.id===(input.chat.providerId??'hybrow')));
      if (!route?.info.available) throw new ProviderPreDispatchError('The selected provider is unavailable. No alternate provider was used.');
      if (input.chat.model && !route.info.models.some(model=>model.id===input.chat.model)) throw new ProviderPreDispatchError('This model is unavailable through the selected provider.');
      const bindingId=route.info.bindingId??route.info.id;
      if (input.chat.providerBindingId && input.chat.providerBindingId!==bindingId) throw new ProviderPreDispatchError('The selected provider account or profile changed. Select it again before running.');
      if (previous && (previous.providerId!==route.info.id || previous.bindingId!==bindingId)) {
        if (previous.liveTurns.size || previous.workOverflow) throw new ProviderPreDispatchError('Background provider work must finish before switching providers.');
        previous.controller.abort();close(previous);sessions.delete(input.chat.id);previous=undefined;
      }
      const resumeThread = input.chat.providerThreadProviderId===route.info.id && input.chat.providerThreadBindingId===bindingId ? input.chat.providerThreadId : undefined;
      if(previous && input.chat.providerThreadId && !resumeThread) {
        if(previous.liveTurns.size || previous.workOverflow) throw new ProviderPreDispatchError('Background provider work must finish before replacing a stale continuation.');
        previous.controller.abort();close(previous);sessions.delete(input.chat.id);previous=undefined;
      }
      const lifecycleSupported = beforeDispatch(() => client().CODEX_RUN_LIFECYCLE_VERSION === 1);
      const budgetOptions = beforeDispatch(() => coreBudgetOptions(input.budgets, lifecycleSupported));
      const access = beforeDispatch(() => providerAccessPolicy(input.chat));
      // Retire the prior observer before changing callbacks or mode. The core
      // normally keeps this process warm; the same chat owner remains stable.
      previous?.controller.abort();
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
      const session: OwnedSession = { owner: previous?.owner ?? `${OWNER}:${instance}:${input.chat.id}:${route.info.id}:${bindingId}`, key:key(input.chat.id,route.info.id,bindingId), providerId:route.info.id,bindingId, controller: new AbortController(), active: true, activity: false, terminalTurns: new Set(), liveTurns: previous?.liveTurns ?? new Set(), workOverflow: previous?.workOverflow, threadId: resumeThread ?? previous?.threadId, completed, finish };
      sessions.set(input.chat.id, session);
      const lateCancellation = () => {
        if (!session.controller.signal.aborted && !disposed) return false;
        // Legacy core has no pre-dispatch AbortSignal. Its late client is
        // closed on first callback/settlement; new core checks signal before dispatch.
        if (sessions.get(input.chat.id) === session) close(session);
        return true;
      };
      try {
        const node = process.env.MUSTER_PROVIDER_NODE || ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find(existsSync) || 'node';
        const commands=new Map<string,{params:Record<string,unknown>;item:Record<string,unknown>;turnId:string;output:string}>();
        const model = input.chat.model || MODEL;
        const result=await client().runCodexAppServer({
          prompt: input.prompt, cwd: input.cwd, command: route.command, model, reasoning: 'medium',
          env: { MUSTER_PROVIDER_NODE: node, ...route.env }, transportOwner: session.owner, cacheKey: session.key,
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
          developerInstructions: input.chat.mode === 'ask' ? 'Answer and inspect only. Do not modify files, execute mutations or request expanded access.' : input.chat.mode === 'plan' ? 'Produce a reviewable plan. Do not change files or request expanded access.' : undefined,
          collaborationMode: input.chat.mode === 'plan' ? { mode: 'plan', settings: { model, reasoning_effort: 'medium' } } : undefined,
          configOverrides: [`agents.default_subagent_model=${JSON.stringify(model)}`, 'agents.default_subagent_reasoning_effort="medium"', `sandbox_workspace_write.network_access=${access.networkAccess}`],
          onDelta(text: string) { session.activity = true; if (!lateCancellation()) input.onDelta(text); },
          onReasoningDelta(text: string) { session.activity = true; if (!lateCancellation()) input.onReasoning(text); },
          onEvent(method:string,params:Record<string,unknown>){
            const turn = params.turn as Record<string, unknown> | undefined;
            const thread = params.thread as Record<string, unknown> | undefined;
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
        const recovery = classifyProviderFailure(result, { activity: session.activity, terminal, cancelled: session.controller.signal.aborted });
        if (result.status === 'failed') session.retired = true;
        return { ...result, ...(session.controller.signal.aborted ? { status: 'failed' as const, errorMessage: recovery?.reason } : {}), ...(recovery ? { recovery } : {}) };
      } catch (error) {
        session.retired = true;
        close(session);
        const result: ProviderResult = { status: 'failed', finalMessage: '', errorMessage: error instanceof Error ? error.message : String(error), dispatchState: 'unknown', ...(session.threadId ? { threadId: session.threadId } : {}), ...(session.turnId ? { turnId: session.turnId } : {}) };
        return { ...result, recovery: classifyProviderFailure(result, { activity: session.activity, terminal: false, cancelled: session.controller.signal.aborted }) };
      } finally {
        session.active = false;
        if (session.retired) session.controller.abort();
        if (session.controller.signal.aborted || disposed) close(session);
        if (session.retired && !session.stop && sessions.get(input.chat.id) === session) sessions.delete(input.chat.id);
        session.finish();
      }
    },
    hasActiveWork(id) { const session=sessions.get(id); return !!session && (session.active || !!session.stop || session.liveTurns.size>0 || !!session.workOverflow); },
    async release(id) {
      const session=sessions.get(id);if(!session)return;
      if(session.active || session.stop || session.liveTurns.size || session.workOverflow)throw new Error('Wait for this chat and its background agents before switching providers.');
      session.controller.abort();close(session);sessions.delete(id);
    },
    async stop(id) { const session = sessions.get(id); return session ? cancel(id, session) : false; },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [id, session] of sessions) { void cancel(id, session); close(session); }
    },
  };
}
