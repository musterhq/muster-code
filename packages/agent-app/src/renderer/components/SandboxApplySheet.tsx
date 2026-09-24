import React, {useCallback, useEffect, useState} from 'react';
import {Loader2} from 'lucide-react';
import type {SandboxChange, SandboxFileDiff} from '../../shared/domains/sandbox-protocol';
import {invoke} from '../bridge';
import {notifyError, notifySuccess} from '../store';
import {InlineDiff} from './InlineDiff';
import {ModalSheet} from './ModalSheet';

const STATUS: Record<SandboxChange['status'], string> = {added: 'A', modified: 'M', deleted: 'D'};

/** Diff review before the isolated copy's changes land on this Mac: pick files, read each diff, apply. */
export function SandboxApplySheet({chatId, folderId, open, onClose}: {chatId: string; folderId?: string; open: boolean; onClose(): void}): React.ReactElement | null {
  const [files, setFiles] = useState<SandboxChange[]>();
  const [truncated, setTruncated] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [current, setCurrent] = useState<string>();
  const [diff, setDiff] = useState<SandboxFileDiff | null>();
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setFiles(undefined);
    invoke('sandbox.changes', {chatId}).then(value => { setFiles(value.files); setTruncated(value.truncated); setSelected(new Set(value.files.map(file => file.path))); setCurrent(value.files[0]?.path); },
      cause => { notifyError(cause); onClose(); });
  }, [chatId]);
  useEffect(() => { if (open) load(); else { setFiles(undefined); setCurrent(undefined); setDiff(undefined); } }, [open, load]);
  useEffect(() => {
    if (!open || !current) { setDiff(undefined); return; }
    let alive = true; setDiff(undefined);
    invoke('sandbox.fileDiff', {chatId, path: current}).then(value => { if (alive) setDiff(value); }, () => { if (alive) setDiff(null); });
    return () => { alive = false; };
  }, [open, chatId, current]);
  const toggle = (path: string) => setSelected(value => { const next = new Set(value); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  const apply = async () => {
    if (!selected.size) return;
    setBusy(true);
    try {
      const {applied} = await invoke('sandbox.applyToHost', {chatId, paths: [...selected]});
      notifySuccess(`Applied ${applied.length} ${applied.length === 1 ? 'file' : 'files'} to this Mac.`);
      onClose();
    } catch (cause) { notifyError(cause); } finally { setBusy(false); }
  };
  return <ModalSheet open={open} title="Apply sandbox changes to this Mac" description="Files the isolated copy changed. Review each diff; applying overwrites the file in the project folder." className="sandbox-apply" testId="sandbox-apply" onClose={() => { if (!busy) onClose(); }}>
    {!files ? <div className="sandbox-apply-empty"><Loader2 size={14} className="env-menu-spin" aria-hidden="true"/> Comparing the copy with the folder…</div>
      : !files.length ? <div className="sandbox-apply-empty">The copy matches the folder. Nothing to apply.</div>
      : <div className="sandbox-apply-body">
        <ul className="sandbox-apply-list" role="list">
          {files.map(file => <li key={file.path} className={file.path === current ? 'is-current' : undefined}>
            <input type="checkbox" checked={selected.has(file.path)} onChange={() => toggle(file.path)} aria-label={`Apply ${file.path}`} disabled={busy}/>
            <button type="button" onClick={() => setCurrent(file.path)} title={file.path}><span className={`sandbox-apply-status is-${file.status}`}>{STATUS[file.status]}</span><span>{file.path}</span></button>
          </li>)}
          {truncated && <li className="sandbox-apply-more">More files differ than are listed here.</li>}
        </ul>
        <div className="sandbox-apply-diff">
          {diff === undefined ? <div className="sandbox-apply-empty"><Loader2 size={14} className="env-menu-spin" aria-hidden="true"/></div>
            : diff === null ? <div className="sandbox-apply-empty">This diff could not be read.</div>
            : diff.patch.trim() ? <InlineDiff text={diff.patch} path={diff.path} folderId={folderId}/> : <div className="sandbox-apply-empty">Binary or identical content.</div>}
        </div>
      </div>}
    <div className="composer-confirm-actions">
      <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" className="is-primary" onClick={() => void apply()} disabled={busy || !files?.length || !selected.size}>{busy ? 'Applying…' : `Apply ${selected.size || ''}`.trim()}</button>
    </div>
  </ModalSheet>;
}
