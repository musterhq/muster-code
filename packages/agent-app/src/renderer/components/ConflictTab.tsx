import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Check, ChevronDown, ChevronRight, Columns3, GitMerge, Pencil, RefreshCw, RotateCcw, TriangleAlert} from 'lucide-react';
import {ConfirmSheet} from './ConfirmSheet';
import type {GitConflictFile, GitConflictState} from '../../shared/domains/git-protocol';
import {applyConflictChoices, parseConflicts, type ConflictBlock, type ConflictChoice} from '../../shared/conflict-markers';
import {invoke, subscribe} from '../bridge';
import {closeTab, loadGitChanges, notifySuccess, openConflictTab, type WorkspaceTab} from '../store';
import {useStoreSelector} from '../useStore';
import {FileTypeIcon} from './FileTypeIcon';
import {GitRefChip, GitStatusBadge} from './GitStatus';
import {ResourceState} from './ResourceState';
import {cleanIpcError, gitErrorMessage, isNotGitRepository} from './resourceErrors';
import './conflict-view.css';
import {Tip} from './Tooltip';

const OPERATION_LABEL = {merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', revert: 'Revert'} as const;

/** Poll-free conflict state for a folder: read on mount and after every workspaceChanged for it. */
export function useConflictState(folderId: string): {state?: GitConflictState; error: string; refresh: () => void} {
  const [state, setState] = useState<GitConflictState>();
  const [error, setError] = useState('');
  const token = useRef(0);
  const refresh = useCallback(() => {
    const mine = ++token.current;
    invoke('git.conflicts', {folderId}).then(value => { if (mine === token.current) { setState(value); setError(''); } }, cause => { if (mine === token.current) setError(cleanIpcError(cause) || 'Conflict state unavailable.'); });
  }, [folderId]);
  useEffect(() => {
    refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = subscribe(event => { if (event.type === 'workspaceChanged' && event.folderId === folderId) { clearTimeout(timer); timer = setTimeout(refresh, 250); } });
    return () => { off(); clearTimeout(timer); token.current++; };
  }, [folderId, refresh]);
  return {state, error, refresh};
}

/** Shown above the Repository panel while a merge/rebase/cherry-pick/revert is in progress: the operation, its sides, the unmerged files and Continue/Abort (GIT-13). */
export function GitConflictBanner({folderId}: {folderId: string}): React.ReactElement | null {
  const {state, error, refresh} = useConflictState(folderId);
  const [busy, setBusy] = useState<'continue' | 'abort' | null>(null);
  const [failure, setFailure] = useState('');
  const [confirmAbort, setConfirmAbort] = useState(false);
  if (!state || isNotGitRepository(error) || (!state.operation && !state.files.length)) return null;
  const act = async (action: 'continue' | 'abort') => {
    if (busy) return;
    setConfirmAbort(false);
    setBusy(action); setFailure('');
    try {
      await invoke('git.conflictContinue', {folderId, action});
      notifySuccess(action === 'continue' ? `${OPERATION_LABEL[state.operation!]} completed` : `${OPERATION_LABEL[state.operation!]} aborted`);
      void loadGitChanges(folderId); refresh();
    } catch (cause) { setFailure(cleanIpcError(cause) || 'The operation could not continue.'); }
    finally { setBusy(null); }
  };
  const label = state.operation ? OPERATION_LABEL[state.operation] : 'Conflicts';
  return <section className="git-conflict-banner" data-testid="conflict-banner" aria-label={`${label} in progress`}>
    <header>
      <GitMerge size={14} aria-hidden="true"/>
      <span className="git-conflict-title">{state.operation ? `${label} in progress` : 'Unmerged files'}</span>
      {(state.operation || state.files.length > 0) && <span className="git-conflict-sides" title={`Bringing ${state.incomingLabel} into ${state.currentLabel}${state.incomingSubject ? `: ${state.incomingSubject}` : ''}`}><GitRefChip name={state.currentLabel} kind="current"/><span className="git-conflict-arrow" aria-hidden="true">←</span><GitRefChip name={state.incomingLabel} kind="local"/></span>}
      {state.operation && <div className="git-conflict-actions">
        <button type="button" disabled={!!busy} onClick={() => setConfirmAbort(true)}>{busy === 'abort' ? 'Aborting…' : 'Abort'}</button>
        <button type="button" className="is-primary" disabled={!!busy || !state.canContinue} title={state.canContinue ? `Finish the ${label.toLowerCase()}` : 'Resolve and mark every file first'} onClick={() => void act('continue')}>{busy === 'continue' ? 'Continuing…' : 'Continue'}</button>
      </div>}
    </header>
    {failure && <p className="git-action-error" role="alert">{gitErrorMessage(failure) ?? failure}</p>}
    {state.files.length > 0 && <ul className="git-conflict-files">
      {state.files.map(file => <li key={file.path}>
        <GitStatusBadge status="conflict"/>
        <FileTypeIcon path={file.path}/>
        <span className="git-conflict-path" title={file.path}>{file.path}</span>
        <span className="git-conflict-kind">{file.description}</span>
        <button type="button" className="git-conflict-resolve" onClick={() => openConflictTab(folderId, file.path)}>Resolve</button>
      </li>)}
    </ul>}
    {!state.operation && state.files.length > 0 && <p className="git-conflict-hint">Your uncommitted changes were merged into {state.currentLabel} when switching. Resolve each file; it stays uncommitted afterwards.</p>}
    {state.operation && state.files.length === 0 && <p className="git-conflict-ready"><Check size={12} aria-hidden="true"/>Every conflict is resolved. Continue to finish.</p>}
    {state.operation && <ConfirmSheet open={confirmAbort} title={`Abort the ${label.toLowerCase()}?`} description="Your working tree goes back to how it was before it started. Resolutions made so far are discarded." busy={busy === 'abort'} testId="conflict-abort-confirm" onCancel={() => setConfirmAbort(false)} actions={[{label: 'Keep going', run: () => setConfirmAbort(false)}, {label: `Abort ${label.toLowerCase()}`, primary: true, run: () => void act('abort')}]}/>}
  </section>;
}

// ---------------------------------------------------------------------------
// The per-file resolver.

function Lines({lines, tone}: {lines: string[]; tone?: 'current' | 'incoming' | 'base'}): React.ReactElement {
  return <pre className={`conflict-lines${tone ? ` is-${tone}` : ''}`}>{lines.length ? lines.join('\n') : <span className="conflict-empty">(no lines)</span>}</pre>;
}

function ContextBlock({lines}: {lines: string[]}): React.ReactElement {
  const [open, setOpen] = useState(false);
  if (lines.length <= 8 || open) return <pre className="conflict-context">{lines.join('\n')}</pre>;
  return <>
    <pre className="conflict-context">{lines.slice(0, 3).join('\n')}</pre>
    <button type="button" className="conflict-fold" onClick={() => setOpen(true)}><ChevronRight size={11} aria-hidden="true"/>{lines.length - 6} unchanged lines</button>
    <pre className="conflict-context">{lines.slice(-3).join('\n')}</pre>
  </>;
}

function ConflictBlockView({block, index, total, choice, currentLabel, incomingLabel, onChoose}: {block: Extract<ConflictBlock, {kind: 'conflict'}>; index: number; total: number; choice?: ConflictChoice; currentLabel: string; incomingLabel: string; onChoose: (choice: ConflictChoice | undefined) => void}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const resolved = choice !== undefined && !editing;
  const startEdit = () => { setDraft(choice && typeof choice === 'object' ? choice.edit : [...block.current, ...block.incoming].join('\n')); setEditing(true); };
  const resultLines = choice === 'current' ? block.current : choice === 'incoming' ? block.incoming : choice === 'both' ? [...block.current, ...block.incoming] : choice && typeof choice === 'object' ? choice.edit.split(/\r?\n/) : [];
  return <section className={`conflict-block${resolved ? ' is-resolved' : ''}`} data-testid="conflict-block" aria-label={`Conflict ${index + 1} of ${total}`}>
    <header className="conflict-block-head">
      <span className="conflict-block-title">Conflict {index + 1} of {total}</span>
      {resolved
        ? <span className="conflict-block-state"><Check size={12} aria-hidden="true"/>{choice === 'current' ? 'Kept current' : choice === 'incoming' ? 'Took incoming' : choice === 'both' ? 'Kept both' : 'Edited'}</span>
        : null}
      <div className="conflict-block-actions">
        {resolved
          ? <button type="button" onClick={() => onChoose(undefined)} title="Show the conflict again"><RotateCcw size={11} aria-hidden="true"/>Undo</button>
          : <>
            <button type="button" className="is-current" onClick={() => { setEditing(false); onChoose('current'); }}>Accept current</button>
            <button type="button" className="is-incoming" onClick={() => { setEditing(false); onChoose('incoming'); }}>Accept incoming</button>
            <button type="button" onClick={() => { setEditing(false); onChoose('both'); }}>Accept both</button>
            <button type="button" aria-pressed={editing} onClick={() => editing ? setEditing(false) : startEdit()}><Pencil size={11} aria-hidden="true"/>Edit</button>
          </>}
      </div>
    </header>
    {editing
      ? <div className="conflict-edit">
        <textarea aria-label="Resolved text" value={draft} spellCheck={false} rows={Math.min(18, Math.max(4, draft.split('\n').length + 1))} onChange={event => setDraft(event.target.value)}/>
        <div className="conflict-edit-actions">
          <button type="button" onClick={() => setEditing(false)}>Cancel</button>
          <button type="button" className="is-primary" onClick={() => { onChoose({edit: draft}); setEditing(false); }}>Use this text</button>
        </div>
      </div>
      : resolved
        ? <Lines lines={resultLines}/>
        : <div className={`conflict-sides${block.base ? ' has-base' : ''}`}>
          <div className="conflict-side"><div className="conflict-side-label is-current">Current <span>{currentLabel}</span></div><Lines lines={block.current} tone="current"/></div>
          {block.base && <div className="conflict-side"><div className="conflict-side-label">Base</div><Lines lines={block.base} tone="base"/></div>}
          <div className="conflict-side"><div className="conflict-side-label is-incoming">Incoming <span>{incomingLabel}</span></div><Lines lines={block.incoming} tone="incoming"/></div>
        </div>}
  </section>;
}

/** Whole-side panes (ours / base / theirs) for orientation; collapsed by default. */
function SidePanes({file}: {file: GitConflictFile}): React.ReactElement {
  const [open, setOpen] = useState(false);
  return <div className="conflict-panes">
    <button type="button" className="conflict-panes-toggle" aria-expanded={open} onClick={() => setOpen(v => !v)}>{open ? <ChevronDown size={12} aria-hidden="true"/> : <ChevronRight size={12} aria-hidden="true"/>}<Columns3 size={12} aria-hidden="true"/>Whole file: ours · base · theirs</button>
    {open && <div className="conflict-panes-grid">
      {([['Ours', file.ours, 'current'], ['Base', file.base, 'base'], ['Theirs', file.theirs, 'incoming']] as const).map(([label, text, tone]) => <div key={label} className="conflict-side">
        <div className={`conflict-side-label is-${tone}`}>{label}</div>
        {text === null ? <p className="conflict-missing">Not present on this side</p> : <Lines lines={text.replace(/\n$/, '').split('\n')} tone={tone}/>}
      </div>)}
    </div>}
  </div>;
}

export function ConflictTab({tab}: {tab: WorkspaceTab}): React.ReactElement {
  const folderId = tab.folderId!, path = tab.path!;
  const folder = useStoreSelector(state => state.snapshot?.folders.find(item => item.id === folderId));
  const [file, setFile] = useState<GitConflictFile>();
  const [error, setError] = useState('');
  const [choices, setChoices] = useState<Map<string, ConflictChoice>>(new Map());
  const [busy, setBusy] = useState<'save' | 'resolve' | null>(null);
  const [notice, setNotice] = useState('');
  const [gone, setGone] = useState(false);
  const token = useRef(0);
  const load = useCallback(() => {
    const mine = ++token.current;
    setError('');
    invoke('git.conflictFile', {folderId, path}).then(value => { if (mine !== token.current) return; setFile(value); setChoices(new Map()); setGone(false); }, cause => {
      if (mine !== token.current) return;
      const message = cleanIpcError(cause) || 'The conflict could not be read.';
      if (/no conflict to resolve|no longer conflicted/i.test(message)) setGone(true); else setError(message);
    });
  }, [folderId, path]);
  useEffect(() => { load(); return () => { token.current++; }; }, [load]);
  const parsed = useMemo(() => file ? parseConflicts(file.working) : undefined, [file]);
  const conflictBlocks = useMemo(() => parsed?.blocks.filter((block): block is Extract<ConflictBlock, {kind: 'conflict'}> => block.kind === 'conflict') ?? [], [parsed]);
  const resolvedCount = conflictBlocks.filter(block => choices.has(block.id)).length;
  const allResolved = conflictBlocks.length > 0 && resolvedCount === conflictBlocks.length;
  const choose = (id: string, choice: ConflictChoice | undefined) => setChoices(previous => { const next = new Map(previous); if (choice === undefined) next.delete(id); else next.set(id, choice); return next; });
  const write = async (markResolved: boolean) => {
    if (!file || !parsed || busy) return;
    setBusy(markResolved ? 'resolve' : 'save'); setError(''); setNotice('');
    try {
      const content = applyConflictChoices(parsed, choices);
      const state = await invoke('git.conflictWrite', {folderId, path, content, revision: file.revision, markResolved});
      void loadGitChanges(folderId);
      if (markResolved) {
        notifySuccess(`${path} marked resolved`);
        const next = state.files[0];
        if (next) openConflictTab(folderId, next.path);
        closeTab(tab.id);
      } else { setNotice('Saved. The file keeps its markers until every conflict is chosen and marked resolved.'); load(); }
    } catch (cause) { setError(cleanIpcError(cause) || 'The file could not be written.'); }
    finally { setBusy(null); }
  };
  const status = file ? {UU: 'Both modified', AA: 'Both added', DD: 'Both deleted', AU: 'Added by us', UA: 'Added by them', DU: 'Deleted by us', UD: 'Deleted by them'}[file.status] ?? file.status : '';
  const oneSided = file && (file.ours === null || file.theirs === null);
  return <div className="conflict-view" data-testid="conflict-view">
    <header className="conflict-head">
      <FileTypeIcon path={path}/>
      <span className="conflict-head-path" title={`${folder?.name ?? ''}/${path}`}>{path}</span>
      {file && <span className="conflict-head-kind">{status}</span>}
      {file && conflictBlocks.length > 0 && <span className="conflict-head-count" data-testid="conflict-progress">{resolvedCount} of {conflictBlocks.length} resolved</span>}
      <Tip label="Reload from disk"><button type="button" className="icon-button" aria-label="Reload conflict" disabled={!!busy} onClick={load}><RefreshCw size={12}/></button></Tip>
    </header>
    {error && <p className="git-action-error conflict-error" role="alert"><TriangleAlert size={12} aria-hidden="true"/>{gitErrorMessage(error) ?? error}</p>}
    {notice && <p className="conflict-notice" role="status">{notice}</p>}
    {gone && <ResourceState kind="empty" message="This file is no longer conflicted." compact><button type="button" onClick={() => closeTab(tab.id)}>Close</button></ResourceState>}
    {!file && !gone && !error && <ResourceState kind="loading" label={`Loading ${path}`} rows={4} compact/>}
    {file && parsed && !gone && <>
      {file.truncated && <div className="pane-truncated">This file is larger than 512 KB; resolve it in an editor.</div>}
      {oneSided && <p className="conflict-notice">{file.ours === null ? 'This file was deleted on your side' : 'This file was deleted on the incoming side'} and changed on the other. Keep the file by marking it resolved, or delete it and mark resolved.</p>}
      <SidePanes file={file}/>
      <div className="conflict-body">
        {conflictBlocks.length === 0 && <p className="conflict-notice">No conflict markers in the working file. If it already looks right, mark it resolved.</p>}
        {parsed.blocks.map(block => block.kind === 'text'
          ? <ContextBlock key={block.id} lines={block.lines}/>
          : <ConflictBlockView key={block.id} block={block} index={conflictBlocks.indexOf(block)} total={conflictBlocks.length} choice={choices.get(block.id)} currentLabel={block.currentLabel} incomingLabel={block.incomingLabel} onChoose={choice => choose(block.id, choice)}/>)}
      </div>
      <footer className="conflict-foot">
        <button type="button" disabled={!!busy || file.truncated} onClick={() => void write(false)}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
        <button type="button" className="is-primary" disabled={!!busy || file.truncated || (conflictBlocks.length > 0 && !allResolved)} title={conflictBlocks.length > 0 && !allResolved ? 'Choose a resolution for every conflict first' : 'Write the file and stage it (git add)'} onClick={() => void write(true)}>{busy === 'resolve' ? 'Marking…' : 'Mark resolved'}</button>
      </footer>
    </>}
  </div>;
}
