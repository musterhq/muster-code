import React, {useRef, useState} from 'react';
import {Trash2} from 'lucide-react';
import {invoke} from '../bridge';
import {closeTab, getState} from '../store';
import {ConfirmSheet} from './ConfirmSheet';
import {Tip} from './Tooltip';

const messageOf = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** Discard a new (untracked) file through the system Trash so it can be restored; its open file and diff tabs close with it. */
export function DiscardUntracked({folderId, path, disabled, className, text, onDiscard}: {folderId: string; path: string; disabled?: boolean; className: string; text?: string; onDiscard?(): void}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const locked = useRef(false);
  const discard = async () => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try {
      await invoke('files.trash', {folderId, path});
      setOpen(false);
      for (const tab of getState().tabs) {
        if (tab.folderId === folderId && tab.path === path && (tab.kind === 'file' || tab.kind === 'diff')) closeTab(tab.id);
      }
      onDiscard?.();
    } catch (cause) {
      setError(messageOf(cause));
    } finally { locked.current = false; setBusy(false); }
  };
  return <>
    <Tip label="Discard: move this new file to the system Trash"><button type="button" className={className} disabled={disabled || busy} aria-label={`Discard ${path}`} onClick={() => { setError(''); setOpen(true); }}><Trash2 size={text ? 12 : 13} aria-hidden={text ? true : undefined}/>{text}</button></Tip>
    <ConfirmSheet open={open} title={`Move ${path} to Trash?`} description={error || 'This new file is not in Git yet. It moves to your system Trash, where you can restore it.'} busy={busy} testId="git-discard-confirm" onCancel={() => setOpen(false)} actions={[
      {label: 'Cancel', run: () => setOpen(false)},
      {label: 'Move to Trash', primary: true, run: () => void discard()},
    ]}/>
  </>;
}
