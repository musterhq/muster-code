/** Pure Project overview helpers, kept free of React so node tests can import them. */
import type { PendingAttentionSummary } from '../shared/attention-protocol.ts';

type Status = 'todo' | 'running' | 'blocked' | 'implemented' | 'verified';
export interface ProjectRollup { running: number; blocked: number; needsInput: number; implemented: number; verified: number; todo: number; total: number }

/** Task-state counts plus chats of this Project waiting on an approval or question. */
export function projectRollup(tasks: readonly { status: Status }[], chatIds: readonly string[], attention?: PendingAttentionSummary): ProjectRollup {
  const r: ProjectRollup = { running: 0, blocked: 0, needsInput: 0, implemented: 0, verified: 0, todo: 0, total: tasks.length };
  for (const t of tasks) r[t.status]++;
  const ids = new Set(chatIds);
  r.needsInput = attention?.chats.filter(c => ids.has(c.chatId) && c.approvalCount + c.questionCount > 0).length ?? 0;
  return r;
}

/** Stored actors are internal ids; 'main' is the legacy spelling of the user. */
const ID_LIKE = /^(?:chat[:/])?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Human label for an activity actor. Chat ids resolve to the chat's title; raw ids are never shown. */
export function actorLabel(actor: string, chats?: ReadonlyArray<{id: string; title: string}>): string {
  if (actor === 'main' || actor === 'user') return 'You';
  if (actor === 'agent') return 'Agent';
  if (actor === 'system') return 'Muster';
  if (ID_LIKE.test(actor)) {
    const id = actor.replace(/^chat[:/]/i, '');
    const title = chats?.find(chat => chat.id === id)?.title;
    return title ? `Chat “${title.length > 40 ? `${title.slice(0, 39)}…` : title}”` : 'A chat';
  }
  return actor;
}
