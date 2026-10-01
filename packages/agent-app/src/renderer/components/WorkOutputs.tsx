/**
 * Outputs depth (G4): what a project's agents made, by kind (documents, images, video, text, data, code, pull requests),
 * searchable, grouped by task, each with a work-product status (draft, ready for review, approved, changes requested,
 * merged), approve / request changes (which tells the task's owner), an arrival cue for what is new since you last looked,
 * and previews through the app's own file viewers and pull request tab.
 */
import { Box, Check, ExternalLink, FileText, GitPullRequest, Image, Search, Table2, Video, Code2, Type } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceRow, WorkspaceSnapshot } from '../../shared/domains/paperclip-protocol';
import { OUTPUT_KINDS, OUTPUT_STATUS_LABEL, OUTPUT_STATUSES, type OutputKind, type OutputStatus } from '../../shared/domains/work-protocol';
import { filterOutputs, outputItems, type OutputItem } from '../outputsModel';
import { invoke } from '../bridge';
import { agoLabel, exactTime } from '../relativeTime';
import { closeSettings, notifyError, notifySuccess, openFile, openPullRequestTab } from '../store';
import { useStore } from '../useStore';
import { useWorkLoad } from '../workHooks';
import { StateChip } from './HubParts';
import { PreviewStrip } from './ServicesPanel';
import type { HubNav } from './HubPages';
import { ResourceState } from './ResourceState';
import { Tip } from './Tooltip';
// @ts-ignore -- side-effect CSS import; esbuild bundles it into dist/renderer/main.css
import './work.css';

const ICON: Record<OutputKind, React.ComponentType<{ size?: number; 'aria-hidden'?: boolean }>> = { document: FileText, image: Image, video: Video, text: Type, data: Table2, code: Code2, pull_request: GitPullRequest, file: Box };
const STATUS_TONE: Record<OutputStatus, 'faint' | 'warn' | 'ok' | 'danger' | 'violet'> = { draft: 'faint', ready_for_review: 'warn', approved: 'ok', changes_requested: 'danger', merged: 'violet' };
const CAP = 120;

export function OutputsPanel({ snapshot, projectId, local, nav }: { snapshot: WorkspaceSnapshot; projectId: string; local: boolean; nav: HubNav }): React.ReactElement {
  const app = useStore().snapshot;
  const list = useWorkLoad(projectId, ['outputs', 'links'], () => invoke('paperclip.list', { kind: 'artifacts' }), [snapshot.fetchedAt]);
  const meta = useWorkLoad(projectId, ['outputs', 'links'], () => local ? invoke('work.outputs.state', { projectId }) : Promise.resolve(null), [local]);
  const [kind, setKind] = useState<OutputKind | 'all'>('all'), [query, setQuery] = useState(''), [status, setStatus] = useState<OutputStatus | 'all' | 'none'>('all'), [group, setGroup] = useState<'none' | 'task' | 'kind'>('none'), [more, setMore] = useState(false);
  const [asking, setAsking] = useState<string | null>(null), [note, setNote] = useState(''), [busy, setBusy] = useState<string | null>(null);
  const states = meta.data?.states ?? {}, seenAt = meta.data?.seenAt ?? null;
  const items = useMemo(() => outputItems((list.data?.rows ?? []).filter(r => r.projectId === projectId), meta.data?.pullRequests ?? []), [list.data, meta.data, projectId]);
  const tasks = useMemo(() => new Map(snapshot.tasks.map(t => [t.id, t])), [snapshot.tasks]);
  const counts = useMemo(() => { const c = new Map<OutputKind, number>(); for (const i of items) c.set(i.kind, (c.get(i.kind) ?? 0) + 1); return c; }, [items]);
  const shown = useMemo(() => filterOutputs(items, { kind, query, status, states }), [items, kind, query, status, states]);
  const isNew = (i: OutputItem) => seenAt !== null && i.at !== null && i.at > seenAt;
  const fresh = items.filter(isNew).length;
  // The arrival cue: a toast when outputs arrive while you are looking, and everything counts as seen when you leave.
  const known = useRef<number | null>(null);
  useEffect(() => { if (!list.data || !meta.data) return; if (known.current !== null && items.length > known.current) notifySuccess(`${items.length - known.current} new ${items.length - known.current === 1 ? 'output' : 'outputs'} from your agents.`); known.current = items.length; }, [items.length, list.data, meta.data]);
  useEffect(() => () => { if (local) void invoke('work.outputs.seen', { projectId }).catch(() => undefined); }, [projectId, local]);
  const primaryFolder = app?.projects.find(p => p.id === projectId)?.primaryFolderId ?? app?.projects.find(p => p.id === projectId)?.folderIds[0];
  const setState = async (i: OutputItem, next: OutputStatus, why = '') => {
    setBusy(i.id);
    try { await invoke('work.outputs.status', { projectId, outputId: i.id, status: next, note: why, taskId: i.taskId, title: i.title }); setAsking(null); setNote(''); meta.reload(); if (next === 'changes_requested') notifySuccess('Sent. The owner has your note.'); }
    catch (cause) { notifyError(cause); } finally { setBusy(null); }
  };
  const open = (i: OutputItem) => {
    if (i.kind === 'pull_request' && i.url) { void invoke('link.open', { url: i.url }).catch(() => { window.open(i.url!, '_blank', 'noopener'); }); return; }
    if (i.path && primaryFolder) { void openFile(primaryFolder, i.path); closeSettings(); }
  };
  const groups = useMemo(() => {
    const map = new Map<string, { label: string; rows: OutputItem[] }>();
    for (const i of shown.slice(0, more ? shown.length : CAP)) {
      const key = group === 'task' ? i.taskId ?? '' : group === 'kind' ? i.kind : 'all';
      const label = group === 'task' ? (i.taskId && tasks.get(i.taskId) ? `${tasks.get(i.taskId)!.key} · ${tasks.get(i.taskId)!.title}` : 'Not tied to a task') : group === 'kind' ? OUTPUT_KINDS.find(k => k.id === i.kind)!.label : '';
      const g = map.get(key) ?? { label, rows: [] }; g.rows.push(i); map.set(key, g);
    }
    return [...map.values()];
  }, [shown, group, more, tasks]);
  if (list.error && !list.data) return <ResourceState kind="error" message="Outputs could not be loaded." detail={list.error} onRetry={list.reload}/>;
  if (!list.data) return <ResourceState kind="loading" label="Loading outputs" rows={4}/>;
  return <section className="work-outputs" aria-label="Outputs">
    {list.data.note && <ResourceState kind="partial" compact message={list.data.note}/>}
    {local && <PreviewStrip projectId={projectId} taskKey={id => tasks.get(id)?.key ?? null}/>}
    <div className="task-toolbar" role="toolbar" aria-label="Filter outputs">
      <label className="task-search"><Search size={14} aria-hidden="true"/><span className="sr-only">Search outputs</span><input type="search" placeholder="Search outputs…" value={query} onChange={e => setQuery(e.target.value)}/></label>
      <span className="task-toolbar-spacer"/>
      {fresh > 0 && <span className="ws-chip" data-tone="accent" title="Made since you last looked at this tab">{fresh} new</span>}
      {local && <select className="ws-select" aria-label="Status" value={status} onChange={e => setStatus(e.target.value as typeof status)}><option value="all">Any status</option><option value="none">No status</option>{OUTPUT_STATUSES.map(s => <option key={s} value={s}>{OUTPUT_STATUS_LABEL[s]}</option>)}</select>}
      <select className="ws-select" aria-label="Group by" value={group} onChange={e => setGroup(e.target.value as typeof group)}><option value="none">No grouping</option><option value="task">Group by task</option><option value="kind">Group by kind</option></select>
    </div>
    <div className="ws-filters" role="tablist" aria-label="Kinds">
      <button type="button" role="tab" aria-selected={kind === 'all'} className="ws-filter" aria-pressed={kind === 'all'} onClick={() => setKind('all')}>All<span>{items.length}</span></button>
      {OUTPUT_KINDS.filter(k => counts.get(k.id)).map(k => <button key={k.id} type="button" role="tab" aria-selected={kind === k.id} className="ws-filter" aria-pressed={kind === k.id} onClick={() => setKind(k.id)}>{k.label}<span>{counts.get(k.id)}</span></button>)}
    </div>
    {items.length === 0 ? <ResourceState kind="empty" icon={<Box size={20}/>} message="Files and documents your agents produce, and the pull requests linked to your tasks, appear here."/>
      : shown.length === 0 ? <ResourceState kind="empty" compact message="No outputs match."/>
      : groups.map(g => <div key={g.label || 'all'} className="work-output-group">
        {g.label && <h3 className="ws-group-title">{g.label}<span>{g.rows.length}</span></h3>}
        <ul className="ws-rows" aria-label={g.label || 'Outputs'}>{g.rows.map(i => {
          const Icon = ICON[i.kind], st = states[i.id], task = i.taskId ? tasks.get(i.taskId) : undefined, can = Boolean(i.path && primaryFolder) || Boolean(i.url);
          return <li key={i.id} className="work-output" data-new={isNew(i) || undefined} data-kind={i.kind}>
            <div className="ws-row is-static">
              <Icon size={15} aria-hidden={true}/>
              <span className="ws-row-text"><span className="ws-row-title">{can ? <button type="button" className="work-output-open" onClick={() => open(i)}>{i.title}</button> : i.title}{isNew(i) && <span className="ws-chip" data-tone="accent">New</span>}</span>
                <span className="ws-row-meta">{i.detail}</span></span>
              {task && group !== 'task' && <button type="button" className="ws-chip-link" onClick={() => nav.onOpenTask(task.id)} title={task.title}>{task.key}</button>}
              {local && (st ? <StateChip tone={STATUS_TONE[st.status]}>{OUTPUT_STATUS_LABEL[st.status]}</StateChip> : null)}
              {local && <select className="ws-select is-bare" aria-label={`Status of ${i.title}`} value={st?.status ?? ''} disabled={busy === i.id} onChange={e => { const v = e.target.value as OutputStatus; if (!v) return; if (v === 'changes_requested') { setAsking(i.id); setNote(''); } else void setState(i, v); }}><option value="" disabled>Set status…</option>{OUTPUT_STATUSES.map(s => <option key={s} value={s}>{OUTPUT_STATUS_LABEL[s]}</option>)}</select>}
              {local && st?.status === 'ready_for_review' && <>
                <button type="button" className="settings-button" disabled={busy === i.id} onClick={() => void setState(i, 'approved')}><Check size={13}/>Approve</button>
                <button type="button" className="settings-button secondary" disabled={busy === i.id} onClick={() => { setAsking(i.id); setNote(''); }}>Request changes</button></>}
              {i.kind === 'pull_request' && i.prNumber && i.repo && primaryFolder && <Tip label="Open in the pull request tab"><button type="button" className="icon-button" aria-label={`Open ${i.repo}#${i.prNumber} in Muster`} onClick={() => { openPullRequestTab(primaryFolder, i.prNumber!, i.title); closeSettings(); }}><GitPullRequest size={13}/></button></Tip>}
              {i.url && <Tip label="Open on GitHub"><button type="button" className="icon-button" aria-label={`Open ${i.title} on GitHub`} onClick={() => open(i)}><ExternalLink size={13}/></button></Tip>}
              {i.at && <span className="ws-row-age" title={exactTime(i.at)}>{agoLabel(i.at)}</span>}
            </div>
            {st?.status === 'changes_requested' && st.note && <p className="work-output-note"><strong>Changes requested:</strong> {st.note}</p>}
            {asking === i.id && <form className="work-comment-form" onSubmit={e => { e.preventDefault(); void setState(i, 'changes_requested', note.trim()); }}>
              <textarea className="work-comment-text" aria-label={`What should change in ${i.title}?`} rows={2} placeholder="What should change? The owner receives this note." value={note} onChange={e => setNote(e.target.value)} autoFocus/>
              <div className="work-inline-form"><button type="submit" className="settings-button" disabled={!note.trim() || busy === i.id}>Request changes</button><button type="button" className="settings-button secondary" onClick={() => setAsking(null)}>Cancel</button></div>
            </form>}
          </li>;
        })}</ul>
      </div>)}
    {shown.length > CAP && !more && <button type="button" className="ws-link" onClick={() => setMore(true)}>Show {shown.length - CAP} more</button>}
  </section>;
}
