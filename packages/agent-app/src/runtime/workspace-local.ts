/**
 * Muster's own Projects in the workspace shapes (#115). Nothing new is stored: every row is read from what already
 * exists — Project tasks and attempts (project.work), members (project.members.list), the mailbox (mailbox.list) and the
 * Project schedulers — and every write goes through the existing commands.
 */
import type { MailboxMessage } from '../shared/domains/mailbox-protocol.ts';
import type { ProjectDetails, ProjectMember, ProjectTaskView, ProjectWorkState, TaskState } from '../shared/domains/projects-protocol.ts';
import type {
  RunState, TaskCreateInput, WorkspaceAgent, WorkspaceComment, WorkspaceInboxItem, WorkspacePriority, WorkspaceProject, WorkspaceRun, WorkspaceStatus,
  WorkspaceTask, WorkspaceTaskDetail,
} from '../shared/domains/paperclip-protocol.ts';
import { OPEN_STATUSES } from '../shared/domains/paperclip-protocol.ts';
import type { Commands } from '../shared/protocol.ts';
import type { SqliteImportStore } from './paperclip-import.ts';

export type Invoke = <K extends keyof Commands>(command: K, input: Commands[K]['input']) => Promise<Commands[K]['output']>;
export interface LocalPart { tasks: WorkspaceTask[]; agents: WorkspaceAgent[]; projects: WorkspaceProject[]; runs: WorkspaceRun[]; inbox: WorkspaceInboxItem[] }

const STATE: Record<TaskState, WorkspaceStatus> = { todo: 'todo', running: 'in_progress', 'needs-input': 'in_review', blocked: 'blocked', review: 'in_review', implemented: 'in_review', verified: 'done', failed: 'blocked', cancelled: 'cancelled' };
const PRIORITY: Record<number, WorkspacePriority> = { 0: 'critical', 1: 'high', 2: 'medium', 3: 'low' };
const ATTEMPT: Record<string, RunState> = { running: 'running', completed: 'succeeded', failed: 'failed', interrupted: 'interrupted', cancelled: 'cancelled' };
/** Manual moves the local task store accepts (running and verified come only from real runs and verification). */
const SETTABLE: Partial<Record<WorkspaceStatus, TaskState>> = { backlog: 'todo', todo: 'todo', blocked: 'blocked', in_review: 'review', cancelled: 'cancelled' };

const prefixOf = (name: string) => (name.match(/\b[\p{L}\p{N}]/gu) ?? ['P']).slice(0, 3).join('').toUpperCase();
export const agentIdOf = (projectId: string) => `agent:${projectId}`;
const clean = (value: unknown, label: string, max: number, required = true): string => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (required && !text) throw new Error(`${label} is required.`);
  if (text.length > max) throw new Error(`${label} is too long (max ${max} characters).`);
  return text;
};

interface ProjectRead { project: ProjectDetails; work: ProjectWorkState; members: ProjectMember[]; prefix: string }

/** What an import from Paperclip recorded about Muster rows: task keys and parents, each project's roster, thread history. */
export type ImportMeta = Pick<SqliteImportStore, 'taskMeta' | 'roster' | 'comments' | 'history' | 'projectMeta'>;
export const memberAgentId = (memberId: string) => `member:${memberId}`;
type RosterRow = { memberId: string; name: string; title: string | null; role: string; capabilities: string | null; reportsToMemberId: string | null; runner: { runtime: string; model: string | null } };

export class LocalWorkspace {
  constructor(private readonly invoke: Invoke, private readonly repoOf: (folderId: string | null) => { repo: string | null; cwd: string | null }, private readonly meta?: () => ImportMeta | undefined) {}
  private roster(projectId: string): RosterRow[] { try { return (this.meta?.()?.roster(projectId) ?? []) as unknown as RosterRow[]; } catch { return []; } }

  private async projects(): Promise<ProjectRead[]> {
    const list = (await this.invoke('project.list', undefined)).filter(p => !p.archived);
    return Promise.all(list.map(async project => {
      const [work, members] = await Promise.all([
        this.invoke('project.work', { projectId: project.id, activityLimit: 200 }),
        this.invoke('project.members.list', { projectId: project.id }).then(r => r.members).catch(() => [] as ProjectMember[]),
      ]);
      return { project, work, members, prefix: prefixOf(project.name) };
    }));
  }
  private agentName(read: ProjectRead): string { return read.members.find(m => m.kind === 'agent' && !m.revokedAt)?.name ?? `${read.project.name} agent`; }

  private task(read: ProjectRead, task: ProjectTaskView, index: number): WorkspaceTask {
    const agent = task.owner.kind === 'agent';
    let imported: ReturnType<ImportMeta['taskMeta']>; try { imported = this.meta?.()?.taskMeta(task.id); } catch { imported = undefined; }
    // An imported task is owned by a named Roster member; keep its Paperclip key (RAG-15) and parent.
    const member = agent ? read.members.find(m => m.id === task.owner.id && m.kind === 'agent') : undefined;
    return {
      id: task.id, key: imported?.key ?? `${read.prefix}-${index + 1}`, title: task.title, status: STATE[task.state], priority: PRIORITY[task.priority] ?? 'medium', source: 'local',
      projectId: read.project.id, parentId: imported?.parentTaskId ?? null, goalId: null,
      assigneeId: member ? memberAgentId(member.id) : agent ? agentIdOf(read.project.id) : 'user:local', assigneeLabel: member ? member.name : agent ? this.agentName(read) : 'You',
      createdAt: task.createdAt, updatedAt: task.updatedAt, startedAt: task.attempts[0]?.startedAt ?? null, completedAt: task.verification?.verifiedAt ?? null,
      live: task.state === 'running' || task.attempts.some(a => a.status === 'running'), blockedByIds: task.dependencies, origin: 'You',
    };
  }

  private run(read: ProjectRead, task: ProjectTaskView, attempt: ProjectTaskView['attempts'][number]): WorkspaceRun {
    const status = ATTEMPT[attempt.status] ?? 'failed';
    const member = task.owner.kind === 'agent' ? read.members.find(m => m.id === task.owner.id && m.kind === 'agent') : undefined;
    return { id: attempt.id, agentId: member ? memberAgentId(member.id) : agentIdOf(read.project.id), taskId: task.id, status, trigger: attempt.trigger, source: 'local', createdAt: attempt.startedAt, startedAt: attempt.startedAt, finishedAt: attempt.endedAt, error: attempt.error ?? null, cancellable: status === 'running', chatId: attempt.chatId };
  }

  async snapshot(): Promise<LocalPart> {
    const [reads, mail] = await Promise.all([this.projects(), this.invoke('mailbox.list', { limit: 200 }).catch(() => null)]);
    const tasks: WorkspaceTask[] = [], runs: WorkspaceRun[] = [], agents: WorkspaceAgent[] = [], projects: WorkspaceProject[] = [];
    if (reads.length) agents.push({ id: 'user:local', name: 'You', role: 'board', title: 'Owner', model: null, adapter: null, source: 'local', status: 'active', reportsTo: null, lastActiveAt: null, error: null, pausable: false, capabilities: 'Owns Muster’s projects and answers what the agents ask.' });
    for (const read of reads) {
      const ordered = [...read.work.tasks.items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const mine = ordered.map((task, index) => this.task(read, task, index));
      tasks.push(...mine);
      for (const task of read.work.tasks.items) for (const attempt of task.attempts) runs.push(this.run(read, task, attempt));
      const running = mine.some(t => t.live), failed = read.work.tasks.items.some(t => t.state === 'failed');
      const roster = this.roster(read.project.id);
      // An imported project has a real org: each member with its title, reporting line, runner and model.
      for (const r of roster) {
        const owned = mine.filter(t => t.assigneeId === memberAgentId(r.memberId));
        agents.push({ id: memberAgentId(r.memberId), name: r.name, role: r.role, title: r.title, model: r.runner.model, adapter: r.runner.runtime, source: 'local', status: read.work.scheduler.paused ? 'paused' : owned.some(t => t.live) ? 'running' : 'idle', reportsTo: r.reportsToMemberId ? memberAgentId(r.reportsToMemberId) : 'user:local', lastActiveAt: null, error: null, pausable: true, capabilities: r.capabilities });
      }
      if (!roster.length) agents.push({ id: agentIdOf(read.project.id), name: this.agentName(read), role: 'engineer', title: read.project.name, model: null, adapter: 'muster', source: 'local', status: read.work.scheduler.paused ? 'paused' : running ? 'running' : failed ? 'error' : 'idle', reportsTo: 'user:local', lastActiveAt: read.work.tasks.items.flatMap(t => t.attempts).map(a => a.endedAt ?? a.startedAt).sort().at(-1) ?? null, error: null, pausable: true, capabilities: read.project.goal || null });
      const where = this.repoOf(read.project.primaryFolderId);
      projects.push({ id: read.project.id, name: read.project.name, status: 'in_progress', description: read.project.goal, source: 'local', repo: where.repo, cwd: where.cwd, taskCount: mine.length, openCount: mine.filter(t => OPEN_STATUSES.includes(t.status)).length, paused: read.work.scheduler.paused, memory: null });
    }
    runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const inbox = localInbox(reads, tasks, runs, mail?.messages ?? []);
    // Pending human-only decisions carried over from Paperclip: Needs you, never resolved here.
    let pending: ReturnType<ImportMeta['history']> = []; try { pending = (this.meta?.()?.history() ?? []).filter(h => h.pending); } catch { pending = []; }
    const names = new Map(reads.map(r => [r.project.id, r.project.name])), keys = new Map(tasks.map(t => [t.id, t.key]));
    for (const h of pending) inbox.push({ id: `import:${h.sourceId}`, kind: h.kind.startsWith('approval') ? 'approval' : 'question', title: `${h.taskId && keys.get(h.taskId) ? `${keys.get(h.taskId)} · ` : ''}${h.title}`.slice(0, 200), why: 'Waiting for your decision (carried over from Paperclip).', severity: 'high', at: h.at, taskId: h.taskId, agentId: null, runId: null, projectId: h.projectId, group: (h.projectId && names.get(h.projectId)) || 'Muster', source: 'local' });
    return { tasks, agents, projects, runs: runs.slice(0, 200), inbox };
  }

  private async locate(taskId: string): Promise<{ read: ProjectRead; task: ProjectTaskView; view: WorkspaceTask }> {
    for (const read of await this.projects()) {
      const ordered = [...read.work.tasks.items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const index = ordered.findIndex(t => t.id === taskId);
      if (index >= 0) return { read, task: ordered[index], view: this.task(read, ordered[index], index) };
    }
    throw new Error('That task no longer exists.');
  }

  async detail(taskId: string): Promise<WorkspaceTaskDetail> {
    const { read, task, view } = await this.locate(taskId);
    const mail = await this.invoke('mailbox.list', { projectId: read.project.id, limit: 200 }).catch(() => null);
    const chats = new Set(task.attempts.map(a => a.chatId));
    let imported: ReturnType<ImportMeta['comments']> = []; try { imported = this.meta?.()?.comments(task.id) ?? []; } catch { imported = []; }
    const comments: WorkspaceComment[] = [
      ...imported.map(c => ({ id: `pc:${c.sourceId}`, author: { kind: c.authorKind === 'agent' ? 'agent' as const : 'user' as const, id: null, label: c.authorLabel }, body: c.body, createdAt: c.createdAt, runId: c.runId })),
      ...read.work.activity.items.filter(a => a.refId === task.id && a.kind !== 'task.create').map(a => ({ id: a.id, author: { kind: 'system' as const, id: null, label: a.actor || 'Muster' }, body: a.summary, createdAt: a.createdAt })),
      ...(mail?.messages ?? []).filter(m => (m.recipient.kind === 'taskRun' && m.recipient.id === task.id) || chats.has(m.sender.chatId ?? m.sender.id) || chats.has(m.recipient.chatId ?? m.recipient.id)).map(m => mailComment(m)),
    ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const agent = task.owner.kind === 'agent';
    return {
      task: view, description: task.acceptance, comments, runs: task.attempts.map(a => this.run(read, task, a)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      addressee: agent ? { id: view.assigneeId ?? agentIdOf(read.project.id), label: view.assigneeLabel ?? 'Agent' } : null,
      composerNote: agent ? 'Delivered into the task run’s next turn through the project mailbox.' : 'This task is yours. Assign it to the project agent to message its runs.',
      subtasks: [], blocking: read.work.tasks.items.filter(t => t.dependencies.includes(task.id)).map(t => t.id), receipts: [], cards: [],
      mentionable: read.members.filter(m => !m.revokedAt).map(m => ({ id: m.id, name: m.name })),
    };
  }

  /** The user's message rides into the task run's next turn through the mailbox (address kind `taskRun`). */
  async comment(taskId: string, body: string): Promise<WorkspaceComment> {
    const { read, task } = await this.locate(taskId);
    return mailComment(await this.invoke('mailbox.send', { to: { kind: 'taskRun', id: task.id, projectId: read.project.id }, body }));
  }

  async setStatus(taskId: string, status: WorkspaceStatus): Promise<WorkspaceTask> {
    const target = SETTABLE[status];
    if (!target) throw new Error(status === 'done' ? 'Muster tasks are marked done by verifying them in the project’s Tasks tab.' : 'In Progress comes from a real run. Start the task from the project’s Tasks tab.');
    const { read, task } = await this.locate(taskId);
    await this.invoke('project.tasks.setState', { projectId: read.project.id, id: task.id, revision: task.revision, state: target });
    return (await this.locate(taskId)).view;
  }

  async createTask(input: TaskCreateInput): Promise<WorkspaceTask> {
    const title = clean(input.title, 'Title', 500), description = clean(input.description, 'Description', 4000, false);
    const projects = (await this.invoke('project.list', undefined)).filter(p => !p.archived);
    const projectId = input.projectId && projects.some(p => p.id === input.projectId) ? input.projectId : projects[0]?.id;
    if (!projectId) throw new Error('Create a project first: Muster tasks belong to a project.');
    const owner = input.assigneeId === 'user:local' ? { kind: 'user' as const, id: 'user' } : { kind: 'agent' as const, id: 'agent' };
    const created = await this.invoke('project.tasks.add', { projectId, title, acceptance: description, dependencies: [], owner });
    return (await this.locate(created.id)).view;
  }

  /** Muster agents are Project schedulers: pausing one holds its Project's task dispatch. */
  async setPaused(agentId: string | null, paused: boolean): Promise<number> {
    // A Roster member pauses its project's scheduler (per-member pause is a follow-up).
    const memberProject = agentId?.startsWith('member:') ? (await this.projects()).find(r => r.members.some(m => memberAgentId(m.id) === agentId))?.project.id : undefined;
    const list = (await this.invoke('project.list', undefined)).filter(p => !p.archived && (!agentId || agentIdOf(p.id) === agentId || p.id === memberProject));
    for (const project of list) await this.invoke('project.scheduler.set', { projectId: project.id, paused });
    return list.length;
  }

  async cancelRun(runId: string): Promise<void> {
    for (const read of await this.projects()) for (const task of read.work.tasks.items) {
      const attempt = task.attempts.find(a => a.id === runId);
      if (attempt) { if (attempt.status !== 'running') throw new Error('That run already ended.'); await this.invoke('chat.stop', { id: attempt.chatId }); return; }
    }
    throw new Error('That run no longer exists.');
  }

  async projectFor(taskId: string): Promise<{ project: ProjectDetails; view: WorkspaceTask }> { const { read, view } = await this.locate(taskId); return { project: read.project, view }; }
}

function mailComment(m: MailboxMessage): WorkspaceComment {
  const kind = m.sender.kind === 'user' ? 'user' : 'agent';
  return { id: m.id, author: { kind, id: m.sender.id, label: kind === 'user' ? 'You' : m.sender.label ?? 'Agent' }, body: m.subject ? `**${m.subject}**\n\n${m.body}` : m.body, createdAt: m.createdAt };
}

/** Everything in Muster's Projects that needs you: tasks waiting for input or review, blocked or failed work, and unacknowledged mail. */
export function localInbox(reads: readonly { project: ProjectDetails; work: ProjectWorkState }[], tasks: readonly WorkspaceTask[], runs: readonly WorkspaceRun[], mail: readonly MailboxMessage[]): WorkspaceInboxItem[] {
  const items: WorkspaceInboxItem[] = [];
  const byId = new Map(tasks.map(t => [t.id, t]));
  for (const read of reads) for (const task of read.work.tasks.items) {
    const view = byId.get(task.id);
    if (!view) continue;
    const kind = task.state === 'needs-input' ? 'question' : task.state === 'review' || task.state === 'implemented' ? 'review' : task.state === 'blocked' ? 'blocked' : task.state === 'failed' ? 'failed_run' : null;
    if (!kind) continue;
    const why = kind === 'question' ? 'The agent is waiting for your answer.' : kind === 'review' ? 'Ready for your review and verification.' : kind === 'failed_run' ? task.runError || task.attempts[0]?.error || 'The last run failed.' : 'Blocked until a dependency or you unblock it.';
    items.push({ id: `task:${task.id}`, kind, title: `${view.key} · ${task.title}`, why, severity: kind === 'question' || task.priority <= 1 ? 'high' : 'medium', at: task.updatedAt, taskId: task.id, agentId: view.assigneeId, runId: runs.find(r => r.taskId === task.id)?.id ?? null, projectId: read.project.id, group: read.project.name, source: 'local', chatIds: [...new Set(task.attempts.map(a => a.chatId).filter(Boolean))] });
  }
  items.push(...mailInbox(mail, new Map(reads.map(r => [r.project.id, r.project.name]))));
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return items.sort((a, b) => rank[a.severity] - rank[b.severity] || b.at.localeCompare(a.at));
}

/** Unacknowledged mail to you, from any project or chat: the Inbox's mailbox rows. */
export function mailInbox(mail: readonly MailboxMessage[], projectNames: ReadonlyMap<string, string>): WorkspaceInboxItem[] {
  const items: WorkspaceInboxItem[] = [];
  for (const m of mail) {
    if (m.recipient.kind !== 'user' || m.state === 'acked' || m.state === 'expired') continue;
    items.push({ id: `mail:${m.id}`, kind: m.kind === 'request' ? 'question' : 'mail', title: `${m.sender.label ?? 'An agent'}: ${m.subject ?? m.body.split('\n')[0]}`.slice(0, 200), why: m.kind === 'request' ? 'Asked you a question.' : 'Sent you a message.', severity: m.kind === 'request' ? 'high' : 'low', at: m.createdAt, taskId: m.sender.kind === 'taskRun' ? m.sender.id : null, agentId: null, runId: null, projectId: m.projectId, group: m.projectId ? projectNames.get(m.projectId) ?? 'Muster' : 'Chats', source: 'local' });
  }
  return items;
}
