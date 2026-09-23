import React, {useCallback, useEffect, useState} from 'react';
import {GitCommitHorizontal, GitCompare, GitPullRequestCreate, XCircle} from 'lucide-react';
import type {GitPullRequest} from '../../shared/protocol';
import type {GitHubChecks} from '../../shared/domains/github-protocol';
import {invoke} from '../bridge';
import {branchPullRequest} from '../branchPullRequest';
import {openGitTab, setGitView, type GitView, type WorkspaceTab} from '../store';
import {useStoreSelector} from '../useStore';
import {checksTone} from '../gitStatus';
import {LazyBoundary, LazyGitHistoryTab, LazyPullRequestTab} from '../lazyScreens';
import {ChangesView, NotARepository} from './ChangesView';
import {GitConflictBanner} from './ConflictTab';
import {CiRepairControls} from './CiRepair';
import {useGitRepository} from './GitActions';
import {GitRefChip, GitSync, PrStateIcon} from './GitStatus';
import {Tip} from './Tooltip';
import './git-tab.css';

type PrSection = 'conversation' | 'checks' | 'files';

/** The folder's open PRs (gh); `undefined` until read, empty when GitHub isn't available. */
function usePullRequests(folderId: string, branch: string | undefined): GitPullRequest[] | undefined {
  const [prs, setPrs] = useState<GitPullRequest[]>();
  useEffect(() => {
    let live = true;
    invoke('git.pullRequests', {folderId}).then(value => { if (live) setPrs(value?.available ? value.items.filter(pr => /^open$/i.test(pr.state)) : []); }, () => { if (live) setPrs([]); });
    return () => { live = false; };
  }, [folderId, branch]);
  return prs;
}

/** The PR's checks, re-read every 30s while any run and every 2 minutes otherwise. */
function useChecks(folderId: string, number: number | undefined): GitHubChecks | undefined {
  const [checks, setChecks] = useState<GitHubChecks>();
  useEffect(() => {
    setChecks(undefined);
    if (!number) return;
    let live = true, pending = false, ticks = 0;
    const load = (refresh: boolean) => invoke('github.pr.checks', {folderId, number, refresh}).then(value => { if (live && value) { setChecks(value); pending = !!value.summary?.pending; } }, () => undefined);
    void load(false);
    const timer = setInterval(() => { ticks++; if (pending || ticks % 4 === 0) void load(true); }, 30_000);
    return () => { live = false; clearInterval(timer); };
  }, [folderId, number]);
  return checks;
}

/** "CI failing on #7 → Fix": the repair task starts here; View checks opens the PR on its Checks section. */
function CiFailingBanner({folderId, number, checks, chatId, onViewChecks}: {folderId: string; number: number; checks: GitHubChecks; chatId?: string; onViewChecks: () => void}): React.ReactElement | null {
  const failing = checks.summary.failed;
  if (checksTone(checks.summary) !== 'failure') return null;
  const names = checks.items.filter(check => check.status === 'completed' && !['success', 'skipped', 'neutral', 'stale'].includes(check.conclusion ?? '')).map(check => check.name);
  return <section className="git-banner is-ci-failure" data-testid="ci-banner" aria-label="CI failing">
    <header>
      <XCircle size={14} className="git-state-icon ci-state is-failure" aria-hidden="true"/>
      <span className="git-banner-title">{failing === 1 ? '1 check failing' : `${failing} checks failing`} on #{number}</span>
      {names.length > 0 && <span className="git-banner-detail" title={names.join('\n')}>{names.slice(0, 2).join(', ')}{names.length > 2 ? ` +${names.length - 2}` : ''}</span>}
      <button type="button" className="git-banner-link" onClick={onViewChecks}>View checks</button>
    </header>
    <CiRepairControls folderId={folderId} number={number} failing={failing} chatId={chatId} compact/>
  </section>;
}

const VIEW_LABEL: Record<GitView, string> = {changes: 'Changes', history: 'History', pullRequest: 'Pull request'};

/**
 * The one Git surface per folder, in the right pane: a compact segmented header (Changes · History ·
 * Pull request), the checked-out branch with ahead/behind, and contextual banners (a merge/rebase in
 * progress → Resolve; failing CI → Fix). Compare lives inside History; conflicts open from the banner.
 */
export function GitTab({tab}: {tab: WorkspaceTab}): React.ReactElement {
  const folderId = tab.folderId!;
  const folderName = useStoreSelector(state => state.snapshot?.folders.find(folder => folder.id === folderId)?.name) ?? 'Repository';
  const changeCount = useStoreSelector(state => state.gitChanges[folderId]?.value?.length);
  const chatId = useStoreSelector(state => state.snapshot?.chats.find(chat => chat.id === state.activeChatId && chat.folderId === folderId)?.id);
  const view: GitView = tab.gitView ?? (tab.kind === 'history' ? 'history' : tab.kind === 'pullRequest' ? 'pullRequest' : 'changes');
  const repo = useGitRepository(folderId);
  const status = repo.status;
  const prs = usePullRequests(folderId, status?.branch);
  const branchPr = status && prs ? branchPullRequest(prs, status) : undefined;
  // An explicit PR (summary card, side chat) wins; otherwise the checked-out branch's open PR; otherwise the create form.
  const prNumber = tab.prNumber ?? branchPr?.number;
  const shownPr = prs?.find(pr => pr.number === prNumber);
  const creating = view === 'pullRequest' && !prNumber;
  const showPr = creating || !!prNumber;
  const checks = useChecks(folderId, prNumber);
  const [prSection, setPrSection] = useState<{section: PrSection; n: number}>();
  const go = useCallback((next: GitView) => { if (tab.kind === 'git') setGitView(tab.id, next); else openGitTab(folderId, folderName, next, next === 'pullRequest' && tab.prNumber ? {prNumber: tab.prNumber} : {}); }, [tab.id, tab.kind, tab.prNumber, folderId, folderName]);
  if (repo.notRepo) return <div className="git-tab" data-testid="git-tab"><NotARepository what="Changes, history and pull requests appear"/></div>;
  const branch = status ? (status.detached ? 'Detached HEAD' : status.branch || 'No branch') : undefined;
  const canCreate = !!status?.remoteUrl && !status.detached && !showPr;
  const segments: GitView[] = ['changes', 'history', ...(showPr ? ['pullRequest' as const] : [])];
  const current = segments.includes(view) ? view : 'changes';
  const onKey = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const index = segments.indexOf(current);
    const next = segments[(index + (event.key === 'ArrowRight' ? 1 : segments.length - 1)) % segments.length];
    go(next);
    requestAnimationFrame(() => document.getElementById(`git-segment-${folderId}-${next}`)?.focus());
  };
  return <div className="git-tab" data-testid="git-tab" data-view={current}>
    <header className="git-tab-head">
      <div className="git-segments" role="tablist" aria-label="Git views" onKeyDown={onKey}>
        {segments.map(id => <button key={id} type="button" role="tab" id={`git-segment-${folderId}-${id}`} aria-selected={current === id} tabIndex={current === id ? 0 : -1} className="git-segment" data-view={id} onClick={() => go(id)}>
          {id === 'changes' ? <GitCompare size={13} aria-hidden="true"/> : id === 'history' ? <GitCommitHorizontal size={13} aria-hidden="true"/> : creating ? <GitPullRequestCreate size={13} aria-hidden="true"/> : <PrStateIcon state={shownPr?.state ?? 'open'} draft={shownPr?.isDraft} size={13}/>}
          <span>{id === 'pullRequest' ? (creating ? 'New pull request' : <>{VIEW_LABEL.pullRequest} <span className="git-segment-num">#{prNumber}</span></>) : VIEW_LABEL[id]}</span>
          {id === 'changes' && !!changeCount && <span className="git-segment-count">{changeCount}</span>}
          {id === 'pullRequest' && checks && checksTone(checks.summary) && <span className={`git-dot ci-state is-${checksTone(checks.summary)}`} data-check={checksTone(checks.summary)} title={`Checks: ${checks.summary.passed} passed, ${checks.summary.failed} failing, ${checks.summary.pending} running`}/>}
        </button>)}
      </div>
      <span className="git-tab-spacer"/>
      {canCreate && <Tip label={`Open a pull request for ${status!.branch}`}><button type="button" className="git-head-action" onClick={() => go('pullRequest')}><GitPullRequestCreate size={13} aria-hidden="true"/><span>Create PR</span></button></Tip>}
      {branch && <Tip label={status?.upstream ? `${branch} tracks ${status.upstream}${status.upstreamGone ? ' (deleted on the remote)' : ''}` : status?.detached ? 'No branch is checked out' : `${branch} is not published to a remote yet`}>
        <span className="git-tab-branch"><GitRefChip name={branch} kind={status?.detached ? 'head' : 'current'}/><GitSync ahead={status?.ahead} behind={status?.behind}/></span>
      </Tip>}
    </header>
    <div className="git-banners">
      <GitConflictBanner folderId={folderId}/>
      {checks && prNumber && <CiFailingBanner folderId={folderId} number={prNumber} checks={checks} chatId={chatId} onViewChecks={() => { setPrSection(value => ({section: 'checks', n: (value?.n ?? 0) + 1})); go('pullRequest'); }}/>}
    </div>
    <div className="git-tab-body" role="tabpanel" aria-labelledby={`git-segment-${folderId}-${current}`}>
      {current === 'changes' && <ChangesView folderId={folderId} repo={repo}/>}
      {current === 'history' && <LazyBoundary label="history"><LazyGitHistoryTab tab={tab} embedded/></LazyBoundary>}
      {current === 'pullRequest' && <LazyBoundary label="pull request"><LazyPullRequestTab tab={{...tab, prNumber}} section={prSection}/></LazyBoundary>}
    </div>
  </div>;
}
