/** Bounded, read-only inventory of local skills and installed plugin manifests, filtered by the extensions domain's enablement gates. */
import { constants, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { MAX_ATTACHED_SKILL_BYTES, type ItemIcon, type PluginEntry, type SkillEntry } from '../shared/protocol.ts';
import { BRAND_COLOR, luminance, monogram } from '../shared/item-icon.ts';
import { readAsset } from './file-assets.ts';
import { brandIconFiles, remoteIconFiles, type RemoteIconFiles } from './remote-plugin-icons.ts';

export type { PluginEntry, SkillEntry };

const MAX_README = 65536;
const MAX_ENTRIES = 200;
const MAX_MANIFEST = 262144;
/** A skills root; `only` restricts it to one child directory (a single-skill marketplace install). */
export interface SkillRoot { path: string; provenance: string; only?: string; name?: string; claude?: 'skill' | 'command' }
let extensionRoots: SkillRoot[] = [];
let skillGate: ((entry: SkillEntry, folderPaths: string[]) => boolean) | null = null;
let pluginGate: ((entry: PluginEntry) => boolean) | null = null;
/** Installed marketplace extensions contribute skill roots (lowest precedence: folder > user > global). */
export function setExtensionSkillRoots(roots: SkillRoot[]): void { extensionRoots = roots.slice(0, 200); }
/** Enablement filters: disabled skills and plugins are left out of discovery and refused at attach time. */
export function setDiscoveryGates(gates: { skill?: typeof skillGate; plugin?: typeof pluginGate }): void { if ('skill' in gates) skillGate = gates.skill ?? null; if ('plugin' in gates) pluginGate = gates.plugin ?? null; }
const ROOTS = (folderPaths: string[]): SkillRoot[] => [
  { path: join(homedir(), '.agents', 'skills'), provenance: '~/.agents/skills' },
  { path: join(homedir(), '.codex', 'skills'), provenance: '~/.codex/skills' },
  { path: join(homedir(), '.omp', 'agent', 'skills'), provenance: '~/.omp/agent/skills' },
  // #729: Claude Code's own skills and commands, user-level and per folder (a worktree added as a folder has its own).
  { path: join(homedir(), '.claude', 'skills'), provenance: '~/.claude/skills', claude: 'skill' },
  { path: join(homedir(), '.claude', 'commands'), provenance: '~/.claude/commands', claude: 'command' },
  ...folderPaths.flatMap((path): SkillRoot[] => [
    { path: join(path, '.agents', 'skills'), provenance: `.agents/skills (${basename(path)})` },
    { path: join(path, '.claude', 'skills'), provenance: `.claude/skills (${basename(path)})`, claude: 'skill' },
    { path: join(path, '.claude', 'commands'), provenance: `.claude/commands (${basename(path)})`, claude: 'command' },
  ]),
  ...extensionRoots,
];
/** Claude Code reads commands from nested folders too (`commands/fe/comp.md` is `/fe:comp`); a bounded walk. */
const COMMAND_DEPTH = 3;

async function contained(path: string, root: string): Promise<string | null> {
  try {
    const resolved = await fs.realpath(path);
    return resolved === root || resolved.startsWith(`${root}/`) ? resolved : null;
  } catch { return null; }
}

async function readSkill(dir: string, root: string): Promise<{ readme: string | null; readError: string | null }> {
  const path = await contained(join(dir, 'SKILL.md'), root);
  if (!path) return { readme: null, readError: null };
  try {
    const read = await readContainedText(path, root, MAX_README, true);
    return read === null ? { readme: null, readError: null } : { readme: read, readError: null };
  } catch (error) { return { readme: null, readError: error instanceof Error ? error.message : String(error) }; }
}

/**
 * Reads a file already resolved inside `root` without following a link swapped in after that check: the open refuses a
 * symlink (on macOS in any path component; on Linux the kernel's path for the opened file must be the resolved one), and the
 * opened file must still be the one at the resolved path inside the root. Null when it is not a regular
 * file, has moved out of the root, or (unless `truncate`) is over `max` bytes.
 */
// macOS refuses a link in ANY component at open time (O_NOFOLLOW_ANY), which closes a parent folder swapped for a link between
// the checks and the open; `resolved` is already a realpath, so a genuine path has no links to refuse.
const OPEN_NO_LINKS = process.platform === 'darwin' ? constants.O_RDONLY | 0x20000000 : constants.O_RDONLY | constants.O_NOFOLLOW;
/** Linux: the path the kernel holds for an open file, so a parent folder swapped for a link before the open is seen however the
 *  race is timed. Null when /proc is not there, which refuses the read. */
async function openedPath(fd: number): Promise<string | null> {
  try { return await fs.readlink(`/proc/self/fd/${fd}`); } catch { return null; }
}
async function readContainedText(resolved: string, root: string, max: number, truncate = false): Promise<string | null> {
  const handle = await fs.open(resolved, OPEN_NO_LINKS);
  try {
    if (process.platform === 'linux' && await openedPath(handle.fd) !== resolved) return null;
    const opened = await handle.stat();
    if (!opened.isFile() || (!truncate && opened.size > max)) return null;
    if (await contained(resolved, root) !== resolved) return null;
    const now = await fs.lstat(resolved);
    if (now.dev !== opened.dev || now.ino !== opened.ino) return null;
    const buffer = Buffer.alloc(Math.min(max, opened.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

const MAX_ICON_BYTES = 256 * 1024;
const MAX_SVG_BYTES = 64 * 1024;
const MAX_ICON_DIMENSION = 1024;
/** #729: a raster logo over the icon budget (Computer Use ships a 900 KB, 1024px PNG) is scaled to this edge instead of dropped. */
const ICON_SCALED_EDGE = 128;
const MAX_ICON_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_ICON_SOURCE_DIMENSION = 4096;
const ICON_CACHE = new Map<string, ItemIcon | null>();

/** Scales a raster image to fit `edge` and returns PNG bytes, or null when it cannot. The app supplies one (Electron's nativeImage). */
export type IconDownscaler = (bytes: Buffer, edge: number) => Buffer | null;
let downscaleIcon: IconDownscaler | undefined;
export function setIconDownscaler(downscaler: IconDownscaler | undefined): void { downscaleIcon = downscaler; }

function scaledIcon(dataUrl: string): ItemIcon | null {
  if (!downscaleIcon) return null;
  try {
    const png = downscaleIcon(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'), ICON_SCALED_EDGE);
    return png?.length && png.length <= MAX_ICON_BYTES ? { kind: 'image', dataUrl: `data:image/png;base64,${png.toString('base64')}` } : null;
  } catch { return null; }
}
const UNSAFE_SVG = /<script|<foreignObject|\bon\w+\s*=|javascript:|<iframe|<image[^>]+href=["']?(?!data:)|<use[^>]+href=["']?(?!#)|url\(\s*["']?(?!#|data:)|@import/i;

/** SVG for an <img> only: bounded, UTF-8, rooted at <svg>, with no script, handler or external reference. */
export function svgIcon(buffer: Buffer): ItemIcon | null {
  if (buffer.length > MAX_SVG_BYTES) return null;
  const text = buffer.toString('utf8');
  if (text.includes('\uFFFD') || !/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text) || UNSAFE_SVG.test(text)) return null;
  // Black-only marks (GitHub, Notion) are inverted by the renderer on dark surfaces.
  const hex = (value: string) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ? (value.length === 4 ? `#${[...value.slice(1)].map(c => c + c).join('')}` : value) : null;
  const dark = (value: string) => ['none', 'black', 'currentcolor', 'transparent'].includes(value) || value.startsWith('url') || (hex(value) !== null && luminance(hex(value)!) < 0.2);
  const paints = [...text.matchAll(/(?:fill|stroke|stop-color|color)\s*[=:]\s*["']?\s*([#a-z][^"';\s>]*)/gi)].map(match => match[1].toLowerCase());
  const monochrome = paints.every(dark) && [...text.matchAll(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi)].every(match => luminance(hex(match[0])!) < 0.2);
  // White-only marks (made for dark backgrounds) vanish on the light theme; the renderer inverts them there.
  const clear = (value: string) => ['none', 'transparent'].includes(value);
  const white = (value: string) => value === 'white' || (hex(value) !== null && luminance(hex(value)!) > 0.8);
  const monochromeLight = !monochrome && paints.some(white) && paints.every(value => clear(value) || white(value)) && [...text.matchAll(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi)].every(match => luminance(hex(match[0])!) > 0.8);
  return { kind: 'image', dataUrl: `data:image/svg+xml;base64,${buffer.toString('base64')}`, ...(monochrome ? { monochrome: true } : {}), ...(monochromeLight ? { monochromeLight: true } : {}) };
}

/** CS-C3-2: the manifest's composer icon (else logo), carrying `interface.logoDark` as the dark-theme variant when it reads. */
export async function readThemedIcon(dir: string, face: Record<string, unknown>): Promise<ItemIcon | null> {
  return themed(await readIcon(dir, face.composerIcon) ?? await readIcon(dir, face.logo), await readIcon(dir, face.logoDark ?? face.composerIconDark));
}

/** #729: a remote plugin with no logo on disk uses the one Codex lists for it, cached by remote-plugin-icons. */
async function cachedRemoteIcon(pluginName: string, provenance: string): Promise<ItemIcon | null> {
  return readCachedFiles(remoteIconFiles(pluginName, provenance));
}

/** #729: the logo an OpenAI catalog lists for a plugin of this exact name, for a plugin that ships none. Null queues a lookup. */
export async function brandIcon(pluginName: string): Promise<ItemIcon | null> {
  return readCachedFiles(brandIconFiles(pluginName));
}

async function readCachedFiles(files: RemoteIconFiles | null): Promise<ItemIcon | null> {
  if (!files) return null;
  let dir: string;
  try { dir = await fs.realpath(files.dir); } catch { return null; }
  return themed(await readIcon(dir, files.light), await readIcon(dir, files.dark));
}

function themed(icon: ItemIcon | null, dark: ItemIcon | null): ItemIcon | null {
  if (!dark || dark.kind !== 'image') return icon;
  // Only a dark logo: it still reads in dark theme, and a plain copy stands in for the light theme.
  if (!icon || icon.kind !== 'image') return { ...dark, darkDataUrl: dark.dataUrl };
  return { ...icon, darkDataUrl: dark.dataUrl };
}

/** Read one manifest-declared icon inside `dir` (no symlink escape, no remote URLs). Null means "use the monogram". */
export async function readIcon(dir: string, rel: unknown): Promise<ItemIcon | null> {
  if (typeof rel !== 'string' || !rel || rel.length > 512 || rel.includes('\0') || /^[a-z][a-z0-9+.-]*:/i.test(rel)) return null;
  const path = await contained(join(dir, rel), dir);
  if (!path) return null;
  let handle: import('node:fs/promises').FileHandle;
  try { handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return null; }
  try {
    const stat = await handle.stat();
    const svg = extname(path).toLowerCase() === '.svg';
    if (!stat.isFile() || stat.size > (svg || !downscaleIcon ? MAX_ICON_BYTES : MAX_ICON_SOURCE_BYTES)) return null;
    const key = `${path}\0${stat.mtimeMs}\0${stat.size}\0${downscaleIcon ? 'scaled' : 'raw'}`;
    if (ICON_CACHE.has(key)) return ICON_CACHE.get(key)!;
    let icon: ItemIcon | null = null;
    if (svg) {
      const buffer = Buffer.alloc(stat.size);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      icon = bytesRead === buffer.length ? svgIcon(buffer) : null;
    } else if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(extname(path).toLowerCase())) {
      try {
        const asset = await readAsset(dir, path.slice(dir.length + 1), { imagesOnly: true, maxBytes: MAX_ICON_SOURCE_BYTES });
        if (asset.width <= MAX_ICON_DIMENSION && asset.height <= MAX_ICON_DIMENSION && asset.size <= MAX_ICON_BYTES) icon = { kind: 'image', dataUrl: asset.dataUrl };
        else if (asset.width <= MAX_ICON_SOURCE_DIMENSION && asset.height <= MAX_ICON_SOURCE_DIMENSION) icon = scaledIcon(asset.dataUrl);
      } catch { icon = null; }
    }
    if (ICON_CACHE.size >= 200) ICON_CACHE.delete(ICON_CACHE.keys().next().value!);
    ICON_CACHE.set(key, icon);
    return icon;
  } catch { return null; } finally { await handle.close(); }
}

/** Tiny YAML subset: the flat `interface:` map of agents/openai.yaml (quoted or bare scalars). */
export function parseSkillInterface(text: string): Record<string, string> {
  const output: Record<string, string> = {};
  let inside = false;
  for (const line of text.split(/\r?\n/).slice(0, 400)) {
    if (/^\S/.test(line)) { inside = /^interface\s*:\s*$/.test(line); continue; }
    const match = inside ? /^\s+([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(line) : null;
    if (!match || !match[2]) continue;
    const raw = match[2];
    const value = /^"(.*)"$/.test(raw) ? (() => { try { return JSON.parse(raw) as string; } catch { return raw.slice(1, -1); } })() : /^'(.*)'$/.test(raw) ? raw.slice(1, -1).replace(/''/g, "'") : raw.replace(/\s+#.*$/, '');
    output[match[1]] = value.slice(0, 1024);
  }
  return output;
}
function frontMatter(readme: string | null): Record<string, string> {
  const block = readme && /^---\r?\n([\s\S]*?)\r?\n---/.exec(readme)?.[1];
  const output: Record<string, string> = {};
  const lines = block ? block.split(/\r?\n/) : [];
  for (let index = 0; index < lines.length; index++) {
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.+?)\s*$/.exec(lines[index]);
    if (!match) continue;
    let value = match[2];
    // Folded/literal block scalars (`description: >-`) continue on indented lines.
    if (/^[>|][+-]?$/.test(value)) { const body: string[] = []; while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1])) body.push(lines[++index].trim()); value = body.join(' '); }
    output[match[1]] = value.replace(/^(["'])(.*)\1$/, '$2').slice(0, 1024);
  }
  return output;
}
async function readSmallText(path: string | null, max = 65536): Promise<string | null> {
  if (!path) return null;
  try { const stat = await fs.stat(path); if (!stat.isFile() || stat.size > max) return null; return await fs.readFile(path, 'utf8'); } catch { return null; }
}
async function skillMetadata(dir: string, root: string, readme: string | null): Promise<Pick<SkillEntry, 'displayName' | 'shortDescription' | 'icon'>> {
  const face = parseSkillInterface(await readSmallText(await contained(join(dir, 'agents', 'openai.yaml'), root)) ?? '');
  const front = frontMatter(readme);
  const displayName = face.display_name || front.name || basename(dir);
  const shortDescription = face.short_description || front.description;
  const icon = await readIcon(dir, face.icon_small) ?? await readIcon(dir, face.icon_large);
  return { displayName, ...(shortDescription ? { shortDescription } : {}), icon: icon ?? monogram(displayName, basename(dir)) };
}

/** `fe/comp.md` under a commands root is `fe:comp`; null outside the root, past the depth bound or not markdown. */
function commandName(path: string, root: string): string | null {
  if (!path.startsWith(`${root}/`) || !path.endsWith('.md')) return null;
  const parts = path.slice(root.length + 1, -3).split('/');
  return parts.length <= COMMAND_DEPTH && parts.every(part => part && !part.startsWith('.') && !part.includes(':')) ? parts.join(':') : null;
}
async function commandFiles(root: string): Promise<Array<{ path: string; name: string }>> {
  const found: Array<{ path: string; name: string }> = [];
  const walk = async (dir: string, depth: number) => {
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= MAX_ENTRIES || entry.name.startsWith('.')) continue;
      const path = await contained(join(dir, entry.name), root);
      if (!path) continue;
      let stat: import('node:fs').Stats;
      try { stat = await fs.stat(path); } catch { continue; }
      if (stat.isDirectory()) { if (depth < COMMAND_DEPTH) await walk(path, depth + 1); continue; }
      const name = stat.isFile() ? commandName(path, root) : null;
      if (name) found.push({ path, name });
    }
  };
  await walk(root, 1);
  return found;
}
/** A Claude Code command: its description, else its first line, as Claude Code lists it. */
async function commandEntry(path: string, name: string, source: SkillRoot, root: string): Promise<SkillEntry | null> {
  let readme: string | null = null, readError: string | null = null;
  try {
    const safe = await contained(path, root);
    if (!safe) return null;
    const stat = await fs.stat(safe);
    if (!stat.isFile()) return null;
    readme = stat.size > MAX_README ? null : await readContainedText(safe, root, MAX_README);
    if (readme === null) readError = stat.size > MAX_README ? 'Over the 64 KB command limit' : 'The command file changed while it was read';
  } catch (error) { readError = error instanceof Error ? error.message : String(error); }
  const front = frontMatter(readme);
  const body = commandBody(readme ?? '');
  const firstLine = body.split(/\r?\n/).map(line => line.trim()).find(Boolean)?.replace(/^#+\s*/, '').slice(0, 200);
  const shortDescription = front.description || firstLine;
  return { id: path, name, provenance: source.provenance, path, readme, readError, claude: 'command', displayName: name,
    ...(shortDescription ? { shortDescription } : {}), ...(front['argument-hint'] ? { argumentHint: front['argument-hint'] } : {}) };
}
/** The command text without its front matter. */
export function commandBody(text: string): string { return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ''); }
/**
 * What Claude Code sends for `/<name> <args>` (checked against Claude Code 2.1): the body without front matter, `$ARGUMENTS`
 * as the whole argument string, `$ARGUMENTS[N]` and `$N` as zero-based words split shell-style (a quoted phrase is one word), and with no placeholder the arguments
 * appended as `ARGUMENTS: <args>`.
 */
/** Arguments split the way a shell would: whitespace separates, '…' and "…" keep a phrase whole, a backslash escapes. */
function commandWords(args: string): string[] {
  const words: string[] = [];
  let word = '', started = false, quote: string | null = null;
  for (let index = 0; index < args.length; index++) {
    const char = args[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && /["\\$`]/.test(args[index + 1] ?? '')) word += args[++index];
      else word += char;
    } else if (/\s/.test(char)) { if (started) { words.push(word); word = ''; started = false; } }
    else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (char === '\\' && index + 1 < args.length) { word += args[++index]; started = true; }
    else { word += char; started = true; }
  }
  if (started) words.push(word);
  return words;
}
export function expandClaudeCommand(text: string, args: string): string {
  const body = commandBody(text).replace(/\s+$/, '');
  const words = commandWords(args);
  const placeholder = /\$ARGUMENTS|\$\d/.test(body);
  const filled = body.replace(/\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS|\$(\d+)/g, (_match, index?: string, position?: string) => index !== undefined || position !== undefined ? words[Number(index ?? position)] ?? '' : args.trim());
  return placeholder || !args.trim() ? filled : `${filled}\n\nARGUMENTS: ${args.trim()}`;
}
/** The request as a command's arguments: the composer keeps the picked chip in the text as `$<name>`, which is not an argument. */
export function commandArguments(request: string, name: string): string {
  // Only the first standalone `/name` or `$name` is the invocation; everything else is the user's text, kept as typed.
  const match = new RegExp(`(^|\\s)[$/]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`).exec(request);
  if (!match) return request.trim();
  const start = match.index + match[1]!.length, end = start + name.length + 1;
  return (request.slice(0, start) + request.slice(end).replace(/^[ \t]/, '')).trim();
}
/** The instruction block a selected skill or command adds to a request that Claude Code does not run natively. */
export function selectedSkillBlock(entry: { name: string; provenance: string; content: string; claude?: 'skill' | 'command' }, request: string): string {
  if (entry.claude === 'command') return `Selected command: /${entry.name} (${entry.provenance})\n\nThe user ran this command on the current request. Follow its instructions:\n<command-instructions>\n${expandClaudeCommand(entry.content, commandArguments(request, entry.name))}\n</command-instructions>`;
  return `Selected skill: ${entry.name} (${entry.provenance})\n\nApply these user-selected skill instructions to the current request:\n<skill-instructions>\n${entry.content}\n</skill-instructions>`;
}

export async function discoverSkills(folderPaths: string[] = [], options: { all?: boolean } = {}): Promise<SkillEntry[]> {
  const output: SkillEntry[] = [];
  const gate = options.all ? null : skillGate;
  for (const source of ROOTS(folderPaths)) {
    if (output.length >= MAX_ENTRIES) break;
    let root: string;
    try {
      root = await fs.realpath(source.path);
      if (!(await fs.stat(root)).isDirectory()) continue;
    } catch { continue; }
    if (source.claude === 'command') {
      for (const command of await commandFiles(root)) {
        if (output.length >= MAX_ENTRIES) break;
        const skill = await commandEntry(command.path, command.name, source, root);
        if (skill && (!gate || gate(skill, folderPaths))) output.push(skill);
      }
      continue;
    }
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (output.length >= MAX_ENTRIES || (!entry.isDirectory() && !entry.isSymbolicLink()) || (source.only && entry.name !== source.only)) continue;
      // Hidden dirs (Codex's .system bundle, .git) are containers, not a skill named ".system".
      if (entry.name.startsWith('.') && !source.only) continue;
      const dir = await contained(join(root, entry.name), root);
      if (!dir) continue;
      try { if (!(await fs.stat(dir)).isDirectory()) continue; } catch { continue; }
      const read = await readSkill(dir, root);
      // Claude Code only treats a folder with a SKILL.md as a skill; its skills root also holds sync bookkeeping folders.
      if (source.claude && read.readme === null && read.readError === null) continue;
      const skill: SkillEntry = { id: dir, name: source.name ?? basename(dir), provenance: source.provenance, path: dir, ...read, ...await skillMetadata(dir, root, read.readme), ...(source.claude ? { claude: source.claude } : {}) };
      if (gate && !gate(skill, folderPaths)) continue;
      // A skill installed for both clients (the same SKILL.md under ~/.agents/skills and ~/.claude/skills) is one row: the
      // Claude Code copy, which a Claude Code run invokes by name and every other run inlines.
      const twin = source.claude === 'skill' && read.readme !== null ? output.findIndex(entry => !entry.claude && entry.name === skill.name && entry.readme === read.readme) : -1;
      if (twin >= 0) output[twin] = skill; else output.push(skill);
    }
  }
  return output;
}

/** Resolve one renderer-selected skill again inside runtime-owned roots. */
export async function resolveAttachedSkill(skillId: string, folderPaths: string[] = []): Promise<(SkillEntry & { content: string; digest: string }) | null> {
  if (!skillId || skillId.length > 4096 || skillId.includes('\0')) return null;
  const leaf = basename(skillId);
  if (!leaf || leaf === '.' || leaf === '..') return null;
  let generic: (SkillEntry & { content: string; digest: string }) | null = null;
  for (const source of ROOTS(folderPaths)) {
    let root: string;
    try { root = await fs.realpath(source.path); } catch { continue; }
    if (source.claude === 'command') {
      const name = commandName(skillId, root);
      if (!name || (await contained(skillId, root)) !== skillId) continue;
      const skill = await commandEntry(skillId, name, source, root);
      if (!skill?.readme?.trim() || Buffer.byteLength(skill.readme, 'utf8') > MAX_ATTACHED_SKILL_BYTES) return null;
      if (skillGate && !skillGate(skill, folderPaths)) throw new Error(`The /${skill.name} command is disabled here. Enable it in Skills & plugins or remove its chip.`);
      return { ...skill, content: skill.readme, digest: createHash('sha256').update(skill.readme, 'utf8').digest('hex') };
    }
    if (source.only && leaf !== source.only) continue;
    // A folder whose .claude/skills links to its .agents/skills reaches one skill through both; listing keeps the Claude Code row.
    if (generic && !source.claude) continue;
    const candidate = await contained(join(root, leaf), root);
    if (!candidate || candidate !== skillId) continue;
    try { if (!(await fs.stat(candidate)).isDirectory()) continue; } catch { continue; }
    const read = await readSkill(candidate, root);
    if (read.readError || !read.readme?.trim() || Buffer.byteLength(read.readme, 'utf8') > MAX_ATTACHED_SKILL_BYTES) return null;
    const skill = { id: candidate, name: source.name ?? leaf, provenance: source.provenance, path: candidate, readme: read.readme, readError: null, content: read.readme, digest: createHash('sha256').update(read.readme, 'utf8').digest('hex'), ...(source.claude ? { claude: source.claude } : {}) };
    if (skillGate && !skillGate(skill, folderPaths)) throw new Error(`The ${skill.name} skill is disabled here. Enable it in Skills & plugins or remove its chip.`);
    if (source.claude) return skill;
    generic ??= skill;
  }
  return generic;
}

/**
 * #729: whether Claude Code's `/<name>` reaches this entry. Claude Code takes a skill over a command of the same name, and a
 * personal one (~/.claude) over a project's, so a picked entry that loses is not sent by name: it runs inlined, as picked.
 */
export async function claudeReachesByName(entry: { id: string; name: string; claude?: 'skill' | 'command' }, folderPaths: string[] = []): Promise<boolean> {
  if (!entry.claude) return false;
  const roots = ROOTS(folderPaths).filter(source => source.claude);
  for (const source of [...roots.filter(root => root.claude === 'skill'), ...roots.filter(root => root.claude === 'command')]) {
    let root: string;
    try { root = await fs.realpath(source.path); } catch { continue; }
    if (source.claude === 'skill') {
      if (entry.name.includes(':')) continue;
      const dir = await contained(join(root, entry.name), root);
      const readme = dir ? await contained(join(dir, 'SKILL.md'), root) : null;
      try { if (!readme || !(await fs.stat(readme)).isFile()) continue; } catch { continue; }
      return dir === entry.id;
    }
    const file = await contained(join(root, ...entry.name.split(':')) + '.md', root);
    try { if (!file || !(await fs.stat(file)).isFile()) continue; } catch { continue; }
    return file === entry.id;
  }
  return false;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function readJson(path: string, root: string): Promise<Record<string, unknown> | null> {
  const safe = await contained(path, root);
  if (!safe) return null;
  const stat = await fs.stat(safe);
  if (!stat.isFile() || stat.size > MAX_MANIFEST) throw new Error(`${basename(path)} is not a bounded file.`);
  return record(JSON.parse(await fs.readFile(safe, 'utf8')));
}

async function directoryNames(path: string, root: string): Promise<string[]> {
  const safe = await contained(path, root);
  if (!safe) return [];
  try {
    return (await fs.readdir(safe, {withFileTypes:true}))
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => entry.name)
      .sort((a,b)=>a.localeCompare(b));
  } catch { return []; }
}

/** Numeric x.y.z comparison; null when either side is not a version (e.g. a commit hash). */
function compareVersions(a: string, b: string): number | null {
  const parse = (value: string) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(value)?.slice(1).map(Number);
  const x = parse(a), y = parse(b);
  if (!x || !y) return null;
  for (let index = 0; index < 3; index++) if (x[index] !== y[index]) return x[index] - y[index];
  return 0;
}

/**
 * Inspect installed Codex plugin bundles without executing manifests or
 * exposing command arguments, environment variables, URLs, or credentials.
 * Duplicate versions (and curated / curated-remote copies) collapse to the newest.
 */
export async function discoverPlugins(cachePath = join(homedir(), '.codex', 'plugins', 'cache'), options: { all?: boolean } = {}): Promise<PluginEntry[]> {
  const entries = await inventoryPlugins(cachePath);
  return options.all || !pluginGate ? entries : entries.filter(pluginGate);
}
/** `<provenanceDir>/<pluginName>/<version>/...` inside `root`, folded into `chosen` (newest version per plugin name wins). */
async function scanProvenanceDir(provenanceDir: string, root: string, provenance: string, chosen: Map<string, { entry: PluginEntry; mtime: number }>, seen: Set<string>): Promise<void> {
  for (const pluginName of await directoryNames(provenanceDir, root)) {
    const pluginDir = await contained(join(provenanceDir, pluginName), root);
    if (!pluginDir) continue;
    for (const version of await directoryNames(pluginDir, root)) {
      if (seen.size >= MAX_ENTRIES) break;
      const dir = await contained(join(pluginDir, version), root);
      // `latest` is a symlink alias of a real version: the realpath dedupes it.
      if (!dir || seen.has(dir)) continue;
      seen.add(dir);
      let readError: string | null = null;
      let lock: Record<string, unknown> | null = null;
      let mcp: Record<string, unknown> | null = null;
      let app: Record<string, unknown> | null = null;
      let manifest: Record<string, unknown> | null = null;
      try { lock = await readJson(join(dir, 'plugin.lock.json'), root); } catch(error) { readError = error instanceof Error ? error.message : String(error); }
      try { mcp = await readJson(join(dir, '.mcp.json'), root); } catch(error) { readError ??= error instanceof Error ? error.message : String(error); }
      try { app = await readJson(join(dir, '.app.json'), root); } catch(error) { readError ??= error instanceof Error ? error.message : String(error); }
      try { manifest = await readJson(join(dir, '.codex-plugin', 'plugin.json'), root); } catch(error) { readError ??= error instanceof Error ? error.message : String(error); }
      const lockedSkills = Array.isArray(lock?.skills) ? lock.skills.flatMap(value => {
        const row=record(value); return typeof row?.id === 'string' ? [row.id] : [];
      }) : [];
      const skills = lockedSkills.length ? lockedSkills : await directoryNames(join(dir, 'skills'), root);
      const mcpServers = Object.entries(record(mcp?.mcpServers) ?? {}).slice(0,64).map(([name,value])=>{
        const row=record(value); const remote=typeof row?.url==='string'||row?.type==='http'; const local=typeof row?.command==='string';
        return {name,transport:remote?'remote':local?'local':'unknown'} as const;
      });
      const apps = Object.entries(record(app?.apps) ?? {}).slice(0,128).flatMap(([name,value])=>{
        const row=record(value); if(typeof row?.id!=='string')return [];
        return [{name,id:row.id,required:row.required===true,...(typeof row.category==='string'?{category:row.category}:{}),...(typeof row.ui==='string'&&row.ui.length<=512?{ui:row.ui}:{})}];
      });
      if (!lock && !mcp && !app && !manifest && !skills.length) continue;
      const face = record(manifest?.interface) ?? {};
      const str = (value: unknown, max = 512) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
      const displayName = str(face.displayName, 128) ?? str(manifest?.name, 128) ?? pluginName;
      const shortDescription = str(face.shortDescription) ?? str(manifest?.description);
      const brandColor = typeof face.brandColor === 'string' && BRAND_COLOR.test(face.brandColor) ? face.brandColor : undefined;
      const category = str(face.category, 64);
      const defaultPrompts = Array.isArray(face.defaultPrompt) ? face.defaultPrompt.flatMap(value => str(value, 512) ?? []).slice(0, 5) : [];
      const icon = await readThemedIcon(dir, face) ?? await cachedRemoteIcon(pluginName, provenance) ?? await brandIcon(pluginName) ?? monogram(displayName, pluginName, brandColor);
      const entry: PluginEntry = {id:dir,name:pluginName,version,provenance,path:dir,skills,mcpServers,apps,readError,displayName,icon,format:'codex',
        ...(shortDescription?{shortDescription}:{}),...(category?{category}:{}),...(brandColor?{brandColor}:{}),...(defaultPrompts.length?{defaultPrompts}:{})};
      let mtime = 0;
      try { mtime = (await fs.stat(dir)).mtimeMs; } catch { /* Unknown age sorts oldest. */ }
      const key = `${provenance.replace(/-remote$/, '')}/${pluginName}`;
      const prior = chosen.get(key);
      const newer = !prior || (compareVersions(version, prior.entry.version) ?? (mtime - prior.mtime || (provenance.endsWith('-remote') ? 1 : -1))) > 0;
      if (newer) chosen.set(key, { entry, mtime });
    }
  }
}
async function inventoryPlugins(cachePath: string): Promise<PluginEntry[]> {
  let root: string;
  try {
    root = await fs.realpath(cachePath);
    if (!(await fs.stat(root)).isDirectory()) return [];
  } catch { return []; }
  const chosen = new Map<string, { entry: PluginEntry; mtime: number }>();
  const seen = new Set<string>();
  for (const provenance of await directoryNames(root, root)) {
    const provenanceDir = await contained(join(root, provenance), root);
    if (!provenanceDir) continue;
    await scanProvenanceDir(provenanceDir, root, provenance, chosen, seen);
  }
  return [...chosen.values()].map(value => value.entry).sort((a,b)=>(a.displayName ?? a.name).localeCompare(b.displayName ?? b.name)||b.version.localeCompare(a.version));
}
/**
 * Inventory a single Codex plugin-cache provenance directory (e.g. `<cache>/openai-curated`) on its own,
 * for a "Detected" marketplace source that points directly at it (the merged `discoverPlugins` cache walk
 * mixes every provenance together, which is right for the Installed tab but not for one Discover source).
 */
export async function discoverCodexProvenance(provenanceDir: string, provenance: string): Promise<PluginEntry[]> {
  let root: string;
  try {
    root = await fs.realpath(provenanceDir);
    if (!(await fs.stat(root)).isDirectory()) return [];
  } catch { return []; }
  const chosen = new Map<string, { entry: PluginEntry; mtime: number }>();
  await scanProvenanceDir(root, root, provenance, chosen, new Set<string>());
  return [...chosen.values()].map(value => value.entry).sort((a,b)=>(a.displayName ?? a.name).localeCompare(b.displayName ?? b.name)||b.version.localeCompare(a.version));
}

export interface InvokedPlugin { id: string; name: string; displayName: string; shortDescription?: string; skills: Array<{ name: string; content: string }>; omittedSkills: string[]; mcpServers: string[]; apps: string[]; digest: string }
/** Re-resolve renderer-chosen plugin ids inside the runtime-owned cache and load bounded skill text for the turn. */
export async function resolveInvokedPlugins(pluginIds: string[], cachePath?: string): Promise<InvokedPlugin[]> {
  if (!pluginIds.length) return [];
  const inventory = await discoverPlugins(cachePath);
  const output: InvokedPlugin[] = [];
  for (const pluginId of pluginIds) {
    const plugin = inventory.find(entry => entry.id === pluginId);
    if (!plugin) throw new Error('A selected plugin is no longer installed. Remove its chip or refresh plugins and try again.');
    const skills: InvokedPlugin['skills'] = [], omittedSkills: string[] = [];
    let budget = MAX_ATTACHED_SKILL_BYTES;
    for (const skill of plugin.skills.slice(0, 32)) {
      const path = await contained(join(plugin.path, 'skills', basename(skill), 'SKILL.md'), plugin.path);
      const content = await readSmallText(path, MAX_ATTACHED_SKILL_BYTES);
      const bytes = content ? Buffer.byteLength(content, 'utf8') : 0;
      if (content?.trim() && bytes <= budget) { skills.push({ name: basename(skill), content }); budget -= bytes; }
      else omittedSkills.push(basename(skill));
    }
    const digest = createHash('sha256').update(JSON.stringify([plugin.id, plugin.version, skills])).digest('hex');
    output.push({ id: plugin.id, name: plugin.name, displayName: plugin.displayName ?? plugin.name, ...(plugin.shortDescription ? { shortDescription: plugin.shortDescription } : {}), skills, omittedSkills, mcpServers: plugin.mcpServers.map(server => server.name), apps: plugin.apps.map(entry => entry.name), digest });
  }
  return output;
}

/** Developer-visible context for plugins the user invoked with an @plugin chip. */
export function invokedPluginContext(plugins: InvokedPlugin[]): string {
  return plugins.map(plugin => [
    `The user invoked the ${plugin.displayName} plugin (@${plugin.name}) for this request.${plugin.shortDescription ? ` ${plugin.shortDescription}.` : ''}`,
    plugin.mcpServers.length || plugin.apps.length ? `Prefer its tools: ${[...plugin.mcpServers.map(name => `MCP server ${name}`), ...plugin.apps.map(name => `app ${name}`)].join(', ')}.` : '',
    ...plugin.skills.map(skill => `<plugin-skill plugin="${plugin.name}" name="${skill.name}">\n${skill.content.replace(/<\/plugin-skill/gi, '<\\/plugin-skill')}\n</plugin-skill>`),
    plugin.omittedSkills.length ? `Other ${plugin.displayName} skills (not inlined): ${plugin.omittedSkills.join(', ')}.` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
}
