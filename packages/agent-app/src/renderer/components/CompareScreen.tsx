/**
 * #175 compare view: the runs of one prompt on several agents side by side (status, time, tokens, reply, changed files,
 * tests and CI), one file's diff across the runs, and "Use this one", which merges the picked run's branch into the
 * original branch after a confirm that offers to keep each other run's branch.
 */
import {ArrowLeft, GitCompare, GitMerge, MessageSquare} from 'lucide-react';
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import type {CompareChoice, CompareRunDetail, ComparisonDetail} from '../../shared/domains/compare-protocol';
import type {ReviewFileDiff} from '../../shared/domains/review-protocol';
import {formatUsd} from '../../shared/model-catalog';
import {invoke, subscribe} from '../bridge';
import {editorFromFile} from '../diffEditorModel';
import {buildCumulativeFileDiff} from '../inlineFileDiffModel';
import {closeSettings, getState, notifyError, notifySuccess, openChangesTab, openConflictTab, selectChat} from '../store';
import {DiffStat, formatCount} from './DiffStat';
import {DiffEditorView} from './FileDiffEditor';
import {FileTypeIcon} from './FileTypeIcon';
import {StatusDot} from './StatusDot';
import {formatDuration} from './turnStatusModel';
import './compare.css';

/** Keep or discard for every other run that has work (or that the user chose to keep). */
const choicesFor = (runs: readonly CompareRunDetail[], winner: string, keep: Record<string, boolean>): Record<string, CompareChoice> =>
  Object.fromEntries(runs.filter(run => run.chatId !== winner && (run.hasWork || keep[run.chatId])).map(run => [run.chatId, keep[run.chatId] ? 'keep' : 'discard']));
const errorText = (cause: unknown) => cause instanceof Error ? cause.message.replace(/^(?:[a-z]+\.[\w.]+:\s*)?(?:Error:\s*)?/i, '') : String(cause);

function RunDiff({id, run, path}: {id: string; run: CompareRunDetail; path: string}): React.ReactElement {
  const [diff, setDiff] = useState<ReviewFileDiff | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true; setDiff(null); setError('');
    invoke('compare.fileDiff', {id, chatId: run.chatId, path}).then(value => { if (live) setDiff(value ?? null); }, cause => { if (live) setError(errorText(cause)); });
    return () => { live = false; };
  }, [id, run.chatId, path]);
  const model = useMemo(() => {
    if (!diff || diff.binary || diff.truncated) return undefined;
    const cumulative = buildCumulativeFileDiff(diff.before, diff.after);
    return cumulative.state === 'unavailable' ? undefined : editorFromFile(cumulative.rows);
  }, [diff]);
  return <section className="compare-diff" data-compare-diff={run.chatId} aria-label={`${path} in ${run.model}`}>
    <header className="compare-diff-head"><strong>{run.model}</strong><span>{run.branch}</span></header>
    {error ? <p className="compare-muted" role="alert">{error}</p>
      : !diff ? <p className="compare-muted" role="status">Loading…</p>
      : diff.binary ? <p className="compare-muted">Binary file</p>
      : !model ? <p className="compare-muted">This file changed too much to show here. Open the run’s chat to review it.</p>
      : <DiffEditorView model={model} path={path} folderId={run.folderId} maxHeight={360}/>}
  </section>;
}

function RunColumn({run, picked, canPick, merging, onPick, onFile, selected}: {run: CompareRunDetail; picked: boolean; canPick: boolean; merging: boolean; onPick(): void; onFile(path: string): void; selected: string | null}): React.ReactElement {
  const cost = run.costUsd !== null ? ` · ${formatUsd(run.costUsd)}` : '';
  return <article className={`compare-run${picked ? ' is-picked' : ''}`} data-compare-run={run.chatId} aria-label={run.model}>
    <header className="compare-run-head">
      <span className="compare-run-model" title={`${run.providerId} · ${run.model}`}>{run.model}</span>
      <StatusDot status={run.status} showLabel/>
    </header>
    <dl className="compare-run-facts">
      <div><dt>Time</dt><dd>{run.durationMs === null ? '—' : formatDuration(run.durationMs)}</dd></div>
      <div><dt>Usage</dt><dd>{run.tokens === null ? '—' : `${formatCount(run.tokens)} tokens${cost}`}</dd></div>
      <div><dt>Changes</dt><dd>{run.files.length ? <>{run.files.length} {run.files.length === 1 ? 'file' : 'files'} <DiffStat adds={run.adds} dels={run.dels}/></> : 'No changes'}</dd></div>
    </dl>
    {(run.tests.length > 0 || run.ci) && <ul className="compare-run-checks" aria-label="Tests">
      {run.tests.map((test, index) => <li key={index} data-status={test.status}><code>{test.command}</code> <span>{test.status}</span></li>)}
      {run.ci && <li data-status={run.ci.failed ? 'failed' : run.ci.pending ? 'running' : 'passed'}>CI: {run.ci.passed} passed, {run.ci.failed} failed{run.ci.pending ? `, ${run.ci.pending} pending` : ''}</li>}
    </ul>}
    <div className="compare-run-reply" dir="auto">{run.reply ?? <span className="compare-muted">No reply yet</span>}</div>
    {run.error && <p className="compare-muted" role="status">{run.error}</p>}
    <ul className="compare-run-files" aria-label="Changed files">
      {run.files.map(file => <li key={file.path}>
        <button type="button" className={`compare-file${selected === file.path ? ' is-selected' : ''}`} data-compare-file={file.path} aria-pressed={selected === file.path} onClick={() => onFile(file.path)}>
          <FileTypeIcon path={file.path}/><span className="compare-file-path" title={file.path}>{file.path}</span><DiffStat adds={file.adds} dels={file.dels}/>
        </button>
      </li>)}
      {run.truncated && <li className="compare-muted">More files changed than can be listed.</li>}
    </ul>
    <footer className="compare-run-foot">
      <button type="button" className="compare-button" onClick={() => void selectChat(run.chatId)}><MessageSquare size={13} aria-hidden="true"/> Open chat</button>
      {picked ? <span className="compare-picked">{merging ? 'Merging' : 'Picked'}</span>
        : canPick && <button type="button" className="compare-button is-primary" onClick={onPick}><GitMerge size={13} aria-hidden="true"/> Use this one</button>}
    </footer>
  </article>;
}

export function CompareScreen({id}: {id: string}): React.ReactElement {
  const [detail, setDetail] = useState<ComparisonDetail | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{chatId: string; keep: Record<string, boolean>} | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(() => invoke('compare.get', {id}).then(value => { setDetail(value); setError(''); }, cause => setError(errorText(cause))), [id]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => subscribe(event => { if (event.type === 'comparison' && event.comparison.id === id) void reload(); }), [id, reload]);

  if (error && !detail) return <section className="compare-screen" aria-label="Compare runs"><p className="compare-muted" role="alert">{error}</p></section>;
  if (!detail) return <section className="compare-screen" aria-label="Compare runs"><p className="compare-muted" role="status">Loading…</p></section>;
  const {comparison, runs} = detail;
  const folder = getState().snapshot?.folders.find(entry => entry.id === comparison.folderId);
  const winner = comparison.winnerChatId;
  const canPick = comparison.state === 'ready';
  const stateLabel = {running: 'Runs are working', ready: 'Ready to pick', merging: 'Merge waiting on conflicts', merged: 'Merged'}[comparison.state];
  const openConfirm = (chatId: string) => setConfirming({chatId, keep: Object.fromEntries(runs.filter(run => run.chatId !== chatId).map(run => [run.chatId, run.hasWork]))});
  /** `others` is empty when finishing a merge: the runtime kept the choices made when it started. */
  const pick = async (chatId: string, others: Record<string, CompareChoice>) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await invoke('compare.pick', {id, chatId, others});
      setConfirming(null);
      if (result?.status === 'conflicts') {
        // The existing conflict view takes it from here; picking again after Continue finishes the clean-up.
        closeSettings();
        if (folder) { openChangesTab(folder.id, folder.name); if (result.files[0]) openConflictTab(folder.id, result.files[0]); }
        notifyError(new Error(`${result.files.length === 1 ? '1 file conflicts' : `${result.files.length} files conflict`} with ${comparison.baseBranch}. Resolve ${result.files.length === 1 ? 'it' : 'them'}, continue the merge, then press Finish merge here.`));
      } else if (result) notifySuccess(`Merged into ${comparison.baseBranch}`);
      await reload();
    } catch (cause) { notifyError(cause); }
    finally { setBusy(false); }
  };
  const winnerRun = runs.find(run => run.chatId === confirming?.chatId);
  const changedIn = selected ? runs.filter(run => run.files.some(file => file.path === selected)) : [];

  return <section className="compare-screen" aria-label="Compare runs">
    <header className="compare-head">
      <button type="button" className="icon-button" aria-label="Back" onClick={closeSettings}><ArrowLeft size={15}/></button>
      <GitCompare size={16} aria-hidden="true"/>
      <div className="compare-head-text">
        <h1>Compare runs</h1>
        <p title={comparison.prompt}>{comparison.prompt || 'No prompt text'}</p>
      </div>
      <span className="compare-head-base">From {comparison.baseBranch} · {comparison.baseSha.slice(0, 7)}{folder ? ` · ${folder.name}` : ''}</span>
      <span className="compare-head-state" data-state={comparison.state}>{stateLabel}</span>
      {comparison.state === 'merging' && winner && <button type="button" className="compare-button is-primary" disabled={busy} onClick={() => void pick(winner, {})}>Finish merge</button>}
    </header>
    <div className="compare-grid" style={{'--compare-columns': runs.length} as React.CSSProperties}>
      {runs.map(run => <RunColumn key={run.chatId} run={run} picked={winner === run.chatId} canPick={canPick && !busy} merging={comparison.state === 'merging'} selected={selected}
        onPick={() => openConfirm(run.chatId)} onFile={path => setSelected(current => current === path ? null : path)}/>)}
    </div>
    {selected && <section className="compare-diffs" aria-label={`Diff of ${selected}`}>
      <h2><FileTypeIcon path={selected}/> {selected}</h2>
      <div className="compare-grid" style={{'--compare-columns': Math.max(changedIn.length, 1)} as React.CSSProperties}>
        {changedIn.map(run => <RunDiff key={`${run.chatId}:${selected}`} id={id} run={run} path={selected}/>)}
      </div>
    </section>}
    {confirming && winnerRun && <div className="compare-confirm" data-compare-confirm role="dialog" aria-label="Use this run">
      <h2>Use {winnerRun.model}?</h2>
      <p>Merges <code>{winnerRun.branch}</code> into <code>{comparison.baseBranch}</code>{folder ? ` in ${folder.name}` : ''}. Changes the run did not commit are committed first.</p>
      <p>The other runs are archived and their worktrees removed.</p>
      <ul>
        {runs.filter(run => run.chatId !== winnerRun.chatId).map(run => <li key={run.chatId}>
          <label><input type="checkbox" data-keep={run.chatId} checked={!!confirming.keep[run.chatId]} onChange={event => { const checked = event.currentTarget.checked; setConfirming(current => current && {...current, keep: {...current.keep, [run.chatId]: checked}}); }}/>
            Keep branch <code>{run.branch}</code> ({run.model})</label>
          {!confirming.keep[run.chatId] && run.hasWork && <span className="compare-warning"> Its work will be deleted.</span>}
          {!run.hasWork && <span className="compare-muted"> No changes</span>}
        </li>)}
      </ul>
      <div className="compare-confirm-foot">
        <button type="button" className="compare-button" disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
        <button type="button" className="compare-button is-primary" disabled={busy} onClick={() => void pick(winnerRun.chatId, choicesFor(runs, winnerRun.chatId, confirming.keep))}>Merge and clean up</button>
      </div>
    </div>}
  </section>;
}
