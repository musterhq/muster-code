/**
 * The `muster_tasks` agent tools (Wave 4: G40), the task protocol they follow (G41), agent-initiated hiring (G8), question and
 * confirmation cards (G6) and the approvals list with comments and change requests (G7).
 *
 * Every tool runs as the task run's own agent and is checked against that agent's governance permissions (Wave 1: G12 can assign,
 * assignment scope, can hire, low-trust containment), exactly like the fenced blocks an agent may end a message with. Nothing here
 * widens what an agent may do: a refusal is returned to the agent as the tool's error and written to the task's activity.
 */
import type { ChatPermissionMode } from '../../shared/protocol.ts';
import { REMOTE_PROVIDER, type ApprovalItem, type Interaction, type InteractionQuestion, type RemoteTask, type RemoteTaskDetail } from '../../shared/domains/agent-tools-protocol.ts';
import type { AgentGovernance, RunReason, SecretProposal } from '../../shared/domains/project-governance-protocol.ts';
import { DEFAULT_AGENT_ID, LOCAL_OWNER_ID, type ProjectMember } from '../../shared/domains/project-team-protocol.ts';
import type { TaskOwner, TaskPriority, TaskState } from '../../shared/domains/projects-protocol.ts';
import type { ProjectTask, ProjectTaskStore } from '../project-tasks.ts';
import type { ProjectTeamStore } from '../project-team.ts';
import { redactSecrets } from '../secret-redaction.ts';
import type { McpToolResult } from '../sandbox-registry.ts';
import type { InteractionStore } from './interactions.ts';
import { toolText, type ToolSpec } from './tool-host.ts';

export const TASK_MCP = 'muster_tasks';
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const S = { type: 'string' } as const;
/** Kept terse: every schema below rides in each task run's turn (see tests/wave4-task-tools.test.ts for the budget). */
export const TASK_TOOL_SPECS: ToolSpec[] = [
  { name: 'task_get', description: 'Your task (or another by key like OSS-3): state, acceptance, subtasks, documents, recent comments.', inputSchema: obj({ task: S }) },
  { name: 'task_list', description: 'List tasks. scope: mine (default), subtasks, project.', inputSchema: obj({ scope: { enum: ['mine', 'subtasks', 'project'] }, state: S, limit: { type: 'number' } }) },
  { name: 'agent_list', description: 'List your teammates: name, title, who they report to.', inputSchema: obj({}) },
  { name: 'task_comment', description: 'Comment on your task (or another you may touch). Say what you did, what changed, what is left.', inputSchema: obj({ body: S, task: S }, ['body']) },
  { name: 'task_update', description: 'Move your task: implemented (done, ready for review) or blocked (say why). Optional comment.', inputSchema: obj({ state: { enum: ['implemented', 'blocked', 'review'] }, comment: S, task: S }, ['state']) },
  { name: 'task_create', description: 'Create a subtask (needs "can assign"). assignee is a teammate name.', inputSchema: obj({ title: S, acceptance: S, assignee: S, parent: S, priority: { type: 'number' } }, ['title']) },
  { name: 'task_assign', description: 'Hand a task to a teammate (needs "can assign").', inputSchema: obj({ task: S, assignee: S }, ['task', 'assignee']) },
  { name: 'task_checkout', description: 'Take a task: lease it so no other agent works it at the same time.', inputSchema: obj({ task: S }) },
  { name: 'task_document_upsert', description: 'Save a keyed document on a task (plan, design, notes). Keeps revisions.', inputSchema: obj({ key: S, text: S, note: S, task: S }, ['key', 'text']) },
  { name: 'task_ask_questions', description: 'Ask the user questions on a card, then end your turn. You are woken with the answers.', inputSchema: obj({ title: S, questions: { type: 'array', items: obj({ prompt: S, options: { type: 'array', items: S }, multiple: { type: 'boolean' } }, ['prompt']) } }, ['questions']) },
  { name: 'task_request_confirmation', description: 'Ask the user to confirm before you go on, then end your turn.', inputSchema: obj({ prompt: S, detail: S }, ['prompt']) },
  { name: 'agent_propose_hire', description: 'Propose a new teammate (needs "can add agents"). The user approves it in the Inbox.', inputSchema: obj({ name: S, title: S, reports_to: S, instructions: S, provider: S, model: S }, ['name', 'instructions']) },
];
export const TASK_TOOL_NAMES = new Set(TASK_TOOL_SPECS.map(t => t.name));

/** The Muster task protocol (G41): what a run does, in order. Shipped with every task run and shown in Skills. */
export const TASK_PROTOCOL_NAME = 'Muster task protocol';
export const TASK_PROTOCOL = [
  '1. Check out. Read your task with task_get before you change anything; if you picked a task yourself, take it with task_checkout.',
  '2. Work in small steps against the acceptance criteria, and keep the work in the task’s folder.',
  '3. Comment as you go with task_comment: what you did, what changed, what is left. Every run ends with a comment.',
  '4. Hand off with task_update: implemented when the acceptance criteria are met and you can say how you checked, or blocked with the reason and who can unblock it.',
  '5. Delegate with task_create under your task when you are allowed to; give each subtask an owner and acceptance criteria.',
  '6. Escalate with task_ask_questions or task_request_confirmation when only the user can decide, then end your turn. Do not wait or poll.',
  '7. Never write a secret into a comment or document. Ask for one with a secret request.',
].join('\n');

const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const clip = (s: string, n: number) => { const f = s.replace(/\s+/g, ' ').trim(); return f.length > n ? `${f.slice(0, n - 1)}…` : f; };
const text = (v: unknown, max: number): string | null => typeof v === 'string' && v.trim() && v.length <= max && !v.includes('\0') ? v.trim() : null;
const LEASE_MS = 30 * 60_000;

export interface HireInput { name: string; title: string | null; reportsTo: string | null; instructions: string; runner?: { providerId: string; model: string } | null }
export interface TaskToolDeps {
  store(): InteractionStore;
  tasks(): ProjectTaskStore;
  team(): ProjectTeamStore;
  exists(projectId: string): boolean;
  keyOf(t: Pick<ProjectTask, 'projectId'> & { seq?: number | null }): string;
  nameOf(projectId: string, memberId: string | null | undefined): string;
  agentGov(projectId: string, memberId: string): AgentGovernance;
  mayAssign(projectId: string, memberId: string, acting: ProjectTask, target: { taskId: string | null; create?: boolean }): string | null;
  lowTrustAssignee(projectId: string, creatorId: string, assigneeId: string): string | null;
  trustCeiling(projectId: string, memberId: string | null): ChatPermissionMode | null;
  record(projectId: string, kind: string, summary: string, refId?: string | null, actor?: 'agent' | 'system' | 'user'): void;
  changed(projectId: string, taskId?: string, snapshot?: boolean): void;
  wake(r: { projectId: string; memberId: string; taskId: string | null; reason: RunReason; note?: string; force?: boolean }): Promise<unknown>;
  onAssigned(projectId: string, taskId: string): void;
  invoke(command: string, input: Record<string, unknown>): Promise<unknown>;
  secretProposals(projectId: string, pendingOnly: boolean): SecretProposal[];
  now(): number;
}

export function createTaskTools(d: TaskToolDeps) {
  const members = (projectId: string) => d.team().list(projectId);
  const activeAgents = (projectId: string) => members(projectId).filter(m => m.kind === 'agent' && m.id !== DEFAULT_AGENT_ID && !m.revokedAt && !m.pendingAt);
  const findAgent = (projectId: string, ref: string | null | undefined): ProjectMember | undefined =>
    ref ? activeAgents(projectId).find(m => m.id === ref || m.name.toLowerCase() === ref.toLowerCase()) : undefined;
  const taskByRef = (projectId: string, ref: string | null | undefined, acting: ProjectTask): ProjectTask | undefined => {
    if (!ref) return acting;
    const list = d.tasks().listTasks(projectId).items;
    return list.find(t => t.id === ref) ?? list.find(t => d.keyOf(t).toLowerCase() === ref.toLowerCase());
  };
  const line = (t: ProjectTask) => `${d.keyOf(t)} [${t.state}] ${clip(t.title, 90)} — ${t.owner.kind === 'agent' ? d.nameOf(t.projectId, t.owner.id) : 'user'}${t.parentId ? '' : ''}`;

  /** The comment lands in the task's activity as the agent's; secrets are redacted on the way in. */
  const comment = (projectId: string, task: ProjectTask, who: string, body: string) => {
    d.record(projectId, 'task.agent-comment', `${who}: ${redactSecrets(body).slice(0, 900)}`, task.id, 'agent');
    d.changed(projectId, task.id);
  };

  /** Hire proposals from tools and from the `muster-hire` block share one path, so both land in the approvals list. */
  function proposeHire(projectId: string, proposerId: string, h: HireInput, taskId: string | null): { ok: true; member: ProjectMember; pending: boolean; approval: ApprovalItem | null } | { ok: false; refusal: string } {
    const who = d.nameOf(projectId, proposerId), caps = d.agentGov(projectId, proposerId).capabilities;
    if (!caps.canHire) return { ok: false, refusal: `${who} is not allowed to add agents. Turn on “Can add agents” in their permissions.` };
    if (caps.trust === 'low-trust') return { ok: false, refusal: `${who} is a low-trust agent and cannot add agents.` };
    const boss = h.reportsTo ? members(projectId).find(m => m.kind === 'agent' && (m.id === h.reportsTo || m.name.toLowerCase() === h.reportsTo!.toLowerCase())) : undefined;
    const pending = d.team().settings(projectId).requireHireApproval;
    // The same agent proposing the same name again, after a change request, revises its open proposal instead of adding a second.
    const open = members(projectId).find(m => m.kind === 'agent' && m.pendingAt && !m.revokedAt && m.name.toLowerCase() === h.name.toLowerCase());
    const prior = open ? d.store().approvalByRef('hire', open.id) : undefined;
    let member: ProjectMember;
    if (open && prior && d.store().requesterId(prior.id) === proposerId) {
      member = d.team().update(projectId, open.id, { ...(h.title ? { title: h.title } : {}), reportsTo: boss?.id ?? proposerId, instructions: h.instructions, ...(h.runner ? { runner: h.runner } : {}) }).after;
    } else {
      member = d.team().add(projectId, { name: h.name, kind: 'agent', role: 'agent', pending, ...(h.title ? { title: h.title } : {}), reportsTo: boss?.id ?? proposerId, instructions: h.instructions, ...(h.runner ? { runner: h.runner } : {}) });
    }
    const approval = pending ? d.store().upsertApproval({ projectId, kind: 'hire', refId: member.id, title: `Add ${member.name}${member.title ? ` as ${member.title}` : ''}`,
      detail: clip(h.instructions, 600), requestedBy: who, requestedById: proposerId, taskId }) : null;
    d.record(projectId, pending ? 'member.hire-requested' : 'member.added', `${who} ${pending ? 'asked to add' : 'added'} ${member.name}${member.title ? ` as ${member.title}` : ''}${pending ? ': waiting for your approval' : ''}.`, member.id, 'agent');
    d.changed(projectId, taskId ?? '', true);
    return { ok: true, member, pending, approval };
  }

  /** Runs one tool as the agent that owns the task whose run is this chat. */
  async function run(chatId: string, tool: string, args: Record<string, unknown>, task: ProjectTask | undefined): Promise<McpToolResult> {
    if (!task) return toolText('These tools work inside a task run. This chat is not running a task.', true);
    const projectId = task.projectId;
    if (!d.exists(projectId)) return toolText('This project no longer exists.', true);
    const mid = task.owner.kind === 'agent' ? task.owner.id : null;
    if (!mid) return toolText('This task is not owned by an agent.', true);
    const who = d.nameOf(projectId, mid), caps = d.agentGov(projectId, mid).capabilities;
    const deny = (why: string) => { d.record(projectId, 'task.permission-denied', `${who}: ${why}`, task.id, 'system'); return toolText(why, true); };
    /** Another task may be touched only inside the scope the agent was given. */
    const reach = (t: ProjectTask): string | null => t.id === task.id ? null : d.mayAssign(projectId, mid, task, { taskId: t.id });
    const pick = (ref: unknown): ProjectTask | McpToolResult => {
      const t = taskByRef(projectId, typeof ref === 'string' && ref.trim() ? ref.trim() : null, task);
      return t ?? toolText(`No task ${String(ref)} in this project.`, true);
    };
    const isResult = (v: ProjectTask | McpToolResult): v is McpToolResult => 'content' in v;

    switch (tool) {
      case 'task_get': {
        const t = pick(args.task); if (isResult(t)) return t;
        const all = d.tasks().listTasks(projectId).items, kids = all.filter(x => x.parentId === t.id), parent = t.parentId ? all.find(x => x.id === t.parentId) : undefined;
        const docs = await d.invoke('work.docs.list', { projectId, taskId: t.id }).catch(() => null) as { docs?: { key: string; rev: number }[] } | null;
        const acts = d.tasks().listActivity(projectId, 60).items.filter(a => a.refId === t.id).slice(0, 6).reverse();
        return toolText([
          `${d.keyOf(t)} “${t.title}” [${t.state}] owner ${t.owner.kind === 'agent' ? d.nameOf(projectId, t.owner.id) : 'user'}, priority ${t.priority}`,
          t.acceptance ? `Acceptance:\n${t.acceptance}` : 'No acceptance criteria written.',
          parent ? `Parent: ${line(parent)}` : '', kids.length ? `Subtasks:\n${kids.slice(0, 15).map(k => `- ${line(k)}`).join('\n')}` : '',
          t.dependencies.length ? `Depends on: ${t.dependencies.map(id => all.find(x => x.id === id)).filter(Boolean).map(x => d.keyOf(x!)).join(', ')}` : '',
          docs?.docs?.length ? `Documents: ${docs.docs.map(x => `${x.key} (rev ${x.rev})`).join(', ')}` : '', t.runError ? `Last note: ${clip(t.runError, 200)}` : '',
          acts.length ? `Recent:\n${acts.map(a => `- ${a.summary.slice(0, 200)}`).join('\n')}` : '',
        ].filter(Boolean).join('\n'));
      }
      case 'task_list': {
        const scope = args.scope === 'project' ? 'project' : args.scope === 'subtasks' ? 'subtasks' : 'mine';
        if (scope === 'project' && caps.trust === 'low-trust') return deny(`${who} is low-trust and may only see its own task and subtasks.`);
        const all = d.tasks().listTasks(projectId).items, limit = Math.min(Math.max(Number(args.limit) || 25, 1), 50);
        const under = new Set<string>([task.id]); for (let grew = true; grew;) { grew = false; for (const x of all) if (x.parentId && under.has(x.parentId) && !under.has(x.id)) { under.add(x.id); grew = true; } }
        const state = typeof args.state === 'string' ? args.state : null;
        const rows = all.filter(x => scope === 'project' ? true : scope === 'subtasks' ? under.has(x.id) && x.id !== task.id : x.owner.kind === 'agent' && x.owner.id === mid).filter(x => !state || x.state === state);
        return toolText(rows.length ? `${rows.length} task${rows.length === 1 ? '' : 's'}${rows.length > limit ? ` (first ${limit})` : ''}:\n${rows.slice(0, limit).map(line).join('\n')}` : 'No tasks match.');
      }
      case 'agent_list': {
        const list = activeAgents(projectId);
        return toolText(list.length ? list.map(m => `${m.name}${m.title ? `, ${m.title}` : ''}${m.reportsTo ? `, reports to ${d.nameOf(projectId, m.reportsTo)}` : ''}${m.pausedAt ? ' (paused)' : ''}${m.id === mid ? ' (you)' : ''}`).join('\n') : 'No other agents.');
      }
      case 'task_comment': {
        const body = text(args.body, 8000); if (!body) return toolText('Write the comment (up to 8,000 characters).', true);
        const t = pick(args.task); if (isResult(t)) return t;
        const why = reach(t); if (why) return deny(why);
        comment(projectId, t, who, body);
        return toolText(`Commented on ${d.keyOf(t)}.`);
      }
      case 'task_update': {
        const t = pick(args.task); if (isResult(t)) return t;
        const why = reach(t); if (why) return deny(why);
        const state = String(args.state) as TaskState, note = text(args.comment, 8000);
        if (!['implemented', 'blocked', 'review'].includes(state)) return toolText('Choose implemented, blocked or review.', true);
        if (state === 'blocked' && !note) return toolText('Say why the task is blocked (the comment).', true);
        if (t.state === 'verified' || t.state === 'cancelled') return toolText(`${d.keyOf(t)} is ${t.state === 'verified' ? 'done' : 'cancelled'}.`, true);
        if (note) comment(projectId, t, who, note);
        const next = d.tasks().setState({ projectId, id: t.id, revision: t.revision, state, ...(note ? { reason: note } : {}) }, 'agent');
        d.changed(projectId, t.id, true);
        return toolText(`${d.keyOf(next)} is now ${next.state}.`);
      }
      case 'task_create': {
        const title = text(args.title, 500); if (!title) return toolText('A task needs a title (up to 500 characters).', true);
        const parent = args.parent ? taskByRef(projectId, String(args.parent), task) : task;
        if (!parent) return toolText(`No task ${String(args.parent)} to put it under.`, true);
        const why = d.mayAssign(projectId, mid, task, { taskId: parent.id, create: true }); if (why) return deny(`${why} The subtask “${clip(title, 60)}” was not created.`);
        const assignee = args.assignee ? findAgent(projectId, String(args.assignee)) : undefined;
        if (args.assignee && !assignee) return toolText(`“${String(args.assignee)}” is not an active agent here. Use agent_list.`, true);
        const low = d.lowTrustAssignee(projectId, mid, assignee?.id ?? mid); if (low && assignee) return deny(`${low} “${clip(title, 60)}” was not created.`);
        const p = args.priority, ceiling = d.trustCeiling(projectId, mid);
        const t = d.tasks().createTask({ projectId, title, acceptance: text(args.acceptance, 4000) ?? '', dependencies: [], owner: assignee ? { kind: 'agent', id: assignee.id } as TaskOwner : task.owner, parentId: parent.id,
          ...(p === 0 || p === 1 || p === 2 || p === 3 ? { priority: p as TaskPriority } : {}), ...(ceiling ? { permissionMode: ceiling } : {}) }, 'agent');
        d.record(projectId, 'task.delegated', `${who} created ${d.keyOf(t)} “${clip(t.title, 60)}” under ${d.keyOf(parent)}${assignee ? ` for ${assignee.name}` : ''}.`, t.id, 'agent');
        if (assignee) d.onAssigned(projectId, t.id);
        d.changed(projectId, task.id, true);
        return toolText(`Created ${d.keyOf(t)} “${t.title}”${assignee ? ` for ${assignee.name}` : ''}.`);
      }
      case 'task_assign': {
        const t = pick(args.task); if (isResult(t)) return t;
        const to = findAgent(projectId, String(args.assignee ?? '')); if (!to) return toolText(`“${String(args.assignee)}” is not an active agent here. Use agent_list.`, true);
        const why = d.mayAssign(projectId, mid, task, { taskId: t.id }) ?? d.lowTrustAssignee(projectId, mid, to.id); if (why) return deny(`${why} ${d.keyOf(t)} was not reassigned.`);
        if (t.state === 'running' || t.state === 'needs-input') return toolText(`${d.keyOf(t)} is running; it cannot be reassigned until the run ends.`, true);
        d.tasks().editTask({ projectId, id: t.id, revision: t.revision, patch: { owner: { kind: 'agent', id: to.id } } }, 'agent');
        d.record(projectId, 'task.delegated', `${who} reassigned ${d.keyOf(t)} to ${to.name}.`, t.id, 'agent');
        d.onAssigned(projectId, t.id); d.changed(projectId, t.id, true);
        return toolText(`${d.keyOf(t)} now belongs to ${to.name}.`);
      }
      case 'task_checkout': {
        const t = pick(args.task); if (isResult(t)) return t;
        const mine = t.owner.kind === 'agent' && t.owner.id === mid, free = t.owner.kind === 'user' || (t.owner.kind === 'agent' && t.owner.id === DEFAULT_AGENT_ID);
        if (!mine && !free) return toolText(`${d.keyOf(t)} belongs to ${d.nameOf(projectId, t.owner.id)}.`, true);
        if (!mine) { const why = d.mayAssign(projectId, mid, task, { taskId: t.id }); if (why) return deny(`${why} It cannot take ${d.keyOf(t)}.`); }
        if (t.state === 'verified' || t.state === 'cancelled') return toolText(`${d.keyOf(t)} is ${t.state === 'verified' ? 'done' : 'cancelled'}.`, true);
        const holder = `agent:${mid}`;
        if (!d.tasks().acquireLease(projectId, t.id, holder, LEASE_MS, d.now())) return toolText(`${d.keyOf(t)} is checked out by another agent. Try again later.`, true);
        if (!mine) { d.tasks().editTask({ projectId, id: t.id, revision: t.revision, patch: { owner: { kind: 'agent', id: mid } } }, 'agent'); d.record(projectId, 'task.delegated', `${who} took ${d.keyOf(t)}.`, t.id, 'agent'); d.changed(projectId, t.id, true); }
        return toolText(`Checked out ${d.keyOf(t)} for 30 minutes.`);
      }
      case 'task_document_upsert': {
        const key = text(args.key, 80), body = typeof args.text === 'string' ? args.text : null;
        if (!key || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(key)) return toolText('The key is 1–64 letters, digits, - or _ (for example plan).', true);
        if (body === null || body.length > 200_000) return toolText('Write the document text (up to 200,000 characters).', true);
        const t = pick(args.task); if (isResult(t)) return t;
        const why = reach(t); if (why) return deny(why);
        const out = await d.invoke('work.docs.save', { projectId, taskId: t.id, key: key.toLowerCase(), text: body, note: text(args.note, 200) ?? '', by: who }) as { rev?: number };
        d.changed(projectId, t.id);
        return toolText(`Saved ${key} on ${d.keyOf(t)}${out?.rev ? ` (revision ${out.rev})` : ''}.`);
      }
      case 'task_ask_questions': {
        const raw = Array.isArray(args.questions) ? args.questions : [];
        if (!raw.length || raw.length > 6) return toolText('Ask 1 to 6 questions.', true);
        const questions: InteractionQuestion[] = [];
        for (const [i, q] of raw.entries()) {
          const prompt = q && typeof q === 'object' ? text((q as Record<string, unknown>).prompt, 600) : null;
          if (!prompt) return toolText(`Question ${i + 1} needs a prompt.`, true);
          const opts = Array.isArray((q as Record<string, unknown>).options) ? ((q as Record<string, unknown>).options as unknown[]).map(o => text(o, 200)).filter((o): o is string => !!o).slice(0, 12) : [];
          questions.push({ id: `q${i + 1}`, prompt, options: opts, multiple: opts.length > 0 && (q as Record<string, unknown>).multiple === true });
        }
        const card = d.store().addInteraction({ projectId, taskId: task.id, memberId: mid, memberName: who, kind: 'questions', title: text(args.title, 200) ?? clip(questions[0]!.prompt, 80), questions });
        d.record(projectId, 'task.question', `${who} asked ${questions.length === 1 ? 'a question' : `${questions.length} questions`}: ${clip(card.title, 120)}`, task.id, 'agent');
        d.changed(projectId, task.id, true);
        return toolText('The questions are on your task for the user. End your turn now; you will be woken with the answers.');
      }
      case 'task_request_confirmation': {
        const prompt = text(args.prompt, 600); if (!prompt) return toolText('Say what needs confirming.', true);
        const card = d.store().addInteraction({ projectId, taskId: task.id, memberId: mid, memberName: who, kind: 'confirmation', title: prompt,
          questions: [{ id: 'confirm', prompt: text(args.detail, 2000) ?? prompt, options: ['Confirm', 'Decline'], multiple: false }] });
        d.store().upsertApproval({ projectId, kind: 'confirmation', refId: card.id, title: prompt, detail: text(args.detail, 2000) ?? '', requestedBy: who, requestedById: mid, taskId: task.id });
        d.record(projectId, 'task.question', `${who} asks you to confirm: ${clip(prompt, 140)}`, task.id, 'agent');
        d.changed(projectId, task.id, true);
        return toolText('The confirmation is on your task for the user. End your turn now; you will be woken with the answer.');
      }
      case 'agent_propose_hire': {
        const name = text(args.name, 120), instructions = text(args.instructions, 20_000);
        if (!name || !instructions) return toolText('A hire needs a name and instructions.', true);
        const runner = text(args.provider, 100) && text(args.model, 200) ? { providerId: String(args.provider).trim(), model: String(args.model).trim() } : null;
        let r: ReturnType<typeof proposeHire>;
        try { r = proposeHire(projectId, mid, { name, title: text(args.title, 120), reportsTo: text(args.reports_to, 128), instructions, runner }, task.id); }
        catch (e) { return toolText(`The hire of ${name} failed: ${e instanceof Error ? e.message : 'error'}`, true); }
        if (!r.ok) return deny(r.refusal);
        return toolText(r.pending ? `${name} is proposed and waits for the user’s approval in the Inbox. Do not rely on them until it is approved.` : `${name} joined the team.`);
      }
      default: return toolText(`Unknown tool ${tool}.`, true);
    }
  }

  // ── what people do with the cards ───────────────────────────────────────────
  const syncApprovals = (projectId: string) => {
    const store = d.store();
    // Secret requests live in the governance store; mirror them so they list, comment and revise like the rest.
    for (const p of d.secretProposals(projectId, true)) {
      const cur = store.approvalByRef('secret', p.id);
      if (!cur) store.upsertApproval({ projectId, kind: 'secret', refId: p.id, title: `${p.memberName} asks for the secret ${p.name}`, detail: p.purpose, requestedBy: p.memberName, requestedById: p.memberId, taskId: p.taskId });
    }
    for (const a of store.approvals(projectId, true)) {
      if (a.kind === 'secret') {
        const p = d.secretProposals(projectId, false).find(x => x.id === a.refId);
        if (p && p.state !== 'pending' && a.state !== (p.state === 'approved' ? 'approved' : p.state === 'denied' ? 'declined' : 'expired')) store.setApprovalState(a.id, p.state === 'approved' ? 'approved' : p.state === 'denied' ? 'declined' : 'expired');
        if (!p && a.state === 'pending') store.setApprovalState(a.id, 'cancelled');
      } else if (a.kind === 'hire') {
        const m = d.team().get(projectId, a.refId);
        if (!m && a.state === 'pending') store.setApprovalState(a.id, 'cancelled');
        else if (m && !m.pendingAt && (a.state === 'pending' || a.state === 'revision_requested')) store.setApprovalState(a.id, m.revokedAt ? 'declined' : 'approved');
      }
    }
    // A person adding an agent while approval is required has nobody to ask but themselves; it still lists, so it is decided in one place.
    for (const m of members(projectId)) if (m.kind === 'agent' && m.pendingAt && !m.revokedAt && !store.approvalByRef('hire', m.id))
      store.upsertApproval({ projectId, kind: 'hire', refId: m.id, title: `Add ${m.name}${m.title ? ` as ${m.title}` : ''}`, detail: clip(m.instructions ?? '', 600), requestedBy: m.reportsTo ? d.nameOf(projectId, m.reportsTo) : 'You', requestedById: m.reportsTo && m.reportsTo !== LOCAL_OWNER_ID ? m.reportsTo : null, taskId: null });
  };
  const approvals = (projectId: string, includeDecided: boolean) => { syncApprovals(projectId); return d.store().approvals(projectId, includeDecided); };

  /** Wakes the agent that asked, with what was decided. A paused or removed agent simply is not woken. */
  const wakeAsker = (projectId: string, memberId: string | null, taskId: string | null, note: string) => {
    if (!memberId || !d.exists(projectId)) return;
    const m = d.team().get(projectId, memberId);
    if (!m || m.revokedAt || m.pendingAt || !d.agentGov(projectId, memberId).heartbeat.wakeOnDecision) return;
    void d.wake({ projectId, memberId, taskId, reason: 'decision', note: redactSecrets(note).slice(0, 1500), force: true }).catch(() => undefined);
  };

  const remoteTask = (t: ProjectTask): RemoteTask => ({ id: t.id, key: d.keyOf(t), title: t.title, state: t.state, acceptance: t.acceptance, priority: t.priority, parentKey: t.parentId ? (d.tasks().getTask(t.parentId) ? d.keyOf(d.tasks().getTask(t.parentId)!) : null) : null, updatedAt: t.updatedAt });
  /** The agent a remote call speaks for: an active agent of this project whose runner is the remote one. */
  function remoteAgent(i: Record<string, unknown>): { projectId: string; m: ProjectMember } {
    const projectId = String(i.projectId ?? ''), memberId = String(i.memberId ?? '');
    if (!ID.test(projectId) || !d.exists(projectId)) throw new Error('Project not found.');
    const m = d.team().get(projectId, memberId);
    if (!m || m.kind !== 'agent' || m.revokedAt || m.pendingAt || m.runner?.providerId !== REMOTE_PROVIDER) throw new Error('That is not an active remote agent of this project.');
    return { projectId, m };
  }
  function remoteOwned(projectId: string, m: ProjectMember, ref: unknown): ProjectTask {
    const t = d.tasks().getTask(String(ref ?? '')); if (!t || t.projectId !== projectId) throw new Error('No such task.');
    if (t.owner.kind !== 'agent' || t.owner.id !== m.id) throw new Error('That task is not assigned to this agent.');
    return t;
  }
  const handlers = {
    'project.interactions.list': (i: Record<string, unknown>) => {
      const projectId = String(i.projectId ?? ''); if (!ID.test(projectId) || !d.exists(projectId)) throw new Error('Project not found.');
      const state = i.state === 'pending' || i.state === 'answered' || i.state === 'cancelled' ? i.state : undefined;
      return { items: d.store().interactions(projectId, { ...(typeof i.taskId === 'string' ? { taskId: i.taskId } : {}), ...(state ? { state } : {}) }) };
    },
    'project.interactions.answer': (i: Record<string, unknown>) => {
      const projectId = String(i.projectId ?? ''); if (!ID.test(projectId) || !d.exists(projectId)) throw new Error('Project not found.');
      const card = d.store().getInteraction(String(i.id ?? ''));
      if (!card || card.projectId !== projectId) throw new Error('That card no longer exists.');
      if (card.state !== 'pending') throw new Error(card.state === 'answered' ? 'That card was already answered.' : 'That card was withdrawn.');
      const given = (i.answers && typeof i.answers === 'object' ? i.answers : {}) as Record<string, unknown>, answers: Record<string, string | string[]> = {};
      for (const q of card.questions) {
        const v = given[q.id];
        if (q.options.length) {
          const picked = (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).filter((x): x is string => typeof x === 'string' && q.options.includes(x));
          if (!picked.length) throw new Error(`Choose an answer for “${clip(q.prompt, 60)}”.`);
          if (!q.multiple && picked.length > 1) throw new Error(`Choose one answer for “${clip(q.prompt, 60)}”.`);
          answers[q.id] = q.multiple ? picked : picked[0]!;
        } else {
          const t = typeof v === 'string' ? v.trim() : '';
          if (!t || t.length > 4000) throw new Error(`Write an answer for “${clip(q.prompt, 60)}” (up to 4,000 characters).`);
          answers[q.id] = t;
        }
      }
      const note = text(i.note, 2000);
      const out = d.store().setInteraction(card.id, 'answered', answers, note);
      if (card.kind === 'confirmation') { const a = d.store().approvalByRef('confirmation', card.id); if (a) d.store().setApprovalState(a.id, answers.confirm === 'Confirm' ? 'approved' : 'declined'); }
      d.record(projectId, 'task.answered', `You answered ${card.memberName}: ${clip(card.questions.map(q => `${clip(q.prompt, 50)} → ${Array.isArray(answers[q.id]) ? (answers[q.id] as string[]).join(', ') : answers[q.id]}`).join('; '), 300)}`, card.taskId, 'user');
      const t = card.taskId ? d.tasks().getTask(card.taskId) : undefined;
      // The run ended when the agent asked; the task waited as blocked. Answering reopens it so the wake can start a run.
      if (t && t.state === 'blocked' && /Waiting for your answer/.test(t.runError ?? '')) d.tasks().setState({ projectId, id: t.id, revision: t.revision, state: 'todo', reason: 'Answered' }, 'user');
      wakeAsker(projectId, card.memberId, card.taskId, `You asked “${card.title}”. The answers: ${card.questions.map(q => `${q.prompt} → ${Array.isArray(answers[q.id]) ? (answers[q.id] as string[]).join(', ') : answers[q.id]}`).join(' | ')}${note ? `. Note: ${note}` : ''}. Carry on.`);
      d.changed(projectId, card.taskId ?? '', true);
      return out;
    },
    'project.interactions.cancel': (i: Record<string, unknown>) => {
      const projectId = String(i.projectId ?? ''); if (!ID.test(projectId) || !d.exists(projectId)) throw new Error('Project not found.');
      const card = d.store().getInteraction(String(i.id ?? ''));
      if (!card || card.projectId !== projectId) throw new Error('That card no longer exists.');
      if (card.state !== 'pending') throw new Error('That card was already answered.');
      const out = d.store().setInteraction(card.id, 'cancelled', null, null);
      const a = d.store().approvalByRef('confirmation', card.id); if (a) d.store().setApprovalState(a.id, 'cancelled');
      const t = card.taskId ? d.tasks().getTask(card.taskId) : undefined;
      if (t && t.state === 'blocked' && /Waiting for your answer/.test(t.runError ?? '')) d.tasks().setState({ projectId, id: t.id, revision: t.revision, state: 'todo', reason: 'Question withdrawn' }, 'user');
      d.changed(projectId, card.taskId ?? '', true);
      return out;
    },
    'project.approvals.list': (i: Record<string, unknown>) => {
      const projectId = String(i.projectId ?? ''); if (!ID.test(projectId) || !d.exists(projectId)) throw new Error('Project not found.');
      return { items: approvals(projectId, i.includeDecided === true) };
    },
    'project.approvals.comment': (i: Record<string, unknown>) => {
      const projectId = String(i.projectId ?? ''); if (!ID.test(projectId) || !d.exists(projectId)) throw new Error('Project not found.');
      const a = d.store().getApproval(String(i.id ?? '')); if (!a || a.projectId !== projectId) throw new Error('That approval no longer exists.');
      const body = text(i.text, 4000); if (!body) throw new Error('Write the comment (up to 4,000 characters).');
      d.store().addComment(a.id, 'You', false, redactSecrets(body));
      return d.store().getApproval(a.id)!;
    },
    'project.approvals.requestRevision': (i: Record<string, unknown>) => {
      const projectId = String(i.projectId ?? ''); if (!ID.test(projectId) || !d.exists(projectId)) throw new Error('Project not found.');
      const a = d.store().getApproval(String(i.id ?? '')); if (!a || a.projectId !== projectId) throw new Error('That approval no longer exists.');
      if (a.state !== 'pending' && a.state !== 'revision_requested') throw new Error('That approval was already decided.');
      const note = text(i.note, 2000); if (!note) throw new Error('Say what to change.');
      d.store().requestRevision(a.id, redactSecrets(note));
      d.store().addComment(a.id, 'You', false, `Changes requested: ${redactSecrets(note)}`);
      d.record(projectId, 'task.approval-revision', `You asked ${a.requestedBy} to change “${clip(a.title, 80)}”: ${clip(note, 200)}`, a.taskId, 'user');
      wakeAsker(projectId, d.store().requesterId(a.id), a.taskId, `Your proposal “${a.title}” needs changes: ${note}. Propose it again with the changes (same name for a hire).`);
      d.changed(projectId, a.taskId ?? '', true);
      return d.store().getApproval(a.id)!;
    },
    // ── remote agents (G28): the server's agent API acts as one Roster agent, and only on tasks that agent owns ──
    'project.remote.tasks': (i: Record<string, unknown>) => { const { projectId, m } = remoteAgent(i); return { tasks: d.tasks().listTasks(projectId).items.filter(t => t.owner.kind === 'agent' && t.owner.id === m.id && t.state !== 'verified' && t.state !== 'cancelled').map(remoteTask) }; },
    'project.remote.task': (i: Record<string, unknown>) => {
      const { projectId, m } = remoteAgent(i), t = remoteOwned(projectId, m, i.id), all = d.tasks().listTasks(projectId).items;
      const docs = d.invoke('work.docs.list', { projectId, taskId: t.id }).then(x => (x as { docs: { key: string; rev: number }[] }).docs.map(y => ({ key: y.key, rev: y.rev })));
      return docs.then((documents): RemoteTaskDetail => ({ ...remoteTask(t), documents,
        comments: d.tasks().listActivity(projectId, 100).items.filter(a => a.refId === t.id && /^task\.(agent-comment|answered|status|delegated)/.test(a.kind)).slice(0, 12).reverse().map(a => ({ at: a.createdAt, by: a.actor, text: a.summary.slice(0, 600) })),
        subtasks: all.filter(x => x.parentId === t.id).slice(0, 30).map(x => ({ key: d.keyOf(x), title: x.title, state: x.state })) }));
    },
    'project.remote.comment': (i: Record<string, unknown>) => {
      const { projectId, m } = remoteAgent(i), t = remoteOwned(projectId, m, i.id), body = text(i.body, 8000); if (!body) throw new Error('Write the comment (up to 8,000 characters).');
      comment(projectId, t, m.name, body); return { ok: true as const };
    },
    'project.remote.state': (i: Record<string, unknown>) => {
      const { projectId, m } = remoteAgent(i), t = remoteOwned(projectId, m, i.id), state = String(i.state) as TaskState, note = text(i.comment, 8000);
      if (!['implemented', 'blocked', 'review'].includes(state)) throw new Error('Choose implemented, blocked or review.');
      if (state === 'blocked' && !note) throw new Error('Say why the task is blocked.');
      if (t.state === 'verified' || t.state === 'cancelled') throw new Error(`${d.keyOf(t)} is ${t.state === 'verified' ? 'done' : 'cancelled'}.`);
      if (note) comment(projectId, t, m.name, note);
      const next = d.tasks().setState({ projectId, id: t.id, revision: t.revision, state, ...(note ? { reason: note } : {}) }, 'agent'); d.changed(projectId, t.id, true); return remoteTask(next);
    },
    'project.remote.doc': async (i: Record<string, unknown>) => {
      const { projectId, m } = remoteAgent(i), t = remoteOwned(projectId, m, i.id), key = text(i.key, 80), body = typeof i.text === 'string' ? i.text : null;
      if (!key || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(key) || body === null || body.length > 200_000) throw new Error('Give a document key and its text.');
      const out = await d.invoke('work.docs.save', { projectId, taskId: t.id, key: key.toLowerCase(), text: body, note: text(i.note, 200) ?? '', by: m.name }) as { rev?: number }; d.changed(projectId, t.id); return { rev: out.rev ?? 1 };
    },
    'project.protocol.get': () => ({ name: TASK_PROTOCOL_NAME, text: TASK_PROTOCOL, tools: TASK_TOOL_SPECS.map(t => ({ name: t.name, description: t.description })) }),
  };

  /** Rows for the Inbox's Needs you: cards waiting for an answer. */
  const inboxItems = (projectId: string) => d.store().pendingInteractions(projectId).map(c => ({
    id: `ask:${c.id}`, kind: (c.kind === 'confirmation' ? 'approval' : 'question') as 'approval' | 'question', title: `${c.memberName} ${c.kind === 'confirmation' ? 'asks you to confirm' : 'has a question'}: ${clip(c.title, 80)}`,
    why: clip(c.questions[0]?.prompt ?? '', 200), severity: 'high' as const, at: c.createdAt, taskId: c.taskId, agentId: c.memberId ? `member:${c.memberId}` : null, area: 'questions',
  }));
  const pendingFor = (taskId: string): Interaction[] => { const t = d.tasks().getTask(taskId); return t ? d.store().interactions(t.projectId, { taskId, state: 'pending' }) : []; };

  return { run, proposeHire, handlers, inboxItems, pendingFor, approvals };
}
export type TaskTools = ReturnType<typeof createTaskTools>;
