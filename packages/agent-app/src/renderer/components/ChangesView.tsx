import React, {useEffect, useMemo, useRef, useState} from 'react';
import {ArrowRight, ChevronRight, Eye, GitCompare, ListCollapse, ListTree, Minus, Plus, RefreshCw, TriangleAlert} from 'lucide-react';
import type {ChangedFile, GitLocalFile} from '../../shared/protocol';
import type {ReviewChange} from '../../shared/domains/review-protocol';
import {loadGitChanges, openConflictTab, openDiff} from '../store';
import {useStore} from '../useStore';
import {nextChangeIndex} from '../changesNavigation';
import {baselineKey, refreshReviewChanges, setReviewBaseline, useReviewBaseline, useReviewChanges} from '../reviewState';
import {reviewViewedKey, useViewedVersion, viewedState} from '../diff-preferences';
import {porcelainStatus, type GitFileStatus} from '../gitStatus';
import {FileTypeIcon} from './FileTypeIcon';
import {isBinaryChange} from './filePresentation';
import {ResourceState} from './ResourceState';
import {ReviewBaselineMenu} from './ReviewBaselineMenu';
import {CommitBox, type GitRepository} from './GitActions';
import {GitCounts, GitStatusBadge} from './GitStatus';
import {Tip} from './Tooltip';
import {gitErrorMessage, isNotGitRepository} from './resourceErrors';
import {groupChanges, type ChangeRow} from './changeGrouping';
import {ChangeOwnerChip, ChangeOwnersProvider, useChangeOwners} from './ChangeOwners';

/** Calm, non-alarming state for a folder without Git: no raw IPC text, no compare picker, no counts. */
export function NotARepository({what = 'Changes are tracked'}: {what?: string}): React.ReactElement {
  return <div className="resource-neutral" role="status">
    <GitCompare size={18} aria-hidden="true"/>
    <strong>Not a Git repository</strong>
    <span>{what} once this folder is a Git repository. The agent’s own edits are still tracked per turn.</span>
  </div>;
}

function splitPath(path: string): {name: string; directory: string} {
  const name = path.replace(/\/$/, '').split('/').pop() ?? path;
  const directory = path.replace(/\/$/, '').slice(0, path.replace(/\/$/, '').length - name.length).replace(/\/$/, '');
  return {name, directory};
}

function PathLabel({path, previousPath, tone}: {path: string; previousPath?: string; tone?: string}): React.ReactElement {
  const {name, directory} = splitPath(path);
  return <span className="change-path">
    {previousPath
      ? <><span className="change-previous">{previousPath}</span><ArrowRight size={11} aria-label="renamed to" className="change-arrow"/>{path}</>
      : <><span className={tone === 'deleted' ? 'change-name git-name-deleted' : 'change-name'}>{name}{path.endsWith('/') ? '/' : ''}</span>{directory && <span className="change-dir">{directory}</span>}</>}
  </span>;
}

/** One changed-file row of a compare list (any "Compare against" choice other than the working tree). */
function ChangeFileRow({c, folderId, folderKey}: {c: ChangedFile; folderId: string; folderKey: string}): React.ReactElement {
  const meta = c as Partial<ReviewChange>;
  const binary = meta.binary === true || isBinaryChange(c);
  const viewed = viewedState(reviewViewedKey(folderId, c.path, folderKey), meta.revision);
  const mode = meta.oldMode && meta.newMode ? `${meta.oldMode} → ${meta.newMode}` : '';
  return <li>
    <button type="button" className="tree-row change-row" title={c.previousPath ? `${c.previousPath} → ${c.path}` : c.path} onClick={() => void openDiff(folderId, c.path)}>
      <FileTypeIcon path={c.path}/>
      <PathLabel path={c.path} previousPath={c.previousPath} tone={c.status}/>
      {binary ? <span className="change-binary">Binary</span> : <GitCounts adds={c.adds} dels={c.dels}/>}
      {mode && <span className="change-mode" title={`File mode ${mode}`}>mode</span>}
      <ChangeOwnerChip path={c.path}/>
      {viewed && <span className={`change-viewed is-${viewed}`} title={viewed === 'viewed' ? 'Viewed' : 'Changed since you viewed it'}>{viewed === 'viewed' ? <Eye size={11} aria-label="Viewed"/> : '•'}</span>}
      <GitStatusBadge status={c.status}/>
    </button>
  </li>;
}

/** An untracked directory with too many loose files to list one by one, collapsed like `git status` does. */
function ChangeGroupRow({group, folderId, folderKey, open: forced, onToggle}: {group: Extract<ChangeRow, {kind: 'group'}>; folderId: string; folderKey: string; open?: boolean; onToggle?: (open: boolean) => void}): React.ReactElement {
  const [own, setOwn] = useState(false);
  const open = forced ?? own;
  const setOpen = (next: boolean) => { setOwn(next); onToggle?.(next); };
  const adds = group.files.reduce((n, f) => n + (f.adds ?? 0), 0);
  return <li className="change-group">
    <button type="button" className="tree-row change-row change-group-toggle" aria-expanded={open} title={`${group.dir}/ — ${group.files.length} untracked files`} onClick={() => setOpen(!open)}>
      <FileTypeIcon path={`${group.dir}/`}/>
      <span className="change-path"><span className="change-group-name">{group.dir}/</span></span>
      <GitCounts adds={adds} dels={0}/>
      <span className="change-group-count">{group.files.length} files</span>
      <GitStatusBadge status="untracked"/>
    </button>
    {open && <ul className="changes-list change-group-files">{group.files.map(c => <ChangeFileRow key={c.path} c={c} folderId={folderId} folderKey={folderKey}/>)}</ul>}
  </li>;
}

type Side = 'staged' | 'unstaged' | 'conflict';

/** A working-tree row: status letter for its side, counts, and Stage / Unstage on the right. */
function StatusRow({file, side, folderId, change, under, repo}: {file: GitLocalFile; side: Side; folderId: string; change?: ChangedFile; under: ChangedFile[]; repo: GitRepository}): React.ReactElement {
  const status: GitFileStatus = porcelainStatus(file, side === 'staged' ? 'staged' : 'unstaged');
  const directory = file.untracked && file.path.endsWith('/');
  const [open, setOpen] = useState(false);
  const meta = change as Partial<ReviewChange> | undefined;
  const binary = !!change && (meta?.binary === true || isBinaryChange(change));
  const adds = directory ? under.reduce((n, f) => n + (f.adds ?? 0), 0) : change?.adds;
  const dels = directory ? 0 : change?.dels;
  const disabled = !!repo.busy || repo.loading;
  const open_ = () => {
    if (side === 'conflict') { openConflictTab(folderId, file.path); return; }
    if (directory) { setOpen(value => !value); return; }
    // Open the diff for the side the row stands for: staged rows show index vs HEAD, the rest the working tree vs the index.
    if (!file.untracked) setReviewBaseline(folderId, side === 'staged' ? 'staged' : 'unstaged');
    void openDiff(folderId, file.path);
  };
  const title = side === 'conflict' ? `${file.path}: both sides changed this file. Open to resolve.`
    : directory ? `${file.path} (new folder; staging it adds every file inside)`
    : `${status.label}: ${file.previousPath ? `${file.previousPath} → ` : ''}${file.path}`;
  return <li className={`change-item is-${side}`}>
    <div className="change-item-row">
      <button type="button" className="tree-row change-row" data-side={side} aria-expanded={directory ? open : undefined} title={title} onClick={open_}>
        {directory ? <ChevronRight size={12} className="change-chevron" data-open={open || undefined} aria-hidden="true"/> : null}
        <FileTypeIcon path={file.path} directory={directory}/>
        <PathLabel path={file.path} previousPath={file.previousPath} tone={status.tone}/>
        {directory && under.length > 0 && <span className="change-group-count">{under.length} files</span>}
        {!directory && <ChangeOwnerChip path={file.path}/>}
        {binary ? <span className="change-binary">Binary</span> : <GitCounts adds={adds} dels={dels}/>}
        <GitStatusBadge resolved={status}/>
      </button>
      {side === 'conflict'
        ? <Tip label="Open the conflict resolver"><button type="button" className="change-action is-text" onClick={open_}>Resolve</button></Tip>
        : side === 'staged'
          ? <Tip label="Unstage: keep the change but leave it out of the next commit"><button type="button" className="icon-button change-action" disabled={disabled} aria-label={`Unstage ${file.path}`} onClick={() => void repo.unstage([file.path])}><Minus size={13}/></button></Tip>
          : <Tip label="Stage: include this change in the next commit"><button type="button" className="icon-button change-action" disabled={disabled} aria-label={`Stage ${file.path}`} onClick={() => void repo.stage([file.path])}><Plus size={13}/></button></Tip>}
    </div>
    {directory && open && under.length > 0 && <ul className="changes-list change-group-files">{under.map(c => <li key={c.path}>
      <button type="button" className="tree-row change-row" title={c.path} onClick={() => void openDiff(folderId, c.path)}>
        <FileTypeIcon path={c.path}/><PathLabel path={c.path.slice(file.path.length)}/><GitCounts adds={c.adds} dels={c.dels}/><GitStatusBadge status="untracked"/>
      </button>
    </li>)}</ul>}
  </li>;
}

const SECTION_COPY: Record<Side, {title: string; hint: string}> = {
  conflict: {title: 'Conflicts', hint: 'Files both sides changed. Resolve each one, then continue the merge or rebase.'},
  staged: {title: 'Staged', hint: 'Staged changes go into the next commit.'},
  unstaged: {title: 'Not staged', hint: 'Changes in your working folder that the next commit leaves out until you stage them.'},
};

function StatusSection({side, files, children, action}: {side: Side; files: GitLocalFile[]; children: React.ReactNode; action?: React.ReactNode}): React.ReactElement | null {
  if (!files.length) return null;
  const copy = SECTION_COPY[side];
  return <section className={`git-section is-${side}`} aria-label={`${copy.title} (${files.length})`} data-testid={`git-section-${side}`}>
    <header className="git-section-head">
      <Tip label={copy.hint}><span className="git-section-title">{side === 'conflict' && <TriangleAlert size={12} aria-hidden="true"/>}{copy.title}<span className="git-section-count">{files.length}</span></span></Tip>
      {action}
    </header>
    <ul className="changes-list">{children}</ul>
  </section>;
}

/**
 * The Changes segment of the Git tab. Against the working tree (the default) it is split like a Git
 * client: Conflicts, Staged and Not staged, each row with its own Stage / Unstage, and the commit box on
 * top. "Compare against" switches to a read-only list of what differs from a branch, commit or agent turn.
 */
export function ChangesView({folderId, repo}: {folderId: string; repo: GitRepository}): React.ReactElement {
  const state = useStore();
  const [baseline, setBaseline] = useReviewBaseline(folderId);
  // HEAD keeps the store's list (shared with the rest of the app); every baseline also reads the review host, which adds
  // binary/mode metadata and per-file revisions for Viewed marks (DIF-11). Other baselines come only from the host.
  const review = useReviewChanges(folderId, baseline);
  const head = baseline === 'head';
  const stored = state.gitChanges[folderId];
  const changes = head && !review.value ? stored : {phase: review.error ? 'error' as const : review.value ? 'ready' as const : 'loading' as const, value: review.value?.files, error: review.error};
  useViewedVersion();
  const key = baselineKey(baseline);
  const refresh = () => { void refreshReviewChanges(folderId, baseline); if (head) void loadGitChanges(folderId); void repo.refresh(); };
  const rows = useMemo(() => changes?.value ? groupChanges(changes.value) : [], [changes?.value]);
  const byPath = useMemo(() => new Map((changes?.value ?? []).map(file => [file.path, file] as const)), [changes?.value]);
  // CHAT-06: which chat owns each pending edit (and which files two chats both edited).
  const ownedPaths = useMemo(() => [...new Set([...(changes?.value ?? []).map(file => file.path), ...(repo.status?.files ?? []).map(file => file.path)])].sort(), [changes?.value, repo.status]);
  const owners = useChangeOwners(folderId, ownedPaths);
  // DIF-06: Collapse all / Expand all for grouped rows, and ↑/↓ (j/k, Home/End) between file rows.
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({});
  const groups = rows.filter(row => row.kind === 'group');
  const anyOpen = groups.some(row => groupOpen[row.dir] === true);
  const setAllGroups = (open: boolean) => setGroupOpen(Object.fromEntries(groups.map(row => [row.dir, open])));
  const list = useRef<HTMLDivElement>(null);
  const onListKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if ((event.target as HTMLElement).closest?.('textarea, input')) return;
    const items = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('.change-row') ?? []).filter(row => row.offsetParent !== null || row.getClientRects().length > 0);
    const at = items.findIndex(row => row === document.activeElement);
    const next = nextChangeIndex(at, items.length, event.key);
    if (next === undefined) return;
    event.preventDefault();
    items[next]?.focus();
    items[next]?.scrollIntoView?.({block: 'nearest'});
  };
  useEffect(() => { if (head && !stored) void loadGitChanges(folderId); }, [head, stored, folderId]);

  // Any Git read that reports "not a git repository" settles the whole view into the neutral state.
  const notRepo = repo.notRepo || isNotGitRepository(stored?.error) || isNotGitRepository(review.error) || (changes?.phase === 'error' && isNotGitRepository(changes.error));
  if (notRepo) return <div className="files-tab changes-tab"><NotARepository/></div>;

  const status = repo.status;
  // The working-tree split needs a full status; past 500 paths (or before status loads) the flat list stands in.
  const sectioned = head && !!status && !status.truncated;
  const conflicts = sectioned ? status!.files.filter(file => file.conflict) : [];
  const staged = sectioned ? status!.files.filter(file => file.staged && !file.conflict && !file.untracked) : [];
  const unstaged = sectioned ? status!.files.filter(file => !file.conflict && (file.untracked || file.worktree !== ' ')) : [];
  const total = changes?.phase === 'ready' || changes?.value ? changes?.value?.length ?? 0 : undefined;
  const totals = (changes?.value ?? []).reduce((sum, file) => ({adds: sum.adds + (file.adds ?? 0), dels: sum.dels + (file.dels ?? 0)}), {adds: 0, dels: 0});
  const disabled = !!repo.busy || repo.loading;
  const underDir = (dir: string) => (changes?.value ?? []).filter(file => file.path.startsWith(dir));
  const clean = sectioned ? status!.files.length === 0 : (changes?.value?.length ?? 0) === 0;

  return <div className="files-tab changes-tab" aria-busy={disabled || undefined}>
    <header className="git-toolbar">
      <ReviewBaselineMenu folderId={folderId} value={baseline} onChange={setBaseline}/>
      <span className="git-toolbar-summary" role="status">
        {total !== undefined && total > 0 && <>{total} {total === 1 ? 'file' : 'files'}<GitCounts adds={totals.adds} dels={totals.dels}/></>}
      </span>
      {groups.length > 0 && !sectioned && <Tip label={anyOpen ? 'Collapse all folders' : 'Expand all folders'}><button type="button" className="icon-button" aria-label={anyOpen ? 'Collapse all' : 'Expand all'} onClick={() => setAllGroups(!anyOpen)}>
        {anyOpen ? <ListCollapse size={12}/> : <ListTree size={12}/>}
      </button></Tip>}
      <Tip label="Refresh changes"><button type="button" className="icon-button" aria-label="Refresh changes" onClick={refresh}><RefreshCw size={12}/></button></Tip>
    </header>
    {repo.error && !repo.notRepo && <p className="git-action-error" role="alert">{gitErrorMessage(repo.error) ?? 'Repository status unavailable.'}</p>}
    {head && status && !clean && <CommitBox folderId={folderId} repo={repo}/>}
    <ChangeOwnersProvider value={owners}>
    <div className="git-change-lists" ref={list} onKeyDown={onListKey} aria-keyshortcuts="ArrowUp ArrowDown Home End">
      {sectioned ? (clean
        ? <ResourceState kind="empty" message={`No uncommitted changes${status!.branch && !status!.detached ? ` on ${status!.branch}` : ''}. Everything is committed.`} compact/>
        : <>
          <StatusSection side="conflict" files={conflicts}>{conflicts.map(file => <StatusRow key={`c:${file.path}`} file={file} side="conflict" folderId={folderId} change={byPath.get(file.path)} under={[]} repo={repo}/>)}</StatusSection>
          <StatusSection side="staged" files={staged} action={<Tip label="Move every staged file back to Not staged"><button type="button" className="git-section-action" disabled={disabled} onClick={() => void repo.unstage(staged.map(file => file.path))}><Minus size={11} aria-hidden="true"/>Unstage all</button></Tip>}>
            {staged.map(file => <StatusRow key={`s:${file.path}`} file={file} side="staged" folderId={folderId} change={byPath.get(file.path)} under={[]} repo={repo}/>)}
          </StatusSection>
          <StatusSection side="unstaged" files={unstaged} action={<Tip label="Stage every change, including new files"><button type="button" className="git-section-action" disabled={disabled || status!.conflicted} onClick={() => void repo.stageAll()}><Plus size={11} aria-hidden="true"/>Stage all</button></Tip>}>
            {unstaged.map(file => <StatusRow key={`u:${file.path}`} file={file} side="unstaged" folderId={folderId} change={byPath.get(file.path)} under={file.untracked && file.path.endsWith('/') ? underDir(file.path) : []} repo={repo}/>)}
          </StatusSection>
        </>)
      : !changes || (changes.phase === 'loading' && !changes.value) || changes.phase === 'idle' ? <ResourceState kind="loading" label="Loading changes" rows={3} compact/>
      : changes.phase === 'error' ? <ResourceState kind="error" message={gitErrorMessage(changes.error) ?? 'Changes could not be read.'} onRetry={refresh} compact/>
      : (changes.value?.length ?? 0) === 0 ? <ResourceState kind="empty" message={head ? 'No uncommitted changes. Everything is committed.' : baseline === 'staged' ? 'Nothing staged yet. Stage files to include them in the next commit.' : baseline === 'unstaged' ? 'No unstaged changes.' : typeof baseline !== 'string' && 'ref' in baseline ? `Nothing differs from ${baseline.ref}.` : 'Nothing has changed since that agent turn.'} compact/>
      : <section className="git-section is-compare" aria-label="Changed files">
        <ul className="changes-list">
          {rows.map(row => row.kind === 'group'
            ? <ChangeGroupRow key={`dir:${row.dir}`} group={row} folderId={folderId} folderKey={key} open={groupOpen[row.dir]} onToggle={open => setGroupOpen(value => ({...value, [row.dir]: open}))}/>
            : <ChangeFileRow key={row.file.path} c={row.file} folderId={folderId} folderKey={key}/>)}
        </ul>
        {status?.truncated && head && <p className="file-format-note" role="status">Over 500 changed paths: staging per file is off. Commit from the terminal, or narrow the change.</p>}
      </section>}
    </div>
    </ChangeOwnersProvider>
  </div>;
}
