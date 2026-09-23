import {AppWindow,Archive,ArchiveRestore,AtSign,Boxes,BookmarkPlus,CircleDot,Folder,FolderKanban,Goal,Lightbulb,ListOrdered,Monitor,Paperclip,PenLine,Server,Sparkles,SquarePen,SquareTerminal} from 'lucide-react';
import React, { useEffect, useRef } from 'react';
import type {FileEntry,PluginEntry,SkillEntry} from '../../shared/protocol';
import {MAX_ATTACHED_SKILL_BYTES} from '../../shared/protocol';
import {previewLimit,rankSections,scoreItem,scoreQueryMatch} from './composerMenus';
import {fileVisual} from './fileVisual';
import {PluginIcon} from './PluginIcon';
import { plural } from '../../shared/wording.ts';

/** One row of the +, / and @ popovers (Codex layout: icon, label, inline muted description, badge). */
export interface MenuRow { key: string; section: string; label: string; description?: string; icon: React.ReactNode; badge?: string; mono?: boolean; disabled?: boolean; checked?: boolean; score: number; run(): void }

export const nextRow = (rows: MenuRow[], from: number, direction: 1 | -1): number => {
  for (let step = 1; step <= rows.length; step++) {
    const index = (from + direction * step + rows.length * 2) % rows.length;
    if (!rows[index].disabled) return index;
  }
  return -1;
};
export const firstRow = (rows: MenuRow[]): number => rows.findIndex(row => !row.disabled);

/** Section headers and rows; the highlight follows the mouse and the keyboard alike. */
export function ComposerMenuList({ id, label, rows, active, empty, note, onActive }: { id: string; label: string; rows: MenuRow[]; active: number; empty?: string; note?: string; onActive(index: number): void }): React.ReactElement {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' }); }, [active]);
  let section = '';
  return <div ref={list} id={id} className="composer-menu-list" role="listbox" aria-label={label}>
    {rows.map((row, index) => {
      const heading = row.section !== section ? (section = row.section) : '';
      return <React.Fragment key={row.key}>
        {heading && <div className="composer-menu-section" role="presentation">{heading}</div>}
        <button type="button" id={`${id}-${index}`} data-index={index} data-testid="composer-row" role="option" className="composer-row" aria-selected={index === active} aria-checked={row.checked} disabled={row.disabled}
          title={row.description} tabIndex={-1} onMouseDown={event => event.preventDefault()} onMouseMove={() => { if (index !== active) onActive(index); }} onClick={() => row.run()}>
          <span className="composer-row-icon">{row.icon}</span>
          <span className={`composer-row-label${row.mono ? ' is-mono' : ''}`}>{row.label}</span>
          {row.description && <span className="composer-row-description">{row.description}</span>}
          {row.badge && <span className="composer-row-badge">{row.badge}</span>}
        </button>
      </React.Fragment>;
    })}
    {!rows.length && empty && <p className="composer-menu-note">{empty}</p>}
    {note && <p className="composer-menu-note">{note}</p>}
  </div>;
}

/* Shared row builders --------------------------------------------------------
 * The single source of truth for what a "+", "/" or "@" popover offers: an in-chat Composer and the
 * new-chat draft both call these, so the two can never drift back out of parity with each other. */
export const MENU_LIMIT = 8;
const PLUGIN_PREVIEW_LIMIT = 6;

export const skillUsable = (skill: SkillEntry): boolean => !skill.readError && Boolean(skill.readme?.trim()) && new TextEncoder().encode(skill.readme ?? '').byteLength <= MAX_ATTACHED_SKILL_BYTES;
export const pluginLabel = (plugin: PluginEntry): string => plugin.displayName ?? plugin.name;
export const baseFileName = (path: string): string => path.replace(/\/+$/, '').split('/').pop() || path;
export const skillScore = (skill: SkillEntry, query: string): number | null => {
  const a = scoreItem(skill.displayName ?? skill.name, skill.shortDescription, query), b = scoreQueryMatch(skill.name, query);
  return a === null ? b : b === null ? a : Math.min(a, b);
};
export const skillBadge = (skill: SkillEntry): string => skill.pluginId ? 'Plugin' : skill.provenance.startsWith('.agents') ? 'Repo' : skill.name.startsWith('.') ? 'System' : 'Personal';
export function skillRow(skill: SkillEntry, score: number, run: () => void): MenuRow {
  const usable = skillUsable(skill);
  return { key: `skill:${skill.id}`, section: 'Skills', label: skill.displayName ?? skill.name, description: usable ? skill.shortDescription ?? skill.provenance : skill.readError ?? 'Empty or over the 48 KB skill limit',
    icon: skill.icon ? <PluginIcon icon={skill.icon} name={skill.displayName ?? skill.name} shape="skill" /> : <Sparkles size={15} className="is-skill" />, badge: skillBadge(skill), disabled: !usable, score, run };
}
export function pluginRow(plugin: PluginEntry, score: number, run: () => void): MenuRow {
  return { key: `plugin:${plugin.id}`, section: 'Plugins', label: pluginLabel(plugin), description: plugin.shortDescription ?? plugin.provenance,
    icon: <PluginIcon icon={plugin.icon} name={pluginLabel(plugin)} seed={plugin.name} brandColor={plugin.brandColor} />, badge: plugin.skills.length ? `${plural(plugin.skills.length, 'skill')}` : plugin.mcpServers.length ? 'MCP' : 'Plugin', score, run };
}

/** `/`: usable skills, ranked in with the caller's own Commands rows (never plugins — those belong to @ and +). */
export function buildSlashRows(query: string, skills: readonly SkillEntry[], onSkill: (skill: SkillEntry) => void, commandRows: MenuRow[]): MenuRow[] {
  const rows = skills.filter(skillUsable).flatMap(skill => { const score = skillScore(skill, query); return score === null ? [] : [skillRow(skill, score, () => onSkill(skill))]; }).slice(0, 30);
  return rankSections([{ title: 'Skills', rows }, { title: 'Commands', rows: commandRows }]).flatMap(section => section.rows.map(row => ({ ...row, section: section.title })));
}

/** `@`: files, folders and plugins (plus any caller-supplied extra sections, e.g. Recent chats or Tools). */
export function buildMentionRows(input: { query: string; files: readonly FileEntry[]; plugins: readonly PluginEntry[]; onFile(entry: FileEntry): void; onPlugin(plugin: PluginEntry): void; extra?: { title: string; rows: MenuRow[] }[] }): MenuRow[] {
  const { query: q, files, plugins, onFile, onPlugin, extra = [] } = input;
  const entryRow = (entry: FileEntry): MenuRow => {
    const { Icon, hue } = entry.kind === 'directory' ? { Icon: Folder, hue: 38 } : fileVisual(entry.name);
    const parent = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
    return { key: `${entry.kind}:${entry.path}`, section: entry.kind === 'file' ? 'Files' : 'Folders', label: entry.name || entry.path, description: parent || undefined,
      icon: <Icon size={15} className="is-hued" style={hue === null ? undefined : { '--h': hue } as React.CSSProperties} />, score: q ? scoreItem(entry.name, entry.path, q) ?? 50 : 0, run: () => onFile(entry) };
  };
  const fileRows = files.filter(entry => entry.kind === 'file').map(entryRow).slice(0, q ? MENU_LIMIT : 6);
  const folderRows = files.filter(entry => entry.kind === 'directory').map(entryRow).slice(0, q ? MENU_LIMIT : 6);
  const pluginRows = plugins.flatMap(plugin => { const score = q ? scoreItem(pluginLabel(plugin), plugin.shortDescription, q) ?? scoreQueryMatch(plugin.name, q) : 0; return score === null ? [] : [pluginRow(plugin, score, () => onPlugin(plugin))]; }).slice(0, q ? MENU_LIMIT : 6);
  return rankSections([{ title: 'Files', rows: fileRows }, { title: 'Folders', rows: folderRows }, { title: 'Plugins', rows: pluginRows }, ...extra])
    .flatMap(section => section.rows.map(row => ({ ...row, section: section.title }))).slice(0, 30);
}

/** `+`: every row an in-chat Composer offers, several of them optional (the draft's new-chat screen has no
 *  chat yet, so it omits whichever capability truly needs one — e.g. `onSaveSkill` — by leaving its
 *  callback out, rather than keeping a second, drifting copy of this list). */
export interface AddRowInput<T extends { key: string; label: string } = { key: string; label: string }> {
  query: string;
  onFiles(): void;
  onCapture?(): void; captureDisabled?: boolean;
  terminals?: readonly T[]; onAttachTerminal?(source: T): void; terminalDisabled?: boolean;
  onProject?(): void; projectDisabled?: boolean;
  goalDescription: string; goalDisabled?: boolean; onGoal(): void;
  planMode: boolean; planDisabled?: boolean; onPlan(): void;
  onRecordSkill?(): void; recordDisabled?: boolean;
  onSaveSkill?(): void; saveSkillDisabled?: boolean;
  onSketch(): void; sketchDisabled?: boolean;
  onMention?(): void;
  backgroundDescription?: string; backgroundDisabled?: boolean; onBackground?(): void;
  /** CMP-19: save the draft as a named stash without sending, and open the Stashes list. */
  onStash?(): void; stashDisabled?: boolean; onStashes?(): void;
  plugins: readonly PluginEntry[]; onPlugin(plugin: PluginEntry): void; onBrowsePlugins?(): void;
  skills: readonly SkillEntry[]; onSkill(skill: SkillEntry): void;
  /** CS-B1-7 "Connectors & MCP": MCP servers (Server, transport) and plugin apps (AppWindow); a pick inserts an @mcp:/@app: chip. */
  connectors?: readonly ConnectorEntry[]; onConnector?(connector: ConnectorEntry): void;
  /** CR-15: Codex's "Turn on queueing" / "Turn off queueing" (the Follow-up behavior setting, from the composer). */
  queueing?: boolean; onQueueing?(): void;
}
export interface ConnectorEntry { key: string; kind: 'mcp' | 'app'; name: string; description: string }
/** The + menu's connector rows: user/detected MCP servers, then servers and apps plugins bring (deduplicated by name). */
export function connectorEntries(servers: readonly { id: string; name: string; transport: string; enabled: boolean }[], plugins: readonly PluginEntry[]): ConnectorEntry[] {
  const seen = new Set<string>(), out: ConnectorEntry[] = [];
  const add = (entry: ConnectorEntry) => { const id = `${entry.kind}:${entry.name.toLowerCase()}`; if (seen.has(id)) return; seen.add(id); out.push(entry); };
  for (const server of servers) if (server.enabled) add({ key: `mcp:${server.id}`, kind: 'mcp', name: server.name, description: server.transport === 'http' ? 'Streamable HTTP' : server.transport === 'stdio' ? 'stdio' : server.transport });
  for (const plugin of plugins) {
    for (const server of plugin.mcpServers) add({ key: `mcp:${plugin.id}:${server.name}`, kind: 'mcp', name: server.name, description: `${server.transport} · ${pluginLabel(plugin)}` });
    for (const app of plugin.apps) add({ key: `app:${plugin.id}:${app.id}`, kind: 'app', name: app.name, description: app.category ? `${app.category} · ${pluginLabel(plugin)}` : pluginLabel(plugin) });
  }
  return out;
}
export function buildAddRows<T extends { key: string; label: string }>(input: AddRowInput<T>): MenuRow[] {
  const q = input.query;
  const keep = (row: MenuRow): MenuRow[] => { const score = scoreItem(row.label, row.description, q); return score === null ? [] : [{ ...row, score }]; };
  const add: MenuRow[] = [
    { key: 'files', section: 'Add', label: 'Files and folders', icon: <Paperclip size={15} />, score: 0, run: input.onFiles },
    ...(input.onCapture ? [{ key: 'capture', section: 'Add', label: 'Capture window', description: 'Attach a screenshot of a window or screen', icon: <Monitor size={15} />, disabled: input.captureDisabled, score: 0, run: input.onCapture } satisfies MenuRow] : []),
    ...(input.onAttachTerminal ? (input.terminals ?? []).slice(0, 3).map(source => ({ key: `terminal:${source.key}`, section: 'Add', label: 'Attach terminal', description: source.label || 'Last 200 lines',
      icon: <span className="composer-terminal-tile"><SquareTerminal size={11} /></span>, disabled: input.terminalDisabled, score: 0, run: () => input.onAttachTerminal!(source) })) : []),
    ...(input.onProject ? [{ key: 'project', section: 'Add', label: 'Work in a project', description: 'Choose project for new chats', icon: <FolderKanban size={15} />, disabled: input.projectDisabled, score: 0, run: input.onProject } satisfies MenuRow] : []),
    { key: 'goal', section: 'Add', label: 'Goal', description: input.goalDescription, disabled: input.goalDisabled, icon: <Goal size={15} />, score: 0, run: input.onGoal },
    { key: 'plan', section: 'Add', label: 'Plan mode', description: input.planMode ? 'Turn plan mode off' : 'Turn plan mode on', checked: input.planMode, disabled: input.planDisabled, icon: <Lightbulb size={15} />, score: 0, run: input.onPlan },
    ...(input.onRecordSkill ? [{ key: 'record', section: 'Add', label: 'Record a skill', description: 'Record a workflow and turn it into a skill', icon: <CircleDot size={15} className="composer-record-icon" />, disabled: input.recordDisabled, score: 0, run: input.onRecordSkill } satisfies MenuRow] : []),
    ...(input.onSaveSkill ? [{ key: 'save-skill', section: 'Add', label: 'Save as skill', description: 'Save this chat’s approach as a skill', icon: <BookmarkPlus size={15} />, disabled: input.saveSkillDisabled, score: 0, run: input.onSaveSkill } satisfies MenuRow] : []),
    { key: 'sketch', section: 'Add', label: 'Sketch', description: 'Draw a sketch', disabled: input.sketchDisabled, icon: <PenLine size={15} />, score: 0, run: input.onSketch },
    ...(input.onMention ? [{ key: 'mention', section: 'Add', label: 'Mention file or chat…', description: 'Type @ in the composer', icon: <AtSign size={15} />, score: 0, run: input.onMention } satisfies MenuRow] : []),
    ...(input.onBackground ? [{ key: 'background', section: 'Add', label: 'Start in background', description: input.backgroundDescription, icon: <SquarePen size={15} />, disabled: input.backgroundDisabled, score: 0, run: input.onBackground } satisfies MenuRow] : []),
    ...(input.onStash ? [{ key: 'stash', section: 'Add', label: 'Stash prompt', description: 'Save this draft for later without sending · ⌘⇧S', icon: <Archive size={15} />, disabled: input.stashDisabled, score: 0, run: input.onStash } satisfies MenuRow] : []),
    ...(input.onStashes ? [{ key: 'stashes', section: 'Add', label: 'Stashes', description: 'Restore, rename or delete stashed prompts', icon: <ArchiveRestore size={15} />, score: 0, run: input.onStashes } satisfies MenuRow] : []),
    ...(input.onQueueing ? [{ key: 'queueing', section: 'Add', label: input.queueing ? 'Turn off queueing' : 'Turn on queueing', description: input.queueing ? 'Follow-ups will steer the running agent' : 'Follow-ups will wait for this turn to finish', icon: <ListOrdered size={15} />, checked: input.queueing, score: 0, run: input.onQueueing } satisfies MenuRow] : []),
  ];
  const pluginMatches = input.plugins.map(plugin => pluginRow(plugin, 0, () => input.onPlugin(plugin))).flatMap(keep);
  // Browsing (no search text yet): a short, relevant set instead of every installed plugin — MRU-first
  // (the caller sorts `plugins` that way), alphabetical fill after; "Browse plugins" reaches the rest.
  const { shown: pluginPreview, more: hiddenPlugins } = previewLimit(pluginMatches, PLUGIN_PREVIEW_LIMIT, !q.trim());
  const pluginSection: MenuRow[] = q.trim() ? pluginMatches.slice(0, MENU_LIMIT)
    : [...pluginPreview, ...(hiddenPlugins && input.onBrowsePlugins ? [{
        key: 'browse-plugins', section: 'Plugins', label: 'Browse plugins', description: `${pluginMatches.length} installed`,
        icon: <Boxes size={15} />, score: 0, run: input.onBrowsePlugins,
      } satisfies MenuRow] : [])];
  return [
    ...add.flatMap(keep),
    ...pluginSection,
    ...(input.onConnector ? (input.connectors ?? []).map(connector => ({ key: `connector:${connector.key}`, section: 'Connectors & MCP', label: connector.name, description: connector.description,
      icon: connector.kind === 'mcp' ? <Server size={15} className="is-hued" style={{ '--h': 190 } as React.CSSProperties} /> : <AppWindow size={15} className="is-hued" style={{ '--h': 28 } as React.CSSProperties} />,
      badge: connector.kind === 'mcp' ? 'MCP' : 'App', score: 0, run: () => input.onConnector!(connector) } satisfies MenuRow)).flatMap(keep).slice(0, MENU_LIMIT) : []),
    ...input.skills.filter(skillUsable).map(skill => skillRow(skill, 0, () => input.onSkill(skill))).flatMap(keep).slice(0, MENU_LIMIT),
  ];
}
