/** CHAT-06: which chat owns each pending edit in Changes. The runtime attributes files to the chats whose
 *  file-change items touched them (`chat.editOwners`); rows show the owner, and flag a file two chats edited. */
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { invoke } from '../bridge';
import { isRunActive, ownersByPath, type EditOwner } from '../parallelRuns';
import { useStoreSelector } from '../useStore';
import './parallel-runs.css';

const OwnersContext = createContext<ReadonlyMap<string, EditOwner[]>>(new Map());

/** Owners for the folder's current changed paths; re-read when the list or a chat's run state in this folder changes. */
export function useChangeOwners(folderId: string, paths: readonly string[] | undefined): ReadonlyMap<string, EditOwner[]> {
  const runKey = useStoreSelector((state) => (state.snapshot?.chats ?? []).filter((chat) => chat.folderId === folderId).map((chat) => `${chat.id}:${chat.status}:${chat.updatedAt}`).join('|'));
  const pathKey = paths?.join('\n') ?? '';
  const [owners, setOwners] = useState<EditOwner[]>([]);
  useEffect(() => {
    if (!pathKey) { setOwners([]); return; }
    let live = true;
    const timer = setTimeout(() => {
      void invoke('chat.editOwners', { folderId }).then((value) => { if (live) setOwners(value); }, () => { if (live) setOwners([]); });
    }, 150);
    return () => { live = false; clearTimeout(timer); };
  }, [folderId, pathKey, runKey]);
  return useMemo(() => ownersByPath(owners, new Set(paths ?? [])), [owners, pathKey]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function ChangeOwnersProvider({ value, children }: { value: ReadonlyMap<string, EditOwner[]>; children: React.ReactNode }): React.ReactElement {
  return <OwnersContext.Provider value={value}>{children}</OwnersContext.Provider>;
}

/** The owning chat for one changed file (and "+N" when several chats edited it). Nothing for edits no chat made. */
export function ChangeOwnerChip({ path }: { path: string }): React.ReactElement | null {
  const owners = useContext(OwnersContext).get(path);
  if (!owners?.length) return null;
  const [first] = owners;
  const shared = owners.length > 1;
  const label = `${first.title}${shared ? ` +${owners.length - 1}` : ''}`;
  const title = shared
    ? `Edited by ${owners.map((owner) => `“${owner.title}”${isRunActive(owner) ? ' (running)' : ''}`).join(', ')}`
    : `Edited by “${first.title}”${isRunActive(first) ? ' (running)' : ''}`;
  return <span className={`change-owner${isRunActive(first) ? ' is-running' : ''}${shared ? ' is-shared' : ''}`} title={title} aria-label={title}>{label}</span>;
}
