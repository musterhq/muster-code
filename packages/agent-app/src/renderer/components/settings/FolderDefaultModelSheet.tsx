import React, {useEffect, useRef, useState} from 'react';
import type {ModelPreference, ResolvedChatDefaults} from '../../../shared/domains/settings-protocol';
import {invoke} from '../../bridge';
import {getState, notifyError} from '../../store';
import {ModalSheet} from '../ModalSheet';
import {DefaultModelPicker} from './DefaultModelPicker';
import {ProvenanceTag} from './ProvenanceTag';
import {provenance} from './provenance';

/** Where the model a new chat here starts with comes from (CMP-23 provenance label). */
export const DEFAULT_SOURCE_LABEL: Record<ResolvedChatDefaults['source'], string> = {project: 'From the Project default', folder: 'From this folder’s default', user: 'From your default', runtime: 'Built-in default'};
export const requestFolderDefaultModel = (folderId: string): void => { window.dispatchEvent(new CustomEvent('muster:folder-default-model', {detail: {folderId}})); };

/** CMP-23: folder ▸ Default Model… — the model new chats in this folder start with, between your default and a Project's. */
export function FolderDefaultModelSheet(): React.ReactElement | null {
  const [folderId, setFolderId] = useState<string | null>(null);
  const [value, setValue] = useState<ModelPreference | null | undefined>(undefined);
  const [resolved, setResolved] = useState<ResolvedChatDefaults>();
  const [error, setError] = useState('');
  const writes = useRef(0);
  useEffect(() => {
    const onRequest = (event: Event) => { const id = (event as CustomEvent<{folderId?: string}>).detail?.folderId; if (typeof id === 'string') { setValue(undefined); setResolved(undefined); setError(''); setFolderId(id); } };
    window.addEventListener('muster:folder-default-model', onRequest);
    return () => window.removeEventListener('muster:folder-default-model', onRequest);
  }, []);
  const refresh = (id: string) => invoke('chat.defaults', {folderId: id}).then(setResolved, () => setResolved(undefined));
  useEffect(() => {
    if (!folderId) return;
    let live = true;
    invoke('settings.folderModel.get', {folderId}).then(result => { if (live) setValue(result.value); }, cause => { if (live) setError(cause instanceof Error ? cause.message : 'Default model couldn’t be loaded.'); });
    void refresh(folderId);
    return () => { live = false; };
  }, [folderId]);
  const folder = folderId ? getState().snapshot?.folders.find(item => item.id === folderId) : undefined;
  if (!folderId || !folder) return null;
  const change = (next: ModelPreference | null) => {
    const previous = value, token = ++writes.current; setValue(next);
    invoke('settings.folderModel.set', {folderId, value: next}).then(
      result => { if (token === writes.current) { setValue(result.value); void refresh(folderId); } },
      cause => { if (token === writes.current) setValue(previous); notifyError(cause); });
  };
  return <ModalSheet open title={`Default model for “${folder.name}”`} description="New chats in this folder start with this model. A Project’s default still wins; each chat can switch in the composer." className="composer-confirm folder-default-model" testId="folder-default-model" onClose={() => setFolderId(null)}>
    {error ? <p className="settings-error" role="alert">{error}</p> : value === undefined ? <p role="status">Loading…</p> : <div className="folder-default-model-row">
      <DefaultModelPicker label="Folder default model" value={value} emptyLabel="Use my default" onChange={change}/>
      <ProvenanceTag provenance={value ? provenance('folder') : {level: 'user', label: 'Inherited from your default', canReset: false}} title="Folder default model" onReset={() => change(null)}/>
    </div>}
    {resolved && <p className="field-help" data-source={resolved.source}>New chats here start with <strong>{resolved.model}</strong> · {DEFAULT_SOURCE_LABEL[resolved.source]}</p>}
    <div className="composer-confirm-actions"><button type="button" className="is-primary" onClick={() => setFolderId(null)}>Done</button></div>
  </ModalSheet>;
}
