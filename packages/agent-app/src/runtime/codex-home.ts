/**
 * #720: Muster runs the coding client with its own home, so the threads it creates never show up in the person's other
 * coding apps that read the same home. The person's home stays the source of truth for everything the client should
 * share: sign-in, configuration, profiles, model catalogs, skills, plugins, rules and helpers are linked in. Threads,
 * the thread index, logs, history and memories stay private to Muster's home.
 *
 * #772-#775: `skills` and `plugins` are no longer one link each. They are real folders in Muster's home with a link per
 * entry of the person's folder, so the person's own skills and plugins still load, except those for documents,
 * spreadsheets, presentations and PDF: Muster installs its own skills for those and the other copies are not linked in.
 */
import {createHash} from 'node:crypto';
import {copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmdirSync, statSync, symlinkSync, unlinkSync, type Dirent} from 'node:fs';
import {join, resolve, sep} from 'node:path';
import {installMusterSkills, OFFICE_SKILL_ALIASES} from './office-skills.ts';

const SHARED = new Set(['auth.json', 'config.toml', 'models_cache.json', 'model-catalogs', 'skills', 'plugins', 'rules', 'prompts',
  'AGENTS.md', 'AGENTS.override.md', 'helpers', 'computer-use', 'node_repl', 'packages', 'vendor_imports']);
/** Whether an entry of the person's home is shared with Muster's home (profiles are `<name>.config.toml`). */
export const sharedCodexEntry = (name: string): boolean => SHARED.has(name) || /^[A-Za-z0-9_.-]{1,120}\.config\.toml$/.test(name);

/** Muster's own home for one of the person's homes (the default one or an extra account). */
export function musterCodexHome(dataDir: string, sourceHome: string): string {
  return join(dataDir, 'codex-home', createHash('sha256').update(resolve(sourceHome)).digest('hex').slice(0, 12));
}

/** Plugin folders (in any marketplace of the plugin cache) for the file types Muster's own skills cover. */
export const OFFICE_PLUGIN_NAMES: ReadonlySet<string> = new Set(['documents', 'spreadsheets', 'presentations', 'pdf']);

/** What to do with one entry of a person's folder: link it, leave it out, or mirror it one level down with another rule. */
type MirrorRule = (name: string, target: string) => 'link' | 'skip' | MirrorRule;
const skillsRule: MirrorRule = name => OFFICE_SKILL_ALIASES.has(name) ? 'skip' : 'link';
const marketplaceRule: MirrorRule = name => OFFICE_PLUGIN_NAMES.has(name) ? 'skip' : 'link';
const hasOfficePlugin = (dir: string) => { try { return readdirSync(dir).some(name => OFFICE_PLUGIN_NAMES.has(name)); } catch { return false; } };
const pluginsRule: MirrorRule = name => name === 'cache' ? (_marketplace, target) => hasOfficePlugin(target) ? marketplaceRule : 'link' : 'link';
const MIRRORED: Record<string, MirrorRule> = {skills: skillsRule, plugins: pluginsRule};

const isLink = (path: string) => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };
/** A folder this file made as a mirror: nothing in it but links and such folders, so it can be replaced by a link again. */
function onlyLinks(dir: string): boolean {
  try { return readdirSync(dir, {withFileTypes: true}).every(entry => entry.isSymbolicLink() || (entry.isDirectory() && onlyLinks(join(dir, entry.name)))); } catch { return false; }
}
function removeMirror(dir: string): void {
  for (const entry of readdirSync(dir, {withFileTypes: true})) { const path = join(dir, entry.name); if (entry.isSymbolicLink()) unlinkSync(path); else removeMirror(path); }
  rmdirSync(dir);
}

/** Links `target` at `link`, replacing an older link, folding a file the client saved over a link back into the person's home. */
function linkEntry(target: string, link: string, directory: boolean, mirrorable = false): void {
  let current: ReturnType<typeof lstatSync> | undefined;
  try { current = lstatSync(link); } catch { current = undefined; }
  try {
    if (current?.isSymbolicLink()) { if (readlinkSync(link) === target) return; unlinkSync(link); }
    else if (current?.isFile()) {
      if (current.mtimeMs > statSync(target).mtimeMs) copyFileSync(link, target);
      unlinkSync(link);
    } else if (current?.isDirectory() && mirrorable && onlyLinks(link)) removeMirror(link);
    else if (current) return;
    try { symlinkSync(target, link, directory ? 'junction' : 'file'); }
    catch { if (!directory) copyFileSync(target, link); }
  } catch { /* this entry stays as it is; the client reports what it misses */ }
}

/** Makes `link` a real folder with a link per entry of `target`, as `rule` says. Links it made for entries that are gone or
 *  now left out are removed; real files and folders (Muster's own skills) are never touched. */
function mirror(target: string, link: string, rule: MirrorRule): void {
  try {
    const current = lstatSync(link);
    if (current.isSymbolicLink()) unlinkSync(link); // the old whole-folder link; never followed
    else if (!current.isDirectory()) return;
  } catch { /* not there yet */ }
  mkdirSync(link, {recursive: true, mode: 0o700});
  let entries: Dirent[] = [];
  try { entries = readdirSync(target, {withFileTypes: true}); } catch { return; }
  const names = new Set<string>();
  for (const entry of entries) {
    const from = join(target, entry.name), to = join(link, entry.name);
    names.add(entry.name);
    let directory = entry.isDirectory();
    try { if (entry.isSymbolicLink()) directory = statSync(from).isDirectory(); } catch { continue; }
    const action = rule(entry.name, from);
    if (action === 'skip') { if (isLink(to)) try { unlinkSync(to); } catch { /* stays */ } continue; }
    if (action === 'link') { linkEntry(from, to, directory, true); continue; }
    if (directory) mirror(from, to, action); else linkEntry(from, to, false);
  }
  // Links to entries the person has since removed.
  for (const entry of readdirSync(link, {withFileTypes: true})) {
    if (names.has(entry.name) || !entry.isSymbolicLink()) continue;
    const path = join(link, entry.name);
    try { if (readlinkSync(path).startsWith(target + sep)) unlinkSync(path); } catch { /* stays */ }
  }
}

export interface PrepareCodexHomeOptions {
  /** Muster's own skills folder (resources/skills); its skills are installed into Muster's home. */
  musterSkills?: string;
}

/** Links the shared entries of the person's home into Muster's home. Run before each launch, so profiles added since
 *  appear and a link the client replaced with a file (a save that renamed over it) is folded back: the newer copy
 *  goes to the person's home and the link is restored. Where links can't be made (Windows without the privilege),
 *  directories use junctions and files are copied both ways by age. Skills and plugins are mirrored per entry (see top). */
export function prepareMusterCodexHome(sourceHome: string, home: string, options: PrepareCodexHomeOptions = {}): void {
  mkdirSync(home, {recursive: true, mode: 0o700});
  let entries: Dirent[] = [];
  try { entries = readdirSync(sourceHome, {withFileTypes: true}); } catch { entries = []; }
  for (const entry of entries) {
    if (!sharedCodexEntry(entry.name)) continue;
    const target = join(sourceHome, entry.name), link = join(home, entry.name);
    let directory = entry.isDirectory();
    try { if (entry.isSymbolicLink()) directory = statSync(target).isDirectory(); } catch { continue; }
    const rule = MIRRORED[entry.name];
    if (rule && directory) mirror(target, link, rule);
    else linkEntry(target, link, directory);
  }
  if (options.musterSkills) {
    // Without a skills folder in the person's home there is still one in Muster's, for Muster's own skills.
    if (isLink(join(home, 'skills'))) try { unlinkSync(join(home, 'skills')); } catch { /* stays */ }
    installMusterSkills(options.musterSkills, join(home, 'skills'));
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
