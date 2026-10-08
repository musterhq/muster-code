/**
 * Work locally on a folder that is not a git repository (#303): which folders may be bound, the folder Muster makes for a project that has none, the file
 * snapshot taken at check-out (so progress and hand-back can list what changed without a git diff), and whether a folder has a test setup at all.
 * Plain functions over the file system; the service takes them as a port so its tests need no disk.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import type { FileChanges } from '../../shared/domains/checkout-protocol.ts';
import { device } from '../../shared/device-noun.ts';

/** Folders that are never a project's files: the system's own, and the roots that hold everyone's. */
const SYSTEM_EXACT = ['/', '/Users', '/Volumes', '/home', '/private', '/var', '/tmp', '/opt', '/root'];
const SYSTEM_TREES = ['/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/dev', '/Applications', '/cores', '/private/etc'];

/** The folder to use: it must exist, be a directory, and not be `/`, the home folder itself, or a system path. Returns the real path (symlinks resolved). */
export async function validateFolder(path: string, home: string = homedir()): Promise<string> {
  if (!path || typeof path !== 'string' || path.includes('\0')) throw new Error('That is not a usable folder.');
  const abs = resolve(path);
  let real: string;
  try {
    const stat = await fs.stat(abs);
    if (!stat.isDirectory()) throw new Error('That is a file, not a folder. Choose a folder.');
    real = await fs.realpath(abs);
  } catch (cause) {
    if (cause instanceof Error && /That is a file/.test(cause.message)) throw cause;
    throw new Error('That folder does not exist on '+device().lower+'. Choose another.');
  }
  const realHome = await fs.realpath(home).catch(() => resolve(home));
  const same = (a: string, b: string) => a === b || a === b + sep;
  const under = (a: string, tree: string) => a === tree || a.startsWith(tree + sep);
  if (SYSTEM_EXACT.some(p => same(real, p) || same(abs, p)) || same(real, realHome) || same(abs, resolve(home)) || SYSTEM_TREES.some(t => under(real, t) || under(abs, t)))
    throw new Error('Muster will not work in that folder (it is the whole disk, your home folder or a system folder). Choose a folder for this project.');
  return real;
}

/** A name that is safe as one path segment: no separators, no leading dots, no control characters. */
export const folderSegment = (name: string, fallback: string): string => {
  const clean = name.normalize('NFC').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[.\s]+/, '').replace(/[.\s]+$/, '').slice(0, 80);
  return clean || fallback;
};
/** `~/Muster/<Org>/<Project>`, or `~/Muster/<Org>/_tasks/<KEY>` for a task with no project (`~/Muster/<Org>/_tasks` when no task is named: the org's default). */
export const musterFolderPath = (home: string, org: string, project: string | null, taskKey?: string): string =>
  project === null ? join(home, 'Muster', folderSegment(org, 'Org'), '_tasks', ...(taskKey ? [folderSegment(taskKey, 'task')] : [])) : join(home, 'Muster', folderSegment(org, 'Org'), folderSegment(project, 'Project'));
/** Makes the folder (0700) when it is not there yet. An existing folder is used as it is and its permissions are left alone. */
export async function ensureMusterFolder(path: string, home: string): Promise<string> {
  const root = join(home, 'Muster');
  if (!resolve(path).startsWith(root + sep)) throw new Error('Muster only makes folders under ~/Muster.');
  let existed = true;
  await fs.stat(path).catch(() => { existed = false; });
  if (!existed) {
    await fs.mkdir(path, { recursive: true, mode: 0o700 });
    // mkdir's mode is masked by the umask and applies to each folder it makes: set the project folder itself explicitly.
    await fs.chmod(path, 0o700).catch(() => undefined);
  }
  return fs.realpath(path);
}

// --- the file snapshot ----------------------------------------------------------------------------------------------------------------
export interface FileEntry { size: number; mtimeMs: number; sha1?: string }
export type FileSnapshot = Record<string, FileEntry>;
export const SNAPSHOT_MAX_FILES = 20_000;
export const SNAPSHOT_HASH_MAX_BYTES = 5 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules']);

/** Every file under `root` (relative path, size, mtime, and a sha1 for files under 5 MB). Skips `.git`, `node_modules` and every dot-folder, never follows links, and stops at 20,000 files. */
export async function snapshotFolder(root: string): Promise<FileSnapshot> {
  const out: FileSnapshot = {};
  let count = 0;
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (count >= SNAPSHOT_MAX_FILES) return;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue; await walk(join(dir, entry.name), path); continue; }
      if (!entry.isFile()) continue;
      try {
        const full = join(dir, entry.name), stat = await fs.stat(full);
        const item: FileEntry = { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
        if (stat.size < SNAPSHOT_HASH_MAX_BYTES) item.sha1 = createHash('sha1').update(await fs.readFile(full)).digest('hex');
        out[path] = item; count++;
      } catch { /* vanished or unreadable: not part of the snapshot */ }
    }
  };
  await walk(root, '');
  return out;
}

/** What differs between two snapshots. Content decides when both sides have a hash (a file only touched is not a change); otherwise size and time do. */
export function diffSnapshots(before: FileSnapshot, after: FileSnapshot): FileChanges {
  const added: string[] = [], changed: string[] = [], removed: string[] = [];
  for (const [path, now] of Object.entries(after)) {
    const was = before[path];
    if (!was) { added.push(path); continue; }
    const differs = was.sha1 && now.sha1 ? was.sha1 !== now.sha1 : was.size !== now.size || was.mtimeMs !== now.mtimeMs;
    if (differs) changed.push(path);
  }
  for (const path of Object.keys(before)) if (!(path in after)) removed.push(path);
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
}
export const changeCount = (c: FileChanges): number => c.added.length + c.changed.length + c.removed.length;
/** The files as the hand-back lists them: a few of each kind by name, then how many more. */
export function describeChanges(c: FileChanges, folderName: string, limit = 12): string {
  if (!changeCount(c)) return `No files changed in “${folderName}” since check-out.`;
  const part = (label: string, list: string[]) => list.length ? [`${label} (${list.length}): ${list.slice(0, limit).map(f => `\`${f}\``).join(', ')}${list.length > limit ? `, and ${list.length - limit} more` : ''}`] : [];
  return [`Worked in place in “${folderName}” (no branch or pull request).`, ...part('Added', c.added), ...part('Changed', c.changed), ...part('Removed', c.removed)].join('\n');
}
export const folderName = (path: string): string => basename(path) || path;

// --- is there a test setup at all? -------------------------------------------------------------------------------------------------------
const NO_TEST_SCRIPT = /no test specified/i;
/** True when the folder has a recognised way to run tests: a package.json test script, pytest, go.mod, Cargo.toml, a Makefile test target, Maven or Gradle, or a Ruby/PHP/Elixir test setup. A folder with none has no tests to gate on. */
export async function hasTestSetup(dir: string): Promise<boolean> {
  const read = (name: string) => fs.readFile(join(dir, name), 'utf8').catch(() => null);
  const exists = (name: string) => fs.stat(join(dir, name)).then(() => true, () => false);
  const pkg = await read('package.json');
  if (pkg) { try { const script = (JSON.parse(pkg) as { scripts?: Record<string, unknown> }).scripts?.test; if (typeof script === 'string' && script.trim() && !NO_TEST_SCRIPT.test(script)) return true; } catch { /* unreadable package.json: no script */ } }
  for (const name of ['pytest.ini', 'tox.ini', 'conftest.py', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'mix.exs', 'phpunit.xml', 'phpunit.xml.dist']) if (await exists(name)) return true;
  const pyproject = await read('pyproject.toml'); if (pyproject && /\[tool\.pytest|pytest/i.test(pyproject)) return true;
  const setupCfg = await read('setup.cfg'); if (setupCfg && /\[tool:pytest\]/i.test(setupCfg)) return true;
  const make = (await read('Makefile')) ?? (await read('makefile')); if (make && /^test\s*:/m.test(make)) return true;
  const composer = await read('composer.json'); if (composer) { try { if ((JSON.parse(composer) as { scripts?: { test?: unknown } }).scripts?.test) return true; } catch { /* no script */ } }
  if ((await exists('Gemfile')) && ((await exists('spec')) || (await exists('test')))) return true;
  for (const folder of ['tests', 'test']) {
    const names = await fs.readdir(join(dir, folder)).catch(() => [] as string[]);
    if (names.some(n => /^test_.*\.py$|_test\.py$/.test(n))) return true;
  }
  return false;
}
