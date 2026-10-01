/**
 * The work-layer domain (Wave 2 of the Paperclip-parity work, #117): project status and target date, labels, star and hide,
 * the goals tree, keyed task documents, feedback votes, Outputs depth, pull requests linked to tasks, Inbox read / snooze /
 * decide-by / recommendations, and living summaries. Storage is `runtime/work/store.ts`; the contract is
 * `shared/domains/work-protocol.ts`.
 *
 * Event-driven: nothing here polls. The one daily timer per scheduled status card is set only while such a card exists, and
 * the store file is opened only when something asks for it (or, after startup, when it already exists and has scheduled cards).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Chat } from '../../shared/protocol.ts';
import type { ProjectTaskView } from '../../shared/domains/projects-protocol.ts';
import {
  DATE_ONLY, DOC_KEY, DOC_LIMITS, GOAL_LEVELS, GOAL_STATUSES, LABEL_COLORS, MAX_LABELS, MAX_RECOMMENDATION, MAX_VOTE_REASON, OUTPUT_STATUSES, PROJECT_STATUSES, SUMMARY_LIMITS, goalAncestry, goalParentOk, findPullRequests,
  type DocThread, type ExternalObject, type Goal, type GoalLevel, type GoalStatus, type InboxMeta, type LabelColor, type OutputStatus, type Recommendation, type SummaryCard, type SummaryRefresh, type TaskDoc, type VoteKind, type VoteSubject, type WorkEvent, type WorkOverlay,
} from '../../shared/domains/work-protocol.ts';
import { keyPrefixOf } from '../../shared/domains/project-team-protocol.ts';
import { filterByQuery } from '../../shared/task-query.ts';
import { STATE, PRIORITY } from '../workspace-local.ts';
import { WorkStore } from '../work/store.ts';
import { latestAssistant, sendPrompt, startReadOnlyRun } from '../work/agent-run.ts';
import { capText, fingerprintOf, summaryPrompt, type WatchedTask } from '../work/summaries.ts';
import { fetchPullRequest } from '../work/pull-requests.ts';
import type { DomainContext, DomainHandler, DomainModule } from './types.ts';

const ID = /^[a-zA-Z0-9_.:-]{1,200}$/;
const id = (v: unknown, field = 'id'): string => { if (typeof v !== 'string' || !ID.test(v)) throw new Error(`Invalid ${field}.`); return v; };
const text = (v: unknown, label: string, max: number, required = true): string => {
  const t = typeof v === 'string' ? v.trim() : '';
  if (required && !t) throw new Error(`${label} is required.`);
  if (t.length > max) throw new Error(`${label} is too long (up to ${max} characters).`);
  if (t.includes('\0')) throw new Error(`${label} has an invalid character.`);
  return t;
};
const clip = (s: string, n: number) => { const f = s.replace(/\s+/g, ' ').trim(); return f.length > n ? `${f.slice(0, n - 1)}…` : f; };
const dateOnly = (v: unknown, label: string): string | null => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || !DATE_ONLY.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) throw new Error(`${label} must be a date like 2026-10-31.`);
  return v;
};
const DAY_MS = 86_400_000, DEBOUNCE_MS = 90_000, MIN_REARM_MS = 1000, MAX_TIMER_MS = 2 ** 31 - 1;
const STALE_MS = 2 * 60_000;

/** Tests only: a fake clock and timers for the daily and on-change summary schedules. Unset in the app. */
export const workClock: { now?: () => number; timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void } } = {};

export function createWorkDomain(ctx: DomainContext): DomainModule {
  let store: WorkStore | undefined, disposed = false;
  const now = () => workClock.now?.() ?? Date.now();
  const timers = () => workClock.timers ?? { set: (fn: () => void, ms: number) => { const t = setTimeout(fn, Math.min(ms, MAX_TIMER_MS)); t.unref?.(); return t; }, clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  const db = () => { if (!store) { store = new WorkStore(ctx.dataDir); store.clock = now; if (store.failStuckSummaries()) emit(null, ['summaries']); } return store; };
  const emit = (projectId: string | null, scopes: WorkEvent['scopes']) => { if (!disposed) ctx.emit({ type: 'workChanged', projectId, scopes }); };

  // ── lookups ─────────────────────────────────────────────────────────────────
  const project = (projectId: unknown) => { const p = ctx.store.project(id(projectId, 'project')); if (!p) throw new Error('That project no longer exists.'); return p; };
  const workOf = (projectId: string) => ctx.invoke('project.work', { projectId, activityLimit: 40 });
  const taskOf = async (projectId: string, taskId: unknown): Promise<ProjectTaskView> => { const t = (await workOf(projectId)).tasks.items.find(x => x.id === id(taskId, 'task')); if (!t) throw new Error('That task is not in this project.'); return t; };
  const membersOf = async (projectId: string) => (await ctx.invoke('project.members.list', { projectId })).members;
  const ownerName = (members: Awaited<ReturnType<typeof membersOf>>, t: ProjectTaskView): string | null => t.owner.kind === 'user' ? 'You' : t.owner.id === 'agent' ? 'Default agent' : members.find(m => m.id === t.owner.id)?.name ?? null;
  const folderPath = (projectId: string): string | null => { const p = ctx.store.project(projectId); const f = (p?.primaryFolderId ? ctx.store.folder(p.primaryFolderId) : undefined) ?? (p?.folderIds[0] ? ctx.store.folder(p.folderIds[0]) : undefined); return f?.path ?? null; };

  // ── overlay ─────────────────────────────────────────────────────────────────
  const overlay = async (): Promise<WorkOverlay> => {
    const w = db(), projects: WorkOverlay['projects'] = {}, agents: WorkOverlay['agents'] = {};
    for (const m of w.allProjectMeta()) projects[m.projectId] = { status: m.status, targetDate: m.targetDate, starred: m.starred, hidden: m.hidden };
    for (const a of w.agentMeta()) agents[a.id] = { starred: a.starred, hidden: a.hidden };
    const inbox = await ctx.invoke('automations.gate.list', {}).then(r => r.items.map(g => ({ id: `gate:${g.id}`, kind: 'approval' as const, title: `Run “${g.automationName}”?`, why: g.summary, severity: 'medium' as const, at: g.createdAt, projectId: g.projectId, group: g.projectName ?? 'Automations' })), () => []);
    return { projects, agents, labels: w.allTaskLabels(), goals: w.taskGoals(), prs: w.prSummaries(), inbox };
  };

  // ── goals ───────────────────────────────────────────────────────────────────
  const goalView = (projectId: string) => {
    const goals = db().goals(projectId), links = db().goalLinks(goals.map(g => g.id));
    return { goals, links, ancestry: Object.fromEntries(goals.map(g => [g.id, goalAncestry(goals, g.id)])) };
  };

  // ── documents ───────────────────────────────────────────────────────────────
  const docView = (taskId: string, key: string, rev?: number): TaskDoc => {
    const w = db(), head = w.docRev(taskId, key);
    if (!head) throw new Error(`This task has no “${key}” document.`);
    const at = rev === undefined ? head : w.docRev(taskId, key, rev);
    if (!at) throw new Error(`Revision ${rev} of “${key}” no longer exists.`);
    return { taskId, key, rev: at.rev, text: at.text, updatedAt: at.updatedAt, revisions: w.docRevisions(taskId, key), threads: w.threads(taskId, key, head.text) };
  };
  const docKey = (v: unknown): string => { const k = typeof v === 'string' ? v.trim().toLowerCase() : ''; if (!DOC_KEY.test(k)) throw new Error('A document key is 1–40 lowercase letters, digits, dashes or underscores, like plan or design.'); return k; };
  const saveDoc = (projectId: string, taskId: string, key: string, body: string, note: string, actor: string, baseRev?: number): TaskDoc => {
    const w = db(), head = w.headRev(taskId, key);
    if (body.length > DOC_LIMITS.maxChars) throw new Error(`A document holds up to ${DOC_LIMITS.maxChars.toLocaleString('en-US')} characters.`);
    if (head === null && w.countDocs(taskId) >= DOC_LIMITS.maxKeys) throw new Error(`A task holds up to ${DOC_LIMITS.maxKeys} documents.`);
    if (head !== null && baseRev !== undefined && baseRev !== head) throw new Error(`This document changed while you edited it (it is now revision ${head}). Reload it and apply your changes again.`);
    if (head !== null && w.docRev(taskId, key)!.text === body) return docView(taskId, key);
    w.saveDoc(projectId, taskId, key, body, note, actor);
    emit(projectId, ['docs']);
    return docView(taskId, key);
  };
  const wakeOwner = async (taskId: string, body: string) => { try { await ctx.invoke('paperclip.comment', { taskId, body }); } catch { /* an unowned task has nobody to wake; the thread is still saved */ } };

  // ── external objects ────────────────────────────────────────────────────────
  const refreshLink = async (link: ExternalObject): Promise<ExternalObject> => {
    const cwd = folderPath(link.projectId);
    if (!cwd) return db().updateLink(link.id, { error: 'Link a folder to this project first: GitHub is read through the signed-in gh session from a project folder.' });
    try { const s = await fetchPullRequest(cwd, link.repo, link.number); const next = db().updateLink(link.id, { title: s.title, state: s.state, draft: s.draft, checks: s.checks, checksSummary: s.checksSummary, error: null }); return next; }
    catch (e) { return db().updateLink(link.id, { error: e instanceof Error ? e.message : String(e) }); }
  };
  const record = async (projectId: string, taskId: string, urls: { url: string; repo: string; number: number }[], source: 'detected' | 'manual'): Promise<ExternalObject[]> => {
    const out: ExternalObject[] = [];
    for (const u of urls) {
      const { link, created } = db().addLink(projectId, taskId, u.url, u.repo, u.number, source);
      out.push(created || link.fetchedAt === null ? await refreshLink(link) : link);
    }
    if (out.length) emit(projectId, ['links', 'outputs']);
    return out;
  };

  // ── agent runs that report back (summaries, recommendations) ────────────────
  type Pending = { kind: 'summary'; cardId: string; projectId: string; fingerprint: string; tasks: number } | { kind: 'recommend'; itemId: string; agent: string; projectId: string };
  const pending = new Map<string, Pending>();
  const generating = new Set<string>();

  const watched = async (projectId: string, query: string): Promise<WatchedTask[]> => {
    const [work, members, team] = await Promise.all([workOf(projectId), membersOf(projectId), ctx.invoke('project.team.settings', { projectId }).catch(() => null)]);
    const prefix = team?.keyPrefix ?? keyPrefixOf(project(projectId).name), labels = db().allTaskLabels(), prs = db().prSummaries();
    const all: WatchedTask[] = work.tasks.items.map(t => ({
      id: t.id, key: `${prefix}-${t.seq ?? '?'}`, title: t.title, status: STATE[t.state], priority: PRIORITY[t.priority] ?? 'medium', assigneeLabel: ownerName(members, t), live: t.state === 'running', parentId: t.parentId ?? null,
      labels: labels[t.id] ?? [], pr: prs[t.id] ?? null, updatedAt: t.updatedAt, description: t.acceptance,
    }));
    return filterByQuery(all, query).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  };
  const cardView = async (c: ReturnType<WorkStore['summaryRows']>[number]): Promise<SummaryCard> => {
    const w = db(), latest = w.summaryRevision(c.id), revisions = w.summaryRevisions(c.id);
    let watching = 0; try { watching = (await watched(c.projectId, c.query)).length; } catch { watching = 0; }
    const base = c.lastRunAt ? Date.parse(c.lastRunAt) : Date.parse(c.createdAt);
    const nextRunAt = c.enabled && c.refresh === 'daily' ? new Date(base + DAY_MS).toISOString() : null;
    return { id: c.id, projectId: c.projectId, title: c.title, query: c.query, refresh: c.refresh, tokenCap: c.tokenCap, enabled: c.enabled, state: c.state, error: c.error, lastRunAt: c.lastRunAt, nextRunAt, rev: latest?.rev ?? null, text: latest?.text ?? '', revisions, createdAt: c.createdAt, watching };
  };
  const generate = async (cardId: string, force: boolean): Promise<'started' | 'unchanged'> => {
    const w = db(), card = w.summary(cardId);
    if (!card) throw new Error('That card no longer exists.');
    if (generating.has(cardId) || card.state === 'working') return 'started';
    const tasks = await watched(card.projectId, card.query), fp = fingerprintOf(tasks);
    if (!force && card.lastFingerprint === fp && w.summaryRevision(cardId)) { w.setSummaryState(cardId, { lastRunAt: new Date(now()).toISOString(), error: null }); emit(card.projectId, ['summaries']); armSummaries(); return 'unchanged'; }
    generating.add(cardId);
    try {
      const p = project(card.projectId), work = await workOf(card.projectId), previous = w.summaryRevision(cardId)?.text ?? null;
      const prompt = summaryPrompt({ project: p.name, goal: p.goal, title: card.title, query: card.query, tasks, activity: work.activity.items.map(a => a.summary), previous, tokenCap: card.tokenCap, now: new Date(now()) });
      const run = await startReadOnlyRun(ctx, { projectId: card.projectId, title: `Status card · ${card.title}`, prompt });
      w.setSummaryState(cardId, { state: 'working', error: null, lastChatId: run.chatId });
      pending.set(run.chatId, { kind: 'summary', cardId, projectId: card.projectId, fingerprint: fp, tasks: tasks.length });
      emit(card.projectId, ['summaries']);
      try { await sendPrompt(ctx, run.chatId, prompt); }
      catch (e) { pending.delete(run.chatId); w.setSummaryState(cardId, { state: 'failed', error: e instanceof Error ? e.message : String(e) }); emit(card.projectId, ['summaries']); }
      return 'started';
    } catch (e) {
      w.setSummaryState(cardId, { state: 'failed', error: e instanceof Error ? e.message : String(e) }); emit(card.projectId, ['summaries']);
      throw e;
    } finally { generating.delete(cardId); }
  };

  // Daily schedule: one timer per scheduled card, set only while one exists.
  const dailyTimers = new Map<string, unknown>();
  function armSummaries(): void {
    if (disposed || !store) return;
    const t = timers();
    for (const h of dailyTimers.values()) t.clear(h);
    dailyTimers.clear();
    for (const c of store.summaryRows()) {
      if (!c.enabled || c.refresh !== 'daily') continue;
      const due = (c.lastRunAt ? Date.parse(c.lastRunAt) : Date.parse(c.createdAt)) + DAY_MS, wait = Math.max(MIN_REARM_MS, due - now());
      dailyTimers.set(c.id, t.set(() => { dailyTimers.delete(c.id); void generate(c.id, false).catch(() => undefined).finally(() => armSummaries()); }, wait));
    }
  }
  // On change: task changes mark the project dirty; one debounced pass regenerates the cards whose watched tasks changed.
  const dirty = new Set<string>();
  let changeTimer: unknown;
  const markDirty = (projectId: string | undefined | null) => {
    if (!projectId || disposed || !existsSync(join(ctx.dataDir, 'muster-project-work.sqlite')) || !db().summaryRows(projectId).some(c => c.enabled && c.refresh === 'on_change')) return;
    dirty.add(projectId);
    if (changeTimer) return;
    changeTimer = timers().set(() => {
      changeTimer = undefined;
      const ids = [...dirty]; dirty.clear();
      for (const projectId of ids) for (const c of db().summaryRows(projectId)) if (c.enabled && c.refresh === 'on_change') void generate(c.id, false).catch(() => undefined);
    }, DEBOUNCE_MS);
  };

  // ── run settled ─────────────────────────────────────────────────────────────
  const DOC_BLOCK = /```muster-doc[^\n]*\n([\s\S]*?)```/g;
  async function settled(chat: Chat, status: string): Promise<void> {
    const job = pending.get(chat.id);
    if (job) {
      const w = db(), reply = latestAssistant(ctx, chat.id);
      pending.delete(chat.id);
      // Its answer lives on the card or the item; the helper chat itself would only clutter the sidebar and the Inbox.
      void ctx.invoke('chat.update', { id: chat.id, archived: true }).catch(() => undefined);
      if (job.kind === 'summary') {
        if (status === 'completed' && reply) { w.addSummaryRevision(job.cardId, capText(reply, w.summary(job.cardId)?.tokenCap ?? 600), job.fingerprint, job.tasks, chat.id); w.setSummaryState(job.cardId, { state: 'idle', error: null, lastRunAt: new Date(now()).toISOString(), lastFingerprint: job.fingerprint, lastChatId: null }); }
        else w.setSummaryState(job.cardId, { state: 'failed', error: status === 'completed' ? 'The agent finished without writing a summary.' : chat.error || 'The summary run did not finish.', lastChatId: null });
        emit(job.projectId, ['summaries']); armSummaries();
      } else {
        const rec: Recommendation = status === 'completed' && reply ? { state: 'ready', agent: job.agent, text: clip(reply, MAX_RECOMMENDATION), chatId: chat.id, at: new Date(now()).toISOString() } : { state: 'failed', agent: job.agent, text: chat.error || 'The agent did not give a recommendation.', chatId: chat.id, at: new Date(now()).toISOString() };
        w.setRecommendation(job.itemId, rec); emit(job.projectId, ['inbox']);
      }
      return;
    }
    if (!chat.projectId) return;
    markDirty(chat.projectId);
    if (status !== 'completed') return;
    const reply = latestAssistant(ctx, chat.id);
    if (!reply || (!/\/pull\/\d/.test(reply) && !reply.includes('```muster-doc'))) return;
    const work = await workOf(chat.projectId).catch(() => null), task = work?.tasks.items.find(t => t.attempts.some(a => a.chatId === chat.id));
    if (!task) return;
    const urls = findPullRequests(reply);
    if (urls.length) await record(chat.projectId, task.id, urls, 'detected');
    const who = (task.owner.kind === 'agent' ? (await membersOf(chat.projectId)).find(m => m.id === task.owner.id)?.name : null) ?? 'Agent';
    for (const m of reply.matchAll(DOC_BLOCK)) {
      try {
        const raw = JSON.parse(m[1]!) as { key?: unknown; text?: unknown; note?: unknown };
        if (typeof raw.text !== 'string') throw new Error('A muster-doc block needs a text field.');
        saveDoc(chat.projectId, task.id, docKey(raw.key), raw.text, text(raw.note, 'Note', 200, false) || 'Written by the agent', who);
      } catch (e) { ctx.store.appendItem(chat.id, 'notice', `A muster-doc block was ignored: ${e instanceof Error ? e.message : 'unreadable'}`, 'completed', { kind: 'work-doc' }); }
    }
  }
  // G18: a task's run is told the chain of goals its work serves (the task's goal, else its owner's), from the top.
  const offGoals = ctx.hooks.addPromptContributor(async ({ chat }) => {
    if (!chat.projectId || (!store && !existsSync(join(ctx.dataDir, 'muster-project-work.sqlite')))) return null;
    const w = db();
    if (!w.hasGoalLinks()) return null;
    const work = await workOf(chat.projectId).catch(() => null), task = work?.tasks.items.find(t => t.runChatId === chat.id || t.attempts.some(a => a.chatId === chat.id));
    if (!task) return null;
    const own = w.goalOf('task', task.id), viaAgent = task.owner.kind === 'agent' ? w.goalOf('agent', task.owner.id) : null, goalId = own ?? viaAgent;
    if (!goalId) return null;
    const chain = goalAncestry(w.goals(chat.projectId), goalId);
    return chain.length ? { label: 'Goals', text: `This work serves the goal “${chain.at(-1)}”${own ? '' : ` (the goal of its owner)`}. Why it matters, from the top: ${chain.join(' › ')}.` } : null;
  });
  const offSettled = ctx.hooks.onRunSettled(({ chat, status }) => settled(chat, status).catch(() => undefined));
  const offCommand = ctx.hooks.onCommand?.(({ command, input }) => {
    if (command === 'project.delete' && typeof input.id === 'string' && (store || existsSync(join(ctx.dataDir, 'muster-project-work.sqlite')))) { db().deleteProject(input.id); return; }
    if (command === 'project.tasks.delete' && typeof input.id === 'string' && (store || existsSync(join(ctx.dataDir, 'muster-project-work.sqlite')))) db().forgetTask(input.id);
    if (/^project\.tasks\.(add|edit|setState|verify|dispatch|delete|stop)$/.test(command) || /^paperclip\.task\.(create|update|start)$/.test(command)) markDirty(typeof input.projectId === 'string' ? input.projectId : undefined);
  });
  // After startup, only if the file already exists and a card is scheduled: open it, fail cards a quit left working, set the timers.
  const boot = setTimeout(() => { if (disposed || !existsSync(join(ctx.dataDir, 'muster-project-work.sqlite'))) return; try { if (db().hasScheduledSummaries()) armSummaries(); } catch { /* the file is read again when asked */ } }, 4000);
  boot.unref?.();

  const handlers: Record<string, DomainHandler> = {
    'work.overlay': () => overlay(),
    'work.project.meta': i => { project(i.projectId); return db().projectMeta(i.projectId as string); },
    'work.project.meta.set': i => {
      const p = project(i.projectId), patch: { status?: (typeof PROJECT_STATUSES)[number]; targetDate?: string | null } = {};
      if (i.status !== undefined) { if (!PROJECT_STATUSES.includes(i.status as never)) throw new Error('Choose a project status.'); patch.status = i.status as never; }
      if (i.targetDate !== undefined) patch.targetDate = dateOnly(i.targetDate, 'The target date');
      const meta = db().setProjectMeta(p.id, patch);
      emit(p.id, ['meta']); ctx.emitSnapshot();
      return meta;
    },
    'work.star.set': i => {
      const kind = i.kind, ref = id(i.id), patch = { ...(typeof i.starred === 'boolean' ? { starred: i.starred } : {}), ...(typeof i.hidden === 'boolean' ? { hidden: i.hidden } : {}) };
      let out: { starred: boolean; hidden: boolean };
      if (kind === 'project') { project(ref); const m = db().setProjectMeta(ref, patch); out = { starred: m.starred, hidden: m.hidden }; }
      else if (kind === 'agent') out = db().setAgentMeta(ref, patch);
      else throw new Error('Star a project or an agent.');
      emit(kind === 'project' ? ref : null, ['meta']);
      return out;
    },

    'work.labels.list': i => { project(i.projectId); return { labels: db().labels(i.projectId as string) }; },
    'work.labels.save': i => {
      const p = project(i.projectId), name = text(i.name, 'The label name', 40);
      if (!LABEL_COLORS.includes(i.color as LabelColor)) throw new Error('Choose a label colour.');
      if (!i.id && db().labels(p.id).length >= MAX_LABELS) throw new Error(`A project holds up to ${MAX_LABELS} labels.`);
      const label = db().saveLabel(p.id, { ...(i.id ? { id: id(i.id) } : {}), name, color: i.color as LabelColor });
      emit(p.id, ['labels']); return label;
    },
    'work.labels.remove': i => { const p = project(i.projectId); db().removeLabel(p.id, id(i.id)); emit(p.id, ['labels']); return { removed: true as const }; },
    'work.task.labels.set': async i => {
      const p = project(i.projectId), task = await taskOf(p.id, i.taskId);
      const ids = Array.isArray(i.labelIds) ? i.labelIds.map(x => id(x, 'label')) : [];
      if (ids.length > 12) throw new Error('A task carries up to 12 labels.');
      const known = new Set(db().labels(p.id).map(l => l.id));
      if (ids.some(x => !known.has(x))) throw new Error('One of those labels is not in this project.');
      const labels = db().setTaskLabels(task.id, ids);
      emit(p.id, ['labels']); return { labels };
    },

    'work.goals.list': i => { project(i.projectId); return goalView(i.projectId as string); },
    'work.goals.save': async i => {
      const level = i.level as GoalLevel, workspace = level === 'workspace';
      if (!GOAL_LEVELS.includes(level)) throw new Error('Choose a goal level.');
      const p = project(i.projectId), title = text(i.title, 'The goal title', 200), status = (i.status ?? 'active') as GoalStatus;
      if (!GOAL_STATUSES.includes(status)) throw new Error('Choose a goal status.');
      const existing = i.id ? db().goal(id(i.id)) : undefined;
      if (i.id && !existing) throw new Error('That goal no longer exists.');
      if (existing && (existing.projectId === null) !== workspace) throw new Error('A goal cannot move between the workspace and a project.');
      if (existing && existing.projectId !== null && existing.projectId !== p.id) throw new Error('That goal belongs to another project.');
      const parentId = typeof i.parentId === 'string' && i.parentId ? id(i.parentId, 'parent goal') : null;
      if (parentId) { const parent = db().goal(parentId); if (!parent || (parent.projectId !== null && parent.projectId !== p.id)) throw new Error('The parent goal is not in this project.'); if (workspace && parent.projectId !== null) throw new Error('A workspace goal sits under another workspace goal.'); }
      if (existing && !goalParentOk(db().goals(p.id), existing.id, parentId)) throw new Error('A goal cannot sit under itself or one of its own sub-goals.');
      const owner = typeof i.ownerMemberId === 'string' && i.ownerMemberId ? id(i.ownerMemberId, 'owner') : null;
      if (owner && !(await membersOf(p.id)).some(m => m.id === owner && !m.revokedAt)) throw new Error('That owner is not on this project.');
      const goal: Goal = db().saveGoal({ ...(existing ? { id: existing.id } : {}), projectId: workspace ? null : p.id, parentId, level, title, description: text(i.description, 'The description', 4000, false), status, ownerMemberId: owner, targetDate: dateOnly(i.targetDate, 'The target date') });
      emit(p.id, ['goals']); return goal;
    },
    'work.goals.remove': i => {
      const p = project(i.projectId), goal = db().goal(id(i.id));
      if (!goal) return { removed: true as const };
      if (goal.projectId === null && (i as { workspace?: unknown }).workspace !== true) throw new Error('This is a workspace goal. Remove it from a workspace goal context.');
      if (goal.projectId !== null && goal.projectId !== p.id) throw new Error('That goal belongs to another project.');
      db().removeGoal(goal.id); emit(p.id, ['goals']); return { removed: true as const };
    },
    'work.goals.link': async i => {
      const p = project(i.projectId), kind = i.kind, ref = id(i.refId, 'target');
      if (kind !== 'task' && kind !== 'agent') throw new Error('Link a task or an agent.');
      if (kind === 'task') await taskOf(p.id, ref); else if (!(await membersOf(p.id)).some(m => m.id === ref && m.kind === 'agent')) throw new Error('That agent is not on this project.');
      let goalId: string | null = null;
      if (typeof i.goalId === 'string' && i.goalId) { goalId = id(i.goalId, 'goal'); const g = db().goal(goalId); if (!g || (g.projectId !== null && g.projectId !== p.id)) throw new Error('That goal is not in this project.'); }
      db().linkGoal(kind, ref, goalId); emit(p.id, ['goals']); return { ok: true as const };
    },

    'work.docs.list': async i => { const p = project(i.projectId); await taskOf(p.id, i.taskId); return { docs: db().docs(i.taskId as string) }; },
    'work.docs.get': async i => { const p = project(i.projectId); await taskOf(p.id, i.taskId); return docView(i.taskId as string, docKey(i.key), typeof i.rev === 'number' ? i.rev : undefined); },
    'work.docs.save': async i => {
      const p = project(i.projectId), task = await taskOf(p.id, i.taskId);
      if (typeof i.text !== 'string') throw new Error('Write the document text.');
      return saveDoc(p.id, task.id, docKey(i.key), i.text, text(i.note, 'The note', 200, false), 'You', typeof i.baseRev === 'number' ? i.baseRev : undefined);
    },
    'work.docs.restore': async i => {
      const p = project(i.projectId), task = await taskOf(p.id, i.taskId), key = docKey(i.key), old = db().docRev(task.id, key, Number(i.rev));
      if (!old) throw new Error('That revision no longer exists.');
      return saveDoc(p.id, task.id, key, old.text, `Restored revision ${old.rev}`, 'You');
    },
    'work.docs.remove': async i => { const p = project(i.projectId), task = await taskOf(p.id, i.taskId); db().removeDoc(task.id, docKey(i.key)); emit(p.id, ['docs']); return { removed: true as const }; },
    'work.docs.thread.add': async i => {
      const p = project(i.projectId), task = await taskOf(p.id, i.taskId), key = docKey(i.key), rev = db().docRev(task.id, key, Number(i.rev));
      if (!rev) throw new Error('That revision no longer exists.');
      const start = Number(i.start), end = Number(i.end), quote = text(i.quote, 'The selection', 600), body = text(i.body, 'The comment', 4000);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > rev.text.length || rev.text.slice(start, end) !== quote) throw new Error('That selection does not match the document. Select the text again.');
      const threadId = db().addThread(task.id, key, rev.rev, quote, start, end, 'You', 'user', body);
      await wakeOwner(task.id, `On the “${key}” document, about “${clip(quote, 160)}”: ${body}`);
      emit(p.id, ['docs']); return db().thread(threadId, db().docRev(task.id, key)!.text) as DocThread;
    },
    'work.docs.thread.reply': async i => {
      const p = project(i.projectId), task = await taskOf(p.id, i.taskId), key = docKey(i.key), t = db().threadRow(id(i.threadId, 'thread'));
      if (!t || t.taskId !== task.id || t.key !== key) throw new Error('That thread no longer exists.');
      const body = text(i.body, 'The reply', 4000);
      db().addThreadComment(i.threadId as string, 'You', 'user', body); db().setThreadStatus(i.threadId as string, 'open');
      await wakeOwner(task.id, `Reply on the “${key}” document: ${body}`);
      emit(p.id, ['docs']); return db().thread(i.threadId as string, db().docRev(task.id, key)?.text) as DocThread;
    },
    'work.docs.thread.resolve': async i => {
      const p = project(i.projectId), task = await taskOf(p.id, i.taskId), key = docKey(i.key), t = db().threadRow(id(i.threadId, 'thread'));
      if (!t || t.taskId !== task.id || t.key !== key) throw new Error('That thread no longer exists.');
      db().setThreadStatus(i.threadId as string, i.resolved === false ? 'open' : 'resolved'); emit(p.id, ['docs']);
      return db().thread(i.threadId as string, db().docRev(task.id, key)?.text) as DocThread;
    },

    'work.votes.set': async i => {
      const p = project(i.projectId), subject = i.subject as VoteSubject, subjectId = id(i.subjectId, 'subject');
      if (subject !== 'message' && subject !== 'document') throw new Error('Vote on a message or a document.');
      const taskId = typeof i.taskId === 'string' && i.taskId ? (await taskOf(p.id, i.taskId)).id : null;
      const vote = i.vote === null || i.vote === undefined ? null : i.vote as VoteKind;
      if (vote !== null && vote !== 'helpful' && vote !== 'needs_work') throw new Error('Vote helpful or needs work.');
      const v = db().setVote(p.id, subject, subjectId, taskId, vote, text(i.reason, 'The reason', MAX_VOTE_REASON, false), clip(typeof i.excerpt === 'string' ? i.excerpt : '', 300));
      emit(p.id, ['votes']); return { vote: v };
    },
    'work.votes.list': i => { const p = project(i.projectId); return { votes: db().votes(p.id, typeof i.taskId === 'string' ? i.taskId : undefined) }; },
    'work.votes.export': i => {
      const p = project(i.projectId), votes = db().votes(p.id);
      return { json: JSON.stringify({ project: p.name, exportedAt: new Date(now()).toISOString(), votes: votes.map(v => ({ at: v.createdAt, subject: v.subject, task: v.taskId, vote: v.vote, reason: v.reason, excerpt: v.excerpt })) }, null, 2), count: votes.length };
    },

    'work.outputs.state': i => {
      const p = project(i.projectId), w = db();
      return { states: w.outputStates(p.id), seenAt: w.outputsSeen(p.id), pullRequests: w.links(p.id).map(l => ({ id: `pr:${l.id}`, title: l.title || `${l.repo}#${l.number}`, detail: `${l.repo}#${l.number} · ${l.state}${l.draft ? ' (draft)' : ''} · ${l.checksSummary}`, url: l.url, taskId: l.taskId, state: l.state === 'merged' ? 'merged' : l.state, at: l.fetchedAt ?? l.createdAt })) };
    },
    'work.outputs.status': async i => {
      const p = project(i.projectId), status = i.status as OutputStatus, outputId = text(i.outputId, 'The output', 600);
      if (!OUTPUT_STATUSES.includes(status)) throw new Error('Choose a status.');
      const note = text(i.note, 'The note', 2000, false);
      if (status === 'changes_requested' && !note) throw new Error('Say what should change: the owner receives your note.');
      const owner = status === 'changes_requested' && typeof i.taskId === 'string' && i.taskId ? await taskOf(p.id, i.taskId) : null;
      const state = db().setOutputState(p.id, outputId, status, note, 'You');
      if (status === 'changes_requested' && typeof i.taskId === 'string' && i.taskId) await wakeOwner(owner!.id, `Changes requested on ${text(i.title, 'Title', 200, false) || 'an output'}: ${note}`);
      emit(p.id, ['outputs']); return state;
    },
    'work.outputs.seen': i => { const p = project(i.projectId); const seenAt = db().markOutputsSeen(p.id); emit(p.id, ['outputs']); return { seenAt }; },

    'work.links.list': i => { const p = project(i.projectId); return { links: db().links(p.id, typeof i.taskId === 'string' ? i.taskId : undefined) }; },
    'work.links.add': async i => {
      const p = project(i.projectId), task = await taskOf(p.id, i.taskId), found = findPullRequests(typeof i.url === 'string' ? i.url.trim() : '');
      if (found.length !== 1 || found[0]!.url !== (i.url as string).trim().replace(/\/+$/, '').replace(/[?#].*$/, '')) throw new Error('Paste a GitHub pull request link, like https://github.com/owner/repo/pull/12.');
      return (await record(p.id, task.id, found, 'manual'))[0]!;
    },
    'work.links.refresh': async i => {
      const p = project(i.projectId), w = db();
      const targets = typeof i.id === 'string' ? [w.link(i.id)].filter((l): l is ExternalObject => Boolean(l && l.projectId === p.id)) : w.links(p.id, typeof i.taskId === 'string' ? i.taskId : undefined);
      const links: ExternalObject[] = [];
      for (const l of targets) links.push(!i.id && l.fetchedAt && now() - Date.parse(l.fetchedAt) < 10_000 ? l : await refreshLink(l));
      emit(p.id, ['links', 'outputs']); return { links };
    },
    'work.links.scan': async i => {
      const p = project(i.projectId), task = await taskOf(p.id, i.taskId);
      const detail = await ctx.invoke('paperclip.task', { id: task.id });
      const urls = findPullRequests([detail.description, ...detail.comments.map(c => c.body)].join('\n'));
      const links = await record(p.id, task.id, urls, 'detected');
      void links; return { found: urls.length, links: db().links(p.id, task.id) };
    },
    'work.links.remove': i => { const p = project(i.projectId), l = db().link(id(i.id)); if (l && l.projectId === p.id) { db().removeLink(l.id); emit(p.id, ['links', 'outputs']); } return { removed: true as const }; },

    'work.inbox.state': () => ({ items: db().inbox() as InboxMeta[] }),
    'work.inbox.read': i => {
      const items = Array.isArray(i.items) ? i.items.slice(0, 500).map(x => ({ id: id((x as { id?: unknown }).id), at: text((x as { at?: unknown }).at, 'Time', 40) })) : [];
      db().markRead(items); emit(null, ['inbox']); return { ok: true as const };
    },
    'work.inbox.snooze': i => {
      const until = i.until === null || i.until === undefined ? null : text(i.until, 'Time', 40);
      if (until && (!Number.isFinite(Date.parse(until)) || Date.parse(until) <= now())) throw new Error('Choose a time in the future.');
      db().snooze(id(i.id), text(i.at, 'Time', 40), until); emit(null, ['inbox']); return { ok: true as const };
    },
    'work.inbox.decideBy': i => { db().setDecideBy(id(i.id), dateOnly(i.date, 'The decide-by date')); emit(null, ['inbox']); return { ok: true as const }; },
    'work.inbox.recommend': async i => {
      const itemId = id(i.id), p = project(i.projectId), title = text(i.title, 'The decision', 300), why = text(i.why, 'The reason', 2000, false);
      const prior = db().inboxItem(itemId)?.recommendation;
      if (prior?.state === 'working') return prior;
      let memberId = typeof i.memberId === 'string' && i.memberId ? id(i.memberId, 'agent') : null, taskLine = '';
      if (typeof i.taskId === 'string' && i.taskId) {
        const t = await taskOf(p.id, i.taskId);
        if (!memberId && t.owner.kind === 'agent' && t.owner.id !== 'agent') memberId = t.owner.id;
        taskLine = `\nThe task: ${t.title}\nAcceptance: ${clip(t.acceptance || '(none)', 600)}\nState: ${t.state}`;
      }
      const prompt = [`A decision is waiting for the project owner in the project “${p.name}”.`, `Decision: ${title}`, why ? `Why it needs them: ${why}` : '', taskLine, '', 'Give a short recommendation: your pick, the two or three reasons that matter most, and the main risk. Use only what you can read in the project. Do not change anything. Reply with the recommendation only.'].filter(Boolean).join('\n');
      const run = await startReadOnlyRun(ctx, { projectId: p.id, memberId, title: `Recommendation · ${title}`, prompt });
      const rec: Recommendation = { state: 'working', agent: run.agent, text: '', chatId: run.chatId, at: new Date(now()).toISOString() };
      db().setRecommendation(itemId, rec); pending.set(run.chatId, { kind: 'recommend', itemId, agent: run.agent, projectId: p.id });
      try { await sendPrompt(ctx, run.chatId, prompt); }
      catch (e) { pending.delete(run.chatId); const failed: Recommendation = { ...rec, state: 'failed', text: e instanceof Error ? e.message : String(e) }; db().setRecommendation(itemId, failed); emit(p.id, ['inbox']); return failed; }
      emit(p.id, ['inbox']); return rec;
    },

    'work.summaries.list': async i => { const p = project(i.projectId); return { cards: await Promise.all(db().summaryRows(p.id).map(cardView)) }; },
    'work.summaries.save': async i => {
      const p = project(i.projectId), title = text(i.title, 'The title', 80), query = text(i.query, 'The watched query', SUMMARY_LIMITS.maxQuery, false);
      const refresh = i.refresh as SummaryRefresh;
      if (refresh !== 'manual' && refresh !== 'daily' && refresh !== 'on_change') throw new Error('Choose when the card refreshes.');
      const cap = Math.round(Number(i.tokenCap));
      if (!Number.isFinite(cap) || cap < SUMMARY_LIMITS.minTokenCap || cap > SUMMARY_LIMITS.maxTokenCap) throw new Error(`The token cap is ${SUMMARY_LIMITS.minTokenCap} to ${SUMMARY_LIMITS.maxTokenCap}.`);
      if (!i.id && db().countSummaries(p.id) >= SUMMARY_LIMITS.maxCards) throw new Error(`A project holds up to ${SUMMARY_LIMITS.maxCards} status cards.`);
      if (i.id && db().summary(id(i.id))?.projectId !== p.id) throw new Error('That card no longer exists.');
      const cardId = db().saveSummary(p.id, { ...(i.id ? { id: id(i.id) } : {}), title, query, refresh, tokenCap: cap, enabled: i.enabled !== false });
      armSummaries(); emit(p.id, ['summaries']);
      return cardView(db().summary(cardId)!);
    },
    'work.summaries.remove': i => { const p = project(i.projectId), c = db().summary(id(i.id)); if (c && c.projectId === p.id) { db().removeSummary(c.id); armSummaries(); emit(p.id, ['summaries']); } return { removed: true as const }; },
    'work.summaries.refresh': async i => {
      const p = project(i.projectId), c = db().summary(id(i.id));
      if (!c || c.projectId !== p.id) throw new Error('That card no longer exists.');
      const status = await generate(c.id, i.force === true);
      return { status, card: await cardView(db().summary(c.id)!) };
    },
    'work.summaries.revision': i => { const p = project(i.projectId), c = db().summary(id(i.id)); if (!c || c.projectId !== p.id) throw new Error('That card no longer exists.'); const r = db().summaryRevision(c.id, Number(i.rev)); if (!r) throw new Error('That revision no longer exists.'); return r; },
  };
  return {
    handlers,
    dispose() { disposed = true; clearTimeout(boot); offSettled(); offCommand?.(); offGoals(); const t = timers(); for (const h of dailyTimers.values()) t.clear(h); dailyTimers.clear(); if (changeTimer) t.clear(changeTimer); store?.close(); store = undefined; },
  };
}
