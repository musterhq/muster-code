import { promises as fs } from 'node:fs';
import type { Folder } from '../../shared/protocol.ts';
import type { ReviewBaseline } from '../../shared/domains/review-protocol.ts';
import { captureBaseline, ReviewBaselineStore } from '../review-baseline.ts';
import { parseBaseline, reviewChanges, reviewFileDiff, stageAll, stageHunk, undoFile, undoHunk } from '../review.ts';
import type { DomainContext, DomainModule } from './types.ts';

const text = (value: unknown, label: string, max = 4096): string => {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) throw new Error(`Invalid ${label}.`);
  return value;
};
const hash = (value: unknown): string => {
  if (value !== '' && (typeof value !== 'string' || !/^[0-9a-f]{40,64}$/.test(value))) throw new Error('Refresh the diff and try again.');
  return value as string;
};

/**
 * Review domain: a pre-run baseline per agent turn (onRunStarted), baseline-aware
 * change lists and file diffs, guarded Keep/Undo per hunk and file, and hunk
 * staging. Handlers are keyed by the command names in shared/domains/review-protocol.ts.
 *
 * Design note on the onRunStarted hook: service.ts awaits every onRunStarted
 * hook (bounded at RUN_STARTED_TIMEOUT_MS = 5s) before it calls provider.run(),
 * so anything this hook awaits sits directly on the turn's dispatch critical
 * path -- delaying the very first token of every single turn. captureBaseline
 * spawns real `git` subprocesses (add -u, ls-files, write-tree); that easily
 * costs tens of milliseconds even for a fast repo, and up to SNAPSHOT_TIMEOUT_MS
 * for a slow one, on every turn. So the hook below does NOT await the capture:
 * it kicks it off (synchronously, in the same tick the turn starts -- before
 * service.ts's `await provider.run(...)` even begins) and returns immediately,
 * which lets the surrounding Promise.all in domainHooks.runStarted() settle on
 * the microtask queue rather than waiting on subprocess I/O.
 *
 * Correctness: a baseline has to reflect the working tree as it stood before
 * this turn's agent could write anything. Firing the capture instead of
 * blocking on it doesn't relax that -- provider.run() always needs a network
 * round trip to the model before any tool call (and therefore any local file
 * write) can happen, and that round trip is unconditionally slower than a
 * local git snapshot. So the snapshot -- whose subprocess is already spawned
 * before the provider request even goes out -- wins that race in practice,
 * exactly as it did when this ran synchronously in front of dispatch, just
 * without holding dispatch hostage to it.
 *
 * review.* handlers that read a run's baseline (`baseTree`, review.keep) await
 * that run's still-in-flight capture through `pending`/`withRun` first, so a
 * request that lands before the git snapshot has written its row still gets
 * the finished baseline instead of a spurious "no recorded baseline" -- the
 * one place a caller can actually observe the capture not being instantaneous.
 */
export function createReviewDomain(context: DomainContext): DomainModule {
  let store: ReviewBaselineStore | undefined;
  const baselines = () => store ??= new ReviewBaselineStore(context.db());
  const folder = (value: unknown): Folder => context.folderFor(text(value, 'folder', 128));
  const changed = (target: Folder) => context.emit({ type: 'workspaceChanged', folderId: target.id });
  /** In-flight captures, keyed by runId, so review.* reads can await the one they need instead of racing it. */
  const pending = new Map<string, { chatId: string; promise: Promise<unknown> }>();
  const withRun = async (runId: string): Promise<void> => { await pending.get(runId)?.promise; };
  const withChat = async (chatId: string): Promise<void> => { await Promise.all([...pending.values()].filter(entry => entry.chatId === chatId).map(entry => entry.promise)); };
  /** A run baseline only applies to the folder it was taken in. */
  const baseTree = (target: Folder, baseline: ReviewBaseline): string | null | undefined => {
    if (typeof baseline === 'string' || 'ref' in baseline) return undefined;
    const info = baselines().get(baseline.runId);
    if (!info) throw new Error('That agent turn has no recorded baseline.');
    if (info.folderId && info.folderId !== target.id) throw new Error('That agent turn ran in another folder.');
    if (!info.treeSha) throw new Error(info.reason ?? 'That agent turn has no review baseline.');
    return info.treeSha;
  };
  const undone = (baseline: ReviewBaseline, path: string, hunkIds: string[]) => { if (typeof baseline !== 'string' && 'runId' in baseline) baselines().mark(baseline.runId, path, hunkIds, 'undone'); };
  const folderForCwd = async (cwd: string, preferred?: string): Promise<string | null> => {
    const folders = context.store.snapshot().folders;
    const real = await fs.realpath(cwd).catch(() => cwd);
    return folders.find(entry => entry.path === cwd || entry.path === real)?.id ?? (preferred && folders.some(entry => entry.id === preferred) ? preferred : null);
  };
  const off = context.hooks.onRunStarted(run => {
    // Fire-and-forget: see the design note above. Not awaited, and not `async`,
    // so this returns synchronously and never adds a subprocess-shaped delay
    // to domainHooks.runStarted()'s Promise.all.
    const startedAt = Date.now();
    const capture = (async () => {
      const folderId = await folderForCwd(run.cwd, run.chat.folderId);
      return captureBaseline(baselines(), { runId: run.runId, chatId: run.chat.id, folderId, cwd: run.cwd, startedAt });
    })();
    pending.set(run.runId, { chatId: run.chat.id, promise: capture });
    capture.catch(() => undefined).finally(() => { if (pending.get(run.runId)?.promise === capture) pending.delete(run.runId); });
  });
  return {
    handlers: {
      'review.baselines': async input => { const chatId = text(input.chatId, 'chat', 128); await withChat(chatId); return baselines().list(chatId); },
      'review.changes': async input => {
        const target = folder(input.folderId), baseline = parseBaseline(input.baseline);
        if (typeof baseline !== 'string' && 'runId' in baseline) await withRun(baseline.runId);
        return reviewChanges(target.path, baseline, baseTree(target, baseline));
      },
      'review.fileDiff': async input => {
        const target = folder(input.folderId), baseline = parseBaseline(input.baseline);
        if (typeof baseline !== 'string' && 'runId' in baseline) await withRun(baseline.runId);
        return reviewFileDiff(target.path, text(input.path, 'path'), baseline, baseTree(target, baseline));
      },
      'review.undoHunk': async input => {
        const target = folder(input.folderId), baseline = parseBaseline(input.baseline), path = text(input.path, 'path'), hunkId = text(input.hunkId, 'hunk', 64);
        if (typeof baseline !== 'string' && 'runId' in baseline) await withRun(baseline.runId);
        const result = await undoHunk(target.path, { path, baseline, hunkId, expectedAfterHash: hash(input.expectedAfterHash), relocate: input.relocate === true }, baseTree(target, baseline));
        if (!result.stale) { undone(baseline, path, [hunkId]); changed(target); }
        return result;
      },
      'review.undoFile': async input => {
        const target = folder(input.folderId), baseline = parseBaseline(input.baseline), path = text(input.path, 'path');
        if (typeof baseline !== 'string' && 'runId' in baseline) await withRun(baseline.runId);
        const result = await undoFile(target.path, { path, baseline, expectedAfterHash: hash(input.expectedAfterHash) }, baseTree(target, baseline));
        if (!result.stale) { undone(baseline, path, ['*']); changed(target); }
        return result;
      },
      'review.keep': async input => {
        const runId = text(input.runId, 'turn', 128), path = text(input.path, 'path');
        await withRun(runId);
        if (!baselines().get(runId)) throw new Error('That agent turn has no recorded baseline.');
        if (!Array.isArray(input.hunkIds) || !input.hunkIds.length || input.hunkIds.length > 500) throw new Error('Choose between 1 and 500 hunks.');
        baselines().mark(runId, path, input.hunkIds.map(id => text(id, 'hunk', 64)), 'kept');
        return baselines().marks(runId);
      },
      'review.marks': input => baselines().marks(text(input.runId, 'turn', 128)),
      'review.stageHunk': async input => {
        const target = folder(input.folderId);
        const result = await stageHunk(target.path, { path: text(input.path, 'path'), hunkId: text(input.hunkId, 'hunk', 64), expectedBeforeHash: hash(input.expectedBeforeHash), expectedAfterHash: hash(input.expectedAfterHash), unstage: input.unstage === true });
        if (!result.stale) changed(target);
        return result;
      },
      'review.stageAll': async input => { const target = folder(input.folderId); await stageAll(target.path); changed(target); },
    },
    dispose: off,
  };
}
