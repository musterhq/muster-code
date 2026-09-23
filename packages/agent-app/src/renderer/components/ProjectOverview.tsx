import { AlertTriangle, CheckCircle2, CircleDot, FolderPlus, Hand, ListChecks, MessageSquare, MessagesSquare, PackageCheck, Pencil, Users } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import type { Chat, Folder } from '../../shared/protocol';
import type { ProjectDetails } from '../../shared/domains/projects-protocol';
import { projectRollup } from '../project-rollup';
import { invoke } from '../bridge';
import { StatusDot } from './StatusDot';
import { ProjectCostSummary } from './UsageCost';
import { useStore } from '../useStore';
import { ProjectActivityList, relativeTime, type ProjectWork, type TaskFilter } from './ProjectTasks';
import { HandoffCard, SourcesCard } from './ProjectKnowledge';
import { plural } from '../../shared/wording.ts';
import { exactTime } from '../relativeTime.ts';

export type ProjectTab = 'overview' | 'tasks' | 'agents' | 'chats' | 'changes' | 'activity' | 'decisions' | 'memory' | 'inbox' | 'environments' | 'settings';

/** Versioned project rules, injected into every project chat's context packet. */
function InstructionsCard({ projectId, instructions, onChanged }: { projectId: string; instructions: ProjectWork['instructions']; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(instructions.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const begin = () => { setDraft(instructions.text); setError(''); setEditing(true); };
  async function save() {
    setBusy(true); setError('');
    try { await invoke('project.instructions.set', { projectId, text: draft, baseVersion: instructions.version }); setEditing(false); onChanged(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not save instructions.'); }
    finally { setBusy(false); }
  }
  return <section aria-label="Project instructions" className="project-card">
    <header><h3>Instructions{instructions.version ? ` (v${instructions.version})` : ''}</h3>{!editing && <button type="button" className="project-link" onClick={begin}>{instructions.text ? 'Edit' : 'Add'}</button>}</header>
    {editing
      ? <div className="project-inline-edit project-instructions-edit"><textarea rows={4} maxLength={32768} value={draft} disabled={busy} onChange={e => setDraft(e.target.value)} autoFocus/>
          {error && <span role="alert" className="settings-error">{error}</span>}
          <div className="project-task-form-actions"><button type="button" className="settings-button" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button><button type="button" className="settings-button secondary" disabled={busy} onClick={() => setEditing(false)}>Cancel</button></div>
        </div>
      : <p className="projects-empty">{instructions.text || 'No standing rules yet. Set project-wide rules every chat should follow.'}</p>}
    {!editing && instructions.version > 0 && <p className="projects-item-meta">New versions apply to the next dispatch; running chats get a notice to steer.</p>}
  </section>;
}

/** The coordinator: a pinned chat that plans and delegates via fenced task commands the user approves. */
function CoordinatorCard({ projectId, coordinator, archived, onOpenChat, onChanged }: { projectId: string; coordinator: ProjectWork['coordinator']; archived: boolean; onOpenChat: (id: string) => void; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const pending = coordinator.proposals.filter(p => p.state === 'pending');
  async function start() { setBusy('start'); setError(''); try { const { chatId } = await invoke('project.coordinator.start', { projectId }); onOpenChat(chatId); onChanged(); } catch (err) { setError(err instanceof Error ? err.message : 'Could not start the coordinator.'); } finally { setBusy(null); } }
  async function apply(key: string) { setBusy(key); setError(''); try { await invoke('project.coordinator.apply', { projectId, key }); onChanged(); } catch (err) { setError(err instanceof Error ? err.message : 'Could not apply that proposal.'); } finally { setBusy(null); } }
  async function dismiss(key: string) { setBusy(key); setError(''); try { await invoke('project.coordinator.dismiss', { projectId, key }); onChanged(); } catch (err) { setError(err instanceof Error ? err.message : 'Could not dismiss that proposal.'); } finally { setBusy(null); } }
  return <section aria-label="Coordinator" className="project-card">
    <header><h3>Coordinator</h3>{coordinator.chatId && <button type="button" className="project-link" onClick={() => onOpenChat(coordinator.chatId!)}>Open chat</button>}</header>
    {!coordinator.chatId
      ? <div className="project-empty-inline"><p className="projects-empty">Plans and delegates tasks via chat commands you approve.</p>{!archived && <button type="button" className="settings-button secondary" disabled={busy==='start'} onClick={() => void start()}><MessagesSquare size={13}/>{busy==='start'?'Starting…':'Start coordinator'}</button>}</div>
      : pending.length === 0 ? <p className="projects-empty">No pending task changes to approve.</p>
      : <ul className="project-coordinator-list">{pending.map(p => <li key={p.key}>
          <span>{plural(p.ops.length, 'change')} proposed {relativeTime(p.createdAt)}</span>
          <span className="project-task-row-actions"><button type="button" className="settings-button secondary" disabled={Boolean(busy)} onClick={() => void apply(p.key)}>{busy===p.key?'Applying…':'Apply'}</button><button type="button" className="settings-button secondary" disabled={Boolean(busy)} onClick={() => void dismiss(p.key)}>Dismiss</button></span>
        </li>)}</ul>}
    {error && <p role="alert" className="settings-error">{error}</p>}
  </section>;
}

/** Roll-up of what is happening in a Project: state counts, what needs you, latest activity and starter actions. */
export function ProjectOverview({ project, folders, chats, work, onTab, onTasks, onOpenChat, onOpenRef, resolveRef, onEditGoal, onStartChat, onAddTask, onChanged }: {
  project: ProjectDetails; folders: Folder[]; chats: Chat[]; work: ProjectWork;
  onTab: (tab: ProjectTab) => void; onTasks: (filter: TaskFilter) => void; onOpenChat: (id: string) => void;
  onOpenRef: (refId: string) => void; resolveRef: (refId: string) => string | null;
  onEditGoal: () => void; onStartChat: () => void; onAddTask: () => void; onChanged: () => void;
}) {
  const { snapshot } = useStore();
  const tasks = work.tasks.items;
  const r = projectRollup(tasks, chats.map(c => c.id), snapshot?.attention);
  const waitingTasks = tasks.filter(t => t.waitingChatId);
  const tiles: { id: string; label: string; value: number; icon: React.ReactNode; tone?: string; hint: string; onClick: () => void }[] = [
    { id: 'running', label: 'Running', value: r.running, icon: <CircleDot size={14}/>, tone: 'accent', hint: 'Show running tasks', onClick: () => onTasks('running') },
    { id: 'input', label: 'Needs input', value: waitingTasks.length, icon: <Hand size={14}/>, tone: 'warn', hint: waitingTasks.length ? `Open "${waitingTasks[0]!.title}"` : 'No tasks are waiting on you', onClick: () => waitingTasks[0] ? onOpenChat(waitingTasks[0].waitingChatId!) : onTasks('needs-input') },
    { id: 'blocked', label: 'Blocked', value: r.blocked, icon: <AlertTriangle size={14}/>, tone: 'danger', hint: 'Show blocked tasks', onClick: () => onTasks('blocked') },
    { id: 'implemented', label: 'To verify', value: tasks.filter(t => t.state === 'implemented' || t.state === 'review').length, icon: <PackageCheck size={14}/>, hint: 'Implemented or in-review tasks waiting for verification', onClick: () => onTasks('implemented') },
    { id: 'verified', label: 'Verified', value: r.verified, icon: <CheckCircle2 size={14}/>, tone: 'ok', hint: 'Show verified tasks', onClick: () => onTasks('verified') },
  ];
  const starters = [
    !project.goal.trim() && { key: 'goal', icon: <Pencil size={14}/>, title: 'Set a shared goal', body: 'Every chat in this project sees it.', action: onEditGoal },
    folders.length === 0 && { key: 'folder', icon: <FolderPlus size={14}/>, title: 'Link a folder', body: 'Agent runs need a folder to work in.', action: () => onTab('environments') },
    tasks.length === 0 && { key: 'task', icon: <ListChecks size={14}/>, title: 'Add the first task', body: 'Track work with acceptance criteria.', action: onAddTask },
    chats.length === 0 && !project.archived && { key: 'chat', icon: <MessageSquare size={14}/>, title: 'Start a project chat', body: folders.length ? `Opens in ${folders[0].name}.` : 'Uses a private scratch folder.', action: onStartChat },
  ].filter((s): s is { key: string; icon: React.ReactElement; title: string; body: string; action: () => void } => Boolean(s));
  const live = chats.filter(c => !c.archived), recent = [...live].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4);
  const pct = r.total ? Math.round((r.verified / r.total) * 100) : 0;

  // Hierarchy (S3-G): what to do first → tasks → chats and the coordinator → activity → knowledge → people and cost.
  return <div className="project-overview-grid">
    {starters.length > 0 && <section aria-label="Get started" className="project-starters">
      {starters.map(s => <button key={s.key} type="button" className="project-starter" onClick={s.action}>{s.icon}<span><strong>{s.title}</strong><small>{s.body}</small></span></button>)}
    </section>}
    <section aria-labelledby="project-ov-tasks" className="project-overview-block">
      <header className="project-overview-heading"><h2 id="project-ov-tasks">Tasks</h2>{r.total > 0 && <button type="button" className="project-link" onClick={() => onTasks('all')}>View all {r.total}</button>}</header>
      <div className="project-stats" role="group" aria-label="Task summary">
        {tiles.map(t => <button key={t.id} type="button" className="project-stat" data-tone={t.tone} data-empty={t.value === 0 || undefined} title={t.hint} onClick={t.onClick}>
          <span className="project-stat-label">{t.icon}{t.label}</span><span className="project-stat-value">{t.value}</span>
        </button>)}
      </div>
      {r.total > 0 && <div className="project-progress" role="progressbar" aria-label="Verified tasks" aria-valuemin={0} aria-valuemax={r.total} aria-valuenow={r.verified}>
        <div className="project-progress-bar"><span style={{ width: `${pct}%` }}/></div><span>{r.verified} of {r.total} tasks verified</span>
      </div>}
    </section>
    <section aria-labelledby="project-ov-chats" className="project-overview-block">
      <header className="project-overview-heading"><h2 id="project-ov-chats">Chats</h2>{live.length > 0 && <button type="button" className="project-link" onClick={() => onTab('chats')}>View all {live.length}</button>}</header>
      <div className="project-overview-cols">
        <section aria-label="Recent chats" className="project-card">
          <header><h3>Recent</h3></header>
          {recent.length === 0 ? <div className="project-empty-inline"><p className="projects-empty">No chats yet.</p></div>
            : <ul className="project-chat-rows">{recent.map(c => <li key={c.id}><button type="button" onClick={() => onOpenChat(c.id)}>
              <StatusDot status={c.status}/><span className="project-chat-title">{c.title || 'Untitled chat'}</span><span className="projects-item-meta" title={exactTime(c.updatedAt)}>{relativeTime(c.updatedAt)}</span>
            </button></li>)}</ul>}
        </section>
        <CoordinatorCard projectId={project.id} coordinator={work.coordinator} archived={project.archived} onOpenChat={onOpenChat} onChanged={onChanged}/>
      </div>
    </section>
    <section aria-labelledby="project-ov-activity" className="project-overview-block">
      <header className="project-overview-heading"><h2 id="project-ov-activity">Activity</h2>{work.activity.items.length > 0 && <button type="button" className="project-link" onClick={() => onTab('activity')}>View all</button>}</header>
      <section aria-label="Latest activity" className="project-card">
        {work.activity.items.length === 0 ? <p className="projects-empty">Nothing yet. Task runs, decisions and edits show up here.</p>
          : <ProjectActivityList items={work.activity.items} limit={6} resolveRef={resolveRef} onOpenRef={onOpenRef}/>}
      </section>
    </section>
    <section aria-labelledby="project-ov-knowledge" className="project-overview-block">
      <header className="project-overview-heading"><h2 id="project-ov-knowledge">Knowledge</h2><span className="project-context-label">Context: {work.context.label}</span></header>
      <div className="project-overview-cols">
        <InstructionsCard projectId={project.id} instructions={work.instructions} onChanged={onChanged}/>
        <SourcesCard projectId={project.id} onChanged={onChanged}/>
      </div>
      <HandoffCard projectId={project.id} tasks={tasks} onOpenChat={onOpenChat}/>
    </section>
    <section aria-labelledby="project-ov-people" className="project-overview-block">
      <header className="project-overview-heading"><h2 id="project-ov-people">Members and usage</h2><button type="button" className="project-link" onClick={() => onTab('settings')}>Manage</button></header>
      <div className="project-overview-cols">
        <MembersGlance projectId={project.id} onManage={() => onTab('settings')}/>
        <div className="project-card project-cost-card"><ProjectCostSummary projectId={project.id}/></div>
      </div>
    </section>
  </div>;
}

/** A one-line roster on the Overview; the full member list with access controls lives under Settings. */
export function MembersGlance({ projectId, onManage }: { projectId: string; onManage: () => void }) {
  const [names, setNames] = useState<string[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    invoke('project.members.list', { projectId }).then(r => { if (!cancelled) setNames(r.members.filter(m => !m.revokedAt).map(m => m.name)); }).catch(() => { if (!cancelled) setNames([]); });
    return () => { cancelled = true; };
  }, [projectId]);
  return <section aria-label="Members" className="project-card">
    <header><h3>Members</h3></header>
    {names === null ? <p className="projects-empty">Loading…</p>
      : names.length === 0 ? <div className="project-empty-inline"><p className="projects-empty">Only you.</p><button type="button" className="project-link" onClick={onManage}>Add people or agents</button></div>
      : <p className="project-members-glance"><Users size={13} aria-hidden="true"/>{plural(names.length, 'member')} · {names.slice(0, 4).join(', ')}{names.length > 4 ? ` and ${names.length - 4} more` : ''}</p>}
  </section>;
}
