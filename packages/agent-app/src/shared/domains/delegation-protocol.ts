/** Delegation domain contract (#44): an agent starts a child chat on any configured provider and controls it. */
import type { ChatStatus } from '../protocol.ts';

/** How many chats deep delegation may go below the chat the user started (child 1, grandchild 2, …). */
export const DELEGATION_MAX_DEPTH = 3;
/** Children of one chat that may be working at the same time. */
export const DELEGATION_MAX_ACTIVE = 4;
/** wait:true and wait_task block at most this long (the default wait is 5 minutes). */
export const DELEGATION_DEFAULT_WAIT_MS = 5 * 60_000;
export const DELEGATION_MAX_WAIT_MS = 10 * 60_000;

/** One child chat another chat started. `status` is the child chat's own status. */
export interface DelegatedTask {
  id: string; parentChatId: string; rootChatId: string; depth: number; title: string;
  providerId?: string; model: string; status: ChatStatus; createdAt: string; finishedAt?: string;
}
/** `data` of the transcript rows delegation writes. 'delegated-task' rides in the parent, 'delegated-from' in the child. */
export interface DelegatedTaskNotice { kind: 'delegated-task'; childChatId: string; title: string; model: string; providerId?: string; state: 'started' | 'finished' | 'failed' | 'stopped' }
export interface DelegatedFromNotice { kind: 'delegated-from'; parentChatId: string; parentTitle: string }
/** On a parent's copy of a child's approval or question card: the card it answers. */
export interface DelegatedAttention { chatId: string; itemId: string; title: string }

export interface DelegationCommands {
  /** The chats this chat started directly, oldest first. */
  'delegation.children': { input: { chatId: string }; output: DelegatedTask[] };
  /** Stops every working chat this chat started, and theirs. */
  'delegation.stopChildren': { input: { chatId: string }; output: { stopped: number } };
}
export type DelegationEvent = never;
export const DELEGATION_COMMANDS = { 'delegation.children': true, 'delegation.stopChildren': true } as const satisfies Record<keyof DelegationCommands, true>;
