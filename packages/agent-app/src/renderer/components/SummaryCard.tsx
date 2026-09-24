import React, {useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {AlertTriangle, ArrowUpRight, ChevronDown, ChevronUp, CircleDot, DiffIcon, FileText, FolderGit2, GitBranch, GitCommitHorizontal, GitPullRequest, Globe, Laptop, ListTodo, Loader2, Monitor, Pencil, Plus, SquareTerminal} from 'lucide-react';
import type {Chat, GitLocalStatus, GitPullRequest as PullRequest, Project, TimelineItem} from '../../shared/protocol';
import type {GitRepoInfo} from '../../shared/domains/git-protocol';
import {invoke, subscribe} from '../bridge';
import {useNewChatDraft} from '../newChatDraft';
import {branchPullRequest} from '../branchPullRequest';
import {loadGitChanges, notifyError, openBrowserTab, openChangesTab, openCreatePullRequestTab, openFile, openPullRequestTab, openFilesTab, openProcessesTab, openSubagentsTab, setSummaryLayout} from '../store';
import {useStore} from '../useStore';
import {EMPTY_ACTIVITY_ITEMS, getSubagentActivity, subagentState} from '../subagentActivity';
import {portURL, useListeningPorts, useProcessSummary} from '../processSummary';
import {isActiveProcess} from '../../shared/process-protocol';
import {classifyTool} from './toolPresentation';
import {AgentGlyph, agentDisplayName} from '../agentIdentity';
import './activity-group.css';
import {commitAction, hasUncommittedChanges} from '../gitSummary';
import {collectFileChanges} from '../turnFileChanges';
import {generatedNote, splitChangeTotals} from '../changeCounts';
import {DiffStat, GeneratedChanges} from './DiffStat';
import {CheckStateIcon, GitSync, PrStateIcon, PrStatePill} from './GitStatus';
import {BranchPicker, type BranchMode} from './BranchPicker';
import {EnvironmentMenu, HOST_ENV_LABEL, SANDBOX_ENV_LABEL, useChatEnvironment} from './EnvironmentFooter';
import {SandboxApplySheet} from './SandboxApplySheet';
import { isNotGitRepository } from './resourceErrors';
import './summary-card.css';
import {SummaryScheduled} from './SummaryScheduled';
import {CheckLogDisclosure, CiRepairControls, useCiRepair} from './CiRepair';
import {ciRepairActive} from '../../shared/domains/ci-protocol';
import type {GitHubChecks} from '../../shared/domains/github-protocol';
import { plural } from '../../shared/wording.ts';
import {Tip} from './Tooltip';

type Folder = {id: string; name: string; path: string};
type PullRequests = Awaited<ReturnType<typeof fetchPullRequests>>;
const fetchPullRequests = (folderId: string) => invoke('git.pullRequests', {folderId});

/** Full card width, its inset from the conversation's right edge, and the gap it keeps around it. */
const CARD_WIDTH = 300;
const CARD_EDGE = 14;
const CARD_GAP = 10;
/** The compact card never shrinks below this (unless the column itself is narrower). */
const CARD_MIN = 200;
/** The centred conversation column (see .timeline-inner). */
const COLUMN = 804;
/** Narrowest transcript worth giving a gutter; below it (typically the resource pane is open) the card
 *  overlays the transcript's right margin instead, leaving the composer and rows full width. */
const TRANSCRIPT_MIN = 600;

/**
 * Where the card goes for a given conversation width: 'float' when it fits in the side margin of the
 * centred column, 'reserve' when the transcript can give up a right gutter and stay readable, else
 * 'overlay' at a compact width (≈ min(300px, 40% of the column)) over the transcript's right margin.
 */
export function pickSummaryLayout(width: number): {layout: 'float' | 'reserve' | 'overlay'; cardWidth: number} {
  const cardWidth = Math.round(Math.max(Math.min(CARD_WIDTH, width * 0.4), Math.min(CARD_MIN, width - CARD_EDGE * 2)));
  const reserve = cardWidth + CARD_EDGE + CARD_GAP;
  if (width >= COLUMN + reserve * 2) return {layout: 'float', cardWidth};
  if (width - reserve >= TRANSCRIPT_MIN) return {layout: 'reserve', cardWidth};
  return {layout: 'overlay', cardWidth};
}

/** Compact-card fold state (overlay layout only), remembered across launches once the user has chosen.
 *  With no stored choice the compact card starts folded to a pill, so it never covers transcript text
 *  uninvited. */
const COLLAPSED_KEY = 'muster.summaryCollapsed';
function readCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSED_KEY) !== 'false'; } catch { return true; }
}
function writeCollapsed(value: boolean): void {
  try { localStorage.setItem(COLLAPSED_KEY, String(value)); } catch {}
}

/**
 * One scheduler for every folder the card shows: a single 15s tick (focused window
 * only) and a focus pass, walked with a stagger so N folders never spawn N×git at once.
 * PR lists refresh on every 8th tick (~2 min), also only while focused.
 */
const refreshers = new Map<string, {status: () => void; prs: () => void}>();
let tick = 0, schedulerTimer: ReturnType<typeof setInterval> | undefined;
function runPass(withPrs: boolean) {
  let delay = 0;
  for (const refresher of refreshers.values()) {
    setTimeout(() => { refresher.status(); if (withPrs) refresher.prs(); }, delay);
    delay += 350;
  }
}
const onWindowFocus = () => runPass(false);
function register(folderId: string, refresher: {status: () => void; prs: () => void}) {
  refreshers.set(folderId, refresher);
  if (!schedulerTimer) {
    schedulerTimer = setInterval(() => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
      runPass(++tick % 8 === 0);
    }, 15_000);
    window.addEventListener('focus', onWindowFocus);
  }
  return () => {
    if (refreshers.get(folderId) === refresher) refreshers.delete(folderId);
    if (!refreshers.size && schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = undefined; window.removeEventListener('focus', onWindowFocus); }
  };
}

function useGitStatus(folderId: string) {
  const [status, setStatus] = useState<GitLocalStatus>();
  const [info, setInfo] = useState<GitRepoInfo>();
  const [error, setError] = useState('');
  const token = useRef(0);
  // At most one status read in flight per folder; triggers during it coalesce into one re-run,
  // so polls never pile up behind a slow push/commit in the backend's per-repo queue.
  const inFlight = useRef(false), again = useRef(false);
  const refresh = useCallback(async () => {
    if (inFlight.current) { again.current = true; return; }
    inFlight.current = true;
    const mine = ++token.current;
    try {
      const [next, , facts] = await Promise.all([invoke('git.status', {folderId}), loadGitChanges(folderId), invoke('git.info', {folderId}).catch(() => undefined)]);
      if (mine === token.current) {setStatus(next); if (facts) setInfo(facts); setError('');}
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // A busy queue is transient: keep showing the last good status rather than an error.
      if (mine === token.current && !/busy/i.test(message)) setError(message);
    } finally {
      inFlight.current = false;
      if (again.current) { again.current = false; void refresh(); }
    }
  }, [folderId]);
  useEffect(() => {
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = subscribe(event => {
      if (event.type !== 'workspaceChanged' || event.folderId !== folderId) return;
      clearTimeout(timer); timer = setTimeout(() => void refresh(), 250);
    });
    return () => {off(); clearTimeout(timer); token.current++;};
  }, [folderId, refresh]);
  return {status, info, error, refresh, setStatus, setInfo};
}

function Row({icon, label, detail, onClick, disabled, title, trailing, busy, expanded}: {icon: React.ReactNode; label: React.ReactNode; detail?: React.ReactNode; onClick?: () => void; disabled?: boolean; title?: string; trailing?: React.ReactNode; busy?: boolean; expanded?: boolean}) {
  return <button type="button" className="summary-row" onClick={onClick} disabled={disabled || busy} title={title} aria-busy={busy || undefined} aria-expanded={expanded}>
    <span className="summary-row-icon" aria-hidden="true">{busy ? <Loader2 size={15} className="summary-spin"/> : icon}</span>
    <span className="summary-row-label">{label}</span>
    {detail !== undefined && <span className="summary-row-detail">{detail}</span>}
    {trailing}
  </button>;
}

/** GIT-08 in the summary card: the PR's checks, failing ones with their log excerpt, and the repair task's live progress. */
function PullRequestChecks({folderId, number, chatId}: {folderId: string; number: number; chatId?: string}) {
  const [checks, setChecks] = useState<GitHubChecks>();
  const [error, setError] = useState('');
  const repair = useCiRepair(folderId, number);
  const checksPending = useRef(false);
  checksPending.current = !!checks?.summary.pending;
  useEffect(() => {
    let alive = true;
    const load = (refresh: boolean) => invoke('github.pr.checks', {folderId, number, refresh}).then(value => { if (alive) { setChecks(value); setError(''); } }, cause => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); });
    void load(!!repair);
    // Running checks stream in: re-read every 30s while any are pending, and whenever the repair reports progress.
    // Settled checks re-read every 2 minutes: the refresh re-reads the PR head, so a new push shows its own checks.
    let ticks = 0;
    const timer = setInterval(() => { ticks++; if (checksPending.current || ticks % 4 === 0) void load(true); }, 30_000);
    return () => { alive = false; clearInterval(timer); };
  }, [folderId, number, repair?.headSha, repair?.phase, repair?.checks?.pending, repair?.checks?.failed]);
  if (error && !checks) return <p className="summary-muted">Checks unavailable: {error}</p>;
  if (!checks) return <p className="summary-muted">Loading checks…</p>;
  const failing = checks.items.filter(check => check.status === 'completed' && !['success', 'skipped', 'neutral', 'stale'].includes(check.conclusion ?? ''));
  const {summary} = checks;
  return <div className="summary-pr-checks">
    <p className="summary-muted" role="status">{checks.items.length ? `${summary.passed} passed · ${summary.failed} failing${summary.pending ? ` · ${summary.pending} running` : ''}` : 'No checks reported'}</p>
    {failing.slice(0, 3).map(check => <div key={check.id}>
      <div className="summary-pr-check"><CheckStateIcon check={check} size={12}/><span title={check.name}>{check.name}</span></div>
      <CheckLogDisclosure key={`${checks.headSha}:${check.id}`} folderId={folderId} number={number} check={check} compact/>
    </div>)}
    <CiRepairControls folderId={folderId} number={number} failing={failing.length} chatId={chatId} compact/>
  </div>;
}

function PullRequestRow({pr, current, folderId, chatId}: {pr: PullRequest; current: boolean; folderId: string; chatId?: string}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const repair = useCiRepair(folderId, pr.number);
  const repairing = !!repair && ciRepairActive(repair);
  return <div className="summary-pr" data-open={open || undefined}>
    <button type="button" className="summary-row" aria-expanded={open} aria-controls={id} title={`#${pr.number} · ${pr.headRefName}`} onClick={() => setOpen(value => !value)}>
      <span className="summary-row-icon" aria-hidden="true"><PrStateIcon state={pr.state} draft={pr.isDraft} size={15}/></span>
      <span className="summary-row-label">{pr.title || `Pull request #${pr.number}`}</span>
      {repairing && <Loader2 size={12} className="ci-spin" aria-label={`Fixing failing checks: ${repair!.message}`}/>}
      <span className="summary-muted summary-pr-num">#{pr.number}</span>
      <ChevronDown size={14} className="summary-chevron" data-open={open || undefined} aria-hidden="true"/>
    </button>
    {open && <div className="summary-pr-detail" id={id}>
      <p className="summary-pr-title">{pr.title || `Pull request #${pr.number}`}</p>
      <dl>
        <div><dt>Status</dt><dd><PrStatePill state={pr.state} draft={pr.isDraft} small/></dd></div>
        <div><dt>Branch</dt><dd className="summary-branch" title={pr.headRefName}>{pr.headRefName || 'unknown'}{current && <span className="summary-muted"> · checked out</span>}</dd></div>
      </dl>
      <PullRequestChecks folderId={folderId} number={pr.number} chatId={current ? chatId : undefined}/>
      <button type="button" className="summary-pr-open-link" onClick={() => openPullRequestTab(folderId, pr.number, pr.title)}><GitPullRequest size={13} aria-hidden="true"/>Review pull request</button>
      <button type="button" className="summary-pr-open-link" onClick={() => openBrowserTab(pr.url)}><ArrowUpRight size={13} aria-hidden="true"/>Open in browser</button>
    </div>}
  </div>;
}

function FolderSection({folder, chat, project, activity}: {folder: Folder; chat: Chat; project?: Project; activity: number}) {
  const state = useStore();
  const {status, info, error, setStatus, setInfo, refresh} = useGitStatus(folder.id);
  const [pushing, setPushing] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [picker, setPicker] = useState<{open: boolean; mode: BranchMode}>({open: false, mode: 'switch'});
  const [prs, setPrs] = useState<PullRequests>();
  const {environment} = useChatEnvironment(chat.id);
  const [applyingSandbox, setApplyingSandbox] = useState(false);
  const inSandbox = environment?.env === 'sandbox';
  const changes = state.gitChanges[folder.id];
  // Each new timeline item (a tool finishing, a turn ending) may have touched the repo.
  const firstActivity = useRef(true);
  useEffect(() => {
    if (firstActivity.current) { firstActivity.current = false; return; }
    const timer = setTimeout(() => void refresh(), 1200);
    return () => clearTimeout(timer);
  }, [activity, refresh]);
  useEffect(() => {
    let alive = true;
    const loadPrs = () => { void fetchPullRequests(folder.id).then(value => { if (alive) setPrs(value); }, () => { if (alive) setPrs(undefined); }); };
    loadPrs();
    const unregister = register(folder.id, {status: () => void refresh(), prs: loadPrs});
    return () => { alive = false; unregister(); };
  }, [folder.id, refresh]);

  const files = changes?.value;
  const known = !!files?.length && files.every(file => typeof file.adds === 'number' && typeof file.dels === 'number') && files.some(file => file.adds! + file.dels! > 0);
  const adds = known ? files!.reduce((n, file) => n + file.adds!, 0) : 0;
  const dels = known ? files!.reduce((n, file) => n + file.dels!, 0) : 0;
  // A transient read failure (a busy Git lock, a slow status mid-run) keeps its last good file list
  // (see loadGitChanges); show that rather than "Unavailable" so the card doesn't flicker empty while
  // 20 files are being edited. Only a folder that has never loaded anything falls back to Unavailable.
  const changeDetail = files ? (
    !files.length ? <span className="summary-muted">Clean</span>
    : known ? <><span className="summary-add git-add">+{adds.toLocaleString()}</span> <span className="summary-del git-del">−{dels.toLocaleString()}</span></>
    : <span className="summary-muted">{plural(files.length, 'file')}</span>
  ) : changes?.phase === 'error' && isNotGitRepository(changes.error) ? <span className="summary-muted" title="Not a Git repository: this chat's edits are tracked per turn">Per turn</span>
    : changes?.phase === 'error' ? <span className="summary-muted" title={changes.error}>Unavailable</span>
    : undefined;

  const isRepo = !!status && !error;
  const dirty = hasUncommittedChanges(status);
  const ahead = status?.ahead ?? 0, behind = status?.behind ?? 0;
  const push = async () => {
    if (!status) return;
    setPushing(true);
    try { setStatus(await invoke('git.push', {folderId: folder.id, revision: status.revision})); void loadGitChanges(folder.id); }
    catch (cause) { notifyError(cause); void refresh(); }
    finally { setPushing(false); }
  };
  const fetchRemote = async () => {
    setFetching(true);
    try { const result = await invoke('git.fetch', {folderId: folder.id}); setStatus(result.status); setInfo(result.info); }
    catch (cause) { notifyError(cause); }
    finally { setFetching(false); }
  };
  const commit = commitAction(status, info, dirty);
  const openPrs = prs?.available ? prs.items.filter(pr => pr.state === 'OPEN' || pr.state === 'open') : [];
  const branchPr = status ? branchPullRequest(openPrs, status) : undefined;
  const branchLabel = status ? (status.detached ? 'Detached HEAD' : status.branch || 'No branch') : '…';
  const worktree = info?.worktree;

  return <section className="summary-section" aria-label={`${folder.name} summary`}>
    <header className="summary-section-head" title={folder.path}>
      <span>{folder.name}</span>
      {worktree && <span className="summary-badge" title={`Worktree of ${worktree.mainPath}`}>Worktree</span>}
      <Tip label="Browse files"><button type="button" className="summary-head-action" aria-label={`Browse ${folder.name} files`} onClick={() => openFilesTab(folder.id, folder.name)}><Plus size={14}/></button></Tip>
    </header>
    <Row icon={<DiffIcon size={15}/>} label="Changes" detail={changeDetail} onClick={() => openChangesTab(folder.id, folder.name)} title="Review changes"/>
    <EnvironmentMenu chat={chat} project={project} folder={folder} info={isRepo ? info : undefined} environment={environment} className="summary-row" side="bottom" align="end"
      onNewWorktree={() => setPicker({open: true, mode: 'worktree'})} onApply={() => setApplyingSandbox(true)}>
      <span className="summary-row-icon" aria-hidden="true">{inSandbox ? <Monitor size={15}/> : worktree ? <FolderGit2 size={15}/> : <Laptop size={15}/>}</span>
      <span className="summary-row-label">{inSandbox ? SANDBOX_ENV_LABEL : worktree ? 'Worktree' : HOST_ENV_LABEL}</span>
      {inSandbox && !environment?.ready && <AlertTriangle size={13} className="summary-row-warn" aria-label="Container not running"/>}
      <ChevronDown size={14} className="summary-chevron" aria-hidden="true"/>
    </EnvironmentMenu>
    <SandboxApplySheet chatId={chat.id} folderId={folder.id} open={applyingSandbox} onClose={() => setApplyingSandbox(false)}/>
    {error ? <p className="summary-note" title={error}>{/not a git repository/i.test(error) ? 'Not a Git repository' : 'Repository status unavailable'}</p> : <>
      {status ? <BranchPicker folder={folder} className="summary-row" label={`Branch: ${branchLabel}${status.upstream ? ` (tracking ${status.upstream})` : ''}`} side="bottom" align="end"
        open={picker.open} mode={picker.mode} onOpenChange={open => setPicker(value => ({open, mode: open ? value.mode : 'switch'}))}>
        <span className="summary-row-icon summary-branch-icon" aria-hidden="true"><GitBranch size={15}/></span>
        <span className="summary-row-label summary-branch">{branchLabel}</span>
        {(ahead || behind) ? <span className="summary-row-detail"><GitSync ahead={ahead} behind={behind}/></span> : null}
        <ChevronDown size={14} className="summary-chevron" aria-hidden="true"/>
      </BranchPicker> : <Row icon={<GitBranch size={15}/>} label="…" disabled/>}
      <Row icon={<GitCommitHorizontal size={15}/>} label={commit.label} busy={pushing || fetching} disabled={!isRepo || commit.kind === 'none'}
        detail={commit.detail ? <span className={commit.kind === 'fetch' && commit.detail === 'Fetch' ? 'summary-link' : 'summary-muted'}>{commit.detail}</span> : undefined}
        onClick={() => commit.kind === 'changes' ? openChangesTab(folder.id, folder.name) : commit.kind === 'push' ? void push() : commit.kind === 'fetch' ? void fetchRemote() : undefined}
        title={commit.hint}/>
      {status?.remoteUrl && !status.detached && (branchPr
        ? <Row icon={<PrStateIcon state={branchPr.state} draft={branchPr.isDraft} size={15}/>} label={`View pull request #${branchPr.number}`} title={branchPr.title || undefined} onClick={() => openPullRequestTab(folder.id, branchPr.number, branchPr.title)}/>
        : <Row icon={<GitPullRequest size={15}/>} label="Create pull request" onClick={() => openCreatePullRequestTab(folder.id)}/>)}
    </>}
    {openPrs.length > 0 && <div className="summary-subsection">
      <header className="summary-section-head"><span>Pull requests</span></header>
      {openPrs.slice(0, 4).map(pr => <PullRequestRow key={pr.number} pr={pr} folderId={folder.id} chatId={chat.id} current={!!status && pr.headRefName === status.branch}/>)}
    </div>}
  </section>;
}


function sourceList(items: readonly TimelineItem[]) {
  const latest = new Map<string, {path: string; action: 'Read' | 'Edited'}>();
  for (const item of items) {
    if (item.kind !== 'tool' || item.status === 'failed' || item.status === 'cancelled' || item.status === 'interrupted') continue;
    const presentation = classifyTool(item.data);
    if (presentation.kind !== 'read' && presentation.kind !== 'edit') continue;
    for (const path of presentation.paths ?? [presentation.subject]) if (path) {
      latest.delete(path);
      latest.set(path, {path, action: presentation.kind === 'read' ? 'Read' : 'Edited'});
    }
  }
  return [...latest.values()].reverse();
}

/**
 * Codex-style floating summary: a separate card over the conversation's top-right, below the chat
 * header, whether or not the resource pane is open. With a wide conversation it floats in the side
 * margin ('float') or gives the transcript a right gutter ('reserve'); with a narrow one (typically
 * the resource pane is open) it shrinks to a compact width and sits over the transcript's right
 * margin ('overlay'), where it offers its own collapse-to-pill chevron. It never auto-hides: only the
 * header toggle (`summaryHidden`) takes it away.
 */
export function SummaryCard() {
  const state = useStore();
  const draft = useNewChatDraft();
  const root = useRef<HTMLElement>(null);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const refocus = useRef(false);
  const toggleCollapsed = useCallback(() => {
    refocus.current = true;
    setCollapsed(value => { const next = !value; writeCollapsed(next); return next; });
  }, []);
  const bodyId = useId();
  const [allSources, setAllSources] = useState(false);
  const chat = state.snapshot?.chats.find(c => c.id === state.activeChatId);
  const project = state.snapshot?.projects.find(p => p.id === chat?.projectId);
  const folders = useMemo(() => {
    const ids = project?.folderIds ?? (chat?.folderId ? [chat.folderId] : []);
    return (state.snapshot?.folders ?? []).filter(folder => ids.includes(folder.id));
  }, [project?.folderIds, chat?.folderId, state.snapshot?.folders]);
  const timeline = chat ? state.timelines[chat.id] : undefined;
  const items = timeline?.value ?? EMPTY_ACTIVITY_ITEMS;
  const {agents, counts} = useMemo(() => getSubagentActivity(items), [items]);
  const sources = useMemo(() => sourceList(items), [items]);
  // This chat's own edits (F23), with lockfiles/generated output counted apart like every other pill (F59).
  const totals = useMemo(() => items.length ? splitChangeTotals(collectFileChanges(items)) : undefined, [items]);
  const latestAction = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.kind !== 'tool') continue;
      const p = classifyTool(item.data);
      return [item.status === 'running' ? p.runningVerb : p.verb, p.subject].filter(Boolean).join(' ') || item.text;
    }
    return undefined;
  }, [items]);
  const {summary: processes} = useProcessSummary();
  const activeCommands = (processes?.sessions ?? []).filter(s => s.chatId === chat?.id && isActiveProcess(s.status)).length;

  // The draft (Codex-style "New chat") has no real chat behind it yet, and a chat with neither a
  // folder nor any activity has nothing to summarize: the card disappears rather than showing a note.
  const hasActivity = items.length > 0 || activeCommands > 0;
  const present = !!chat && !draft.open && (folders.length > 0 || hasActivity);
  // S3-E / DF-F38: servers this chat's shells, commands or agent left listening (agent first).
  const {ports: listening} = useListeningPorts(present ? chat?.id : undefined);
  const shownPorts = useMemo(() => [...listening].sort((a, b) => Number(b.owner === 'agent') - Number(a.owner === 'agent') || a.port - b.port).slice(0, 4), [listening]);
  const emptyTimeline = items.length === 0;

  // Pick the layout from the conversation's real size with one ResizeObserver (no media queries, no
  // per-frame polling). It also tracks where the header ends and where the transcript's flexible area
  // ends, so the card never runs under the header or down over the composer. CSS variables are only
  // written when a value actually changes, so a resize drag never re-styles the subtree needlessly.
  useLayoutEffect(() => {
    const center = root.current?.parentElement;
    if (!present || !center) return;
    const written = new Map<string, string>();
    const write = (name: string, value: string) => {
      if (written.get(name) === value) return;
      written.set(name, value);
      center.style.setProperty(name, value);
    };
    const content = () => center.querySelector<HTMLElement>('.chat > .timeline-shell, .chat > .chat-empty, .chat > .chat-loading, .chat > .chat-error');
    const measure = () => {
      const {layout, cardWidth} = pickSummaryLayout(center.clientWidth || 0);
      setSummaryLayout(layout);
      write('--summary-width', `${cardWidth}px`);
      write('--summary-reserve', `${cardWidth + CARD_EDGE + CARD_GAP}px`);
      const box = center.getBoundingClientRect();
      const head = center.querySelector<HTMLElement>('.chat-head')?.getBoundingClientRect();
      const body = content()?.getBoundingClientRect();
      const top = head ? Math.max(0, Math.round(head.bottom - box.top)) + CARD_GAP : 56;
      const bottom = body ? Math.max(0, Math.round(box.bottom - body.bottom)) + CARD_GAP : 16;
      write('--summary-top', `${top}px`);
      write('--summary-bottom', `${bottom}px`);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(center);
    const body = content();
    if (body) observer.observe(body);
    return () => observer.disconnect();
  }, [present, chat?.id, timeline?.phase, emptyTimeline]);
  // An expanded compact card ('overlay-open') gets the same transcript-only gutter as 'reserve', so
  // rows reflow beside it instead of hiding under it; the folded pill needs none.
  useLayoutEffect(() => {
    const center = root.current?.parentElement;
    if (!present || !center) return;
    center.dataset.summary = state.summaryHidden ? 'hidden' : state.summaryLayout === 'overlay' && !collapsed ? 'overlay-open' : state.summaryLayout;
    return () => { delete center.dataset.summary; };
  }, [present, state.summaryHidden, state.summaryLayout, collapsed]);
  // Keep keyboard focus on the chevron/pill across collapse and expand (the button is swapped).
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    root.current?.querySelector<HTMLElement>('.summary-pill, .summary-collapse')?.focus();
  }, [collapsed]);

  if (!present || !chat) return null;
  const layout = state.summaryLayout;
  const compact = layout === 'overlay';
  const folded = compact && collapsed;
  const shownSources = allSources ? sources.slice(0, 20) : sources.slice(0, 3);
  const openAgents = () => openSubagentsTab(chat.id, chat.folderId ?? folders[0]?.id, chat.title || 'Conversation');
  const running = chat.status === 'running' || chat.status === 'stopping';
  const attention = chat.status === 'waiting' || chat.status === 'failed' || !!chat.recovery;
  const agentSummary = [counts.working && `${counts.working} working`, counts.waiting && `${counts.waiting} waiting`, counts.failed && `${counts.failed} failed`, counts.done && `${counts.done} done`].filter(Boolean).join(' · ');
  const stats = totals && (totals.adds > 0 || totals.dels > 0 || generatedNote(totals.generated))
    ? <span className="summary-pill-stats"><DiffStat adds={totals.adds} dels={totals.dels}/><GeneratedChanges generated={totals.generated}/></span>
    : null;

  const sections = <>
    {running && <div className="summary-now" role="status"><CircleDot size={13} className="summary-pulse" aria-hidden="true"/><span title={latestAction}>{latestAction || 'Working…'}</span></div>}
    {folders.map(folder => <FolderSection key={folder.id} folder={folder} chat={chat} project={project} activity={items.length}/>)}
    {/* IMG-2026-09-18T1224: automations that target this folder. */}
    <SummaryScheduled folderIds={folders.map(folder => folder.id)} projectId={project?.id}/>
    {(activeCommands > 0 || shownPorts.length > 0) && <section className="summary-section" aria-label="Terminal">
      <Row icon={<SquareTerminal size={15}/>} label="Terminal" detail={<span className="summary-muted">{activeCommands > 0 ? `${activeCommands} running` : plural(listening.length, 'port') + ' listening'}</span>} onClick={() => openProcessesTab(chat.id, 'Terminal')}/>
      {shownPorts.map(port => <Row key={port.id} icon={<Globe size={15}/>} title={`Open ${portURL(port)} in the browser`}
        label={<>{port.name} <span className={`summary-port-owner is-${port.owner}`}>{port.owner === 'agent' ? 'Agent' : 'You'}</span></>}
        detail={<span className="summary-muted summary-port">:{port.port}</span>} trailing={<ArrowUpRight size={12} aria-hidden="true"/>} onClick={() => openBrowserTab(portURL(port))}/>)}
    </section>}
    {agents.length > 0 && <section className="summary-section" aria-label="Subagents">
      <header className="summary-section-head"><span>Subagents</span></header>
      <button type="button" className="summary-row summary-agents" onClick={openAgents} title={agents.map((a, index) => `${agentDisplayName(a, index + 1)}: ${subagentState(a.state).label}`).join('\n')}>
        <span className="summary-agent-dots" aria-hidden="true">{agents.slice(0, 5).map((agent, index) => { const kind = subagentState(agent.state).kind; return <AgentGlyph key={agent.id} name={agentDisplayName(agent, index + 1)} state={kind === 'working' ? 'working' : kind === 'failed' ? 'failed' : kind === 'done' ? 'done' : 'idle'}/>; })}</span>
        <span className="summary-row-label">{agentSummary || `${agents.length} reported`}</span>
      </button>
    </section>}
    {sources.length > 0 && <section className="summary-section" aria-label="Sources">
      <header className="summary-section-head"><span>Sources</span></header>
      {shownSources.map(source => {
        const target = resolveSource(source.path, folders, chat.folderId);
        const name = (target?.path || source.path).split('/').pop() || source.path;
        return <Row key={`${source.action}:${source.path}`} icon={source.action === 'Edited' ? <Pencil size={14}/> : <FileText size={14}/>} label={name} title={`${source.action} ${source.path}`}
          disabled={!target} onClick={() => target && openFile(target.folderId, target.path)}/>;
      })}
      {sources.length > 3 && <button type="button" className="summary-row summary-more" onClick={() => setAllSources(v => !v)}><span className="summary-row-icon"/><span className="summary-row-label">{allSources ? 'Show less' : `View all ${sources.length}`}</span></button>}
    </section>}
  </>;

  return <aside ref={root} className="summary-card" data-layout={layout} data-collapsed={folded || undefined} hidden={state.summaryHidden} aria-label="Chat summary" data-testid="summary-card">
    {folded
      ? <button type="button" className="summary-pill" aria-expanded={false} aria-label="Expand summary" title="Expand summary" onClick={toggleCollapsed}>
          <ListTodo size={14} className="summary-pill-icon" aria-hidden="true"/>
          <span className="summary-pill-label">Summary</span>
          {stats}
          {(running || attention) && <span className="summary-pill-dot" data-state={running ? 'running' : 'attention'} role="img" aria-label={running ? 'Working' : 'Needs attention'}/>}
          <ChevronDown size={14} className="summary-chevron" aria-hidden="true"/>
        </button>
      : <>
          {compact && <div className="summary-card-bar">
            <span className="summary-card-title">Summary</span>
            {stats}
            <Tip label="Collapse summary"><button type="button" className="summary-collapse" aria-expanded={true} aria-controls={bodyId} aria-label="Collapse summary" onClick={toggleCollapsed}>
              <ChevronUp size={14} aria-hidden="true"/>
            </button></Tip>
          </div>}
          <div className="summary-card-body" id={bodyId}>{sections}</div>
        </>}
  </aside>;
}

function resolveSource(sourcePath: string, folders: Folder[], chatFolderId?: string): {folderId: string; path: string} | undefined {
  const normalized = sourcePath.replaceAll('\\', '/');
  for (const folder of folders) {
    const rootPath = folder.path.replaceAll('\\', '/').replace(/\/$/, '');
    if (normalized.startsWith(rootPath + '/')) return {folderId: folder.id, path: normalized.slice(rootPath.length + 1)};
  }
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').some(part => part === '..' || part === '.' || part === '')) return undefined;
  const folderId = chatFolderId ?? (folders.length === 1 ? folders[0].id : undefined);
  return folderId ? {folderId, path: normalized} : undefined;
}
