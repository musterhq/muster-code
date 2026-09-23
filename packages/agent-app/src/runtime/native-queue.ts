/**
 * Follow-up queue delegated to Codex's `thread/queue/*` for chats whose app-server supports it.
 *
 * Muster keeps its own row (the composer list, chips, errors) and records which app-server
 * submission carries it. The app-server then owns idle dispatch, the interrupt pause and the
 * ordering relative to goal continuations; `thread/queue/changed` tells Muster to re-list and
 * drop rows the app-server has sent. Only plain text rows are mirrored, and a chat's queue is
 * either wholly native or wholly Muster's: files, skill/plugin chips and effort need Muster's
 * send path, so a queue holding one stays local, and any native failure falls back to local.
 */
import type { QueuedMessage } from '../shared/protocol.ts';
import type { ChatQueue } from './chat-queue.ts';
import { NativeUnavailableError, type NativeThreadBridge } from './codex-native.ts';

export interface NativeQueueHost {
  queue: ChatQueue;
  native: NativeThreadBridge | undefined;
  /** Rows changed (mirrored, sent natively, fell back): re-emit the snapshot. */
  changed(chatId: string): void;
}

const plain = (item: QueuedMessage) => !item.attachmentIds.length && !item.skillIds?.length && !item.pluginIds?.length && !item.effort;
const submissionId = (result: Record<string, unknown>): string | undefined => {
  const submission = result.queuedSubmission && typeof result.queuedSubmission === 'object' ? result.queuedSubmission as Record<string, unknown> : undefined;
  return typeof submission?.id === 'string' && submission.id ? submission.id : undefined;
};
const userInput = (text: string) => [{ type: 'text', text, text_elements: [] }];

export function createNativeQueueMirror(host: NativeQueueHost) {
  const { queue } = host;
  /** Rows whose thread/queue/add is in flight; local dispatch must not race them. */
  const mirroring = new Set<string>();
  const thread = (chatId: string) => host.native?.thread(chatId)?.threadId;
  /** Adds run one at a time per chat, so the app-server's order matches Muster's. */
  const chains = new Map<string, Promise<unknown>>();

  /** Puts every native row of the chat back under Muster's own dispatch (best-effort native delete). */
  async function unmirrorAll(chatId: string): Promise<void> {
    const rows = queue.nativeRows(chatId), threadId = thread(chatId);
    for (const row of rows) {
      queue.clearNative(row.queueId);
      if (threadId) await host.native?.call(chatId, 'thread/queue/delete', { threadId, queuedSubmissionId: row.submissionId }).catch(() => undefined);
    }
    if (rows.length) host.changed(chatId);
  }

  async function mirrorOne(chatId: string, item: QueuedMessage): Promise<boolean> {
    const native = host.native!;
    try {
      const rows = queue.list(chatId);
      if (!plain(item) || rows.some(entry => entry.id !== item.id && !queue.nativeId(entry.id) && !mirroring.has(entry.id))) {
        // A row that needs Muster's send path joins the queue: the whole queue goes back to Muster.
        if (!plain(item)) await unmirrorAll(chatId);
        return false;
      }
      if (!(await native.supports(chatId, 'queue'))) return false;
      const threadId = thread(chatId);
      if (!threadId) return false;
      const id = submissionId(await native.call(chatId, 'thread/queue/add', { threadId, input: userInput(item.text), clientUserMessageId: item.requestId }));
      if (!id) return false;
      if (!queue.list(chatId).some(entry => entry.id === item.id)) {
        // Removed (or sent by Muster) while the add was in flight: take it back out of the app-server.
        await native.call(chatId, 'thread/queue/delete', { threadId, queuedSubmissionId: id }).catch(() => undefined);
        return false;
      }
      queue.setNative(chatId, item.id, id);
      host.changed(chatId);
      return true;
    } catch { return false; }
    finally { mirroring.delete(item.id); }
  }

  return {
    /** Whether dispatch of this chat's queue head belongs to the app-server. */
    owns(chatId: string): boolean {
      const head = queue.list(chatId)[0];
      return Boolean(head && queue.nativeId(head.id));
    },
    /** The row's thread/queue/add is still in flight; its completion decides who dispatches it. */
    pending(queueId: string): boolean { return mirroring.has(queueId); },
    /** Mirrors a newly queued row into the app-server when the chat's whole queue can be native. */
    mirror(chatId: string, item: QueuedMessage): Promise<boolean> {
      if (!host.native) return Promise.resolve(false);
      mirroring.add(item.id);
      const run = (chains.get(chatId) ?? Promise.resolve()).then(() => mirrorOne(chatId, item));
      const tail = run.catch(() => undefined);
      chains.set(chatId, tail);
      void tail.then(() => { if (chains.get(chatId) === tail) chains.delete(chatId); });
      return run;
    },
    /** Edits a native row in place; on failure the row falls back to Muster's queue. */
    async update(chatId: string, queueId: string, text: string): Promise<void> {
      const id = queue.nativeId(queueId), threadId = thread(chatId);
      if (!id) return;
      try {
        if (!threadId) throw new NativeUnavailableError();
        await host.native!.call(chatId, 'thread/queue/update', { threadId, queuedSubmissionId: id, input: userInput(text) });
      } catch { await unmirrorAll(chatId); }
    },
    /** Deletes the native submission before Muster drops its row. */
    async remove(chatId: string, queueId: string): Promise<void> {
      const id = queue.nativeId(queueId), threadId = thread(chatId);
      if (!id) return;
      queue.clearNative(queueId);
      if (threadId) await host.native?.call(chatId, 'thread/queue/delete', { threadId, queuedSubmissionId: id }).catch(() => undefined);
    },
    /** Mirrors Muster's order to the app-server. */
    async reorder(chatId: string): Promise<void> {
      const rows = queue.nativeRows(chatId), threadId = thread(chatId);
      if (!rows.length) return;
      try {
        if (!threadId) throw new NativeUnavailableError();
        await host.native!.call(chatId, 'thread/queue/reorder', { threadId, queuedSubmissionIds: rows.map(row => row.submissionId) });
      } catch { await unmirrorAll(chatId); }
    },
    /** `thread/queue/start`: sends the given (or head) native row now if the thread is idle. False lets Muster dispatch. */
    async start(chatId: string, queueId?: string): Promise<boolean> {
      const head = queueId ?? queue.list(chatId)[0]?.id;
      const id = head ? queue.nativeId(head) : undefined, threadId = thread(chatId);
      if (!id) return false;
      if (!threadId) { await unmirrorAll(chatId); return false; }
      try {
        await host.native!.call(chatId, 'thread/queue/start', { threadId, queuedSubmissionId: id });
        return true;
      } catch (error) {
        // The app-server already started it (or another turn) on idle: that turn is adopted instead.
        const message = error instanceof Error ? error.message : String(error);
        if (/active or pending turn|already has an active/i.test(message)) return true;
        // Already sent (its turn ran before thread/queue/changed arrived): drop the row, never resend it.
        if (/queued submission not found/i.test(message)) { queue.dropSent(chatId, head!); host.changed(chatId); return true; }
        await unmirrorAll(chatId);
        return false;
      }
    },
    /** `thread/queue/changed`: drops rows whose submission the app-server no longer holds (sent or deleted). */
    async reconcile(chatId: string): Promise<void> {
      const rows = queue.nativeRows(chatId), threadId = thread(chatId);
      if (!rows.length || !threadId) return;
      const held = new Set<string>();
      try {
        let cursor: string | undefined;
        for (let page = 0; page < 20; page++) {
          const result = await host.native!.call(chatId, 'thread/queue/list', { threadId, limit: 100, ...(cursor ? { cursor } : {}) });
          for (const entry of Array.isArray(result.data) ? result.data : []) if (entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string') held.add((entry as { id: string }).id);
          cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
          if (!cursor) break;
        }
      } catch { return; }
      let dropped = false;
      for (const row of rows) if (!held.has(row.submissionId)) { queue.dropSent(chatId, row.queueId); dropped = true; }
      if (dropped) host.changed(chatId);
    },
    unmirrorAll,
  };
}
