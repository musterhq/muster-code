/**
 * Per-agent git identity (C12, S87): the name and email an agent's commits carry, so the founder's own identity is never
 * written into an agent's commits. Applied two ways, both real:
 *  1. As run environment (GIT_AUTHOR_* and GIT_COMMITTER_*), through the run-option override that Codex, Claude Code and
 *     OpenCode runs all honour (see envOverrides below and provider.ts).
 *  2. As worktree-local git config for the task's worktree, so a commit made by any tool inside it (and the Git tab) carries it.
 *     The project's main checkout is never touched: its identity stays yours.
 */
import { execFile } from 'node:child_process';
import type { GitIdentity } from '../../shared/domains/project-governance-protocol.ts';

const run = (cwd: string, args: string[]) => new Promise<string>((resolve, reject) => execFile('git', args, { cwd, timeout: 8000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (e, out, err) => e ? reject(new Error((err || e.message).trim())) : resolve(out.trim())));

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
export function validateIdentity(input: unknown): GitIdentity {
  const i = input as Partial<GitIdentity> | null;
  const name = typeof i?.name === 'string' ? i.name.trim() : '', email = typeof i?.email === 'string' ? i.email.trim() : '';
  if (!name || name.length > 120 || /[<>\n\r\0]/.test(name)) throw new Error('A git name is up to 120 characters, without angle brackets or line breaks.');
  if (!EMAIL.test(email) || email.length > 200) throw new Error('Enter a valid git email, like agent@yourcompany.dev.');
  return { name, email };
}
/** The run-environment overrides for an identity. The `shell_environment_policy.set.*` keys are the shape the run-options seam understands. */
export function envOverrides(id: GitIdentity): Record<string, string> {
  const p = 'shell_environment_policy.set.';
  return { [`${p}GIT_AUTHOR_NAME`]: id.name, [`${p}GIT_AUTHOR_EMAIL`]: id.email, [`${p}GIT_COMMITTER_NAME`]: id.name, [`${p}GIT_COMMITTER_EMAIL`]: id.email };
}
/** Is `cwd` a linked worktree (not the main checkout)? */
export async function isLinkedWorktree(cwd: string): Promise<boolean> {
  try { const [dir, common] = await Promise.all([run(cwd, ['rev-parse', '--git-dir']), run(cwd, ['rev-parse', '--git-common-dir'])]); const abs = (p: string) => p.startsWith('/') || /^[A-Za-z]:/.test(p) ? p : `${cwd}/${p}`; return abs(dir).replace(/\/+$/, '') !== abs(common).replace(/\/+$/, ''); } catch { return false; }
}
export type AppliedIdentity = { applied: 'worktree'; name: string; email: string } | { applied: 'environment-only'; reason: string };
/** Writes the identity into the worktree's own config. A main checkout is left alone and the run relies on the environment. */
export async function applyIdentity(cwd: string, id: GitIdentity): Promise<AppliedIdentity> {
  if (!(await isLinkedWorktree(cwd))) return { applied: 'environment-only', reason: 'This run works in the project’s main checkout, which keeps your own git identity. The agent’s identity applies to its run environment only.' };
  try {
    await run(cwd, ['config', 'extensions.worktreeConfig', 'true']);
    await run(cwd, ['config', '--worktree', 'user.name', id.name]);
    await run(cwd, ['config', '--worktree', 'user.email', id.email]);
    return { applied: 'worktree', ...id };
  } catch (err) { return { applied: 'environment-only', reason: `The worktree config could not be written (${err instanceof Error ? err.message : 'git error'}); the identity applies to the run environment only.` }; }
}
/** The identity git would use inside `cwd` right now (worktree config included). */
export async function effectiveIdentity(cwd: string): Promise<{ name: string; email: string } | null> {
  try { return { name: await run(cwd, ['config', 'user.name']), email: await run(cwd, ['config', 'user.email']) }; } catch { return null; }
}
