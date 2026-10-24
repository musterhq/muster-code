/**
 * Never end on a promise: when a background process the agent started outlives the turn that started it
 * ("I'll report back when the build finishes"), its exit queues one synthetic follow-up through the chat queue,
 * so the agent wakes up and keeps that promise. The queue applies the usual running/paused rules.
 *
 * It fires only when all of these hold:
 *  - the process is agent-owned (never a command or terminal the user started);
 *  - the chat's last turn ended while the process was still running (a process that exits mid-turn is seen by the
 *    agent itself);
 *  - the chat still exists, is not archived, is not mid-turn now, and its last turn was not stopped by the user;
 *  - the process ended on its own (not stopped by the user);
 *  - at most once per process.
 */
import type {ChatStatus} from '../shared/protocol.ts';
import type {ProcessSnapshot} from '../shared/process-protocol.ts';

export const PROCESS_TAIL_LINES = 40;
const MAX_TAIL_CHARS = 16 * 1024;
const BUSY: ReadonlySet<ChatStatus> = new Set<ChatStatus>(['running', 'stopping', 'waiting', 'queued', 'reconnecting']);

export type ProcessExit = Pick<ProcessSnapshot, 'chatId' | 'processId' | 'label' | 'status' | 'exitCode' | 'signal' | 'owner' | 'output'>;
export interface ChatLike {id: string; status: ChatStatus; archived?: boolean}

/** The last `lines` lines of a process's output (bounded), without a trailing blank line. */
export function outputTail(output: string, lines = PROCESS_TAIL_LINES): string {
  const rows = output.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  const tail = rows.slice(-lines).join('\n');
  return tail.length > MAX_TAIL_CHARS ? tail.slice(tail.length - MAX_TAIL_CHARS) : tail;
}

export function processContinuationText(exit: ProcessExit): string {
  const how = exit.exitCode !== null && exit.exitCode !== undefined ? `exit code ${exit.exitCode}` : exit.signal ? `signal ${exit.signal}` : exit.status === 'failed' ? 'it failed to run' : 'no exit code';
  const tail = outputTail(exit.output ?? '');
  return [
    `Background process "${exit.label}" exited (${how}) after your last turn ended.`,
    tail ? `Last ${PROCESS_TAIL_LINES} lines of its output:\n\`\`\`\n${tail}\n\`\`\`` : 'It printed no output.',
    'Continue the task from here: check the result, carry on with the next step, and report what happened.',
  ].join('\n\n');
}

/** Request ids reach chat.queue.add, which accepts [a-zA-Z0-9_-] only. One id per process keeps a resend idempotent. */
export const continuationRequestId = (processId: string): string => `process-exit-${processId.replace(/[^a-zA-Z0-9_-]/g, '-')}`.slice(0, 128);

export class ProcessContinuations {
  private statuses = new Map<string, ChatLike>();
  /** Agent processes whose chat's turn ended while they were still running. */
  private awaiting = new Map<string, string>();
  /** Processes that already queued (or were ruled out of) a continuation: never twice. */
  private settled = new Set<string>();
  constructor(private deps: {
    /** Live agent-owned processes of a chat (process ids). */
    agentProcesses(chatId: string): string[];
    enqueue(chatId: string, text: string, requestId: string): Promise<unknown> | void;
  }) {}

  /** Feed every snapshot's chats: a busy → settled transition is a turn end. Chats that disappear were deleted. */
  observe(chats: readonly ChatLike[]): void {
    const seen = new Set<string>();
    for (const chat of chats) {
      seen.add(chat.id);
      const before = this.statuses.get(chat.id);
      this.statuses.set(chat.id, {id: chat.id, status: chat.status, ...(chat.archived ? {archived: true} : {})});
      if (before && BUSY.has(before.status) && !BUSY.has(chat.status)) this.turnEnded(chat.id, chat.status);
    }
    for (const id of [...this.statuses.keys()]) if (!seen.has(id)) { this.statuses.delete(id); this.forget(id); }
  }

  turnEnded(chatId: string, status: ChatStatus): void {
    // The user stopped the turn: whatever was running is no longer a promise the agent has to keep.
    if (status === 'interrupted') { this.forget(chatId); return; }
    for (const processId of this.deps.agentProcesses(chatId)) if (!this.settled.has(processId)) this.awaiting.set(processId, chatId);
  }

  /** Drops every pending continuation of a chat (deleted, or stopped by the user). */
  forget(chatId: string): void {
    for (const [processId, owner] of this.awaiting) if (owner === chatId) { this.awaiting.delete(processId); this.settled.add(processId); }
  }

  /** Returns true when a continuation was queued. */
  exited(exit: ProcessExit): boolean {
    if (this.settled.has(exit.processId)) return false;
    this.settled.add(exit.processId);
    if (this.settled.size > 4096) this.settled.delete(this.settled.values().next().value!);
    const waiting = this.awaiting.get(exit.processId) === exit.chatId;
    this.awaiting.delete(exit.processId);
    if (!waiting || exit.owner !== 'agent' || exit.status === 'stopped' || exit.status === 'lost') return false;
    const chat = this.statuses.get(exit.chatId);
    if (!chat || chat.archived || BUSY.has(chat.status) || chat.status === 'interrupted') return false;
    try { void Promise.resolve(this.deps.enqueue(exit.chatId, processContinuationText(exit), continuationRequestId(exit.processId))).catch(() => {}); }
    catch { return false; }
    return true;
  }
}
