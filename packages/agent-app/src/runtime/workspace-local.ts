/**
 * Muster's own Projects in the workspace shapes (#115). Nothing new is stored: every row is read from what already
 * exists — Project tasks and attempts (project.work), members (project.members.list), the mailbox (mailbox.list) and the
 * Project schedulers — and every write goes through the existing commands.
 */
import type { MailboxMessage } from '../shared/domains/mailbox-protocol.ts';
import type { GovInboxItem } from '../shared/domains/project-governance-protocol.ts';
import type { ProjectDetails, ProjectMember, ProjectTaskView, ProjectWorkState, TaskPriority, TaskState, TeamSettings } from '../shared/domains/projects-protocol.ts';
import { DEFAULT_AGENT_ID, DEFAULT_TEAM_SETTINGS, keyPrefixOf, LOCAL_OWNER_ID } from '../shared/domains/project-team-protocol.ts';
import type {
  RunState, TaskCreateInput, WorkspaceAgent, WorkspaceComment, WorkspaceInboxItem, WorkspacePriority, WorkspaceProject, WorkspaceRun, WorkspaceStatus,
  WorkspaceTask, WorkspaceTaskDetail,
} from '../shared/domains/paperclip-protocol.ts';
import { OPEN_STATUSES } from '../shared/domains/paperclip-protocol.ts';
import type { Commands } from '../shared/protocol.ts';
import type { SqliteImportStore } from './paperclip-import.ts';

export const DEFAULT_AGENT_NAME = 'Default agent';
export type Invoke = <K extends keyof Commands>(command: K, input: Commands[K]['input']) => Promise<Commands[K]['output']>;
export interface LocalPart { tasks: WorkspaceTask[]; agents: WorkspaceAgent[]; projects: WorkspaceProject[]; runs: WorkspaceRun[]; inbox: WorkspaceInboxItem[] }

export const STATE: Record<TaskState, WorkspaceStatus> = { backlog: 'backlog', todo: 'todo', running: 'in_progress', 'needs-input': 'in_review', blocked: 'blocked', review: 'in_review', implemented: 'in_review', verified: 'done', failed: 'blocked', cancelled: 'cancelled' };
export const PRIORITY: Record<number, WorkspacePriority> = { 0: 'critical', 1: 'high', 2: 'medium', 3: 'low' };
const PRIORITY_IN: Record<WorkspacePriority, TaskPriority> = { critical: 0, high: 1, medium: 2, low: 3 };
const ATTEMPT: Record<string, RunState> = { running: 'running', completed: 'succeeded', failed: 'failed', interrupted: 'interrupted', cancelled: 'cancelled' };
/** Manual moves the local task store accepts (running and verified come only from real runs and verification). */
const SETTABLE: Partial<Record<WorkspaceStatus, TaskState>> = { backlog: 'backlog', todo: 'todo', blocked: 'blocked', in_review: 'review', cancelled: 'cancelled' };

export const agentIdOf = (projectId: string) => `agent:${projectId}`;
const clean = (value: unknown, label: string, max: number, required = true): string => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (required && !text) throw new Error(`${label} is required.`);
  if (text.length > max) throw new Error(`${label} is too long (max ${max} characters).`);
  return text;
};

interface GovRead { items: GovInboxItem[]; hidden: ReadonlySet<string>; held: ReadonlySet<string> }
interface ProjectRead { project: ProjectDetails; work: ProjectWorkState; members: ProjectMember[]; prefix: string; settings: TeamSettings; gov: GovRead }

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
      const [work, team, gov] = await Promise.all([
        this.invoke('project.work', { projectId: project.id, activityLimit: 200 }),
        this.invoke('project.members.list', { projectId: project.id }).catch(() => ({ members: [] as ProjectMember[], settings: undefined })),
        this.invoke('project.gov.summary', { projectId: project.id }).catch(() => ({ items: [] as GovInboxItem[], hidden: [] as string[], held: [] as string[] })),
      ]);
      const settings = team.settings ?? DEFAULT_TEAM_SETTINGS;
      return { project, work, members: team.members, settings, prefix: settings.keyPrefix ?? keyPrefixOf(project.name), gov: { items: gov.items, hidden: new Set(gov.hidden), held: new Set(gov.held) } };
    }));
  }
  /** Real Roster members: agent members that are not the project's default runner and were not removed. */
  private rosterMembers(read: ProjectRead): ProjectMember[] { return read.members.filter(m => m.kind === 'agent' && m.id !== DEFAULT_AGENT_ID && !m.revokedAt); }

  private task(read: ProjectRead, task: ProjectTaskView, index: number): WorkspaceTask {
    const agent = task.owner.kind === 'agent';
    let imported: ReturnType<ImportMeta['taskMeta']>; try { imported = this.meta?.()?.taskMeta(task.id); } catch { imported = undefined; }
    // An imported task keeps its Paperclip key (RAG-15) and parent; a Muster task gets the project's prefix and its stable number (OSS-3).
    const member = agent ? this.rosterMembers(read).find(m => m.id === task.owner.id) : undefined;
    return {
      id: task.id, key: imported?.key ?? `${read.prefix}-${task.seq ?? index + 1}`, title: task.title, status: STATE[task.state], priority: PRIORITY[task.priority] ?? 'medium', source: 'local',
      projectId: read.project.id, parentId: task.parentId ?? imported?.parentTaskId ?? null, goalId: null,
      assigneeId: member ? memberAgentId(member.id) : agent ? agentIdOf(read.project.id) : 'user:local', assigneeLabel: member ? member.name : agent ? DEFAULT_AGENT_NAME : 'You',
      createdAt: task.createdAt, updatedAt: task.updatedAt, startedAt: task.attempts[0]?.startedAt ?? null, completedAt: task.verification?.verifiedAt ?? null,
      live: task.state === 'running' || task.attempts.some(a => a.status === 'running'), blockedByIds: task.dependencies, origin: 'You',
      ...(read.gov.hidden.has(task.id) ? { hidden: true } : {}), ...(read.gov.held.has(task.id) ? { held: true } : {}),
    };
  }

  private run(read: ProjectRead, task: ProjectTaskView, attempt: ProjectTaskView['attempts'][number]): WorkspaceRun {
    const status = ATTEMPT[attempt.status] ?? 'failed';
    const member = task.owner.kind === 'agent' ? this.rosterMembers(read).find(m => m.id === task.owner.id) : undefined;
    return { id: attempt.id, agentId: member ? memberAgentId(member.id) : agentIdOf(read.project.id), taskId: task.id, status, trigger: attempt.trigger, source: 'local', createdAt: attempt.startedAt, startedAt: attempt.startedAt, finishedAt: attempt.endedAt, error: attempt.error ?? null, cancellable: status === 'running', chatId: attempt.chatId };
  }

  /** The project's Roster as workspace agents: every real agent member with its title, reporting line (to another member,
   *  else to You), runner, model and instructions. The project's default runner shows only while it owns tasks. */
  private rosterAgents(read: ProjectRead, mine: readonly WorkspaceTask[]): WorkspaceAgent[] {
    const imported = new Map(this.roster(read.project.id).map(r => [r.memberId, r]));
    const members = this.rosterMembers(read), ids = new Set(members.map(m => m.id)), paused = read.work.scheduler.paused;
    const lastActive = (agentId: string) => read.work.tasks.items.filter(t => mine.find(x => x.id === t.id)?.assigneeId === agentId).flatMap(t => t.attempts).map(a => a.endedAt ?? a.startedAt).sort().at(-1) ?? null;
    const out: WorkspaceAgent[] = members.map(m => {
      const r = imported.get(m.id), id = memberAgentId(m.id), owned = mine.filter(t => t.assigneeId === id);
      const boss = m.reportsTo ?? r?.reportsToMemberId ?? null;
      const failed = owned.some(t => t.status === 'blocked' && read.work.tasks.items.find(x => x.id === t.id)?.state === 'failed');
      return {
        id, name: m.name, role: r?.role ?? 'agent', title: m.title ?? r?.title ?? null, model: m.runner?.model ?? r?.runner.model ?? null, adapter: r?.runner.runtime ?? m.runner?.providerId ?? 'muster', source: 'local',
        status: m.pendingAt ? 'pending' : paused || m.pausedAt ? 'paused' : owned.some(t => t.live) ? 'running' : failed ? 'error' : 'idle',
        reportsTo: boss && ids.has(boss) ? memberAgentId(boss) : 'user:local', lastActiveAt: lastActive(id), error: null, pausable: !m.pendingAt, capabilities: m.instructions?.trim() ? m.instructions.trim().split('\n')[0].slice(0, 280) : r?.capabilities ?? null,
        projectId: read.project.id, memberId: m.id, runner: m.runner ?? null, instructions: m.instructions ?? '',
      };
    });
    const fallback = mine.filter(t => t.assigneeId === agentIdOf(read.project.id));
    if (fallback.length) out.push({ id: agentIdOf(read.project.id), name: DEFAULT_AGENT_NAME, role: 'agent', title: 'Runs tasks with no named owner', model: null, adapter: 'muster', source: 'local', status: paused ? 'paused' : fallback.some(t => t.live) ? 'running' : 'idle', reportsTo: 'user:local', lastActiveAt: lastActive(agentIdOf(read.project.id)), error: null, pausable: true, capabilities: read.project.goal || null, projectId: read.project.id, memberId: DEFAULT_AGENT_ID });
    return out;
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
      agents.push(...this.rosterAgents(read, mine));
      const where = this.repoOf(read.project.primaryFolderId);
      projects.push({ id: read.project.id, name: read.project.name, status: 'in_progress', description: read.project.goal, source: 'local', repo: where.repo, cwd: where.cwd, taskCount: mine.length, openCount: mine.filter(t => OPEN_STATUSES.includes(t.status)).length, paused: read.work.scheduler.paused, memory: null });
    }
    runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const inbox = localInbox(reads, tasks, runs, mail?.messages ?? []);
    // Governance: stages waiting on you, stopped subtrees, breakers, secret requests. A stage row replaces the plain review row of its task.
    for (const read of reads) {
      const staged = new Set(read.gov.items.filter(i => i.id.startsWith('stage:') && i.taskId).map(i => i.taskId!));
      for (let i = inbox.length - 1; i >= 0; i--) if (inbox[i]!.projectId === read.project.id && inbox[i]!.taskId && staged.has(inbox[i]!.taskId!) && inbox[i]!.id.startsWith('task:')) inbox.splice(i, 1);
      for (const g of read.gov.items) inbox.push({ id: `gov:${g.id}`, kind: g.kind, title: g.title, why: g.why, severity: g.severity, at: g.at, taskId: g.taskId, agentId: g.agentId, runId: null, projectId: read.project.id, group: read.project.name, source: 'local' });
    }
    inbox.sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.severity] - { high: 0, medium: 1, low: 2 }[b.severity]) || b.at.localeCompare(a.at));
    // Pending human-only decisions carried over from Paperclip: Needs you, never resolved here.
    let pending: ReturnType<ImportMeta['history']> = []; try { pending = (this.meta?.()?.history() ?? []).filter(h => h.pending); } catch { pending = []; }
    const names = new Map(reads.map(r => [r.project.id, r.project.name])), keys = new Map(tasks.map(t => [t.id, t.key]));
    for (const read of reads) for (const m of read.members) if (m.kind === 'agent' && m.pendingAt && !m.revokedAt)
      inbox.push({ id: `hire:${read.project.id}:${m.id}`, kind: 'approval', title: `Add ${m.name}${m.title ? ` as ${m.title}` : ''} to ${read.project.name}?`, why: 'A new agent is waiting for your approval before it can run.', severity: 'high', at: m.createdAt, taskId: null, agentId: memberAgentId(m.id), runId: null, projectId: read.project.id, group: read.project.name, source: 'local' });
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

  /** A task's subtasks: its own children, and for an imported parent the ones the import map records under it. */
  private children(read: ProjectRead, taskId: string): ProjectTaskView[] {
    return read.work.tasks.items.filter(t => {
      if (t.parentId === taskId) return true;
      if (t.parentId) return false;
      try { return this.meta?.()?.taskMeta(t.id)?.parentTaskId === taskId; } catch { return false; }
    });
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
    // A Delegated card per subtask: who handed which piece of this work to whom.
    const ordered = [...read.work.tasks.items].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), kids = this.children(read, task.id);
    const delegated = kids.map(k => { const v = this.task(read, k, ordered.indexOf(k)); return { kind: 'delegated' as const, id: `delegated:${v.id}`, at: v.createdAt, from: view.assigneeLabel ?? view.origin, to: v.assigneeLabel, taskId: v.id, key: v.key, title: v.title, brief: `${v.key} · ${v.title}` }; });
    return {
      task: view, description: task.acceptance, comments, runs: task.attempts.map(a => this.run(read, task, a)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      addressee: agent ? { id: view.assigneeId ?? agentIdOf(read.project.id), label: view.assigneeLabel ?? 'Agent' } : null,
      composerNote: agent ? 'Delivered into the task run’s next turn through the project mailbox.' : 'This task is yours. Assign it to a Roster agent to message its runs.',
      subtasks: kids.map(t => t.id), blocking: read.work.tasks.items.filter(t => t.dependencies.includes(task.id)).map(t => t.id), receipts: [], cards: delegated,
      mentionable: read.members.filter(m => !m.revokedAt).map(m => ({ id: m.id, name: m.name })),
    };
  }

  /** The user's message rides into the task run's next turn through the mailbox (address kind `taskRun`). */
  async comment(taskId: string, body: string): Promise<WorkspaceComment> {
    const { read, task } = await this.locate(taskId);
    return mailComment(await this.invoke('mailbox.send', { to: { kind: 'taskRun', id: task.id, projectId: read.project.id }, body }));
  }

  async setStatus(taskId: string, status: WorkspaceStatus): Promise<WorkspaceTask> {
    if (status === 'done') return this.markDone(taskId);
    const target = SETTABLE[status];
    if (!target) throw new Error('In Progress comes from a real run. Assign the task to an agent and start it.');
    const { read, task } = await this.locate(taskId);
    await this.invoke('project.tasks.setState', { projectId: read.project.id, id: task.id, revision: task.revision, state: target });
    return (await this.locate(taskId)).view;
  }

  /** Done is a verified task: moving one that is In Review to Done records your manual check (the verify flow).
   *  Work that has not been reviewed yet says why it cannot be done. */
  private async markDone(taskId: string): Promise<WorkspaceTask> {
    const { read, task } = await this.locate(taskId);
    if (task.state === 'verified') return (await this.locate(taskId)).view;
    if (task.state !== 'review' && task.state !== 'implemented') throw new Error('Move it to In Review first: a Muster task is done once its finished work is verified.');
    await this.invoke('project.tasks.verify', { projectId: read.project.id, id: task.id, revision: task.revision, kind: 'manual', notes: 'Checked and moved to Done by you.' });
    return (await this.locate(taskId)).view;
  }

  async createTask(input: TaskCreateInput): Promise<WorkspaceTask> {
    const title = clean(input.title, 'Title', 500), description = clean(input.description, 'Description', 4000, false);
    const projects = (await this.invoke('project.list', undefined)).filter(p => !p.archived);
    const projectId = input.projectId && projects.some(p => p.id === input.projectId) ? input.projectId : projects[0]?.id;
    if (!projectId) throw new Error('Create a project first: Muster tasks belong to a project.');
    // The owner: You, a Roster member (member:<id>), or the project's default runner.
    const member = input.assigneeId?.startsWith('member:') ? input.assigneeId.slice(7) : null;
    if (member) {
      const team = await this.invoke('project.members.list', { projectId });
      const m = team.members.find(x => x.id === member && x.kind === 'agent' && !x.revokedAt);
      if (!m) throw new Error('That agent is not on this project’s Roster.');
      if (m.pendingAt) throw new Error(`${m.name} is waiting for approval. Approve the hire first.`);
    }
    const owner = input.assigneeId === 'user:local' ? { kind: 'user' as const, id: LOCAL_OWNER_ID } : member ? { kind: 'agent' as const, id: member } : { kind: 'agent' as const, id: DEFAULT_AGENT_ID };
    const priority = input.priority && input.priority in PRIORITY_IN ? PRIORITY_IN[input.priority] : undefined;
    const created = await this.invoke('project.tasks.add', { projectId, title, acceptance: description, dependencies: [], owner, ...(priority !== undefined ? { priority } : {}), ...(input.parentId ? { parentId: input.parentId } : {}) });
    return (await this.locate(created.id)).view;
  }

  /** Pausing a Roster member holds that member only (its runs stop; the scheduler and Start skip its tasks). The
   *  project's default runner, or every agent (`null`), pauses through the Project scheduler and stops its running work. */
  async setPaused(agentId: string | null, paused: boolean): Promise<number> {
    const reads = await this.projects();
    if (agentId?.startsWith('member:')) {
      const read = reads.find(r => r.members.some(m => memberAgentId(m.id) === agentId));
      if (!read) throw new Error('That agent is not on a Roster.');
      await this.invoke('project.members.pause', { projectId: read.project.id, id: agentId.slice(7), paused });
      return 1;
    }
    const list = reads.filter(r => !agentId || agentIdOf(r.project.id) === agentId);
    for (const read of list) await this.hold(read, paused);
    return list.length;
  }

  /** Pause all: holds every project that is not paused yet and stops its running work. Returns the projects it paused. */
  async pauseAll(): Promise<string[]> {
    const list = (await this.projects()).filter(r => !r.work.scheduler.paused);
    for (const read of list) await this.hold(read, true);
    return list.map(r => r.project.id);
  }

  /** Resume all: only the projects Pause all paused (`ids`), so a project paused on purpose stays paused. `null`: every one. */
  async resumeProjects(ids: readonly string[] | null): Promise<number> {
    const list = (await this.projects()).filter(r => r.work.scheduler.paused && (!ids || ids.includes(r.project.id)));
    for (const read of list) await this.hold(read, false);
    return list.length;
  }

  /** "Running work stops and nothing new starts": pausing sets the scheduler and stops every running attempt. */
  private async hold(read: ProjectRead, paused: boolean): Promise<void> {
    await this.invoke('project.scheduler.set', { projectId: read.project.id, paused });
    if (!paused) return;
    for (const task of read.work.tasks.items) for (const attempt of task.attempts) if (attempt.status === 'running') await this.invoke('chat.stop', { id: attempt.chatId }).catch(() => undefined);
  }

  async cancelRun(runId: string): Promise<void> {
    for (const read of await this.projects()) for (const task of read.work.tasks.items) {
      const attempt = task.attempts.find(a => a.id === runId);
      if (attempt) { if (attempt.status !== 'running') throw new Error('That run already ended.'); await this.invoke('chat.stop', { id: attempt.chatId }); return; }
    }
    throw new Error('That run no longer exists.');
  }

  /** The task a project run worked on (its attempt ran in `chatId`) and that task's owner, for the run's Receipt. */
  async attribution(projectId: string, chatId: string): Promise<{ taskId: string; agent: string } | null> {
    const work = await this.invoke('project.work', { projectId, activityLimit: 1 });
    const task = work.tasks.items.find(t => t.attempts.some(a => a.chatId === chatId));
    if (!task) return null;
    if (task.owner.kind !== 'agent') return { taskId: task.id, agent: 'You' };
    if (task.owner.id === DEFAULT_AGENT_ID) return { taskId: task.id, agent: DEFAULT_AGENT_NAME };
    const members = await this.invoke('project.members.list', { projectId }).then(r => r.members, () => [] as ProjectMember[]);
    return { taskId: task.id, agent: members.find(m => m.id === task.owner.id)?.name ?? DEFAULT_AGENT_NAME };
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
