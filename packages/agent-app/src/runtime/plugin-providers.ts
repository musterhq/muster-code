/**
 * #776: for each plugin Muster ships its own version of, the versions a chat could load ("providers"): Muster's, and any
 * the person already has from another app (its plugin cache, or a skill in their coding-client home). The person picks
 * one per plugin in Skills & plugins (Muster's by default where there is one); codex-home.ts loads only that one.
 *
 * Everything here only reads folders and small manifest files. Nothing found is ever run.
 */
import {createHash} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, isAbsolute, join} from 'node:path';
import {isMusterSkillCopy} from './office-skills.ts';
import type {PluginCapability, PluginCapabilityId, PluginChoiceValue, PluginProvider} from '../shared/domains/extensions-protocol.ts';

interface CapabilitySpec {
  id: PluginCapabilityId; displayName: string;
  /** Plugin folder names (in any marketplace of the plugin cache) that are a version of this plugin. */
  plugins: readonly string[];
  /** Skill folder names (in the home's skills folder) that are a version of this plugin. */
  skills: readonly string[];
  /** What Muster's own version is. */
  muster: 'skill' | 'visualize' | 'computer';
}
export const PLUGIN_CAPABILITIES: readonly CapabilitySpec[] = [
  {id: 'documents', displayName: 'Documents', plugins: ['documents'], skills: ['documents', 'docx', 'doc', 'word'], muster: 'skill'},
  {id: 'spreadsheets', displayName: 'Spreadsheets', plugins: ['spreadsheets'], skills: ['spreadsheets', 'xlsx', 'excel', 'spreadsheet'], muster: 'skill'},
  {id: 'presentations', displayName: 'Presentations', plugins: ['presentations'], skills: ['presentations', 'pptx', 'powerpoint', 'slides', 'presentation'], muster: 'skill'},
  {id: 'pdf', displayName: 'PDF', plugins: ['pdf'], skills: ['pdf'], muster: 'skill'},
  {id: 'visualize', displayName: 'Visualize', plugins: ['visualize'], skills: ['visualize'], muster: 'visualize'},
  {id: 'computer-use', displayName: 'Computer use', plugins: ['computer-use', 'unified-computer-use'], skills: [], muster: 'computer'},
];
/** #771: Muster's skills a chat's home gets when Muster's version is chosen: the office ones, and visualize (its skill
 *  goes with the render_html tool). Computer use is a server, not a skill. */
export const MUSTER_SKILL_NAMES: readonly PluginCapabilityId[] = PLUGIN_CAPABILITIES.filter(spec => spec.muster !== 'computer').map(spec => spec.id);
const CAPABILITY_IDS = new Set<string>(PLUGIN_CAPABILITIES.map(spec => spec.id));
export const isPluginCapability = (value: unknown): value is PluginCapabilityId => typeof value === 'string' && CAPABILITY_IDS.has(value);

/** Where the choices live in Muster's data folder. Read synchronously at turn setup, so a plain JSON file. */
export const PLUGIN_CHOICES_FILE = 'plugin-choices.json';
export interface StoredChoice { choice: PluginChoiceValue; installedId?: string }
export interface PluginChoices { choices: Partial<Record<PluginCapabilityId, StoredChoice>>; /** Fallbacks already told to a chat: capability → missing installed id. */ noticed: Partial<Record<PluginCapabilityId, string>> }

export function readPluginChoices(dataDir: string | undefined): PluginChoices {
  const empty: PluginChoices = {choices: {}, noticed: {}};
  if (!dataDir) return empty;
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, PLUGIN_CHOICES_FILE), 'utf8')) as Partial<PluginChoices>;
    const choices: PluginChoices['choices'] = {}, noticed: PluginChoices['noticed'] = {};
    for (const [id, value] of Object.entries(raw.choices ?? {})) {
      if (!isPluginCapability(id) || !value || !['muster', 'installed', 'off'].includes(value.choice)) continue;
      choices[id] = {choice: value.choice, ...(typeof value.installedId === 'string' ? {installedId: value.installedId} : {})};
    }
    for (const [id, value] of Object.entries(raw.noticed ?? {})) if (isPluginCapability(id) && typeof value === 'string') noticed[id] = value;
    return {choices, noticed};
  } catch { return empty; }
}
export function writePluginChoices(dataDir: string, value: PluginChoices): void {
  const file = join(dataDir, PLUGIN_CHOICES_FILE), temp = `${file}.${process.pid}.tmp`;
  mkdirSync(dirname(file), {recursive: true});
  writeFileSync(temp, JSON.stringify(value, null, 2), {mode: 0o600});
  renameSync(temp, file);
}

const isDirectory = (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } };
const subfolders = (path: string) => { try { return readdirSync(path).filter(name => !name.startsWith('.') && isDirectory(join(path, name))).sort(); } catch { return []; } };
const tilde = (path: string) => { const home = homedir(); return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path; };
function readSmall(path: string, max = 256 * 1024): string | undefined {
  try { const stat = lstatSync(path); if (!stat.isFile() || stat.size > max) return undefined; return readFileSync(path, 'utf8'); } catch { return undefined; }
}
const numeric = (version: string) => version.split(/[.-]/).map(part => /^\d+$/.test(part) ? part.padStart(8, '0') : part).join('.');

/** A plugin folder in the cache: its newest version folder's manifest gives the name and version. */
function pluginProvider(market: string, folder: string, name: string): PluginProvider {
  let version = '', displayName = name;
  for (const candidate of subfolders(folder).sort((a, b) => numeric(a).localeCompare(numeric(b))).reverse()) {
    const text = readSmall(join(folder, candidate, '.codex-plugin', 'plugin.json'));
    if (text === undefined) continue;
    try {
      const manifest = JSON.parse(text) as {version?: unknown; interface?: {displayName?: unknown}};
      version = typeof manifest.version === 'string' ? manifest.version : candidate;
      if (typeof manifest.interface?.displayName === 'string') displayName = manifest.interface.displayName;
    } catch { version = candidate; }
    break;
  }
  return {id: folder, origin: 'installed', form: 'plugin', name: displayName, source: `Plugin cache · ${market}`, version, path: folder};
}
function skillProvider(skills: string, name: string): PluginProvider {
  const path = join(skills, name);
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readSmall(join(path, 'SKILL.md')) ?? '')?.[1] ?? '';
  const version = /^\s*version:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(front)?.[1] ?? '';
  return {id: path, origin: 'installed', form: 'skill', name, source: `Skills folder · ${tilde(skills)}`, version, path};
}

export interface FindOptions {
  /** Muster's shipped skills folder. */
  musterSkills?: string;
  /** Muster's own computer-use launcher, when this machine has one. */
  computerLauncher?: string;
  musterVersion?: string;
}
/** Every version of every plugin, read from `sourceHome` (the person's coding-client home) and Muster's own files. */
export function findPluginProviders(sourceHome: string, options: FindOptions = {}): Map<PluginCapabilityId, {muster: PluginProvider | null; installed: PluginProvider[]}> {
  const version = options.musterVersion || process.env.MUSTER_APP_VERSION || 'built in';
  const cache = join(sourceHome, 'plugins', 'cache'), skills = join(sourceHome, 'skills');
  const markets = subfolders(cache);
  const out = new Map<PluginCapabilityId, {muster: PluginProvider | null; installed: PluginProvider[]}>();
  for (const spec of PLUGIN_CAPABILITIES) {
    const installed: PluginProvider[] = [];
    for (const market of markets) for (const name of spec.plugins) if (isDirectory(join(cache, market, name))) installed.push(pluginProvider(market, join(cache, market, name), name));
    for (const name of spec.skills) if (isDirectory(join(skills, name)) && !isMusterSkillCopy(join(skills, name))) installed.push(skillProvider(skills, name));
    let muster: PluginProvider | null = null;
    const base = {id: `muster:${spec.id}`, origin: 'muster' as const, source: 'Muster', version};
    if (spec.muster === 'skill') { const path = options.musterSkills && join(options.musterSkills, spec.id); if (path && readSmall(join(path, 'SKILL.md')) !== undefined) muster = {...base, form: 'skill', name: spec.id, path}; }
    else if (spec.muster === 'visualize') muster = {...base, form: 'tool', name: 'render_html', path: 'muster_browser/render_html'};
    else if (options.computerLauncher) muster = {...base, form: 'tool', name: 'muster_computer', path: options.computerLauncher};
    out.set(spec.id, {muster, installed});
  }
  return out;
}

export interface PluginPlan {
  capabilities: PluginCapability[];
  /** Muster's skills to copy into the chat's home. */
  copy: ReadonlySet<string>;
  /** Installed plugin and skill folders (in the person's home) to leave out of the chat's home. */
  blocked: ReadonlySet<string>;
  /** Whether Muster's computer-use server joins the turn. */
  musterComputer: boolean;
  /** Changes whenever what a turn loads changes; part of the warm session's signature. */
  key: string;
}
/** Resolves the person's choices against what is on disk. A chosen installed version that is gone falls back to Muster's. */
export function planPluginProviders(sourceHome: string, choices: PluginChoices, options: FindOptions = {}): PluginPlan {
  const found = findPluginProviders(sourceHome, options);
  const capabilities: PluginCapability[] = [], copy = new Set<string>(), blocked = new Set<string>();
  let musterComputer = false;
  for (const spec of PLUGIN_CAPABILITIES) {
    const {muster, installed} = found.get(spec.id)!;
    const stored = choices.choices[spec.id];
    const choice: PluginChoiceValue = stored?.choice ?? (muster ? 'muster' : installed.length ? 'installed' : 'off');
    let active: PluginProvider | null = null, missing = false;
    if (choice === 'muster') active = muster;
    else if (choice === 'installed') {
      active = (stored?.installedId ? installed.find(entry => entry.id === stored.installedId) : installed[0]) ?? null;
      if (!active && stored?.installedId) { missing = true; active = muster; }
    }
    for (const entry of installed) if (entry.id !== active?.id) blocked.add(entry.path);
    if (active?.origin === 'muster' && spec.muster !== 'computer') copy.add(spec.id);
    if (active?.origin === 'muster' && spec.muster === 'computer') musterComputer = true;
    capabilities.push({id: spec.id, displayName: spec.displayName, muster, installed, choice, ...(stored?.installedId && choice === 'installed' ? {installedId: stored.installedId} : {}), active, ...(missing ? {missing} : {})});
  }
  const key = createHash('sha256').update(JSON.stringify(capabilities.map(entry => [entry.id, entry.active?.id ?? null]))).digest('hex').slice(0, 16);
  return {capabilities, copy, blocked, musterComputer, key};
}

/** Muster's own computer-use launcher (main sets it on macOS when the helper shipped; same variable as domains/computer.ts). */
export function musterComputerLauncher(): string | undefined {
  const file = process.env.MUSTER_COMPUTER_MCP_LAUNCHER;
  return file && isAbsolute(file) && existsSync(file) ? file : undefined;
}

/** Tests point this at a fixture home. */
export const pluginSourceOptions: {codexHome?: string} = {};
/** The person's coding-client home Skills & plugins reads (the default account's). */
export const pluginSourceHome = (): string => pluginSourceOptions.codexHome ?? (process.env.CODEX_HOME || join(homedir(), '.codex'));
/** The plan Skills & plugins and the turn notes read: the default home, the choices saved in `dataDir`. */
export const currentPluginPlan = (dataDir: string, musterSkills?: string): PluginPlan =>
  planPluginProviders(pluginSourceHome(), readPluginChoices(dataDir), {musterSkills, computerLauncher: musterComputerLauncher()});

/** One line per chosen installed version that is gone and not yet told: said once, then remembered. */
export function pluginFallbackNote(dataDir: string, plan: PluginPlan): string | undefined {
  const stored = readPluginChoices(dataDir);
  const lines: string[] = [];
  let changed = false;
  for (const entry of plan.capabilities) {
    const told = stored.noticed[entry.id];
    if (entry.missing && entry.installedId) {
      if (told === entry.installedId) continue;
      stored.noticed[entry.id] = entry.installedId; changed = true;
      lines.push(`The installed ${entry.displayName} version chosen in Skills & plugins (${tilde(entry.installedId)}) is no longer there, so this chat uses ${entry.active ? `Muster's ${entry.displayName}` : `no ${entry.displayName} plugin`}. Tell the user this once, briefly.`);
    } else if (told) { delete stored.noticed[entry.id]; changed = true; }
  }
  if (changed) try { writePluginChoices(dataDir, stored); } catch { /* told again next turn */ }
  return lines.length ? lines.join('\n') : undefined;
}
