import React, {useEffect, useState} from 'react';
import {Menu} from '@base-ui/react/menu';
import {AppWindow, Check, ChevronDown, FolderOpen} from 'lucide-react';
import {invoke} from '../bridge';
import {openWithKind, type OpenWithApp} from '../../shared/domains/files-protocol';
import {friendlyFileError} from './filePresentation';
import './file-actions.css';

// One lookup per file kind per session: the installed-app scan and icon conversion are not repeated per tab.
const lookups = new Map<string, Promise<OpenWithApp[]>>();
const appsFor = (path: string) => {
  const kind = openWithKind(path);
  let pending = lookups.get(kind);
  if (!pending) {
    pending = invoke('files.openWith.apps', {path}).then(result => result.apps);
    pending.catch(() => lookups.delete(kind));
    lookups.set(kind, pending);
  }
  return pending;
};
const preferenceKey = (path: string) => `muster.openWith.${openWithKind(path)}`;
const readPreference = (path: string) => {try {return localStorage.getItem(preferenceKey(path)) ?? '';} catch {return '';}};

function AppIcon({app}: {app?: OpenWithApp}): React.ReactElement {
  if (app?.icon) return <img className="open-in-icon" src={app.icon} alt="" aria-hidden="true" draggable={false}/>;
  return app?.id === 'finder' ? <FolderOpen size={14} aria-hidden="true" className="open-in-icon"/> : <AppWindow size={14} aria-hidden="true" className="open-in-icon"/>;
}

/** Codex's "Open ⌄": the button opens in the remembered (or best installed) app for this file type; the chevron lists the rest. */
export function OpenInMenu({folderId, path}: {folderId: string; path: string}): React.ReactElement | null {
  const [apps, setApps] = useState<OpenWithApp[] | null>(null);
  const [preferred, setPreferred] = useState(() => readPreference(path));
  const [status, setStatus] = useState('');
  useEffect(() => {
    let live = true;
    setApps(null); setPreferred(readPreference(path));
    void appsFor(path).then(value => {if (live) setApps(value);}, () => {if (live) setApps([]);});
    return () => {live = false;};
  }, [path]);
  useEffect(() => {if (!status) return; const timer = setTimeout(() => setStatus(''), 2400); return () => clearTimeout(timer);}, [status]);
  if (apps && apps.length === 0) return null;
  const primary = apps?.find(app => app.id === preferred) ?? apps?.[0];
  const label = primary && (primary.id === 'finder' ? 'Reveal in Finder' : `Open in ${primary.name}`);
  const open = (app: OpenWithApp) => {
    // Revealing is a one-off; only a real app becomes the default for this file type.
    if (app.id !== 'finder') {
      try {localStorage.setItem(preferenceKey(path), app.id);} catch { /* the choice just is not remembered */ }
      setPreferred(app.id);
    }
    void invoke('files.openWith', {folderId, path, app: app.id}).catch(error => setStatus(friendlyFileError(error)));
  };
  return <><div className="open-in" data-loading={!apps || undefined}>
    <button type="button" className="open-in-primary" disabled={!primary} title={label ?? 'Finding apps…'} aria-label={label ?? 'Open in app'} onClick={() => primary && open(primary)}>
      <AppIcon app={primary}/><span>Open</span>
    </button>
    <Menu.Root>
      <Menu.Trigger className="open-in-more" disabled={!apps} aria-label="Choose app to open with"><ChevronDown size={13}/></Menu.Trigger>
      <Menu.Portal><Menu.Positioner side="bottom" align="end" sideOffset={4} className="file-action-positioner"><Menu.Popup className="ui-menu file-action-menu open-in-menu">
        {apps?.map(app => <Menu.Item key={app.id} onClick={() => open(app)}>
          <AppIcon app={app}/><span className="open-in-name">{app.id === 'finder' ? 'Reveal in Finder' : app.name}</span>{app.id === primary?.id && <Check size={13} aria-label="Default" className="open-in-check"/>}
        </Menu.Item>)}
      </Menu.Popup></Menu.Positioner></Menu.Portal>
    </Menu.Root>
  </div>{status && <span className="file-copy-status open-in-status" role="status">{status}</span>}</>;
}
