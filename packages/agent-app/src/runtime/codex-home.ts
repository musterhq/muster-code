/**
 * #720: Muster runs the coding client with its own home, so the threads it creates never show up in the person's other
 * coding apps that read the same home. The person's home stays the source of truth for everything the client should
 * share: sign-in, configuration, profiles, model catalogs, skills, plugins, rules and helpers are linked in. Threads,
 * the thread index, logs, history and memories stay private to Muster's home.
 */
import {createHash} from 'node:crypto';
import {copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, statSync, symlinkSync, unlinkSync, type Dirent} from 'node:fs';
import {join, resolve} from 'node:path';

const SHARED = new Set(['auth.json', 'config.toml', 'models_cache.json', 'model-catalogs', 'skills', 'plugins', 'rules', 'prompts',
  'AGENTS.md', 'AGENTS.override.md', 'helpers', 'computer-use', 'node_repl', 'packages', 'vendor_imports']);
/** Whether an entry of the person's home is shared with Muster's home (profiles are `<name>.config.toml`). */
export const sharedCodexEntry = (name: string): boolean => SHARED.has(name) || /^[A-Za-z0-9_.-]{1,120}\.config\.toml$/.test(name);

/** Muster's own home for one of the person's homes (the default one or an extra account). */
export function musterCodexHome(dataDir: string, sourceHome: string): string {
  return join(dataDir, 'codex-home', createHash('sha256').update(resolve(sourceHome)).digest('hex').slice(0, 12));
}

/** Links the shared entries of the person's home into Muster's home. Run before each launch, so profiles added since
 *  appear and a link the client replaced with a file (a save that renamed over it) is folded back: the newer copy
 *  goes to the person's home and the link is restored. Where links can't be made (Windows without the privilege),
 *  directories use junctions and files are copied both ways by age. */
export function prepareMusterCodexHome(sourceHome: string, home: string): void {
  mkdirSync(home, {recursive: true, mode: 0o700});
  let entries: Dirent[] = [];
  try { entries = readdirSync(sourceHome, {withFileTypes: true}); } catch { return; }
  for (const entry of entries) {
    if (!sharedCodexEntry(entry.name)) continue;
    const target = join(sourceHome, entry.name), link = join(home, entry.name);
    let directory = entry.isDirectory();
    try { if (entry.isSymbolicLink()) directory = statSync(target).isDirectory(); } catch { continue; }
    let current: ReturnType<typeof lstatSync> | undefined;
    try { current = lstatSync(link); } catch { current = undefined; }
    try {
      if (current?.isSymbolicLink()) { if (readlinkSync(link) === target) continue; unlinkSync(link); }
      else if (current?.isFile()) {
        if (current.mtimeMs > statSync(target).mtimeMs) copyFileSync(link, target);
        unlinkSync(link);
      } else if (current) continue;
      try { symlinkSync(target, link, directory ? 'junction' : 'file'); }
      catch { if (!directory) copyFileSync(target, link); }
    } catch { /* this entry stays as it is; the client reports what it misses */ }
  }
}

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const adopted = new Set<string>();
const subdirs = (dir: string) => { try { return readdirSync(dir, {withFileTypes: true}).filter(entry => entry.isDirectory()).map(entry => entry.name).sort().reverse(); } catch { return []; } };
const rolloutIn = (dir: string, suffix: string) => { try { return readdirSync(dir).find(name => name.startsWith('rollout-') && name.endsWith(suffix)); } catch { return undefined; } };

/** Where a thread's rollout lives under a home: `sessions/YYYY/MM/DD/`, or flat in `archived_sessions/`. */
function findRollout(home: string, threadId: string): {path: string; dated: string[]} | undefined {
  const suffix = `-${threadId}.jsonl`, sessions = join(home, 'sessions');
  for (const year of subdirs(sessions)) for (const month of subdirs(join(sessions, year))) for (const day of subdirs(join(sessions, year, month))) {
    const name = rolloutIn(join(sessions, year, month, day), suffix);
    if (name) return {path: join(sessions, year, month, day, name), dated: [year, month, day, name]};
  }
  const archived = rolloutIn(join(home, 'archived_sessions'), suffix);
  const date = archived?.match(/^rollout-(\d{4})-(\d{2})-(\d{2})T/);
  return archived && date ? {path: join(home, 'archived_sessions', archived), dated: [date[1]!, date[2]!, date[3]!, archived]} : undefined;
}

/** A chat started before #720 has its thread in the person's home: copy it into Muster's home once, so the chat
 *  continues there with its whole history and the person's copy is never written to again. */
export function adoptCodexThread(sourceHome: string, home: string, threadId: string | undefined): void {
  if (!threadId || !THREAD_ID.test(threadId)) return;
  const key = `${home}\0${threadId}`;
  if (adopted.has(key)) return;
  if (!findRollout(home, threadId)) {
    const found = findRollout(sourceHome, threadId);
    if (found) try {
      const [year, month, day, name] = found.dated as [string, string, string, string];
      const folder = join(home, 'sessions', year, month, day);
      mkdirSync(folder, {recursive: true, mode: 0o700});
      if (!existsSync(join(folder, name))) copyFileSync(found.path, join(folder, name));
    } catch { return; }
  }
  if (adopted.size >= 4096) adopted.clear();
  adopted.add(key);
}
