/** The task thread's entries (C7): turns and cards in time order, with quiet turns folded and system lines as notices. Pure so it is unit tested. */
import type { LedgerEntry, ThreadCard, WorkspaceComment } from '../shared/domains/paperclip-protocol';

export type Entry = { kind: 'turn'; id: string; at: string; comment: WorkspaceComment; to: string | null; receipt: LedgerEntry | null } | { kind: 'card'; id: string; at: string; card: ThreadCard }
  /** A run of turns that wrote nothing, gathered into one line (C7). */
  | { kind: 'fold'; id: string; at: string; receipts: LedgerEntry[] }
  /** A system line: a refusal, a retry, a status change. */
  | { kind: 'notice'; id: string; at: string; text: string };
/** Quiet turns that follow each other become one fold; system comments become notices. Two or more quiet turns fold; one stays as it is. */
export function foldEntries(entries: readonly Entry[]): Entry[] {
  const out: Entry[] = []; let run: Extract<Entry, { kind: 'turn' }>[] = [];
  const flush = () => { if (run.length >= 2 && run.every(e => e.receipt)) out.push({ kind: 'fold', id: `fold:${run[0]!.id}`, at: run[run.length - 1]!.at, receipts: run.map(e => e.receipt!) }); else out.push(...run); run = []; };
  for (const e of entries) {
    if (e.kind === 'turn' && !e.comment.body && e.receipt) { run.push(e); continue; }
    flush();
    out.push(e.kind === 'turn' && e.comment.author.kind === 'system' && e.comment.body ? { kind: 'notice', id: e.id, at: e.at, text: e.comment.body } : e);
  }
  flush();
  return out;
}

