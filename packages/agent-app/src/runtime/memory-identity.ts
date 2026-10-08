/** Which Hindsight bank a memory lives in, for an organisation sharing one Hindsight server.
 *
 * Local memory keeps its own scopes (Personal is `user:local` on every Mac). Hindsight needs identities that
 * mean the same thing on every Mac:
 * - Personal: one bank per person. The identity is MUSTER_MEMORY_IDENTITY (IT can push it), else the
 *   person's git user.email, else `username@host`. Only a hash of it reaches the server.
 * - A folder that is a git repository: one bank per repository, keyed by its normalised `origin` URL, so
 *   everyone working on the same codebase shares its memory. A folder without a remote stays private: its
 *   bank is keyed by the person and the folder.
 * - A Project: keyed by its primary folder's repository and the Project name, so a team's Project of the
 *   same name on the same repository shares one bank; otherwise private to the person.
 * Access control on a shared server is the server's job (keys per person or team); these ids only decide
 * which memories belong together. */
import {createHash} from 'node:crypto';
import {execFile, execFileSync} from 'node:child_process';
import {hostname, userInfo} from 'node:os';

export interface MemoryIdentityDeps {
  env?: NodeJS.ProcessEnv;
  /** `git config` reader; returns the trimmed value or undefined. Injected by tests. */
  git?: (args: string[], cwd?: string) => string | undefined;
  /** Async `git config` reader (the runtime path: it never blocks the Electron main process). Defaults to `git`, or to `git` wrapped when injected. */
  gitAsync?: (args: string[], cwd?: string) => Promise<string | undefined>;
  user?: () => string;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);

const runGit = (args: string[], cwd?: string): string | undefined => {
  try {
    const out = execFileSync('git', args, {cwd, timeout: 1500, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: {...process.env, GIT_TERMINAL_PROMPT: '0'}});
    return out.trim() || undefined;
  } catch { return undefined; }
};

const runGitAsync = (args: string[], cwd?: string): Promise<string | undefined> => new Promise(resolve => {
  try {
    execFile('git', args, {cwd, timeout: 1500, encoding: 'utf8', env: {...process.env, GIT_TERMINAL_PROMPT: '0'}}, (error, stdout) => resolve(error ? undefined : String(stdout).trim() || undefined));
  } catch { resolve(undefined); }
});

/** `git@github.com:Org/Repo.git`, `https://user:token@github.com/org/repo` and `ssh://git@github.com/org/repo`
 *  all become `github.com/org/repo`. Credentials never survive. */
export function normalizeRemote(url: string): string | undefined {
  let value = url.trim();
  if (!value) return undefined;
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(value);
  if (scp) value = `${scp[1]}/${scp[2]}`;
  else {
    try { const parsed = new URL(value); value = `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}${parsed.pathname}`; }
    catch { if (!/^[\w.-]+\/[\w./-]+$/.test(value)) return undefined; }
  }
  value = value.replace(/\.git\/?$/i, '').replace(/\/+$/, '').replace(/^\/+/, '').toLowerCase();
  return /^[^/\s]+\/.+/.test(value) ? value : undefined;
}

export function createMemoryIdentity(deps: MemoryIdentityDeps = {}) {
  const env = deps.env ?? process.env, git = deps.git ?? runGit;
  const gitAsync = deps.gitAsync ?? (deps.git ? async (args: string[], cwd?: string) => deps.git!(args, cwd) : runGitAsync);
  const user = deps.user ?? (() => { try { return `${userInfo().username}@${hostname()}`; } catch { return 'unknown@unknown'; } });
  let person: string | undefined;
  const remotes = new Map<string, string | null>();
  const personId = (): string => person ??= hash(`person:${(env.MUSTER_MEMORY_IDENTITY?.trim() || git(['config', '--global', 'user.email']) || user()).toLowerCase()}`);
  const repoOf = (path: string): string | undefined => {
    if (!remotes.has(path)) {
      const url = git(['config', '--get', 'remote.origin.url'], path);
      remotes.set(path, url ? normalizeRemote(url) ?? null : null);
    }
    return remotes.get(path) ?? undefined;
  };
  // Async twins: the same caches, filled without a blocking spawn. Concurrent lookups share one git call.
  const pending = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, run: () => Promise<T>): Promise<T> => {
    let promise = pending.get(key) as Promise<T> | undefined;
    if (!promise) { promise = run().finally(() => pending.delete(key)); pending.set(key, promise); }
    return promise;
  };
  const personAsync = async (): Promise<string> => {
    if (person) return person;
    const configured = env.MUSTER_MEMORY_IDENTITY?.trim();
    const email = configured ? undefined : await once('person', () => gitAsync(['config', '--global', 'user.email']));
    return person ??= hash(`person:${(configured || email || user()).toLowerCase()}`);
  };
  const repoOfAsync = async (path: string): Promise<string | undefined> => {
    if (!remotes.has(path)) {
      const url = await once(`repo:${path}`, () => gitAsync(['config', '--get', 'remote.origin.url'], path));
      if (!remotes.has(path)) remotes.set(path, url ? normalizeRemote(url) ?? null : null);
    }
    return remotes.get(path) ?? undefined;
  };
  return {
    /** True once the person id and this folder's remote are cached, so the sync methods cannot spawn git. */
    isWarm: (path?: string) => Boolean(person) && (path === undefined || remotes.has(path)),
    /** Pre-fills the person and per-folder remote caches without blocking. */
    async warm(folders: Array<{id: string; path: string}>) { await personAsync(); await Promise.all(folders.map(folder => repoOfAsync(folder.path))); },
    async personalAsync() { return {kind: 'user', id: await personAsync()}; },
    async folderAsync(folder: {id: string; path: string}) {
      const repo = await repoOfAsync(folder.path);
      return repo ? {kind: 'workspace', id: `repo-${hash(`repo:${repo}`)}`} : {kind: 'workspace', id: `private-${hash(`${await personAsync()}:${folder.id}`)}`};
    },
    async projectAsync(project: {id: string; name: string}, primary?: {id: string; path: string}) {
      const repo = primary ? await repoOfAsync(primary.path) : undefined;
      const name = project.name.trim().toLowerCase().replace(/\s+/g, ' ');
      return repo ? {kind: 'project', id: `repo-${hash(`project:${repo}:${name}`)}`} : {kind: 'project', id: `private-${hash(`${await personAsync()}:${project.id}`)}`};
    },
    /** Hindsight scope for a local memory scope. */
    personal: () => ({kind: 'user', id: personId()}),
    folder(folder: {id: string; path: string}) {
      const repo = repoOf(folder.path);
      return repo ? {kind: 'workspace', id: `repo-${hash(`repo:${repo}`)}`} : {kind: 'workspace', id: `private-${hash(`${personId()}:${folder.id}`)}`};
    },
    project(project: {id: string; name: string}, primary?: {id: string; path: string}) {
      const repo = primary ? repoOf(primary.path) : undefined;
      const name = project.name.trim().toLowerCase().replace(/\s+/g, ' ');
      return repo ? {kind: 'project', id: `repo-${hash(`project:${repo}:${name}`)}`} : {kind: 'project', id: `private-${hash(`${personId()}:${project.id}`)}`};
    },
    /** What the Memory screen can say about where a scope's memories go. */
    describe(folder?: {path: string}): 'personal' | 'team' | 'private' {
      if (!folder) return 'personal';
      return repoOf(folder.path) ? 'team' : 'private';
    },
  };
}
export type MemoryIdentity = ReturnType<typeof createMemoryIdentity>;
