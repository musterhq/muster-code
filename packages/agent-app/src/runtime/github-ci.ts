/**
 * CI for pull requests (GIT-08): failing-check log excerpts and the bounded repair loop behind "Fix failing checks".
 *
 * Logs: a GitHub Actions check run's id is its job id, so the job log comes from `actions/jobs/{id}/logs`; other
 * apps only publish the check run's output (title/summary/text) and annotations. Either way the excerpt is a
 * bounded window around the last error line with timestamps and ANSI codes stripped and secrets redacted.
 *
 * Repair: `runRepairLoop` is pure orchestration over injected effects (read checks, read logs, run one agent
 * turn, sleep), so it is tested without GitHub or a provider. Each attempt: wait for CI to settle, stop on
 * success or at the attempt limit, otherwise hand the failing checks and their logs to the agent, then wait
 * for a new head commit and for CI on it. An abort (the user's Stop) ends it at the next step.
 */
import {promises as fs} from 'node:fs';
import type {CiAnnotation, CiCheckLog, CiRepair, CiRepairAttempt} from '../shared/domains/ci-protocol.ts';
import type {GitHubCheck, GitHubChecks} from '../shared/domains/github-protocol.ts';
import {GitHubError, getPullRequest, githubApi} from './github.ts';
import {redactGitText} from './git-local.ts';
import {redactSecrets} from './secret-redaction.ts';

// ---------------------------------------------------------------------------
// Log excerpts

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;
const ERROR_LINE = /##\[error\]|\berror\b|\bfailed\b|\bfailure\b|\bFAIL\b|✖|✗|Traceback|panic:|exit code [1-9]/i;
export const LOG_EXCERPT_LINES = 80;
export const LOG_EXCERPT_CHARS = 12_000;

/** A bounded, readable window of a CI log: the lines leading up to (and just after) its last error. */
export function excerptLog(raw: string, maxLines = LOG_EXCERPT_LINES, maxChars = LOG_EXCERPT_CHARS): {excerpt: string; lines: number; truncated: boolean} {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n')
    .map(line => line.replace(STAMP, '').replace(ANSI, '').replace(/^##\[(group|endgroup)\]/, ''))
    .filter((line, index, all) => !(index === all.length - 1 && !line.trim()));
  let last = -1;
  for (let index = lines.length - 1; index >= 0; index--) if (ERROR_LINE.test(lines[index]!)) { last = index; break; }
  const end = last >= 0 ? Math.min(lines.length, last + 8) : lines.length;
  const start = Math.max(0, end - maxLines);
  // Earlier ##[error] lines outside the window still say what broke.
  const earlier = lines.slice(0, start).filter(line => line.startsWith('##[error]')).slice(-5);
  let window = [...(earlier.length ? [...earlier, '…'] : []), ...lines.slice(start, end)];
  let text = redactSecrets(redactGitText(window.join('\n')));
  let truncated = start > 0 || end < lines.length;
  if (text.length > maxChars) { text = `…${text.slice(text.length - maxChars)}`; truncated = true; window = text.split('\n'); }
  return {excerpt: text, lines: window.length, truncated};
}

const str = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback;
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const LEVELS = new Set(['notice', 'warning', 'failure']);
const CHECK_ID = /^(check|status):(\d{1,20})$/;

/** The log excerpt and annotations of one check of a PR's head commit. Completed checks are cached for a minute. */
export async function checkLog(root: string, number: number, checkId: unknown, refresh = false): Promise<CiCheckLog> {
  const match = typeof checkId === 'string' ? CHECK_ID.exec(checkId) : null;
  if (!match) throw new Error('Choose a check.');
  const [, kind, id] = match as unknown as [string, 'check' | 'status', string];
  const real = await fs.realpath(root);
  const s = await githubApi.slug(real);
  const base = githubApi.repoPath(s);
  return githubApi.cached(real, `ci:log:${checkId}`, 60_000, refresh, async () => {
    if (kind === 'status') {
      const pr = await getPullRequest(real, number, refresh);
      const combined = await githubApi.request<{statuses?: Record<string, unknown>[]}>(real, {method: 'GET', path: `${base}/commits/${encodeURIComponent(pr.headSha)}/status?per_page=100`});
      const status = (combined?.statuses ?? []).find(row => String(num(row.id)) === id);
      if (!status) throw new GitHubError('not_found', 'That status is no longer reported for this commit.');
      const state = str(status.state, 'pending');
      const description = redactSecrets(redactGitText(str(status.description)));
      return {checkId: checkId as string, name: str(status.context, 'Status'), conclusion: state === 'pending' ? null : state, source: 'status', excerpt: description,
        lines: description ? description.split('\n').length : 0, truncated: false, annotations: [], ...(str(status.target_url) ? {url: str(status.target_url)} : {})};
    }
    const run = await githubApi.request<Record<string, unknown>>(real, {method: 'GET', path: `${base}/check-runs/${id}`});
    const output = (run.output ?? {}) as Record<string, unknown>;
    const name = str(run.name, 'Check');
    const conclusion = run.status === 'completed' ? str(run.conclusion, 'neutral') : null;
    const url = str(run.html_url) || str(run.details_url);
    let annotations: CiAnnotation[] = [];
    if ((num(output.annotations_count) ?? 0) > 0) {
      const rows = await githubApi.request<Record<string, unknown>[]>(real, {method: 'GET', path: `${base}/check-runs/${id}/annotations?per_page=50`}).catch(() => []);
      annotations = (Array.isArray(rows) ? rows : []).slice(0, 50).map(row => ({
        path: str(row.path), line: num(row.start_line), level: (LEVELS.has(str(row.annotation_level)) ? str(row.annotation_level) : 'failure') as CiAnnotation['level'],
        message: redactSecrets(redactGitText(str(row.message))).slice(0, 2000), ...(str(row.title) ? {title: str(row.title).slice(0, 200)} : {}),
      }));
    }
    const app = str((run.app as {slug?: unknown} | null)?.slug);
    if (app === 'github-actions' && run.status === 'completed') {
      try {
        const log = await githubApi.request<unknown>(real, {method: 'GET', path: `${base}/actions/jobs/${id}/logs`});
        if (typeof log === 'string' && log.trim()) {
          const excerpt = excerptLog(log);
          return {checkId: checkId as string, name, conclusion, source: 'actions-log', ...excerpt, annotations, ...(url ? {url} : {})};
        }
      } catch (error) {
        // Expired (410) or unreadable logs fall back to the check's own output.
        if (!(error instanceof GitHubError) || (error.code !== 'not_found' && error.code !== 'forbidden' && error.code !== 'unknown')) throw error;
      }
    }
    const text = [str(output.title), str(output.summary), str(output.text)].filter(part => part.trim()).join('\n\n');
    const excerpt = text ? excerptLog(text) : {excerpt: '', lines: 0, truncated: false};
    return {checkId: checkId as string, name, conclusion, source: text ? 'check-output' : 'none', ...excerpt, annotations, ...(url ? {url} : {})};
  });
}

// ---------------------------------------------------------------------------
// Repair loop

export const isFailingCheck = (check: GitHubCheck) => check.status === 'completed' && !['success', 'skipped', 'neutral', 'stale'].includes(check.conclusion ?? '');
const PROMPT_BUDGET = 30_000;

/** The agent's instructions for one attempt: what failed, the evidence, and the one thing it must do (push a fix to the PR branch). */
export function buildRepairPrompt(input: {number: number; headRef: string; attempt: number; maxAttempts: number; failing: GitHubCheck[]; logs: CiCheckLog[]}): string {
  const head = [
    `CI is failing on pull request #${input.number} (branch \`${input.headRef}\`). This is repair attempt ${input.attempt} of ${input.maxAttempts}.`,
    '',
    `Find the cause of the failing checks below and fix it. Run the relevant build or tests locally when you can. Then commit the fix and push it to \`${input.headRef}\` so CI runs again.`,
    'Do not disable, skip or weaken checks or tests to make them pass, and do not change unrelated code. If the failure is not caused by this branch (an outage, a flaky runner, missing secrets), say so and stop without pushing.',
    '',
    'Failing checks:',
    ...input.failing.map(check => `- ${check.name} (${check.conclusion ?? 'failed'})${check.url ? ` ${check.url}` : ''}`),
  ].join('\n');
  let body = '';
  for (const log of input.logs) {
    const parts: string[] = [];
    if (log.excerpt.trim()) parts.push(`Log excerpt for ${log.name}${log.truncated ? ' (tail around the last error)' : ''}:\n\`\`\`text\n${log.excerpt.replace(/```/g, 'ˋˋˋ')}\n\`\`\``);
    if (log.annotations.length) parts.push(`Annotations for ${log.name}:\n${log.annotations.slice(0, 20).map(note => `- ${note.path}${note.line ? `:${note.line}` : ''} [${note.level}] ${note.message.split('\n')[0]}`).join('\n')}`);
    const chunk = parts.join('\n\n');
    if (!chunk) continue;
    if (head.length + body.length + chunk.length > PROMPT_BUDGET) { body += `\n\n(More logs were left out; open ${log.url ?? 'the check'} for the rest.)`; break; }
    body += `\n\n${chunk}`;
  }
  return head + body;
}

export interface RepairDeps {
  /** The PR head's checks; `refresh` bypasses the cache. */
  checks(refresh: boolean): Promise<GitHubChecks>;
  logs(failing: GitHubCheck[]): Promise<CiCheckLog[]>;
  /** Sends one prompt and resolves when that agent turn settles. */
  runAgent(prompt: string, attempt: number): Promise<{runId: string; status: string}>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
  /** Called with a fresh copy after every change (phase, message, checks, attempts). */
  emit(state: CiRepair): void;
}
export interface RepairTiming {pollMs: number; settleTimeoutMs: number; pushTimeoutMs: number}
export const REPAIR_TIMING: RepairTiming = {pollMs: 20_000, settleTimeoutMs: 45 * 60_000, pushTimeoutMs: 10 * 60_000};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const names = (checks: GitHubCheck[]) => { const list = checks.map(check => check.name); return list.length > 3 ? `${list.slice(0, 3).join(', ')} and ${list.length - 3} more` : list.join(', '); };

/** Runs the loop to a terminal phase (succeeded, exhausted, failed or stopped) and returns the final state. Never throws. */
export async function runRepairLoop(state: CiRepair, deps: RepairDeps, signal: AbortSignal, timing: RepairTiming = REPAIR_TIMING): Promise<CiRepair> {
  const iso = () => new Date(deps.now()).toISOString();
  const copy = (): CiRepair => ({...state, attempts: state.attempts.map(attempt => ({...attempt})), ...(state.checks ? {checks: {...state.checks}} : {})});
  const emit = (patch: Partial<CiRepair>) => { Object.assign(state, patch); deps.emit(copy()); };
  const finish = (phase: CiRepair['phase'], message: string) => { emit({phase, message, endedAt: iso()}); return copy(); };
  const stopped = (attempt?: CiRepairAttempt) => { if (attempt && !attempt.outcome) { attempt.outcome = 'stopped'; attempt.endedAt = iso(); } return finish('stopped', 'Stopped. The fixes pushed so far stay on the branch.'); };
  /** Poll until nothing is pending (CI settled) or the timeout passes; every read is streamed to the UI. */
  const settle = async (first?: GitHubChecks): Promise<GitHubChecks | 'timeout'> => {
    const deadline = deps.now() + timing.settleTimeoutMs;
    let checks = first ?? await deps.checks(true);
    for (;;) {
      emit({checks: checks.summary, headSha: checks.headSha});
      if (!checks.summary.pending) return checks;
      if (signal.aborted) return checks;
      if (deps.now() >= deadline) return 'timeout';
      emit({phase: state.phase === 'waiting' ? 'waiting' : 'checking', message: `Waiting for ${plural(checks.summary.pending, 'running check')}…`});
      await deps.sleep(timing.pollMs, signal);
      if (signal.aborted) return checks;
      checks = await deps.checks(true);
    }
  };
  let attempt: CiRepairAttempt | undefined;
  try {
    emit({phase: 'checking', message: 'Reading the latest checks…'});
    let checks = await settle();
    for (;;) {
      if (signal.aborted) return stopped(attempt);
      if (checks === 'timeout') return finish('failed', `CI was still running after ${Math.round(timing.settleTimeoutMs / 60_000)} minutes. Try again when it finishes.`);
      const failing = checks.items.filter(isFailingCheck);
      if (attempt) { attempt.outcome = failing.length ? 'still-failing' : 'fixed'; attempt.endedAt = iso(); }
      if (!failing.length) return finish('succeeded', state.attempts.length ? `All checks pass after ${plural(state.attempts.length, 'fix attempt')}.` : 'All checks already pass. Nothing to fix.');
      if (state.attempts.length >= state.maxAttempts) return finish('exhausted', `Still failing after ${plural(state.maxAttempts, 'attempt')}: ${names(failing)}.`);
      attempt = {n: state.attempts.length + 1, startedAt: iso(), failing: failing.map(check => check.name), headBefore: checks.headSha};
      state.attempts.push(attempt);
      emit({phase: 'fixing', message: `Attempt ${attempt.n} of ${state.maxAttempts}: reading logs for ${names(failing)}…`});
      const logs = await deps.logs(failing).catch(() => [] as CiCheckLog[]);
      if (signal.aborted) return stopped(attempt);
      emit({message: `Attempt ${attempt.n} of ${state.maxAttempts}: the agent is fixing ${names(failing)}.`});
      const result = await deps.runAgent(buildRepairPrompt({number: state.number, headRef: state.headRef, attempt: attempt.n, maxAttempts: state.maxAttempts, failing, logs}), attempt.n);
      attempt.runId = result.runId;
      emit({});
      if (signal.aborted) return stopped(attempt);
      if (result.status !== 'completed') { attempt.outcome = 'agent-failed'; attempt.endedAt = iso(); return finish('failed', `The agent’s turn ended ${result.status === 'interrupted' ? 'early' : 'with an error'}, so the repair stopped.`); }
      // CI only has something new to check once a fix is pushed.
      emit({phase: 'waiting', message: 'Waiting for the fix to be pushed…'});
      const deadline = deps.now() + timing.pushTimeoutMs;
      let next = await deps.checks(true);
      while (next.headSha === attempt.headBefore) {
        if (signal.aborted) return stopped(attempt);
        if (deps.now() >= deadline) { attempt.outcome = 'no-push'; attempt.endedAt = iso(); return finish('failed', `No new commit reached ${state.headRef}, so CI has nothing new to check. Push the fix, then try again.`); }
        await deps.sleep(timing.pollMs, signal);
        if (signal.aborted) return stopped(attempt);
        next = await deps.checks(true);
      }
      attempt.headAfter = next.headSha;
      emit({phase: 'waiting', message: `Waiting for CI on ${next.headSha.slice(0, 7)}…`});
      checks = await settle(next);
    }
  } catch (error) {
    if (signal.aborted) return stopped(attempt);
    if (attempt && !attempt.outcome) attempt.endedAt = iso();
    return finish('failed', error instanceof Error ? error.message : String(error));
  }
}

/** Resolves after `ms`, or as soon as the signal aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, {once: true});
  });
}
