/**
 * CHAT-06 same-checkout isolation. Before a chat starts a run in a folder where another chat is still working,
 * the user chooses: run in a new worktree (existing git.worktree.create), queue until the other run finishes,
 * run anyway, or cancel. Overlapping pending edits (both chats edited the same uncommitted file) are named.
 *
 * Mount <ParallelRunHost/> once near the app root. Callers wrap their send in `sendWithCheckoutGuard`.
 */
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { GitBranch, Hourglass, Play, TriangleAlert, X } from 'lucide-react';
import type { Chat } from '../../shared/protocol';
import { invoke } from '../bridge';
import { createChat, getState, notifyError, notifySuccess, selectChat, setComposerDraft, subscribeStore } from '../store';
import {
  checkoutSiblings, overlappingPaths, pendingEditsByChat, worktreeBranchName, worktreeOption,
  type EditOwner, type ParallelRunChoice,
} from '../parallelRuns';
import './parallel-runs.css';

// --- Dialog request (module state, one at a time) -------------------------------------------

interface GuardRequest {
  readonly chat: Chat;
  readonly siblings: readonly Chat[];
  readonly hasAttachments: boolean;
  readonly hasHistory: boolean;
  resolve(choice: ParallelRunChoice): void;
}
let request: GuardRequest | null = null;
const requestListeners = new Set<() => void>();
function setRequest(next: GuardRequest | null): void { request = next; for (const listener of requestListeners) listener(); }

function askParallelRun(input: Omit<GuardRequest, 'resolve'>): Promise<ParallelRunChoice> {
  request?.resolve('cancel'); // a newer ask replaces an unanswered one
  return new Promise((resolve) => setRequest({ ...input, resolve: (choice) => { setRequest(null); resolve(choice); } }));
}

/** The unanswered question, if any (chat asking, chats it would collide with). */
export function pendingParallelRun(): { chatId: string; siblingIds: string[] } | null {
  return request ? { chatId: request.chat.id, siblingIds: request.siblings.map((chat) => chat.id) } : null;
}
/** Answers the open question as the dialog's buttons do (keyboard automation and tests). */
export function answerParallelRun(choice: ParallelRunChoice): void { request?.resolve(choice); }

// --- Cross-chat queue: "start when the other chat finishes" --------------------------------

interface QueuedRun { readonly blockers: readonly string[]; readonly settle: (how: 'send' | 'cancel') => void }
const queued = new Map<string, QueuedRun>();
const queueListeners = new Set<() => void>();
let queueVersion = 0;
function queueChanged(): void { queueVersion++; for (const listener of queueListeners) listener(); }

export function isCheckoutQueued(chatId: string): boolean { return queued.has(chatId); }
export function cancelCheckoutQueue(chatId: string): void { queued.get(chatId)?.settle('cancel'); }
export function sendQueuedNow(chatId: string): void { queued.get(chatId)?.settle('send'); }

function siblingsNow(chatId: string): Chat[] {
  const { snapshot } = getState();
  const chat = snapshot?.chats.find((item) => item.id === chatId);
  return snapshot && chat ? checkoutSiblings(chat.id, chat.folderId, snapshot.chats, snapshot.folders) : [];
}

/** Resolves 'send' once no other chat runs in this checkout (or the user says "Send now"), 'cancel' when withdrawn. */
function waitForCheckout(chatId: string): Promise<'send' | 'cancel'> {
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    const settle = (how: 'send' | 'cancel') => { unsubscribe(); queued.delete(chatId); queueChanged(); resolve(how); };
    const check = () => {
      const blockers = siblingsNow(chatId);
      if (!blockers.length) { settle('send'); return; }
      const titles = blockers.map((chat) => chat.title);
      const current = queued.get(chatId);
      if (!current || current.blockers.join('\n') !== titles.join('\n')) { queued.set(chatId, { blockers: titles, settle }); queueChanged(); }
    };
    queued.get(chatId)?.settle('cancel');
    unsubscribe = subscribeStore(check);
    check();
  });
}

// --- The guard ---------------------------------------------------------------------------------

/**
 * Sends through `send(chatId)` unless another chat is running in the same checkout, in which case the user
 * decides first. Resolves true once the message was sent (here or in a worktree chat), false if not sent.
 */
export async function sendWithCheckoutGuard(chatId: string, options: { hasAttachments: boolean }, send: (targetChatId: string) => Promise<boolean>): Promise<boolean> {
  const { snapshot, timelines } = getState();
  const chat = snapshot?.chats.find((item) => item.id === chatId);
  if (!chat?.folderId) return send(chatId);
  const siblings = siblingsNow(chatId);
  if (!siblings.length) return send(chatId);
  const hasHistory = (timelines[chatId]?.value ?? []).some((item) => item.kind === 'user');
  const choice = await askParallelRun({ chat, siblings, hasAttachments: options.hasAttachments, hasHistory });
  if (choice === 'cancel') return false;
  if (choice === 'run') return send(chatId);
  if (choice === 'queue') return (await waitForCheckout(chatId)) === 'send' ? send(chatId) : false;
  return runInWorktree(chat, hasHistory, send);
}

async function runInWorktree(chat: Chat, hasHistory: boolean, send: (targetChatId: string) => Promise<boolean>): Promise<boolean> {
  const branch = worktreeBranchName(chat.title);
  try {
    const { folder } = await invoke('git.worktree.create', { folderId: chat.folderId!, branch });
    if (!hasHistory) {
      // An empty chat simply moves: same chat, same composer (and attachments), new checkout.
      await invoke('chat.update', { id: chat.id, folderId: folder.id });
      const sent = await send(chat.id);
      if (sent) notifySuccess(`Running in worktree ${branch}`);
      return sent;
    }
    const text = getState().composerDrafts[chat.id]?.text ?? '';
    const id = await createChat(folder.id);
    if (!id) return false;
    const sent = await send(id);
    if (sent) {
      if ((getState().composerDrafts[chat.id]?.text ?? '') === text) setComposerDraft(chat.id, '');
      notifySuccess(`Running in a new chat on worktree ${branch}`, { label: 'Back to original', run: () => void selectChat(chat.id) });
    }
    return sent;
  } catch (cause) {
    notifyError(cause);
    return false;
  }
}

// --- UI ------------------------------------------------------------------------------------------

interface Facts { owners: EditOwner[]; pending: Set<string> | null; isGitRepo: boolean | null }

export function ParallelRunHost(): React.ReactElement | null {
  const current = useSyncExternalStore((listener) => { requestListeners.add(listener); return () => { requestListeners.delete(listener); }; }, () => request, () => request);
  if (!current) return null;
  return <ParallelRunDialog key={current.chat.id} request={current} />;
}

function ParallelRunDialog({ request: ask }: { request: GuardRequest }): React.ReactElement {
  const [facts, setFacts] = useState<Facts>({ owners: [], pending: null, isGitRepo: null });
  const primary = useRef<HTMLButtonElement>(null);
  const folderId = ask.chat.folderId!;
  useEffect(() => {
    let live = true;
    void Promise.allSettled([invoke('chat.editOwners', { folderId }), invoke('git.changes', { folderId }), invoke('git.info', { folderId })]).then(([owners, changes, info]) => {
      if (!live) return;
      setFacts({
        owners: owners.status === 'fulfilled' ? owners.value : [],
        pending: changes.status === 'fulfilled' ? new Set(changes.value.map((file) => file.path)) : null,
        isGitRepo: info.status === 'fulfilled',
      });
    });
    return () => { live = false; };
  }, [folderId]);
  const siblingIds = ask.siblings.map((chat) => chat.id);
  const edits = pendingEditsByChat(facts.owners, siblingIds, facts.pending);
  const overlap = overlappingPaths(facts.owners, ask.chat.id, siblingIds, facts.pending);
  const worktree = worktreeOption({ isGitRepo: facts.isGitRepo, hasHistory: ask.hasHistory, hasAttachments: ask.hasAttachments, inProject: !!ask.chat.projectId });
  const folderName = getState().snapshot?.folders.find((folder) => folder.id === folderId)?.name ?? 'this folder';
  const others = ask.siblings.length === 1 ? `“${ask.siblings[0].title}” is` : `${ask.siblings.length} other chats are`;

  return <Dialog.Root open onOpenChange={(open) => { if (!open) ask.resolve('cancel'); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="parallel-run-backdrop" />
      <Dialog.Popup className="parallel-run-dialog" initialFocus={primary} aria-label="Another chat is working in this folder">
        <div className="parallel-run-heading">
          <Dialog.Title><TriangleAlert size={15} aria-hidden="true" />Another chat is working in {folderName}</Dialog.Title>
          <Dialog.Close className="icon-button" aria-label="Cancel"><X size={16} /></Dialog.Close>
        </div>
        <Dialog.Description>{others} still running in the same checkout. Two runs editing one working tree can overwrite each other’s changes.</Dialog.Description>
        <ul className="parallel-run-siblings" aria-label="Chats working here">
          {ask.siblings.map((chat) => {
            const paths = edits.get(chat.id) ?? [];
            return <li key={chat.id}>
              <span className="parallel-run-sibling-title">{chat.title}</span>
              <span className="parallel-run-sibling-edits">{paths.length ? `${paths.length} pending edit${paths.length === 1 ? '' : 's'}: ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` +${paths.length - 3}` : ''}` : 'No pending edits yet'}</span>
            </li>;
          })}
        </ul>
        {overlap.length > 0 && <p className="parallel-run-overlap" role="alert">
          Both chats have edited {overlap.length === 1 ? 'this file' : `these ${overlap.length} files`}: {overlap.slice(0, 4).join(', ')}{overlap.length > 4 ? ` +${overlap.length - 4}` : ''}
        </p>}
        <div className="parallel-run-choices">
          <button ref={worktree.enabled ? primary : undefined} type="button" className="parallel-run-choice is-primary" disabled={!worktree.enabled} onClick={() => ask.resolve('worktree')} title={worktree.reason}>
            <GitBranch size={14} aria-hidden="true" /><span><strong>Run in a worktree</strong><small>{worktree.reason ?? worktree.detail}</small></span>
          </button>
          <button ref={worktree.enabled ? undefined : primary} type="button" className="parallel-run-choice" onClick={() => ask.resolve('queue')}>
            <Hourglass size={14} aria-hidden="true" /><span><strong>Queue until it finishes</strong><small>Starts here automatically when the other run ends</small></span>
          </button>
          <button type="button" className="parallel-run-choice" onClick={() => ask.resolve('run')}>
            <Play size={14} aria-hidden="true" /><span><strong>Run anyway</strong><small>Both chats edit the same files at once</small></span>
          </button>
        </div>
        <footer><Dialog.Close>Cancel</Dialog.Close></footer>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

/** Composer strip while a message waits for another chat in this checkout: who it waits for, Send now, Cancel. */
export function CheckoutQueueBanner({ chatId }: { chatId: string }): React.ReactElement | null {
  useSyncExternalStore((listener) => { queueListeners.add(listener); return () => { queueListeners.delete(listener); }; }, () => queueVersion, () => queueVersion);
  const entry = queued.get(chatId);
  if (!entry) return null;
  const who = entry.blockers.length === 1 ? `“${entry.blockers[0]}”` : `${entry.blockers.length} chats`;
  return <div className="checkout-queue-banner" role="status">
    <Hourglass size={13} aria-hidden="true" />
    <span>Queued · starts when {who} finishes in this folder</span>
    <button type="button" onClick={() => sendQueuedNow(chatId)}>Send now</button>
    <button type="button" onClick={() => cancelCheckoutQueue(chatId)}>Cancel</button>
  </div>;
}
