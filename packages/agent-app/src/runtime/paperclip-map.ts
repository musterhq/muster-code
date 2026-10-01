/** Paperclip JSON -> the Projects workspace shapes (shared/domains/paperclip-protocol.ts). Pure, so tests feed recorded payloads. */
import type {
  ThreadCard, LedgerEntry, AgentState, InboxKind, RunState, WorkspaceAgent, WorkspaceComment, WorkspaceCompany, WorkspaceGoal, WorkspaceInboxItem, WorkspacePriority,
  WorkspaceProject, WorkspaceRow, WorkspaceRun, WorkspaceStatus, WorkspaceTask,
} from '../shared/domains/paperclip-protocol.ts';
import { OPEN_STATUSES, WORKSPACE_STATUSES } from '../shared/domains/paperclip-protocol.ts';
import { normalizeRemote } from './memory-identity.ts';

type Json = Record<string, unknown>;
const str = (value: unknown): string | null => typeof value === 'string' && value ? value : null;
const obj = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
export const arr = (value: unknown): Json[] => Array.isArray(value) ? value.filter((v): v is Json => Boolean(v) && typeof v === 'object') : [];
const iso = (value: unknown, fallback = ''): string => str(value) ?? fallback;

export const mapCompany = (c: Json): WorkspaceCompany => ({ id: String(c.id), name: str(c.name) ?? 'Company', prefix: str(c.issuePrefix) ?? '' });

const AGENT_STATE: Record<string, AgentState> = { active: 'active', idle: 'idle', running: 'running', paused: 'paused', error: 'error', pending_approval: 'pending', terminated: 'terminated' };
export function mapAgent(a: Json): WorkspaceAgent {
  const adapter = obj(a.adapterConfig);
  return {
    id: String(a.id), name: str(a.name) ?? 'Agent', role: str(a.role) ?? 'general', title: str(a.title), model: str(adapter.model), adapter: str(a.adapterType),
    status: AGENT_STATE[String(a.status)] ?? 'idle', reportsTo: str(a.reportsTo), lastActiveAt: str(a.lastHeartbeatAt) ?? str(a.updatedAt),
    error: str(a.errorReason) ?? str(a.pauseReason), pausable: true, source: 'paperclip', capabilities: str(a.capabilities),
  };
}

const PRIORITY = new Set<WorkspacePriority>(['critical', 'high', 'medium', 'low']);
export function mapIssue(i: Json, agents: ReadonlyMap<string, WorkspaceAgent>, liveTaskIds: ReadonlySet<string>): WorkspaceTask {
  const status = (WORKSPACE_STATUSES as readonly string[]).includes(String(i.status)) ? i.status as WorkspaceStatus : 'todo';
  const assigneeId = str(i.assigneeAgentId), creator = str(i.createdByAgentId);
  const id = String(i.id);
  return {
    id, key: str(i.identifier) ?? id.slice(0, 8), title: str(i.title) ?? 'Untitled', status, source: 'paperclip',
    priority: PRIORITY.has(i.priority as WorkspacePriority) ? i.priority as WorkspacePriority : 'medium',
    projectId: str(i.projectId), parentId: str(i.parentId), goalId: str(i.goalId),
    assigneeId: assigneeId ?? (str(i.assigneeUserId) ? `user:${i.assigneeUserId}` : null),
    assigneeLabel: assigneeId ? agents.get(assigneeId)?.name ?? 'Agent' : str(i.assigneeUserId) ? 'You' : null,
    createdAt: iso(i.createdAt), updatedAt: iso(i.lastActivityAt, iso(i.updatedAt)), startedAt: str(i.startedAt), completedAt: str(i.completedAt) ?? str(i.cancelledAt),
    live: Boolean(i.activeRun) || liveTaskIds.has(id),
    blockedByIds: Array.isArray(i.blockedByIssueIds) ? (i.blockedByIssueIds as unknown[]).filter((v): v is string => typeof v === 'string') : [],
    origin: creator ? agents.get(creator)?.name ?? 'Agent' : str(i.createdByUserId) ? 'You' : null,
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

export const mapGoal = (g: Json): WorkspaceGoal => ({ id: String(g.id), title: str(g.title) ?? 'Goal', status: str(g.status) ?? 'active', level: str(g.level) });

const RUN_STATE: Record<string, RunState> = { queued: 'queued', scheduled_retry: 'queued', running: 'running', succeeded: 'succeeded', failed: 'failed', cancelled: 'cancelled', timed_out: 'timed_out', interrupted: 'interrupted' };
export function mapRun(r: Json): WorkspaceRun {
  const status = RUN_STATE[String(r.status)] ?? 'failed', context = obj(r.contextSnapshot);
  return {
    id: String(r.id), agentId: str(r.agentId), taskId: str(context.issueId) ?? str(context.taskId), status, trigger: str(r.invocationSource), source: 'paperclip',
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
  };
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
  return { id: String(c.id), author: { kind, id: agentId ?? str(c.authorUserId), label: agentId ? agents.get(agentId)?.name ?? 'Agent' : kind === 'user' ? 'You' : 'Paperclip' }, body: str(c.body) ?? '', createdAt: iso(c.createdAt), runId: str(c.createdByRunId) };
}

/** Rows for the read-only lists (skills, artifacts, audit, routines). */
export function mapRows(kind: 'artifacts' | 'audit' | 'routines', payload: unknown): WorkspaceRow[] {
  const list = kind === 'artifacts' ? arr(obj(payload).artifacts) : arr(Array.isArray(payload) ? payload : obj(payload).items);
  return list.slice(0, 200).map(item => {
    if (kind === 'artifacts') { const issue = obj(item.issue), project = obj(item.project); return { id: String(item.id), title: str(item.title) ?? 'Artifact', detail: [str(issue.identifier), str(item.mediaKind), str(item.previewText)?.slice(0, 140)].filter(Boolean).join(' · '), status: str(item.source), at: str(item.updatedAt), source: 'paperclip', projectId: str(project.id) ?? str(item.projectId) }; }
    if (kind === 'audit') return { id: String(item.id), title: `${str(item.action) ?? 'action'} · ${str(item.entityType) ?? ''}`, detail: `${str(item.actorType) ?? 'actor'} ${String(item.actorId ?? '').slice(0, 8)}`, status: null, at: str(item.createdAt), source: 'paperclip' };
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
    costUsd: num(usage.costUsd) ?? num(usage.cost_usd), tools: [], approvals: 0, tests: 0, files: null,
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
