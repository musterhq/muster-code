/**
 * A Finder-launched app inherits launchd's minimal environment, so keys and PATH entries exported in
 * ~/.zshrc are invisible. Read the login shell's environment once (3s cap) and fill in only variables
 * Muster does not already have; values already set by the launcher always win.
 */
import { execFile } from 'node:child_process';

const SKIP = new Set(['_', 'PWD', 'OLDPWD', 'SHLVL', 'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TERM_SESSION_ID', 'COLORTERM', 'TMPDIR', 'ZDOTDIR', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'NODE_OPTIONS']);
const MARK = '__MUSTER_ENV_7f3a__';

/** Parses `env -0` output between the markers, so banners printed by rc files are ignored. */
export function parseShellEnv(output: string): Record<string, string> {
  const start = output.indexOf(MARK), end = output.lastIndexOf(MARK);
  const body = start >= 0 && end > start ? output.slice(start + MARK.length, end) : output;
  const env: Record<string, string> = {};
  for (const pair of body.split('\0')) {
    const at = pair.indexOf('=');
    const name = pair.slice(0, at).replace(/^\s+/, '');
    if (at > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !SKIP.has(name) && pair.length < 65_536) env[name] = pair.slice(at + 1);
  }
  return env;
}

/** Merges the result into `target`. PATH is unioned (launcher entries first). Returns the names added. */
export function mergeShellEnv(target: NodeJS.ProcessEnv, found: Record<string, string>): string[] {
  const added: string[] = [];
  for (const [name, value] of Object.entries(found)) {
    if (name === 'PATH') {
      const parts = [...(target.PATH ?? '').split(':'), ...value.split(':')].filter(Boolean);
      const next = [...new Set(parts)].join(':');
      if (next !== target.PATH) { target.PATH = next; added.push(name); }
    } else if (target[name] === undefined || target[name] === '') { target[name] = value; added.push(name); }
  }
  return added;
}

type Run = (file: string, args: string[], options: {timeout: number; maxBuffer: number; encoding: 'utf8'; env: NodeJS.ProcessEnv}, done: (error: Error | null, stdout: string) => void) => unknown;
let pending: Promise<string[]> | undefined;
/** Runs once per process. Resolves to the imported variable names ([] on timeout or failure). */
export function importLoginShellEnv(options: { shell?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; run?: Run } = {}): Promise<string[]> {
  if (pending && !options.run) return pending;
  const env = options.env ?? process.env;
  const shell = options.shell ?? env.SHELL ?? '/bin/zsh';
  const run = options.run ?? (execFile as unknown as Run);
  const result = new Promise<string[]>(resolve => {
    if (!/^\/[\w./-]+$/.test(shell)) { resolve([]); return; }
    run(shell, ['-ilc', `printf '${MARK}'; command env -0; printf '${MARK}'`], {timeout: options.timeoutMs ?? 3000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', env: {...env, TERM: 'dumb'}}, (error, stdout) => {
      if (error || typeof stdout !== 'string') { resolve([]); return; }
      resolve(mergeShellEnv(env, parseShellEnv(stdout)));
    });
  });
  if (!options.run) pending = result;
  return result;
}
