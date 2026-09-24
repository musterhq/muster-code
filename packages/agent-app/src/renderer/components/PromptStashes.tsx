/**
 * CMP-19 prompt stash: save the composer draft (text, @/skill/plugin chips, context chips, attachments,
 * effort) under a name without sending, and bring it back later. Stashes live runtime-side
 * (`stashes.*`); the runtime copies attachment bytes so a stash outlives the composer's staged files.
 */
import { Archive, Check, Pencil, Search, Trash2, Undo2, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { AttachmentRef, ReasoningEffort } from '../../shared/protocol';
import type { PromptStash } from '../../shared/domains/stashes-protocol';
import { getBridge, BridgeError } from '../bridge';
import { discardAttachment, previewAttachment, runtimeMessage } from '../composerBridge';
import type { ContextChip } from '../composerContext';
import type { ComposerAttachment } from './AttachmentStrip';
import type { ComposerChip } from './composerMenus';
import { plural } from '../../shared/wording.ts';
import {Tip} from './Tooltip';

/** ⌘K "Stashes" (or any surface) asks the focused composer to open its stash list. */
export const OPEN_STASHES_EVENT = 'muster:composer-open-stashes';
export function openStashes(): void { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(OPEN_STASHES_EVENT)); }

async function call<T>(command: string, input?: unknown): Promise<T> {
  const bridge = getBridge();
  if (!bridge) throw new BridgeError(command, 'Agent runtime is not connected');
  try { return await (bridge.invoke as unknown as (c: string, i: unknown) => Promise<T>)(command, input); }
  catch (cause) { throw new BridgeError(command, cause); }
}
export const listStashes = async () => (await call<{ stashes?: PromptStash[] }>('stashes.list')).stashes ?? [];
export const saveStash = (input: { name?: string; text: string; chatId?: string; chips?: unknown[]; context?: unknown[]; effort?: ReasoningEffort; attachmentIds?: string[] }) => call<PromptStash>('stashes.save', input);
export const renameStash = (id: string, name: string) => call<PromptStash>('stashes.rename', { id, name });
export const deleteStash = (id: string) => call<void>('stashes.delete', { id });
export const restoreStash = (id: string, chatId: string) => call<{ stash: PromptStash; attachments: AttachmentRef[] }>('stashes.restore', { id, chatId });

/** Restored text joins what is already typed instead of replacing it. */
export function mergeStashText(current: string, stashed: string): string {
  if (!current.trim()) return stashed;
  if (!stashed) return current;
  return `${current.replace(/\s+$/, '')}\n\n${stashed}`;
}
/** Chips are matched by token, context chips by id; the draft's own entries win. */
export function mergeById<T>(current: readonly T[], incoming: readonly unknown[], key: (item: T) => string): T[] {
  const seen = new Set(current.map(key));
  return [...current, ...(incoming as T[]).filter(item => item && typeof item === 'object' && !seen.has(key(item)))];
}

interface StashDeps {
  chatId: string; text: string; chips: ComposerChip[]; context: ContextChip[];
  attachments: ComposerAttachment[]; effort?: ReasoningEffort; disabled?: boolean;
  setText(value: string): void;
  setChips(update: (current: ComposerChip[]) => ComposerChip[]): void;
  setContext(update: (current: ContextChip[]) => ContextChip[]): void;
  setAttachments(update: (current: ComposerAttachment[]) => ComposerAttachment[]): void;
  chooseEffort(value: ReasoningEffort): void;
  flash(message: string): void;
  notifyError(message: string): void;
}

/** Stash/restore actions plus the popover state; the composer wires them to its + menu, ⌘⇧S and ⌘K. */
export function usePromptStash(deps: StashDeps) {
  const [open, setOpen] = useState(false);
  const pending = useRef(false);
  const latest = useRef(deps); latest.current = deps;
  useEffect(() => {
    const onOpen = () => { if (!latest.current.disabled) setOpen(true); };
    window.addEventListener(OPEN_STASHES_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_STASHES_EVENT, onOpen);
  }, []);

  const stash = async (name?: string): Promise<PromptStash | null> => {
    const d = latest.current;
    if (pending.current || d.disabled) return null;
    if (d.attachments.some(item => item.state === 'staging')) { d.flash('Waiting for attachments to finish uploading'); return null; }
    const ready = d.attachments.filter(item => item.state === 'ready' && item.ref);
    const chips = d.chips.filter(chip => d.text.includes(chip.token));
    // Image context chips are the attachment strip's files; the stash carries those as attachments.
    const context = d.context.filter(chip => chip.type !== 'image');
    if (!d.text.trim() && !ready.length && !context.length) { d.flash('Write something to stash first'); return null; }
    pending.current = true;
    try {
      const saved = await saveStash({ ...(name ? { name } : {}), text: d.text, chatId: d.chatId, chips, context, ...(d.effort ? { effort: d.effort } : {}), attachmentIds: ready.map(item => item.ref!.id) });
      // The stash owns copies now: clear the composer and let go of its staged files.
      const ids = ready.map(item => item.ref!.id);
      for (const item of ready) if (item.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(item.previewUrl);
      d.setAttachments(current => current.filter(item => !item.ref || !ids.includes(item.ref.id)));
      for (const id of ids) void discardAttachment(d.chatId, id).catch(() => undefined);
      d.setText(''); d.setChips(() => []); d.setContext(current => current.filter(chip => chip.type === 'image' && !ids.includes(chip.attachment?.id ?? '')));
      d.flash(`Stashed “${saved.name}” · ⌘K Stashes to restore`);
      return saved;
    } catch (cause) { d.notifyError(`Could not stash this prompt: ${runtimeMessage(cause)}`); return null; }
    finally { pending.current = false; }
  };

  const restore = async (id: string): Promise<boolean> => {
    const d = latest.current;
    if (pending.current || d.disabled) return false;
    pending.current = true;
    try {
      const { stash: saved, attachments } = await restoreStash(id, d.chatId);
      // Merge into what is typed now, not the text from before the round trip (typing during a restore is kept).
      const typed = latest.current.chatId === d.chatId ? latest.current.text : d.text;
      d.setText(mergeStashText(typed, saved.text));
      d.setChips(current => mergeById<ComposerChip>(current, saved.chips, chip => chip.token));
      d.setContext(current => mergeById<ContextChip>(current, saved.context, chip => chip.id));
      if (saved.effort) d.chooseEffort(saved.effort);
      d.setAttachments(current => [...current, ...attachments.filter(ref => !current.some(item => item.ref?.id === ref.id))
        .map(ref => ({ localId: ref.id, key: `ref:${ref.id}`, name: ref.name, mime: ref.mime, size: ref.size, kind: ref.kind, state: 'ready' as const, ref }))]);
      for (const ref of attachments) if (ref.kind === 'image') void previewAttachment(d.chatId, ref.id).then(value => {
        if (value?.dataUrl) latest.current.setAttachments(current => current.map(item => item.ref?.id === ref.id && !item.previewUrl ? { ...item, previewUrl: value.dataUrl } : item));
      }).catch(() => undefined);
      d.flash(`Restored “${saved.name}”`);
      return true;
    } catch (cause) { d.notifyError(`Could not restore this stash: ${runtimeMessage(cause)}`); return false; }
    finally { pending.current = false; }
  };

  return { open, setOpen, stash, restore };
}

const when = (iso: string) => { const at = new Date(iso); return Number.isNaN(at.getTime()) ? '' : at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };

/** The Stashes list: restore into the composer, rename inline, delete with a confirm step. */
export function StashesPopover({ onRestore, onClose }: { onRestore(id: string): Promise<boolean>; onClose(): void }): React.ReactElement {
  const [stashes, setStashes] = useState<PromptStash[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const reload = () => listStashes().then(value => { setStashes(value); setError(''); }).catch(cause => { setStashes([]); setError(runtimeMessage(cause)); });
  useEffect(() => { void reload(); }, []);
  useEffect(() => {
    const onDown = (event: MouseEvent) => { if (root.current && event.target instanceof Node && !root.current.contains(event.target)) onClose(); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);
  const run = async (work: () => Promise<unknown>) => {
    if (busy) return; setBusy(true);
    try { await work(); setError(''); } catch (cause) { setError(runtimeMessage(cause)); } finally { setBusy(false); }
  };
  const commitRename = (value: string) => {
    if (!renaming) return;
    const { id } = renaming;
    if (!value.trim()) { setRenaming(null); return; }
    void run(async () => { const next = await renameStash(id, value); setStashes(current => current?.map(item => item.id === id ? next : item) ?? current); setRenaming(null); });
  };
  const q = query.trim().toLowerCase();
  const shown = (stashes ?? []).filter(item => !q || `${item.name}\n${item.text}`.toLowerCase().includes(q));
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (renaming) setRenaming(null); else if (confirming) setConfirming(null); else onClose(); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('.composer-stash-restore') ?? [])];
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[event.key === 'ArrowDown' ? (index + 1) % buttons.length : index <= 0 ? buttons.length - 1 : index - 1]?.focus();
  };

  return <div ref={root} data-testid="composer-stashes" className="composer-popover composer-stash-popover" data-browser-overlay role="dialog" aria-label="Stashes" onKeyDown={onKeyDown}>
    <div className="composer-stash-head">
      <span className="composer-stash-title">Stashes</span>
      <button type="button" className="composer-stash-icon" aria-label="Close stashes" onClick={onClose}><X size={13} /></button>
    </div>
    <label className="composer-model-search"><Search size={13} /><input autoFocus type="search" aria-label="Search stashes" placeholder="Search stashes…" value={query} onChange={event => setQuery(event.target.value)} /></label>
    {error && <p className="composer-stash-error" role="alert">{error}</p>}
    <ul className="composer-stash-list" aria-label="Stashed prompts" aria-busy={stashes === null}>
      {stashes === null ? <li className="composer-stash-empty">Loading…</li>
        : !shown.length ? <li className="composer-stash-empty">{stashes.length ? 'No stash matches.' : 'No stashes yet. Stash a draft with ⌘⇧S.'}</li>
        : shown.map(item => <li key={item.id} className="composer-stash-row" data-stash-id={item.id}>
          {renaming?.id === item.id
            ? <input className="composer-stash-rename" autoFocus aria-label={`Rename ${item.name}`} defaultValue={renaming.value} maxLength={120}
                onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitRename(event.currentTarget.value); } }} onBlur={event => commitRename(event.currentTarget.value)} />
            : <button type="button" className="composer-stash-restore" disabled={busy} title="Restore into the composer"
                onClick={() => void run(async () => { if (await onRestore(item.id)) onClose(); })}>
                <span className="composer-stash-name">{item.name}</span>
                <span className="composer-stash-meta">{[when(item.updatedAt), item.attachments.length ? `${plural(item.attachments.length, 'file')}` : '', item.effort ?? ''].filter(Boolean).join(' · ')}</span>
                {item.text && item.text.trim() !== item.name && <span className="composer-stash-preview">{item.text.slice(0, 160)}</span>}
              </button>}
          {confirming === item.id
            ? <span className="composer-stash-actions">
                <button type="button" className="composer-stash-danger" disabled={busy} aria-label={`Confirm delete ${item.name}`}
                  onClick={() => void run(async () => { await deleteStash(item.id); setConfirming(null); setStashes(current => current?.filter(entry => entry.id !== item.id) ?? current); })}><Check size={13} />Delete</button>
                <button type="button" className="composer-stash-icon" aria-label="Keep stash" onClick={() => setConfirming(null)}><Undo2 size={13} /></button>
              </span>
            : <span className="composer-stash-actions">
                <Tip label="Rename"><button type="button" className="composer-stash-icon" disabled={busy} aria-label={`Rename ${item.name}`} onClick={() => setRenaming({ id: item.id, value: item.name })}><Pencil size={13} /></button></Tip>
                <Tip label="Delete"><button type="button" className="composer-stash-icon" disabled={busy} aria-label={`Delete ${item.name}`} onClick={() => setConfirming(item.id)}><Trash2 size={13} /></button></Tip>
              </span>}
        </li>)}
    </ul>
    <p className="composer-command-hint"><Archive size={11} aria-hidden="true" /> ⌘⇧S stashes the current draft · Enter restores</p>
  </div>;
}
