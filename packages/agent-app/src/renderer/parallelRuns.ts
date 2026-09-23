/**
 * CHAT-06: two chats working in the same checkout. Pure rules (no React, no store) for: which chats share a
 * checkout and are mid-run, which pending edits each chat owns, where they overlap, and whether "Run in a
 * worktree" can be offered. components/ParallelRunGuard.tsx asks the user; Changes shows the owners.
 */
import type { Chat, Folder } from '../shared/protocol.ts';

/** A chat in any of these is mid-run: a second run in its checkout could write the same files. */
export const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set(['running', 'stopping', 'waiting', 'reconnecting']);

export function isRunActive(chat: { readonly status: string }): boolean { return ACTIVE_RUN_STATUSES.has(chat.status); }

/** One checkout = one directory on disk: two folder entries with the same path are the same checkout. */
export function checkoutKey(folderId: string | undefined, folders: readonly Pick<Folder, 'id' | 'path'>[]): string | undefined {
  if (!folderId) return undefined;
  const folder = folders.find((item) => item.id === folderId);
  return folder ? folder.path.replace(/[\\/]+$/, '') || folder.path : `id:${folderId}`;
}

/** Other unarchived chats running right now in the same checkout as `folderId`. */
export function checkoutSiblings(chatId: string, folderId: string | undefined, chats: readonly Chat[], folders: readonly Pick<Folder, 'id' | 'path'>[]): Chat[] {
  const key = checkoutKey(folderId, folders);
  if (!key) return [];
  return chats.filter((chat) => chat.id !== chatId && !chat.archived && isRunActive(chat) && checkoutKey(chat.folderId, folders) === key);
}

/** A file a chat edited (runtime `chat.editOwners`), folder-relative. */
export interface EditOwner { readonly path: string; readonly chatId: string; readonly title: string; readonly status: string }

/** Owners of each path, newest-active first, one entry per chat. `pending` (uncommitted paths) narrows to pending edits. */
export function ownersByPath(owners: readonly EditOwner[], pending?: ReadonlySet<string> | null): Map<string, EditOwner[]> {
  const out = new Map<string, EditOwner[]>();
  for (const owner of owners) {
    if (pending && !pending.has(owner.path)) continue;
    const list = out.get(owner.path) ?? [];
    if (!list.some((item) => item.chatId === owner.chatId)) list.push(owner);
    out.set(owner.path, list);
  }
  for (const list of out.values()) list.sort((a, b) => Number(isRunActive(b)) - Number(isRunActive(a)));
  return out;
}

/** Each chat's pending edits (paths in `pending` it edited), for the chats asked about. */
export function pendingEditsByChat(owners: readonly EditOwner[], chatIds: readonly string[], pending?: ReadonlySet<string> | null): Map<string, string[]> {
  const out = new Map<string, string[]>(chatIds.map((id) => [id, []]));
  for (const owner of owners) {
    const list = out.get(owner.chatId);
    if (!list || (pending && !pending.has(owner.path)) || list.includes(owner.path)) continue;
    list.push(owner.path);
  }
  for (const list of out.values()) list.sort();
  return out;
}

/** Paths this chat already edited that a sibling chat has also edited (or is editing): the real collision risk. */
export function overlappingPaths(owners: readonly EditOwner[], chatId: string, siblingIds: readonly string[], pending?: ReadonlySet<string> | null): string[] {
  const mine = new Set(owners.filter((owner) => owner.chatId === chatId).map((owner) => owner.path));
  const siblings = new Set(siblingIds);
  const out = new Set<string>();
  for (const owner of owners) if (siblings.has(owner.chatId) && mine.has(owner.path) && (!pending || pending.has(owner.path))) out.add(owner.path);
  return [...out].sort();
}

/** Branch for "Run in a worktree": `muster/<title-slug>-<MMDD-HHMM>`, always a valid ref name. */
export function worktreeBranchName(title: string, now: Date = new Date()): string {
  const slug = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '') || 'chat';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `muster/${slug}-${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

export interface WorktreeFacts {
  /** null while the Git check is still in flight. */
  readonly isGitRepo: boolean | null;
  /** The chat already has messages: the run moves to a NEW chat in the worktree, so staged attachments cannot follow. */
  readonly hasHistory: boolean;
  readonly hasAttachments: boolean;
  /** Project chats may only use the Project's folders; a fresh worktree is not one of them. */
  readonly inProject?: boolean;
}

export function worktreeOption(facts: WorktreeFacts): { enabled: boolean; reason?: string; detail: string } {
  const detail = facts.hasHistory ? 'Starts a new chat on its own branch and checkout with this message' : 'Moves this chat to its own branch and checkout, then sends';
  if (facts.isGitRepo === null) return { enabled: false, reason: 'Checking Git…', detail };
  if (!facts.isGitRepo) return { enabled: false, reason: 'This folder is not a Git repository', detail };
  if (facts.inProject) return { enabled: false, reason: 'Project chats stay in the Project’s folders; queue instead', detail };
  if (facts.hasHistory && facts.hasAttachments) return { enabled: false, reason: 'Attachments stay with this chat; send without them or queue instead', detail };
  return { enabled: true, detail };
}

/** The user's answer to "another chat is working here". */
export type ParallelRunChoice = 'worktree' | 'queue' | 'run' | 'cancel';
