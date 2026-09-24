/**
 * Marketplace engine: sync sources, read their package index, validate and stage a
 * package, then atomically rename it into dataDir/extensions/<name>@<version>.
 * Nothing a package ships is executed here — files are only read and copied.
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { readIcon } from './plugin-library.ts';
import type { ExtensionCapabilities, ExtensionCompatibility, ExtensionKind, ExtensionMcpServer, ExtensionSource, InstalledVersion, MarketplacePackage, MusterManifest } from '../shared/domains/extensions-protocol.ts';

export const LIMITS = { files: 2000, bytes: 64 * 1024 * 1024, file: 16 * 1024 * 1024, depth: 24, manifest: 256 * 1024, packages: 500 };
export const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const COMMIT = /^[0-9a-f]{7,64}$/i;
const SKIP = new Set(['.git', 'node_modules', '.DS_Store']);
const KNOWN = new Set(['name', 'version', 'description', 'author', 'license', 'homepage', 'repository', 'keywords', 'category', 'mcpServers', 'skills', 'hooks', 'commands', 'agents', 'interface', 'apps', 'source', 'strict', 'tags', '$schema', 'displayName']);
const REVIEW_ONLY: Record<string, string> = { hooks: 'hooks (listed for review, never executed)', commands: 'slash commands', agents: 'subagent definitions', lspServers: 'LSP servers', outputStyles: 'output styles' };

export interface CatalogEntry { pkg: MarketplacePackage; dir: string | null }
export const sourcesRoot = (dataDir: string) => join(dataDir, 'extension-sources');
export const extensionsRoot = (dataDir: string) => join(dataDir, 'extensions');

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const str = (value: unknown, max = 512): string | undefined => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
const strings = (value: unknown, max = 64): string[] => Array.isArray(value) ? value.flatMap(item => str(item) ?? []).slice(0, max) : [];

/** realpath of `path` when it stays inside `root` (itself a realpath). */
export async function inside(path: string, root: string): Promise<string | null> {
  try { const real = await fs.realpath(path); return real === root || real.startsWith(root + sep) ? real : null; } catch { return null; }
}
async function readJson(path: string, root: string): Promise<Record<string, unknown> | null> {
  const safe = await inside(path, root);
  if (!safe) return null;
  const stat = await fs.stat(safe);
  if (!stat.isFile()) return null;
  if (stat.size > LIMITS.manifest) throw new Error(`${relative(root, safe)} is larger than ${LIMITS.manifest / 1024} KB.`);
  try { return record(JSON.parse(await fs.readFile(safe, 'utf8'))); } catch (error) { throw new Error(`${relative(root, safe)} is not valid JSON: ${error instanceof Error ? error.message : error}`); }
}
async function names(dir: string, root: string, test: (name: string, isDir: boolean) => boolean): Promise<string[]> {
  const safe = await inside(dir, root);
  if (!safe) return [];
  try { return (await fs.readdir(safe, { withFileTypes: true })).filter(entry => test(entry.name, entry.isDirectory())).map(entry => entry.name).sort().slice(0, 256); } catch { return []; }
}
async function exists(path: string): Promise<boolean> { try { await fs.lstat(path); return true; } catch { return false; } }

/** YAML front matter keys of a SKILL.md (flat `key: value` lines only). */
export function skillFront(text: string): Record<string, string> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const output: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) { const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(line); if (match?.[2]) output[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2').slice(0, 1024); }
  return output;
}

// ---------------------------------------------------------------- sources

/** https URL, `git@host:path`, or `owner/repo` (GitHub). Local file URLs are refused unless a test opts in. */
export function normalizeGitUrl(value: string, allowFile = false): string {
  const url = value.trim();
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url)) return `https://github.com/${url.replace(/\.git$/, '')}.git`;
  if (/^https:\/\/[^\s/@]+(?:\/[^\s]*)?$/.test(url) || /^git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+$/.test(url)) return url;
  if (allowFile && (url.startsWith('file://') || isAbsolute(url))) return url;
  throw new Error('Use an https Git URL, git@host:repo, or owner/repo.');
}

const run = (args: string[], cwd: string, allowFile: boolean) => new Promise<string>((resolve, reject) => {
  const safety = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.symlinks=false', '-c', 'core.fsmonitor=false', ...(allowFile ? [] : ['-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never'])];
  execFile('git', [...safety, ...args], { cwd, timeout: 120_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_CONFIG_NOSYSTEM: '1', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes' } },
    (error, stdout, stderr) => error ? reject(new Error((stderr || error.message).trim().split('\n').slice(-2).join(' ').slice(0, 400))) : resolve(stdout.trim()));
});

/** Shallow-clone a Git source at its pinned commit into extension-sources/<id>; returns the checked-out commit. */
export async function syncGitSource(dataDir: string, source: Pick<ExtensionSource, 'id' | 'url' | 'pinnedCommit'>, options: { allowFile?: boolean } = {}): Promise<string> {
  if (!/^[a-z0-9-]{1,64}$/.test(source.id)) throw new Error('Invalid source id.');
  const url = normalizeGitUrl(source.url ?? '', options.allowFile);
  if (source.pinnedCommit && !COMMIT.test(source.pinnedCommit)) throw new Error('Pin a full or abbreviated commit hash.');
  const root = sourcesRoot(dataDir);
  await fs.mkdir(root, { recursive: true });
  const temp = join(root, `.tmp-${randomUUID()}`), target = join(root, source.id);
  try {
    if (source.pinnedCommit) {
      await fs.mkdir(temp);
      await run(['init', '-q'], temp, !!options.allowFile);
      await run(['remote', 'add', 'origin', url], temp, !!options.allowFile);
      await run(['fetch', '-q', '--depth', '1', 'origin', source.pinnedCommit], temp, !!options.allowFile);
      await run(['-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD'], temp, !!options.allowFile);
    } else await run(['clone', '-q', '--depth', '1', '--no-tags', url, temp], root, !!options.allowFile);
    const commit = await run(['rev-parse', 'HEAD'], temp, !!options.allowFile);
    const old = join(root, `.old-${randomUUID()}`);
    if (await exists(target)) await fs.rename(target, old);
    await fs.rename(temp, target);
    await fs.rm(old, { recursive: true, force: true });
    return commit;
  } catch (error) { await fs.rm(temp, { recursive: true, force: true }); throw error; }
}

/** The directory a source's index is read from, or null when it is not available (unsynced or missing). */
export async function sourceRoot(dataDir: string, source: ExtensionSource): Promise<string | null> {
  const path = source.kind === 'git' ? join(sourcesRoot(dataDir), source.id) : source.path;
  if (!path) return null;
  try { const real = await fs.realpath(path); return (await fs.stat(real)).isDirectory() ? real : null; } catch { return null; }
}

// ---------------------------------------------------------------- inspection

async function mcpServers(dir: string, manifest: Record<string, unknown> | null): Promise<ExtensionMcpServer[]> {
  let table = record(manifest?.mcpServers);
  if (!table && typeof manifest?.mcpServers === 'string') { const file = await readJson(join(dir, manifest.mcpServers), dir); table = record(file?.mcpServers) ?? file; }
  if (!table) { const file = await readJson(join(dir, '.mcp.json'), dir); table = record(file?.mcpServers) ?? (file && Object.values(file).every(value => record(value)?.command || record(value)?.url) ? file : null); }
  return Object.entries(table ?? {}).slice(0, 64).flatMap(([name, value]) => {
    const row = record(value);
    if (!row || !NAME.test(name)) return [];
    const url = str(row.url, 2048), command = str(row.command, 1024);
    const env = Object.keys(record(row.env) ?? {}).slice(0, 32);
    return [{ name, transport: url ? 'remote' : command ? 'local' : 'unknown', ...(command ? { command } : {}), ...(Array.isArray(row.args) ? { args: strings(row.args, 64) } : {}), ...(url ? { url } : {}), ...(env.length ? { env } : {}) } as ExtensionMcpServer];
  });
}
async function hookList(dir: string, manifest: Record<string, unknown> | null): Promise<string[]> {
  let table = record(manifest?.hooks);
  if (!table && typeof manifest?.hooks === 'string') table = await readJson(join(dir, manifest.hooks), dir).catch(() => null);
  if (!table) table = await readJson(join(dir, 'hooks', 'hooks.json'), dir).catch(() => null);
  const events = record(table?.hooks) ?? table ?? {};
  const output: string[] = [];
  for (const [event, groups] of Object.entries(events)) for (const group of Array.isArray(groups) ? groups : []) for (const hook of Array.isArray(record(group)?.hooks) ? record(group)!.hooks as unknown[] : [group]) {
    const detail = str(record(hook)?.command, 300) ?? str(record(hook)?.url, 300) ?? str(record(hook)?.type, 64);
    if (detail) output.push(`${event}: ${detail}`);
  }
  return output.slice(0, 64);
}

interface Hints { name: string; version?: string; description?: string; publisher?: string; license?: string; homepage?: string; category?: string; keywords?: string[]; entry?: Record<string, unknown> }
/** Read a package directory's manifests into catalog metadata, capabilities and a compatibility report. */
export async function inspectPackage(path: string, hints: Hints): Promise<Omit<MarketplacePackage, 'id' | 'sourceId' | 'sourceLabel'>> {
  const dir = await fs.realpath(path);
  const unsupported: string[] = [], notes: string[] = [];
  let manifest: Record<string, unknown> | null = null, format: ExtensionCompatibility['format'] = 'skill';
  for (const [file, kind] of [['.claude-plugin/plugin.json', 'claude'], ['.codex-plugin/plugin.json', 'codex']] as const) {
    try { manifest = await readJson(join(dir, file), dir); } catch (error) { unsupported.push(error instanceof Error ? error.message : String(error)); }
    if (manifest) { format = kind; break; }
  }
  // Non-strict Claude marketplace entries carry the manifest inline.
  if (hints.entry) manifest = { ...hints.entry, ...(manifest ?? {}) };
  let kind: ExtensionKind = manifest || format !== 'skill' ? 'plugin' : 'skill';
  let skills = await names(join(dir, 'skills'), dir, (name, isDir) => isDir && NAME.test(name));
  let skillFrontMatter: Record<string, string> = {};
  if (!manifest && await inside(join(dir, 'SKILL.md'), dir)) { skillFrontMatter = skillFront(await fs.readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => '')); skills = [hints.name]; kind = 'skill'; }
  else if (!manifest && !skills.length) unsupported.push('No plugin.json or SKILL.md was found.');
  else kind = 'plugin';
  const servers = await mcpServers(dir, manifest).catch(error => { unsupported.push(error instanceof Error ? error.message : String(error)); return []; });
  const hooks = await hookList(dir, manifest);
  const commands = (await names(join(dir, 'commands'), dir, (name, isDir) => !isDir && name.endsWith('.md'))).map(name => name.slice(0, -3));
  const agents = (await names(join(dir, 'agents'), dir, (name, isDir) => !isDir && name.endsWith('.md'))).map(name => name.slice(0, -3));
  let apps: string[] = [];
  try { apps = Object.keys(record((await readJson(join(dir, '.app.json'), dir))?.apps) ?? {}).slice(0, 64); } catch { /* reported by review */ }
  for (const key of Object.keys(manifest ?? {})) if (!KNOWN.has(key)) unsupported.push(REVIEW_ONLY[key] ?? `field “${key}”`);
  if (hooks.length) unsupported.push(REVIEW_ONLY.hooks);
  if (commands.length) unsupported.push(`${REVIEW_ONLY.commands} (${commands.length})`);
  if (agents.length) unsupported.push(`${REVIEW_ONLY.agents} (${agents.length})`);
  if (servers.some(server => server.env?.length)) notes.push('Some MCP servers read environment variables; set them before connecting.');
  if (servers.some(server => server.transport === 'remote') || apps.length) notes.push('Remote servers and apps need a connection after install.');
  const author = record(manifest?.author);
  const face = record(manifest?.interface) ?? {};
  const name = hints.name;
  const version = [hints.version, str(manifest?.version, 64), str(skillFrontMatter.version, 64)].find(value => value && VERSION.test(value)) ?? '0.0.0';
  const description = hints.description ?? str(face.shortDescription) ?? str(manifest?.description, 1024) ?? str(skillFrontMatter.description, 1024);
  const publisher = hints.publisher ?? str(author?.name, 128) ?? str(manifest?.author, 128) ?? str(face.developerName, 128);
  const license = hints.license ?? str(manifest?.license, 64) ?? str(skillFrontMatter.license, 64);
  const homepage = hints.homepage ?? str(manifest?.homepage, 512) ?? str(record(manifest?.repository)?.url ?? manifest?.repository, 512);
  const category = hints.category ?? str(manifest?.category ?? face.category, 64);
  const keywords = hints.keywords ?? strings(manifest?.keywords, 16);
  const displayName = str(face.displayName, 128) ?? str(manifest?.displayName, 128) ?? name;
  const icon = await readIcon(dir, face.composerIcon) ?? await readIcon(dir, face.logo) ?? await readIcon(dir, manifest?.icon);
  const supported = !unsupported.some(entry => /not valid JSON|larger than|No plugin\.json/.test(entry)) && (skills.length > 0 || servers.length > 0 || apps.length > 0);
  return { name, kind, displayName, version, ...(description ? { description } : {}), ...(publisher ? { publisher } : {}), ...(license ? { license } : {}), ...(homepage ? { homepage } : {}), ...(category ? { category } : {}), ...(keywords.length ? { keywords } : {}), ...(icon ? { icon } : {}),
    capabilities: { mcpServers: servers, apps, hooks, skills, commands, agents }, compatibility: { format, supported, unsupported, notes } };
}

/** The package index of a source: a Claude or Codex marketplace.json, else a plain skills folder. */
export async function readCatalog(path: string, source: Pick<ExtensionSource, 'id' | 'label'>): Promise<CatalogEntry[]> {
  const root = await fs.realpath(path);
  const base = { sourceId: source.id, sourceLabel: source.label };
  const output: CatalogEntry[] = [];
  let index: Record<string, unknown> | null = null;
  for (const file of ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json', 'marketplace.json']) { index = await readJson(join(root, file), root); if (index) break; }
  if (index) {
    const owner = str(record(index.owner)?.name, 128);
    const pluginRoot = str(record(index.metadata)?.pluginRoot, 256) ?? '';
    for (const value of (Array.isArray(index.plugins) ? index.plugins : []).slice(0, LIMITS.packages)) {
      const entry = record(value);
      const name = str(entry?.name, 64);
      if (!entry || !name || !NAME.test(name)) continue;
      const src = entry.source, srcRecord = record(src);
      const rel = typeof src === 'string' ? src : srcRecord && ['local', 'relative', undefined].includes(srcRecord.source as string | undefined) ? str(srcRecord.path) : undefined;
      const hints: Hints = { name, version: str(entry.version, 64), description: str(entry.description, 1024), publisher: str(record(entry.author)?.name, 128) ?? owner, license: str(entry.license, 64), homepage: str(entry.homepage, 512), category: str(entry.category, 64), keywords: strings(entry.keywords ?? entry.tags, 16),
        ...(entry.strict === false ? { entry: Object.fromEntries(Object.entries(entry).filter(([key]) => !['name', 'source', 'strict'].includes(key))) } : {}) };
      const dir = rel && !/^[a-z][a-z0-9+.-]*:/i.test(rel) ? await inside(join(root, rel.startsWith('./') || rel.startsWith('../') || rel.includes('/') ? rel : join(pluginRoot, rel)), root) : null;
      if (!dir) {
        const kind = str(srcRecord?.source, 32) ?? 'unknown';
        output.push({ dir: null, pkg: { ...base, id: `${source.id}:${name}`, name, kind: 'plugin', displayName: name, version: hints.version ?? '0.0.0', ...(hints.description ? { description: hints.description } : {}), ...(hints.publisher ? { publisher: hints.publisher } : {}),
          capabilities: { mcpServers: [], apps: [], hooks: [], skills: [], commands: [], agents: [] }, compatibility: { format: 'claude', supported: false, unsupported: [rel ? 'source path escapes the marketplace' : `remote source (${kind}); add that repository as its own source`], notes: [] } } });
        continue;
      }
      output.push({ dir, pkg: { ...base, id: `${source.id}:${name}`, ...await inspectPackage(dir, hints) } });
    }
    return output;
  }
  if (await inside(join(root, 'SKILL.md'), root)) {
    const name = skillFront(await fs.readFile(join(root, 'SKILL.md'), 'utf8').catch(() => '')).name ?? basename(root);
    if (NAME.test(name)) output.push({ dir: root, pkg: { ...base, id: `${source.id}:${name}`, ...await inspectPackage(root, { name }) } });
    return output;
  }
  for (const parent of [join(root, 'skills'), root]) {
    for (const name of await names(parent, root, (entry, isDir) => isDir && NAME.test(entry) && !SKIP.has(entry))) {
      if (output.length >= LIMITS.packages) break;
      const dir = await inside(join(parent, name), root);
      if (dir && await inside(join(dir, 'SKILL.md'), root) && !output.some(entry => entry.pkg.name === name)) output.push({ dir, pkg: { ...base, id: `${source.id}:${name}`, ...await inspectPackage(dir, { name }) } });
    }
  }
  return output;
}

// ---------------------------------------------------------------- install

/** Walk a package, enforcing file, size, depth and containment caps. Symlinks must stay inside and are copied as files. */
export async function packageFiles(path: string): Promise<{ files: Array<{ rel: string; path: string; size: number }>; bytes: number }> {
  const dir = await fs.realpath(path);
  const files: Array<{ rel: string; path: string; size: number }> = [];
  let bytes = 0;
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > LIMITS.depth) throw new Error(`The package nests deeper than ${LIMITS.depth} folders.`);
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(entry.name)) continue;
      const path = join(current, entry.name), rel = relative(dir, path);
      const real = await inside(path, dir);
      if (!real) throw new Error(`${rel} points outside the package.`);
      const stat = await fs.stat(real);
      if (stat.isDirectory()) { if (entry.isSymbolicLink()) throw new Error(`${rel} is a linked folder.`); await walk(path, depth + 1); continue; }
      if (!stat.isFile()) continue;
      if (stat.size > LIMITS.file) throw new Error(`${rel} is larger than ${LIMITS.file / 1048576} MB.`);
      bytes += stat.size;
      files.push({ rel, path: real, size: stat.size });
      if (files.length > LIMITS.files) throw new Error(`The package has more than ${LIMITS.files} files.`);
      if (bytes > LIMITS.bytes) throw new Error(`The package is larger than ${LIMITS.bytes / 1048576} MB.`);
    }
  };
  await walk(dir, 0);
  return { files, bytes };
}

/** Content digest: sha256 over each file's relative path and sha256, in path order. */
export async function digestFiles(files: Array<{ rel: string; path: string }>): Promise<string> {
  const outer = createHash('sha256');
  for (const file of files) outer.update(`${file.rel.split(sep).join('/')}\0${createHash('sha256').update(await fs.readFile(file.path)).digest('hex')}\n`);
  return outer.digest('hex');
}

export interface Installed extends InstalledVersion { manifest: MusterManifest }
/**
 * Validate, stage into extensions/.staging-*, write muster-manifest.json, then rename
 * into extensions/<name>@<version>. A same-version reinstall swaps directories so the
 * target never holds a half-copied tree. `onStage` sees the staging directory (tests).
 */
export async function installPackage(dataDir: string, entry: CatalogEntry, meta: { commit?: string }, onStage?: (staging: string) => Promise<void> | void): Promise<Installed> {
  const { pkg, dir } = entry;
  if (!dir) throw new Error(pkg.compatibility.unsupported[0] ?? 'This package cannot be installed from its source.');
  if (!pkg.compatibility.supported) throw new Error(`${pkg.displayName} has nothing Muster can run: ${pkg.compatibility.unsupported.join('; ') || 'no skills, MCP servers or apps'}.`);
  if (!NAME.test(pkg.name) || !VERSION.test(pkg.version)) throw new Error('The package name or version is not a safe folder name.');
  const { files } = await packageFiles(dir);
  const root = extensionsRoot(dataDir);
  await fs.mkdir(root, { recursive: true });
  const staging = join(root, `.staging-${randomUUID()}`);
  try {
    await fs.mkdir(staging);
    for (const file of files) { const to = join(staging, file.rel); await fs.mkdir(join(to, '..'), { recursive: true }); await fs.copyFile(file.path, to); }
    const sha256 = await digestFiles(files.map(file => ({ rel: file.rel, path: join(staging, file.rel) })));
    const installedAt = new Date().toISOString();
    const target = join(root, `${pkg.name}@${pkg.version}`);
    const manifest: MusterManifest = { schema: 1, name: pkg.name, kind: pkg.kind, version: pkg.version, displayName: pkg.displayName, ...(pkg.description ? { description: pkg.description } : {}), ...(pkg.publisher ? { publisher: pkg.publisher } : {}), ...(pkg.license ? { license: pkg.license } : {}), ...(pkg.homepage ? { homepage: pkg.homepage } : {}),
      source: { id: pkg.sourceId, label: pkg.sourceLabel, ...(meta.commit ? { commit: meta.commit } : {}), path: relative(await fs.realpath(join(dir, '..')), dir) || '.' }, sha256, capabilities: pkg.capabilities, compatibility: pkg.compatibility, installedAt };
    await fs.writeFile(join(staging, 'muster-manifest.json'), JSON.stringify(manifest, null, 2));
    await onStage?.(staging);
    const old = join(root, `.old-${randomUUID()}`);
    const replacing = await exists(target);
    if (replacing) await fs.rename(target, old);
    try { await fs.rename(staging, target); } catch (error) { if (replacing) await fs.rename(old, target); throw error; }
    if (replacing) await fs.rm(old, { recursive: true, force: true });
    return { version: pkg.version, path: target, sha256, ...(meta.commit ? { commit: meta.commit } : {}), installedAt, manifest };
  } catch (error) { await fs.rm(staging, { recursive: true, force: true }); throw error; }
}

/** Remove one installed version directory, only when it is directly under extensions/. */
export async function removeInstall(dataDir: string, path: string): Promise<void> {
  const root = await fs.realpath(extensionsRoot(dataDir)).catch(() => null);
  if (!root) return;
  const real = await inside(path, root);
  if (!real || real === root || relative(root, real).includes(sep)) return;
  await fs.rm(real, { recursive: true, force: true });
}

/** Clear half-finished staging folders a crash may have left. */
export async function sweepStaging(dataDir: string): Promise<void> {
  for (const root of [extensionsRoot(dataDir), sourcesRoot(dataDir)]) {
    let entries: string[] = [];
    try { entries = await fs.readdir(root); } catch { continue; }
    await Promise.all(entries.filter(name => /^\.(staging|tmp|old)-/.test(name)).map(name => fs.rm(join(root, name), { recursive: true, force: true })));
  }
}

/** Numeric x.y.z ordering; non-numeric versions compare as text. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(value)?.slice(1).map(part => Number(part ?? 0));
  const x = parse(a), y = parse(b);
  if (!x || !y) return a === b ? 0 : a.localeCompare(b);
  for (let index = 0; index < 3; index++) if (x[index] !== y[index]) return x[index]! - y[index]!;
  return 0;
}

/** `${CLAUDE_PLUGIN_ROOT}` and `${PLUGIN_ROOT}` point at the installed copy. */
export const expandRoot = (value: string, root: string) => value.replace(/\$\{(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)\}/g, root);
