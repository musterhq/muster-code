import { AlertTriangle, AppWindow, ArrowLeft, BookOpen, Boxes, Check, Download, FolderGit2, FolderOpen, GitBranch, Pencil, Plug, Plus, RefreshCw, RotateCcw, Search, Server, Store, Trash2, Webhook } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ItemIcon, PluginEntry, SkillEntry } from '../../shared/protocol';
import { brandIcons, discoverCards, iconFor, isHiddenUnsupported, isSystemSkill, type CatalogCard, type InstalledTarget } from '../marketplaceCatalog';
import { isEnabled, pluginExtensionId, qualifiedSkillName, skillExtensionId, skillShadows, skillTier, type ExtensionEnablement, type ExtensionScope, type ExtensionSource, type InstalledExtension, type InstallReview, type MarketplacePackage } from '../../shared/domains/extensions-protocol';
import { invoke } from '../bridge';
import { closeSettings, loadPlugins, loadSkills, notifySuccess } from '../store';
import { openPluginUiTab } from '../artifacts';
import { restoreFocus } from '../focus';
import { useStore } from '../useStore';
import { MessageBody } from './MessageBody';
import { ModalSheet } from './ModalSheet';
import { PluginIcon } from './PluginIcon';
import { SkillEditor } from './SkillEditor';
import { McpServers } from './McpServers';
import './plugins-screen.css';
import './plugin-ui.css';
import { plural } from '../../shared/wording.ts';
import { ResourceState } from './ResourceState';
import {Tip} from './Tooltip';

type Tab = 'discover' | 'installed' | 'sources' | 'mcp';
type Kind = 'all' | 'plugin' | 'skill';
type Selection = { kind: 'package'; id: string } | { kind: 'installed'; id: string } | { kind: 'skill'; id: string } | { kind: 'codex'; id: string } | { kind: 'editor'; name: string | null } | null;
interface Data { sources: ExtensionSource[]; catalog: MarketplacePackage[]; installed: InstalledExtension[]; enablement: ExtensionEnablement[]; skills: SkillEntry[]; plugins: PluginEntry[] }
const EMPTY: Data = { sources: [], catalog: [], installed: [], enablement: [], skills: [], plugins: [] };
const message = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);
const bytes = (value: number) => value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1048576).toFixed(1)} MB`;
const LOCAL_SKILLS = '~/.agents/skills';
const matches = (query: string, ...values: Array<string | undefined>) => !query || values.join(' ').toLocaleLowerCase().includes(query);

export function PluginsScreen(): React.ReactElement {
  const state = useStore();
  const [tab, setTab] = useState<Tab>(state.pluginView === 'skills' ? 'installed' : 'discover');
  // The type filter is remembered per tab: opening from "Skills" must not leave Discover
  // (a mostly-plugin catalog) filtered to skills and looking empty.
  const [kinds, setKinds] = useState<Record<Tab, Kind>>(() => ({discover: 'all', installed: state.pluginView === 'skills' ? 'skill' : 'all'} as Record<Tab, Kind>));
  const kind: Kind = kinds[tab] ?? 'all';
  const setKind = (value: Kind) => setKinds(current => ({...current, [tab]: value}));
  const [scope, setScope] = useState('user');
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState<Selection>(null);
  const [data, setData] = useState<Data>(EMPTY);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<InstalledExtension | null>(null);
  const back = useRef<HTMLButtonElement>(null);
  const launcher = useRef<Element | null>(null);
  useEffect(() => { launcher.current = document.activeElement; back.current?.focus(); }, []);
  const leave = () => { closeSettings(); restoreFocus(launcher.current); };

  const reload = useCallback(async () => {
    setPhase(current => current === 'ready' ? 'ready' : 'loading');
    try {
      const [sources, catalog, installed, enablement, inventory] = await Promise.all([invoke('extensions.sources.list', undefined), invoke('extensions.catalog', undefined), invoke('extensions.installed', undefined), invoke('extensions.enablement.list', undefined), invoke('extensions.inventory', undefined)]);
      setData({ sources, catalog, installed, enablement, skills: inventory.skills, plugins: inventory.plugins }); setPhase('ready'); setError(null);
    } catch (cause) { setError(message(cause)); setPhase('error'); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  /** The composer's lists drop disabled items, so they refresh after every lifecycle change. */
  const changed = async () => { await reload(); void loadSkills(true); void loadPlugins(true); };
  const run = async (key: string, label: string, work: () => Promise<unknown>, done?: string) => {
    setPending(current => ({ ...current, [key]: label })); setFailed(({ [key]: _, ...rest }) => rest);
    try { await work(); if (done) notifySuccess(done); await changed(); return true; }
    catch (cause) { setFailed(current => ({ ...current, [key]: message(cause) })); return false; }
    finally { setPending(({ [key]: _, ...rest }) => rest); }
  };

  const folders = state.snapshot?.folders ?? [], projects = state.snapshot?.projects ?? [];
  const [scopeKind, scopeId] = scope === 'user' ? ['user', ''] as const : [scope.slice(0, scope.indexOf(':')) as ExtensionScope, scope.slice(scope.indexOf(':') + 1)];
  const at = scopeKind === 'folder' ? { folderId: scopeId } : scopeKind === 'project' ? { projectId: scopeId } : {};
  const enabled = (id: string) => isEnabled(data.enablement, id, at);
  const toggle = (id: string, value: boolean) => void run(`enable:${id}`, value ? 'Enabling…' : 'Disabling…', () => invoke('extensions.enablement.set', { extensionId: id, scope: scopeKind, scopeId, enabled: value }));
  const scopeLabel = scopeKind === 'user' ? 'everywhere' : scopeKind === 'folder' ? `in ${folders.find(folder => folder.id === scopeId)?.name ?? 'this folder'}` : `in ${projects.find(project => project.id === scopeId)?.name ?? 'this project'}`;

  const q = query.trim().toLocaleLowerCase();
  // S3-F (QA-#19): one card per package across sources, Manage for anything installed anywhere,
  // unsupported packages behind a filter, and a real logo wherever any manifest ships one.
  const [showUnsupported, setShowUnsupported] = useState(false);
  const cards = useMemo(() => discoverCards(data), [data]);
  const unsupportedCount = useMemo(() => cards.filter(isHiddenUnsupported).length, [cards]);
  const catalog = useMemo(() => cards.filter(card => (showUnsupported || !isHiddenUnsupported(card)) && (kind === 'all' || card.pkg.kind === kind) && matches(q, card.pkg.displayName, card.pkg.name, card.pkg.description, card.pkg.publisher, card.pkg.category, ...card.sources, ...(card.pkg.keywords ?? []))), [cards, showUnsupported, kind, q]);
  const icons = useMemo(() => brandIcons(data.plugins, data.catalog), [data.plugins, data.catalog]);
  const manage = (target: InstalledTarget) => { setTab('installed'); setSelection(target); };
  const userSkills = useMemo(() => data.skills.filter(skill => !isSystemSkill(skill)), [data.skills]);
  const shadows = useMemo(() => skillShadows(data.skills), [data.skills]);
  const localSkills = useMemo(() => userSkills.filter(skill => skillTier(skill.provenance) !== 'global' && (kind === 'all' || kind === 'skill') && matches(q, skill.displayName, skill.name, skill.shortDescription, skill.provenance)), [userSkills, kind, q]);
  const installs = data.installed.filter(entry => (kind === 'all' || entry.kind === kind) && matches(q, entry.manifest?.displayName, entry.name, entry.manifest?.description, entry.manifest?.publisher));
  const codexPlugins = data.plugins.filter(plugin => (kind === 'all' || kind === 'plugin') && matches(q, plugin.displayName, plugin.name, plugin.shortDescription, plugin.provenance));
  const switchTab = (next: Tab) => { setTab(next); setSelection(null); };
  const refreshing = phase === 'loading' || Object.keys(pending).some(key => key.startsWith('sync:'));

  const detail = (() => {
    if (!selection) return null;
    if (selection.kind === 'editor') return <SkillEditor key={selection.name ?? 'new'} name={selection.name} onClose={() => setSelection(null)} onSaved={saved => { void changed(); setSelection({ kind: 'editor', name: saved.name }); }} />;
    if (selection.kind === 'package') { const pkg = data.catalog.find(entry => entry.id === selection.id), card = cards.find(entry => entry.pkg.id === selection.id); return pkg ? <PackageDetail pkg={pkg} icon={card?.icon} onManage={card?.installedAs ? () => manage(card.installedAs!) : undefined} busy={pending[pkg.id]} error={failed[pkg.id]} onInstall={() => setReviewing(pkg.id)} onUpdate={() => void run(pkg.id, 'Updating…', () => invoke('extensions.update', { id: pkg.name }), `${pkg.displayName} updated.`)} /> : null; }
    if (selection.kind === 'installed') { const entry = data.installed.find(row => row.id === selection.id); return entry ? <InstalledDetail entry={entry} update={data.catalog.find(pkg => pkg.id === entry.packageId && pkg.installed?.updateAvailable)} busy={pending[entry.id]} error={failed[entry.id]} onUpdate={() => void run(entry.id, 'Updating…', () => invoke('extensions.update', { id: entry.id }), `${entry.name} updated.`)} onRollback={() => void run(entry.id, 'Rolling back…', () => invoke('extensions.rollback', { id: entry.id }), `${entry.name} rolled back to ${entry.previous[0]?.version}.`)} onRemove={() => setRemoving(entry)} /> : null; }
    if (selection.kind === 'skill') { const skill = data.skills.find(entry => entry.id === selection.id); return skill ? <SkillDetail skill={skill} shadowedBy={shadows.get(skill.id)} onEdit={skill.provenance === LOCAL_SKILLS ? () => setSelection({ kind: 'editor', name: skill.name }) : undefined} /> : null; }
    const plugin = data.plugins.find(entry => entry.id === selection.id);
    return plugin ? <PluginDetail plugin={plugin} /> : null;
  })();

  return <section className="settings-screen plugins-screen" aria-label="Skills & plugins" onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); if (selection) setSelection(null); else leave(); } }}>
    <header className="settings-topbar">
      <button ref={back} type="button" className="settings-back" onClick={leave}><ArrowLeft size={15} />Back to app</button>
      <span className="plugins-topbar-title">Skills & plugins</span>
      <Tip label="Refresh"><button type="button" className="tool-button plugins-refresh" disabled={refreshing} onClick={() => void changed()} aria-label="Refresh"><RefreshCw size={14} className={refreshing ? 'spinning' : ''} /></button></Tip>
    </header>
    <div className="plugins-toolbar">
      <div className="plugins-view-tabs" role="tablist" aria-label="Marketplace">
        <button role="tab" aria-selected={tab === 'discover'} className={tab === 'discover' ? 'is-active' : ''} onClick={() => switchTab('discover')}><Store size={14} />Discover <span>{cards.length - unsupportedCount || ''}</span></button>
        <button role="tab" aria-selected={tab === 'installed'} className={tab === 'installed' ? 'is-active' : ''} onClick={() => switchTab('installed')}><Boxes size={14} />Installed <span>{data.installed.length + data.plugins.length + userSkills.filter(skill => skillTier(skill.provenance) !== 'global').length || ''}</span></button>
        <button role="tab" aria-selected={tab === 'sources'} className={tab === 'sources' ? 'is-active' : ''} onClick={() => switchTab('sources')}><GitBranch size={14} />Sources <span>{data.sources.length || ''}</span></button>
        <button role="tab" aria-selected={tab === 'mcp'} className={tab === 'mcp' ? 'is-active' : ''} onClick={() => switchTab('mcp')}><Server size={14} />MCP</button>
      </div>
      {tab !== 'sources' && tab !== 'mcp' && <>
        <div className="plugins-search-row"><Search size={13} className="plugins-search-icon" /><input type="search" className="plugins-search" placeholder={tab === 'discover' ? 'Search plugins and skills' : 'Filter installed'} value={query} onChange={event => setQuery(event.target.value)} aria-label="Search" /></div>
        <div className="plugins-categories" role="group" aria-label="Type">{(['all', 'plugin', 'skill'] as const).map(value => <button key={value} type="button" className={`plugins-category${kind === value ? ' is-active' : ''}`} aria-pressed={kind === value} onClick={() => setKind(value)}>{value === 'all' ? 'All' : value === 'plugin' ? 'Plugins' : 'Skills'}</button>)}
          {tab === 'discover' && unsupportedCount > 0 && <button type="button" className={`plugins-category plugins-unsupported-filter${showUnsupported ? ' is-active' : ''}`} aria-pressed={showUnsupported} title="Packages that use features Muster cannot run yet" onClick={() => setShowUnsupported(value => !value)}>Unsupported <span>{unsupportedCount}</span></button>}</div>
        {tab === 'installed' && <label className="plugins-scope">Scope<select value={scope} onChange={event => setScope(event.target.value)}>
          <option value="user">User (everywhere)</option>
          {folders.length > 0 && <optgroup label="Folders">{folders.map(folder => <option key={folder.id} value={`folder:${folder.id}`}>{folder.name}</option>)}</optgroup>}
          {projects.length > 0 && <optgroup label="Projects">{projects.map(project => <option key={project.id} value={`project:${project.id}`}>{project.name}</option>)}</optgroup>}
        </select></label>}
      </>}
    </div>
    {phase === 'error' && <div className="plugins-status plugins-status-error" role="alert">{error}<button type="button" className="tool-button" onClick={() => void reload()}>Retry</button></div>}
    <div className="plugins-body">
      <div className="plugins-main" hidden={!!detail}>
        {phase === 'loading' && tab !== 'mcp' && <ResourceState kind="loading" label="Loading marketplace" rows={4}/>}
        {phase === 'ready' && tab === 'discover' && (data.sources.length === 0
          ? <EmptyState icon={<Store size={26} />} title="No marketplace sources yet" text="Add a Git repository or a local folder that publishes a Claude or Codex marketplace index, or a folder of skills." action={<button type="button" className="plugins-primary" onClick={() => switchTab('sources')}><Plus size={13} />Add source</button>} />
          : catalog.length === 0 ? <EmptyState icon={<Search size={24} />} title={q || kind !== 'all' ? 'Nothing matches' : 'The sources list no packages'} text={q || kind !== 'all' ? 'Try another search or type.' : 'Sync a source or check that it has a marketplace.json or skills folder.'} />
          : <ul className="plugins-grid" role="list">{catalog.map(card => { const pkg = card.pkg; return <li key={pkg.id}><PackageCard card={card} busy={pending[pkg.id]} failed={!!failed[pkg.id]} onOpen={() => setSelection({ kind: 'package', id: pkg.id })} onInstall={() => setReviewing(pkg.id)} onManage={card.installedAs ? () => manage(card.installedAs!) : undefined} onUpdate={() => void run(pkg.id, 'Updating…', () => invoke('extensions.update', { id: pkg.name }), `${pkg.displayName} updated.`)} /></li>; })}</ul>)}
        {phase === 'ready' && tab === 'installed' && <div className="plugins-installed">
          <p className="plugins-scope-note">Toggles apply {scopeLabel}. Folder settings override project settings, which override user settings.</p>
          {installs.length > 0 && <InstalledGroup title="From marketplace">{installs.map(entry => <InstalledRow key={entry.id} name={entry.manifest?.displayName ?? entry.name} icon={<ItemTile icon={iconFor(icons, data.catalog.find(pkg => pkg.id === entry.packageId)?.icon, entry.name, entry.manifest?.displayName)} name={entry.manifest?.displayName ?? entry.name} seed={entry.name} shape={entry.kind === 'skill' ? 'skill' : 'square'} size={28} />} meta={`${entry.version} · ${entry.manifest?.source.label ?? entry.sourceId}`} badge={pending[entry.id] ?? (failed[entry.id] ? 'Failed' : entry.state)} tone={failed[entry.id] || entry.state === 'Failed' ? 'danger' : entry.state === 'Needs connection' ? 'warn' : entry.state === 'Ready' ? 'ok' : 'dim'} enabled={enabled(entry.id)} busy={!!pending[`enable:${entry.id}`]} onToggle={value => toggle(entry.id, value)} onOpen={() => setSelection({ kind: 'installed', id: entry.id })} />)}</InstalledGroup>}
          {(kind !== 'plugin') && <InstalledGroup title="Local skills" action={<button type="button" className="plugins-link" onClick={() => setSelection({ kind: 'editor', name: null })}><Plus size={12} />New skill</button>}>{localSkills.length ? localSkills.map(skill => { const id = skillExtensionId(skill), shadow = shadows.get(skill.id); return <InstalledRow key={skill.id} name={skill.displayName ?? skill.name} icon={<ItemTile icon={skill.icon} name={skill.displayName ?? skill.name} seed={skill.name} shape="skill" size={28} />} meta={qualifiedSkillName(skill)} badge={shadow ? `Shadowed by ${shadow}` : undefined} tone="dim" enabled={enabled(id)} busy={!!pending[`enable:${id}`]} onToggle={value => toggle(id, value)} onOpen={() => setSelection({ kind: 'skill', id: skill.id })} />; }) : <p className="plugins-group-empty">No local skills. Create one, or put folders with a SKILL.md in {LOCAL_SKILLS}.</p>}</InstalledGroup>}
          {codexPlugins.length > 0 && <InstalledGroup title="Codex plugins">{codexPlugins.map(plugin => { const id = pluginExtensionId(plugin); return <InstalledRow key={plugin.id} name={plugin.displayName ?? plugin.name} icon={<ItemTile icon={plugin.icon} name={plugin.displayName ?? plugin.name} seed={plugin.name} brandColor={plugin.brandColor} size={28} />} meta={`${plugin.version} · ${plugin.provenance}`} badge={plugin.readError ? 'Manifest warning' : undefined} tone={plugin.readError ? 'warn' : 'dim'} enabled={enabled(id)} busy={!!pending[`enable:${id}`]} scopeLocked={scopeKind !== 'user'} onToggle={value => toggle(id, value)} onOpen={() => setSelection({ kind: 'codex', id: plugin.id })} />; })}</InstalledGroup>}
          {!installs.length && !codexPlugins.length && kind === 'plugin' && <EmptyState icon={<Boxes size={24} />} title="No plugins installed" text="Install one from Discover." action={<button type="button" className="plugins-primary" onClick={() => switchTab('discover')}>Browse plugins</button>} />}
          {Object.entries(failed).filter(([key]) => key.startsWith('enable:')).map(([key, text]) => <p key={key} className="settings-error" role="alert">{text}</p>)}
        </div>}
        {tab === 'mcp' && <McpServers />}
        {phase === 'ready' && tab === 'sources' && <SourcesPanel sources={data.sources} pending={pending} failed={failed} onAdd={input => run('source:add', 'Adding…', () => invoke('extensions.sources.add', input), 'Source added.')} onSync={(id, latest) => void run(`sync:${id}`, latest ? 'Updating…' : 'Syncing…', () => invoke('extensions.sources.sync', { id, ...(latest ? { latest } : {}) }))} onRemove={id => void run(`sync:${id}`, 'Removing…', () => invoke('extensions.sources.remove', { id }), 'Source removed. Installed packages stay installed.')} />}
      </div>
      {detail && <div className="plugins-detail-panel"><button type="button" className="plugins-link plugins-detail-back" hidden={selection?.kind === 'editor'} onClick={() => setSelection(null)}><ArrowLeft size={13} />{tab === 'discover' ? 'Discover' : 'Installed'}</button>{detail}</div>}
    </div>
    {reviewing && <ReviewSheet packageId={reviewing} onClose={() => setReviewing(null)} onConfirm={async pkg => { setReviewing(null); await run(pkg.id, 'Staging…', () => invoke('extensions.install', { packageId: pkg.id }), `${pkg.displayName} installed.`); }} />}
    <ModalSheet open={!!removing} className="composer-access-dialog project-confirm" title={`Uninstall ${removing?.manifest?.displayName ?? removing?.name ?? ''}?`} description="Its files and every kept version are deleted. Runs already in progress keep the version they started with until they finish." onClose={() => setRemoving(null)}>
      <div><button type="button" onClick={() => setRemoving(null)}>Cancel</button><button type="button" className="is-danger" onClick={() => { const entry = removing!; setRemoving(null); setSelection(null); void run(entry.id, 'Removing…', () => invoke('extensions.uninstall', { id: entry.id }), `${entry.name} uninstalled.`); }}>Uninstall</button></div>
    </ModalSheet>
  </section>;
}

function EmptyState({ icon, title, text, action }: { icon: React.ReactNode; title: string; text: string; action?: React.ReactNode }): React.ReactElement {
  return <div className="plugins-empty">{icon}<strong>{title}</strong><p>{text}</p>{action}</div>;
}

/** One fixed-size tile for every icon, so text columns line up whether a row has a logo or a monogram. */
function ItemTile({ icon, name, seed, brandColor, shape = 'square', size }: { icon?: ItemIcon; name: string; seed?: string; brandColor?: string; shape?: 'square' | 'skill'; size: number }): React.ReactElement {
  const image = icon?.kind === 'image';
  return <span className={`plugins-tile${image ? ' is-image' : ''} is-${shape}`} style={{ width: size, height: size } as React.CSSProperties} aria-hidden="true">
    <PluginIcon icon={icon} name={name} seed={seed} brandColor={brandColor} shape={shape} size={image ? Math.round(size * 0.66) : size} />
  </span>;
}

function PackageCard({ card, busy, failed, onOpen, onInstall, onUpdate, onManage }: { card: CatalogCard; busy?: string; failed: boolean; onOpen(): void; onInstall(): void; onUpdate(): void; onManage?: () => void }): React.ReactElement {
  const pkg = card.pkg, installed = !!(pkg.installed || card.installedAs);
  const action = busy ? <span className="plugins-card-state">{busy}</span>
    : pkg.installed?.updateAvailable ? <button type="button" className="plugins-card-action" onClick={event => { event.stopPropagation(); onUpdate(); }} aria-label={`Update ${pkg.displayName}`}><RefreshCw size={12} />Update</button>
    : installed ? (onManage ? <button type="button" className="plugins-card-action is-manage" onClick={event => { event.stopPropagation(); onManage(); }} aria-label={`Manage ${pkg.displayName}`} title={card.installedAs?.kind === 'codex' ? 'Installed in Codex' : 'Installed'}>Manage</button> : <span className="plugins-card-state is-ok"><Check size={12} />Installed</span>)
    : !pkg.compatibility.supported ? <span className="plugins-card-state" title={pkg.compatibility.unsupported.join('\n')}>Unsupported</span>
    : <button type="button" className="plugins-card-action" onClick={event => { event.stopPropagation(); onInstall(); }} aria-label={`Install ${pkg.displayName}`}><Plus size={13} /></button>;
  const provenance = [pkg.publisher, card.sources.join(', ')].filter(Boolean).join(' · ');
  return <div className={`plugins-card${installed ? ' is-installed' : ''}`} role="button" tabIndex={0} aria-label={`${pkg.displayName}${installed ? ', installed' : ''}`} onClick={onOpen} onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onOpen(); } }}>
    <ItemTile icon={card.icon} name={pkg.displayName} seed={pkg.id} shape={pkg.kind === 'skill' ? 'skill' : 'square'} size={36} />
    <span className="plugins-card-text"><strong>{pkg.displayName}</strong><small>{pkg.description ?? (pkg.kind === 'skill' ? 'Skill' : 'Plugin')}</small><em>{installed && <span className="plugins-card-installed"><Check size={11} />Installed{card.installedAs?.kind === 'codex' ? ' in Codex' : ''}</span>}{installed && provenance ? ' · ' : ''}{provenance}{failed ? ' · install failed' : ''}</em></span>
    {action}
  </div>;
}

function Capabilities({ caps }: { caps: MarketplacePackage['capabilities'] }): React.ReactElement {
  return <>
    <Section icon={<BookOpen size={14} />} title="Skills" items={caps.skills.map(name => ({ key: name, label: name }))} empty="No skills." />
    <Section icon={<Server size={14} />} title="MCP servers" items={caps.mcpServers.map(server => ({ key: server.name, label: server.name, note: server.url ?? [server.command, ...(server.args ?? [])].filter(Boolean).join(' '), tag: server.transport }))} empty="No MCP servers." />
    {caps.apps.length > 0 && <Section icon={<AppWindow size={14} />} title="Apps" items={caps.apps.map(name => ({ key: name, label: name, tag: 'UI opens from the installed plugin' }))} empty="" />}
    {caps.hooks.length > 0 && <Section icon={<Webhook size={14} />} title="Hooks (review in MCP)" items={caps.hooks.map(hook => ({ key: hook, label: hook }))} empty="" />}
  </>;
}
function Section({ icon, title, items, empty }: { icon: React.ReactNode; title: string; items: Array<{ key: string; label: string; note?: string; tag?: string }>; empty: string }): React.ReactElement {
  return <section className="plugin-capability-section"><h3>{icon}{title} <span>{items.length}</span></h3>{items.length ? <ul>{items.map(item => <li key={item.key}><span className="plugin-capability-label">{item.label}{item.note && <code>{item.note}</code>}</span>{item.tag && <small>{item.tag}</small>}</li>)}</ul> : <p>{empty}</p>}</section>;
}
function Compatibility({ report }: { report: MarketplacePackage['compatibility'] }): React.ReactElement | null {
  if (!report.unsupported.length && !report.notes.length) return null;
  return <section className="plugin-compat"><h3><AlertTriangle size={13} />Compatibility · {report.format} format</h3><ul>{report.unsupported.map(item => <li key={item}>Not supported: {item}</li>)}{report.notes.map(item => <li key={item}>{item}</li>)}</ul></section>;
}
function Facts({ rows }: { rows: Array<[string, string | undefined]> }): React.ReactElement {
  return <dl className="plugin-facts">{rows.filter((row): row is [string, string] => !!row[1]).map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd>{value}</dd></React.Fragment>)}</dl>;
}

function PackageDetail({ pkg, icon, busy, error, onInstall, onUpdate, onManage }: { pkg: MarketplacePackage; icon?: ItemIcon; busy?: string; error?: string; onInstall(): void; onUpdate(): void; onManage?: () => void }): React.ReactElement {
  return <div className="plugin-detail">
    <div className="plugin-detail-hero"><PluginIcon icon={icon ?? pkg.icon} name={pkg.displayName} seed={pkg.id} shape={pkg.kind === 'skill' ? 'skill' : 'square'} size={48} />
      <div><h2 className="plugin-detail-name">{pkg.displayName}</h2><div className="plugin-detail-provenance">{[pkg.publisher, pkg.kind === 'skill' ? 'Skill' : 'Plugin', `${pkg.sourceLabel}:${pkg.name}`].filter(Boolean).join(' · ')}</div></div>
      {busy ? <span className="plugins-card-state">{busy}</span> : pkg.installed?.updateAvailable ? <button type="button" className="plugins-primary" onClick={onUpdate}><RefreshCw size={13} />Update to {pkg.version}</button> : pkg.installed ? <span className="plugins-card-state is-ok"><Check size={12} />Installed {pkg.installed.version}</span> : onManage ? <button type="button" className="plugins-secondary" onClick={onManage}><Check size={13} />Installed · Manage</button> : <button type="button" className="plugins-primary" disabled={!pkg.compatibility.supported} onClick={onInstall}><Download size={13} />Install</button>}
    </div>
    {error && <p className="settings-error" role="alert">Failed: {error}</p>}
    {pkg.description && <p className="plugin-detail-description">{pkg.description}</p>}
    <Facts rows={[['Version', pkg.version], ['Publisher', pkg.publisher], ['License', pkg.license], ['Category', pkg.category], ['Homepage', pkg.homepage], ['Format', pkg.compatibility.format]]} />
    <Capabilities caps={pkg.capabilities} />
    <Compatibility report={pkg.compatibility} />
  </div>;
}

function InstalledDetail({ entry, update, busy, error, onUpdate, onRollback, onRemove }: { entry: InstalledExtension; update?: MarketplacePackage; busy?: string; error?: string; onUpdate(): void; onRollback(): void; onRemove(): void }): React.ReactElement {
  const manifest = entry.manifest;
  return <div className="plugin-detail">
    <div className="plugin-detail-hero"><PluginIcon name={manifest?.displayName ?? entry.name} seed={entry.name} shape={entry.kind === 'skill' ? 'skill' : 'square'} size={48} />
      <div><h2 className="plugin-detail-name">{manifest?.displayName ?? entry.name}</h2><div className="plugin-detail-provenance">{entry.state} · {entry.version} · {manifest?.source.label ?? entry.sourceId}</div></div>
      <div className="plugin-detail-actions">{busy ? <span className="plugins-card-state">{busy}</span> : <>
        {update && <button type="button" className="plugins-primary" onClick={onUpdate}><RefreshCw size={13} />Update to {update.version}</button>}
        {entry.previous[0] && <button type="button" className="plugins-secondary" onClick={onRollback}><RotateCcw size={13} />Roll back to {entry.previous[0].version}</button>}
        <button type="button" className="plugins-secondary is-danger" onClick={onRemove}><Trash2 size={13} />Uninstall</button></>}</div>
    </div>
    {error && <p className="settings-error" role="alert">{error}</p>}
    {entry.state === 'Needs connection' && <p className="plugin-detail-notice-inline">Remote MCP servers, apps or environment variables below need a connection before their tools work.</p>}
    {manifest?.description && <p className="plugin-detail-description">{manifest.description}</p>}
    <Facts rows={[['Path', entry.path], ['Publisher', manifest?.publisher], ['License', manifest?.license], ['Commit', entry.commit?.slice(0, 12)], ['SHA-256', entry.sha256.slice(0, 16)], ['Installed', new Date(entry.installedAt).toLocaleString()]]} />
    {manifest && <><Capabilities caps={manifest.capabilities} /><Compatibility report={manifest.compatibility} /></>}
  </div>;
}

function InstalledGroup({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }): React.ReactElement {
  return <section className="plugins-group"><header><h3>{title}</h3>{action}</header><ul role="list">{children}</ul></section>;
}
function InstalledRow({ name, icon, meta, badge, tone, enabled, busy, scopeLocked, onToggle, onOpen }: { name: string; icon: React.ReactNode; meta: string; badge?: string; tone: 'ok' | 'warn' | 'danger' | 'dim'; enabled: boolean; busy: boolean; scopeLocked?: boolean; onToggle(value: boolean): void; onOpen(): void }): React.ReactElement {
  return <li className={`plugins-row${enabled ? '' : ' is-disabled'}`}>
    <button type="button" className="plugins-row-main" onClick={onOpen}>{icon}<span className="plugins-card-text"><strong>{name}</strong><em>{meta}</em></span>{badge && <span className={`plugins-badge is-${tone}`}>{badge}</span>}</button>
    <button type="button" role="switch" aria-checked={enabled} aria-label={`${enabled ? 'Disable' : 'Enable'} ${name}`} title={scopeLocked ? 'Codex cache plugins are enabled or disabled for the user scope only.' : undefined} className="plugins-switch" disabled={busy || scopeLocked} onClick={() => onToggle(!enabled)}><span /></button>
  </li>;
}

function SkillDetail({ skill, shadowedBy, onEdit }: { skill: SkillEntry; shadowedBy?: string; onEdit?: () => void }): React.ReactElement {
  return <div className="plugin-detail">
    <div className="plugin-detail-hero"><PluginIcon icon={skill.icon} name={skill.displayName ?? skill.name} seed={skill.name} shape="skill" size={48} />
      <div><h2 className="plugin-detail-name">{skill.displayName ?? skill.name}</h2><div className="plugin-detail-provenance">{qualifiedSkillName(skill)} · {skillTier(skill.provenance)}</div></div>
      {onEdit && <button type="button" className="plugins-secondary" onClick={onEdit}><Pencil size={13} />Edit</button>}
    </div>
    {shadowedBy && <p className="plugin-detail-notice-inline">Shadowed by {shadowedBy}: a folder skill beats a user skill, which beats an installed one with the same name.</p>}
    <div className="plugin-detail-path">{skill.path}</div>
    {skill.readError ? <div className="plugin-detail-read-error"><p>Could not read SKILL.md</p><code>{skill.readError}</code></div> : skill.readme ? <MessageBody text={skill.readme} /> : <p className="plugin-detail-empty">No SKILL.md found in this skill directory.</p>}
  </div>;
}

function PluginDetail({ plugin }: { plugin: PluginEntry }): React.ReactElement {
  return <div className="plugin-detail">
    <div className="plugin-detail-hero"><PluginIcon icon={plugin.icon} name={plugin.displayName ?? plugin.name} seed={plugin.name} brandColor={plugin.brandColor} size={48} />
      <div><h2 className="plugin-detail-name">{plugin.displayName ?? plugin.name}</h2><div className="plugin-detail-provenance">{plugin.provenance} · {plugin.version} · Codex plugin cache</div></div></div>
    {plugin.readError && <div className="plugin-detail-read-error" role="alert">Some plugin metadata could not be read: {plugin.readError}</div>}
    {plugin.shortDescription && <p className="plugin-detail-description">{plugin.shortDescription}</p>}
    <div className="plugin-detail-path">{plugin.path}</div>
    <Section icon={<BookOpen size={14} />} title="Skills" items={plugin.skills.map(name => ({ key: name, label: name }))} empty="No bundled skills." />
    <Section icon={<Server size={14} />} title="MCP servers" items={plugin.mcpServers.map(server => ({ key: server.name, label: server.name, tag: server.transport }))} empty="No MCP server manifest." />
    <Section icon={<AppWindow size={14} />} title="Apps" items={plugin.apps.map(app => ({ key: `${app.name}:${app.id}`, label: app.name, tag: `${app.category ?? (app.required ? 'required' : 'optional')} · ${app.ui ? 'has a UI' : 'connector, no UI'}` }))} empty="No app connector manifest." />
    {plugin.apps.some(app => app.ui) && <div className="plugin-ui-launchers">
      {/* EXT-10: a plugin's own UI opens in a sandboxed right-pane tab (isolated origin, no network, narrow message bridge). */}
      {plugin.apps.filter(app => app.ui).map(app => <button key={`${app.name}:ui`} type="button" className="plugins-secondary" onClick={() => { openPluginUiTab(plugin.id, app.name, `${plugin.displayName ?? plugin.name} · ${app.name}`); closeSettings(); }}><AppWindow size={13} />Open {app.name}</button>)}
    </div>}
  </div>;
}

function SourcesPanel({ sources, pending, failed, onAdd, onSync, onRemove }: { sources: ExtensionSource[]; pending: Record<string, string>; failed: Record<string, string>; onAdd(input: { kind: 'git' | 'local'; url?: string; path?: string; pinnedCommit?: string; label?: string }): Promise<boolean>; onSync(id: string, latest?: boolean): void; onRemove(id: string): void }): React.ReactElement {
  const [kind, setKind] = useState<'git' | 'local'>('git');
  const [location, setLocation] = useState('');
  const [commit, setCommit] = useState('');
  const [label, setLabel] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const adding = pending['source:add'];
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!location.trim() || adding) return;
    const ok = await onAdd({ kind, ...(kind === 'git' ? { url: location.trim(), ...(commit.trim() ? { pinnedCommit: commit.trim() } : {}) } : { path: location.trim() }), ...(label.trim() ? { label: label.trim() } : {}) });
    if (ok) { setLocation(''); setCommit(''); setLabel(''); }
  };
  return <div className="plugins-sources">
    <form className="plugins-source-form" onSubmit={event => void submit(event)} aria-label="Add source">
      <div className="plugins-segment" role="radiogroup" aria-label="Source type">{(['git', 'local'] as const).map(value => <button key={value} type="button" role="radio" aria-checked={kind === value} className={kind === value ? 'is-active' : ''} onClick={() => setKind(value)}>{value === 'git' ? <><FolderGit2 size={13} />Git</> : <><FolderOpen size={13} />Local folder</>}</button>)}</div>
      <input value={location} onChange={event => setLocation(event.target.value)} placeholder={kind === 'git' ? 'owner/repo or https://…/repo.git' : '/path/to/marketplace-or-skills'} aria-label={kind === 'git' ? 'Git URL' : 'Folder path'} spellCheck={false} />
      {kind === 'git' && <input className="is-short" value={commit} onChange={event => setCommit(event.target.value)} placeholder="Pin commit (optional)" aria-label="Pinned commit" spellCheck={false} />}
      <input className="is-short" value={label} onChange={event => setLabel(event.target.value)} placeholder="Label (optional)" aria-label="Label" />
      <button type="submit" className="plugins-primary" disabled={!location.trim() || !!adding}><Plus size={13} />{adding ?? 'Add source'}</button>
    </form>
    {failed['source:add'] && <p className="settings-error" role="alert">{failed['source:add']}</p>}
    <p className="plugins-scope-note">Muster ships no third-party sources. Git sources are cloned shallow at a pinned commit; nothing in them runs until you install and enable a package.</p>
    {sources.length === 0 ? <EmptyState icon={<GitBranch size={24} />} title="Add your first source" text="A source is a repository or folder with .claude-plugin/marketplace.json, a Codex plugin index, or skills/<name>/SKILL.md folders." />
      : <table className="plugins-source-table"><thead><tr><th>Source</th><th>Location</th><th>Pinned</th><th>Packages</th><th /></tr></thead><tbody>{sources.map(source => {
        const busy = pending[`sync:${source.id}`], problem = failed[`sync:${source.id}`] ?? source.error;
        const removeVerb = source.detected ? 'Hide' : 'Remove';
        return <tr key={source.id}>
          <td><span className="plugins-source-label">{source.kind === 'git' ? <FolderGit2 size={13} /> : <FolderOpen size={13} />}{source.label}{source.detected && <span className="plugins-badge is-dim" title={`Detected on this Mac from ${source.detected === 'codex' ? 'the Codex plugin cache' : 'a Claude marketplace checkout'}`}>Detected · {source.detected === 'codex' ? 'Codex' : 'Claude'}</span>}</span><code className="plugins-source-id">{source.id}</code></td>
          <td className="plugins-source-location" title={source.url ?? source.path}>{source.url ?? source.path}{problem && <span className="settings-error">{problem}</span>}</td>
          <td><code>{source.pinnedCommit?.slice(0, 10) ?? (source.kind === 'local' ? 'live' : '—')}</code></td>
          <td>{busy ?? source.packages ?? '—'}</td>
          <td className="plugins-source-actions">{confirm === source.id ? <><button type="button" className="plugins-link is-danger" onClick={() => { setConfirm(null); onRemove(source.id); }}>{removeVerb}</button><button type="button" className="plugins-link" onClick={() => setConfirm(null)}>Keep</button></> : <>
            <Tip label="Sync at pin"><button type="button" className="tool-button" disabled={!!busy} aria-label={`Sync ${source.label}`} onClick={() => onSync(source.id)}><RefreshCw size={13} className={busy ? 'spinning' : ''} /></button></Tip>
            {source.kind === 'git' && <button type="button" className="plugins-link" disabled={!!busy} title="Fetch the remote HEAD and pin it" onClick={() => onSync(source.id, true)}>Check for updates</button>}
            <Tip label={source.detected ? 'Hide this detected source; it will not reappear on its own' : undefined}><button type="button" className="tool-button" disabled={!!busy} aria-label={`${removeVerb} ${source.label}`} onClick={() => setConfirm(source.id)}><Trash2 size={13} /></button></Tip></>}</td>
        </tr>; })}</tbody></table>}
  </div>;
}

function ReviewSheet({ packageId, onClose, onConfirm }: { packageId: string; onClose(): void; onConfirm(pkg: MarketplacePackage): Promise<void> }): React.ReactElement {
  const [review, setReview] = useState<InstallReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let live = true; invoke('extensions.review', { packageId }).then(value => { if (live) setReview(value); }, cause => { if (live) setError(message(cause)); }); return () => { live = false; }; }, [packageId]);
  const pkg = review?.package;
  const blocked = !review || review.errors.length > 0;
  return <ModalSheet open className="composer-access-dialog plugins-review" title={pkg ? `Install ${pkg.displayName}?` : 'Reviewing package…'} description={pkg ? `${pkg.version}${pkg.publisher ? ` · ${pkg.publisher}` : ''} · ${pkg.sourceLabel}${review ? ` · ${review.files} files, ${bytes(review.bytes)}` : ''}` : undefined} onClose={onClose}>
    {!review && !error && <p className="plugins-status" role="status">Validating the manifest and files…</p>}
    {error && <p className="settings-error" role="alert">{error}</p>}
    {review && <div className="plugins-review-body">
      <p>Installing only copies files. Nothing runs until the package is enabled for a chat, and hooks run only after you review and enable each one under MCP.</p>
      {review.permissions.mcp.length > 0 && <><h3><Server size={13} />MCP servers it will start when enabled</h3><ul>{review.permissions.mcp.map(server => <li key={server.name}><Plug size={12} /><strong>{server.name}</strong><code>{server.detail || 'no command'}</code></li>)}</ul></>}
      {review.permissions.apps.length > 0 && <><h3><AppWindow size={13} />Apps that need a connection</h3><ul>{review.permissions.apps.map(app => <li key={app}>{app}</li>)}</ul></>}
      {review.permissions.hooks.length > 0 && <><h3><Webhook size={13} />Hooks (off until enabled under MCP)</h3><ul>{review.permissions.hooks.map(hook => <li key={hook}><code>{hook}</code></li>)}</ul></>}
      {!review.permissions.mcp.length && !review.permissions.apps.length && !review.permissions.hooks.length && <p>It asks for no servers, apps or hooks{pkg?.capabilities.skills.length ? `; it adds ${plural(pkg.capabilities.skills.length, 'skill')}` : ''}.</p>}
      {review.errors.map(item => <p key={item} className="settings-error">{item}</p>)}
      {pkg && <Compatibility report={pkg.compatibility} />}
    </div>}
    <div><button type="button" onClick={onClose}>Cancel</button><button type="button" disabled={blocked} onClick={() => pkg && void onConfirm(pkg)}>Install</button></div>
  </ModalSheet>;
}
