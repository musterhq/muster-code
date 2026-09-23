/**
 * Repository and CI triggers for automations (AUT-06). GitHub has no push channel into a desktop app, so the
 * folder's repository is polled through the user's `gh` session (runtime/github.ts; tokens never pass here):
 * open pull requests with their head commits, the watched branch's head, and failed check runs on those
 * commits. Each poll is diffed against the previous one; the first poll only sets the baseline, so opening
 * the app never replays history. Polls back off exponentially on errors (to the maximum on a rate limit)
 * and reset after a success, and one poll yields at most one batch of events per automation, so an event
 * storm on GitHub cannot fan out into unbounded agent runs.
 */
import {promises as fs} from 'node:fs';
import type {RepoTriggerEvent} from '../shared/domains/automations-protocol.ts';
import {GitHubError, githubApi, repoInfo} from './github.ts';

export interface RepoSnapshot {
  pulls: Record<string, {head: string; title: string}>;
  /** The watched branch (or the default branch) and its head commit. */
  branch: string;
  branchHead: string | null;
  /** `${sha}:${check name}` for completed check runs that failed on a watched commit. */
  failed: string[];
}
export interface RepoEvent {kind: RepoTriggerEvent; key: string; description: string}

const FAILED = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);
const MAX_PULLS = 30, MAX_CHECKED = 6;

/** One poll of a folder's GitHub repository. `checks` reads failed check runs (one request per watched commit, capped). */
export async function readRepoSnapshot(root: string, options: {branch?: string; checks: boolean}): Promise<RepoSnapshot> {
  const real = await fs.realpath(root);
  const s = await githubApi.slug(real);
  const base = githubApi.repoPath(s);
  const branch = options.branch || (await repoInfo(real)).defaultBranch;
  const [pulls, head] = await Promise.all([
    githubApi.request<Record<string, unknown>[]>(real, {method: 'GET', path: `${base}/pulls?state=open&sort=updated&direction=desc&per_page=${MAX_PULLS}`}),
    githubApi.request<{commit?: {sha?: unknown}}>(real, {method: 'GET', path: `${base}/branches/${encodeURIComponent(branch)}`}).catch(error => { if (error instanceof GitHubError && error.code === 'not_found') return null; throw error; }),
  ]);
  const snapshot: RepoSnapshot = {pulls: {}, branch, branchHead: typeof head?.commit?.sha === 'string' ? head.commit.sha : null, failed: []};
  for (const row of Array.isArray(pulls) ? pulls : []) {
    const number = typeof row.number === 'number' ? row.number : NaN;
    const sha = (row.head as {sha?: unknown} | undefined)?.sha;
    if (Number.isInteger(number) && typeof sha === 'string') snapshot.pulls[String(number)] = {head: sha, title: typeof row.title === 'string' ? row.title.slice(0, 120) : ''};
  }
  if (options.checks) {
    const shas = [...new Set([...(snapshot.branchHead ? [snapshot.branchHead] : []), ...Object.values(snapshot.pulls).map(pull => pull.head)])].slice(0, MAX_CHECKED);
    const runs = await Promise.all(shas.map(sha => githubApi.request<{check_runs?: Record<string, unknown>[]}>(real, {method: 'GET', path: `${base}/commits/${encodeURIComponent(sha)}/check-runs?filter=latest&per_page=100`})
      .then(body => ({sha, runs: body?.check_runs ?? []}), () => ({sha, runs: [] as Record<string, unknown>[]}))));
    for (const {sha, runs: list} of runs) for (const run of list) if (run.status === 'completed' && FAILED.has(String(run.conclusion))) snapshot.failed.push(`${sha}:${String(run.name ?? 'check')}`);
  }
  return snapshot;
}

/** What changed between two polls, as trigger events. Pure. */
export function diffRepoSnapshots(previous: RepoSnapshot, next: RepoSnapshot): RepoEvent[] {
  const events: RepoEvent[] = [];
  const label = (number: string) => `PR #${number}${next.pulls[number]?.title ? ` “${next.pulls[number]!.title}”` : ''}`;
  for (const [number, pull] of Object.entries(next.pulls)) {
    const before = previous.pulls[number];
    if (!before) events.push({kind: 'pr-opened', key: `pr-opened:${number}:${pull.head}`, description: `${label(number)} was opened`});
    else if (before.head !== pull.head) events.push({kind: 'pr-updated', key: `pr-updated:${number}:${pull.head}`, description: `${label(number)} was updated (new head ${pull.head.slice(0, 7)})`});
  }
  if (previous.branch === next.branch && previous.branchHead && next.branchHead && previous.branchHead !== next.branchHead)
    events.push({kind: 'push', key: `push:${next.branch}:${next.branchHead}`, description: `New commits were pushed to ${next.branch} (${next.branchHead.slice(0, 7)})`});
  const seen = new Set(previous.failed);
  for (const entry of next.failed) {
    if (seen.has(entry)) continue;
    const [sha, ...rest] = entry.split(':');
    const pr = Object.entries(next.pulls).find(([, pull]) => pull.head === sha)?.[0];
    events.push({kind: 'check-failed', key: `check-failed:${entry}`, description: `Check “${rest.join(':')}” failed on ${pr ? label(pr) : `${next.branch} (${sha!.slice(0, 7)})`}`});
  }
  return events;
}

export interface RepoWatch {folderId: string; branch?: string; checks: boolean}
export interface RepoPollerOptions {
  read(watch: RepoWatch): Promise<RepoSnapshot>;
  onEvents(watch: RepoWatch, events: RepoEvent[]): void;
  onError?(watch: RepoWatch, error: unknown, retryInMs: number): void;
  baseMs: number; maxMs: number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(timer: unknown): void;
}
export const repoWatchKey = (watch: {folderId: string; branch?: string}) => `${watch.folderId}\0${watch.branch ?? ''}`;

/** Polls each watched (folder, branch) on its own timer with exponential backoff. */
export class RepoPoller {
  private readonly watches = new Map<string, {watch: RepoWatch; previous?: RepoSnapshot; failures: number; timer?: unknown; busy: boolean}>();
  private disposed = false;
  constructor(private readonly options: RepoPollerOptions) {}
  private set(fn: () => void, ms: number): unknown { if (this.options.setTimer) return this.options.setTimer(fn, ms); const timer = setTimeout(fn, ms); timer.unref?.(); return timer; }
  private clear(timer: unknown): void { if (timer === undefined) return; if (this.options.clearTimer) this.options.clearTimer(timer); else clearTimeout(timer as ReturnType<typeof setTimeout>); }
  keys(): string[] { return [...this.watches.keys()]; }
  /** Adds or updates a watch; a new one polls right away (to take its baseline). */
  watch(watch: RepoWatch): void {
    const key = repoWatchKey(watch), current = this.watches.get(key);
    if (current) { current.watch = watch; return; }
    const entry = {watch, failures: 0, busy: false} as {watch: RepoWatch; previous?: RepoSnapshot; failures: number; timer?: unknown; busy: boolean};
    this.watches.set(key, entry);
    entry.timer = this.set(() => void this.poll(key), 0);
  }
  unwatch(key: string): void { const entry = this.watches.get(key); if (!entry) return; this.clear(entry.timer); this.watches.delete(key); }
  /** Runs one poll now (tests; also the scheduled path). */
  async poll(key: string): Promise<void> {
    const entry = this.watches.get(key);
    if (!entry || entry.busy || this.disposed) return;
    entry.busy = true; entry.timer = undefined;
    let delay = this.options.baseMs;
    try {
      const next = await this.options.read(entry.watch);
      if (this.watches.get(key) !== entry) return;
      const events = entry.previous ? diffRepoSnapshots(entry.previous, next) : [];
      entry.previous = next; entry.failures = 0;
      if (events.length) this.options.onEvents(entry.watch, events);
    } catch (error) {
      entry.failures++;
      delay = error instanceof GitHubError && (error.code === 'rate_limit' || error.code === 'auth' || error.code === 'unavailable')
        ? this.options.maxMs : Math.min(this.options.maxMs, this.options.baseMs * 2 ** entry.failures);
      this.options.onError?.(entry.watch, error, delay);
    } finally {
      entry.busy = false;
      if (!this.disposed && this.watches.get(key) === entry) entry.timer = this.set(() => void this.poll(key), delay);
    }
  }
  dispose(): void { this.disposed = true; for (const entry of this.watches.values()) this.clear(entry.timer); this.watches.clear(); }
}
