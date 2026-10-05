/** The few git reads and the one push check-out needs, as a port so the service is testable. Real implementation shells out to git with no prompts. */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export interface WorkStat { count: number; added: number; removed: number }
export interface GitPort {
  isRepo(path: string): Promise<boolean>;
  /** The branch work starts from: the project's dev branch if it exists, else main, master, or the current branch. */
  defaultBranch(path: string, preferred?: string | null): Promise<string>;
  headSha(path: string, rev?: string): Promise<string>;
  /** Files and lines changed in a worktree against a base commit (tracked changes plus new files). */
  stat(path: string, base: string): Promise<WorkStat>;
  push(path: string, branch: string): Promise<{ pushed: boolean; message: string }>;
  /** The branch has been pushed from this worktree and the remote copy is the current HEAD (the remote-tracking ref says so; no network). */
  pushedHead(path: string, branch: string): Promise<boolean>;
}
const git = (cwd: string, args: string[], timeout = 60_000): Promise<string> => new Promise((resolve, reject) => {
  execFile('git', args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } }, (error, stdout, stderr) => error ? reject(new Error((stderr || error.message).trim())) : resolve(stdout));
});

export const realGit: GitPort = {
  async pushedHead(path, branch) {
    try {
      const head = (await git(path, ['rev-parse', 'HEAD'])).trim();
      for (const remote of (await git(path, ['remote'])).split('\n').filter(Boolean)) { const ref = await git(path, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`]).catch(() => ''); if (ref.trim() === head) return true; }
    } catch { /* no remote */ }
    return false;
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
  async push(path, branch) {
    const remote = (await git(path, ['remote']).catch(() => '')).split('\n').filter(Boolean)[0];
    if (!remote) return { pushed: false, message: 'This repository has no remote, so the branch stays on this Mac.' };
    try { await git(path, ['push', '-u', remote, `${branch}:${branch}`], 120_000); return { pushed: true, message: `Pushed ${branch} to ${remote}.` }; }
    catch (cause) { return { pushed: false, message: `Could not push ${branch}: ${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)}` }; }
  },
};
