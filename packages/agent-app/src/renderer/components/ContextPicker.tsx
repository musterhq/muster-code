import { BookOpen, Check, FileText, Folder, Globe, ImagePlus, MessageSquareText, Plus, Search } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { MAX_ATTACHED_SKILL_BYTES, type Commands } from '../../shared/protocol';
import { invoke } from '../bridge';
import { useStore } from '../useStore';
import { menuIndex } from './composerMenus';

export type ContextKind = 'upload' | 'file' | 'folder' | 'skill' | 'browser' | 'new-browser' | 'chat';
export interface ContextItem { key: string; kind: ContextKind; section: string; label: string; detail?: string; value?: string; folderId?: string; disabled?: boolean; selected?: boolean }
type Entry = Commands['files.search']['output']['entries'][number];

const ICONS = { upload: ImagePlus, file: FileText, folder: Folder, skill: BookOpen, browser: Globe, 'new-browser': Plus, chat: MessageSquareText };
const RECENT_CHATS = 6;

/** Debounced workspace search; a result for an older query or folder is never shown. */
export function useWorkspaceSearch(folderId: string | undefined, query: string, enabled: boolean): { entries: Entry[] | null; loading: boolean; error: string } {
  const [result, setResult] = useState<{ key: string; entries: Entry[] } | null>(null);
  const [error, setError] = useState('');
  const term = query.trim();
  const key = `${folderId}\u0000${term}`;
  useEffect(() => {
    setError('');
    if (!enabled || !folderId || !term) return;
    let live = true;
    const timer = window.setTimeout(() => {
      void invoke('files.search', { folderId, path: '', query: term })
        .then(value => { if (live) setResult({ key, entries: Array.isArray(value?.entries) ? value.entries : [] }); })
        .catch(cause => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); });
    }, 180);
    return () => { live = false; window.clearTimeout(timer); };
  }, [folderId, term, enabled]);
  const entries = enabled && term && result?.key === key ? result.entries : null;
  return { entries, loading: Boolean(enabled && folderId && term && !entries && !error), error: enabled && term ? error : '' };
}

export interface ContextSources { chatId: string; folderId?: string; mode: 'plus' | 'mention'; selectedSkillId?: string }

/** One flat, sectioned list: the + picker and the @ popover share it so results and icons agree. */
export function useContextItems({ chatId, folderId, mode, selectedSkillId }: ContextSources, query: string, enabled: boolean): { items: ContextItem[]; loading: boolean; error: string; searching: boolean } {
  const state = useStore();
  const search = useWorkspaceSearch(folderId, query, enabled);
  const needle = query.trim().toLowerCase();
  const matches = (...values: (string | undefined)[]) => !needle || values.some(value => value?.toLowerCase().includes(needle));
  const items: ContextItem[] = [];
  if (!enabled) return { items, loading: false, error: '', searching: false };
  const chat = state.snapshot?.chats.find(entry => entry.id === chatId);
  const project = state.snapshot?.projects.find(entry => entry.id === chat?.projectId);
  const folderIds = project?.folderIds ?? (chat?.folderId ? [chat.folderId] : []);
  if (mode === 'plus' && matches('Add photos & files', 'upload image attach screenshot')) items.push({ key: 'upload', kind: 'upload', section: 'Attach', label: 'Add photos & files', detail: 'Images, documents or code, up to 20 MB each' });
  for (const folder of state.snapshot?.folders ?? []) {
    if (folderIds.includes(folder.id) && matches(folder.name, folder.path)) items.push({ key: `workspace:${folder.id}`, kind: 'folder', section: 'Files and folders', label: folder.name, detail: folder.path, value: folder.path });
  }
  for (const entry of search.entries ?? []) items.push({ key: `entry:${folderId}:${entry.path}`, kind: entry.kind === 'directory' ? 'folder' : 'file', section: 'Files and folders', label: entry.name || entry.path, detail: entry.path, value: entry.path, folderId });
  if (mode === 'plus') {
    for (const skill of state.skills.value ?? []) {
      if (!matches(skill.name, skill.provenance)) continue;
      const usable = !skill.readError && Boolean(skill.readme?.trim()) && new TextEncoder().encode(skill.readme ?? '').byteLength <= MAX_ATTACHED_SKILL_BYTES;
      items.push({ key: `skill:${skill.id}`, kind: 'skill', section: 'Skills', label: skill.name, detail: usable ? skill.provenance : skill.readError ?? 'Empty or over the 48 KB skill limit', value: skill.id, disabled: !usable, selected: skill.id === selectedSkillId });
    }
    for (const tab of state.tabs) {
      if (tab.kind !== 'browser' || !tab.url || tab.url === 'about:blank' || !matches(tab.title, tab.url)) continue;
      items.push({ key: `browser:${tab.id}`, kind: 'browser', section: 'Browser', label: tab.url.replace(/^https?:\/\//, ''), detail: 'Reference this page', value: tab.url });
    }
    if (matches('New browser tab', 'web browse')) items.push({ key: 'new-browser', kind: 'new-browser', section: 'Browser', label: 'New browser tab', detail: 'Open the Personal browser' });
  }
  const chats = (state.snapshot?.chats ?? []).filter(entry => entry.id !== chatId && !entry.archived && matches(entry.title))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, RECENT_CHATS);
  for (const entry of chats) items.push({ key: `chat:${entry.id}`, kind: 'chat', section: 'Recent chats', label: entry.title || 'Untitled chat', detail: 'Reference this chat', value: `chat:${entry.title || entry.id}` });
  return { items, loading: search.loading, error: search.error, searching: Boolean(needle && folderId) };
}

export function ContextList({ id, label, items, active, loading, error, empty, onActive, onPick }: { id: string; label: string; items: ContextItem[]; active: number; loading: boolean; error: string; empty: string; onActive: (index: number) => void; onPick: (item: ContextItem) => void }): React.ReactElement {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' }); }, [active]);
  let section = '';
  return <div ref={list} id={id} className="context-list" role="listbox" aria-label={label}>
    {items.map((item, index) => {
      const Icon = ICONS[item.kind];
      const heading = item.section !== section ? (section = item.section) : '';
      return <React.Fragment key={item.key}>
        {heading && <div className="context-section" role="presentation">{heading}</div>}
        <button type="button" id={`${id}-${index}`} data-index={index} role="option" className={`context-item is-${item.kind}`} aria-selected={index === active} disabled={item.disabled} title={item.detail}
          onMouseDown={event => event.preventDefault()} onMouseEnter={() => onActive(index)} onClick={() => onPick(item)}>
          <Icon size={14} aria-hidden="true" /><span><strong>{item.label}</strong>{item.detail && <small>{item.detail}</small>}</span>{item.selected && <Check size={13} aria-label="Selected" />}
        </button>
      </React.Fragment>;
    })}
    {error ? <p className="context-note is-error" role="alert">{error}</p>
      : loading ? <p className="context-note" role="status">Searching…</p>
        : !items.length ? <p className="context-note">{empty}</p> : null}
  </div>;
}

export const nextEnabled = (items: ContextItem[], from: number, direction: 'next' | 'previous'): number => {
  for (let step = 0, index = from; step < items.length; step++) {
    index = menuIndex(index, items.length, direction);
    if (!items[index].disabled) return index;
  }
  return -1;
};

/** The + menu: a single searchable context picker. Navigation screens live elsewhere. */
export function ContextPicker({ sources, folders, onFolder, onPick, onClose }: { sources: ContextSources; folders: { id: string; name: string }[]; onFolder: (id: string) => void; onPick: (item: ContextItem) => void; onClose: () => void }): React.ReactElement {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const { items, loading, error, searching } = useContextItems(sources, query, true);
  const current = items[active]?.disabled ? nextEnabled(items, active, 'next') : Math.min(active, items.length - 1);
  useEffect(() => setActive(0), [query]);
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const next = nextEnabled(items, current, event.key === 'ArrowDown' ? 'next' : 'previous'); if (next >= 0) setActive(next); }
    else if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey && items.length && query)) { const item = items[current]; if (item && !item.disabled) { event.preventDefault(); onPick(item); } }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
  };
  return <div className="composer-menu-popover context-picker" role="dialog" aria-label="Add context">
    <label className="context-search"><Search size={13} aria-hidden="true" />
      <input autoFocus type="search" aria-label="Search context" placeholder="Search files, skills, chats…" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={onKeyDown}
        role="combobox" aria-expanded="true" aria-controls="context-picker-options" aria-activedescendant={current >= 0 && items.length ? `context-picker-options-${current}` : undefined} />
    </label>
    {folders.length > 1 && <label className="context-folder">Search in<select aria-label="Reference workspace folder" value={sources.folderId} onChange={event => onFolder(event.target.value)}>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>}
    <ContextList id="context-picker-options" label="Context" items={items} active={current} loading={loading} error={error}
      empty={searching ? 'No matching files, skills or chats.' : sources.folderId ? 'Nothing to add yet.' : 'Open a workspace folder to reference files.'} onActive={setActive} onPick={onPick} />
    {!query.trim() && sources.folderId && <p className="context-note">Type to search files and folders in this workspace.</p>}
  </div>;
}
