import type { ItemIcon, PluginEntry, SkillEntry } from '../shared/protocol.ts';
import type { InstalledExtension, MarketplacePackage } from '../shared/domains/extensions-protocol.ts';

/** QA-#19/#20 (S3-F): what the Discover grid and the Installed lists show, as pure data. */
export type InstalledTarget = { kind: 'installed'; id: string } | { kind: 'codex'; id: string } | { kind: 'skill'; id: string };
export interface CatalogCard { pkg: MarketplacePackage; icon?: ItemIcon; installedAs?: InstalledTarget; sources: string[] }

/** "Google Calendar", "google-calendar" and "google_calendar" are the same thing. */
export const normalizeName = (value: string | undefined): string => (value ?? '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Internal bundles (Codex's `.system` skills, dot-folders) are not the user's skills. */
export function isSystemSkill(skill: Pick<SkillEntry, 'name' | 'path' | 'provenance'>): boolean {
  return skill.name.startsWith('.') || /(^|[\\/])\.system([\\/]|$)/.test(skill.path) || /(^|[\\/])\.system([\\/]|$)/.test(skill.provenance);
}

/** A real logo for a name, taken from any manifest that ships one (a Codex plugin, another source's copy). */
export function brandIcons(plugins: readonly PluginEntry[], catalog: readonly MarketplacePackage[]): Map<string, ItemIcon> {
  const icons = new Map<string, ItemIcon>();
  const add = (icon: ItemIcon | undefined, ...names: Array<string | undefined>) => {
    if (icon?.kind !== 'image') return;
    for (const name of names) { const key = normalizeName(name); if (key && !icons.has(key)) icons.set(key, icon); }
  };
  for (const plugin of plugins) add(plugin.icon, plugin.name, plugin.displayName);
  for (const pkg of catalog) add(pkg.icon, pkg.name, pkg.displayName);
  return icons;
}
export function iconFor(icons: ReadonlyMap<string, ItemIcon>, own: ItemIcon | undefined, ...names: Array<string | undefined>): ItemIcon | undefined {
  if (own?.kind === 'image') return own;
  for (const name of names) { const found = icons.get(normalizeName(name)); if (found) return found; }
  return own;
}

/**
 * One card per package across every source: the same plugin is often published by several
 * (openai-curated and openai-curated-remote, a Claude marketplace too). Copies merge by kind and
 * normalized name or display name; the kept copy is the installed one, then one with an update,
 * then a supported one, then one with a logo. Installed anywhere (marketplace, Codex cache, a local
 * skill folder) means the card offers Manage, never Install.
 */
export function discoverCards(input: { catalog: readonly MarketplacePackage[]; installed: readonly InstalledExtension[]; plugins: readonly PluginEntry[]; skills: readonly SkillEntry[] }): CatalogCard[] {
  const icons = brandIcons(input.plugins, input.catalog);
  const codex = new Map<string, PluginEntry>();
  for (const plugin of input.plugins) for (const name of [plugin.name, plugin.displayName]) { const key = normalizeName(name); if (key && !codex.has(key)) codex.set(key, plugin); }
  const skills = new Map<string, SkillEntry>();
  for (const skill of input.skills) if (!isSystemSkill(skill)) { const key = normalizeName(skill.name); if (key && !skills.has(key)) skills.set(key, skill); }
  const installedFor = (pkg: MarketplacePackage): InstalledTarget | undefined => {
    const mine = input.installed.find(entry => entry.packageId === pkg.id) ?? (pkg.installed ? input.installed.find(entry => entry.kind === pkg.kind && normalizeName(entry.name) === normalizeName(pkg.name)) : undefined);
    if (mine) return { kind: 'installed', id: mine.id };
    if (pkg.kind === 'plugin') { const plugin = codex.get(normalizeName(pkg.name)) ?? codex.get(normalizeName(pkg.displayName)); if (plugin) return { kind: 'codex', id: plugin.id }; }
    if (pkg.kind === 'skill') { const skill = skills.get(normalizeName(pkg.name)); if (skill) return { kind: 'skill', id: skill.id }; }
    return undefined;
  };
  const rank = (card: CatalogCard) => (card.pkg.installed ? 8 : 0) + (card.installedAs ? 4 : 0) + (card.pkg.installed?.updateAvailable ? 2 : 0) + (card.pkg.compatibility.supported ? 1 : 0) + (card.pkg.icon?.kind === 'image' ? 0.5 : 0);
  const cards: CatalogCard[] = [], byKey = new Map<string, CatalogCard>();
  for (const pkg of input.catalog) {
    const keys = [`${pkg.kind}:${normalizeName(pkg.name)}`, `${pkg.kind}:${normalizeName(pkg.displayName)}`].filter(key => !key.endsWith(':'));
    const next: CatalogCard = { pkg, icon: iconFor(icons, pkg.icon, pkg.name, pkg.displayName), installedAs: installedFor(pkg), sources: [pkg.sourceLabel] };
    const prior = keys.map(key => byKey.get(key)).find(Boolean);
    if (!prior) { cards.push(next); for (const key of keys) byKey.set(key, next); continue; }
    const sources = prior.sources.includes(pkg.sourceLabel) ? prior.sources : [...prior.sources, pkg.sourceLabel];
    if (rank(next) > rank(prior)) Object.assign(prior, next, { installedAs: next.installedAs ?? prior.installedAs, sources });
    else Object.assign(prior, { installedAs: prior.installedAs ?? next.installedAs, sources });
    for (const key of keys) byKey.set(key, prior);
  }
  return cards;
}
/** Unsupported packages stay out of the grid unless asked for (an installed one always shows). */
export const isHiddenUnsupported = (card: CatalogCard): boolean => !card.pkg.compatibility.supported && !card.pkg.installed && !card.installedAs;
