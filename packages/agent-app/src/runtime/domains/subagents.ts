import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Chat, TimelineItem } from '../../shared/protocol.ts';
import { SUBAGENT_STEER_MAX, type SubagentControlCapabilities, type SubagentControlResult, type SubagentTranscript, type SubagentTranscriptStatus } from '../../shared/domains/subagents-protocol.ts';
import { configuredProviderInstances, type ProviderInstance } from '../provider-instances.ts';
import { toolEventDetails } from '../tool-event-details.ts';
import type { DomainContext, DomainModule } from './types.ts';

type ReadParams = { threadId: string; includeTurns: true };
/** The two bundled-core entry points a child read needs; tests inject fakes. */
export interface TranscriptCore {
  /** `thread/read` for transcripts; `turn/interrupt` and `turn/steer` on a child thread for TRN-10's per-subagent Stop and Steer. */
  callCodexConversation(key: string, method: 'thread/read' | 'turn/interrupt' | 'turn/steer', params: Record<string, unknown>, options: { requireOwner: true; timeoutMs: number }): Promise<Record<string, unknown>>;
  queryCodexAppServer?(method: 'thread/read', params: ReadParams, options: { command: string; cwd: string; timeoutMs: number; env: Record<string, string> }): Promise<Record<string, unknown>>;
}
export interface SubagentsDeps { core?: () => TranscriptCore; instances?: () => ProviderInstance[]; now?: () => number }

const MAX_ITEMS = 400, MAX_TEXT = 65536, CACHE = 32, COLD_RUNNING_TTL = 10_000, COLD_SETTLED_TTL = 5 * 60_000;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;
const clip = (value: string) => value.length <= MAX_TEXT ? value : value.slice(0, MAX_TEXT) + '\n[Truncated]';
const iso = (value: unknown): string | undefined => typeof value === 'number' && Number.isFinite(value) ? new Date(value < 1e12 ? value * 1000 : value).toISOString() : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
function parsed(value: unknown): unknown { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return undefined; } }

/** Thread ids the parent's own collab reports name. A chat can read only its own children. */
export function reportedChildIds(items: readonly TimelineItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    const data = item.data;
    if (item.kind !== 'tool' || data?.type !== 'collabAgentToolCall') continue;
    if (Array.isArray(data.receiverThreadIds)) for (const id of data.receiverThreadIds) if (str(id)) ids.add(id as string);
    const states = parsed(data.agentsStates);
    if (isRecord(states)) for (const id of Object.keys(states)) ids.add(id);
    const agents = parsed(data.receiverAgents);
    for (const agent of Array.isArray(agents) ? agents : isRecord(agents) ? Object.entries(agents).map(([key, value]) => isRecord(value) ? { _key:key, ...value } : undefined) : []) {
      if (!isRecord(agent)) continue;
      const id = str(agent.threadId) ?? str(agent.receiverThreadId) ?? str(agent.agentThreadId) ?? str(agent.id) ?? str(agent._key);
      if (id) ids.add(id);
    }
    if (str(data.senderThreadId)) ids.delete(data.senderThreadId as string);
  }
  return ids;
}

const toolStatus = (status: unknown, turnRunning: boolean): string =>
  status === 'inProgress' || status === 'running' ? 'running' : status === 'failed' ? 'failed' : status === 'declined' || status === 'cancelled' ? 'cancelled' : status === 'interrupted' ? 'interrupted' : status === 'completed' ? 'completed' : turnRunning ? 'running' : 'completed';
function userText(item: Record<string, unknown>): string {
  if (Array.isArray(item.content)) return item.content.flatMap(part => isRecord(part) && typeof part.text === 'string' ? [part.text] : []).join('\n');
  return typeof item.text === 'string' ? item.text : '';
}
const lines = (value: unknown): string => Array.isArray(value) ? value.flatMap(part => typeof part === 'string' ? [part] : isRecord(part) && typeof part.text === 'string' ? [part.text] : []).join('\n\n') : typeof value === 'string' ? value : '';

/** Codex thread/read turns -> timeline rows the parent components already render. */
export function normalizeChildThread(chatId: string, threadId: string, thread: Record<string, unknown>): Pick<SubagentTranscript, 'items' | 'status' | 'startedAt' | 'updatedAt' | 'name' | 'role' | 'model'> {
  const turns = Array.isArray(thread.turns) ? thread.turns.filter(isRecord) : [];
  const startedAt = iso(thread.createdAt), updatedAt = iso(thread.updatedAt) ?? startedAt;
  const createdAt = startedAt ?? new Date(0).toISOString();
  const items: TimelineItem[] = [];
  for (const turn of turns) {
    const running = turn.status === 'inProgress' || turn.status === 'running';
    for (const raw of Array.isArray(turn.items) ? turn.items.filter(isRecord) : []) {
      const type = String(raw.type ?? ''), rawId = str(raw.id) ?? `${str(turn.id) ?? 'turn'}:${items.length}`;
      const id = `${threadId}:${rawId}`, base = { id, chatId, createdAt };
      if (type === 'userMessage') { const text = userText(raw); if (text.trim()) items.push({ ...base, kind:'user', text:clip(text) }); }
      else if (type === 'agentMessage') { if (typeof raw.text === 'string' && raw.text.trim()) items.push({ ...base, kind:'assistant', text:clip(raw.text) }); }
      else if (type === 'reasoning') { const text = lines(raw.summary) || lines(raw.content); if (text.trim()) items.push({ ...base, kind:'reasoning', text:clip(text), status:running ? 'running' : 'completed' }); }
      else if (type) {
        const name = String(raw.command ?? raw.title ?? raw.name ?? raw.tool ?? raw.query ?? type).slice(0, 4096);
        const supplied = raw.aggregatedOutput ?? raw.output;
        const output = supplied == null ? '' : clip(typeof supplied === 'string' ? supplied : JSON.stringify(supplied) ?? '');
        items.push({ ...base, kind:'tool', text:name + (output ? '\n' + output : ''), status:toolStatus(raw.status, running), data:{ ...toolEventDetails(raw), providerItemId:rawId, threadId, type, name, output } });
      }
    }
  }
  const last = turns.at(-1), threadStatus = isRecord(thread.status) ? thread.status.type : thread.status;
  const status: SubagentTranscriptStatus = last?.status === 'inProgress' || last?.status === 'running' || threadStatus === 'active' ? 'running'
    : last?.status === 'failed' || threadStatus === 'systemError' ? 'failed' : last?.status === 'interrupted' ? 'interrupted' : last?.status === 'completed' ? 'completed' : 'unknown';
  return {
    items:items.slice(-MAX_ITEMS), status, ...(startedAt ? { startedAt } : {}), ...(updatedAt ? { updatedAt } : {}),
    ...(str(thread.agentNickname) ? { name:thread.agentNickname as string } : {}), ...(str(thread.agentRole) ? { role:thread.agentRole as string } : {}),
    ...(str(thread.model) ? { model:thread.model as string } : {}),
  };
}

/** Subagents domain. Handlers are keyed by the command names in shared/domains/subagents-protocol.ts. */
export function createSubagentsDomain(context: DomainContext, deps: SubagentsDeps = {}): DomainModule {
  let loaded: TranscriptCore | undefined;
  const core = deps.core ?? (() => loaded ??= createRequire(__filename)(join(__dirname, 'core-client.cjs')) as TranscriptCore);
  const instances = deps.instances ?? (() => configuredProviderInstances());
  const now = deps.now ?? Date.now;
  const allowed = new Map<string, Set<string>>();
  // A live read reuses the parent's warm app-server and is cheap. A cold read spawns
  // one, so its result is reused (briefly while the child still runs) instead of per poll.
  const cache = new Map<string, { at: number; value: SubagentTranscript }>();
  const inflight = new Map<string, Promise<SubagentTranscript>>();
  const remember = (key: string, value: SubagentTranscript) => { cache.delete(key); cache.set(key, { at:now(), value }); if (cache.size > CACHE) cache.delete(cache.keys().next().value!); };
  const route = (chat: Chat, providerId: string) => instances().find(instance => instance.info.id === providerId);

  async function read(chat: Chat, threadId: string): Promise<SubagentTranscript> {
    const params: ReadParams = { threadId, includeTurns:true };
    const liveRoute = route(chat, chat.providerId ?? 'hybrow');
    let response: Record<string, unknown> | undefined, source: SubagentTranscript['source'] = 'live';
    if (liveRoute) {
      const key = `agent:${chat.id}:${liveRoute.info.id}:${liveRoute.info.bindingId ?? liveRoute.info.id}`;
      try { response = await core().callCodexConversation(key, 'thread/read', params, { requireOwner:true, timeoutMs:4000 }); }
      catch (error) { if (!/No live app-server owner/.test(error instanceof Error ? error.message : String(error))) throw error; }
    }
    if (!response) {
      // Never fall back to another account: the saved thread lives on its own binding.
      const saved = route(chat, chat.providerThreadProviderId ?? chat.providerId ?? 'hybrow');
      if (!saved?.info.available || (chat.providerThreadBindingId && (saved.info.bindingId ?? saved.info.id) !== chat.providerThreadBindingId)) throw new Error('The provider account that ran this subagent is unavailable.');
      const query = core().queryCodexAppServer;
      if (typeof query !== 'function' || !existsSync(saved.command)) throw new Error('Reading saved subagent threads is unavailable in this build.');
      let cwd = process.cwd();
      try { if (chat.folderId) cwd = context.folderFor(chat.folderId).path; } catch {}
      response = await query('thread/read', params, { command:saved.command, cwd, timeoutMs:8000, env:saved.env });
      source = 'provider';
    }
    const thread = isRecord(response?.thread) ? response.thread : undefined;
    if (!thread || thread.id !== threadId) throw new Error('The provider did not return this subagent thread.');
    return { threadId, source, ...normalizeChildThread(chat.id, threadId, thread) };
  }

  /** The chat and one of its reported child threads, or a thrown reason. */
  function child(input: Record<string, unknown>): { chat: Chat; threadId: string } {
    const chatId = input.chatId, threadId = input.threadId;
    if (typeof chatId !== 'string' || typeof threadId !== 'string' || !threadId || threadId.length > 256 || /[\x00-\x1f]/.test(threadId)) throw new Error('Invalid subagent reference.');
    const chat = context.store.chat(chatId);
    if (!chat) throw new Error('Conversation not found.');
    let ids = allowed.get(chatId);
    if (!ids?.has(threadId)) { ids = reportedChildIds(context.store.timeline(chatId)); allowed.set(chatId, ids); }
    if (!ids.has(threadId)) throw new Error('This conversation has not reported that subagent.');
    return { chat, threadId };
  }
  /** Only a Codex app-server route owns child threads Muster can address; CLI and API adapters run subagents out of reach. */
  function capabilities(chat: Chat): SubagentControlCapabilities {
    if (route(chat, chat.providerId ?? 'hybrow')) return { stop:true, steer:true };
    return { stop:false, steer:false, reason:'This chat’s provider runs subagents inside its own process, so Muster cannot stop or steer one on its own. Stop or steer the parent chat instead.' };
  }
  const SESSION_CLOSED = 'The parent chat’s provider session has closed, so this subagent can no longer be stopped or steered. Send the parent a message to direct it.';
  async function control(chat: Chat, threadId: string, action: 'stop' | 'steer', text: string): Promise<SubagentControlResult> {
    const able = capabilities(chat);
    if (!able[action]) return { ok:false, reason:able.reason };
    const live = route(chat, chat.providerId ?? 'hybrow')!;
    const key = `agent:${chat.id}:${live.info.id}:${live.info.bindingId ?? live.info.id}`;
    const call = (method: 'thread/read' | 'turn/interrupt' | 'turn/steer', params: Record<string, unknown>, timeoutMs: number) => core().callCodexConversation(key, method, params, { requireOwner:true, timeoutMs });
    const message = (error: unknown) => error instanceof Error ? error.message : String(error);
    let thread: Record<string, unknown> | undefined;
    try { const response = await call('thread/read', { threadId, includeTurns:true }, 4000); thread = isRecord(response?.thread) ? response.thread : undefined; }
    catch (error) { return { ok:false, reason:/No live app-server owner/.test(message(error)) ? SESSION_CLOSED : `The provider could not read this subagent: ${message(error)}` }; }
    const turns = Array.isArray(thread?.turns) ? thread.turns.filter(isRecord) : [];
    const active = turns.findLast(turn => turn.status === 'inProgress' || turn.status === 'running');
    const turnId = str(active?.id);
    if (!turnId) return { ok:false, reason:'This subagent has no running turn to ' + (action === 'stop' ? 'stop.' : 'steer.') };
    try {
      if (action === 'stop') await call('turn/interrupt', { threadId, turnId }, 15_000);
      // Codex `turn/steer` names the turn it expects, so a steer never lands in a newer turn.
      else await call('turn/steer', { threadId, expectedTurnId:turnId, input:[{ type:'text', text }] }, 15_000);
    } catch (error) {
      const reason = message(error);
      if (/No live app-server owner/.test(reason)) return { ok:false, reason:SESSION_CLOSED };
      if (/no active turn/i.test(reason)) return { ok:false, reason:'This subagent finished before the request arrived.' };
      const kind = /cannot steer a (review|compact) turn/i.exec(reason)?.[1]?.toLowerCase();
      return { ok:false, reason:kind ? `A ${kind} turn can’t be steered.` : `The provider refused: ${reason}` };
    }
    cache.delete(`${chat.id}\0${threadId}`);
    return { ok:true };
  }

  return {
    handlers: {
      'subagents.capabilities': input => {
        const chat = typeof input.chatId === 'string' ? context.store.chat(input.chatId) : undefined;
        if (!chat) throw new Error('Conversation not found.');
        return capabilities(chat);
      },
      'subagents.control': async input => {
        const { chat, threadId } = child(input), action = input.action;
        if (action !== 'stop' && action !== 'steer') throw new Error('Invalid subagent action.');
        const text = typeof input.text === 'string' ? input.text.trim() : '';
        if (action === 'steer' && (!text || text.length > SUBAGENT_STEER_MAX || text.includes('\0'))) throw new Error(`Write a steer message under ${SUBAGENT_STEER_MAX} characters.`);
        return control(chat, threadId, action, text);
      },
      'subagents.transcript': async input => {
        const { chat, threadId } = child(input), chatId = chat.id;
        const key = `${chatId}\0${threadId}`, hit = cache.get(key);
        if (hit && now() - hit.at < (hit.value.status === 'running' || hit.value.status === 'unknown' ? COLD_RUNNING_TTL : COLD_SETTLED_TTL)) return hit.value;
        const pending = inflight.get(key);
        if (pending) return pending;
        const promise = read(chat, threadId).then(value => { if (value.source === 'provider') remember(key, value); else cache.delete(key); return value; }).finally(() => inflight.delete(key));
        inflight.set(key, promise);
        return promise;
      },
    },
    dispose() { cache.clear(); allowed.clear(); },
  };
}
