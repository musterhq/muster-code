/**
 * The work layer inside a project (Wave 2): status and target date in the header and General settings (G32), the paused
 * banner on the Dashboard (C18), living status cards (G2), the goals tree (G18), labels (C6) and the feedback list (G15).
 * Everything goes through the `work.*` commands.
 */
import { Pause, Pencil, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import type { WorkspaceProject, WorkspaceSnapshot } from '../../shared/domains/paperclip-protocol';
import {
  GOAL_LEVEL_LABEL, GOAL_LEVELS, GOAL_STATUS_LABEL, GOAL_STATUSES, LABEL_COLORS, PROJECT_STATUS_LABEL, PROJECT_STATUSES, SUMMARY_LIMITS, SUMMARY_REFRESH_LABEL, buildGoalTree, isOverdue,
  type Goal, type GoalLevel, type GoalNode, type GoalStatus, type LabelColor, type ProjectStatus, type SummaryCard, type SummaryRefresh,
} from '../../shared/domains/work-protocol';
import { invoke } from '../bridge';
import { refreshWorkspace } from '../hubStore';
import { agoLabel, exactTime } from '../relativeTime';
import { notifyError, notifySuccess } from '../store';
import { useWorkLoad } from '../workHooks';
import { StateChip } from './HubParts';
import { MessageBody } from './MessageBody';
import { ModalSheet } from './ModalSheet';
import { ResourceState } from './ResourceState';
import { LabelChip, daysUntil, dayLabel } from './WorkParts';
import { goalOptions } from '../workModels';
import { Tip } from './Tooltip';

const STATUS_TONE: Record<ProjectStatus, 'faint' | 'accent' | 'ok' | 'warn'> = { backlog: 'faint', planned: 'warn', in_progress: 'accent', completed: 'ok', cancelled: 'faint' };

// ── Status and target date (G32) ─────────────────────────────────────────────
/** The header chips: the project's status, and its target date with how far off it is, red once overdue. */
export function ProjectStatusChips({ project }: { project: Pick<WorkspaceProject, 'status' | 'targetDate' | 'starred'> | undefined }): React.ReactElement | null {
  if (!project) return null;
  const status = (PROJECT_STATUSES.includes(project.status as ProjectStatus) ? project.status : 'in_progress') as ProjectStatus;
  const target = project.targetDate ?? null, overdue = isOverdue(status, target), days = target ? daysUntil(target) : 0;
  return <>
    <StateChip tone={STATUS_TONE[status]}>{PROJECT_STATUS_LABEL[status]}</StateChip>
    {target && <span className="ws-chip" data-tone={overdue ? 'danger' : undefined} title={`Target date ${dayLabel(target)}`}>{overdue ? `Overdue · ${dayLabel(target)}` : status === 'completed' || status === 'cancelled' ? `Target ${dayLabel(target)}` : days === 0 ? 'Due today' : `Target ${dayLabel(target)} · ${days} ${days === 1 ? 'day' : 'days'}`}</span>}
  </>;
}
export function ProjectStatusFields({ projectId, status, targetDate }: { projectId: string; status: string; targetDate: string | null }): React.ReactElement {
  const [date, setDate] = useState(targetDate ?? ''), [busy, setBusy] = useState(false);
  const current = (PROJECT_STATUSES.includes(status as ProjectStatus) ? status : 'in_progress') as ProjectStatus;
  const save = async (patch: { status?: ProjectStatus; targetDate?: string | null }) => {
    setBusy(true);
    try { const meta = await invoke('work.project.meta.set', { projectId, ...patch }); setDate(meta.targetDate ?? ''); await refreshWorkspace(); notifySuccess('Project status saved.'); }
    catch (cause) { notifyError(cause); setDate(targetDate ?? ''); } finally { setBusy(false); }
  };
  return <>
    <div><dt>Status</dt><dd><select className="ws-select" aria-label="Project status" value={current} disabled={busy} onChange={e => void save({ status: e.target.value as ProjectStatus })}>{PROJECT_STATUSES.map(s => <option key={s} value={s}>{PROJECT_STATUS_LABEL[s]}</option>)}</select></dd></div>
    <div><dt>Target date</dt><dd className="pp-inline-form">
      <input className="ws-input" type="date" aria-label="Target date" value={date} disabled={busy} onChange={e => setDate(e.target.value)}/>
      <button type="button" className="settings-button secondary" disabled={busy || date === (targetDate ?? '')} onClick={() => void save({ targetDate: date || null })}>Save</button>
      {targetDate && <button type="button" className="settings-button secondary" disabled={busy} onClick={() => void save({ targetDate: null })}>Clear</button>}
    </dd></div>
  </>;
}

// ── Paused banner (C18) ──────────────────────────────────────────────────────
export function PausedBanner({ project }: { project: Pick<WorkspaceProject, 'id' | 'paused' | 'source'> | undefined }): React.ReactElement | null {
  const [busy, setBusy] = useState(false);
  if (!project?.paused || project.source !== 'local') return null;
  const resume = async () => { setBusy(true); try { await invoke('project.scheduler.set', { projectId: project.id, paused: false }); await refreshWorkspace(); notifySuccess('Agents resumed.'); } catch (cause) { notifyError(cause); } finally { setBusy(false); } };
  return <div className="work-banner" role="status" data-tone="warn"><Pause size={14} aria-hidden="true"/><span>This project’s agents are paused. Running work stopped, and nothing new starts until you resume.</span><button type="button" className="settings-button secondary" disabled={busy} onClick={() => void resume()}><Play size={13}/>Resume</button></div>;
}

// ── Status cards (G2) ────────────────────────────────────────────────────────
export function StatusCards({ projectId, archived = false }: { projectId: string; archived?: boolean }): React.ReactElement {
  const { data, error, reload } = useWorkLoad(projectId, ['summaries'], () => invoke('work.summaries.list', { projectId }));
  const [editing, setEditing] = useState<SummaryCard | 'new' | null>(null), [busy, setBusy] = useState<string | null>(null);
  const cards = data?.cards ?? [];
  const run = async (key: string, fn: () => Promise<unknown>) => { setBusy(key); try { await fn(); reload(); } catch (cause) { notifyError(cause); reload(); } finally { setBusy(null); } };
  const refresh = (card: SummaryCard, force = false) => run(`r:${card.id}`, async () => { const r = await invoke('work.summaries.refresh', { projectId, id: card.id, ...(force ? { force: true } : {}) }); if (r.status === 'unchanged') notifySuccess(`${card.title}: nothing changed since the last revision, so no agent was started.`); });
  const addDefault = () => run('add', async () => { const card = await invoke('work.summaries.save', { projectId, title: 'Project summary', query: '', refresh: 'daily', tokenCap: 600 }); await invoke('work.summaries.refresh', { projectId, id: card.id }); });
  return <section className="work-cards" aria-label="Status cards">
    <div className="ws-section-head"><h2>Status cards</h2>{!archived && <button type="button" className="settings-button secondary" onClick={() => setEditing('new')}><Plus size={13}/>New status card</button>}</div>
    {error && !data ? <ResourceState kind="error" compact message="Status cards could not be loaded." detail={error} onRetry={reload}/>
      : !data ? <ResourceState kind="loading" compact label="Loading status cards" rows={2}/>
      : cards.length === 0 ? <ResourceState kind="empty" compact message="A status card is a short report an agent keeps up to date from the tasks it watches. It reads the project, never changes it, and skips the run when nothing changed.">{!archived && <button type="button" className="settings-button" disabled={busy !== null} onClick={() => void addDefault()}><Plus size={13}/>Add a project summary</button>}</ResourceState>
      : <div className="work-card-grid">{cards.map(card => <StatusCard key={card.id} card={card} busy={busy === `r:${card.id}`} archived={archived} projectId={projectId}
          onRefresh={force => void refresh(card, force)} onEdit={() => setEditing(card)} onDelete={() => void run(`d:${card.id}`, () => invoke('work.summaries.remove', { projectId, id: card.id }))}/>)}</div>}
    {editing && <CardDialog projectId={projectId} card={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }}/>}
  </section>;
}
function StatusCard({ card, projectId, busy, archived, onRefresh, onEdit, onDelete }: { card: SummaryCard; projectId: string; busy: boolean; archived: boolean; onRefresh: (force: boolean) => void; onEdit: () => void; onDelete: () => void }): React.ReactElement {
  const [rev, setRev] = useState<number | null>(null), [old, setOld] = useState<{ rev: number; text: string; createdAt: string } | null>(null), [confirm, setConfirm] = useState(false);
  const pick = async (value: string) => { if (!value) { setRev(null); setOld(null); return; } const n = Number(value); setRev(n); try { setOld(await invoke('work.summaries.revision', { projectId, id: card.id, rev: n })); } catch (cause) { notifyError(cause); } };
  const shown = old && rev !== card.rev ? old : null;
  return <article className="work-card dash-card" aria-label={`Status card ${card.title}`} data-state={card.state}>
    <header className="work-card-head"><h3>{card.title}</h3>
      <span className="work-card-chips"><span className="ws-chip">{SUMMARY_REFRESH_LABEL[card.refresh]}</span><span className="ws-chip" title={card.query ? `Watches: ${card.query}` : 'Watches every task'}>{card.query ? card.query : 'All tasks'} · {card.watching}</span></span>
      <span className="work-card-actions">
        {card.revisions.length > 1 && <select className="ws-select is-bare" aria-label={`${card.title} revisions`} value={rev ?? ''} onChange={e => void pick(e.target.value)}><option value="">Latest (rev {card.rev})</option>{card.revisions.slice(1).map(r => <option key={r.rev} value={r.rev}>Rev {r.rev} · {agoLabel(r.createdAt)}</option>)}</select>}
        {!archived && <Tip label={card.state === 'working' ? 'Writing…' : 'Refresh now'}><button type="button" className="icon-button" aria-label={`Refresh ${card.title}`} disabled={busy || card.state === 'working'} onClick={e => onRefresh(e.shiftKey)}><RefreshCw size={14} className={busy || card.state === 'working' ? 'work-spin' : undefined}/></button></Tip>}
        {!archived && <Tip label="Edit"><button type="button" className="icon-button" aria-label={`Edit ${card.title}`} onClick={onEdit}><Pencil size={14}/></button></Tip>}
        {!archived && (confirm ? <><button type="button" className="automation-confirm" onClick={() => setConfirm(false)}>Keep</button><button type="button" className="automation-confirm danger" onClick={onDelete}>Delete</button></>
          : <Tip label="Delete"><button type="button" className="icon-button" aria-label={`Delete ${card.title}`} onClick={() => setConfirm(true)}><Trash2 size={14}/></button></Tip>)}
      </span></header>
    {card.state === 'working' && <p className="work-card-note" role="status">An agent is writing this card from the watched tasks…</p>}
    {card.state === 'failed' && <p className="work-card-note work-error" role="alert">{card.error ?? 'The last run did not finish.'} <button type="button" className="ws-link" onClick={() => onRefresh(true)}>Try again</button></p>}
    {(shown?.text ?? card.text) ? <div className="work-card-body"><MessageBody text={shown?.text ?? card.text}/></div> : card.state !== 'working' && card.state !== 'failed' && <p className="ws-faint">No revision yet. Refresh to write the first one.</p>}
    <footer className="work-card-foot ws-faint">{shown ? <>Revision {shown.rev} · <time title={exactTime(shown.createdAt)}>{agoLabel(shown.createdAt)}</time> · <button type="button" className="ws-link" onClick={() => void pick('')}>Back to latest</button></>
      : card.rev ? <>Revision {card.rev} · updated <time title={card.lastRunAt ? exactTime(card.lastRunAt) : undefined}>{card.lastRunAt ? agoLabel(card.lastRunAt) : '—'}</time>{card.nextRunAt && card.refresh === 'daily' ? <> · next <time title={exactTime(card.nextRunAt)}>{agoLabel(card.nextRunAt)}</time></> : null} · up to {card.tokenCap} tokens</> : `Up to ${card.tokenCap} tokens`}</footer>
  </article>;
}
function CardDialog({ projectId, card, onClose, onSaved }: { projectId: string; card: SummaryCard | null; onClose: () => void; onSaved: () => void }): React.ReactElement {
  const [title, setTitle] = useState(card?.title ?? ''), [query, setQuery] = useState(card?.query ?? ''), [refresh, setRefresh] = useState<SummaryRefresh>(card?.refresh ?? 'daily'), [cap, setCap] = useState(String(card?.tokenCap ?? 600)), [enabled, setEnabled] = useState(card?.enabled ?? true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const save = async () => {
    setBusy(true); setError('');
    try { const saved = await invoke('work.summaries.save', { projectId, ...(card ? { id: card.id } : {}), title, query, refresh, tokenCap: Number(cap), enabled }); if (!card) await invoke('work.summaries.refresh', { projectId, id: saved.id }); notifySuccess(card ? 'Status card saved.' : 'Status card added. An agent is writing the first revision.'); onSaved(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); }
  };
  return <ModalSheet open title={card ? 'Edit status card' : 'New status card'} description="An agent writes the card from the tasks it watches. Leave the query empty to watch every task." className="composer-confirm work-dialog" testId="work-card-dialog" onClose={() => { if (!busy) onClose(); }}>
    <form className="work-form" onSubmit={e => { e.preventDefault(); void save(); }}>
      <label>Title<input type="text" className="ws-input" value={title} maxLength={80} onChange={e => setTitle(e.target.value)} placeholder="Release blockers" autoFocus/></label>
      <label>Watched tasks<input type="text" className="ws-input" value={query} maxLength={SUMMARY_LIMITS.maxQuery} onChange={e => setQuery(e.target.value)} placeholder="status:blocked label:release   (empty: every task)"/></label>
      <p className="ws-faint">Same search as the Tasks tab: <code>status:</code> <code>assignee:</code> <code>label:</code> <code>priority:</code> <code>is:live</code> <code>pr:failing</code>, or plain words.</p>
      <div className="work-form-row">
        <label>Refresh<select className="ws-select" value={refresh} onChange={e => setRefresh(e.target.value as SummaryRefresh)}>{(Object.keys(SUMMARY_REFRESH_LABEL) as SummaryRefresh[]).map(r => <option key={r} value={r}>{SUMMARY_REFRESH_LABEL[r]}</option>)}</select></label>
        <label>Token cap<input className="ws-input" type="number" min={SUMMARY_LIMITS.minTokenCap} max={SUMMARY_LIMITS.maxTokenCap} step={50} value={cap} onChange={e => setCap(e.target.value)}/></label>
      </div>
      <label className="pp-check"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)}/>Keep this card up to date automatically</label>
      {error && <p className="work-error" role="alert">{error}</p>}
      <div className="composer-confirm-actions"><button type="button" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="is-primary" disabled={busy || !title.trim()}>{busy ? 'Saving…' : card ? 'Save' : 'Add card'}</button></div>
    </form>
  </ModalSheet>;
}

// ── Goals (G18) ──────────────────────────────────────────────────────────────
export function GoalsSection({ projectId, snapshot }: { projectId: string; snapshot: WorkspaceSnapshot }): React.ReactElement {
  const { data, error, reload } = useWorkLoad(projectId, ['goals'], () => invoke('work.goals.list', { projectId }));
  const [editing, setEditing] = useState<{ goal: Goal | null; parentId: string | null; level: GoalLevel } | null>(null);
  const tree = useMemo(() => data ? buildGoalTree(data.goals, data.links) : [], [data]);
  const names = useMemo(() => new Map(snapshot.tasks.map(t => [t.id, t.key])), [snapshot.tasks]);
  const remove = async (goal: Goal) => { try { await invoke('work.goals.remove', { projectId, id: goal.id, ...(goal.projectId === null ? { workspace: true } : {}) }); reload(); } catch (cause) { notifyError(cause); } };
  const row = (node: GoalNode, depth: number): React.ReactNode => <li key={node.id} className="work-goal" style={{ ['--depth' as string]: depth }}>
    <div className="work-goal-main" data-status={node.status}>
      <span className="work-goal-title">{node.title}</span>
      <StateChip tone="faint">{GOAL_LEVEL_LABEL[node.level]}</StateChip>
      <StateChip tone={node.status === 'achieved' ? 'ok' : node.status === 'cancelled' ? 'faint' : node.status === 'planned' ? 'warn' : 'accent'}>{GOAL_STATUS_LABEL[node.status]}</StateChip>
      {node.targetDate && <span className="ws-chip" data-tone={isOverdue(node.status === 'achieved' ? 'completed' : node.status === 'cancelled' ? 'cancelled' : 'in_progress', node.targetDate) ? 'danger' : undefined}>{dayLabel(node.targetDate)}</span>}
      {(node.tasks.length > 0 || node.agents.length > 0) && <span className="ws-faint work-goal-links" title={node.tasks.map(t => names.get(t) ?? t).join(', ')}>{node.tasks.length ? `${node.tasks.length} ${node.tasks.length === 1 ? 'task' : 'tasks'}` : ''}{node.tasks.length && node.agents.length ? ' · ' : ''}{node.agents.length ? `${node.agents.length} ${node.agents.length === 1 ? 'agent' : 'agents'}` : ''}</span>}
      <span className="work-goal-actions">
        <Tip label="Add a sub-goal"><button type="button" className="icon-button" aria-label={`Add a sub-goal under ${node.title}`} onClick={() => setEditing({ goal: null, parentId: node.id, level: GOAL_LEVELS[Math.min(GOAL_LEVELS.indexOf(node.level) + 1, GOAL_LEVELS.length - 1)]! })}><Plus size={13}/></button></Tip>
        <Tip label="Edit"><button type="button" className="icon-button" aria-label={`Edit ${node.title}`} onClick={() => setEditing({ goal: node, parentId: node.parentId, level: node.level })}><Pencil size={13}/></button></Tip>
        <Tip label="Delete"><button type="button" className="icon-button" aria-label={`Delete ${node.title}`} onClick={() => void remove(node)}><Trash2 size={13}/></button></Tip>
      </span>
    </div>
    {node.description && <p className="work-goal-desc ws-faint">{node.description}</p>}
    {node.children.length > 0 && <ul className="work-goal-children">{node.children.map(c => row(c, depth + 1))}</ul>}
  </li>;
  return <section className="project-section work-goals" aria-label="Goals">
    <p className="project-section-note">Goals say why the work matters: a workspace mission, the project’s goals, a team’s, an agent’s, a task’s. A run is told the chain of goals its task belongs to. Link a task or an agent to a goal from its Properties.</p>
    <div className="ws-section-head"><h2>Goals</h2><button type="button" className="settings-button secondary" onClick={() => setEditing({ goal: null, parentId: null, level: 'project' })}><Plus size={13}/>New goal</button></div>
    {error && !data ? <ResourceState kind="error" compact message="Goals could not be loaded." detail={error} onRetry={reload}/>
      : !data ? <ResourceState kind="loading" compact label="Loading goals" rows={2}/>
      : tree.length === 0 ? <ResourceState kind="empty" compact message="No goals yet. Start with the project’s goal, then break it down."/>
      : <ul className="work-goal-tree" aria-label="Goals tree">{tree.map(n => row(n, 0))}</ul>}
    {editing && data && <GoalDialog projectId={projectId} goals={data.goals} snapshot={snapshot} init={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }}/>}
  </section>;
}
function GoalDialog({ projectId, goals, snapshot, init, onClose, onSaved }: { projectId: string; goals: Goal[]; snapshot: WorkspaceSnapshot; init: { goal: Goal | null; parentId: string | null; level: GoalLevel }; onClose: () => void; onSaved: () => void }): React.ReactElement {
  const g = init.goal;
  const [title, setTitle] = useState(g?.title ?? ''), [description, setDescription] = useState(g?.description ?? ''), [level, setLevel] = useState<GoalLevel>(init.level), [status, setStatus] = useState<GoalStatus>(g?.status ?? 'active');
  const [parentId, setParentId] = useState(init.parentId ?? ''), [owner, setOwner] = useState(g?.ownerMemberId ?? ''), [target, setTarget] = useState(g?.targetDate ?? ''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const options = useMemo(() => goalOptions(goals).filter(o => o.goal.id !== g?.id), [goals, g?.id]);
  const members = snapshot.agents.filter(a => a.projectId === projectId && a.memberId);
  const save = async () => {
    setBusy(true); setError('');
    try { await invoke('work.goals.save', { projectId, ...(g ? { id: g.id } : {}), level, title, description, status, parentId: parentId || null, ownerMemberId: owner || null, targetDate: target || null }); onSaved(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); }
  };
  return <ModalSheet open title={g ? 'Edit goal' : 'New goal'} className="composer-confirm work-dialog" testId="work-goal-dialog" onClose={() => { if (!busy) onClose(); }}>
    <form className="work-form" onSubmit={e => { e.preventDefault(); void save(); }}>
      <label>Title<input type="text" className="ws-input" value={title} maxLength={200} onChange={e => setTitle(e.target.value)} placeholder="Ship 0.3.0 with every parity row working" autoFocus/></label>
      <label>Description<textarea className="work-comment-text" rows={2} value={description} maxLength={4000} onChange={e => setDescription(e.target.value)}/></label>
      <div className="work-form-row">
        <label>Level<select className="ws-select" value={level} disabled={Boolean(g)} onChange={e => setLevel(e.target.value as GoalLevel)}>{GOAL_LEVELS.map(l => <option key={l} value={l}>{GOAL_LEVEL_LABEL[l]}</option>)}</select></label>
        <label>Status<select className="ws-select" value={status} onChange={e => setStatus(e.target.value as GoalStatus)}>{GOAL_STATUSES.map(s => <option key={s} value={s}>{GOAL_STATUS_LABEL[s]}</option>)}</select></label>
      </div>
      <div className="work-form-row">
        <label>Parent goal<select className="ws-select" value={parentId} onChange={e => setParentId(e.target.value)}><option value="">None (a root goal)</option>{options.map(({ goal, depth }) => <option key={goal.id} value={goal.id}>{`${'  '.repeat(depth)}${goal.title}`}</option>)}</select></label>
        <label>Owner<select className="ws-select" value={owner} onChange={e => setOwner(e.target.value)}><option value="">No owner</option>{members.map(a => <option key={a.memberId!} value={a.memberId!}>{a.name}</option>)}</select></label>
        <label>Target date<input className="ws-input" type="date" value={target} onChange={e => setTarget(e.target.value)}/></label>
      </div>
      {error && <p className="work-error" role="alert">{error}</p>}
      <div className="composer-confirm-actions"><button type="button" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="is-primary" disabled={busy || !title.trim()}>{busy ? 'Saving…' : 'Save goal'}</button></div>
    </form>
  </ModalSheet>;
}

// ── Labels (C6) ──────────────────────────────────────────────────────────────
export function LabelsSection({ projectId }: { projectId: string }): React.ReactElement {
  const { data, error, reload } = useWorkLoad(projectId, ['labels'], () => invoke('work.labels.list', { projectId }));
  const [name, setName] = useState(''), [color, setColor] = useState<LabelColor>('accent'), [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await refreshWorkspace(); reload(); } catch (cause) { notifyError(cause); } };
  return <section className="project-section" aria-label="Labels">
    <p className="project-section-note">Labels mark tasks across the project. Add them from a task’s Properties; filter by them in the Tasks tab.</p>
    <form className="work-inline-form" onSubmit={e => { e.preventDefault(); const n = name.trim(); if (n) void act(async () => { await invoke('work.labels.save', { projectId, name: n, color }); setName(''); }); }}>
      <input type="text" className="ws-input" aria-label="New label name" placeholder="New label" maxLength={40} value={name} onChange={e => setName(e.target.value)}/>
      <select className="ws-select" aria-label="New label colour" value={color} onChange={e => setColor(e.target.value as LabelColor)}>{LABEL_COLORS.map(c => <option key={c} value={c}>{c}</option>)}</select>
      <button type="submit" className="settings-button secondary" disabled={!name.trim()}><Plus size={13}/>Add label</button>
    </form>
    {error && !data ? <ResourceState kind="error" compact message="Labels could not be loaded." detail={error} onRetry={reload}/>
      : !data ? <ResourceState kind="loading" compact label="Loading labels" rows={2}/>
      : data.labels.length === 0 ? <ResourceState kind="empty" compact message="No labels yet."/>
      : <ul className="work-list" aria-label="Labels">{data.labels.map(l => <li key={l.id} className="work-label-line">
          {renaming?.id === l.id ? <input type="text" className="ws-input" aria-label={`Rename ${l.name}`} value={renaming.name} maxLength={40} autoFocus onChange={e => setRenaming({ id: l.id, name: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void act(async () => { await invoke('work.labels.save', { projectId, id: l.id, name: renaming.name, color: l.color }); setRenaming(null); }); } if (e.key === 'Escape') setRenaming(null); }}/> : <LabelChip label={l}/>}
          <span className="ws-faint">{l.tasks} {l.tasks === 1 ? 'task' : 'tasks'}</span>
          <select className="ws-select is-bare" aria-label={`Colour of ${l.name}`} value={l.color} onChange={e => void act(() => invoke('work.labels.save', { projectId, id: l.id, name: l.name, color: e.target.value as LabelColor }))}>{LABEL_COLORS.map(c => <option key={c} value={c}>{c}</option>)}</select>
          <Tip label="Rename"><button type="button" className="icon-button" aria-label={`Rename ${l.name}`} onClick={() => setRenaming({ id: l.id, name: l.name })}><Pencil size={13}/></button></Tip>
          <Tip label="Delete"><button type="button" className="icon-button" aria-label={`Delete label ${l.name}`} onClick={() => void act(() => invoke('work.labels.remove', { projectId, id: l.id }))}><Trash2 size={13}/></button></Tip>
        </li>)}</ul>}
  </section>;
}

// ── Feedback (G15) ───────────────────────────────────────────────────────────
export function FeedbackSection({ projectId, snapshot }: { projectId: string; snapshot: WorkspaceSnapshot }): React.ReactElement {
  const { data, error, reload } = useWorkLoad(projectId, ['votes'], () => invoke('work.votes.list', { projectId }));
  const keys = useMemo(() => new Map(snapshot.tasks.map(t => [t.id, t.key])), [snapshot.tasks]);
  const votes = data?.votes ?? [], good = votes.filter(v => v.vote === 'helpful').length;
  const exportJson = async (how: 'copy' | 'save') => {
    try {
      const out = await invoke('work.votes.export', { projectId });
      if (how === 'copy') { await invoke('clipboard.write', { text: out.json }); notifySuccess(`Copied ${out.count} ${out.count === 1 ? 'vote' : 'votes'} as JSON.`); }
      else { const url = URL.createObjectURL(new Blob([out.json], { type: 'application/json' })), a = document.createElement('a'); a.href = url; a.download = 'muster-feedback.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); notifySuccess(`Saved ${out.count} ${out.count === 1 ? 'vote' : 'votes'}.`); }
    } catch (cause) { notifyError(cause); }
  };
  return <section className="project-section" aria-label="Feedback">
    <p className="project-section-note">Your thumbs on agent replies and documents. They stay on this computer; nothing is sent anywhere. Export them to keep or share.</p>
    <div className="work-inline-form"><span className="ws-chip" data-tone="ok">{good} helpful</span><span className="ws-chip" data-tone="warn">{votes.length - good} needs work</span>
      <button type="button" className="settings-button secondary" disabled={!votes.length} onClick={() => void exportJson('copy')}>Copy JSON</button>
      <button type="button" className="settings-button secondary" disabled={!votes.length} onClick={() => void exportJson('save')}>Save JSON</button></div>
    {error && !data ? <ResourceState kind="error" compact message="Feedback could not be loaded." detail={error} onRetry={reload}/>
      : !data ? <ResourceState kind="loading" compact label="Loading feedback" rows={2}/>
      : votes.length === 0 ? <ResourceState kind="empty" compact message="No votes yet. Use the thumbs on an agent’s reply in a task thread."/>
      : <ul className="work-list" aria-label="Votes">{votes.map(v => <li key={v.id} className="work-vote-line">
          <StateChip tone={v.vote === 'helpful' ? 'ok' : 'warn'}>{v.vote === 'helpful' ? 'Helpful' : 'Needs work'}</StateChip>
          <span className="work-vote-text"><span className="ws-ellipsis" title={v.excerpt}>{v.excerpt || '(no excerpt)'}</span>{v.reason && <span className="ws-faint">“{v.reason}”</span>}</span>
          <span className="ws-faint">{v.subject === 'document' ? 'Document' : 'Reply'}{v.taskId && keys.get(v.taskId) ? ` · ${keys.get(v.taskId)}` : ''} · <time title={exactTime(v.createdAt)}>{agoLabel(v.createdAt)}</time></span>
        </li>)}</ul>}
  </section>;
}
