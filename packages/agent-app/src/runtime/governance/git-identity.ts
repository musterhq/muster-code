/**
 * Per-agent git identity (C12, S87): the name and email an agent's commits carry, so the founder's own identity is never
 * written into an agent's commits. Nothing is ever written to a git config file: the main checkout's .git/config (and
 * every worktree's) stays exactly as the founder left it. The identity travels as run environment:
 *  - GIT_AUTHOR_* and GIT_COMMITTER_*, which git itself reads, and
 *  - GIT_CONFIG_COUNT/KEY_n/VALUE_n, so tools that read config (libgit2, go-git, hooks) see user.name and user.email too.
 * Commits made from Muster's Git tab inside an agent's task worktree pass `-c user.name -c user.email` at commit time.
 */
import type { GitIdentity } from '../../shared/domains/project-governance-protocol.ts';

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
  return {
    [`${p}GIT_AUTHOR_NAME`]: id.name, [`${p}GIT_AUTHOR_EMAIL`]: id.email, [`${p}GIT_COMMITTER_NAME`]: id.name, [`${p}GIT_COMMITTER_EMAIL`]: id.email,
    [`${p}GIT_CONFIG_COUNT`]: '2', [`${p}GIT_CONFIG_KEY_0`]: 'user.name', [`${p}GIT_CONFIG_VALUE_0`]: id.name, [`${p}GIT_CONFIG_KEY_1`]: 'user.email', [`${p}GIT_CONFIG_VALUE_1`]: id.email,
  };
}
/** The `-c` arguments for a commit that must carry an identity. */
export const commitConfigArgs = (id: GitIdentity): string[] => ['-c', `user.name=${id.name}`, '-c', `user.email=${id.email}`];
