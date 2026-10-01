/**
 * The work layer inside a task thread's Properties (Wave 2): labels (C6), the goal and its ancestry (G18), linked pull
 * requests (G34), keyed documents with revisions, diff and annotation threads (G5), and feedback votes on agent messages
 * and documents (G15). Everything goes through the `work.*` commands; nothing here talks to GitHub or an agent directly.
 */
import { Menu } from '@base-ui/react/menu';
import { Check, ExternalLink, FileText, GitPullRequest, MessageSquare, Plus, RefreshCw, ScanSearch, ThumbsDown, ThumbsUp, Trash2 } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { canvasDiffRows } from '../canvasDiff';
import { invoke } from '../bridge';
import { refreshWorkspace } from '../hubStore';
import { notifyError, notifySuccess } from '../store';
import { agoLabel, exactTime } from '../relativeTime';
import { useWorkLoad } from '../workHooks';
import { DOC_KEY, DOC_STANDARD_KEYS, LABEL_COLORS, MAX_VOTE_REASON, type DocThread, type ExternalObject, type Goal, type LabelColor, type TaskDoc, type TaskLabel, type Vote, type VoteKind, type VoteSubject } from '../../shared/domains/work-protocol';
import { goalOptions } from '../workModels';
import { LabelChip } from './WorkParts';
import { MessageBody } from './MessageBody';
import { ModalSheet } from './ModalSheet';
import { StateChip } from './HubParts';
import { Tip } from './Tooltip';
// @ts-ignore -- side-effect CSS import; esbuild bundles it into dist/renderer/main.css
import './work.css';

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

// ── Labels (C6) ──────────────────────────────────────────────────────────────
/** The labels on a task, with a menu to add or remove them and to make a new one. */
export function TaskLabelsRow({ projectId, taskId, labels, onChanged }: { projectId: string; taskId: string; labels: readonly TaskLabel[]; onChanged: () => void }): React.ReactElement {
  const { data, reload } = useWorkLoad(projectId, ['labels'], () => invoke('work.labels.list', { projectId }));
  const [name, setName] = useState(''), [color, setColor] = useState<LabelColor>('accent'), [busy, setBusy] = useState(false);
  const mine = new Set(labels.map(l => l.id));
  const set = async (ids: string[]) => { setBusy(true); try { await invoke('work.task.labels.set', { projectId, taskId, labelIds: ids }); await refreshWorkspace(); onChanged(); } catch (cause) { notifyError(cause); } finally { setBusy(false); } };
  const create = async () => {
    const n = name.trim(); if (!n) return;
    setBusy(true);
    try { const label = await invoke('work.labels.save', { projectId, name: n, color }); setName(''); reload(); await invoke('work.task.labels.set', { projectId, taskId, labelIds: [...mine, label.id] }); await refreshWorkspace(); onChanged(); }
    catch (cause) { notifyError(cause); } finally { setBusy(false); }
  };
  return <span className="work-labels-row">
    {labels.length ? labels.map(l => <LabelChip key={l.id} label={l}/>) : <span className="ws-faint">None</span>}
    <Menu.Root>
      <Tip label="Edit labels"><Menu.Trigger className="icon-button work-add" aria-label="Edit labels" disabled={busy}><Plus size={13}/></Menu.Trigger></Tip>
      <Menu.Portal><Menu.Positioner side="bottom" align="end" sideOffset={6} className="ui-menu-positioner"><Menu.Popup className="ui-menu work-label-menu">
        <Menu.Group><Menu.GroupLabel className="ui-menu-label">Labels</Menu.GroupLabel>
          {(data?.labels ?? []).length === 0 && <p className="task-filter-empty">No labels in this project yet.</p>}
          {(data?.labels ?? []).map(l => <Menu.CheckboxItem key={l.id} closeOnClick={false} checked={mine.has(l.id)} onCheckedChange={on => void set(on ? [...mine, l.id] : [...mine].filter(x => x !== l.id))}><Check size={13} className="task-check" data-on={mine.has(l.id) || undefined}/><LabelChip label={l}/></Menu.CheckboxItem>)}
        </Menu.Group>
        <Menu.Separator/>
        <form className="work-label-form" onSubmit={e => { e.preventDefault(); void create(); }}>
          <input type="text" className="ws-input" aria-label="New label name" placeholder="New label" maxLength={40} value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.stopPropagation()}/>
          <select className="ws-select" aria-label="New label colour" value={color} onChange={e => setColor(e.target.value as LabelColor)} onKeyDown={e => e.stopPropagation()}>{LABEL_COLORS.map(c => <option key={c} value={c}>{c === 'accent' ? 'Blue' : c === 'ok' ? 'Green' : c === 'warn' ? 'Amber' : c === 'danger' ? 'Red' : c === 'violet' ? 'Violet' : 'Grey'}</option>)}</select>
          <button type="submit" className="settings-button secondary" disabled={!name.trim() || busy}>Add</button>
        </form>
      </Menu.Popup></Menu.Positioner></Menu.Portal>
    </Menu.Root>
  </span>;
}

// ── Goal (G18) ───────────────────────────────────────────────────────────────
export function TaskGoalRow({ projectId, taskId, kind = 'task', refId }: { projectId: string; taskId?: string; kind?: 'task' | 'agent'; refId?: string }): React.ReactElement {
  const target = refId ?? taskId ?? '';
  const { data, reload } = useWorkLoad(projectId, ['goals'], () => invoke('work.goals.list', { projectId }), [target]);
  const current = data?.links.find(l => l.kind === kind && l.refId === target)?.goalId ?? '';
  const options = useMemo(() => goalOptions(data?.goals ?? []), [data]);
  const change = async (goalId: string) => { try { await invoke('work.goals.link', { projectId, kind, refId: target, goalId: goalId || null }); await refreshWorkspace(); reload(); } catch (cause) { notifyError(cause); } };
  const ancestry = current ? data?.ancestry[current] : null;
  return <span className="work-goal-row">
    <select className="ws-select is-bare" aria-label={kind === 'task' ? 'Goal' : 'Agent goal'} value={current} onChange={e => void change(e.target.value)} disabled={!data}>
      <option value="">No goal</option>
      {options.map(({ goal, depth }) => <option key={goal.id} value={goal.id}>{`${'  '.repeat(depth)}${goal.title}`}</option>)}
    </select>
    {ancestry && ancestry.length > 1 && <span className="work-ancestry ws-faint" title={ancestry.join(' › ')}>{ancestry.slice(0, -1).join(' › ')}</span>}
  </span>;
}

// ── Pull requests (G34) ──────────────────────────────────────────────────────
const STATE_TONE = { open: 'accent', merged: 'ok', closed: 'faint', unknown: 'faint' } as const;
const CHECK_TONE = { passing: 'ok', failing: 'danger', pending: 'warn', none: 'faint' } as const;
const CHECK_LABEL = { passing: 'Checks passing', failing: 'Checks failing', pending: 'Checks running', none: 'No checks' } as const;
export function TaskPullRequests({ projectId, taskId }: { projectId: string; taskId: string }): React.ReactElement {
  const { data, error, reload } = useWorkLoad(projectId, ['links'], () => invoke('work.links.list', { projectId, taskId }), [taskId]);
  const [url, setUrl] = useState(''), [busy, setBusy] = useState<string | null>(null);
  const links = data?.links ?? [];
  const run = async (what: string, fn: () => Promise<unknown>, done?: string) => { setBusy(what); try { await fn(); if (done) notifySuccess(done); reload(); await refreshWorkspace(); } catch (cause) { notifyError(cause); } finally { setBusy(null); } };
  // Opening the thread reads the status of links that are more than two minutes old, once. Never on a timer.
  const refreshed = useRef<string | null>(null);
  useEffect(() => {
    if (!data || refreshed.current === taskId) return;
    refreshed.current = taskId;
    if (data.links.some(l => !l.fetchedAt || Date.now() - Date.parse(l.fetchedAt) > 120_000)) void invoke('work.links.refresh', { projectId, taskId }).then(() => { reload(); return refreshWorkspace(); }, () => undefined);
  }, [data, taskId]);
  return <section className="work-section" aria-label="Pull requests">
    <ul className="work-list">{links.map(l => <li key={l.id} className="work-link" data-checks={l.checks}>
      <GitPullRequest size={13} aria-hidden="true"/>
      <span className="work-link-main"><span className="ws-ellipsis" title={l.title}>{l.title || `${l.repo}#${l.number}`}</span><span className="ws-faint">{l.repo}#{l.number}{l.draft ? ' · draft' : ''}</span></span>
      <StateChip tone={STATE_TONE[l.state]}>{l.state === 'unknown' ? 'Not read' : l.state[0]!.toUpperCase() + l.state.slice(1)}</StateChip>
      {l.state === 'open' && <StateChip tone={CHECK_TONE[l.checks]}>{CHECK_LABEL[l.checks]}</StateChip>}
      <Tip label="Open on GitHub"><button type="button" className="icon-button" aria-label={`Open ${l.repo}#${l.number} on GitHub`} onClick={() => void invoke('link.open', { url: l.url }).catch(() => { window.open(l.url, '_blank', 'noopener'); })}><ExternalLink size={13}/></button></Tip>
      <Tip label="Unlink"><button type="button" className="icon-button" aria-label={`Unlink ${l.repo}#${l.number}`} disabled={busy !== null} onClick={() => void run(`rm:${l.id}`, () => invoke('work.links.remove', { projectId, id: l.id }))}><Trash2 size={13}/></button></Tip>
      {(l.error || l.checksSummary) && <span className="work-link-note ws-faint" data-error={l.error ? 'true' : undefined}>{l.error ?? l.checksSummary}{l.fetchedAt ? ` · read ${agoLabel(l.fetchedAt)}` : ''}</span>}
    </li>)}</ul>
    {links.length === 0 && !error && <p className="ws-faint work-empty">No pull requests linked. Paste a link, or scan this thread for them.</p>}
    {error && <p className="work-error" role="alert">{error}</p>}
    <form className="work-inline-form" onSubmit={e => { e.preventDefault(); const u = url.trim(); if (!u) return; void run('add', async () => { await invoke('work.links.add', { projectId, taskId, url: u }); setUrl(''); }, 'Pull request linked.'); }}>
      <input className="ws-input" type="url" aria-label="Pull request link" placeholder="https://github.com/owner/repo/pull/12" value={url} onChange={e => setUrl(e.target.value)}/>
      <button type="submit" className="settings-button secondary" disabled={!url.trim() || busy !== null}>Link</button>
      <Tip label="Look for pull request links in this thread"><button type="button" className="icon-button" aria-label="Scan this thread for pull requests" disabled={busy !== null} onClick={() => void run('scan', async () => { const r = await invoke('work.links.scan', { projectId, taskId }); notifySuccess(r.found ? `Found ${r.found} pull request ${r.found === 1 ? 'link' : 'links'}.` : 'No pull request links in this thread.'); })}><ScanSearch size={14}/></button></Tip>
      <Tip label="Read their status again"><button type="button" className="icon-button" aria-label="Refresh pull request status" disabled={busy !== null || links.length === 0} onClick={() => void run('refresh', () => invoke('work.links.refresh', { projectId, taskId, ...(links.length === 1 ? { id: links[0]!.id } : {}) }))}><RefreshCw size={14}/></button></Tip>
    </form>
  </section>;
}

// ── Votes (G15) ──────────────────────────────────────────────────────────────
/** Thumbs on an agent message or document: Helpful / Needs work, with an optional reason. Local only. */
export function VoteButtons({ projectId, taskId, subject, subjectId, excerpt, votes, onChanged }: { projectId: string; taskId: string; subject: VoteSubject; subjectId: string; excerpt: string; votes: readonly Vote[]; onChanged: () => void }): React.ReactElement {
  const mine = votes.find(v => v.subject === subject && v.subjectId === subjectId);
  const [asking, setAsking] = useState(false), [reason, setReason] = useState(''), [busy, setBusy] = useState(false);
  const send = async (vote: VoteKind | null, why = '') => { setBusy(true); try { await invoke('work.votes.set', { projectId, taskId, subject, subjectId, vote, reason: why, excerpt }); setAsking(false); setReason(''); onChanged(); } catch (cause) { notifyError(cause); } finally { setBusy(false); } };
  return <span className="work-votes" role="group" aria-label="Feedback on this reply">
    <Tip label={mine?.vote === 'helpful' ? 'Clear: helpful' : 'Helpful'}><button type="button" className="icon-button" aria-pressed={mine?.vote === 'helpful'} aria-label="Helpful" disabled={busy} onClick={() => void send(mine?.vote === 'helpful' ? null : 'helpful')}><ThumbsUp size={13}/></button></Tip>
    <Tip label={mine?.vote === 'needs_work' ? 'Clear: needs work' : 'Needs work'}><button type="button" className="icon-button" aria-pressed={mine?.vote === 'needs_work'} aria-label="Needs work" disabled={busy} onClick={() => { if (mine?.vote === 'needs_work') void send(null); else setAsking(a => !a); }}><ThumbsDown size={13}/></button></Tip>
    {asking && <form className="work-vote-reason" onSubmit={e => { e.preventDefault(); void send('needs_work', reason.trim()); }}>
      <input type="text" className="ws-input" aria-label="What was wrong?" placeholder="What was wrong? (optional)" maxLength={MAX_VOTE_REASON} value={reason} onChange={e => setReason(e.target.value)} autoFocus/>
      <button type="submit" className="settings-button secondary" disabled={busy}>Save</button>
    </form>}
    {mine?.reason && !asking && <span className="work-vote-note ws-faint" title={mine.reason}>{mine.reason}</span>}
  </span>;
}

// ── Documents (G5) ───────────────────────────────────────────────────────────
export function TaskDocuments({ projectId, taskId, votes, onVotesChanged }: { projectId: string; taskId: string; votes: readonly Vote[]; onVotesChanged: () => void }): React.ReactElement {
  const { data, error, reload } = useWorkLoad(projectId, ['docs'], () => invoke('work.docs.list', { projectId, taskId }), [taskId]);
  const [open, setOpen] = useState<string | null>(null), [key, setKey] = useState('');
  const docs = data?.docs ?? [];
  const missing = DOC_STANDARD_KEYS.filter(k => !docs.some(d => d.key === k));
  const create = (k: string) => { const clean = k.trim().toLowerCase(); if (!DOC_KEY.test(clean)) { notifyError(new Error('A document key is 1–40 lowercase letters, digits, dashes or underscores, like plan or design.')); return; } setKey(''); setOpen(clean); };
  return <section className="work-section" aria-label="Documents">
    <ul className="work-list">{docs.map(d => <li key={d.key}>
      <button type="button" className="work-doc" onClick={() => setOpen(d.key)} aria-label={`Open the ${d.key} document`}>
        <FileText size={13} aria-hidden="true"/><span className="work-doc-key">{d.key}</span><span className="ws-faint">rev {d.rev} · {d.chars.toLocaleString()} chars</span>
        {d.openThreads > 0 && <span className="ws-chip" data-tone="warn" title={`${d.openThreads} open comment thread${d.openThreads === 1 ? '' : 's'}`}><MessageSquare size={11}/>&nbsp;{d.openThreads}</span>}
        <span className="ws-row-age" title={exactTime(d.updatedAt)}>{agoLabel(d.updatedAt)}</span>
      </button></li>)}</ul>
    {docs.length === 0 && !error && <p className="ws-faint work-empty">No documents yet. Start a plan, a design or notes: every save keeps a revision.</p>}
    {error && <p className="work-error" role="alert">{error}</p>}
    <form className="work-inline-form" onSubmit={e => { e.preventDefault(); create(key); }}>
      <input type="text" className="ws-input" aria-label="New document key" placeholder="plan, design, notes…" maxLength={40} list={`doc-keys-${taskId}`} value={key} onChange={e => setKey(e.target.value)}/>
      <datalist id={`doc-keys-${taskId}`}>{missing.map(k => <option key={k} value={k}/>)}</datalist>
      <button type="submit" className="settings-button secondary" disabled={!key.trim()}><Plus size={13}/>New</button>
    </form>
    {open && <DocDialog projectId={projectId} taskId={taskId} docKey={open} votes={votes} onVotesChanged={onVotesChanged} onClose={() => { setOpen(null); reload(); }}/>}
  </section>;
}

type DocTab = 'edit' | 'read' | 'history' | 'threads';
function DocDialog({ projectId, taskId, docKey, votes, onVotesChanged, onClose }: { projectId: string; taskId: string; docKey: string; votes: readonly Vote[]; onVotesChanged: () => void; onClose: () => void }): React.ReactElement {
  const [doc, setDoc] = useState<TaskDoc | null>(null), [missing, setMissing] = useState(false), [tab, setTab] = useState<DocTab>('edit');
  const [draft, setDraft] = useState(''), [note, setNote] = useState(''), [busy, setBusy] = useState(false), [compare, setCompare] = useState<number | null>(null);
  const load = async (rev?: number) => {
    try { const d = await invoke('work.docs.get', { projectId, taskId, key: docKey, ...(rev ? { rev } : {}) }); setDoc(d); if (!rev) setDraft(d.text); setMissing(false); }
    catch (cause) { if (/no “/.test(errorText(cause)) || /has no/.test(errorText(cause))) { setMissing(true); setDoc(null); setDraft(''); } else notifyError(cause); }
  };
  useEffect(() => { void load(); }, [docKey]);
  // A document changed elsewhere (an agent saved a revision, a comment arrived): reload threads, keep an unsaved draft.
  const { data: latest } = useWorkLoad(projectId, ['docs'], async () => { try { return await invoke('work.docs.get', { projectId, taskId, key: docKey }); } catch { return null; } }, [docKey]);
  useEffect(() => { if (latest && doc && latest.rev !== doc.rev && draft === doc.text) { setDoc(latest); setDraft(latest.text); } else if (latest && doc && latest.rev === doc.rev) setDoc(prev => prev && { ...prev, threads: latest.threads, revisions: latest.revisions }); }, [latest]);
  const dirty = doc ? draft !== doc.text : draft.length > 0;
  const save = async () => {
    setBusy(true);
    try { const saved = await invoke('work.docs.save', { projectId, taskId, key: docKey, text: draft, note: note.trim(), ...(doc ? { baseRev: doc.rev } : {}) }); setDoc(saved); setDraft(saved.text); setNote(''); setMissing(false); notifySuccess(`Saved ${docKey} (revision ${saved.rev}).`); }
    catch (cause) { notifyError(cause); } finally { setBusy(false); }
  };
  const remove = async () => { setBusy(true); try { await invoke('work.docs.remove', { projectId, taskId, key: docKey }); onClose(); } catch (cause) { notifyError(cause); setBusy(false); } };
  const openThreads = doc?.threads.filter(t => t.status === 'open').length ?? 0;
  return <ModalSheet open title={`${docKey} document`} description={doc ? `Revision ${doc.rev} · ${doc.revisions.length} saved` : 'A new document: the first save makes revision 1.'} className="composer-confirm work-dialog work-doc-dialog" testId="work-doc-dialog" onClose={() => { if (!busy) onClose(); }}>
    <div className="work-tabs" role="tablist" aria-label="Document views">
      {(['edit', 'read', 'history', 'threads'] as const).map(t => <button key={t} type="button" role="tab" aria-selected={tab === t} aria-pressed={tab === t} className="ws-filter" onClick={() => setTab(t)}>{t === 'edit' ? 'Edit' : t === 'read' ? 'Read and comment' : t === 'history' ? `History${doc ? ` (${doc.revisions.length})` : ''}` : `Comments${openThreads ? ` (${openThreads})` : ''}`}</button>)}
    </div>
    {tab === 'edit' && <div className="work-doc-edit">
      <textarea className="gov-editor work-doc-text" aria-label={`${docKey} text`} value={draft} onChange={e => setDraft(e.target.value)} spellCheck={false}/>
      <div className="work-inline-form">
        <input type="text" className="ws-input" aria-label="Revision note" placeholder="Note for this revision (optional)" maxLength={200} value={note} onChange={e => setNote(e.target.value)}/>
        <button type="button" className="settings-button" disabled={busy || !dirty || (!doc && !draft.trim())} onClick={() => void save()}>Save revision</button>
        {doc && <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void remove()}><Trash2 size={13}/>Delete</button>}
      </div>
      {missing && <p className="ws-faint">Nothing saved under “{docKey}” yet.</p>}
    </div>}
    {tab === 'read' && doc && <DocReader projectId={projectId} taskId={taskId} doc={doc} onChanged={() => void load()}/>}
    {tab === 'read' && !doc && <p className="ws-faint">Save the document first, then select text in it to comment.</p>}
    {tab === 'history' && doc && <div className="work-history">
      <ul className="work-list">{doc.revisions.map((r, i) => <li key={r.rev} className="work-rev" data-current={r.rev === doc.rev || undefined}>
        <span className="work-rev-id">rev {r.rev}</span><span className="work-rev-note">{r.note || <span className="ws-faint">No note</span>}</span><span className="ws-faint">{r.actor} · {r.chars.toLocaleString()} chars · <time title={exactTime(r.createdAt)}>{agoLabel(r.createdAt)}</time></span>
        {i < doc.revisions.length - 1 && <button type="button" className="ws-link" aria-label={`Compare revision ${r.rev} with the one before`} onClick={() => setCompare(compare === r.rev ? null : r.rev)}>Compare</button>}
        {r.rev !== doc.rev && <button type="button" className="ws-link" aria-label={`Restore revision ${r.rev}`} disabled={busy} onClick={() => { setBusy(true); void invoke('work.docs.restore', { projectId, taskId, key: docKey, rev: r.rev }).then(d => { setDoc(d); setDraft(d.text); notifySuccess(`Restored revision ${r.rev} as revision ${d.rev}.`); }, notifyError).finally(() => setBusy(false)); }}>Restore</button>}
      </li>)}</ul>
      {compare !== null && <RevisionDiff projectId={projectId} taskId={taskId} docKey={docKey} rev={compare} previous={doc.revisions[doc.revisions.findIndex(r => r.rev === compare) + 1]?.rev ?? compare - 1}/>}
    </div>}
    {tab === 'threads' && doc && <DocThreads projectId={projectId} taskId={taskId} doc={doc} onChanged={() => void load()}/>}
    {doc && <div className="work-doc-foot"><span className="ws-faint">Is this document useful?</span><VoteButtons projectId={projectId} taskId={taskId} subject="document" subjectId={`${taskId}:${docKey}`} excerpt={`${docKey} (revision ${doc.rev}): ${doc.text.slice(0, 160)}`} votes={votes} onChanged={onVotesChanged}/></div>}
    <div className="composer-confirm-actions"><button type="button" onClick={onClose}>Close</button></div>
  </ModalSheet>;
}

function RevisionDiff({ projectId, taskId, docKey, rev, previous }: { projectId: string; taskId: string; docKey: string; rev: number; previous: number }): React.ReactElement {
  const [rows, setRows] = useState<ReturnType<typeof canvasDiffRows> | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([invoke('work.docs.get', { projectId, taskId, key: docKey, rev: previous }), invoke('work.docs.get', { projectId, taskId, key: docKey, rev })]).then(([a, b]) => { if (live) setRows(canvasDiffRows(a.text, b.text)); }, notifyError);
    return () => { live = false; };
  }, [rev, previous]);
  if (!rows) return <p className="ws-faint">Comparing…</p>;
  return <div className="work-diff" role="region" aria-label={`Revision ${previous} to ${rev}`}>
    <p className="ws-faint">Revision {previous} → {rev}: +{rows.added} −{rows.removed}</p>
    <pre>{rows.rows.map((r, i) => <span key={i} className="work-diff-row" data-kind={r.kind}>{r.kind === 'add' ? '+ ' : r.kind === 'del' ? '− ' : r.kind === 'gap' ? '… ' : '  '}{r.text}{'\n'}</span>)}</pre>
  </div>;
}

/** The text with its anchored threads highlighted. Select any run of text to comment on it. */
function DocReader({ projectId, taskId, doc, onChanged }: { projectId: string; taskId: string; doc: TaskDoc; onChanged: () => void }): React.ReactElement {
  const root = useRef<HTMLPreElement>(null);
  const [sel, setSel] = useState<{ start: number; end: number; quote: string } | null>(null), [body, setBody] = useState(''), [busy, setBusy] = useState(false);
  const segments = useMemo(() => {
    const spots = doc.threads.filter(t => t.current && t.rev <= doc.rev).map(t => ({ start: t.start, end: t.end, id: t.id, open: t.status === 'open' })).sort((a, b) => a.start - b.start);
    const out: { text: string; thread?: { id: string; open: boolean } }[] = []; let at = 0;
    for (const s of spots) { if (s.start < at) continue; if (s.start > at) out.push({ text: doc.text.slice(at, s.start) }); out.push({ text: doc.text.slice(s.start, s.end), thread: { id: s.id, open: s.open } }); at = s.end; }
    if (at < doc.text.length) out.push({ text: doc.text.slice(at) });
    return out;
  }, [doc]);
  const capture = () => {
    const el = root.current, selection = window.getSelection?.();
    if (!el || !selection || selection.rangeCount === 0 || selection.isCollapsed || !el.contains(selection.anchorNode) || !el.contains(selection.focusNode)) { return; }
    const range = selection.getRangeAt(0), pre = range.cloneRange(); pre.selectNodeContents(el); pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length, quote = range.toString();
    if (!quote.trim()) return;
    setSel({ start, end: start + quote.length, quote });
  };
  const add = async () => {
    if (!sel || !body.trim()) return;
    setBusy(true);
    try { await invoke('work.docs.thread.add', { projectId, taskId, key: doc.key, rev: doc.rev, quote: sel.quote, start: sel.start, end: sel.end, body: body.trim() }); setSel(null); setBody(''); notifySuccess('Comment added. The owner was told.'); onChanged(); }
    catch (cause) { notifyError(cause); } finally { setBusy(false); }
  };
  return <div className="work-reader">
    <pre ref={root} className="work-doc-read" aria-label={`${doc.key} text, select to comment`} onMouseUp={capture} onKeyUp={capture}>{segments.map((s, i) => s.thread ? <mark key={i} className="work-anchor" data-open={s.thread.open || undefined} data-thread={s.thread.id}>{s.text}</mark> : <React.Fragment key={i}>{s.text}</React.Fragment>)}</pre>
    {sel ? <form className="work-comment-form" onSubmit={e => { e.preventDefault(); void add(); }}>
      <p className="ws-faint">Commenting on “{sel.quote.length > 120 ? `${sel.quote.slice(0, 119)}…` : sel.quote}”</p>
      <textarea className="work-comment-text" aria-label="Comment on the selection" rows={2} placeholder="What should change?" value={body} onChange={e => setBody(e.target.value)} autoFocus/>
      <div className="work-inline-form"><button type="submit" className="settings-button" disabled={busy || !body.trim()}>Comment</button><button type="button" className="settings-button secondary" onClick={() => { setSel(null); setBody(''); }}>Cancel</button></div>
    </form> : <p className="ws-faint">Select text above to comment on it. The task’s owner is woken with your comment.</p>}
  </div>;
}

function DocThreads({ projectId, taskId, doc, onChanged }: { projectId: string; taskId: string; doc: TaskDoc; onChanged: () => void }): React.ReactElement {
  const [reply, setReply] = useState<Record<string, string>>({});
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); onChanged(); } catch (cause) { notifyError(cause); } };
  if (!doc.threads.length) return <p className="ws-faint">No comments on this document yet. Select text under “Read and comment”.</p>;
  return <ul className="work-threads">{doc.threads.map((t: DocThread) => <li key={t.id} className="work-thread" data-status={t.status}>
    <p className="work-quote">“{t.quote.length > 160 ? `${t.quote.slice(0, 159)}…` : t.quote}”{!t.current && <span className="ws-chip" data-tone="warn" title="This text changed after the comment was made">text changed</span>}<span className="ws-faint"> · rev {t.rev}</span></p>
    {t.comments.map(c => <div key={c.id} className="work-comment"><strong>{c.author}</strong> <span className="ws-faint" title={exactTime(c.createdAt)}>{agoLabel(c.createdAt)}</span><MessageBody text={c.body}/></div>)}
    <div className="work-inline-form">
      <input type="text" className="ws-input" aria-label={`Reply to the comment on “${t.quote.slice(0, 30)}”`} placeholder="Reply…" value={reply[t.id] ?? ''} onChange={e => setReply(r => ({ ...r, [t.id]: e.target.value }))}/>
      <button type="button" className="settings-button secondary" disabled={!(reply[t.id] ?? '').trim()} onClick={() => void act(async () => { await invoke('work.docs.thread.reply', { projectId, taskId, key: doc.key, threadId: t.id, body: reply[t.id]!.trim() }); setReply(r => ({ ...r, [t.id]: '' })); })}>Reply</button>
      <button type="button" className="settings-button secondary" onClick={() => void act(() => invoke('work.docs.thread.resolve', { projectId, taskId, key: doc.key, threadId: t.id, resolved: t.status === 'open' }))}>{t.status === 'open' ? 'Resolve' : 'Reopen'}</button>
    </div>
  </li>)}</ul>;
}

