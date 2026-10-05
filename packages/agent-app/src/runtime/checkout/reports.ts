/**
 * Auto-reports for a checked-out task (#117), as pure functions. Everything Muster posts to the server while someone works locally is
 * written as the person, labelled "via Muster · local", and falls into two streams:
 *
 * - MILESTONE comments (few, each worth reading): checked out, a decision, a context summary, a pull request opened, test results against the
 *   baseline, handed back. These are batched: a flush posts them in order, keeps only the newest context summary and the newest test result,
 *   and never posts the same milestone key twice.
 * - PER-TURN receipts (many): files ±, tests, tokens, model and source of every local turn. They are never comments. They are rows of one
 *   rolling "Local work log" document on the task, rewritten once per flush.
 *
 * Every comment ends with the marker the optional Paperclip plugin reads (see lease.ts): `muster:activity` on progress, `muster:handback` and
 * `muster:release` for the two ways a check-out ends (a check-out carries `muster:checkout`).
 *
 * `Outbox` rows survive offline: the service stores them in SQLite and flushes on reconnect; these functions decide what a flush contains.
 */
import { markerFor } from './lease.ts';
import { sanitizeOut } from './sanitize.ts';
export const REPORT_LABEL = 'via Muster · local';
export const WORK_LOG_KEY = 'local-work-log';
export type ReportKind = 'checkout' | 'decision' | 'context' | 'pr' | 'tests' | 'handback' | 'release' | 'note';
export interface Report { key: string; kind: ReportKind; body: string; at: string }
/** Milestones where only the newest of a flush matters. */
const NEWEST_ONLY: ReadonlySet<ReportKind> = new Set(['context', 'tests']);
export const REPORT_FOOTER = (kind: ReportKind, key: string): string => `<!-- muster:report ${kind} ${key} -->`;
const REPORT_MARK = /<!--\s*muster:report\s+(\w+)\s+([^\s]+)\s*-->/g;
/** Keys already present in comment bodies, so a replay after a failed (or half-failed) flush never double-posts. */
export function postedKeys(commentBodies: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const body of commentBodies) for (const m of body.matchAll(REPORT_MARK)) keys.add(m[2]!);
  return keys;
}
/** The full comment text: the body, the label, the marker the plugin reads, and Muster's own idempotency key. A check-out comment already carries its `muster:checkout` marker. */
export function reportComment(report: Report): string {
  const body = report.body.trim();
  if (report.kind === 'checkout') return `${body}\n\n${REPORT_FOOTER(report.kind, report.key)}`;
  const marker = markerFor(report.kind === 'handback' ? 'handback' : report.kind === 'release' ? 'release' : 'activity', { at: report.at });
  return report.kind === 'handback' || report.kind === 'release' ? `${body}\n\n${marker}\n${REPORT_FOOTER(report.kind, report.key)}` : `${body}\n\n_${REPORT_LABEL}_\n${marker}\n${REPORT_FOOTER(report.kind, report.key)}`;
}

/** What one flush posts: milestones in time order, de-duplicated, newest-only kinds collapsed, minus keys the server already has. */
export function batchReports(pending: readonly Report[], already: ReadonlySet<string> = new Set()): { post: Report[]; dropped: Report[] } {
  // Time order; rows with the same time keep the order they were queued in (the sort is stable).
  const sorted = [...pending].sort((a, b) => a.at.localeCompare(b.at));
  const newest = new Map<ReportKind, string>();
  for (const r of sorted) if (NEWEST_ONLY.has(r.kind)) newest.set(r.kind, r.key);
  const seen = new Set<string>(), post: Report[] = [], dropped: Report[] = [];
  for (const r of sorted) {
    const skip = already.has(r.key) || seen.has(r.key) || (NEWEST_ONLY.has(r.kind) && newest.get(r.kind) !== r.key);
    if (skip) dropped.push(r); else { seen.add(r.key); post.push(r); }
  }
  return { post, dropped };
}

// --- milestone texts -------------------------------------------------------------------------------------------------------------
export const decisionReport = (key: string, at: string, text: string): Report => ({ key, kind: 'decision', at, body: `**Decision**\n\n${sanitizeOut(text, 4000, { multiline: true })}` });
export const contextReport = (key: string, at: string, summary: string): Report => ({ key, kind: 'context', at, body: `**Context so far**\n\n${sanitizeOut(summary, 600)}` });
export const prReport = (key: string, at: string, url: string, branch: string): Report => ({ key, kind: 'pr', at, body: `**Pull request opened**\n\n${url}\n\nBranch: \`${branch}\`` });
export interface TestResult { ran: boolean; passed?: number; failed?: number; baselineFailed?: number | null; note?: string | null; /** The project has no recognised test setup, so none was expected. */ none?: boolean; /** Tests ran and finished cleanly but their output is not a summary Muster can read: the person looked at it. */ unparsed?: boolean }
export function testsLine(t: TestResult): string {
  if (t.none && !t.ran) return 'No tests in this project.';
  if (t.ran && t.unparsed) return 'Tests ran; the result was read by you (Muster could not parse it).';
  if (!t.ran) return t.note?.trim() ? `Tests were not run: ${t.note.trim()}` : 'Tests were not run.';
  const now = `${t.passed ?? 0} passed, ${t.failed ?? 0} failed`;
  if (t.baselineFailed === null || t.baselineFailed === undefined) return `Tests: ${now}.`;
  const delta = (t.failed ?? 0) - t.baselineFailed;
  return `Tests: ${now}. Baseline had ${t.baselineFailed} failing${delta === 0 ? ' (no change).' : delta > 0 ? `; ${delta} new.` : `; ${-delta} fewer.`}`;
}
export const testsReport = (key: string, at: string, t: TestResult): Report => ({ key, kind: 'tests', at, body: `**Test results**\n\n${testsLine(t)}` });

export interface HandBackSummary { reviewedLocally?: readonly string[]; branch: string; /** Plain folder: it was used in place, so there is no branch or pull request to name. */ folder?: string; /** Replaces "no pull request linked" (for example, a branch that stays local because the repository has no remote). */ branchNote?: string; changed: string; decisions: readonly string[]; tests: TestResult; prUrl: string | null; openQuestions?: string; reviewerName: string; summary?: string }
export function handBackBody(s: HandBackSummary): string {
  const clean = (v: string) => sanitizeOut(v, 2000, { multiline: true });
  s = { ...s, ...(s.summary ? { summary: clean(s.summary) } : {}), changed: clean(s.changed), decisions: s.decisions.map(d => clean(d)), ...(s.openQuestions ? { openQuestions: clean(s.openQuestions) } : {}) };
  const lines = ['**Handed back for review** · via Muster', '', s.summary?.trim() || 'Work on this task is ready for review.', '', '**What changed**', s.changed.trim() || 'No file changes were recorded.', ''];
  lines.push('**Decisions**', ...(s.decisions.length ? s.decisions.map(d => `- ${d}`) : ['None recorded.']), '');
  lines.push('**Evidence**', testsLine(s.tests), ...(s.reviewedLocally?.length ? [`Reviewed locally by ${s.reviewedLocally.join(', ')}.`] : []), s.folder ? `Worked in place in “${s.folder}”; no branch, push or pull request.` : s.prUrl ? `Pull request: ${s.prUrl}` : s.branchNote ?? `Branch: \`${s.branch}\` (no pull request linked).`, '');
  lines.push('**Open questions**', s.openQuestions?.trim() || 'None.', '', `Reviewer: ${s.reviewerName}.`);
  return lines.join('\n');
}
export const releaseBody = (device: string, note: string | undefined): string => `Released from ${device} · via Muster${note?.trim() ? `\n\n${note.trim()}` : ''}`;

// --- the rolling work log ---------------------------------------------------------------------------------------------------------
/** One local turn. `title` and `summary` come from the turn's final message; `costSource` says who paid (personal: the person's own subscription or key). */
export interface TurnReceipt {
  runId: string; at: string; model: string | null; provider: string | null; source: 'org-agent' | 'own'; /** A local review session's turn. */ role?: 'maker' | 'reviewer';
  files: { count: number; added: number; removed: number } | null; /** Plain folder: how many files were added, changed and removed since check-out (there are no lines without git). */ fileChanges?: { added: number; changed: number; removed: number }; tests: number; testSummary?: { passed: number; failed: number } | null;
  tokens: { input: number; cached: number; output: number } | null; durationMs: number | null; outcome: string;
  title?: string; summary?: string; costUsd?: number | null; costSource?: 'personal' | 'org';
}
export interface WorkLogHeader { key: string; title: string; person: string; device: string; branch: string; /** Plain folder: its name (there is no branch). */ folder?: string; since: string; state: string; modelLabel: string }
const fmt = (n: number) => n.toLocaleString('en-US');
const oneLine = (v: string, max: number) => v.replace(/\s+/g, ' ').trim().slice(0, max);
/**
 * The "Local work log" document (key `local-work-log`), in the format the plugin and the server's reader parse: a title, then one
 * `## <time> · <title>` section per local turn with the bullets Device, Files, Tests, Tokens, Model, Cost (personal|org) and Summary.
 * One document, rewritten whole.
 */
export function renderWorkLog(header: WorkLogHeader, receipts: readonly TurnReceipt[]): string {
  const rows = [...receipts].sort((a, b) => a.at.localeCompare(b.at));
  const total = rows.reduce((t, r) => ({ added: t.added + (r.files?.added ?? 0), removed: t.removed + (r.files?.removed ?? 0), tests: t.tests + r.tests, tokens: t.tokens + (r.tokens ? r.tokens.input + r.tokens.output : 0) }), { added: 0, removed: 0, tests: 0, tokens: 0 });
  const out = [
    `# Local work log · ${header.key}`, '',
    `${header.person} on ${header.device}, ${header.folder ? `in the folder “${header.folder}” (used in place)` : `branch \`${header.branch}\``}, ${header.state}. Engine: ${header.modelLabel}. Since ${header.since}.`,
    `${rows.length} ${rows.length === 1 ? 'turn' : 'turns'} · +${fmt(total.added)} −${fmt(total.removed)} lines · ${total.tests} test ${total.tests === 1 ? 'command' : 'commands'} · ${fmt(total.tokens)} tokens. Written by Muster on this Mac (${REPORT_LABEL}).`, '',
  ];
  rows.forEach((r, i) => {
    out.push(`## ${r.at.replace(/\.\d+Z$/, 'Z')} · ${sanitizeOut(r.title || `Local turn ${i + 1}`, 90)}${r.role === 'reviewer' ? ' (review)' : ''}`);
    out.push(`- Device: ${header.device}`);
    if (r.fileChanges) out.push(`- Files changed: ${r.fileChanges.added} added, ${r.fileChanges.changed} changed, ${r.fileChanges.removed} removed`);
    if (r.files) out.push(`- Files: +${r.files.added} -${r.files.removed} (${r.files.count} ${r.files.count === 1 ? 'file' : 'files'})`);
    out.push(`- Tests: ${r.testSummary ? `${r.testSummary.passed} passed, ${r.testSummary.failed} failed` : r.tests > 0 ? `${r.tests} test ${r.tests === 1 ? 'command' : 'commands'} ran` : 'not run'}`);
    if (r.tokens) out.push(`- Tokens: ${fmt(r.tokens.input)} in / ${fmt(r.tokens.output)} out`);
    out.push(`- Model: ${sanitizeOut(r.model ?? 'unknown', 80)}${r.source === 'org-agent' ? ' (org agent)' : ''}`);
    out.push(`- Cost: $${(r.costUsd ?? 0).toFixed(2)} (${r.costSource ?? 'personal'})`);
    if (r.summary) out.push(`- Summary: ${sanitizeOut(r.summary, 280)}`);
    out.push('');
  });
  return out.join('\n').trimEnd() + '\n';
}
