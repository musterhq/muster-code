/** Paperclip JSON -> the Projects workspace shapes (shared/domains/paperclip-protocol.ts). Pure, so tests feed recorded payloads. */
import type {
  ApprovalDecision, PaperclipBudgetPolicy, ThreadCard, LedgerEntry, AgentState, InboxKind, RunState, WorkspaceAgent, WorkspaceComment, WorkspaceCompany, WorkspaceGoal, WorkspaceInboxItem, WorkspacePriority,
  WorkspaceApproval, WorkspaceProject, WorkspaceRow, WorkspaceRun, WorkspaceStatus, WorkspaceTask,
} from '../shared/domains/paperclip-protocol.ts';
import { OPEN_STATUSES, WORKSPACE_STATUSES } from '../shared/domains/paperclip-protocol.ts';
import { normalizeRemote } from './memory-identity.ts';

type Json = Record<string, unknown>;
const str = (value: unknown): string | null => typeof value === 'string' && value ? value : null;
const obj = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
export const arr = (value: unknown): Json[] => Array.isArray(value) ? value.filter((v): v is Json => Boolean(v) && typeof v === 'object') : [];
const iso = (value: unknown, fallback = ''): string => str(value) ?? fallback;

/** The org's people from `/user-directory` (`users: [{ principalId, user: { id, name } | null }]`): id and a display name (the account's name, else its email, else the id). */
export function mapPeople(directory: unknown): { id: string; name: string }[] {
  const rows = arr(obj(directory).users);
  return rows.filter(r => r.status === undefined || r.status === 'active').map(r => { const u = obj(r.user), id = String(r.principalId ?? u.id ?? ''); return { id, name: str(u.name) ?? str(u.email)?.split('@')[0] ?? id }; }).filter(p => p.id);
}
export const mapCompany = (c: Json): WorkspaceCompany => ({ id: String(c.id), name: str(c.name) ?? 'Company', prefix: str(c.issuePrefix) ?? '' });

/** Skill names the org gave an agent (`adapterConfig.paperclipSkillSync.desiredSkills`). Never anything from `env`. */
const skillsOf = (adapter: Json): string[] => Array.isArray(obj(adapter.paperclipSkillSync).desiredSkills) ? (obj(adapter.paperclipSkillSync).desiredSkills as unknown[]).filter((v): v is string => typeof v === 'string').map(v => v.split('/').pop()!).slice(0, 40) : [];
const AGENT_STATE: Record<string, AgentState> = { active: 'active', idle: 'idle', running: 'running', paused: 'paused', error: 'error', pending_approval: 'pending', terminated: 'terminated' };
export function mapAgent(a: Json): WorkspaceAgent {
  const adapter = obj(a.adapterConfig);
  return {
    id: String(a.id), name: str(a.name) ?? 'Agent', role: str(a.role) ?? 'general', title: str(a.title), model: str(adapter.model), adapter: str(a.adapterType),
    status: AGENT_STATE[String(a.status)] ?? 'idle', reportsTo: str(a.reportsTo), lastActiveAt: str(a.lastHeartbeatAt) ?? str(a.updatedAt),
    error: str(a.errorReason) ?? str(a.pauseReason), pausable: true, source: 'paperclip', capabilities: str(a.capabilities),
    ...(skillsOf(adapter).length ? { skills: skillsOf(adapter) } : {}),
  };
}

/** An issue's blockers. Paperclip lists them as `blockedBy: [{ id, … }]` (only with `includeBlockedBy=true`); older
 *  payloads carry `blockedByIssueIds`. Both are read. */
export function blockerIds(i: Json): string[] {
  const listed = Array.isArray(i.blockedBy) ? (i.blockedBy as unknown[]).map(b => typeof b === 'string' ? b : str(obj(b).id)).filter((v): v is string => Boolean(v)) : [];
  const legacy = Array.isArray(i.blockedByIssueIds) ? (i.blockedByIssueIds as unknown[]).filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
  return [...new Set([...listed, ...legacy])];
}

const PRIORITY = new Set<WorkspacePriority>(['critical', 'high', 'medium', 'low']);
/** `me`: the signed-in person's id on this server. When it is known, "You" is shown only for that id; anyone else is named from `people` (user id to name), or "A teammate". */
export function mapIssue(i: Json, agents: ReadonlyMap<string, WorkspaceAgent>, liveTaskIds: ReadonlySet<string>, me?: string | null, people?: ReadonlyMap<string, string>): WorkspaceTask {
  const status = (WORKSPACE_STATUSES as readonly string[]).includes(String(i.status)) ? i.status as WorkspaceStatus : 'todo';
  const assigneeId = str(i.assigneeAgentId), creator = str(i.createdByAgentId);
  const id = String(i.id);
  return {
    id, key: str(i.identifier) ?? id.slice(0, 8), title: str(i.title) ?? 'Untitled', status, source: 'paperclip',
    priority: PRIORITY.has(i.priority as WorkspacePriority) ? i.priority as WorkspacePriority : 'medium',
    projectId: str(i.projectId), parentId: str(i.parentId), goalId: str(i.goalId),
    assigneeId: assigneeId ?? (str(i.assigneeUserId) ? `user:${i.assigneeUserId}` : null),
    assigneeLabel: assigneeId ? agents.get(assigneeId)?.name ?? 'Agent' : str(i.assigneeUserId) ? (me && i.assigneeUserId !== me ? people?.get(String(i.assigneeUserId)) ?? 'A teammate' : 'You') : null,
    assigneeUserId: str(i.assigneeUserId), responsibleUserId: str(i.responsibleUserId), createdByUserId: str(i.createdByUserId), createdByAgentId: creator,
    createdAt: iso(i.createdAt), updatedAt: iso(i.lastActivityAt, iso(i.updatedAt)), startedAt: str(i.startedAt), completedAt: str(i.completedAt) ?? str(i.cancelledAt),
    live: Boolean(i.activeRun) || liveTaskIds.has(id),
    blockedByIds: blockerIds(i),
    origin: creator ? agents.get(creator)?.name ?? 'Agent' : str(i.createdByUserId) ? (me && i.createdByUserId !== me ? people?.get(String(i.createdByUserId)) ?? 'A teammate' : 'You') : null,
    ...(arr(i.labels).length ? { labels: arr(i.labels).map(l => ({ name: str(l.name) ?? '', color: str(l.color) })).filter(l => l.name) } : {}),
  };
}

export function mapProject(p: Json, tasks: readonly WorkspaceTask[]): WorkspaceProject {
  const codebase = obj(p.codebase), primary = obj(p.primaryWorkspace);
  const workspace = arr(p.workspaces).find(w => w.isPrimary) ?? {};
  const remote = str(codebase.repoUrl) ?? str(primary.repoUrl) ?? str(workspace.repoUrl);
  const id = String(p.id), mine = tasks.filter(t => t.projectId === id);
  return {
    id, name: str(p.name) ?? 'Project', status: str(p.status) ?? 'in_progress', description: str(p.description) ?? '', source: 'paperclip',
    repo: remote ? normalizeRemote(remote) ?? null : null, cwd: str(codebase.effectiveLocalFolder) ?? str(primary.cwd) ?? str(workspace.cwd),
    taskCount: mine.length || (typeof p.taskCount === 'number' ? p.taskCount : 0), openCount: mine.filter(t => OPEN_STATUSES.includes(t.status)).length,
    paused: Boolean(p.pausedAt), memory: null,
  };
}

export const mapGoal = (g: Json): WorkspaceGoal => ({ id: String(g.id), title: str(g.title) ?? 'Goal', status: str(g.status) ?? 'active', level: str(g.level), parentId: str(g.parentId), ownerAgentId: str(g.ownerAgentId) });

const RUN_STATE: Record<string, RunState> = { queued: 'queued', scheduled_retry: 'queued', running: 'running', succeeded: 'succeeded', failed: 'failed', cancelled: 'cancelled', timed_out: 'timed_out', interrupted: 'interrupted' };
/**
 * Paperclip answers about a run in two shapes: a heartbeat run (`/heartbeat-runs`, `/live-runs`: `id` and a `contextSnapshot` holding
 * the task) and an issue's run row (`/issues/:id/runs`: `runId` and `contextIssueId`, no `id`, no snapshot). Both must give the same
 * run, or a run opened from a task is a different run ("undefined") from the one the Ledger lists.
 */
export function mapRun(r: Json): WorkspaceRun {
  const status = RUN_STATE[String(r.status)] ?? 'failed', context = obj(r.contextSnapshot);
  return {
    id: String(str(r.id) ?? str(r.runId)), agentId: str(r.agentId), taskId: str(context.issueId) ?? str(context.taskId) ?? str(r.contextIssueId), status, trigger: str(r.invocationSource), source: 'paperclip',
    createdAt: iso(r.createdAt), startedAt: str(r.startedAt), finishedAt: str(r.finishedAt), error: str(r.error) ?? str(r.errorCode),
    cancellable: status === 'queued' || status === 'running',
  };
}

const ATTENTION_KIND: Record<string, InboxKind> = {
  approval: 'approval', decision: 'approval', join_request: 'approval', issue_thread_interaction: 'question', blocker_attention: 'blocked', review: 'review',
  productivity_review: 'review', failed_run: 'failed_run', agent_error_alert: 'agent_error', budget_alert: 'budget', recovery_action: 'other',
};
/** Muster's own words for why an item is in the Inbox; Paperclip's `whyNow` speaks of its board and issue threads. */
const WHY: Record<string, string> = {
  approval: 'Waiting for your approval.', decision: 'Waiting for your decision.', join_request: 'Someone asked to join. Approve or decline.',
  issue_thread_interaction: 'An agent is waiting for your answer in the thread.', blocker_attention: 'Blocked until someone unblocks it.',
  review: 'Waiting for your review.', productivity_review: 'Waiting for your review of recent work.', failed_run: 'The run ended with an error.',
  agent_error_alert: 'The agent stopped with an error. Open it to see why.', budget_alert: 'An agent is close to or over its budget.', recovery_action: 'Needs a recovery step before work can go on.',
};
const SEVERITY = new Set(['high', 'medium', 'low']);
export function mapAttention(item: Json): WorkspaceInboxItem {
  const subject = obj(item.subject), related = obj(item.relatedIssue);
  const identifier = str(subject.identifier) ?? (subject.kind === 'interaction' ? str(related.identifier) : null);
  return {
    id: String(item.id ?? item.dedupKey), kind: ATTENTION_KIND[String(item.sourceKind)] ?? 'other',
    title: `${identifier ? `${identifier} · ` : ''}${str(subject.title) ?? str(related.title) ?? 'Needs attention'}`,
    why: WHY[String(item.sourceKind)] ?? 'Needs your attention.', severity: SEVERITY.has(String(item.severity)) ? item.severity as 'high' : 'medium', at: iso(item.activityAt, iso(item.updatedAt)),
    taskId: subject.kind === 'issue' ? str(subject.id) : str(related.id), agentId: subject.kind === 'agent' ? str(subject.id) : null, runId: subject.kind === 'run' ? str(subject.id) : null,
    // An approval row is decided from the row: its id and the decisions Paperclip offers for it.
    ...(item.sourceKind === 'approval' && subject.kind === 'approval' && str(subject.id) ? { approvalId: String(subject.id), approvalVerbs: verbsOf(item.decisionVerbs) } : {}),
  };
}
const VERB: Record<string, ApprovalDecision> = { approve: 'approve', reject: 'reject', request_revision: 'request_revision' };
/** The approval decisions Paperclip lists for an item; all three when it lists none. */
const verbsOf = (value: unknown): ApprovalDecision[] => { const found = arr(value).map(v => VERB[String(v.id)]).filter((v): v is ApprovalDecision => Boolean(v)); return found.length ? found : ['approve', 'reject', 'request_revision']; };

const APPROVAL_TITLE: Record<string, string> = { hire_agent: 'Hire an agent', approve_ceo_strategy: 'Approve the CEO’s strategy', budget_override_required: 'Budget override', request_board_approval: 'Board approval' };
/** A Paperclip approval (hire, strategy, budget override, board request) waiting on the board. */
export function mapApproval(a: Json, agents: ReadonlyMap<string, WorkspaceAgent>): WorkspaceApproval {
  const payload = obj(a.payload), type = String(a.type ?? 'request_board_approval');
  const name = str(payload.name), title = str(payload.title);
  const requester = str(a.requestedByAgentId);
  const facts = type === 'hire_agent'
    ? [str(payload.role) && `Role: ${payload.role}`, str(payload.adapterType) && `Runner: ${String(payload.adapterType).replace(/_local$/, '')}`, str(payload.capabilities)].filter(Boolean).join('\n')
    : [str(payload.plan), str(payload.description), str(payload.reason)].filter(Boolean).join('\n');
  return {
    id: String(a.id), type, status: a.status === 'revision_requested' ? 'revision_requested' : 'pending',
    title: type === 'hire_agent' ? `Hire ${name ?? 'an agent'}${str(payload.title) ? ` as ${payload.title}` : ''}` : title ?? name ?? APPROVAL_TITLE[type] ?? 'Approval',
    detail: facts.slice(0, 1200), requestedBy: requester ? agents.get(requester)?.name ?? 'Agent' : str(a.requestedByUserId) ? 'You' : null,
    agentId: type === 'hire_agent' ? str(payload.agentId) : null, issueIds: arr(a.issues).map(i => str(i.id)).filter((v): v is string => Boolean(v)),
    at: iso(a.createdAt), verbs: ['approve', 'reject', 'request_revision'],
  };
}

/** The @mention chip of a person in a comment: `[@Name](user://<id>)`. */
export const mentionsUser = (body: string, userId: string): boolean => body.includes(`(user://${userId})`) || body.includes(`(user://${userId}?`);
/**
 * Comments that tag the person, as Inbox items. Paperclip's attention feed has no mention kind, so the company activity feed is read for
 * `issue.comment_added` rows whose snippet carries the person's mention chip. One item per comment; the person's own comments never count.
 */
export function mapMentions(rows: readonly Json[], meId: string | null, agents: ReadonlyMap<string, WorkspaceAgent>): WorkspaceInboxItem[] {
  if (!meId) return [];
  const out: WorkspaceInboxItem[] = [];
  for (const row of rows) {
    if (row.action !== 'issue.comment_added' || row.actorId === meId) continue;
    const d = obj(row.details), snippet = str(d.bodySnippet);
    if (!snippet || !mentionsUser(snippet, meId)) continue;
    const by = str(row.agentId) ? agents.get(String(row.agentId))?.name ?? 'An agent' : 'Someone';
    out.push({ id: `mention:${str(d.commentId) ?? str(row.id)}`, kind: 'mention', title: `${str(d.identifier) ? `${d.identifier} · ` : ''}${str(d.issueTitle) ?? 'A task'}`, why: `${by} mentioned you in a comment.`, severity: 'medium', at: iso(row.createdAt), taskId: str(row.entityId), agentId: null, runId: null });
  }
  return out;
}

/** The founder's inbox: Paperclip's attention feed, plus review/blocked tasks and recent failed runs it did not already list. */
export function buildInbox(attention: readonly WorkspaceInboxItem[], tasks: readonly WorkspaceTask[], runs: readonly WorkspaceRun[], agents: ReadonlyMap<string, WorkspaceAgent>, now = Date.now()): WorkspaceInboxItem[] {
  const items = [...attention];
  const covered = new Set(items.map(i => i.taskId).filter(Boolean));
  for (const task of tasks) {
    if (covered.has(task.id) || (task.status !== 'in_review' && task.status !== 'blocked')) continue;
    covered.add(task.id);
    items.push({ id: `task:${task.id}`, kind: task.status === 'in_review' ? 'review' : 'blocked', title: `${task.key} · ${task.title}`, why: task.status === 'in_review' ? 'Waiting for your review.' : 'Blocked until someone unblocks it.', severity: task.priority === 'critical' || task.priority === 'high' ? 'high' : 'medium', at: task.updatedAt, taskId: task.id, agentId: task.assigneeId, runId: null });
  }
  const seen = new Set<string>();
  for (const run of runs) {
    if (run.status !== 'failed' && run.status !== 'timed_out') continue;
    const at = Date.parse(run.finishedAt ?? run.createdAt);
    if (!Number.isFinite(at) || now - at > 86_400_000) continue;
    const key = `${run.agentId}:${run.taskId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const task = run.taskId ? tasks.find(t => t.id === run.taskId) : undefined;
    // A failure on work that has since finished or been dropped needs nobody.
    if (task && (task.status === 'done' || task.status === 'cancelled')) continue;
    items.push({ id: `run:${run.id}`, kind: 'failed_run', title: `${agents.get(run.agentId ?? '')?.name ?? 'An agent'}'s run failed${task ? ` on ${task.key}` : ''}`, why: run.error ?? 'The run ended with an error.', severity: 'medium', at: run.finishedAt ?? run.createdAt, taskId: run.taskId, agentId: run.agentId, runId: run.id });
  }
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return items.sort((a, b) => rank[a.severity] - rank[b.severity] || b.at.localeCompare(a.at));
}

export function mapComment(c: Json, agents: ReadonlyMap<string, WorkspaceAgent>): WorkspaceComment {
  const agentId = str(c.authorAgentId) ?? str(c.derivedAuthorAgentId);
  const kind = agentId ? 'agent' : str(c.authorUserId) || c.authorType === 'user' ? 'user' : 'system';
  return { id: String(c.id), author: { kind, id: agentId ?? str(c.authorUserId), label: agentId ? agents.get(agentId)?.name ?? 'Agent' : kind === 'user' ? 'You' : 'Muster Server' }, body: str(c.body) ?? '', createdAt: iso(c.createdAt), runId: str(c.createdByRunId) };
}

/** Rows for the read-only lists (skills, artifacts, audit, routines). */
export function mapRows(kind: 'artifacts' | 'audit' | 'routines', payload: unknown): WorkspaceRow[] {
  const list = kind === 'artifacts' ? arr(obj(payload).artifacts) : arr(Array.isArray(payload) ? payload : obj(payload).items);
  return list.slice(0, 200).map(item => {
    if (kind === 'artifacts') { const issue = obj(item.issue), project = obj(item.project); return { id: String(item.id), title: str(item.title) ?? 'Artifact', detail: [str(issue.identifier), str(item.mediaKind), str(item.previewText)?.slice(0, 140)].filter(Boolean).join(' · '), status: str(item.source), at: str(item.updatedAt), source: 'paperclip', projectId: str(project.id) ?? str(item.projectId) }; }
    if (kind === 'audit') {
      // Which project and task an event is about, so a project's Activity can show only its own (the server's feed is company-wide).
      const details = obj(item.details), entity = str(item.entityType), entityId = str(item.entityId);
      const taskId = entity === 'issue' ? entityId : str(details.issueId) ?? str(details.taskId);
      const projectId = entity === 'project' ? entityId : str(details.projectId);
      return { id: String(item.id), title: `${str(item.action) ?? 'action'} · ${str(item.entityType) ?? ''}`, detail: `${str(item.actorType) ?? 'actor'} ${String(item.actorId ?? '').slice(0, 8)}`, status: null, at: str(item.createdAt), source: 'paperclip', projectId, taskId };
    }
    return mapRoutine(item);
  });
}

/** A Paperclip routine on Muster's automation model: schedule summary, next run, last run, overlap and catch-up. */
export function mapRoutine(item: Json): WorkspaceRow {
  const triggers = arr(item.triggers).filter(t => t.enabled !== false);
  const summary = triggers.map(t => t.kind === 'schedule' && str(t.cronExpression) ? `Cron ${t.cronExpression}${str(t.timezone) ? ` (${t.timezone})` : ''}` : t.kind === 'webhook' ? 'Webhook' : str(t.label) ?? 'On demand').join(' · ') || 'No active trigger';
  const next = triggers.map(t => str(t.nextRunAt)).filter((v): v is string => Boolean(v)).sort()[0] ?? null;
  const last = obj(item.lastRun);
  const status = str(item.status) ?? 'active';
  return {
    id: String(item.id), title: str(item.title) ?? 'Routine', detail: [summary, str(item.description)?.slice(0, 160)].filter(Boolean).join(' · '), status, at: next ?? str(last.createdAt) ?? str(item.updatedAt), source: 'paperclip',
    projectId: str(item.projectId), nextRunAt: next, lastRun: str(last.status) ? { status: String(last.status), at: str(last.triggeredAt) ?? str(last.createdAt) } : null,
    overlap: item.concurrencyPolicy === 'always_enqueue' ? 'queue' : 'skip', catchUp: item.catchUpPolicy === 'skip_missed' ? 'none' : 'one', paused: status !== 'active',
  };
}

const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
/** A Paperclip heartbeat run as a Ledger entry: Paperclip's own usage and outcome; no Muster hash chain. */
export function mapReceipt(r: Json, agents: ReadonlyMap<string, WorkspaceAgent>): LedgerEntry {
  const usage = obj(r.usageJson), context = obj(r.contextSnapshot), run = mapRun(r);
  const input = num(usage.inputTokens) ?? num(usage.input_tokens), output = num(usage.outputTokens) ?? num(usage.output_tokens);
  const agent = run.agentId ? agents.get(run.agentId) : undefined;
  return {
    id: `paperclip:${run.id}`, seq: null, source: 'paperclip', chatId: null, runId: run.id, taskId: run.taskId, projectId: str(context.projectId),
    trigger: str(r.invocationSource) ?? 'run', agent: agent?.name ?? 'Agent', provider: str(usage.provider) ?? agent?.adapter ?? null, model: str(usage.model) ?? agent?.model ?? null,
    tokens: input === null && output === null ? null : { input: input ?? 0, cached: num(usage.cachedInputTokens) ?? num(usage.cacheReadInputTokens) ?? 0, output: output ?? 0, reasoning: num(usage.reasoningOutputTokens) ?? 0 },
    // A run's list row carries no tool use (it lives in the run's own log): `unfetched`, not "none recorded". The run page reads it.
    costUsd: num(usage.costUsd) ?? num(usage.cost_usd), tools: [], toolsState: 'unfetched', approvals: 0, tests: 0, files: null,
    startedAt: run.startedAt, endedAt: run.finishedAt ?? run.createdAt, durationMs: run.startedAt && run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null,
    outcome: run.status, prevHash: null, hash: null,
  };
}

/** Needs-you cards from a Paperclip issue's thread interactions (confirmations, questions, suggested tasks). */
export function mapInteraction(i: Json, agents: ReadonlyMap<string, WorkspaceAgent>): ThreadCard {
  const payload = obj(i.payload), result = obj(i.result), status = String(i.status ?? 'pending');
  const questions = arr(payload.questions).map(q => str(q.prompt) ?? str(q.question)).filter(Boolean);
  // ask_user_questions is answerable here too, through Paperclip's respond endpoint.
  const asking = i.kind === 'ask_user_questions' && status === 'pending'
    ? arr(payload.questions).filter(q => str(q.id) && arr(q.options).length).map(q => ({ id: String(q.id), prompt: str(q.prompt) ?? str(q.question) ?? 'Question', helpText: str(q.helpText), multi: q.selectionMode === 'multi', allowOther: q.allowOther === true,
      options: arr(q.options).filter(o => str(o.id)).map(o => ({ id: String(o.id), label: str(o.label) ?? String(o.id), description: str(o.description) })) }))
    : [];
  return {
    kind: 'needs', id: `interaction:${i.id}`, at: iso(i.createdAt), from: agents.get(str(i.createdByAgentId) ?? '')?.name ?? null,
    prompt: str(payload.prompt) ?? (questions.length ? questions.join(' · ') : str(payload.title) ?? 'An agent needs your decision.'),
    detail: str(payload.detailsMarkdown)?.slice(0, 1200) ?? null,
    status: status === 'pending' ? 'pending' : status === 'cancelled' || status === 'withdrawn' || status === 'expired' ? 'cancelled' : 'resolved',
    resolution: str(result.outcome) ? `${result.outcome}${str(result.reason) ? `: ${result.reason}` : ''}` : null,
    interactionId: (i.kind === 'request_confirmation' || asking.length > 0) && status === 'pending' ? String(i.id) : null,
    acceptLabel: str(payload.acceptLabel), rejectLabel: str(payload.rejectLabel),
    ...(asking.length ? { questions: asking, submitLabel: str(payload.submitLabel) } : {}),
  };
}

/** A task document (a plan is the one with key `plan`) with its revisions, newest first. */
export function mapDocument(d: Json, revisions: readonly Json[], agents: ReadonlyMap<string, WorkspaceAgent>): ThreadCard {
  const by = (r: Json) => str(r.createdByAgentId) ? agents.get(String(r.createdByAgentId))?.name ?? 'Agent' : str(r.createdByUserId) ? 'You' : null;
  return {
    kind: 'document', id: `document:${d.id}`, at: iso(d.updatedAt, iso(d.createdAt)), key: String(d.key), title: str(d.title) ?? String(d.key), format: str(d.format) ?? 'markdown',
    body: (str(d.body) ?? '').slice(0, 24_000), revision: Number(d.latestRevisionNumber) || 1,
    revisions: revisions.map(r => ({ number: Number(r.revisionNumber) || 0, summary: str(r.changeSummary) ?? '', at: iso(r.createdAt), by: by(r) })).sort((a, b) => b.number - a.number).slice(0, 50),
  };
}
/** A pull request, branch or artifact an agent produced for a task. */
export const mapWorkProduct = (w: Json): ThreadCard => ({
  kind: 'workproduct', id: `workproduct:${w.id}`, at: iso(w.updatedAt, iso(w.createdAt)), type: str(w.type) ?? 'artifact', title: str(w.title) ?? 'Work product', status: str(w.status) ?? '',
  provider: str(w.provider), url: str(w.url), summary: (str(w.summary) ?? '').slice(0, 2000),
});

/** Budget policies from `/budgets/overview` (dollar budgets only: a policy in another metric is not a dollar figure). */
export function mapBudgets(overview: unknown): { policies: PaperclipBudgetPolicy[]; incidents: number } {
  const o = obj(overview);
  const policies = arr(o.policies).filter(p => p.metric === 'billed_cents' && p.isActive !== false && Number(p.amount) > 0 && (p.scopeType === 'company' || p.scopeType === 'project' || p.scopeType === 'agent')).map(p => ({
    id: String(p.policyId ?? p.id), scope: p.scopeType as 'company' | 'project' | 'agent', scopeId: String(p.scopeId), name: str(p.scopeName) ?? String(p.scopeType),
    limitUsd: Number(p.amount) / 100, observedUsd: (Number(p.observedAmount) || 0) / 100, percent: Number(p.utilizationPercent) || 0, warnPercent: Number(p.warnPercent) || 80,
    hardStop: p.hardStopEnabled === true, status: str(p.status) ?? 'ok', paused: p.paused === true,
  }));
  return { policies, incidents: arr(o.activeIncidents).length };
}
