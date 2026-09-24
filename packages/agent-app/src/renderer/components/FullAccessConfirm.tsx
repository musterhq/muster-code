import { CircleAlert, FolderOpen, Globe, Hand, LockKeyhole, SquareTerminal } from 'lucide-react';
import { Dialog } from '@base-ui/react/dialog';
import React, { useEffect, useState } from 'react';
import { FULL_ACCESS_SKIP_EVENT, fullAccessSkipFolders, setFullAccessSkip, type ComposerAccess } from './composerMenus';
import './composer-s3a.css';

/** The three access levels, shared by the in-chat Composer and the New-chat draft so both toolbars match. */
export const ACCESS_OPTIONS = [
  {id:'read-only',label:'Read only',description:'Read files and answer; never edits',Icon:LockKeyhole},
  {id:'workspace',label:'Ask for approval',description:'Always ask to edit external files and use the internet',Icon:Hand},
  {id:'full',label:'Full access',description:'Unrestricted access to the internet and any file on your computer',Icon:CircleAlert},
] as const satisfies readonly {id:ComposerAccess;label:string;description:string;Icon:typeof LockKeyhole}[];

const FULL_ACCESS_ROWS = [
  {Icon:FolderOpen,title:'Files and folders',text:'Read, create, modify, upload, or delete files anywhere on this computer'},
  {Icon:SquareTerminal,title:'Terminal commands',text:'Run commands, install software, and change system settings'},
  {Icon:Globe,title:'Internet and connected apps',text:'Access websites, send data, and use enabled plugins'},
];

/** What turning Full access on actually covers (F6): this chat, plus the default for new chats in its folder. */
export function fullAccessScope(folderName: string | undefined): string {
  return folderName
    ? `Applies to this chat. New chats in ${folderName} will also start with Full access until you change it.`
    : 'Applies to this chat only.';
}

/** The one Full-access confirmation (F13): identical in the draft and in a running chat. */
export function FullAccessConfirm({ open, folderName, canRemember = false, pending = false, blocked = false, error, cancelRef, finalFocus, onOpenChange, onConfirm }: {
  open: boolean; folderName?: string;
  /** CS-B7-3: offer "Don't ask again for this folder" (only when the chat has a folder to remember it for). */
  canRemember?: boolean;
  pending?: boolean; blocked?: boolean; error?: string;
  cancelRef?: React.RefObject<HTMLButtonElement | null>; finalFocus?: React.RefObject<HTMLElement | null>;
  onOpenChange(open: boolean): void; onConfirm(remember: boolean): void;
}): React.ReactElement {
  const [remember, setRemember] = useState(false);
  useEffect(() => { if (open) setRemember(false); }, [open]);
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal><Dialog.Backdrop className="composer-access-backdrop" /><Dialog.Popup data-testid="full-access-confirm" className="composer-access-dialog" initialFocus={cancelRef} finalFocus={finalFocus}>
      <Dialog.Title>Turn on Full Access?</Dialog.Title>
      <Dialog.Description render={<ul />}>
        {FULL_ACCESS_ROWS.map(row => <li key={row.title}><row.Icon size={16} aria-hidden="true" /><span><strong>{row.title}</strong><small>{row.text}</small></span></li>)}
      </Dialog.Description>
      <p className="composer-access-scope">{fullAccessScope(folderName)}</p>
      {canRemember && <label className="composer-access-remember" data-testid="full-access-remember">
        <input type="checkbox" checked={remember} disabled={pending} onChange={event => setRemember(event.target.checked)} />
        <span>Don’t ask again for {folderName ? <strong>{folderName}</strong> : 'this folder'}<small>You can turn this confirmation back on in Settings › Chat.</small></span>
      </label>}
      {error && <p className="composer-reference-error" role="alert">{error}</p>}
      <div><Dialog.Close ref={cancelRef} disabled={pending}>Cancel</Dialog.Close><button type="button" disabled={blocked} onClick={() => onConfirm(canRemember && remember)}>{pending ? 'Applying…' : 'Turn on'}</button></div>
    </Dialog.Popup></Dialog.Portal>
  </Dialog.Root>;
}

/** Settings › Chat: folders whose Full-access confirmation was turned off, each with "Ask again" (CS-B7-3 is reversible). */
export function FullAccessSkips({ folders }: { folders: readonly { id: string; name: string; path?: string }[] }): React.ReactElement {
  const [ids, setIds] = useState<string[]>(() => fullAccessSkipFolders());
  useEffect(() => {
    const refresh = () => setIds(fullAccessSkipFolders());
    window.addEventListener(FULL_ACCESS_SKIP_EVENT, refresh);
    return () => window.removeEventListener(FULL_ACCESS_SKIP_EVENT, refresh);
  }, []);
  if (!ids.length) return <p className="full-access-skips-empty" data-testid="full-access-skips">Muster asks before every switch to Full access.</p>;
  return <ul className="full-access-skips" data-testid="full-access-skips" aria-label="Folders that skip the Full access confirmation">
    {ids.map(id => { const folder = folders.find(entry => entry.id === id); const name = folder?.name ?? 'Removed folder';
      return <li key={id}><CircleAlert size={13} aria-hidden="true" /><span title={folder?.path}>{name}</span>
        <button type="button" aria-label={`Ask again before Full access in ${name}`} onClick={() => setFullAccessSkip(id, false)}>Ask again</button></li>; })}
  </ul>;
}
