/**
 * Living summaries (G2): what a status card watches, how "nothing changed" is decided, and the prompt a summary run gets.
 * Pure functions: the domain supplies the tasks and stores the revisions.
 */
import { createHash } from 'node:crypto';
import type { QueryTask } from '../../shared/task-query.ts';

export interface WatchedTask extends QueryTask { id: string; updatedAt: string; description?: string }

/** Identical when the watched tasks (and their pull requests) are in the same state: the card then skips the run and spends no tokens. */
export function fingerprintOf(tasks: readonly WatchedTask[]): string {
  const rows = [...tasks].sort((a, b) => a.id.localeCompare(b.id)).map(t => [t.id, t.status, t.updatedAt, t.assigneeLabel ?? '', t.priority, (t.labels ?? []).map(l => l.name).sort().join(','), t.pr ? `${t.pr.total}/${t.pr.open}/${t.pr.merged}/${t.pr.failing}/${t.pr.pending}` : ''].join('|'));
  return createHash('sha256').update(`${tasks.length}\n${rows.join('\n')}`).digest('hex').slice(0, 24);
}
const clip = (s: string, n: number) => { const f = s.replace(/\s+/g, ' ').trim(); return f.length > n ? `${f.slice(0, n - 1)}…` : f; };

export function summaryPrompt(input: { project: string; goal: string; title: string; query: string; tasks: readonly WatchedTask[]; activity: readonly string[]; previous: string | null; tokenCap: number; now: Date }): string {
  const words = Math.max(60, Math.round(input.tokenCap * 0.7));
  const shown = input.tasks.slice(0, 80);
  return [
    `You write the status card “${input.title}” for the project “${input.project}”.${input.goal ? ` The project's goal: ${clip(input.goal, 400)}` : ''}`,
    `Today is ${input.now.toISOString().slice(0, 10)}. The card watches ${input.query.trim() ? `the tasks matching “${input.query.trim()}”` : 'every task in the project'}: ${input.tasks.length} ${input.tasks.length === 1 ? 'task' : 'tasks'}${input.tasks.length > shown.length ? ` (the ${shown.length} most recent are listed)` : ''}.`,
    '', 'Tasks:',
    ...(shown.length ? shown.map(t => `- ${t.key} [${t.status.replace('_', ' ')}${t.live ? ', running' : ''}] ${clip(t.title, 120)} — ${t.assigneeLabel ?? 'unassigned'}, ${t.priority} priority${t.labels?.length ? `, labels: ${t.labels.map(l => l.name).join(', ')}` : ''}${t.pr?.total ? `, ${t.pr.total} pull request${t.pr.total === 1 ? '' : 's'}${t.pr.failing ? ' (checks failing)' : ''}` : ''}, updated ${t.updatedAt.slice(0, 10)}`) : ['- (none)']),
    ...(input.activity.length ? ['', 'Recent activity:', ...input.activity.slice(0, 15).map(a => `- ${clip(a, 160)}`)] : []),
    ...(input.previous ? ['', 'The previous version of this card:', clip(input.previous, 2400), '', 'Say what changed since then, and drop what is no longer true.'] : []),
    '', `Write the card in Markdown, at most ${words} words: a one-line status first, then what moved, what is blocked or at risk, and what is next. Use only the facts above; do not invent tasks or dates. You may read files in the project but must not change anything. Reply with the card only.`,
  ].join('\n');
}

/** The card text as stored: trimmed, and never longer than the token cap allows (about four characters a token). */
export function capText(text: string, tokenCap: number): string {
  const max = tokenCap * 4, t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max), at = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
  return `${(at > max * 0.6 ? cut.slice(0, at + 1) : cut).trimEnd()}…`;
}
