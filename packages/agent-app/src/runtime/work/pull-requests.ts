/**
 * Reads a pull request's state and checks for an external object (G34), through the same GitHub layer the in-app pull
 * request surface uses: the signed-in `gh` session, nothing else. Reads only; this module never writes to GitHub.
 */
import { githubApi, summarizeChecks, toPullRequest } from '../github.ts';
import type { GitHubCheck } from '../../shared/domains/github-protocol.ts';
import type { ChecksState, ExternalObject } from '../../shared/domains/work-protocol.ts';

export interface PrStatus { title: string; state: ExternalObject['state']; draft: boolean; checks: ChecksState; checksSummary: string }
const enc = encodeURIComponent;

export async function fetchPullRequest(cwd: string, repo: string, number: number): Promise<PrStatus> {
  const [owner, name] = repo.split('/') as [string, string], base = `repos/${enc(owner)}/${enc(name)}`;
  const pr = toPullRequest(await githubApi.request<Record<string, unknown>>(cwd, { method: 'GET', path: `${base}/pulls/${number}` }));
  let checks: ChecksState = 'none', summary = 'No checks reported.';
  if (pr.headSha && pr.state === 'open') {
    try {
      const runs = await githubApi.request<{ check_runs?: Record<string, unknown>[] }>(cwd, { method: 'GET', path: `${base}/commits/${enc(pr.headSha)}/check-runs?per_page=100` });
      const latest = new Map<string, Record<string, unknown>>();
      for (const run of runs?.check_runs ?? []) { const key = String(run.name ?? ''), prior = latest.get(key); if (!prior || Number(run.id) > Number(prior.id)) latest.set(key, run); }
      const items: GitHubCheck[] = [...latest.values()].map(run => ({ id: String(run.id), name: String(run.name ?? 'Check'), kind: 'check', status: run.status === 'completed' ? 'completed' : run.status === 'in_progress' ? 'in_progress' : 'queued', conclusion: run.status === 'completed' ? String(run.conclusion ?? 'neutral') : null }));
      const s = summarizeChecks(items);
      checks = s.failed ? 'failing' : s.pending ? 'pending' : s.passed ? 'passing' : 'none';
      summary = items.length ? [s.passed && `${s.passed} passed`, s.failed && `${s.failed} failed`, s.pending && `${s.pending} running`, s.skipped && `${s.skipped} skipped`].filter(Boolean).join(' · ') : 'No checks reported.';
    } catch { summary = 'Checks could not be read.'; }
  } else if (pr.state !== 'open') summary = pr.state === 'merged' ? 'Merged.' : 'Closed.';
  return { title: pr.title, state: pr.state, draft: pr.draft, checks, checksSummary: summary };
}
