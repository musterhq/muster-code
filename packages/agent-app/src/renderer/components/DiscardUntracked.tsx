import React, {useState} from 'react';
import {Trash2} from 'lucide-react';
import {invoke} from '../bridge';
import {ConfirmSheet} from './ConfirmSheet';

/** Discard new files through the system Trash so they can be restored. */
export function DiscardUntracked({folderId, path, disabled, className, onDiscard}: {folderId: string; path: string; disabled?: boolean; className: string; onDiscard(): void}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const discard = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await invoke('files.trash', {folderId, path});
      setOpen(false);
      onDiscard();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };
  return <>
    <button type="button" className={className} disabled={disabled || busy} aria-label={`Discard ${path}`} title="Discard untracked file" onClick={() => setOpen(true)}><Trash2 size={13}/></button>
    <ConfirmSheet open={open} title={`Move ${path} to Trash?`} description={error || 'This untracked file will move to your system Trash. You can restore it there.'} busy={busy} testId="git-discard-confirm" onCancel={() => setOpen(false)} actions={[
      {label: 'Cancel', run: () => setOpen(false)},
      {label: 'Move to Trash', primary: true, run: () => void discard()},
    ]}/>
  </>;
}
