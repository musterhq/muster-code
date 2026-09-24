import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useVirtualizer} from '@tanstack/react-virtual';
import {ArrowLeftRight, ArrowRight, Check, Copy, GitCommitHorizontal, GitMerge, History, RefreshCw} from 'lucide-react';
import {GIT_EMPTY_TREE, type GitCommit, type GitCommitDetail, type GitCompareResult, type GitHistoryFile, type GitRefDiff} from '../../shared/domains/git-protocol';
import {invoke, subscribe} from '../bridge';
import {editorFromFile} from '../diffEditorModel';
import {buildCumulativeFileDiff} from '../inlineFileDiffModel';
import type {WorkspaceTab} from '../store';
import {useStoreSelector} from '../useStore';
import {compactAge, exactTime} from '../relativeTime';
import {DiffEditorView} from './FileDiffEditor';
import {commitGraph, gitFileStatus, LANE_COLORS, type GraphRow} from '../gitStatus';
import {GitCounts, GitRefChip, GitStatusBadge, GitSync} from './GitStatus';
import {Tip} from './Tooltip';
import {FileTypeIcon} from './FileTypeIcon';
import {ResourceState} from './ResourceState';
import {cleanIpcError, gitErrorMessage, isNotGitRepository} from './resourceErrors';
import './git-history.css';

const PAGE = 100, ROW = 26;

// ---------------------------------------------------------------------------
// Shared pieces: a file at two refs, and a file list that shows one diff at a time.

/** One file between two refs, rendered by the same inline diff editor the review views use (GIT-11). */
export function RefFileDiff({folderId, base, head, file}: {folderId: string; base: string; head: string; file: GitHistoryFile}): React.ReactElement {
  const [state, setState] = useState<{key: string; value?: GitRefDiff; error?: string}>();
  const key = `${base}..${head}:${file.path}`;
  useEffect(() => {
    let live = true;
    invoke('git.refDiff', {folderId, base, head, path: file.path, ...(file.previousPath ? {previousPath: file.previousPath} : {})})
      .then(value => { if (live) setState({key, value}); }, cause => { if (live) setState({key, error: cleanIpcError(cause) || 'The diff could not be read.'}); });
    return () => { live = false; };
  }, [folderId, base, head, file.path, file.previousPath, key]);
  const current = state?.key === key ? state : undefined;
  const model = useMemo(() => {
    if (!current?.value || current.value.binary) return undefined;
    const cumulative = buildCumulativeFileDiff(current.value.before, current.value.after);
    return cumulative.state === 'unavailable' ? null : editorFromFile(cumulative.rows);
  }, [current]);
  if (current?.error) return <ResourceState kind="error" message={gitErrorMessage(current.error) ?? current.error} compact/>;
  if (!current?.value) return <ResourceState kind="loading" label={`Loading ${file.path}`} rows={4} compact/>;
  if (current.value.binary) return <div className="git-history-note" role="status">Binary file · no text diff</div>;
  if (model === null) return <div className="git-history-note" role="status">This file is too large to diff in the app.</div>;
  if (model && !model.hunks.length) return <div className="git-history-note" role="status">{file.previousPath ? 'Renamed without content changes.' : 'No text changes.'}</div>;
  return <div className="git-history-diff" data-testid="ref-file-diff">
    {current.value.truncated && <div className="pane-truncated">Partial preview: first 512 KB per side.</div>}
    {model && <DiffEditorView model={model} path={file.path} maxHeight={null} folderId={folderId} label={`${file.previousPath ? `${file.previousPath} → ` : ''}${file.path}`}/>}
  </div>;
}


/** The files of a commit or compare; clicking one opens its diff underneath (one at a time, like a PR file list). */
export function RefFileList({folderId, base, head, files, truncated}: {folderId: string; base: string; head: string; files: GitHistoryFile[]; truncated: boolean}): React.ReactElement {
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => setSelected(null), [base, head]);
  const adds = files.reduce((n, f) => n + (f.adds ?? 0), 0), dels = files.reduce((n, f) => n + (f.dels ?? 0), 0);
  const current = files.find(file => file.path === selected);
  return <section className="git-history-files">
    <header className="files-section-head">
      <span>{files.length} {files.length === 1 ? 'file' : 'files'}{(adds || dels) ? <GitCounts adds={adds} dels={dels} className="git-history-stat"/> : null}</span>
    </header>
    {files.length === 0 && <ResourceState kind="empty" message="No files changed." compact/>}
    <ul className="changes-list git-history-file-list">
      {files.map(file => {
        const name = file.path.split('/').pop() ?? file.path;
        const directory = file.path.slice(0, file.path.length - name.length).replace(/\/$/, '');
        const status = gitFileStatus(file.status);
        return <li key={file.path}>
          <button type="button" className={`tree-row change-row${file.path === selected ? ' is-selected' : ''}`} aria-pressed={file.path === selected} title={`${status.label}: ${file.previousPath ? `${file.previousPath} → ` : ''}${file.path}`} onClick={() => setSelected(prev => prev === file.path ? null : file.path)}>
            <FileTypeIcon path={file.path}/>
            <span className="change-path">{file.previousPath ? <><span className="change-previous">{file.previousPath}</span><ArrowRight size={11} aria-label="renamed to" className="change-arrow"/>{file.path}</> : <><span className={status.tone === 'deleted' ? 'git-name-deleted' : undefined}>{name}</span>{directory && <span className="change-dir">{directory}</span>}</>}</span>
            {file.binary ? <span className="change-binary">Binary</span> : <GitCounts adds={file.adds} dels={file.dels}/>}
            <GitStatusBadge resolved={status}/>
          </button>
        </li>;
      })}
    </ul>
    {truncated && <p className="file-format-note" role="status">Showing the first 1,000 files.</p>}
    {current && <RefFileDiff key={current.path} folderId={folderId} base={base} head={head} file={current}/>}
  </section>;
}

// ---------------------------------------------------------------------------
// Commit list (virtualised, paged) and detail.

/** What the History list knows about branches, to colour a decoration as current / local / remote. */
interface RefContext {current?: string | null; local?: ReadonlySet<string>}
const RefCtx = React.createContext<RefContext>({});
function RefBadge({name}: {name: string}): React.ReactElement {
  const refs = React.useContext(RefCtx);
  return <GitRefChip name={name} current={refs.current} local={refs.local}/>;
}

const LANE = 10, MAX_LANES = 8;
/** The lane column of one row: lines in, out, and between lanes, and the commit's dot (hollow for a merge). */
function GraphCell({row, width}: {row: GraphRow; width: number}): React.ReactElement {
  const x = (lane: number) => lane * LANE + LANE / 2;
  const y = (half: number) => (half * ROW) / 2;
  const lanes = Math.min(width, MAX_LANES);
  return <svg className="git-graph" width={lanes * LANE} height={ROW} viewBox={`0 0 ${lanes * LANE} ${ROW}`} aria-hidden="true">
    {row.segments.filter(segment => segment.x1 < MAX_LANES && segment.x2 < MAX_LANES).map((segment, index) => segment.x1 === segment.x2
      ? <line key={index} className={`git-lane-${segment.color % LANE_COLORS}`} x1={x(segment.x1)} y1={y(segment.y1)} x2={x(segment.x2)} y2={y(segment.y2)}/>
      : <path key={index} className={`git-lane-${segment.color % LANE_COLORS}`} d={`M ${x(segment.x1)} ${y(segment.y1)} C ${x(segment.x1)} ${y(segment.y1) + ROW / 4}, ${x(segment.x2)} ${y(segment.y2) - ROW / 4}, ${x(segment.x2)} ${y(segment.y2)}`}/>)}
    {row.lane < MAX_LANES && <circle className={`git-graph-dot git-lane-${row.color % LANE_COLORS}${row.merge ? ' is-merge' : ''}`} cx={x(row.lane)} cy={ROW / 2} r={row.merge ? 3.6 : 3.2}/>}
  </svg>;
}

function CommitRow({commit, selected, onSelect, now, graph, graphWidth}: {commit: GitCommit; selected: boolean; onSelect: () => void; now: number; graph?: GraphRow; graphWidth: number}): React.ReactElement {
  const merge = commit.parents.length > 1;
  return <button type="button" className={`git-history-row${selected ? ' is-selected' : ''}${commit.head ? ' is-head' : ''}${merge ? ' is-merge' : ''}`} aria-pressed={selected} onClick={onSelect} title={`${merge ? 'Merge commit · ' : ''}${commit.subject}\n${commit.author} · ${exactTime(commit.authoredAt)}`}>
    {graph && <GraphCell row={graph} width={graphWidth}/>}
    <span className="git-history-sha">{commit.short}</span>
    {merge && <GitMerge size={11} className="git-history-merge" aria-label="Merge commit"/>}
    <span className="git-history-subject">{commit.subject}</span>
    {commit.head && <GitRefChip name="HEAD" kind="head"/>}
    {commit.refs.slice(0, 3).map(ref => <RefBadge key={ref} name={ref}/>)}
    {commit.refs.length > 3 && <span className="git-ref is-local" title={commit.refs.slice(3).join(', ')}>+{commit.refs.length - 3}</span>}
    <span className="git-history-author">{commit.author}</span>
    <span className="git-history-age">{compactAge(commit.authoredAt, now)}</span>
  </button>;
}

function CommitDetailView({folderId, sha}: {folderId: string; sha: string}): React.ReactElement {
  const [detail, setDetail] = useState<{sha: string; value?: GitCommitDetail; error?: string}>();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    invoke('git.commitDetail', {folderId, sha}).then(value => { if (live) setDetail({sha, value}); }, cause => { if (live) setDetail({sha, error: cleanIpcError(cause) || 'The commit could not be read.'}); });
    return () => { live = false; };
  }, [folderId, sha]);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1400); return () => clearTimeout(timer); }, [copied]);
  const current = detail?.sha === sha ? detail : undefined;
  if (current?.error) return <ResourceState kind="error" message={gitErrorMessage(current.error) ?? current.error} compact/>;
  if (!current?.value) return <ResourceState kind="loading" label="Loading commit" rows={3} compact/>;
  const {commit, body, base, files, truncated} = current.value;
  const description = body.startsWith(commit.subject) ? body.slice(commit.subject.length).trim() : body;
  return <div className="git-history-detail" data-testid="commit-detail">
    <div className="git-history-detail-head">
      <h3 className="git-history-detail-subject">{commit.subject}</h3>
      <div className="git-history-meta">
        <span>{commit.author}</span>
        <span className="git-history-dot" aria-hidden="true">·</span>
        <span title={exactTime(commit.authoredAt)}>{exactTime(commit.authoredAt)}</span>
        <span className="git-history-dot" aria-hidden="true">·</span>
        <button type="button" className="git-history-copy" title="Copy full SHA" onClick={() => void invoke('clipboard.write', {text: commit.sha}).then(() => setCopied(true), () => {})}>
          <span className="git-history-sha">{commit.short}</span>{copied ? <Check size={11} aria-label="Copied"/> : <Copy size={11} aria-hidden="true"/>}
        </button>
        {commit.parents.length > 1 && <span className="git-history-merge-tag" title={`Merge of ${commit.parents.length} parents; the diff is against the first`}><GitMerge size={10} aria-hidden="true"/>Merge</span>}
        {commit.refs.map(ref => <RefBadge key={ref} name={ref}/>)}
      </div>
      {description && <pre className="git-history-body">{description}</pre>}
    </div>
    <RefFileList folderId={folderId} base={base ?? GIT_EMPTY_TREE} head={commit.sha} files={files} truncated={truncated}/>
  </div>;
}

function CommitList({folderId, selected, onSelect, reloadKey}: {folderId: string; selected: string | null; onSelect: (sha: string) => void; reloadKey: number}): React.ReactElement {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const loading = useRef(false), token = useRef(0);
  const now = useMemo(() => Date.now(), [commits]);
  const load = useCallback(async (skip: number) => {
    if (loading.current) return;
    loading.current = true;
    const mine = ++token.current;
    if (skip === 0) setPhase('loading');
    try {
      const page = await invoke('git.log', {folderId, skip, limit: PAGE});
      if (mine !== token.current) return;
      setCommits(previous => skip === 0 ? page.commits : [...previous, ...page.commits]);
      setHasMore(page.hasMore); setPhase('ready'); setError('');
    } catch (cause) {
      if (mine !== token.current) return;
      setError(cleanIpcError(cause) || 'History could not be read.'); setPhase('error');
    } finally { if (mine === token.current) loading.current = false; }
  }, [folderId]);
  useEffect(() => { token.current++; loading.current = false; void load(0); }, [load, reloadKey]);
  const scroller = useRef<HTMLDivElement>(null);
  const graph = useMemo(() => commitGraph(commits), [commits]);
  const graphWidth = useMemo(() => graph.reduce((max, row) => Math.max(max, row.width), 1), [graph]);
  const virtualizer = useVirtualizer({count: commits.length + (hasMore ? 1 : 0), getScrollElement: () => scroller.current, estimateSize: () => ROW, overscan: 12});
  const items = virtualizer.getVirtualItems();
  const lastIndex = items[items.length - 1]?.index ?? -1;
  useEffect(() => { if (hasMore && lastIndex >= commits.length - 10) void load(commits.length); }, [hasMore, lastIndex, commits.length, load]);
  if (phase === 'error') return <ResourceState kind="error" message={gitErrorMessage(error) ?? error} onRetry={() => void load(0)} compact/>;
  if (phase === 'loading' && !commits.length) return <ResourceState kind="loading" label="Loading history" rows={6} compact/>;
  if (!commits.length) return <ResourceState kind="empty" message="No commits yet. Your first commit will appear here." compact/>;
  return <div className="git-history-list" ref={scroller} role="list" aria-label="Commits" data-testid="commit-list">
    <div style={{height: virtualizer.getTotalSize(), position: 'relative'}}>
      {items.map(item => {
        const commit = commits[item.index];
        return <div key={commit?.sha ?? 'more'} role="listitem" style={{position: 'absolute', top: 0, left: 0, width: '100%', height: item.size, transform: `translateY(${item.start}px)`}}>
          {commit ? <CommitRow commit={commit} selected={commit.sha === selected} now={now} graph={graph[item.index]} graphWidth={graphWidth} onSelect={() => onSelect(commit.sha)}/> : <div className="git-history-more" role="status">Loading more…</div>}
        </div>;
      })}
    </div>
  </div>;
}

// ---------------------------------------------------------------------------
// Compare picker: any two refs (branch, tag, sha, HEAD~n).

function ComparePane({folderId, reloadKey}: {folderId: string; reloadKey: number}): React.ReactElement {
  const [base, setBase] = useState(''), [head, setHead] = useState('HEAD');
  const [branches, setBranches] = useState<string[]>([]);
  const [result, setResult] = useState<{key: string; value?: GitCompareResult; error?: string; busy?: boolean}>();
  useEffect(() => {
    let live = true;
    invoke('git.branches', {folderId}).then(list => { if (!live) return; setBranches(list.local.map(branch => branch.name)); setBase(previous => previous || (list.local.find(branch => /^(main|master|develop)$/.test(branch.name))?.name ?? list.local.find(branch => branch.name !== list.current)?.name ?? '')); }, () => {});
    return () => { live = false; };
  }, [folderId, reloadKey]);
  const compare = (event?: React.FormEvent) => {
    event?.preventDefault();
    const key = `${base.trim()}...${head.trim()}`;
    if (!base.trim() || !head.trim()) return;
    setResult({key, busy: true});
    invoke('git.compare', {folderId, base: base.trim(), head: head.trim()}).then(value => setResult(prev => prev?.key === key ? {key, value} : prev), cause => setResult(prev => prev?.key === key ? {key, error: cleanIpcError(cause) || 'The refs could not be compared.'} : prev));
  };
  const swap = () => { const nextBase = head; setHead(base); setBase(nextBase); setResult(undefined); };
  const listId = `git-compare-refs-${folderId}`;
  return <div className="git-compare" data-testid="git-compare">
    <form className="git-compare-form" onSubmit={compare}>
      <label className="git-compare-field"><Tip label="The starting point, usually the branch you will merge into"><span>Base</span></Tip><input type="text" list={listId} value={base} placeholder="main" spellCheck={false} maxLength={256} onChange={event => setBase(event.target.value)} aria-label="Base ref"/></label>
      <Tip label="Swap"><button type="button" className="icon-button" aria-label="Swap base and head" onClick={swap}><ArrowLeftRight size={13}/></button></Tip>
      <label className="git-compare-field"><Tip label="What changed on top of the base, usually your branch"><span>Head</span></Tip><input type="text" list={listId} value={head} placeholder="HEAD" spellCheck={false} maxLength={256} onChange={event => setHead(event.target.value)} aria-label="Head ref"/></label>
      <datalist id={listId}>{['HEAD', ...branches].map(name => <option key={name} value={name}/>)}</datalist>
      <button type="submit" className="git-compare-submit" disabled={!base.trim() || !head.trim() || result?.busy}>{result?.busy ? 'Comparing…' : 'Compare'}</button>
    </form>
    {result?.error && <ResourceState kind="error" message={gitErrorMessage(result.error) ?? result.error} compact/>}
    {result?.value && <div className="git-compare-result">
      <div className="git-history-meta">
        <span className="git-history-sha" title={result.value.base.sha}>{result.value.base.ref}</span>
        <ArrowRight size={11} aria-hidden="true"/>
        <span className="git-history-sha" title={result.value.head.sha}>{result.value.head.ref}</span>
        <span className="git-history-dot" aria-hidden="true">·</span>
        {result.value.mergeBase
          ? <><span>{result.value.ahead} ahead, {result.value.behind} behind</span><GitSync ahead={result.value.ahead} behind={result.value.behind}/></>
          : <span>Unrelated histories</span>}
      </div>
      <RefFileList folderId={folderId} base={result.value.base.sha} head={result.value.head.sha} files={result.value.files} truncated={result.value.truncated}/>
    </div>}
  </div>;
}

// ---------------------------------------------------------------------------
// The tab: History | Compare.

export function GitHistoryTab({tab, embedded = false}: {tab: WorkspaceTab; embedded?: boolean}): React.ReactElement {
  const folderId = tab.folderId!;
  const folder = useStoreSelector(state => state.snapshot?.folders.find(item => item.id === folderId));
  const [mode, setMode] = useState<'history' | 'compare'>('history');
  const [selected, setSelected] = useState<string | null>(tab.sha ?? null);
  const [reloadKey, setReloadKey] = useState(0);
  const [notRepo, setNotRepo] = useState(false);
  useEffect(() => { if (tab.sha) { setSelected(tab.sha); setMode('history'); } }, [tab.sha]);
  // A commit landing in this folder (Repository panel commit, a chat's turn) refreshes the list; nothing polls.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = subscribe(event => { if (event.type === 'workspaceChanged' && event.folderId === folderId) { clearTimeout(timer); timer = setTimeout(() => setReloadKey(n => n + 1), 300); } });
    return () => { off(); clearTimeout(timer); };
  }, [folderId]);
  useEffect(() => {
    let live = true;
    invoke('git.info', {folderId}).then(() => { if (live) setNotRepo(false); }, cause => { if (live && isNotGitRepository(cause)) setNotRepo(true); });
    return () => { live = false; };
  }, [folderId, reloadKey]);
  const [refs, setRefs] = useState<RefContext>({});
  useEffect(() => {
    let live = true;
    invoke('git.branches', {folderId}).then(list => { if (live && list) setRefs({current: list.current, local: new Set(list.local.map(branch => branch.name))}); }, () => {});
    return () => { live = false; };
  }, [folderId, reloadKey]);
  if (notRepo) return <div className="files-tab git-history-tab"><div className="resource-neutral" role="status"><History size={18} aria-hidden="true"/><strong>Not a Git repository</strong><span>History appears once this folder is a Git repository.</span></div></div>;
  return <RefCtx.Provider value={refs}><div className={`files-tab git-history-tab${embedded ? ' is-embedded' : ''}`} data-testid="git-history">
    <header className="git-history-head">
      <div className="git-history-modes" role="tablist" aria-label="History view">
        <Tip label="Every commit on this branch, newest first"><button type="button" role="tab" aria-selected={mode === 'history'} className={mode === 'history' ? 'is-active' : ''} onClick={() => setMode('history')}><GitCommitHorizontal size={13} aria-hidden="true"/>Commits</button></Tip>
        <Tip label="What differs between two branches, tags or commits"><button type="button" role="tab" aria-selected={mode === 'compare'} className={mode === 'compare' ? 'is-active' : ''} onClick={() => setMode('compare')}><ArrowLeftRight size={13} aria-hidden="true"/>Compare</button></Tip>
      </div>
      {embedded ? <span className="git-history-legend" aria-label="Ref colours"><GitRefChip name="HEAD" kind="head"/><GitRefChip name="branch" kind="local"/><GitRefChip name="remote" kind="remote"/><GitRefChip name="tag" kind="tag"/></span>
        : <span className="git-history-folder" title={folder?.path}>{folder?.name ?? tab.title}</span>}
      <Tip label="Refresh history"><button type="button" className="icon-button" aria-label="Refresh history" onClick={() => setReloadKey(n => n + 1)}><RefreshCw size={12}/></button></Tip>
    </header>
    {mode === 'history'
      ? <div className="git-history-split">
        <CommitList folderId={folderId} selected={selected} onSelect={setSelected} reloadKey={reloadKey}/>
        {selected
          ? <CommitDetailView key={selected} folderId={folderId} sha={selected}/>
          : <div className="git-history-placeholder" role="status">Select a commit to see what it changed.</div>}
      </div>
      : <ComparePane folderId={folderId} reloadKey={reloadKey}/>}
  </div></RefCtx.Provider>;
}
