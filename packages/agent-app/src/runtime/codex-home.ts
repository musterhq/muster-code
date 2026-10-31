/**
 * #720: Muster runs the coding client with its own home, so the threads it creates never show up in the person's other
 * coding apps that read the same home. The person's home stays the source of truth for everything the client should
 * share: sign-in, configuration, profiles, model catalogs, skills, plugins, rules and helpers are linked in. Threads,
 * the thread index, logs, history and memories stay private to Muster's home.
 *
 * #772-#775: `skills` and `plugins` are no longer one link each. They are real folders in Muster's home with a link per
 * entry of the person's folder, so the person's own skills and plugins still load.
 *
 * #776: for documents, spreadsheets, presentations, PDF, visualize and computer use only the version the person chose in
 * Skills & plugins is loaded (plugin-providers.ts): Muster's (its skill is copied in) or one installed version (its link
 * stays), never both. Every other installed version of the same plugin is left out.
 */
import {createHash} from 'node:crypto';
import {copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, type Dirent} from 'node:fs';
import {join, resolve, sep} from 'node:path';
import {installMusterSkills, isMusterSkillCopy, MUSTER_OFFICE_SKILLS} from './office-skills.ts';
import {musterComputerLauncher, planPluginProviders, readPluginChoices, type PluginPlan} from './plugin-providers.ts';

const SHARED = new Set(['auth.json', 'config.toml', 'models_cache.json', 'model-catalogs', 'skills', 'plugins', 'rules', 'prompts',
  'AGENTS.md', 'AGENTS.override.md', 'helpers', 'computer-use', 'node_repl', 'packages', 'vendor_imports']);
/** Whether an entry of the person's home is shared with Muster's home (profiles are `<name>.config.toml`). */
export const sharedCodexEntry = (name: string): boolean => SHARED.has(name) || /^[A-Za-z0-9_.-]{1,120}\.config\.toml$/.test(name);

/** Muster's own home for one of the person's homes (the default one or an extra account). */
export function musterCodexHome(dataDir: string, sourceHome: string): string {
  return join(dataDir, 'codex-home', createHash('sha256').update(resolve(sourceHome)).digest('hex').slice(0, 12));
}

/** What to do with one entry of a person's folder: link it, leave it out, or mirror it one level down with another rule. */
type MirrorRule = (name: string, target: string) => 'link' | 'skip' | MirrorRule;
/** Skills and plugins are mirrored per entry, leaving out the installed plugin versions the person did not choose. */
function mirroredRules(blocked: ReadonlySet<string>): Record<string, MirrorRule> {
  const leaveOut: MirrorRule = (_name, target) => blocked.has(target) ? 'skip' : 'link';
  const holdsBlocked = (dir: string) => { try { return readdirSync(dir).some(name => blocked.has(join(dir, name))); } catch { return false; } };
  const plugins: MirrorRule = name => name === 'cache' ? (_marketplace, target) => holdsBlocked(target) ? leaveOut : 'link' : 'link';
  return {skills: leaveOut, plugins};
}

const isLink = (path: string) => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };
/** A folder this file made as a mirror: nothing in it but links and such folders, so it can be replaced by a link again. */
function onlyLinks(dir: string): boolean {
  try { return readdirSync(dir, {withFileTypes: true}).every(entry => entry.isSymbolicLink() || (entry.isDirectory() && onlyLinks(join(dir, entry.name)))); } catch { return false; }
}
/** Whether a mirror folder holds a link into `target` (so it is one this file made for an entry of `target`). */
function hasLinkInto(dir: string, target: string): boolean {
  try { return readdirSync(dir, {withFileTypes: true}).some(entry => entry.isSymbolicLink() ? readlinkSync(join(dir, entry.name)).startsWith(target + sep) : entry.isDirectory() && hasLinkInto(join(dir, entry.name), target)); } catch { return false; }
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
  // Links to entries the person has since removed, and mirror folders of removed folders (another app uninstalled).
  for (const entry of readdirSync(link, {withFileTypes: true})) {
    if (names.has(entry.name)) continue;
    const path = join(link, entry.name);
    if (entry.isSymbolicLink()) { try { if (readlinkSync(path).startsWith(target + sep)) unlinkSync(path); } catch { /* stays */ } }
    else if (entry.isDirectory() && hasLinkInto(path, target) && onlyLinks(path)) try { removeMirror(path); } catch { /* stays */ }
  }
}

export interface PrepareCodexHomeOptions {
  /** Muster's own skills folder (resources/skills); its skills are installed into Muster's home. */
  musterSkills?: string;
  /** #776: which version of each plugin to load; without one, the defaults (Muster's where it has one). */
  plan?: Pick<PluginPlan, 'copy' | 'blocked'>;
}

/** Links the shared entries of the person's home into Muster's home. Run before each launch, so profiles added since
 *  appear and a link the client replaced with a file (a save that renamed over it) is folded back: the newer copy
 *  goes to the person's home and the link is restored. Where links can't be made (Windows without the privilege),
 *  directories use junctions and files are copied both ways by age. Skills and plugins are mirrored per entry (see top). */
export function prepareMusterCodexHome(sourceHome: string, home: string, options: PrepareCodexHomeOptions = {}): void {
  const plan = options.plan ?? planPluginProviders(sourceHome, {choices: {}, noticed: {}}, {musterSkills: options.musterSkills, computerLauncher: musterComputerLauncher()});
  const rules = mirroredRules(plan.blocked);
  mkdirSync(home, {recursive: true, mode: 0o700});
  // Muster's copy of a skill the person no longer loads goes first, so a chosen installed skill of the same name links.
  for (const name of MUSTER_OFFICE_SKILLS) {
    const path = join(home, 'skills', name);
    if (!plan.copy.has(name) && isMusterSkillCopy(path)) try { rmSync(path, {recursive: true, force: true}); } catch { /* stays */ }
  }
  let entries: Dirent[] = [];
  try { entries = readdirSync(sourceHome, {withFileTypes: true}); } catch { entries = []; }
  for (const entry of entries) {
    if (!sharedCodexEntry(entry.name)) continue;
    const target = join(sourceHome, entry.name), link = join(home, entry.name);
    let directory = entry.isDirectory();
    try { if (entry.isSymbolicLink()) directory = statSync(target).isDirectory(); } catch { continue; }
    const rule = rules[entry.name];
    if (rule && directory) mirror(target, link, rule);
    else linkEntry(target, link, directory);
  }
  if (options.musterSkills && plan.copy.size) {
    // Without a skills folder in the person's home there is still one in Muster's, for Muster's own skills.
    if (isLink(join(home, 'skills'))) try { unlinkSync(join(home, 'skills')); } catch { /* stays */ }
    installMusterSkills(options.musterSkills, join(home, 'skills'), plan.copy);
  }
}

/** #776: what a turn runs before it starts: reads the person's choices, links only the chosen versions into the chat's
 *  home and returns the plan (its key joins the warm session's signature, so a changed choice applies on the next turn). */
export function prepareChatCodexHome(sourceHome: string, home: string, options: {dataDir: string | undefined; musterSkills?: string; computerLauncher?: string}): PluginPlan {
  const plan = planPluginProviders(sourceHome, readPluginChoices(options.dataDir), {musterSkills: options.musterSkills, computerLauncher: options.computerLauncher ?? musterComputerLauncher()});
  prepareMusterCodexHome(sourceHome, home, {musterSkills: options.musterSkills, plan});
  return plan;
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
