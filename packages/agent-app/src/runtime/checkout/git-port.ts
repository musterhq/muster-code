/** The few git reads and the one push check-out needs, as a port so the service is testable. Real implementation shells out to git with no prompts. */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { normalizeRemote } from '../memory-identity.ts';
import { device } from '../../shared/device-noun.ts';

export interface WorkStat { count: number; added: number; removed: number }
export interface GitPort {
  isRepo(path: string): Promise<boolean>;
  /** The branch work starts from: the project's dev branch if it exists, else main, master, or the current branch. */
  defaultBranch(path: string, preferred?: string | null): Promise<string>;
  headSha(path: string, rev?: string): Promise<string>;
  /** Files and lines changed in a worktree against a base commit (tracked changes plus new files). */
  stat(path: string, base: string): Promise<WorkStat>;
  push(path: string, branch: string): Promise<{ pushed: boolean; message: string; /** The repository has no remote at all: the branch can only stay on this Mac. */ noRemote?: boolean }>;
  /** Commits every change in the worktree (tracked and new files) as the person's own git identity. Used only when the person said it is done. `committed` is false when there was nothing to commit or git refused (for instance no identity is set). */
  commitAll(path: string, message: string): Promise<{ committed: boolean; message: string }>;
  /** The branch has been pushed from this worktree and the remote copy is the current HEAD (the remote-tracking ref says so; no network). */
  pushedHead(path: string, branch: string): Promise<boolean>;
  /** A pull request link is real and is this worktree's: `gh` says its head branch is `branch` and the repository is the one `origin` points at. False when `gh` is missing or unsure. */
  verifyPr(path: string, url: string, branch: string): Promise<boolean>;
  /** No uncommitted or untracked changes in the worktree. */
  isClean(path: string): Promise<boolean>;
}
const git = (cwd: string, args: string[], timeout = 60_000): Promise<string> => new Promise((resolve, reject) => {
  execFile('git', args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } }, (error, stdout, stderr) => error ? reject(new Error((stderr || error.message).trim())) : resolve(stdout));
});

const run = (cwd: string, cmd: string, args: string[], timeout = 12_000): Promise<string> => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd, timeout, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' } }, (error, stdout) => error ? reject(error) : resolve(stdout));
});
/** The remote of a git folder is the project's repository: `repo` is the server's normalised `host/path` (GitHub, GitLab, Bitbucket or a self-hosted server alike), and any URL form of the same remote matches (https, ssh, scp-style, with credentials or a `.git` suffix). */
export const sameRepo = (repo: string | null | undefined, remoteUrl: string): boolean => {
  if (!repo) return false;
  const given = repo.trim(), want = /^[\w.-]+(?::\d+)?\/\S+$/.test(given) ? given.toLowerCase().replace(/\.git$/, '') : normalizeRemote(given) ?? given.toLowerCase(), have = normalizeRemote(remoteUrl);
  return Boolean(have) && have === want;
};
/** `github.com/org/repo` from a remote URL (https or ssh), lowercased. */
export const repoOf = (url: string): string | null => { const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim()); return m ? `${m[1]}/${m[2]}`.toLowerCase() : null; };
export const realGit: GitPort = {
  async verifyPr(path, url, branch) {
    const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(url);
    if (!m) return false;
    try {
      const origin = repoOf((await git(path, ['config', '--get', 'remote.origin.url'])).trim());
      if (!origin || origin !== `${m[1]}/${m[2]}`.toLowerCase()) return false;
      // The pull request must be from this repository (not a fork), from this branch, and at exactly the commit the worktree is on.
      const out = JSON.parse(await run(path, 'gh', ['pr', 'view', url, '--json', 'headRefName,url,isCrossRepository,headRefOid'])) as { headRefName?: string; url?: string; isCrossRepository?: boolean; headRefOid?: string };
      const head = (await git(path, ['rev-parse', 'HEAD'])).trim();
      return out.headRefName === branch && out.url === url && out.isCrossRepository === false && out.headRefOid === head;
    } catch { return false; }
  },
  async isClean(path) { return (await git(path, ['status', '--porcelain']).catch(() => 'x')).trim() === ''; },
  /** Pushed to the worktree's own upstream: `@{u}` is a remote branch of this name and is exactly HEAD. */
  async pushedHead(path, branch) {
    try {
      const head = (await git(path, ['rev-parse', 'HEAD'])).trim();
      const upstream = (await git(path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
      if (!upstream.endsWith(`/${branch}`)) return false;
      return (await git(path, ['rev-parse', '--verify', '--quiet', upstream])).trim() === head;
    } catch { return false; }
  },

  async isRepo(path) { return git(path, ['rev-parse', '--is-inside-work-tree']).then(out => out.trim() === 'true', () => false); },
  async defaultBranch(path, preferred) {
    const exists = (name: string) => git(path, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]).then(() => true, () => false);
    for (const name of [preferred, 'dev', 'develop', 'main', 'master']) if (name && await exists(name)) return name;
    return (await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  },
  async headSha(path, rev = 'HEAD') { return (await git(path, ['rev-parse', '--verify', `${rev}^{commit}`])).trim(); },
  async stat(path, base) {
    let added = 0, removed = 0; const files = new Set<string>();
    for (const line of (await git(path, ['diff', '--numstat', base]).catch(() => '')).split('\n')) {
      const [a, r, ...name] = line.split('\t');
      if (!name.length) continue;
      files.add(name.join('\t')); added += a === '-' ? 0 : Number(a) || 0; removed += r === '-' ? 0 : Number(r) || 0;
    }
    for (const rel of (await git(path, ['ls-files', '--others', '--exclude-standard']).catch(() => '')).split('\n').filter(Boolean)) {
      files.add(rel);
      try { const text = await fs.readFile(join(path, rel), 'utf8'); added += text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0; } catch { /* binary or unreadable: counted as a file, no lines */ }
    }
    return { count: files.size, added, removed };
  },
  async commitAll(path, message) {
    try {
      await git(path, ['add', '-A']);
      if ((await git(path, ['status', '--porcelain'])).trim() === '') return { committed: false, message: 'Nothing to commit.' };
      // The person's own identity (their git config): Muster never invents an author.
      const name = (await git(path, ['config', 'user.name']).catch(() => '')).trim(), email = (await git(path, ['config', 'user.email']).catch(() => '')).trim();
      if (!name || !email) return { committed: false, message: 'Git has no name and email set on '+device().lower+' (git config user.name / user.email), so Muster cannot commit for you.' };
      await git(path, ['commit', '-q', '-m', message]);
      return { committed: true, message: 'Committed.' };
    } catch (cause) { return { committed: false, message: `Could not commit: ${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)}` }; }
  },
  async push(path, branch) {
    // The remote the project came from: origin when there is one, else the first listed.
    const remotes = (await git(path, ['remote']).catch(() => '')).split('\n').filter(Boolean), remote = remotes.includes('origin') ? 'origin' : remotes[0];
    if (!remote) return { pushed: false, noRemote: true, message: 'This repository has no remote, so the branch stays on '+device().lower+'.' };
    try { await git(path, ['push', '-u', remote, `${branch}:${branch}`], 120_000); return { pushed: true, message: `Pushed ${branch} to ${remote}.` }; }
    catch (cause) { return { pushed: false, message: `Could not push ${branch}: ${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)}` }; }
  },
};
