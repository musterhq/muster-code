import React, {useMemo, useState} from 'react';
import {Check, SquareArrowOutUpRight, Undo2} from 'lucide-react';
import type {TimelineItem} from '../../../shared/protocol';
import type {ReviewChange} from '../../../shared/domains/review-protocol';
import type {ChangedFile} from '../../transcriptRows';
import {getState, openDiff, openFile} from '../../store';
import {invoke} from '../../bridge';
import {useStoreSelector} from '../../useStore';
import {keepHunks, latestBaseline, refreshReviewChanges, refreshRunMarks, setReviewBaseline, useChatBaselines, useReviewChanges, useRunMarks} from '../../reviewState';
import {basename, resolveToolPath, uniqueFileLabels} from '../toolPresentation';
import {FileTypeIcon} from '../FileTypeIcon';
import {formatCount} from '../DiffStat';
import {turnFileState} from '../TurnChanges';
import {TurnFileChanges} from '../TurnFileChanges';

function target(chatId: string, path: string) {
  const {snapshot} = getState(), chat = snapshot?.chats.find(entry => entry.id === chatId);
  return resolveToolPath(path, snapshot?.folders ?? [], chat?.folderId);
}

/** Five segments split between additions and removals, like a tiny bar chart of the change. */
export function MiniBar({adds, dels}: {adds: number; dels: number}) {
  const total = adds + dels;
  const green = total ? Math.round((adds / total) * 5) : 0;
  return <span className="tx-minibar" aria-hidden="true">{Array.from({length: 5}, (_, index) => <i key={index} className={!total ? '' : index < green ? 'is-add' : 'is-del'}/>)}</span>;
}

/** The latest turn's review against its pre-turn snapshot, when the folder has one: per-file Keep and Undo. */
function useTurnReview(chatId: string, latest: boolean) {
  const folderId = useStoreSelector(state => state.snapshot?.chats.find(chat => chat.id === chatId)?.folderId ?? undefined);
  const status = useStoreSelector(state => state.snapshot?.chats.find(chat => chat.id === chatId)?.status);
  const turn = latestBaseline(useChatBaselines(latest && folderId ? chatId : undefined, status), folderId);
  const review = useReviewChanges(turn ? folderId : undefined, turn ? {runId: turn.runId} : undefined).value;
  const marks = useRunMarks(turn?.runId);
  return turn && folderId && review ? {folderId, runId: turn.runId, files: review.files, marks} : undefined;
}

function FileRow({file, label, chatId, review, onAct, busy}: {file: ChangedFile; label: string; chatId: string; review?: ReturnType<typeof useTurnReview>; onAct: (kind: 'keep' | 'undo', change: ReviewChange) => void; busy: boolean}) {
  const to = target(chatId, file.movePath ?? file.path);
  const change = to && review ? review.files.find(entry => entry.path === to.path) : undefined;
  const state = review && to ? turnFileState(file.status, change, review.marks, to.path, true) : undefined;
  const counts = change ? {adds: change.adds, dels: change.dels} : file;
  const openReview = () => { if (!to) return; if (review) setReviewBaseline(to.folderId, {runId: review.runId}); void openDiff(to.folderId, to.path); };
  const pending = change && (state === 'proposed' || state === 'partly-kept');
  return <li className={`tx-file${state ? ` is-${state}` : ''}`}>
    <FileTypeIcon path={file.path} size={14}/>
    <button type="button" className="tx-file-name" disabled={!to} title={`${file.path} — Open the diff`} onClick={openReview}>{label}</button>
    <span className="tx-file-counts"><span className="tx-add">+{formatCount(counts.adds)}</span><span className="tx-del">-{formatCount(counts.dels)}</span></span>
    <MiniBar adds={counts.adds} dels={counts.dels}/>
    {state === 'kept' && <span className="tx-file-state">Kept</span>}
    {state === 'undone' && <span className="tx-file-state">Undone</span>}
    {pending && <span className="tx-file-actions">
      <button type="button" disabled={busy} title="Put this file back the way it was before the turn" onClick={() => onAct('undo', change)}><Undo2 size={12} aria-hidden="true"/>Undo</button>
      <button type="button" disabled={busy} title="Keep this file’s changes" onClick={() => onAct('keep', change)}><Check size={12} aria-hidden="true"/>Keep</button>
    </span>}
    {to && file.kind !== 'delete' && <button type="button" className="tx-file-open" aria-label={`Open ${basename(file.path)}`} title="Open the file" onClick={() => void openFile(to.folderId, to.path)}><SquareArrowOutUpRight size={12} aria-hidden="true"/></button>}
  </li>;
}

/**
 * Files a turn changed, under its reply: name (opens the side diff), +/- with a mini bar, and for the latest turn
 * Keep / Undo per file. The full diffs stay in the Diff tab unless the "Show file diffs inline" setting is on.
 */
export function ChangedFilesCard({files, chatId, turnId, latest, items}: {files: readonly ChangedFile[]; chatId: string; turnId: string; latest: boolean; items: readonly TimelineItem[]}) {
  const review = useTurnReview(chatId, latest);
  const inline = useStoreSelector(state => state.showInlineFileDiffs);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const all = useMemo(() => {
    if (!review) return files;
    const known = new Set(files.map(file => target(chatId, file.movePath ?? file.path)?.path ?? file.path));
    const extra = review.files.filter(change => !known.has(change.path)).map((change): ChangedFile => ({path: change.path, kind: change.status === 'deleted' ? 'delete' : change.status === 'added' || change.status === 'untracked' ? 'add' : 'update', adds: change.adds, dels: change.dels, status: 'completed'}));
    return [...files, ...extra];
  }, [files, review, chatId]);
  const labels = useMemo(() => uniqueFileLabels(all.map(file => file.path)), [all]);
  if (!all.length) return null;
  const act = async (kind: 'keep' | 'undo', change: ReviewChange) => {
    if (!review || busy) return;
    setBusy(true); setNotice('');
    try {
      if (kind === 'keep') await keepHunks(review.runId, change.path, ['*']);
      else if ((await invoke('review.undoFile', {folderId: review.folderId, path: change.path, baseline: {runId: review.runId}, expectedAfterHash: change.afterHash})).stale) setNotice(`${basename(change.path)} changed after the review was read, so it was left as is. Review it in the Diff tab.`);
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); void refreshRunMarks(review.runId); void refreshReviewChanges(review.folderId, {runId: review.runId}); }
  };
  const adds = all.reduce((n, file) => n + file.adds, 0), dels = all.reduce((n, file) => n + file.dels, 0);
  return <section className="tx-files" aria-label={`Files changed in this turn: ${all.length}`}>
    <header className="tx-files-head"><span>{all.length} {all.length === 1 ? 'file' : 'files'} changed</span><span className="tx-file-counts"><span className="tx-add">+{formatCount(adds)}</span><span className="tx-del">-{formatCount(dels)}</span></span></header>
    <ul className="tx-files-list">{all.map(file => <FileRow key={file.path} file={file} label={labels.get(file.path) ?? basename(file.path)} chatId={chatId} review={review} onAct={(kind, change) => void act(kind, change)} busy={busy}/>)}</ul>
    {notice && <p className="tx-files-notice" role="alert">{notice}</p>}
    {inline && <TurnFileChanges items={items} chatId={chatId} turnId={turnId} latest={latest} showPill={false}/>}
  </section>;
}
