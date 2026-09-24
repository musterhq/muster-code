/**
 * Turns the Codex app-server starts on its own while Muster has no run in flight: a native goal
 * continuation (`thread/goal/*`) or a natively queued follow-up (`thread/queue/*`). They are
 * adopted as ordinary runs so the chat shows "running", streams its text, can be stopped, and
 * settles through the same hooks (goals, queue, notifications) as a turn Muster dispatched.
 *
 * Tool rows are already written by the provider's event stream; this module adds the turn
 * lifecycle, assistant/reasoning text and the user message of a native queued submission.
 * Muster imposes no timeout on an adopted turn: it ends when the app-server says so or the user stops it.
 */
import { randomUUID } from 'node:crypto';
import type { Chat, ChatStatus, TimelineItem } from '../shared/protocol.ts';
import type { AgentStore } from './store.ts';

export interface AdoptedRun { cwd: string; stopped: boolean; retry: AbortController; adopted: true; turnId: string; seal?(): void }

export interface NativeTurnHost {
  store: AgentStore;
  /** The service's active runs; an adopted run occupies the same slot so sends queue behind it. */
  runs: Map<string, { stopped: boolean; retry: AbortController; cwd: string; seal?(): void }>;
  state(): void;
  timeline(chatId: string): void;
  runStarted(chat: Chat, runId: string): void;
  runSettled(chat: Chat, runId: string, status: ChatStatus): void;
  afterRun(chatId: string, status: ChatStatus): void;
}

const text = (value: unknown): string => typeof value === 'string' ? value : '';
/** A userMessage item's text parts, joined. */
function userText(item: Record<string, unknown>): string {
  const content = Array.isArray(item.content) ? item.content : [];
  return content.map(part => part && typeof part === 'object' && (part as {type?: unknown}).type === 'text' ? text((part as {text?: unknown}).text) : '').filter(Boolean).join('\n');
}

export function createNativeTurnObserver(host: NativeTurnHost) {
  const adopted = new Map<string, { run: AdoptedRun; runId: string; segment?: TimelineItem; streamed: Set<string> }>();
  /** Events of a native turn that began while Muster's own run was still settling; replayed by drain(). */
  const pending = new Map<string, Array<[string, Record<string, unknown>]>>();
  const MAX_PENDING = 4096;
  const seal = (chatId: string) => {
    const entry = adopted.get(chatId);
    if (entry?.segment) { host.store.updateItem(entry.segment.id, entry.segment.text, 'completed'); entry.segment = undefined; }
  };
  const append = (chatId: string, kind: 'assistant' | 'reasoning', delta: string) => {
    const entry = adopted.get(chatId);
    if (!entry || !delta) return;
    if (entry.segment && entry.segment.kind !== kind) seal(chatId);
    if (!entry.segment) entry.segment = host.store.appendItem(chatId, kind, '', 'running');
    entry.segment = { ...entry.segment, text: entry.segment.text + delta };
    host.store.updateItem(entry.segment.id, entry.segment.text, 'running');
    host.timeline(chatId);
  };
  function finish(chatId: string, status: ChatStatus, error?: string) {
    const entry = adopted.get(chatId);
    if (!entry) return;
    seal(chatId);
    adopted.delete(chatId);
    if (host.runs.get(chatId) === entry.run) host.runs.delete(chatId);
    const final = entry.run.stopped && status !== 'failed' ? 'interrupted' : status;
    const chat = host.store.updateChat(chatId, { status: final, error: final === 'failed' ? error ?? 'The provider turn failed.' : null, recovery: null });
    if (final === 'failed' && error) host.store.appendItem(chatId, 'notice', error, 'failed');
    host.timeline(chatId); host.state();
    host.runSettled(chat, entry.runId, final);
    host.afterRun(chatId, final);
  }
  function event(chatId: string, method: string, params: Record<string, unknown>): void {
      const current = host.runs.get(chatId);
      if (current && !adopted.has(chatId) && (pending.has(chatId) || method === 'turn/started')) {
        const queued = pending.get(chatId) ?? [];
        if (queued.length < MAX_PENDING) queued.push([method, params]);
        pending.set(chatId, queued);
        return;
      }
      const chat = host.store.chat(chatId);
      if (!chat?.providerThreadId || params.threadId !== chat.providerThreadId) return;
      const turn = params.turn && typeof params.turn === 'object' ? params.turn as Record<string, unknown> : undefined;
      if (method === 'turn/started') {
        if (host.runs.has(chatId) || typeof turn?.id !== 'string' || chat.archived) return;
        const run: AdoptedRun = { cwd: '', stopped: false, retry: new AbortController(), adopted: true, turnId: turn.id };
        run.seal = () => seal(chatId);
        const runId = `native-${randomUUID()}`;
        adopted.set(chatId, { run, runId, streamed: new Set() });
        host.runs.set(chatId, run);
        const running = host.store.updateChat(chatId, { status: 'running', error: null, recovery: null, providerTurnId: turn.id });
        host.state(); host.timeline(chatId);
        host.runStarted(running, runId);
        return;
      }
      const entry = adopted.get(chatId);
      if (!entry) return;
      if (method === 'turn/completed') {
        if (turn?.id !== undefined && turn.id !== entry.run.turnId) return;
        const status = turn?.status === 'interrupted' ? 'interrupted' : turn?.status === 'failed' ? 'failed' : 'completed';
        const error = turn?.error && typeof turn.error === 'object' ? text((turn.error as {message?: unknown}).message) : '';
        finish(chatId, status, error || undefined);
        return;
      }
      if (method === 'item/agentMessage/delta') { entry.streamed.add(text(params.itemId)); append(chatId, 'assistant', text(params.delta)); return; }
      if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') { entry.streamed.add(text(params.itemId)); append(chatId, 'reasoning', text(params.delta)); return; }
      const item = params.item && typeof params.item === 'object' ? params.item as Record<string, unknown> : undefined;
      if (!item) return;
      if (method === 'item/started' && item.type === 'userMessage') {
        const message = userText(item);
        if (message) { seal(chatId); host.store.appendItem(chatId, 'user', message, 'completed', { native: true }); host.timeline(chatId); }
        return;
      }
      if (method === 'item/completed' && item.type === 'agentMessage' && !entry.streamed.has(text(item.id))) {
        const message = text(item.text);
        if (message) { append(chatId, 'assistant', message); seal(chatId); }
        return;
      }
      if (method === 'item/started' && item.type !== 'agentMessage' && item.type !== 'reasoning') seal(chatId);
  }
  return {
    /** Feed every event the provider reports while no Muster run is in flight. */
    event,
    /** Called once the service's own run has left the run map: replays a native turn that started meanwhile. */
    drain(chatId: string): void {
      const queued = pending.get(chatId);
      if (!queued || host.runs.has(chatId)) return;
      pending.delete(chatId);
      for (const [method, params] of queued) event(chatId, method, params);
    },
    /** A native turn started while Muster's run was settling and waits for drain(). */
    pendingTurn(chatId: string): boolean { return pending.has(chatId); },
    /** True when the chat's active run is a turn the app-server started itself. */
    adopted(chatId: string): boolean { return adopted.has(chatId); },
    /** After a stop request: settles the adopted run when the provider no longer holds a live session. */
    stopped(chatId: string, sessionAlive: boolean): void { if (adopted.has(chatId) && !sessionAlive) finish(chatId, 'interrupted'); },
    dispose(): void { adopted.clear(); pending.clear(); },
  };
}
