import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { isEnabled, pluginExtensionId, skillExtensionId, type DetectedSourceProvider, type ExtensionEnablement, type ExtensionScope, type ExtensionSource, type InstalledExtension, type InstallReview, type MarketplacePackage } from '../../shared/domains/extensions-protocol.ts';
import type { Chat } from '../../shared/protocol.ts';
import { discoverCodexProvenance, discoverPlugins, discoverSkills, setDiscoveryGates, setExtensionSkillRoots, type PluginEntry, type SkillRoot } from '../plugin-library.ts';
import { compareVersions, expandRoot, extensionsRoot, installPackage, NAME, packageFiles, readCatalog, removeInstall, sourceRoot, sweepStaging, syncGitSource, type CatalogEntry } from '../plugin-install.ts';
import { readLocalSkill, restoreLocalSkill, saveLocalSkill } from '../skill-editor.ts';
import { PROMPT_CONTRIBUTION_MAX_BYTES } from './hooks.ts';
import type { DomainContext, DomainModule } from './types.ts';

/** Tests point these at fixtures. */
export const extensionsOptions: { allowFileGit: boolean; home?: string; codexCache?: string; claudeMarketplaces?: string } = { allowFileGit: false };
const SCOPES: readonly ExtensionScope[] = ['user', 'folder', 'project'];
// The hook merge (resolveRunOptions) caps each contributor's developerInstructions at
// PROMPT_CONTRIBUTION_MAX_BYTES and truncates mid-text past that. Budgeting skill blocks below
// that cap, with headroom for the intro line and the "more enabled skills" trailer, keeps this
// domain's own accounting (what gets inlined vs. just listed) accurate instead of silently lying.
const MAX_SKILL_CONTEXT = PROMPT_CONTRIBUTION_MAX_BYTES - 1024;
/** The per-turn skill index (name, one line, path) stays around 1k tokens; skills past it are listed by name only. */
const MAX_SKILL_INDEX = 4096;
const MAX_LISTED_SKILLS = 24;
/** The one-line `description:` from a SKILL.md front matter (or its first prose line), clipped for the index. */
export function skillSummary(body: string): string {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body)?.[1] ?? '';
  const described = /^description:\s*(.+)$/m.exec(front)?.[1]?.trim().replace(/^["']|["']$/g, '');
  const text = described || body.replace(/^---[\s\S]*?---/, '').split(/\r?\n/).map(line => line.replace(/^#+\s*/, '').trim()).find(Boolean) || '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
}
/** skillSummary per SKILL.md, keyed by path and reused while its mtime and size are unchanged: the index is
 *  rebuilt on every turn, and re-reading every enabled SKILL.md each time is wasted I/O. */
const summaryCache = new Map<string, { mtimeMs: number; size: number; summary: string | undefined }>();
/** The skill's one-line summary; `undefined` when the file is missing or empty (not indexed). */
export async function cachedSkillSummary(path: string): Promise<string | undefined> {
  const stat = await fs.stat(path).catch(() => null);
  if (!stat?.isFile()) { summaryCache.delete(path); return undefined; }
  const hit = summaryCache.get(path);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.summary;
  const body = await fs.readFile(path, 'utf8').catch(() => '');
  const summary = body.trim() ? skillSummary(body) : undefined;
  summaryCache.delete(path); summaryCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
  if (summaryCache.size > 512) summaryCache.delete(summaryCache.keys().next().value!);
  return summary;
}
interface SourceRow { id: string; kind: string; url: string | null; path: string | null; pinned_commit: string | null; label: string; added_at: string; synced_at: string | null; error: string | null; packages: number | null; detected: string | null }

const text = (value: unknown, label: string, max = 4096): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`Invalid ${label}.`);
  return value.trim();
};
const optional = (value: unknown, label: string, max = 4096) => value === undefined || value === null || value === '' ? undefined : text(value, label, max);
const toSource = (row: SourceRow): ExtensionSource => ({ id: row.id, kind: row.kind === 'git' ? 'git' : 'local', label: row.label, addedAt: row.added_at, ...(row.url ? { url: row.url } : {}), ...(row.path ? { path: row.path } : {}), ...(row.pinned_commit ? { pinnedCommit: row.pinned_commit } : {}), ...(row.synced_at ? { syncedAt: row.synced_at } : {}), ...(row.error ? { error: row.error } : {}), ...(row.packages !== null ? { packages: row.packages } : {}), ...(row.detected === 'codex' || row.detected === 'claude' ? { detected: row.detected } : {}) });
/** Directory names (not dotfiles) directly under `path`, following one level of symlink; missing or unreadable paths are silently empty. */
function listDirsSync(path: string): string[] {
  let entries: import('node:fs').Dirent[];
  try { entries = readdirSync(path, { withFileTypes: true }); } catch { return []; }
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) { names.push(entry.name); continue; }
    if (entry.isSymbolicLink()) { try { if (statSync(join(path, entry.name)).isDirectory()) names.push(entry.name); } catch { /* broken link */ } }
  }
  return names.sort();
}
/** `PluginEntry` (Codex cache format) reshaped into a Discover catalog package, for a "Detected" Codex source. */
function pluginEntryToPackage(entry: PluginEntry, source: Pick<ExtensionSource, 'id' | 'label'>): MarketplacePackage {
  return {
    id: `${source.id}:${entry.name}`, sourceId: source.id, sourceLabel: source.label, name: entry.name, kind: 'plugin',
    displayName: entry.displayName ?? entry.name, version: entry.version,
    ...(entry.shortDescription ? { description: entry.shortDescription } : {}),
    ...(entry.category ? { category: entry.category } : {}),
    ...(entry.icon ? { icon: entry.icon } : {}),
    capabilities: { mcpServers: entry.mcpServers.map(server => ({ name: server.name, transport: server.transport })), apps: entry.apps.map(app => app.name), hooks: [], skills: entry.skills, commands: [], agents: [] },
    compatibility: { format: 'codex', supported: true, unsupported: entry.readError ? [entry.readError] : [], notes: [] },
  };
}
/** Remote MCP servers, apps or required environment variables mean the user still has to connect something. */
const baseState = (entry: InstalledExtension): InstalledExtension['state'] => {
  const caps = entry.manifest?.capabilities;
  return caps && (caps.apps.length || caps.mcpServers.some(server => server.transport === 'remote' || server.env?.length)) ? 'Needs connection' : 'Ready';
};
/** Codex `-c mcp_servers.<key>.*` keys allow only [A-Za-z0-9_-]. */
const serverKey = (extension: string, server: string) => `${extension}_${server}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);

/** Extensions domain: marketplace sources, install lifecycle, scoped enablement and local skill authoring. */
export function createExtensionsDomain(ctx: DomainContext): DomainModule {
  const db = ctx.db();
  db.exec(`CREATE TABLE IF NOT EXISTS extension_sources (id TEXT PRIMARY KEY, kind TEXT NOT NULL, url TEXT, path TEXT, pinned_commit TEXT, label TEXT NOT NULL, added_at TEXT NOT NULL, synced_at TEXT, error TEXT, packages INTEGER);
    CREATE TABLE IF NOT EXISTS extensions_installed (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS extension_enablement (extension_id TEXT NOT NULL, scope TEXT NOT NULL, scope_id TEXT NOT NULL, enabled INTEGER NOT NULL, PRIMARY KEY (extension_id, scope, scope_id));
    CREATE TABLE IF NOT EXISTS extension_sources_hidden (path TEXT PRIMARY KEY)`);
  // extension_sources predates the `detected` column; add it for databases created before this defect fix.
  if (!(db.prepare('PRAGMA table_info(extension_sources)').all() as Array<{ name: string }>).some(row => row.name === 'detected')) db.exec('ALTER TABLE extension_sources ADD COLUMN detected TEXT');
  void sweepStaging(ctx.dataDir);
  const catalogCache = new Map<string, CatalogEntry[]>();
  /** Version directories an active run was dispatched with; uninstall defers their removal until the run settles. */
  const pinned = new Map<string, Set<string>>();
  const pendingRemoval = new Set<string>();
  const busy = new Set<string>();

  const sources = () => (db.prepare('SELECT * FROM extension_sources ORDER BY added_at').all() as unknown as SourceRow[]).map(toSource);
  const source = (id: string) => { const found = sources().find(entry => entry.id === id); if (!found) throw new Error('That source was removed.'); return found; };

  /**
   * On construction, register any of the Mac's existing Codex plugin-cache provenance folders and Claude
   * marketplace checkouts as read-only "Detected" sources (DEF-DISCOVER-EMPTY), skipping paths the user
   * already hid or that are already a source (added detected or by hand). Synchronous and cheap (a
   * handful of top-level `readdir`s), so every source/catalog read after construction sees them — no
   * race with the renderer's first load.
   */
  const detectSources = () => {
    const home = extensionsOptions.home ?? homedir();
    const codexCache = extensionsOptions.codexCache ?? join(home, '.codex', 'plugins', 'cache');
    const claudeMarketplaces = extensionsOptions.claudeMarketplaces ?? join(home, '.claude', 'plugins', 'marketplaces');
    const candidates: Array<{ path: string; label: string; detected: DetectedSourceProvider }> = [
      ...listDirsSync(codexCache).map(name => ({ path: join(codexCache, name), label: `Codex: ${name}`, detected: 'codex' as const })),
      ...listDirsSync(claudeMarketplaces).map(name => ({ path: join(claudeMarketplaces, name), label: `Claude: ${name}`, detected: 'claude' as const })),
    ];
    if (!candidates.length) return;
    const hidden = new Set((db.prepare('SELECT path FROM extension_sources_hidden').all() as Array<{ path: string }>).map(row => row.path));
    const existing = new Set(sources().map(entry => entry.path).filter((value): value is string => !!value));
    const insert = db.prepare('INSERT INTO extension_sources (id, kind, url, path, pinned_commit, label, added_at, synced_at, error, packages, detected) VALUES (?, ?, NULL, ?, NULL, ?, ?, NULL, NULL, NULL, ?)');
    for (const candidate of candidates) {
      if (hidden.has(candidate.path) || existing.has(candidate.path)) continue;
      insert.run(randomUUID().slice(0, 8), 'local', candidate.path, candidate.label, new Date().toISOString(), candidate.detected);
    }
  };
  detectSources();
  const enablement = (): ExtensionEnablement[] => (db.prepare('SELECT * FROM extension_enablement').all() as Array<{ extension_id: string; scope: string; scope_id: string; enabled: number }>).map(row => ({ extensionId: row.extension_id, scope: row.scope as ExtensionScope, scopeId: row.scope_id, enabled: row.enabled === 1 }));
  const installedRows = (): InstalledExtension[] => (db.prepare('SELECT data FROM extensions_installed ORDER BY id').all() as Array<{ data: string }>).map(row => JSON.parse(row.data) as InstalledExtension);
  const installed = (): InstalledExtension[] => {
    const rules = enablement();
    return installedRows().map(entry => ({ ...entry, state: entry.state === 'Failed' || entry.state === 'Staging' ? entry.state : isEnabled(rules, entry.id) ? baseState(entry) : 'Installed' }));
  };
  const save = (entry: InstalledExtension) => { db.prepare('INSERT INTO extensions_installed (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(entry.id, JSON.stringify(entry)); sync(); };
  const folderIdFor = (paths: string[]) => paths.length === 1 ? ctx.store.snapshot().folders.find(folder => folder.path === paths[0])?.id : undefined;

  /** Push installed skill roots and enablement gates into discovery, so disabled items vanish from the composer and attach. */
  const sync = () => {
    const rows = installedRows().filter(entry => entry.state !== 'Failed' && entry.state !== 'Staging');
    const roots: SkillRoot[] = rows.map(entry => entry.kind === 'skill'
      ? { path: extensionsRoot(ctx.dataDir), only: basename(entry.path), name: entry.name, provenance: `extension:${entry.name}` }
      : { path: join(entry.path, 'skills'), provenance: `extension:${entry.name}` });
    setExtensionSkillRoots(roots);
    const rules = enablement();
    setDiscoveryGates({
      skill: (skill, folderPaths) => {
        const at = { folderId: folderIdFor(folderPaths) };
        const owner = skill.provenance.startsWith('extension:') ? skill.provenance.slice(10) : null;
        return (owner === null || isEnabled(rules, owner, at)) && isEnabled(rules, skillExtensionId(skill), at);
      },
      plugin: plugin => isEnabled(rules, pluginExtensionId(plugin)),
    });
  };
  sync();

  const catalogFor = async (entry: ExtensionSource, fresh = false): Promise<CatalogEntry[]> => {
    if (!fresh && entry.kind === 'git' && catalogCache.has(entry.id)) return catalogCache.get(entry.id)!;
    // A detected Codex source is a plugin-cache provenance dir (name/version/... ), not a marketplace.json
    // index: readCatalog would find nothing there, so it goes through the same reader as the Installed tab.
    if (entry.detected === 'codex' && entry.path) {
      const plugins = await discoverCodexProvenance(entry.path, basename(entry.path));
      return plugins.map(plugin => ({ dir: plugin.path, pkg: pluginEntryToPackage(plugin, entry) }));
    }
    const root = await sourceRoot(ctx.dataDir, entry);
    const catalog = root ? await readCatalog(root, entry) : [];
    if (entry.kind === 'git') catalogCache.set(entry.id, catalog);
    return catalog;
  };
  const catalog = async (): Promise<MarketplacePackage[]> => {
    const current = new Map(installed().map(entry => [entry.packageId, entry]));
    const output: MarketplacePackage[] = [];
    for (const entry of sources()) for (const { pkg } of await catalogFor(entry).catch(() => [])) {
      const mine = current.get(pkg.id);
      output.push(mine ? { ...pkg, installed: { version: mine.version, updateAvailable: compareVersions(pkg.version, mine.version) > 0 } } : pkg);
    }
    return output;
  };
  const findPackage = async (packageId: string): Promise<{ entry: CatalogEntry; source: ExtensionSource }> => {
    const sourceId = packageId.slice(0, packageId.indexOf(':'));
    const owner = source(sourceId);
    const entry = (await catalogFor(owner)).find(item => item.pkg.id === packageId);
    if (!entry) throw new Error('That package is no longer in its source. Sync the source and try again.');
    return { entry, source: owner };
  };
  const review = async (packageId: string): Promise<InstallReview> => {
    const { entry } = await findPackage(packageId);
    const errors = [...(entry.dir ? [] : entry.pkg.compatibility.unsupported), ...(entry.pkg.compatibility.supported || !entry.dir ? [] : ['Nothing in this package can run in Muster.'])];
    let bytes = 0, files = 0;
    if (entry.dir) try { const walked = await packageFiles(entry.dir); bytes = walked.bytes; files = walked.files.length; } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    const caps = entry.pkg.capabilities;
    return { package: entry.pkg, bytes, files, errors, permissions: {
      mcp: caps.mcpServers.map(server => ({ name: server.name, detail: server.url ?? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ') + (server.env?.length ? ` (env: ${server.env.join(', ')})` : '') })),
      hooks: caps.hooks, apps: caps.apps } };
  };
  const exclusive = async <T>(key: string, work: () => Promise<T>): Promise<T> => {
    if (busy.has(key)) throw new Error('Another change to this extension is still running.');
    busy.add(key);
    try { return await work(); } finally { busy.delete(key); }
  };
  const isPinned = (path: string) => [...pinned.values()].some(paths => paths.has(path));
  const discard = async (path: string) => { if (isPinned(path)) pendingRemoval.add(path); else await removeInstall(ctx.dataDir, path); };

  const install = (packageId: string) => exclusive(packageId, async () => {
    const { entry, source: owner } = await findPackage(packageId);
    const prior = installedRows().find(row => row.id === entry.pkg.name);
    if (prior && prior.packageId !== packageId) throw new Error(`“${entry.pkg.name}” is already installed from ${prior.manifest?.source.label ?? prior.sourceId}. Uninstall it first.`);
    if (prior && prior.version === entry.pkg.version && prior.state !== 'Failed') throw new Error(`${entry.pkg.displayName} ${prior.version} is already installed.`);
    const done = await installPackage(ctx.dataDir, entry, { ...(owner.pinnedCommit ? { commit: owner.pinnedCommit } : {}) });
    const previous = prior && prior.state !== 'Failed' ? [{ version: prior.version, path: prior.path, sha256: prior.sha256, installedAt: prior.installedAt, ...(prior.commit ? { commit: prior.commit } : {}) }, ...prior.previous] : [];
    // Keep one prior version for rollback; older ones are removed once no run uses them.
    for (const stale of previous.slice(1)) await discard(stale.path);
    const next: InstalledExtension = { id: entry.pkg.name, name: entry.pkg.name, kind: entry.pkg.kind, version: done.version, path: done.path, sourceId: owner.id, packageId, sha256: done.sha256, installedAt: done.installedAt, manifest: done.manifest, previous: previous.slice(0, 1), state: 'Ready', ...(done.commit ? { commit: done.commit } : {}) };
    save({ ...next, state: baseState(next) });
    return installed().find(row => row.id === next.id)!;
  });

  // Active runs keep the version directories they were dispatched with.
  const offSettled = ctx.hooks.onRunSettled(async ({ chat }) => {
    pinned.delete(chat.id);
    for (const path of [...pendingRemoval]) if (!isPinned(path)) { pendingRemoval.delete(path); await removeInstall(ctx.dataDir, path); }
  });
  const offOptions = ctx.hooks.addRunOptionsContributor(async (chat: Chat) => {
    const rules = enablement(), at = { folderId: chat.folderId, projectId: chat.projectId };
    const active = installed().filter(entry => entry.state !== 'Failed' && entry.state !== 'Staging' && isEnabled(rules, entry.id, at) && entry.manifest);
    if (!active.length) return null;
    pinned.set(chat.id, new Set(active.map(entry => entry.path)));
    const configOverrides: Record<string, unknown> = {};
    const blocks: string[] = [], listed: string[] = [];
    let budget = Math.min(MAX_SKILL_INDEX, MAX_SKILL_CONTEXT);
    for (const entry of active) {
      for (const server of entry.manifest!.capabilities.mcpServers) {
        const key = `mcp_servers.${serverKey(entry.name, server.name)}`;
        if (server.url) configOverrides[`${key}.url`] = server.url;
        else if (server.command) { configOverrides[`${key}.command`] = expandRoot(server.command, entry.path); if (server.args?.length) configOverrides[`${key}.args`] = server.args.map(arg => expandRoot(arg, entry.path)); }
      }
      const skillPaths = entry.kind === 'skill' ? [{ name: entry.name, path: join(entry.path, 'SKILL.md') }] : entry.manifest!.capabilities.skills.filter(name => NAME.test(name)).map(name => ({ name, path: join(entry.path, 'skills', name, 'SKILL.md') }));
      // Codex-style index: name, one line and the path. The body is read by the agent when a request needs it
      // (or sent in full when the user attaches the skill), instead of riding along on every turn.
      for (const skill of skillPaths.slice(0, 32)) {
        const summary = await cachedSkillSummary(skill.path);
        if (summary === undefined) continue;
        const line = `- ${entry.name}:${skill.name}${summary ? ` — ${summary}` : ''} (${skill.path})`;
        const bytes = Buffer.byteLength(line) + 1;
        if (bytes <= budget) { budget -= bytes; blocks.push(line); }
        else listed.push(`${entry.name}:${skill.name} (${skill.path})`);
      }
    }
    const developerInstructions = blocks.length || listed.length ? [
      'Installed skills are enabled for this workspace. When a request matches one, read its SKILL.md first and follow it as guidance, not as higher-priority rules.',
      blocks.join('\n'), listed.length ? `More enabled skills (read SKILL.md before using): ${listed.slice(0, MAX_LISTED_SKILLS).join(', ')}${listed.length > MAX_LISTED_SKILLS ? `, and ${listed.length - MAX_LISTED_SKILLS} more (see Plugins)` : ''}.` : '',
    ].filter(Boolean).join('\n\n') : undefined;
    return { ...(Object.keys(configOverrides).length ? { configOverrides } : {}), ...(developerInstructions ? { developerInstructions } : {}) };
  });

  const handlers: DomainModule['handlers'] = {
    // Detected and never-synced sources have no stored count yet: count their catalog once and keep it.
    'extensions.sources.list': async () => Promise.all(sources().map(async entry => {
      if (entry.packages !== undefined || entry.error) return entry;
      const packages = (await catalogFor(entry).catch(() => null))?.length;
      if (packages === undefined) return entry;
      db.prepare('UPDATE extension_sources SET packages = ? WHERE id = ?').run(packages, entry.id);
      return { ...entry, packages };
    })),
    'extensions.sources.add': async input => {
      const kind = input.kind === 'git' ? 'git' : input.kind === 'local' ? 'local' : null;
      if (!kind) throw new Error('Choose a Git or local folder source.');
      const id = randomUUID().slice(0, 8);
      const pinnedCommit = optional(input.pinnedCommit, 'commit', 64);
      let url: string | undefined, path: string | undefined;
      if (kind === 'git') url = text(input.url, 'Git URL', 2048);
      else {
        path = await fs.realpath(text(input.path, 'folder')).catch(() => { throw new Error('That folder does not exist.'); });
        if (!(await fs.stat(path)).isDirectory()) throw new Error('Choose a folder.');
      }
      const label = optional(input.label, 'label', 80) ?? (url ? url.replace(/^https:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '') : basename(path!));
      if (sources().some(entry => (url && entry.url === url) || (path && entry.path === path))) throw new Error('That source is already added.');
      db.prepare('INSERT INTO extension_sources (id, kind, url, path, pinned_commit, label, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, kind, url ?? null, path ?? null, pinnedCommit ?? null, label, new Date().toISOString());
      return handlers['extensions.sources.sync']!({ id });
    },
    'extensions.sources.sync': input => exclusive(`source:${text(input.id, 'source')}`, async () => {
      const entry = source(text(input.id, 'source'));
      let error: string | null = null, commit = entry.pinnedCommit ?? null;
      try { if (entry.kind === 'git') commit = await syncGitSource(ctx.dataDir, input.latest === true ? { id: entry.id, url: entry.url } : entry, { allowFile: extensionsOptions.allowFileGit }); }
      catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
      const packages = error ? null : (await catalogFor(entry, true)).length;
      db.prepare('UPDATE extension_sources SET synced_at = ?, error = ?, packages = ?, pinned_commit = ? WHERE id = ?').run(new Date().toISOString(), error, packages, commit, entry.id);
      return source(entry.id);
    }),
    'extensions.sources.remove': async input => {
      const entry = source(text(input.id, 'source'));
      db.prepare('DELETE FROM extension_sources WHERE id = ?').run(entry.id);
      catalogCache.delete(entry.id);
      if (entry.kind === 'git') await fs.rm(join(ctx.dataDir, 'extension-sources', entry.id), { recursive: true, force: true });
      // A detected source is read-only: "remove" hides it so it never comes back on its own.
      if (entry.detected && entry.path) db.prepare('INSERT OR IGNORE INTO extension_sources_hidden (path) VALUES (?)').run(entry.path);
    },
    'extensions.catalog': () => catalog(),
    'extensions.inventory': async () => ({
      skills: await discoverSkills(ctx.store.snapshot().folders.filter(folder => !folder.missing).map(folder => folder.path), { all: true }),
      plugins: await discoverPlugins(extensionsOptions.codexCache, { all: true }),
    }),
    'extensions.review': input => review(text(input.packageId, 'package', 256)),
    'extensions.install': input => install(text(input.packageId, 'package', 256)),
    'extensions.installed': () => installed(),
    'extensions.update': async input => {
      const current = installedRows().find(entry => entry.id === text(input.id, 'extension'));
      if (!current) throw new Error('That extension is not installed.');
      const { entry } = await findPackage(current.packageId);
      if (compareVersions(entry.pkg.version, current.version) <= 0) throw new Error(`${current.name} ${current.version} is up to date.`);
      return install(current.packageId);
    },
    'extensions.rollback': input => exclusive(text(input.id, 'extension'), async () => {
      const current = installedRows().find(entry => entry.id === input.id);
      const prior = current?.previous[0];
      if (!current || !prior) throw new Error('There is no earlier version to roll back to.');
      const manifest = JSON.parse(await fs.readFile(join(prior.path, 'muster-manifest.json'), 'utf8').catch(() => { throw new Error(`${current.name} ${prior.version} is no longer on disk.`); }));
      const next: InstalledExtension = { ...current, version: prior.version, path: prior.path, sha256: prior.sha256, installedAt: prior.installedAt, manifest, previous: [{ version: current.version, path: current.path, sha256: current.sha256, installedAt: current.installedAt, ...(current.commit ? { commit: current.commit } : {}) }] };
      if (prior.commit) next.commit = prior.commit; else delete next.commit;
      save({ ...next, state: baseState(next) });
      return installed().find(row => row.id === next.id)!;
    }),
    'extensions.uninstall': input => exclusive(text(input.id, 'extension'), async () => {
      const current = installedRows().find(entry => entry.id === input.id);
      if (!current) return;
      db.prepare('DELETE FROM extensions_installed WHERE id = ?').run(current.id);
      db.prepare('DELETE FROM extension_enablement WHERE extension_id = ?').run(current.id);
      sync();
      for (const path of [current.path, ...current.previous.map(entry => entry.path)]) await discard(path);
    }),
    'extensions.enablement.list': () => enablement(),
    'extensions.enablement.set': input => {
      const extensionId = text(input.extensionId, 'extension', 512);
      const scope = SCOPES.includes(input.scope as ExtensionScope) ? input.scope as ExtensionScope : null;
      if (!scope) throw new Error('Choose user, folder or project scope.');
      const scopeId = scope === 'user' ? '' : text(input.scopeId, `${scope} id`, 128);
      if (scope === 'folder' && !ctx.store.folder(scopeId)) throw new Error('That folder was removed.');
      if (scope === 'project' && !ctx.store.project(scopeId)) throw new Error('That project was removed.');
      if (typeof input.enabled !== 'boolean') throw new Error('Invalid enablement.');
      db.prepare('INSERT INTO extension_enablement (extension_id, scope, scope_id, enabled) VALUES (?, ?, ?, ?) ON CONFLICT(extension_id, scope, scope_id) DO UPDATE SET enabled = excluded.enabled').run(extensionId, scope, scopeId, input.enabled ? 1 : 0);
      sync();
      return enablement();
    },
    'extensions.skills.read': input => readLocalSkill(text(input.name, 'skill name', 64), extensionsOptions.home),
    'extensions.skills.save': input => saveLocalSkill({ name: text(input.name, 'skill name', 64), description: typeof input.description === 'string' ? input.description : '', body: typeof input.body === 'string' ? input.body : '', ...(typeof input.previousName === 'string' && input.previousName ? { previousName: input.previousName } : {}) }, extensionsOptions.home),
    'extensions.skills.restore': input => restoreLocalSkill(text(input.name, 'skill name', 64), text(input.historyId, 'version', 64), extensionsOptions.home),
  };
  return { handlers, dispose() { offSettled(); offOptions(); setExtensionSkillRoots([]); setDiscoveryGates({ skill: null, plugin: null }); } };
}
