/**
 * Keeps secrets out of process arguments. Run-option overrides normally become `-c key=value` arguments of the Codex
 * process, which any process of the same user can read with `ps`. Values that are secret (lent project secrets, MCP
 * bearer tokens and secret environment) are instead sent in the body of thread/start and thread/resume.
 *  - `shell_environment_policy.set.NAME` (lent secrets, git identity) and
 *  - `secret.<dotted.config.key>` (marked by the domain that holds the value)
 * go to `threadConfig`; everything else stays an argument.
 */
export const SECRET_PREFIX = 'secret.';
const SECRET_KEY = /^(?:secret\.|shell_environment_policy\.set\.)/;

export function splitSecretOverrides(overrides: Record<string, unknown> | undefined): { args: Record<string, unknown>; threadConfig: Record<string, unknown> | undefined } {
  const args: Record<string, unknown> = {}, threadConfig: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!SECRET_KEY.test(key)) { args[key] = value; continue; }
    const path = (key.startsWith(SECRET_PREFIX) ? key.slice(SECRET_PREFIX.length) : key).split('.');
    let at = threadConfig;
    for (const part of path.slice(0, -1)) { const next = at[part]; at = (typeof next === 'object' && next !== null ? next : (at[part] = {})) as Record<string, unknown>; }
    at[path.at(-1)!] = value;
  }
  return { args, threadConfig: Object.keys(threadConfig).length ? threadConfig : undefined };
}
