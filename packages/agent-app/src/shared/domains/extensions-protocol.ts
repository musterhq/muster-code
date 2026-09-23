/** Extensions domain contract: marketplace sources, catalog, install lifecycle, scoped enablement and local skill authoring. */
import type { ItemIcon, PluginEntry, SkillEntry } from '../protocol.ts';
export type ExtensionSourceKind = 'git' | 'local';
/** Where a "Detected" source came from: an existing Codex plugin cache or Claude marketplace directory on disk. */
export type DetectedSourceProvider = 'codex' | 'claude';
/** A marketplace source. Git sources are shallow-cloned at `pinnedCommit` (or the commit resolved on first sync, which is then pinned).
 * `detected` marks a source Muster found on disk itself (read-only path/label; the user can only hide it, via remove). */
export interface ExtensionSource { id: string; kind: ExtensionSourceKind; url?: string; path?: string; pinnedCommit?: string; label: string; addedAt: string; syncedAt?: string; error?: string; packages?: number; detected?: DetectedSourceProvider }
export type ExtensionKind = 'plugin' | 'skill';
export interface ExtensionMcpServer { name: string; transport: 'local' | 'remote' | 'unknown'; command?: string; args?: string[]; url?: string; env?: string[] }
/** What a package asks for. Hooks, commands and agents are listed for review only; Muster never executes them. */
export interface ExtensionCapabilities { mcpServers: ExtensionMcpServer[]; apps: string[]; hooks: string[]; skills: string[]; commands: string[]; agents: string[] }
export interface ExtensionCompatibility { format: 'claude' | 'codex' | 'skill'; supported: boolean; unsupported: string[]; notes: string[] }
export interface MarketplacePackage {
  /** `sourceId:name` — the qualified name. */
  id: string; sourceId: string; sourceLabel: string; name: string; kind: ExtensionKind; displayName: string; version: string;
  description?: string; publisher?: string; license?: string; homepage?: string; category?: string; keywords?: string[];
  capabilities: ExtensionCapabilities; compatibility: ExtensionCompatibility; icon?: ItemIcon;
  installed?: { version: string; updateAvailable: boolean };
}
export type ExtensionState = 'Staging' | 'Installed' | 'Needs connection' | 'Ready' | 'Failed';
/** Normalized manifest written beside every install as muster-manifest.json. */
export interface MusterManifest { schema: 1; name: string; kind: ExtensionKind; version: string; displayName: string; description?: string; publisher?: string; license?: string; homepage?: string; source: { id: string; label: string; commit?: string; path: string }; sha256: string; capabilities: ExtensionCapabilities; compatibility: ExtensionCompatibility; installedAt: string }
export interface InstalledVersion { version: string; path: string; sha256: string; commit?: string; installedAt: string }
export interface InstalledExtension { id: string; name: string; kind: ExtensionKind; version: string; path: string; sourceId: string; packageId: string; commit?: string; sha256: string; installedAt: string; state: ExtensionState; error?: string; manifest: MusterManifest | null; previous: InstalledVersion[] }
export type ExtensionScope = 'user' | 'folder' | 'project';
/** `scopeId` is '' for user scope, a folder id or a project id otherwise. */
export interface ExtensionEnablement { extensionId: string; scope: ExtensionScope; scopeId: string; enabled: boolean }
export interface InstallReview { package: MarketplacePackage; permissions: { mcp: Array<{ name: string; detail: string }>; hooks: string[]; apps: string[] }; bytes: number; files: number; errors: string[] }
export interface LocalSkillDraft { name: string; description: string; body: string }
export interface LocalSkill extends LocalSkillDraft { path: string; assets: string[]; history: Array<{ id: string; savedAt: string }> }

export interface ExtensionsCommands {
  'extensions.sources.list': { input: undefined; output: ExtensionSource[] };
  'extensions.sources.add': { input: { kind: ExtensionSourceKind; url?: string; path?: string; pinnedCommit?: string; label?: string }; output: ExtensionSource };
  /** Re-reads the source at its pin; `latest` moves a Git source's pin to the remote HEAD first. */
  'extensions.sources.sync': { input: { id: string; latest?: boolean }; output: ExtensionSource };
  'extensions.sources.remove': { input: { id: string }; output: void };
  'extensions.catalog': { input: undefined; output: MarketplacePackage[] };
  /** Everything on disk, disabled items included: local skills from every folder, marketplace installs and Codex cache plugins. */
  'extensions.inventory': { input: undefined; output: { skills: SkillEntry[]; plugins: PluginEntry[] } };
  'extensions.review': { input: { packageId: string }; output: InstallReview };
  'extensions.install': { input: { packageId: string }; output: InstalledExtension };
  'extensions.installed': { input: undefined; output: InstalledExtension[] };
  'extensions.update': { input: { id: string }; output: InstalledExtension };
  'extensions.rollback': { input: { id: string }; output: InstalledExtension };
  'extensions.uninstall': { input: { id: string }; output: void };
  'extensions.enablement.list': { input: undefined; output: ExtensionEnablement[] };
  'extensions.enablement.set': { input: ExtensionEnablement; output: ExtensionEnablement[] };
  'extensions.skills.read': { input: { name: string }; output: LocalSkill };
  'extensions.skills.save': { input: LocalSkillDraft & { previousName?: string }; output: LocalSkill };
  'extensions.skills.restore': { input: { name: string; historyId: string }; output: LocalSkill };
}
export type ExtensionsEvent = never;
export const EXTENSIONS_COMMANDS = {
  'extensions.sources.list': true, 'extensions.sources.add': true, 'extensions.sources.sync': true, 'extensions.sources.remove': true,
  'extensions.catalog': true, 'extensions.inventory': true, 'extensions.review': true, 'extensions.install': true, 'extensions.installed': true, 'extensions.update': true,
  'extensions.rollback': true, 'extensions.uninstall': true, 'extensions.enablement.list': true, 'extensions.enablement.set': true,
  'extensions.skills.read': true, 'extensions.skills.save': true, 'extensions.skills.restore': true,
} as const satisfies Record<keyof ExtensionsCommands, true>;

/** Enablement ids: installed marketplace extensions use their name; local skills and Codex cache plugins are prefixed. */
export const skillExtensionId = (skill: { name: string; provenance: string }) => `skill:${qualifiedSkillName(skill)}`;
export const pluginExtensionId = (plugin: { name: string; provenance: string }) => `codex-plugin:${plugin.provenance}/${plugin.name}`;
/** Enablement precedence: the most specific scope wins (folder > project > user); no row means enabled. */
export function isEnabled(rows: readonly ExtensionEnablement[], extensionId: string, at: { folderId?: string; projectId?: string } = {}): boolean {
  const find = (scope: ExtensionScope, scopeId: string) => rows.find(row => row.extensionId === extensionId && row.scope === scope && row.scopeId === scopeId);
  const hit = (at.folderId ? find('folder', at.folderId) : undefined) ?? (at.projectId ? find('project', at.projectId) : undefined) ?? find('user', '');
  return hit ? hit.enabled : true;
}

export type SkillTier = 'folder' | 'user' | 'global';
/** Folder skills shadow user skills, which shadow globally installed (marketplace) skills with the same name. */
export const SKILL_TIER_RANK: Record<SkillTier, number> = { folder: 0, user: 1, global: 2 };
export function skillTier(provenance: string): SkillTier { return provenance.startsWith('.agents/skills (') ? 'folder' : provenance.startsWith('extension:') ? 'global' : 'user'; }
/** `source:name`; the source is the root label without its path noise. */
export function qualifiedSkillName(entry: { name: string; provenance: string }): string {
  const source = entry.provenance.startsWith('extension:') ? entry.provenance.slice(10) : entry.provenance.replace(/^\.agents\/skills \((.*)\)$/, '$1').replace(/^~\//, '').replace(/\/skills$/, '');
  return `${source}:${entry.name}`;
}
/** For each skill id, the qualified name of the entry that wins its bare name, when that is not the entry itself. */
export function skillShadows(entries: ReadonlyArray<{ id: string; name: string; provenance: string }>): Map<string, string> {
  const winners = new Map<string, { id: string; name: string; provenance: string }>();
  for (const entry of entries) {
    const prior = winners.get(entry.name);
    if (!prior || SKILL_TIER_RANK[skillTier(entry.provenance)] < SKILL_TIER_RANK[skillTier(prior.provenance)]) winners.set(entry.name, entry);
  }
  const output = new Map<string, string>();
  for (const entry of entries) { const winner = winners.get(entry.name)!; if (winner.id !== entry.id) output.set(entry.id, qualifiedSkillName(winner)); }
  return output;
}
