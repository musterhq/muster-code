import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {ArrowUpRight, ChevronDown, ChevronRight, GitPullRequest, Loader2, MessageSquare, RefreshCw} from 'lucide-react';
import type {
  GitHubCheck, GitHubChecks, GitHubConversation, GitHubCreateDraft, GitHubMergeMethod, GitHubPullFile, GitHubPullFiles,
  GitHubPullRequest, GitHubRepo, GitHubReviewEvent, GitHubReviewThread,
} from '../../shared/domains/github-protocol';
import type {EditorLine} from '../diffEditorModel';
import {invoke} from '../bridge';
import {closeTab, notifyError, notifySuccess, openBrowserTab, openPullRequestTab, type WorkspaceTab} from '../store';
import {relativeLabel} from '../relativeTime';
import {DiffEditorView, patchEditorModel, type DiffLineExtras} from './FileDiffEditor';
import {CheckStateIcon, GitCounts, GitStatusBadge, PrStatePill, QueuedIcon, ReviewStatePill} from './GitStatus';
import {checksTone, reviewTone} from '../gitStatus';
import {ConfirmSheet} from './ConfirmSheet';
import {ResourceState} from './ResourceState';
import {cleanIpcError} from './resourceErrors';
import {safeUrl} from './MessageBody';
import './pull-request.css';
import {CheckLogDisclosure, CiRepairControls, useCiRepair} from './CiRepair';
import {useStoreSelector} from '../useStore';
import { plural } from '../../shared/wording.ts';
import {Tip} from './Tooltip';

// ---------------------------------------------------------------------------
// Data

interface Query<T> {value?: T; error?: string; loading: boolean; reload: () => Promise<void>}
/** One GitHub read: first load uses the runtime cache, `reload` bypasses it. Stale responses are dropped. */
function useQuery<T>(key: string, load: (refresh: boolean) => Promise<T>): Query<T> {
  const [state, setState] = useState<{value?: T; error?: string; loading: boolean}>({loading: true});
  const token = useRef(0);
  const loader = useRef(load); loader.current = load;
  const run = useCallback(async (refresh: boolean) => {
    const mine = ++token.current;
    setState(previous => ({...previous, loading: true}));
    try { const value = await loader.current(refresh); if (mine === token.current) setState({value, loading: false}); }
    catch (cause) { if (mine === token.current) setState(previous => ({...(previous.value !== undefined ? {value: previous.value} : {}), error: cleanIpcError(cause), loading: false})); }
  }, []);
  useEffect(() => { void run(false); return () => { token.current++; }; }, [key, run]);
  return {...state, reload: useCallback(() => run(true), [run])};
}

const safeLink = (url: string) => safeUrl(url) ?? '';
function Markdown({text}: {text: string}): React.ReactElement {
  if (!text.trim()) return <p className="pr-muted">No description provided.</p>;
  return <div className="md-body pr-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeLink}
    components={{a: ({href, children}) => <a href={href} onClick={event => { event.preventDefault(); if (href) openBrowserTab(href); }}>{children}</a>}}>{text}</ReactMarkdown></div>;
}

const when = (value: string | null | undefined) => value ? relativeLabel(value) : '';
function duration(ms?: number): string {
  if (ms === undefined) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// ---------------------------------------------------------------------------
// Entry

/** The Git tab's Pull request segment: the create form (no number) or a PR's review surface. `section` jumps to a
 *  section (the CI banner's "View checks"); each new request carries a fresh `n`. */
export function PullRequestTab({tab, section}: {tab: WorkspaceTab; section?: {section: Section; n: number}}): React.ReactElement {
  const folderId = tab.folderId!;
  return <div className="pr-tab">{tab.prNumber ? <PullRequestView folderId={folderId} number={tab.prNumber} jump={section}/> : <CreatePullRequest folderId={folderId} tabId={tab.id}/>}</div>;
}
/** Leaving the create form: the PR opens in the same Git tab (a legacy standalone tab closes). */
function leaveCreate(tabId: string, folderId: string, number: number, title: string): void {
  openPullRequestTab(folderId, number, title);
  if (!tabId.startsWith('git:')) closeTab(tabId);
}

// ---------------------------------------------------------------------------
// Create (GIT-07)

function CreatePullRequest({folderId, tabId}: {folderId: string; tabId: string}): React.ReactElement {
  const [base, setBase] = useState<string>();
  const draft = useQuery<GitHubCreateDraft>(`draft:${folderId}:${base ?? ''}`, () => invoke('github.pr.draft', {folderId, ...(base ? {base} : {})}));
  const [title, setTitle] = useState(''), [body, setBody] = useState(''), [isDraft, setIsDraft] = useState(false);
  const edited = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const value = draft.value;
  // Prefill from commits until the user types; a new base re-prefills an untouched form.
  useEffect(() => { if (value?.available && !edited.current) { setTitle(value.title); setBody(value.body); } }, [value]);
  if (!value) return draft.error ? <ResourceState kind="error" message={draft.error} onRetry={() => void draft.reload()}/> : <ResourceState kind="loading" label="Preparing pull request" rows={4}/>;
  if (!value.available) return <ResourceState kind="error" message={value.reason ?? 'Pull requests aren’t available here.'} onRetry={() => void draft.reload()}>
    {value.compareUrl && <button type="button" onClick={() => openBrowserTab(value.compareUrl!)}><ArrowUpRight size={12} aria-hidden="true"/>Open compare page</button>}
  </ResourceState>;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !title.trim()) return;
    setBusy(true); setError('');
    try {
      const pr = await invoke('github.pr.create', {folderId, base: value.base, title, body, draft: isDraft, push: true});
      notifySuccess(`Opened pull request #${pr.number}`);
      leaveCreate(tabId, folderId, pr.number, pr.title);
    } catch (cause) { setError(cleanIpcError(cause)); }
    finally { setBusy(false); }
  };
  return <form className="pr-create" onSubmit={event => void submit(event)} aria-label="Create pull request">
    <header className="pr-create-head"><GitPullRequest size={16} aria-hidden="true"/><h2>New pull request</h2></header>
    {value.existing && <div className="pr-notice" role="status">
      <span>This branch already has an open pull request: #{value.existing.number} {value.existing.title}</span>
      <button type="button" onClick={() => leaveCreate(tabId, folderId, value.existing!.number, value.existing!.title)}>Open it</button>
    </div>}
    <div className="pr-branches">
      <label className="pr-field-inline">Merge into
        <select value={value.base} disabled={busy} onChange={event => setBase(event.target.value)} aria-label="Base branch">
          {value.bases.map(name => <option key={name} value={name}>{name}</option>)}
          {!value.bases.includes(value.base) && <option value={value.base}>{value.base}</option>}
        </select>
      </label>
      <span className="pr-muted">from</span><code className="pr-ref" title={value.head}>{value.head}</code>
    </div>
    <label className="pr-field">Title
      <input value={title} disabled={busy} maxLength={256} required onChange={event => { edited.current = true; setTitle(event.target.value); }}/>
    </label>
    <label className="pr-field">Description
      <textarea value={body} disabled={busy} rows={8} placeholder="What changed, and why?" onChange={event => { edited.current = true; setBody(event.target.value); }}/>
    </label>
    <label className="pr-check"><input type="checkbox" checked={isDraft} disabled={busy} onChange={event => setIsDraft(event.target.checked)}/>Create as draft</label>
    {value.needsPush && <p className="pr-muted" role="note">Publishes <code>{value.head}</code>{value.pushRemote ? <> to <code>{value.pushRemote}</code></> : null} first.</p>}
    {error && <p className="pr-error" role="alert">{error}</p>}
    <div className="pr-form-actions">
      {value.compareUrl && <button type="button" className="pr-button is-quiet" onClick={() => openBrowserTab(value.compareUrl!)}><ArrowUpRight size={12} aria-hidden="true"/>Open in browser</button>}
      <button type="submit" className="pr-button is-primary" disabled={busy || !title.trim()}>{busy ? <><Loader2 size={12} className="pr-spin" aria-hidden="true"/>{value.needsPush ? 'Pushing…' : 'Creating…'}</> : isDraft ? 'Create draft pull request' : 'Create pull request'}</button>
    </div>
  </form>;
}

// ---------------------------------------------------------------------------
// Review surface (GIT-12)

type Section = 'conversation' | 'checks' | 'files';

function mergeability(pr: GitHubPullRequest): {label: string; tone: 'ok' | 'warn' | 'bad' | 'muted'} {
  if (pr.state !== 'open') return {label: pr.state === 'merged' ? 'Merged' : 'Closed', tone: 'muted'};
  if (pr.mergeable === null) return {label: 'Checking mergeability…', tone: 'muted'};
  if (pr.mergeable === false || pr.mergeableState === 'dirty') return {label: 'Has conflicts with the base branch', tone: 'bad'};
  switch (pr.mergeableState) {
    case 'clean': return {label: 'No conflicts, ready to merge', tone: 'ok'};
    case 'blocked': return {label: 'Blocked by required reviews or checks', tone: 'warn'};
    case 'behind': return {label: 'Behind the base branch', tone: 'warn'};
    case 'unstable': return {label: 'No conflicts; some checks are failing', tone: 'warn'};
    case 'draft': return {label: 'Draft: mark ready to merge', tone: 'muted'};
    default: return {label: 'No conflicts', tone: 'ok'};
  }
}
const METHOD_LABEL: Record<GitHubMergeMethod, string> = {merge: 'Create a merge commit', squash: 'Squash and merge', rebase: 'Rebase and merge'};

function PullRequestView({folderId, number, jump}: {folderId: string; number: number; jump?: {section: Section; n: number}}): React.ReactElement {
  const pr = useQuery<GitHubPullRequest>(`pr:${folderId}:${number}`, refresh => invoke('github.pr.get', {folderId, number, refresh}));
  const repo = useQuery<GitHubRepo>(`repo:${folderId}`, refresh => invoke('github.repo', {folderId, refresh}));
  const checks = useQuery<GitHubChecks>(`checks:${folderId}:${number}:${pr.value?.headSha ?? ''}`, refresh => invoke('github.pr.checks', {folderId, number, refresh}));
  const [section, setSection] = useState<Section>(jump?.section ?? 'conversation');
  useEffect(() => { if (jump) setSection(jump.section); }, [jump?.n]);
  const [threadsKey, setThreadsKey] = useState(0);
  const pending = !!checks.value?.summary.pending;
  // Running checks refresh every 30s (GitHub's own UI polls too). Settled ones still re-read the PR every 2 minutes,
  // so a new push (new head SHA) is picked up: the checks key follows the head, and Merge sends the head shown.
  useEffect(() => {
    const timer = setInterval(() => void (pending ? checks.reload() : pr.reload()), pending ? 30_000 : 120_000);
    return () => clearInterval(timer);
  }, [pending, checks.reload, pr.reload]);
  // A checks read refreshes the head on the server: when it reports a newer head than the one shown, re-read the PR.
  const checksHead = checks.value?.headSha, prHead = pr.value?.headSha, reloadPrHead = pr.reload;
  useEffect(() => { if (checksHead && prHead && checksHead !== prHead) void reloadPrHead(); }, [checksHead, prHead, reloadPrHead]);
  const refreshAll = () => { void pr.reload(); void checks.reload(); setThreadsKey(value => value + 1); };
  // GIT-08: a running repair streams check progress; the tab follows it (new head commit, settled checks).
  const repair = useCiRepair(folderId, number);
  const reloadChecks = checks.reload, reloadPr = pr.reload, shownHead = pr.value?.headSha;
  useEffect(() => {
    if (!repair) return;
    void reloadChecks();
    if (shownHead && repair.headSha && repair.headSha !== shownHead) void reloadPr();
  }, [repair?.headSha, repair?.phase, repair?.checks?.pending, repair?.checks?.failed]);
  if (!pr.value) return pr.error ? <ResourceState kind="error" message={pr.error} onRetry={() => void pr.reload()}/> : <ResourceState kind="loading" label="Loading pull request" rows={5}/>;
  const value = pr.value;
  const merge = mergeability(value);
  const summary = checks.value?.summary;
  return <div className="pr-view">
    <header className="pr-header">
      <div className="pr-title-row">
        <h2 className="pr-title">{value.title || `Pull request #${value.number}`} <span className="pr-muted">#{value.number}</span></h2>
        <Tip label="Refresh"><button type="button" className="icon-button" aria-label="Refresh pull request" disabled={pr.loading} onClick={refreshAll}><RefreshCw size={13} className={pr.loading ? 'pr-spin' : undefined}/></button></Tip>
        <button type="button" className="pr-button is-quiet" onClick={() => openBrowserTab(value.url)} title="Open on GitHub"><ArrowUpRight size={12} aria-hidden="true"/>Open in browser</button>
      </div>
      <div className="pr-meta">
        <PrStatePill state={value.state} draft={value.draft}/>
        <span><strong>{value.author}</strong> wants to merge {value.commits ? `${plural(value.commits, 'commit')} ` : ''}into <code className="pr-ref">{value.baseRef}</code> from <code className="pr-ref">{value.headRef}</code></span>
      </div>
      <div className="pr-meta">
        <span className={`pr-merge is-${merge.tone}`} role="status">{merge.label}</span>
        {value.requestedReviewers.length > 0 && <span className="pr-muted">Review requested from {value.requestedReviewers.join(', ')}</span>}
      </div>
      {pr.error && <p className="pr-error" role="alert">{pr.error}</p>}
      <PullRequestActions folderId={folderId} pr={value} repo={repo.value} checks={checks.value} onChanged={next => { if (next) void pr.reload(); else refreshAll(); }}/>
    </header>
    <nav className="pr-sections" role="tablist" aria-label="Pull request sections">
      {([['conversation', 'Conversation'], ['checks', summary ? `Checks ${summary.failed ? `· ${summary.failed} failing` : summary.pending ? `· ${summary.pending} running` : `· ${summary.passed} passed`}` : 'Checks'], ['files', `Files changed · ${value.changedFiles}`]] as const).map(([id, label]) =>
        <button key={id} type="button" role="tab" aria-selected={section === id} className="pr-section-tab" onClick={() => setSection(id)}>{id === 'checks' && checksTone(summary) && <CheckStateIcon tone={checksTone(summary)} size={12}/>}{label}</button>)}
    </nav>
    <div className="pr-section-body" role="tabpanel">
      {section === 'conversation' && <ConversationSection folderId={folderId} pr={value}/>}
      {section === 'checks' && <ChecksSection checks={checks} folderId={folderId} pr={value}/>}
      {section === 'files' && <FilesSection key={threadsKey} folderId={folderId} pr={value}/>}
    </div>
  </div>;
}

function PullRequestActions({folderId, pr, repo, checks, onChanged}: {folderId: string; pr: GitHubPullRequest; repo?: GitHubRepo; checks?: GitHubChecks; onChanged: (pr?: GitHubPullRequest) => void}): React.ReactElement | null {
  const [busy, setBusy] = useState<string>();
  const [panel, setPanel] = useState<'review' | 'reviewers' | null>(null);
  const [reviewers, setReviewers] = useState('');
  const [reviewEvent, setReviewEvent] = useState<GitHubReviewEvent>('APPROVE');
  const [reviewBody, setReviewBody] = useState('');
  const methods = repo?.mergeMethods ?? ['merge', 'squash', 'rebase'];
  const [method, setMethod] = useState<GitHubMergeMethod>();
  const chosen = method && methods.includes(method) ? method : methods.includes('squash') ? 'squash' : methods[0]!;
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  if (pr.state !== 'open') return null;
  const run = async (label: string, action: () => Promise<unknown>, success: string) => {
    setBusy(label); setError('');
    try { await action(); notifySuccess(success); onChanged(); return true; }
    catch (cause) { setError(cleanIpcError(cause)); return false; }
    finally { setBusy(undefined); }
  };
  const failing = checks?.summary.failed ?? 0, running = checks?.summary.pending ?? 0;
  const mergeBlocked = pr.draft || pr.mergeable === false;
  return <div className="pr-actions">
    <div className="pr-action-row">
      {pr.draft && <button type="button" className="pr-button" disabled={!!busy} onClick={() => void run('ready', () => invoke('github.pr.ready', {folderId, number: pr.number}), 'Marked ready for review')}>{busy === 'ready' ? 'Marking…' : 'Mark ready for review'}</button>}
      <button type="button" className="pr-button" aria-expanded={panel === 'reviewers'} disabled={!!busy} onClick={() => setPanel(value => value === 'reviewers' ? null : 'reviewers')}>Request review</button>
      <button type="button" className="pr-button" aria-expanded={panel === 'review'} disabled={!!busy} onClick={() => setPanel(value => value === 'review' ? null : 'review')}>Review<ChevronDown size={12} aria-hidden="true"/></button>
      <span className="pr-merge-group">
        <select value={chosen} aria-label="Merge method" disabled={!!busy || mergeBlocked} onChange={event => setMethod(event.target.value as GitHubMergeMethod)}>
          {methods.map(name => <option key={name} value={name}>{METHOD_LABEL[name]}</option>)}
        </select>
        <button type="button" className="pr-button is-primary" disabled={!!busy || mergeBlocked} title={pr.draft ? 'Mark the pull request ready first' : pr.mergeable === false ? 'Resolve conflicts first' : undefined} onClick={() => setConfirming(true)}>{busy === 'merge' ? 'Merging…' : 'Merge'}</button>
      </span>
    </div>
    {panel === 'reviewers' && <form className="pr-inline-form" onSubmit={event => { event.preventDefault(); const names = reviewers.split(/[\s,]+/).filter(Boolean); void run('reviewers', () => invoke('github.pr.requestReview', {folderId, number: pr.number, reviewers: names}), `Requested review from ${names.join(', ')}`).then(ok => { if (ok) { setReviewers(''); setPanel(null); } }); }}>
      <input value={reviewers} placeholder="GitHub usernames or org/team, comma separated" aria-label="Reviewers" onChange={event => setReviewers(event.target.value)} autoFocus/>
      <button type="submit" className="pr-button is-primary" disabled={!!busy || !reviewers.trim()}>{busy === 'reviewers' ? 'Requesting…' : 'Request'}</button>
    </form>}
    {panel === 'review' && <form className="pr-inline-form is-review" onSubmit={event => { event.preventDefault(); void run('review', () => invoke('github.pr.review', {folderId, number: pr.number, event: reviewEvent, body: reviewBody}), reviewEvent === 'APPROVE' ? 'Approved' : reviewEvent === 'REQUEST_CHANGES' ? 'Requested changes' : 'Review submitted').then(ok => { if (ok) { setReviewBody(''); setPanel(null); } }); }}>
      <textarea value={reviewBody} rows={3} placeholder="Leave a review summary" aria-label="Review summary" onChange={event => setReviewBody(event.target.value)}/>
      <fieldset className="pr-review-events"><legend className="pr-sr">Review outcome</legend>
        {([['COMMENT', 'Comment'], ['APPROVE', 'Approve'], ['REQUEST_CHANGES', 'Request changes']] as const).map(([id, label]) =>
          <label key={id}><input type="radio" name="pr-review-event" checked={reviewEvent === id} onChange={() => setReviewEvent(id)}/>{label}</label>)}
      </fieldset>
      <button type="submit" className="pr-button is-primary" disabled={!!busy || (reviewEvent !== 'APPROVE' && !reviewBody.trim())}>{busy === 'review' ? 'Submitting…' : 'Submit review'}</button>
    </form>}
    {error && <p className="pr-error" role="alert">{error}</p>}
    <ConfirmSheet open={confirming} busy={busy === 'merge'} title={`${METHOD_LABEL[chosen]} #${pr.number}?`}
      description={`Merges ${pr.headRef} into ${pr.baseRef} on GitHub.${failing ? ` ${failing} check${failing === 1 ? ' is' : 's are'} failing.` : running ? ` ${running} check${running === 1 ? ' is' : 's are'} still running.` : ''} This can’t be undone from here.`}
      onCancel={() => setConfirming(false)}
      actions={[{label: 'Cancel', run: () => setConfirming(false)}, {label: 'Merge', primary: true, run: () => {
        void run('merge', () => invoke('github.pr.merge', {folderId, number: pr.number, method: chosen, expectedHeadSha: pr.headSha}), `Merged #${pr.number}`).finally(() => setConfirming(false));
      }}]}/>
  </div>;
}

// Conversation ---------------------------------------------------------------

function ConversationSection({folderId, pr}: {folderId: string; pr: GitHubPullRequest}): React.ReactElement {
  const data = useQuery<GitHubConversation>(`conv:${folderId}:${pr.number}`, refresh => invoke('github.pr.conversation', {folderId, number: pr.number, refresh}));
  const [draft, setDraft] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const items = useMemo(() => {
    const value = data.value; if (!value) return [];
    return [
      ...value.comments.map(comment => ({key: `c${comment.id}`, at: comment.createdAt, author: comment.author, body: comment.body, review: undefined as string | undefined, label: 'commented'})),
      ...value.reviews.filter(review => review.body.trim() || review.state !== 'COMMENTED').map(review => ({key: `r${review.id}`, at: review.submittedAt ?? '', author: review.author, body: review.body,
        review: review.state,
      label: review.state === 'APPROVED' ? 'approved these changes' : review.state === 'CHANGES_REQUESTED' ? 'requested changes' : review.state === 'DISMISSED' ? 'review dismissed' : 'reviewed'})),
    ].sort((a, b) => a.at.localeCompare(b.at));
  }, [data.value]);
  const send = async (event: React.FormEvent) => {
    event.preventDefault(); if (!draft.trim() || busy) return;
    setBusy(true); setError('');
    try { await invoke('github.pr.comment', {folderId, number: pr.number, body: draft}); setDraft(''); await data.reload(); }
    catch (cause) { setError(cleanIpcError(cause)); }
    finally { setBusy(false); }
  };
  return <div className="pr-conversation">
    <article className="pr-comment is-body"><header><strong>{pr.author}</strong> <span className="pr-muted">opened {when(pr.createdAt)}</span></header><Markdown text={pr.body}/></article>
    {data.error && <ResourceState kind="error" message={data.error} onRetry={() => void data.reload()} compact/>}
    {!data.value && !data.error && <ResourceState kind="loading" label="Loading comments" rows={2} compact/>}
    {items.map(item => <article key={item.key} className="pr-comment" data-review={item.review ? reviewTone(item.review) : undefined}><header><strong>{item.author}</strong> {item.review && <ReviewStatePill state={item.review}/>} <span className="pr-muted">{item.label} {when(item.at)}</span></header>{item.body.trim() && <Markdown text={item.body}/>}</article>)}
    <form className="pr-reply" onSubmit={event => void send(event)}>
      <textarea value={draft} rows={3} placeholder="Add a comment" aria-label="Add a comment" disabled={busy} onChange={event => setDraft(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void send(event); }}/>
      {error && <p className="pr-error" role="alert">{error}</p>}
      <div className="pr-form-actions"><button type="submit" className="pr-button is-primary" disabled={busy || !draft.trim()}>{busy ? 'Commenting…' : 'Comment'}</button></div>
    </form>
  </div>;
}

// Checks ---------------------------------------------------------------------

function CheckIcon({check}: {check: GitHubCheck}): React.ReactElement {
  if (check.status === 'queued') return <QueuedIcon/>;
  return <CheckStateIcon check={check}/>;
}

const failingCheck = (check: GitHubCheck) => check.status === 'completed' && !['success', 'skipped', 'neutral', 'stale'].includes(check.conclusion ?? '');

function ChecksSection({checks, folderId, pr}: {checks: Query<GitHubChecks>; folderId: string; pr: GitHubPullRequest}): React.ReactElement {
  const chatId = useStoreSelector(state => { const chat = state.snapshot?.chats.find(item => item.id === state.activeChatId); return chat?.folderId === folderId ? chat.id : undefined; });
  if (!checks.value) return checks.error ? <ResourceState kind="error" message={checks.error} onRetry={() => void checks.reload()} compact/> : <ResourceState kind="loading" label="Loading checks" rows={3} compact/>;
  const {items, summary} = checks.value;
  if (!items.length) return <ResourceState kind="empty" message="No checks reported for the latest commit." compact/>;
  return <div className="pr-checks">
    <p className="pr-muted" role="status">{summary.passed} passed · {summary.failed} failing · {summary.pending} running{summary.skipped ? ` · ${summary.skipped} skipped` : ''}{checks.error ? ` · ${checks.error}` : ''}</p>
    {pr.state === 'open' && <CiRepairControls folderId={folderId} number={pr.number} failing={summary.failed} chatId={chatId}/>}
    <ul>{items.map(check => <li key={check.id} className="pr-check-item"><div className="pr-check-row">
      <CheckIcon check={check}/>
      <span className="pr-check-name" title={check.name}>{check.name}</span>
      <span className="pr-muted">{check.status !== 'completed' ? (check.status === 'queued' ? 'Queued' : 'Running') : check.conclusion}{check.durationMs !== undefined ? ` · ${duration(check.durationMs)}` : ''}</span>
      {check.url && <button type="button" className="pr-link" onClick={() => openBrowserTab(check.url!)}>Details<ArrowUpRight size={11} aria-hidden="true"/></button>}
    </div>{failingCheck(check) && <CheckLogDisclosure key={`${checks.value!.headSha}:${check.id}`} folderId={folderId} number={pr.number} check={check}/>}</li>)}</ul>
  </div>;
}

// Files + inline review threads ----------------------------------------------

type LineTarget = {path: string; line: number; side: 'LEFT' | 'RIGHT'};
const lineKey = (path: string, side: string, line: number | null) => `${path}\0${side}\0${line ?? ''}`;
const rowTarget = (path: string, row: EditorLine): LineTarget | undefined => row.line == null ? undefined : {path, line: row.line, side: row.kind === 'deleted' ? 'LEFT' : 'RIGHT'};

function FilesSection({folderId, pr}: {folderId: string; pr: GitHubPullRequest}): React.ReactElement {
  const files = useQuery<GitHubPullFiles>(`files:${folderId}:${pr.number}:${pr.headSha}`, refresh => invoke('github.pr.files', {folderId, number: pr.number, refresh}));
  const threads = useQuery<{items: GitHubReviewThread[]}>(`threads:${folderId}:${pr.number}`, refresh => invoke('github.pr.threads', {folderId, number: pr.number, refresh}));
  const byLine = useMemo(() => {
    const map = new Map<string, GitHubReviewThread[]>();
    for (const thread of threads.value?.items ?? []) { const key = lineKey(thread.path, thread.side, thread.line); map.set(key, [...(map.get(key) ?? []), thread]); }
    return map;
  }, [threads.value]);
  // DIF-06: collapse or expand every file at once.
  const [bulk, setBulk] = useState<{open: boolean; n: number}>();
  if (!files.value) return files.error ? <ResourceState kind="error" message={files.error} onRetry={() => void files.reload()} compact/> : <ResourceState kind="loading" label="Loading changed files" rows={4} compact/>;
  return <div className="pr-files">
    {files.value.items.length > 1 && <div className="pr-files-toolbar">
      <button type="button" className="pr-link" onClick={() => setBulk(value => ({open: false, n: (value?.n ?? 0) + 1}))}>Collapse all</button>
      <button type="button" className="pr-link" onClick={() => setBulk(value => ({open: true, n: (value?.n ?? 0) + 1}))}>Expand all</button>
    </div>}
    {threads.error && <p className="pr-error" role="alert">Review comments couldn’t load: {threads.error}</p>}
    {files.value.truncated && <p className="pr-muted" role="note">Showing the first {files.value.items.length} files. Open the pull request in the browser for the rest.</p>}
    {files.value.items.map(file => <PullFile key={file.path} folderId={folderId} pr={pr} file={file} byLine={byLine} bulk={bulk}
      outdated={(threads.value?.items ?? []).filter(thread => thread.path === file.path && (thread.line == null || thread.isOutdated))} onThreadsChanged={() => void threads.reload()}/>)}
  </div>;
}

function PullFile({folderId, pr, file, byLine, outdated, onThreadsChanged, bulk}: {folderId: string; pr: GitHubPullRequest; file: GitHubPullFile; byLine: Map<string, GitHubReviewThread[]>; outdated: GitHubReviewThread[]; onThreadsChanged: () => void; bulk?: {open: boolean; n: number}}): React.ReactElement {
  const [open, setOpen] = useState(true);
  useEffect(() => { if (bulk) setOpen(bulk.open); }, [bulk?.n]);
  const [composing, setComposing] = useState<LineTarget>();
  const model = useMemo(() => file.patch ? patchEditorModel(file.patch, file.path) : undefined, [file.patch, file.path]);
  const extras: DiffLineExtras = {
    addLabel: 'Comment on line',
    onAdd: pr.state === 'open' ? row => setComposing(rowTarget(file.path, row)) : undefined,
    render: row => {
      const target = rowTarget(file.path, row); if (!target) return null;
      const list = (byLine.get(lineKey(file.path, target.side, target.line)) ?? []).filter(thread => !thread.isOutdated);
      const drafting = composing && composing.line === target.line && composing.side === target.side;
      if (!list.length && !drafting) return null;
      return <div className="pr-line-threads">
        {list.map(thread => <ReviewThread key={thread.id} folderId={folderId} number={pr.number} thread={thread} onChanged={onThreadsChanged}/>)}
        {drafting && <NewLineComment folderId={folderId} number={pr.number} target={composing!} onDone={posted => { setComposing(undefined); if (posted) onThreadsChanged(); }}/>}
      </div>;
    },
  };
  return <section className="pr-file" aria-label={file.path}>
    <button type="button" className="pr-file-head" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {open ? <ChevronDown size={13} aria-hidden="true"/> : <ChevronRight size={13} aria-hidden="true"/>}
      <span className="pr-file-path" title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}>{file.previousPath ? `${file.previousPath} → ` : ''}{file.path}</span>
      <GitCounts adds={file.additions} dels={file.deletions}/>
      <GitStatusBadge status={file.status}/>
    </button>
    {open && <>
      {outdated.length > 0 && <div className="pr-line-threads is-outdated"><p className="pr-muted">Outdated comments</p>{outdated.map(thread => <ReviewThread key={thread.id} folderId={folderId} number={pr.number} thread={thread} onChanged={onThreadsChanged}/>)}</div>}
      {model ? <DiffEditorView model={model} path={file.path} folderId={folderId} maxHeight={null} fold lineExtras={extras} label={`Changes in ${file.path}`}/>
        : <p className="pr-muted pr-file-empty">{file.status === 'renamed' ? 'Renamed without changes.' : 'Binary or large file: no inline diff.'}</p>}
    </>}
  </section>;
}

function ReviewThread({folderId, number, thread, onChanged}: {folderId: string; number: number; thread: GitHubReviewThread; onChanged: () => void}): React.ReactElement {
  const [expanded, setExpanded] = useState(!thread.isResolved);
  const [reply, setReply] = useState(''), [replying, setReplying] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await action(); onChanged(); return true; } catch (cause) { setError(cleanIpcError(cause)); return false; } finally { setBusy(false); }
  };
  const first = thread.comments[0];
  return <div className="pr-thread" data-resolved={thread.isResolved || undefined}>
    <button type="button" className="pr-thread-head" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <MessageSquare size={12} aria-hidden="true"/>
      <span>{first ? `${first.author}` : 'Thread'}{thread.comments.length > 1 ? ` + ${thread.comments.length - 1} repl${thread.comments.length === 2 ? 'y' : 'ies'}` : ''}</span>
      {thread.isResolved && <span className="pr-badge is-muted">Resolved</span>}
      {thread.isOutdated && <span className="pr-badge is-muted">Outdated</span>}
    </button>
    {expanded && <>
      {thread.comments.map(comment => <article key={comment.id} className="pr-comment is-inline"><header><strong>{comment.author}</strong> <span className="pr-muted">{when(comment.createdAt)}</span></header><Markdown text={comment.body}/></article>)}
      {replying ? <form className="pr-reply" onSubmit={event => { event.preventDefault(); void act(() => invoke('github.pr.reply', {folderId, number, threadId: thread.id, body: reply})).then(ok => { if (ok) { setReply(''); setReplying(false); } }); }}>
        <textarea value={reply} rows={2} autoFocus placeholder="Reply" aria-label="Reply" disabled={busy} onChange={event => setReply(event.target.value)}/>
        <div className="pr-form-actions">
          <button type="button" className="pr-button is-quiet" onClick={() => setReplying(false)}>Cancel</button>
          <button type="submit" className="pr-button is-primary" disabled={busy || !reply.trim()}>{busy ? 'Replying…' : 'Reply'}</button>
        </div>
      </form> : <div className="pr-thread-actions">
        {thread.viewerCanReply && <button type="button" className="pr-link" onClick={() => setReplying(true)}>Reply</button>}
        {thread.isResolved ? thread.viewerCanUnresolve && <button type="button" className="pr-link" disabled={busy} onClick={() => void act(() => invoke('github.pr.resolve', {folderId, number, threadId: thread.id, resolved: false}))}>Unresolve</button>
          : thread.viewerCanResolve && <button type="button" className="pr-link" disabled={busy} onClick={() => void act(() => invoke('github.pr.resolve', {folderId, number, threadId: thread.id, resolved: true}))}>Resolve conversation</button>}
      </div>}
      {error && <p className="pr-error" role="alert">{error}</p>}
    </>}
  </div>;
}

function NewLineComment({folderId, number, target, onDone}: {folderId: string; number: number; target: LineTarget; onDone: (posted: boolean) => void}): React.ReactElement {
  const [body, setBody] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (!body.trim() || busy) return;
    setBusy(true); setError('');
    try { await invoke('github.pr.reviewComment', {folderId, number, ...target, body}); onDone(true); }
    catch (cause) { setError(cleanIpcError(cause)); setBusy(false); }
  };
  return <form className="pr-reply pr-thread" onSubmit={event => void submit(event)} aria-label={`Comment on line ${target.line}`}>
    <textarea value={body} rows={3} autoFocus placeholder={`Comment on ${target.side === 'LEFT' ? 'removed ' : ''}line ${target.line}`} aria-label="Line comment" disabled={busy} onChange={event => setBody(event.target.value)}
      onKeyDown={event => { if (event.key === 'Escape') onDone(false); if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit(event); }}/>
    {error && <p className="pr-error" role="alert">{error}</p>}
    <div className="pr-form-actions">
      <button type="button" className="pr-button is-quiet" onClick={() => onDone(false)}>Cancel</button>
      <button type="submit" className="pr-button is-primary" disabled={busy || !body.trim()}>{busy ? 'Commenting…' : 'Comment'}</button>
    </div>
  </form>;
}
