/**
 * The app-wide Inbox (#115, #121): one activity centre for every chat and run. It is built from what the app already
 * tracks — each chat's pending approvals and questions (snapshot.attention), its run status and unread flag, and the
 * workspace's needs-you items (task reviews, blocked or failed work, mailbox mail, Paperclip attention when connected).
 * Nothing is stored twice; this only sorts existing state into buckets.
 */
import type { Snapshot } from '../shared/protocol';
import type { InboxKind, WorkspaceSnapshot } from '../shared/domains/paperclip-protocol';
import type { INBOX_BUCKETS } from '../shared/workspace-names';

export type InboxBucket = keyof typeof INBOX_BUCKETS;
export type InboxAction = { kind: 'chat'; chatId: string } | { kind: 'task'; taskId: string } | { kind: 'agent'; agentId: string } | { kind: 'none' };
export interface ActivityItem {
  id: string; bucket: InboxBucket; title: string; why: string; at: string; group: string; unread: boolean;
  source: 'chat' | 'muster' | 'paperclip'; kind: string; action: InboxAction;
}

const KIND_BUCKET: Record<InboxKind, InboxBucket> = { question: 'needs', approval: 'needs', review: 'review', blocked: 'problems', failed_run: 'problems', agent_error: 'problems', budget: 'problems', mail: 'mentions', mention: 'mentions', other: 'review' };
const DONE_WINDOW_MS = 3 * 86_400_000;

/** `covered`: more run chats to leave out (the sidebar passes the badge's, as it has no workspace snapshot). */
export function buildActivity(app: Pick<Snapshot, 'chats' | 'folders' | 'projects' | 'attention'> | null | undefined, workspace: WorkspaceSnapshot | null | undefined, now = Date.now(), covered: Iterable<string> = []): ActivityItem[] {
  const items: ActivityItem[] = [];
  // A project task's run chat is represented by its task row; listing the chat as well would count it twice.
  const taskChats = new Set([...covered, ...(workspace?.inbox ?? []).flatMap(i => i.chatIds ?? [])]);
  const chats = app?.chats ?? [];
  const groupOf = (chat: { folderId?: string; projectId?: string }) => app?.projects.find(p => p.id === chat.projectId)?.name ?? app?.folders.find(f => f.id === chat.folderId)?.name ?? 'Chats';
  const asking = new Map((app?.attention?.chats ?? []).map(a => [a.chatId, a]));
  for (const chat of chats) {
    if (chat.archived || taskChats.has(chat.id)) continue;
    const attention = asking.get(chat.id), group = groupOf(chat), open = { kind: 'chat' as const, chatId: chat.id };
    if (attention && (attention.approvalCount || attention.questionCount)) {
      const why = [attention.approvalCount ? `${attention.approvalCount} ${attention.approvalCount === 1 ? 'approval' : 'approvals'} waiting` : '', attention.questionCount ? `${attention.questionCount} ${attention.questionCount === 1 ? 'question' : 'questions'} for you` : ''].filter(Boolean).join(' · ');
      items.push({ id: `chat-needs:${chat.id}`, bucket: 'needs', title: chat.title || 'Untitled chat', why, at: attention.requests.at(-1)?.createdAt ?? chat.updatedAt, group, unread: true, source: 'chat', kind: attention.approvalCount ? 'approval' : 'question', action: open });
    } else if (chat.status === 'waiting') {
      items.push({ id: `chat-needs:${chat.id}`, bucket: 'needs', title: chat.title || 'Untitled chat', why: 'Waiting for your input.', at: chat.updatedAt, group, unread: Boolean(chat.unread), source: 'chat', kind: 'question', action: open });
    } else if (chat.status === 'failed' || chat.status === 'interrupted') {
      items.push({ id: `chat-problem:${chat.id}`, bucket: 'problems', title: chat.title || 'Untitled chat', why: chat.error || (chat.status === 'failed' ? 'The last turn failed. Open the chat to retry.' : 'The last turn was interrupted. Open the chat to continue.'), at: chat.updatedAt, group, unread: Boolean(chat.unread), source: 'chat', kind: chat.status, action: open });
    } else if (chat.status === 'completed' && now - Date.parse(chat.updatedAt) < DONE_WINDOW_MS) {
      items.push({ id: `chat-done:${chat.id}`, bucket: 'done', title: chat.title || 'Untitled chat', why: chat.unread ? 'Finished — not opened yet.' : 'Finished.', at: chat.updatedAt, group, unread: Boolean(chat.unread), source: 'chat', kind: 'completed', action: open });
    }
  }
  for (const item of workspace?.inbox ?? []) {
    items.push({ id: `ws:${item.id}`, bucket: KIND_BUCKET[item.kind], title: item.title, why: item.why, at: item.at, group: item.group ?? workspace?.paperclip?.company?.name ?? 'Muster', unread: item.severity === 'high',
      source: item.source === 'paperclip' ? 'paperclip' : 'muster', kind: item.kind,
      action: item.taskId ? { kind: 'task', taskId: item.taskId } : item.agentId ? { kind: 'agent', agentId: item.agentId } : { kind: 'none' } });
  }
  return items.sort((a, b) => Number(b.unread) - Number(a.unread) || b.at.localeCompare(a.at));
}

/** What the sidebar badge shows: Needs you and Problems only. */
export const badgeCount = (items: readonly ActivityItem[]) => items.filter(i => i.bucket === 'needs' || i.bucket === 'problems').length;
