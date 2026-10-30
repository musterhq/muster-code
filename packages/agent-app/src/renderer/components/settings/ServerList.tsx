import { Menu } from '@base-ui/react/menu';
import { Check, MoreHorizontal } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { MusterServerEntryView } from '../../../shared/domains/muster-server-protocol';
import type { PaperclipConfigView } from '../../../shared/domains/paperclip-protocol';
import { invoke, subscribe } from '../../bridge';
import { refreshWorkspace } from '../../hubStore';
import { notifySuccess } from '../../store';
import { ConnectionPanel } from '../HubSetup';
import { ResourceState } from '../ResourceState';
import { device } from '../../../shared/device-noun.ts';

/**
 * Settings › Integrations › Muster Server (#803): every connected server side by side, one row each, in the same table the SSH hosts use.
 * Each row shows the server's name, address, who is signed in and its status on one line; Rename, Re-authenticate, Disconnect and Remove
 * act on that server alone and sit in the row's "…" menu (Use for Projects, when it applies, is the one button left in the row). A server that cannot be reached shows its own error and a Retry; the rest stay usable. Add server opens the same add
 * flow as before. With no servers yet, that add flow is all there is (the first-time look is unchanged).
 */
const errorText = (cause: unknown) => cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(cause);
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };
const STATUS: Record<MusterServerEntryView['state'], string> = { online: 'Online', checking: 'Checking…', unreachable: 'Can’t reach', 'signed-out': 'Signed out', disconnected: 'Disconnected' };

export function ServerList({ signInAvailable = true }: { signInAvailable?: boolean }): React.ReactElement {
  const [servers, setServers] = useState<MusterServerEntryView[] | null>(null);
  const [projects, setProjects] = useState<Record<string, string[]>>({});
  const [adding, setAdding] = useState<{ serverId: string; address: string } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  /** "Connected to …" for the server just added; it goes with the next action or after a few seconds. */
  const [notice, setNotice] = useState('');
  const alive = useRef(true);
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(''), 8000); return () => clearTimeout(t); }, [notice]);

  const reload = useCallback(async () => {
    try { const result = await invoke('musterServer.list', {}); if (alive.current) setServers(result.servers); }
    catch (cause) { if (alive.current) { setError(errorText(cause)); setServers(s => s ?? []); } }
  }, []);
  /** Every server's projects in one read; a server that fails is skipped here (its row shows the error). */
  const loadProjects = useCallback(async () => {
    try {
      const result = await invoke('musterServer.projects', {});
      const grouped: Record<string, string[]> = {};
      for (const p of result.projects) if (p.serverId && !p.archived) (grouped[p.serverId] ??= []).push(p.name);
      if (alive.current) setProjects(grouped);
    } catch { if (alive.current) setProjects({}); }
  }, []);
  const check = useCallback(async (serverId?: string) => {
    try { const result = await invoke('musterServer.check', serverId ? { serverId } : {}); if (alive.current) setServers(result.servers); }
    catch (cause) { if (alive.current) setError(errorText(cause)); }
    await loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    alive.current = true;
    void reload().then(() => check());
    // A sign-in finishing, a check ending or another window's change: the runtime says so; nothing here polls.
    const off = subscribe(event => { if (event.type === 'musterServerChanged') void reload(); });
    return () => { alive.current = false; off(); };
  }, []);

  /** Runs one row action; a second click while it runs is ignored. */
  const act = async (key: string, run: () => Promise<unknown>, done?: string) => {
    if (busy) return;
    setBusy(key); setError(''); setNotice('');
    try { await run(); if (done) notifySuccess(done); await reload(); }
    catch (cause) { setError(errorText(cause)); }
    finally { if (alive.current) setBusy(null); }
  };
  const saveName = (server: MusterServerEntryView) => act(`${server.id}:rename`, async () => { await invoke('musterServer.rename', { serverId: server.id, name: renaming?.name ?? '' }); setRenaming(null); });
  const disconnect = (server: MusterServerEntryView) => act(`${server.id}:disconnect`, async () => {
    const result = await invoke('paperclip.disconnect', { serverId: server.id });
    if (result.message) setError(result.message);
    if (server.workspace) await refreshWorkspace(true);
  }, `Disconnected ${server.name}. It stays in the list; Re-authenticate connects it again.`);
  const remove = (server: MusterServerEntryView) => act(`${server.id}:remove`, async () => {
    await invoke('musterServer.remove', { serverId: server.id });
    setProjects(p => { const next = { ...p }; delete next[server.id]; return next; });
    if (server.workspace) await refreshWorkspace(true);
  }, `Removed ${server.name}. Its sign-in was deleted from ${device().lower}.`);
  const useForProjects = (server: MusterServerEntryView) => act(`${server.id}:workspace`, async () => { await invoke('musterServer.useForWorkspace', { serverId: server.id }); await refreshWorkspace(true); }, `Projects, Roster and Inbox now sync from ${server.name}.`);
  const added = (view?: PaperclipConfigView) => {
    setAdding(null);
    if (view && view.mode !== 'off') setNotice(`Connected to ${view.serverName ?? hostOf(view.baseUrl)}${view.user ? ` as ${view.user.displayName}` : view.hasToken ? ' with an API token' : ''}.`);
    void reload().then(() => check());
  };

  if (!servers) return <ResourceState kind="loading" compact label="Loading servers" rows={2}/>;
  // No server yet: the add flow exactly as it was, and the first server it connects feeds Projects.
  if (servers.length === 0 && !adding) return <ConnectionPanel compact signInAvailable={signInAvailable} onSaved={added}/>;
  const workspace = servers.find(s => s.workspace);
  return <div className="ws-server-list">
    <table className="server-table" aria-label="Muster Servers">
      <thead><tr><th>Server</th><th>Address</th><th>Signed in as</th><th>Status</th><th/></tr></thead>
      <tbody>{servers.map(server => {
        const names = projects[server.id] ?? [], editing = renaming?.id === server.id, failed = server.state === 'unreachable' || server.state === 'signed-out';
        const note = [server.workspace ? 'Projects, Roster and Inbox sync from this server.' : null, names.length ? `Projects: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ` and ${names.length - 6} more` : ''}` : null].filter(Boolean).join(' ');
        return <React.Fragment key={server.id}>
          <tr data-server-id={server.id}>
            <td data-cell="name">{editing
              ? <span className="server-inline"><input type="text" aria-label="Server name" value={renaming.name} maxLength={80} autoFocus onChange={e => setRenaming({ id: server.id, name: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') void saveName(server); if (e.key === 'Escape') setRenaming(null); }}/></span>
              : <strong>{server.name}</strong>}</td>
            <td data-cell="url">{server.url}</td>
            <td data-cell="account" className={server.account ? undefined : 'ws-faint'}>{server.account ?? 'Not signed in'}</td>
            <td data-cell="status"><span className="ws-faint" data-state={server.state}>{STATUS[server.state]}</span>{failed && <> <button type="button" className="ws-link" disabled={busy !== null} onClick={() => void act(`${server.id}:check`, () => check(server.id))}>Retry</button></>}</td>
            <td data-cell="actions" className="server-inline">{editing
              ? <><button type="button" className="settings-button" disabled={busy !== null || !renaming.name.trim()} onClick={() => void saveName(server)}>Save name</button><button type="button" className="settings-button secondary" onClick={() => setRenaming(null)}>Cancel</button></>
              : <>
                {!server.workspace && server.state !== 'disconnected' && <button type="button" className="settings-button secondary" title="Projects, Roster and Inbox sync from one server at a time. Every server’s projects stay listed here." disabled={busy !== null} onClick={() => void useForProjects(server)}>Use for Projects</button>}
                <Menu.Root>
                  <Menu.Trigger className="icon-button" aria-label={`Actions for ${server.name}`} disabled={busy !== null}><MoreHorizontal size={14}/></Menu.Trigger>
                  <Menu.Portal><Menu.Positioner side="bottom" align="end" sideOffset={4} className="project-menu-positioner"><Menu.Popup className="ui-menu project-menu">
                    <Menu.Item onClick={() => setRenaming({ id: server.id, name: server.name })}>Rename</Menu.Item>
                    <Menu.Item onClick={() => { setNotice(''); setAdding({ serverId: server.id, address: server.url }); }}>Re-authenticate</Menu.Item>
                    {server.state !== 'disconnected' && <Menu.Item onClick={() => void disconnect(server)}>Disconnect</Menu.Item>}
                    <Menu.Item onClick={() => void remove(server)}>Remove</Menu.Item>
                  </Menu.Popup></Menu.Positioner></Menu.Portal>
                </Menu.Root>
              </>}</td>
          </tr>
          {failed && server.error && <tr><td colSpan={5}><p role="alert" className="settings-error">{server.error}</p></td></tr>}
          {note && <tr><td colSpan={5}><span className="ws-faint">{note}</span></td></tr>}
        </React.Fragment>;
      })}</tbody>
    </table>
    {error && <p role="alert" className="settings-error">{error}</p>}
    {notice && !adding && <p className="ws-connection-detect" data-ok="true" role="status"><Check size={13} aria-hidden="true"/>{notice}</p>}
    {adding
      ? <ConnectionPanel key={`${adding.serverId}:${adding.address}`} compact addOnly signInAvailable={signInAvailable} serverId={adding.serverId} initialAddress={adding.address} onSaved={added} onCancel={() => setAdding(null)}/>
      : <div className="project-edit-actions"><button type="button" className="settings-button" disabled={busy !== null} onClick={() => { setNotice(''); setAdding({ serverId: 'new', address: '' }); }}>Add server</button></div>}
    {workspace && workspace.state !== 'disconnected' && !adding && <ConnectionPanel key={workspace.id} compact inList signInAvailable={signInAvailable} onSaved={() => void reload()}/>}
  </div>;
}
