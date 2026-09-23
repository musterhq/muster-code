import { plural } from '../shared/wording.ts';

export interface BatchArchiveResult { archived: string[]; failed: Array<{ id: string; error: string }> }

/**
 * Archives every id and waits for all of them: one call per chat, run together, never one confirmation per chat
 * (the caller confirmed running chats once and passes `acknowledgeRunning`). A chat the runtime returns still
 * unarchived counts as failed.
 */
export async function archiveChats(ids: readonly string[], archive: (id: string) => Promise<unknown>): Promise<BatchArchiveResult> {
  const settled = await Promise.allSettled(ids.map(id => archive(id)));
  const result: BatchArchiveResult = { archived: [], failed: [] };
  settled.forEach((outcome, index) => {
    const id = ids[index]!;
    if (outcome.status === 'rejected') result.failed.push({ id, error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) });
    else if (outcome.value && typeof outcome.value === 'object' && (outcome.value as { archived?: unknown }).archived === false) result.failed.push({ id, error: 'The chat was not archived.' });
    else result.archived.push(id);
  });
  return result;
}

/** One notice for the whole batch. */
export function archiveSummary(result: BatchArchiveResult): { message: string; kind: 'success' | 'error' } {
  const total = result.archived.length + result.failed.length;
  if (!result.failed.length) return { message: `Archived ${plural(result.archived.length, 'chat')}`, kind: 'success' };
  const reason = result.failed[0]!.error.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').slice(0, 160);
  return { message: `${result.archived.length ? `Archived ${result.archived.length} of ${total} chats. ` : ''}${plural(result.failed.length, 'chat')} could not be archived${reason ? `: ${reason}` : '.'}`, kind: 'error' };
}
