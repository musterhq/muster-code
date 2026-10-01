/**
 * The app-wide Inbox (#115, #121): one activity centre for every chat and run. It is built from what the app already
 * tracks — each chat's pending approvals and questions (snapshot.attention), its run status and unread flag, and the
 * workspace's needs-you items (task reviews, blocked or failed work, mailbox mail, Paperclip attention when connected).
 * Nothing is stored twice; this only sorts existing state into buckets.
 *
 * The badge (#189) counts what still needs you: pending approvals and questions always, a chat that failed, was
 * interrupted or is waiting only while it is unread (not opened since). Once opened, a problem stays listed under
 * Problems for the same 3 days as Done, then drops off. Dismiss hides an item until it changes: dismissals are keyed by
 * item id and the item's `at`, so a new failure in the same chat shows again.
 */
import type { Snapshot } from '../shared/protocol';
import type { InboxKind, WorkspaceSnapshot } from '../shared/domains/paperclip-protocol';
import type { INBOX_BUCKETS } from '../shared/workspace-names';
import { decisionOverdue, type InboxMeta } from '../shared/domains/work-protocol.ts';

export type InboxBucket = keyof typeof INBOX_BUCKETS;
export type InboxAction = { kind: 'chat'; chatId: string } | { kind: 'task'; taskId: string } | { kind: 'agent'; agentId: string } | { kind: 'none' };
export interface ActivityItem {
  id: string; bucket: InboxBucket; title: string; why: string; at: string; group: string; unread: boolean;
  source: 'chat' | 'muster' | 'paperclip'; kind: string; action: InboxAction;
  /** Workspace items: the project, task and agent they are about (decide-by, recommendations and gates need them). */
  projectId?: string | null; taskId?: string | null; agentId?: string | null;
}

const KIND_BUCKET: Record<InboxKind, InboxBucket> = { question: 'needs', approval: 'needs', review: 'review', blocked: 'problems', failed_run: 'problems', agent_error: 'problems', budget: 'problems', mail: 'mentions', mention: 'mentions', other: 'review' };
const DONE_WINDOW_MS = 3 * 86_400_000;
/** A turn cut short because Muster quit is not a failure: it can simply be continued. */
export const INTERRUPTED_WHY = 'Interrupted when Muster quit — continue?';
/** Item id → the `at` it was dismissed at. */
export type Dismissals = ReadonlyMap<string, string>;

/** `covered`: more run chats to leave out (the sidebar passes the badge's, as it has no workspace snapshot). */
export function buildActivity(app: Pick<Snapshot, 'chats' | 'folders' | 'projects' | 'attention'> | null | undefined, workspace: WorkspaceSnapshot | null | undefined, now = Date.now(), covered: Iterable<string> = [], dismissed: Dismissals = EMPTY): ActivityItem[] {
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
    } else if ((chat.status === 'failed' || chat.status === 'interrupted') && (chat.unread || now - Date.parse(chat.updatedAt) < DONE_WINDOW_MS)) {
      items.push({ id: `chat-problem:${chat.id}`, bucket: 'problems', title: chat.title || 'Untitled chat', why: chat.status === 'interrupted' ? INTERRUPTED_WHY : chat.error || 'The last turn failed. Open the chat to retry.', at: chat.updatedAt, group, unread: Boolean(chat.unread), source: 'chat', kind: chat.status, action: open });
    } else if (chat.status === 'completed' && now - Date.parse(chat.updatedAt) < DONE_WINDOW_MS) {
      items.push({ id: `chat-done:${chat.id}`, bucket: 'done', title: chat.title || 'Untitled chat', why: chat.unread ? 'Finished — not opened yet.' : 'Finished.', at: chat.updatedAt, group, unread: Boolean(chat.unread), source: 'chat', kind: 'completed', action: open });
    }
  }
  for (const item of workspace?.inbox ?? []) {
    items.push({ id: `ws:${item.id}`, bucket: KIND_BUCKET[item.kind], title: item.title, why: item.why, at: item.at, group: item.group ?? workspace?.paperclip?.company?.name ?? 'Muster', unread: item.severity === 'high',
      source: item.source === 'paperclip' ? 'paperclip' : 'muster', kind: item.kind, projectId: item.projectId ?? null, taskId: item.taskId, agentId: item.agentId,
      action: item.taskId ? { kind: 'task', taskId: item.taskId } : item.agentId ? { kind: 'agent', agentId: item.agentId } : { kind: 'none' } });
  }
  return items.filter(i => dismissed.get(i.id) !== i.at).sort((a, b) => Number(b.unread) - Number(a.unread) || b.at.localeCompare(a.at));
}
const EMPTY: Dismissals = new Map();

/** Whether an item counts toward the badge: Needs you and Problems only, and a chat's own status only while unread. */
export const badges = (item: ActivityItem) => (item.bucket === 'needs' || item.bucket === 'problems') && (item.source !== 'chat' || item.unread);
/** What the sidebar badge shows. */
export const badgeCount = (items: readonly ActivityItem[]) => items.filter(badges).length;

// ── Views: Mine, Unread, Snoozed (C4) and the decisions desk (G37) ───────────────────────────────────────────────────────
export type InboxView = 'all' | 'mine' | 'unread' | 'snoozed';
export const INBOX_VIEW_LABEL: Record<InboxView, string> = { all: 'All', mine: 'Mine', unread: 'Unread', snoozed: 'Snoozed' };
export type InboxMetaMap = ReadonlyMap<string, InboxMeta>;
/** A snooze holds only for the item as it was (`at`) and only until its time: a newer item (a new failure) is awake again. */
export const snoozedNow = (item: Pick<ActivityItem, 'id' | 'at'>, meta: InboxMetaMap, now = Date.now()): boolean => { const m = meta.get(item.id); return Boolean(m?.snoozedUntil && Date.parse(m.snoozedUntil) > now && m.snoozedFor === item.at); };
/** Unread: the item's own unread flag, unless you marked it read at this very time. */
export const unreadNow = (item: Pick<ActivityItem, 'id' | 'at' | 'unread'>, meta: InboxMetaMap): boolean => item.unread && meta.get(item.id)?.readFor !== item.at;
/** Mine: a chat of yours, anything waiting for your decision, review or mail, and work owned by you. */
export const isMine = (item: ActivityItem, taskOwner: (taskId: string) => string | null | undefined): boolean =>
  item.source === 'chat' || item.bucket === 'needs' || item.bucket === 'review' || item.bucket === 'mentions' || Boolean(item.taskId && taskOwner(item.taskId) === 'user:local');
export function applyView(items: readonly ActivityItem[], view: InboxView, meta: InboxMetaMap, taskOwner: (taskId: string) => string | null | undefined, now = Date.now()): ActivityItem[] {
  const awake = items.filter(i => !snoozedNow(i, meta, now));
  if (view === 'snoozed') return items.filter(i => snoozedNow(i, meta, now));
  return view === 'mine' ? awake.filter(i => isMine(i, taskOwner)) : view === 'unread' ? awake.filter(i => unreadNow(i, meta)) : awake;
}
/** Decisions with a decide-by date come first, the most overdue before the nearest; the rest keep their order. */
export function decisionOrder(items: readonly ActivityItem[], meta: InboxMetaMap, now = Date.now()): ActivityItem[] {
  const by = (i: ActivityItem) => meta.get(i.id)?.decideBy ?? null;
  return items.map((item, index) => ({ item, index })).sort((a, b) => {
    const da = a.item.bucket === 'needs' ? by(a.item) : null, db = b.item.bucket === 'needs' ? by(b.item) : null;
    if (da && db) return da.localeCompare(db) || a.index - b.index;
    if (da || db) return da ? -1 : 1;
    return a.index - b.index;
  }).map(x => x.item);
}
export const overdueDecision = (item: ActivityItem, meta: InboxMetaMap, now = Date.now()): boolean => item.bucket === 'needs' && decisionOverdue(meta.get(item.id)?.decideBy ?? null, now);
/** The next moment a snooze ends, so the page can wake itself once instead of polling. */
export function nextWake(items: readonly ActivityItem[], meta: InboxMetaMap, now = Date.now()): number | null {
  let next: number | null = null;
  for (const i of items) { const m = meta.get(i.id); if (m?.snoozedUntil && m.snoozedFor === i.at) { const t = Date.parse(m.snoozedUntil); if (t > now && (next === null || t < next)) next = t; } }
  return next;
}
