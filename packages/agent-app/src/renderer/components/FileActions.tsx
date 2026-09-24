import React, {useRef, useState, useSyncExternalStore} from 'react';
import {Menu} from '@base-ui/react/menu';
import {Dialog} from '@base-ui/react/dialog';
import {Check, Copy, Download, EyeOff, FilePlus, FolderPlus, FolderOpen, MoreHorizontal, Pencil, Trash2, X} from 'lucide-react';
import {invoke} from '../bridge';
import {closeTab, getState, loadDir, openFile, pushNotice, setShowHiddenFiles} from '../store';
import {showHiddenFiles, subscribeShowHidden} from '../fileTreePrefs';
import {useStoreSelector} from '../useStore';
import './file-actions.css';

type Action = 'file' | 'directory' | 'move' | 'trash';
const parentOf = (path: string) => path.includes('/') ? path.slice(0,path.lastIndexOf('/')) : '';
const messageOf = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export const FileActions = React.memo(function FileActions({folderId, path, kind, root = false}: {folderId:string;path:string;kind:'file'|'directory';root?:boolean}) {
  const [menu, setMenu] = useState(false);
  const showHidden = useSyncExternalStore(subscribeShowHidden, showHiddenFiles);
  const [action, setAction] = useState<Action | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const name = path.split('/').pop() || 'folder';
  const folderPath = useStoreSelector(state => state.snapshot?.folders.find(f => f.id === folderId)?.path);
  const begin = (next: Action) => {
    setMenu(false); setError(''); setValue(next === 'move' ? path : ''); setAction(next);
  };
  /** W6-D: copy the file anywhere via the native save dialog (main confines the source to the folder). */
  const saveCopy = async () => {
    setError('');
    try { const result = await invoke('files.saveCopy',{folderId,path}); if (result.saved) pushNotice(`Saved a copy as “${result.fileName}”.`, {kind: 'info'}); }
    catch(cause) {setError(messageOf(cause));}
  };
  const direct = async (command: 'clipboard.write'|'files.reveal', text?: string) => {
    setError('');
    try {
      if (command === 'clipboard.write') await invoke(command,{text:text ?? path});
      else await invoke(command,{folderId,path});
    } catch(cause) {setError(messageOf(cause));}
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!action || locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try {
      if (action === 'trash') {
        await invoke('files.trash',{folderId,path});
        void loadDir(folderId,parentOf(path));
        // Trashing a folder takes every file under it with it.
        const prefix = kind === 'directory' ? `${path}/` : path;
        for (const tab of getState().tabs) {
          if (tab.folderId === folderId && tab.kind === 'file' && tab.path && (tab.path === path || tab.path.startsWith(prefix))) {
            closeTab(tab.id);
            pushNotice(`“${tab.path.split('/').pop()}” was moved to Trash; its tab was closed.`, {kind: 'info'});
          }
        }
      } else if (action === 'move') {
        if (!value.trim()) throw new Error('Enter a destination path.');
        await invoke('files.move',{folderId,from:path,to:value});
        void loadDir(folderId,parentOf(path));
        if (parentOf(path) !== parentOf(value)) void loadDir(folderId,parentOf(value));
      } else {
        if (!value.trim() || value.includes('/')) throw new Error('Enter one file or folder name.');
        const destination = path ? path + '/' + value : value;
        await invoke('files.create',{folderId,path:destination,kind:action});
        void loadDir(folderId,path);
        if (action === 'file') void openFile(folderId,destination);
      }
      setAction(null);
    } catch(cause) {setError(messageOf(cause));}
    finally {locked.current = false; setBusy(false);}
  };
  const title = action === 'file' ? 'New file' : action === 'directory' ? 'New folder' : action === 'move' ? 'Rename or move file' : 'Move to Trash';
  return <>
    <Menu.Root open={menu} onOpenChange={setMenu}>
      <Menu.Trigger ref={trigger} className="file-action-trigger" aria-label={root ? 'Folder actions' : `Actions for ${name}`}><MoreHorizontal size={15}/></Menu.Trigger>
      <Menu.Portal><Menu.Positioner side="bottom" align="end" sideOffset={4} className="file-action-positioner"><Menu.Popup className="ui-menu file-action-menu">
        {kind === 'directory' && <><Menu.Item onClick={() => begin('file')}><FilePlus size={14}/>New file</Menu.Item><Menu.Item onClick={() => begin('directory')}><FolderPlus size={14}/>New folder</Menu.Item></>}
        {!root && <>
          <Menu.Item onClick={() => void direct('clipboard.write')}><Copy size={14}/>Copy relative path</Menu.Item>
          {folderPath && <Menu.Item onClick={() => void direct('clipboard.write', `${folderPath.replace(/[\\/]+$/,'')}/${path}`)}><Copy size={14}/>Copy absolute path</Menu.Item>}
          <Menu.Item onClick={() => void direct('files.reveal')}><FolderOpen size={14}/>Reveal in file manager</Menu.Item>
          {kind === 'file' && <Menu.Item onClick={() => void saveCopy()}><Download size={14}/>Save a copy…</Menu.Item>}
          <Menu.Item onClick={() => begin('move')}><Pencil size={14}/>Rename or move…</Menu.Item>
          <Menu.Item className="file-action-destructive" onClick={() => begin('trash')}><Trash2 size={14}/>Move to Trash…</Menu.Item>
        </>}
        {root && <Menu.CheckboxItem className="file-action-check" checked={showHidden} onCheckedChange={setShowHiddenFiles} title="List .git, .DS_Store and other version-control or system files the tree leaves out. Other dotfiles are always shown.">
          {showHidden ? <Check size={14}/> : <EyeOff size={14}/>}Show .git and system files
        </Menu.CheckboxItem>}
      </Menu.Popup></Menu.Positioner></Menu.Portal>
    </Menu.Root>
    {error && !action && <span className="file-action-inline-error" role="alert">{error}</span>}
    <Dialog.Root open={action !== null} onOpenChange={open => {if (!open && !locked.current) {setAction(null);setError('');}}}>
      <Dialog.Portal><Dialog.Backdrop className="file-dialog-backdrop"/><Dialog.Popup className="file-dialog" initialFocus={input} finalFocus={trigger}>
        <div className="file-dialog-heading"><Dialog.Title>{title}</Dialog.Title><Dialog.Close className="icon-button" disabled={busy} aria-label="Close file action"><X size={16}/></Dialog.Close></div>
        <Dialog.Description>{action === 'trash' ? `“${name}” will be moved to your system Trash. You can restore it there.` : action === 'move' ? 'Enter a path relative to this workspace. Existing files are never replaced.' : `Create in ${path || 'the workspace root'}.`}</Dialog.Description>
        <form onSubmit={event => void submit(event)} aria-busy={busy}>
          {action !== 'trash' && <label>{action === 'move' ? 'Destination path' : 'Name'}<input ref={input} value={value} onChange={event => setValue(event.target.value)} disabled={busy} maxLength={4096} autoComplete="off" spellCheck={false}/></label>}
          {error && <p className="file-action-error" role="alert">{error}</p>}
          <footer><Dialog.Close disabled={busy}>Cancel</Dialog.Close><button className={action === 'trash' ? 'file-action-destructive' : 'file-action-primary'} type="submit" disabled={busy || (action !== 'trash' && !value.trim())}>{busy ? 'Working…' : action === 'trash' ? 'Move to Trash' : action === 'move' ? 'Move' : 'Create'}</button></footer>
        </form>
      </Dialog.Popup></Dialog.Portal>
    </Dialog.Root>
  </>;
});
