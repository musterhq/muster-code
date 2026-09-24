/** PRJ-X3: the Project sections beyond tasks and decisions: Agents (task runs), Changes (git across the project's folders),
 *  Memory (the Project's own bank) and Environments (where each project chat's agent runs). */
import { Brain, Container, GitBranch, Laptop, MessageSquare } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import type { Chat, ChatStatus, Folder, GitLocalStatus, MemoryEntry } from '../../shared/protocol';
import type { AttemptStatus, ProjectWorkState, TaskAttempt } from '../../shared/domains/projects-protocol';
import type { ChatEnvironmentStatus } from '../../shared/domains/sandbox-protocol';
import { invoke } from '../bridge';
import { agoLabel, exactTime } from '../relativeTime.ts';
import { plural } from '../../shared/wording.ts';
import { ResourceState } from './ResourceState';
import { StatusDot } from './StatusDot';
import { agentRuns, shortPath } from '../projectSurface';

const message = (err: unknown, fallback: string) => err instanceof Error ? err.message : fallback;
const ATTEMPT_STATUS: Record<AttemptStatus, ChatStatus> = { running: 'running', completed: 'completed', failed: 'failed', interrupted: 'interrupted', cancelled: 'interrupted' };
const TRIGGER: Record<TaskAttempt['trigger'], string> = { user: 'Started by you', scheduler: 'Scheduler', coordinator: 'Coordinator' };

function duration(from: string, to: string | null): string {
  const ms = (to ? Date.parse(to) : Date.now()) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.round(ms / 60_000);
  return m < 1 ? 'under a minute' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function ProjectAgentsSection({ work, chats, onOpenChat, onShowTasks }: { work: Pick<ProjectWorkState, 'tasks'>; chats: readonly Chat[]; onOpenChat: (id: string) => void; onShowTasks: () => void }) {
  const runs = agentRuns(work.tasks.items);
  const runChatIds = new Set(runs.map(r => r.attempt.chatId));
  const liveChats = chats.filter(c => !c.archived && !runChatIds.has(c.id) && (c.status === 'running' || c.status === 'stopping' || c.status === 'waiting'));
  const running = runs.filter(r => r.attempt.status === 'running').length + liveChats.length;
  if (runs.length === 0 && liveChats.length === 0) return <section aria-label="Agents" className="project-section">
    <ResourceState kind="empty" title="No agent runs yet" message="Task runs started by you, the scheduler or the coordinator show up here with their status and chat."><button type="button" className="settings-button secondary" onClick={onShowTasks}>Go to tasks</button></ResourceState>
  </section>;
  return <section aria-label="Agents" className="project-section">
    <p className="project-section-note">{running ? `${running} working now · ` : ''}{plural(runs.length, 'task run')}{work.tasks.truncated ? ' in the loaded tasks' : ''}</p>
    <ul className="project-run-list">
      {liveChats.map(c => <li key={c.id}><button type="button" onClick={() => onOpenChat(c.id)}>
        <StatusDot status={c.status}/><span className="project-run-text"><span className="project-run-title">{c.title || 'Untitled chat'}</span><span className="project-run-meta">Project chat</span></span>
        <span className="project-run-age" title={exactTime(c.updatedAt)}>{agoLabel(c.updatedAt)}</span>
      </button></li>)}
      {runs.map(({ task, attempt }) => <li key={attempt.id}><button type="button" onClick={() => onOpenChat(attempt.chatId)} title={attempt.error || undefined}>
        <StatusDot status={task.state === 'needs-input' && attempt.status === 'running' ? 'waiting' : ATTEMPT_STATUS[attempt.status]}/>
        <span className="project-run-text"><span className="project-run-title">{task.title}</span>
          <span className="project-run-meta">{TRIGGER[attempt.trigger]}{attempt.status === 'running' ? ` · running ${duration(attempt.startedAt, null)}` : attempt.endedAt ? ` · took ${duration(attempt.startedAt, attempt.endedAt)}` : ''}{attempt.error ? ` · ${attempt.error}` : ''}</span></span>
        <span className="project-run-age" title={exactTime(attempt.startedAt)}>{agoLabel(attempt.startedAt)}</span>
      </button></li>)}
    </ul>
  </section>;
}

type FolderStatus = { folder: Folder; status?: GitLocalStatus; error?: string };
export function ProjectChangesSection({ folders, onReview }: { folders: readonly Folder[]; onReview: (folder: Folder) => void }) {
  const [rows, setRows] = useState<FolderStatus[] | null>(null);
  const [tick, setTick] = useState(0);
  const key = folders.map(f => f.id).join(',');
  useEffect(() => {
    let cancelled = false;
    setRows(null);
    void Promise.all(folders.map(folder => folder.missing ? Promise.resolve<FolderStatus>({ folder, error: 'Folder not found on this Mac.' })
      : invoke('git.status', { folderId: folder.id }).then(status => ({ folder, status }), err => ({ folder, error: message(err, 'Not a git repository.') }))))
      .then(next => { if (!cancelled) setRows(next); });
    return () => { cancelled = true; };
  }, [key, tick]);
  if (folders.length === 0) return <section aria-label="Changes" className="project-section"><ResourceState kind="empty" message="Link a folder to see its uncommitted changes here."/></section>;
  if (!rows) return <section aria-label="Changes" className="project-section"><ResourceState kind="loading" label="Reading git status" rows={3}/></section>;
  const total = rows.reduce((n, r) => n + (r.status?.files.length ?? 0), 0);
  return <section aria-label="Changes" className="project-section">
    <div className="project-section-toolbar"><p className="project-section-note">{total ? `${plural(total, 'changed file')} across ${plural(rows.filter(r => r.status?.files.length).length, 'folder')}` : 'Every folder is clean.'}</p>
      <button type="button" className="project-link" onClick={() => setTick(n => n + 1)}>Refresh</button></div>
    <ul className="project-change-list">{rows.map(({ folder, status, error }) => <li key={folder.id}>
      <header><span className="project-change-folder">{folder.name}</span>
        {status && <span className="project-change-branch"><GitBranch size={12} aria-hidden="true"/>{status.detached ? 'detached' : status.branch || 'no branch'}{status.ahead ? ` ↑${status.ahead}` : ''}{status.behind ? ` ↓${status.behind}` : ''}</span>}
        <span className="project-change-spacer"/>
        {status && status.files.length > 0 && <button type="button" className="settings-button secondary" onClick={() => onReview(folder)}>Review</button>}
      </header>
      {error ? <p className="project-change-note">{error}</p>
        : status!.files.length === 0 ? <p className="project-change-note">No uncommitted changes.</p>
        : <ul className="project-change-files">{status!.files.slice(0, 6).map(f => <li key={f.path}><code className="project-change-code">{f.untracked ? '?' : f.conflict ? '!' : (f.staged ? f.index : f.worktree).trim() || 'M'}</code><span>{f.path}</span></li>)}
            {status!.files.length > 6 && <li className="project-change-more">+{status!.files.length - 6} more{status!.truncated ? ' (list capped)' : ''}</li>}</ul>}
    </li>)}</ul>
  </section>;
}

export function ProjectMemorySection({ projectId, onOpenMemory }: { projectId: string; onOpenMemory: () => void }) {
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setEntries(null); setError('');
    invoke('memory.list', { folderId: `project:${projectId}` }).then(list => { if (!cancelled) setEntries(list); }).catch(err => { if (!cancelled) setError(message(err, 'Could not read project memory.')); });
    return () => { cancelled = true; };
  }, [projectId, tick]);
  if (error) return <section aria-label="Memory" className="project-section"><ResourceState kind="error" message="Project memory could not be loaded." detail={error} onRetry={() => setTick(n => n + 1)}/></section>;
  if (!entries) return <section aria-label="Memory" className="project-section"><ResourceState kind="loading" label="Loading project memory" rows={3}/></section>;
  const sorted = [...entries].sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  return <section aria-label="Memory" className="project-section">
    <div className="project-section-toolbar"><p className="project-section-note">This project’s own memory. Every project chat can recall it; it stays separate from folder and personal memory.</p>
      <button type="button" className="settings-button secondary" onClick={onOpenMemory}><Brain size={13} aria-hidden="true"/>Open in Memory</button></div>
    {sorted.length === 0 ? <ResourceState kind="empty" message="No project memories yet. When a project chat saves something worth keeping, it lands here."/>
      : <ul className="project-memory-list">{sorted.slice(0, 50).map(m => <li key={m.id}>
          <span className="project-memory-summary">{m.summary}</span>
          <span className="project-memory-meta" title={exactTime(m.observedAt)}>{m.kind} · {agoLabel(m.observedAt)}</span>
        </li>)}</ul>}
    {sorted.length > 50 && <ResourceState kind="partial" compact message={`Showing the newest 50 of ${sorted.length}. Open Memory to search them all.`}/>}
  </section>;
}

type EnvRow = { chat: Chat; env?: ChatEnvironmentStatus; error?: string };
/** Where each recent project chat's agent runs: on this Mac, or in its sandbox copy. The folder list renders above it. */
export function ProjectEnvironmentsSection({ chats, folders, onOpenChat, children }: { chats: readonly Chat[]; folders: readonly Folder[]; onOpenChat: (id: string) => void; children?: React.ReactNode }) {
  const recent = [...chats].filter(c => !c.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 12);
  const key = recent.map(c => c.id).join(',');
  const [rows, setRows] = useState<EnvRow[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void Promise.all(recent.map(chat => invoke('sandbox.chatEnvironment.get', { chatId: chat.id }).then(env => ({ chat, env }), err => ({ chat, error: message(err, 'Unavailable') }))))
      .then(next => { if (!cancelled) setRows(next); });
    return () => { cancelled = true; };
  }, [key]);
  const folderName = (id?: string) => folders.find(f => f.id === id)?.name ?? 'Scratch';
  return <section aria-label="Environments" className="project-section">
    <h3 className="project-subhead">Folders</h3>
    {children}
    <h3 className="project-subhead">Where agents run</h3>
    {recent.length === 0 ? <ResourceState kind="empty" compact message="No project chats yet. Each chat runs on this Mac unless you move it into a sandbox."/>
      : !rows ? <ResourceState kind="loading" compact label="Reading chat environments" rows={2}/>
      : <ul className="project-run-list">{rows.map(({ chat, env, error }) => <li key={chat.id}><button type="button" onClick={() => onOpenChat(chat.id)}>
          {env?.env === 'sandbox' ? <Container size={14} aria-hidden="true" className="project-env-icon"/> : env ? <Laptop size={14} aria-hidden="true" className="project-env-icon"/> : <MessageSquare size={14} aria-hidden="true" className="project-env-icon"/>}
          <span className="project-run-text"><span className="project-run-title">{chat.title || 'Untitled chat'}</span>
            <span className="project-run-meta">{folderName(chat.folderId)} · {error ? error : env?.env === 'sandbox' ? `Sandbox${env.ready ? '' : ` · ${env.reason || 'not running'}`}${env.workspacePath ? ` · ${shortPath(env.workspacePath)}` : ''}` : 'This Mac'}</span></span>
          <span className="project-run-age" title={exactTime(chat.updatedAt)}>{agoLabel(chat.updatedAt)}</span>
        </button></li>)}</ul>}
  </section>;
}
