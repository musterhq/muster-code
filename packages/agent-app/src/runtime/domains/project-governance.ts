/**
 * Projects domain, part three: governance and the run lifecycle (Wave 1 of the Paperclip-parity work, #117).
 * createProjectsDomain mounts these handlers, asks `gate()` before every dispatch, folds `taskLines()` and `runOptions()`
 * into every task run, and forwards run-start and run-settle to `started()` and `settled()`.
 *
 * What lives here: wake reasons, heartbeat timers and the wake queue (C14, C30); subtree holds and hiding (G10); stop
 * variants (G33); run liveness, continuations, retries and recovery (G9); the every-run-comments backstop (C8);
 * review and approval execution policies (C16); watchdogs and monitors (C17); agent permissions (G12); tool policy
 * (G13); instruction bundles (G11); git identity (C12); project secrets (G23).
 *
 * Event-driven throughout: wakes, retries, monitors and heartbeats each hold a timer only while something is waiting.
 */
import { randomUUID } from 'node:crypto';
import type { Chat, ChatPermissionMode, TimelineItem } from '../../shared/protocol.ts';
import { keyPrefixOf, DEFAULT_AGENT_ID, LOCAL_OWNER_ID, type ProjectMember } from '../../shared/domains/project-team-protocol.ts';
import { clampPermission, type ProjectDetails, type ProjectTaskRecord, type TaskOwner, type TaskState } from '../../shared/domains/projects-protocol.ts';
import {
  BUNDLE_MAIN, BUNDLE_STANDARD, DEFAULT_CAPABILITIES, DEFAULT_GOVERNANCE, LEGACY_GOVERNANCE, DEFAULT_MAX_REVIEW_ROUNDS, MAX_TOOL_RULES, RUN_REASON_LABEL,
  type AgentCapabilities, type AgentGovernance, type AgentGovernanceView, type BundleFile, type Decision, type ExecutionPolicy, type GovernanceSettings, type GovernanceState, type HoldMode, type HoldRelease, type Liveness,
  type MonitorPolicy, type PolicyInput, type RecoveryAction, type RecoveryItem, type RunReason, type SecretProposal, type StopMode, type TaskHold, type TaskMonitor, type TaskStageState, type Watchdog, type WatchdogVerdict, type WakeRecord,
} from '../../shared/domains/project-governance-protocol.ts';
import { budgetUse } from '../../shared/domains/paperclip-protocol.ts';
import { redactSecrets } from '../secret-redaction.ts';
import { forgetLiterals, lendLiterals } from '../literal-redaction.ts';
import { activeSecretStore, SecretStore } from '../secret-store.ts';
import { isAdapterProvider } from '../adapters/index.ts';
import type { Actor, ProjectTask, ProjectTaskStore } from '../project-tasks.ts';
import { composeBundle, validateFile, checkBundle, changedNames } from '../governance/bundle.ts';
import { hireRequests, reviewVerdict, secretRequests, subtaskRequests, watchdogVerdict } from '../governance/blocks.ts';
import { envOverrides, validateIdentity } from '../governance/git-identity.ts';
import { classifyRun, commentRequiredPrompt, continuationPrompt, failureKind, retryDelayMs, type RunFacts } from '../governance/liveness.ts';
import { ProjectVault, validName, type VaultStore } from '../governance/secrets.ts';
import { clampHeartbeat, GovernanceStore } from '../governance/store.ts';
import { ancestorsOf, fingerprintOf, leavesOf, rootOf, subtreeIds, type TreeTask } from '../governance/subtree.ts';
import { actionOf, evaluateTool, normalizeRules, type ToolVerdict } from '../governance/tool-policy.ts';
import { leadReason, WakeQueue } from '../governance/wake-queue.ts';
import type { createProjectTeam } from './project-team.ts';
import type { DomainContext, DomainHandler, RunOptions } from './types.ts';

const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const id = (v: unknown, field = 'id'): string => { if (typeof v !== 'string' || !ID.test(v)) throw new Error(`Invalid ${field}.`); return v; };
const clip = (s: string, n: number) => { const f = s.replace(/\s+/g, ' ').trim(); return f.length > n ? `${f.slice(0, n - 1)}…` : f; };
const LIVE = new Set(['running', 'needs-input']);
const ACTIVE = new Set(['running', 'stopping']);
const DONE = new Set<TaskState>(['verified', 'cancelled']);
const TERMINAL_STATES = DONE;
const MAX_TIMER_MS = 2 ** 31 - 1;
const SECRET_PROPOSAL_TTL_MS = 7 * 86_400_000;
const REVIEW_TIMEOUT_NOTE = 'The reviewer ended without a verdict.';

export interface GovernanceDeps {
  tasks(): ProjectTaskStore;
  details(projectId: string): ProjectDetails;
  exists(projectId: string): boolean;
  team: ReturnType<typeof createProjectTeam>;
  dispatch(projectId: string, taskId: string, revision: number, trigger: 'user' | 'scheduler' | 'coordinator', folderId?: string, wake?: WakeInfo): Promise<{ chatId: string; runId: string }>;
  /** Tells the projects domain which trigger the next run in this chat has (attempt bookkeeping). */
  expectRun(chatId: string, trigger: 'user' | 'scheduler' | 'coordinator'): void;
  changed(projectId: string, taskId?: string, snapshot?: boolean): void;
  /** Secret store override (tests). Defaults to the runtime's open store. */
  secrets?: () => VaultStore;
  now?: () => number;
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
}
export interface WakeInfo { reason: RunReason; memberId?: string | null; note?: string | null; notes?: string[] }
/** Tests only: a fake clock and timers for waits that would otherwise take minutes (heartbeats, retries, monitors). Unset in the app. */
export const governanceClock: { now?: () => number; timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }; secrets?: () => VaultStore } = {};

export function createGovernance(ctx: DomainContext, deps: GovernanceDeps) {
  let store: GovernanceStore | undefined, queue: WakeQueue | undefined, vault: ProjectVault | undefined, disposed = false;
  const now = () => deps.now?.() ?? governanceClock.now?.() ?? Date.now();
  const timers = deps.timers ?? governanceClock.timers ?? { set: (fn: () => void, ms: number) => { const t = setTimeout(fn, Math.min(ms, MAX_TIMER_MS)); t.unref?.(); return t; }, clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  /** Once, at the first start after the update: every project that already exists keeps the old run behaviour. A fresh install has none, so nothing is opened. */
  function seedLegacy() {
    try {
      const d = ctx.db();
      if (d.prepare("SELECT 1 FROM meta WHERE key = 'governance_seeded'").get()) return;
      const rows = d.prepare('SELECT id FROM projects').all() as { id: string }[];
      if (rows.length) { const g = gov(); for (const r of rows) if (!g.hasSettings(r.id)) g.setSettings(r.id, LEGACY_GOVERNANCE); }
      d.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('governance_seeded', ?)").run(new Date(now()).toISOString());
    } catch { /* a bare test context has no meta table: the defaults apply */ }
  }
  const gov = () => store ??= Object.assign(new GovernanceStore(ctx.dataDir), { clock: now });
  const tasks = () => deps.tasks();
  const team = () => deps.team.store();
  const record = (projectId: string, kind: string, summary: string, refId: string | null = null, actor: Actor = 'system') => { tasks().record(projectId, kind, summary, refId, actor); };
  const secretStore = (): VaultStore => deps.secrets?.() ?? governanceClock.secrets?.() ?? activeSecretStore() ?? new SecretStore(ctx.dataDir);
  const theVault = () => vault ??= new ProjectVault(gov(), secretStore);

  seedLegacy();

  // ── names and lookups ───────────────────────────────────────────────────────
  const prefixOf = (projectId: string) => team().settings(projectId).keyPrefix ?? keyPrefixOf(deps.details(projectId).name);
  const keyOf = (t: Pick<ProjectTaskRecord, 'projectId' | 'seq'>) => `${prefixOf(t.projectId)}-${t.seq ?? '?'}`;
  const taskList = (projectId: string): ProjectTask[] => tasks().listTasks(projectId).items;
  const treeOf = (projectId: string): TreeTask[] => taskList(projectId);
  const memberOf = (projectId: string, memberId: string): ProjectMember | undefined => team().get(projectId, memberId);
  const nameOf = (projectId: string, memberId: string | null | undefined) => (memberId ? memberOf(projectId, memberId)?.name : null) ?? (memberId === LOCAL_OWNER_ID ? 'You' : 'Agent');
  const ownerMemberId = (t: Pick<ProjectTaskRecord, 'owner'>): string | null => t.owner.kind === 'agent' ? t.owner.id : null;
  const settings = (projectId: string): GovernanceSettings => gov().settings(projectId);
  const agentGov = (projectId: string, memberId: string): AgentGovernance => ({ ...gov().agent(projectId, memberId), secrets: memberOf(projectId, memberId)?.secrets ?? [] });
  const folderPathOf = (chat: Chat): string | null => { const f = chat.folderId ? ctx.store.folder(chat.folderId) : undefined; return f?.path ?? null; };
  const timeline = (chatId: string): TimelineItem[] => { try { return ctx.store.timeline(chatId); } catch { return []; } };

  // ── holds (G10) ─────────────────────────────────────────────────────────────
  /** The active hold covering a task: its own, or one on any ancestor. */
  type HoldInfo = { id: string; mode: HoldMode; rootKey: string; rootTitle: string; reason: string };
  /** The active holds of a project resolved once: a lookup walks a task's ancestors in a prebuilt map, so a pass over n tasks costs n steps, not n tree reads. */
  function holdIndex(projectId: string): (taskId: string) => HoldInfo | null {
    const active = gov().holds(projectId, 'active');
    if (!active.length) return () => null;
    const tree = treeOf(projectId), byId = new Map(tree.map(t => [t.id, t])), roots = new Map(active.map(h => [h.rootTaskId, h]));
    return taskId => {
      const seen = new Set<string>();
      for (let at: string | null | undefined = taskId; at && !seen.has(at); at = byId.get(at)?.parentId) {
        seen.add(at);
        const hit = roots.get(at);
        if (hit) { const root = byId.get(hit.rootTaskId); return { id: hit.id, mode: hit.mode, rootKey: root ? keyOf({ projectId, seq: root.seq }) : '', rootTitle: root?.title ?? '', reason: hit.reason }; }
      }
      return null;
    };
  }
  const holdFor = (t: Pick<ProjectTaskRecord, 'id' | 'projectId'>): HoldInfo | null => holdIndex(t.projectId)(t.id);
  const heldMessage = (h: NonNullable<ReturnType<typeof holdFor>>) => `Held: ${h.mode === 'cancel' ? 'cancelled' : 'paused'} with ${h.rootKey || 'its parent task'}${h.rootTitle ? ` “${clip(h.rootTitle, 60)}”` : ''}${h.reason ? ` (${clip(h.reason, 80)})` : ''}. Release the hold first.`;
  /** The reason a task may not start now, or null. Called by dispatch, the wake queue and the scheduler. */
  function gate(t: Pick<ProjectTaskRecord, 'id' | 'projectId'> & { owner?: TaskOwner }): string | null {
    const h = holdFor(t);
    if (h) return heldMessage(h);
    const full = t.owner ? t : tasks().getTask(t.id), mid = full?.owner ? ownerMemberId(full as ProjectTask) : null;
    if (mid) {
      // C15: an agent works on at most `maxConcurrent` tasks at once.
      const cap = agentGov(t.projectId, mid).heartbeat.maxConcurrent;
      if (cap > 0) { const reserved = [...reservations].filter(([task, who]) => task !== t.id && who === `${t.projectId}:${mid}`).length; const live = reserved + taskList(t.projectId).filter(x => x.id !== t.id && x.owner.kind === 'agent' && x.owner.id === mid && LIVE.has(x.state) && !reservations.has(x.id)).length; if (live >= cap) return `${nameOf(t.projectId, mid)} is already working on ${live} ${live === 1 ? 'task' : 'tasks'} (the limit is ${cap}). It can take another when one finishes.`; }
    }
    const b = budgetBlock.get(t.projectId);
    if (b) return b;
    return null;
  }
  // C28: at 100% of the project's monthly budget no new run starts. The spend is read at most once a minute, and again after each run.
  const budgetBlock = new Map<string, string>(), budgetAt = new Map<string, number>(), budgetDirty = new Set<string>(), budgetLater = new Set<unknown>();
  async function refreshBudget(projectId: string, force = false): Promise<void> {
    if (!force && !budgetDirty.has(projectId) && now() - (budgetAt.get(projectId) ?? 0) < 60_000) return;
    budgetDirty.delete(projectId);
    budgetAt.set(projectId, now());
    try {
      const t = team().settings(projectId);
      if (!settings(projectId).budgetHardStop || (!t.monthlyBudgetUsd && !t.monthlyBudgetTokens)) { budgetBlock.delete(projectId); return; }
      const dash = await ctx.invoke('paperclip.dashboard', { projectId });
      const use = budgetUse({ usd: t.monthlyBudgetUsd, tokens: t.monthlyBudgetTokens ?? null }, { usd: dash.spend.usd, tokens: dash.spend.tokens });
      const open = gov().openBreaker(projectId, 'budget', projectId);
      if (use && use.ratio >= 1) {
        const fmt = (n: number) => use.unit === 'usd' ? `$${n.toFixed(2)}` : `${Math.round(n).toLocaleString('en-US')} tokens`;
        budgetBlock.set(projectId, `This project reached its monthly budget (${fmt(use.used)} of ${fmt(use.limit)}), so no new run starts. Raise the budget in the project's Budget tab to continue.`);
        if (!open) { gov().addBreaker({ projectId, kind: 'budget', subject: projectId, summary: `${deps.details(projectId).name} reached its monthly budget (${fmt(use.used)} of ${fmt(use.limit)}). New runs are blocked; running work finishes.`, evidence: [] }); record(projectId, 'task.breaker', `Monthly budget reached: new runs are blocked until the budget is raised.`, null, 'system'); deps.changed(projectId); }
      } else { budgetBlock.delete(projectId); if (open) { gov().setBreakerState(open.id, 'resumed'); deps.changed(projectId); } }
    } catch { /* an unreadable spend never blocks work */ }
  }
  // C15: a start that passed its checks holds a place until its dispatch finishes, so two starts racing through the awaits cannot both take the last slot.
  const reservations = new Map<string, string>();
  /** Before every dispatch: holds, per-agent concurrency and the budget stop. A start that passes holds its slot until `release`. */
  async function preflight(t: ProjectTask): Promise<string | null> {
    await refreshBudget(t.projectId);
    const blocked = gate(t);
    if (!blocked && t.owner.kind === 'agent') reservations.set(t.id, `${t.projectId}:${t.owner.id}`);
    return blocked;
  }
  const release = (taskId: string) => { reservations.delete(taskId); };
  /** The scheduler asks once per candidate task: the index is shared for a second instead of rebuilt each time. */
  const heldMemo = new Map<string, { at: number; fn: (id: string) => HoldInfo | null }>();
  const held = (t: ProjectTask): boolean => {
    let m = heldMemo.get(t.projectId);
    if (!m || now() - m.at > 1000) { m = { at: now(), fn: holdIndex(t.projectId) }; heldMemo.set(t.projectId, m); }
    return Boolean(m.fn(t.id));
  };
  const projectHold = (projectId: string): string | null => {
    const s = tasks().schedule(projectId);
    if (s.paused) return 'This project is paused. Resume it first.';
    if (tasks().isSuspended(projectId)) return 'This project is archived.';
    return null;
  };

  // ── runs: facts, resume, meta ───────────────────────────────────────────────
  interface Facts extends RunFacts { tools: Map<string, number>; files: string[]; askedYou: boolean }
  /** What the run did: tool items since the last prompt, and the final assistant message. */
  function factsOf(chat: Chat, status: RunFacts['status']): Facts {
    const items = timeline(chat.id);
    let from = -1;
    for (let i = items.length - 1; i >= 0; i--) if (items[i]!.kind === 'user') { from = i; break; }
    const run = items.slice(from + 1), tools = new Map<string, number>(), files: string[] = [];
    let fileChanges = 0, toolCalls = 0;
    for (const it of run) {
      if (it.kind !== 'tool') continue;
      toolCalls++;
      const type = String(it.data?.type ?? ''), name = type === 'commandExecution' ? 'shell' : type === 'mcpToolCall' ? 'connector' : type || 'tool';
      tools.set(name, (tools.get(name) ?? 0) + 1);
      if (type === 'fileChange') {
        fileChanges++;
        const changes = it.data?.changes;
        if (Array.isArray(changes)) for (const c of changes as { path?: unknown }[]) if (typeof c?.path === 'string' && files.length < 40) files.push(c.path);
      }
    }
    const last = [...run].reverse().find(i => i.kind === 'assistant' && i.text.trim());
    return { status, error: chat.error, assistantText: last?.text ?? '', toolCalls, fileChanges, tools, files, askedYou: run.some(i => i.kind === 'question') };
  }

  const pendingMeta = new Map<string, WakeInfo & { taskId: string; memberId: string | null }>();
  /** Called by dispatch once the run chat exists and before its first message: records why the run starts. */
  function beforeSend(projectId: string, chatId: string, task: ProjectTask, wake: WakeInfo | undefined, trigger: 'user' | 'scheduler' | 'coordinator'): void {
    const reason: RunReason = wake?.reason ?? (trigger === 'user' ? 'user' : trigger === 'coordinator' ? 'assignment' : 'automation');
    const note = wake?.notes?.length ? wake.notes.join('\n') : wake?.note ?? null;
    gov().upsertRunMeta(projectId, chatId, { taskId: task.id, memberId: wake?.memberId ?? ownerMemberId(task), reason, note: note ? redactSecrets(note).slice(0, 500) : null, liveness: null, comment: null, settledAt: null, pendingAt: null });
    pendingMeta.set(chatId, { ...wake, reason, taskId: task.id, memberId: wake?.memberId ?? ownerMemberId(task) });
  }
  const runReasonOf = (chatId: string): RunReason | null => gov().runMeta(chatId)?.reason ?? null;

  /** Continues a settled task in its own chat: running again, with a prompt. Throws a sentence when it cannot. */
  async function resume(task: ProjectTask, chatId: string, prompt: string, reason: RunReason, say: string, patch: { continuations?: number; retries?: number; comment?: 'asked' } = {}): Promise<void> {
    // A paused or archived project starts nothing, follow-ups included.
    const frozen = projectHold(task.projectId); if (frozen) throw new Error(frozen);
    const blocked = gate(task); if (blocked) throw new Error(blocked);
    const mid = ownerMemberId(task), m = mid ? memberOf(task.projectId, mid) : undefined;
    if (m?.pausedAt) throw new Error(`${m.name} is paused.`);
    tasks().resumeRun({ projectId: task.projectId, id: task.id, chatId, note: say });
    gov().upsertRunMeta(task.projectId, chatId, { reason, settledAt: null, pendingAt: null, liveness: null, ...patch });
    pendingMeta.set(chatId, { reason, taskId: task.id, memberId: mid });
    deps.expectRun(chatId, 'scheduler');
    deps.changed(task.projectId, task.id);
    try { await ctx.invoke('chat.send', { id: chatId, text: prompt, requestId: randomUUID() }); }
    catch (err) {
      pendingMeta.delete(chatId);
      const why = err instanceof Error ? err.message : 'The follow-up could not be sent.';
      const fresh = tasks().getTask(task.id);
      if (fresh && LIVE.has(fresh.state)) tasks().setState({ projectId: task.projectId, id: task.id, revision: fresh.revision, state: 'blocked', reason: why }, 'system');
      deps.changed(task.projectId, task.id);
      throw err;
    }
  }

  // ── wake queue and heartbeats (C14, C30) ────────────────────────────────────
  const wakeQueue = (): WakeQueue => queue ??= new WakeQueue({
    store: gov(), now, setTimer: timers.set, clearTimer: timers.clear,
    settings, heartbeat: (p, m) => agentGov(p, m).heartbeat,
    member: (p, m) => { const x = memberOf(p, m); return x ? { name: x.name, paused: Boolean(x.pausedAt), revoked: Boolean(x.revokedAt), pending: Boolean(x.pendingAt) } : undefined; },
    task: (p, t) => { const x = tasks().getTask(t); return x && x.projectId === p ? { state: x.state, held: gate(x), live: LIVE.has(x.state), title: x.title } : undefined; },
    projectHold,
    deliver: w => deliverWake(w),
    storm: w => tripStorm(w),
    changed: p => deps.changed(p),
  });
  /** Picks the task a task-less wake (timer, on demand) works on: the owner's highest-priority ready task. */
  function readyTaskFor(projectId: string, memberId: string): ProjectTask | undefined {
    const all = taskList(projectId), byId = new Map(all.map(t => [t.id, t])), heldOf = holdIndex(projectId);
    return all.filter(t => t.owner.kind === 'agent' && t.owner.id === memberId && (t.state === 'todo' || t.state === 'backlog' || t.state === 'failed') && t.dependencies.every(d => byId.get(d)?.state === 'verified') && !heldOf(t.id))
      .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt))[0];
  }
  async function deliverWake(w: { projectId: string; memberId: string; taskId: string | null; reason: RunReason; reasons: RunReason[]; notes: string[] }): Promise<{ chatId: string | null }> {
    let task = w.taskId ? tasks().getTask(w.taskId) : readyTaskFor(w.projectId, w.memberId);
    if (!task) throw new Error('This agent has no ready task, so there is nothing to start.');
    // Finished work that a comment, mention or decision reopens: back to todo, said in the thread.
    if ((task.state === 'implemented' || task.state === 'review') && ['comment', 'mention', 'decision', 'on_demand', 'review'].includes(w.reason)) {
      task = tasks().setState({ projectId: task.projectId, id: task.id, revision: task.revision, state: 'todo', reason: `${RUN_REASON_LABEL[w.reason]}: reopened for ${nameOf(w.projectId, w.memberId)}` }, 'system');
    }
    // A task owned by someone else is handed to the woken agent only when the wake targets that agent as the owner.
    if (ownerMemberId(task) !== w.memberId && w.memberId !== DEFAULT_AGENT_ID) throw new Error(`${nameOf(w.projectId, w.memberId)} does not own this task.`);
    const run = await deps.dispatch(w.projectId, task.id, task.revision, 'scheduler', undefined, { reason: w.reason, memberId: w.memberId, notes: w.notes });
    return { chatId: run.chatId };
  }
  /** The storm breaker: too many wakes in a minute. The agent is paused and the problem lands in the Inbox. */
  async function tripStorm(w: { projectId: string; memberId: string; count: number; perMinute: number }): Promise<void> {
    if (gov().openBreaker(w.projectId, 'wake_storm', w.memberId)) return;
    const name = nameOf(w.projectId, w.memberId), recent = gov().wakes(w.projectId, { limit: 12 }).filter(x => x.status === 'started');
    gov().addBreaker({ projectId: w.projectId, kind: 'wake_storm', subject: w.memberId, memberId: w.memberId, summary: `${w.count} wakes in a minute (limit ${w.perMinute}). ${name} was paused.`, evidence: recent.map(r => `${RUN_REASON_LABEL[r.reason]}${r.taskId ? ` · ${clip(tasks().getTask(r.taskId)?.title ?? '', 50)}` : ''} · ${r.createdAt}`) });
    record(w.projectId, 'task.breaker', `Wake storm: ${w.count} wakes in a minute. ${name} was paused until you resume it.`, w.memberId, 'system');
    try { await deps.team.handlers['project.members.pause']!({ projectId: w.projectId, id: w.memberId, paused: true }); } catch { /* the default agent has nothing to pause */ } arm(w.projectId, w.memberId);
  }

  const heartbeatTimers = new Map<string, unknown>();
  const hbKey = (p: string, m: string) => `${p}:${m}`;
  function disarm(projectId: string, memberId: string) { const k = hbKey(projectId, memberId), h = heartbeatTimers.get(k); if (h) timers.clear(h); heartbeatTimers.delete(k); }
  /** One timer per enabled agent. A tick starts a run only when the agent has ready work; an idle tick records itself and costs nothing. */
  /** A heartbeat only runs for an active, unpaused agent in a project that is neither archived nor missing. */
  const heartbeatEligible = (projectId: string, memberId: string): boolean => {
    if (!deps.exists(projectId) || tasks().isSuspended(projectId)) return false;
    const m = memberOf(projectId, memberId);
    return Boolean(m && m.kind === 'agent' && !m.revokedAt && !m.pendingAt && !m.pausedAt);
  };
  function arm(projectId: string, memberId: string) {
    disarm(projectId, memberId);
    if (disposed || !heartbeatEligible(projectId, memberId)) return;
    const hb = agentGov(projectId, memberId).heartbeat;
    if (!hb.enabled) return;
    heartbeatTimers.set(hbKey(projectId, memberId), timers.set(() => { heartbeatTimers.delete(hbKey(projectId, memberId)); void tick(projectId, memberId); }, hb.intervalSec * 1000));
  }
  async function tick(projectId: string, memberId: string) {
    if (disposed || !deps.exists(projectId)) return;
    try {
      if (!heartbeatEligible(projectId, memberId) || !agentGov(projectId, memberId).heartbeat.enabled) return;
      // Nothing ready, or the project is paused: the tick writes nothing and starts nothing (no row, no event, no tokens).
      if (projectHold(projectId)) return;
      const task = readyTaskFor(projectId, memberId);
      if (task) await wakeQueue().request({ projectId, memberId, taskId: task.id, reason: 'timer' });
    } catch { /* a tick never throws */ }
    finally { arm(projectId, memberId); } // re-arms only while the agent is still eligible
  }
  let armed = false;
  /** Arms the timers of every enabled agent, once, the first time governance is used. */
  function armAll() {
    if (armed || disposed) return; armed = true;
    for (const a of gov().heartbeatAgents()) arm(a.projectId, a.memberId);
    armMonitors();
  }

  // ── stop variants (G33) ─────────────────────────────────────────────────────
  const stopIntent = new Map<string, StopMode | 'hold'>();
  async function stopTask(projectId: string, taskId: string, mode: StopMode): Promise<{ stopped: boolean; mode: StopMode }> {
    const task = tasks().assertTaskProject(projectId, taskId);
    if (!LIVE.has(task.state) || !task.runChatId) throw new Error('This task has no run to stop.');
    const chatId = task.runChatId;
    stopIntent.set(chatId, mode);
    try { await ctx.invoke('chat.stop', { id: chatId }); }
    catch (err) { stopIntent.delete(chatId); throw err; }
    return { stopped: true, mode };
  }
  /** Applies a stop variant once the run has settled. Returns true when it handled the task. */
  async function afterStop(task: ProjectTask, mode: StopMode): Promise<boolean> {
    const by = 'You';
    if (mode === 'keep') { record(task.projectId, 'task.stopped', `${by} stopped the run on “${task.title}”. It is Blocked until you resolve it.`, task.id, 'user'); return true; }
    if (mode === 'cancel') {
      tasks().setState({ projectId: task.projectId, id: task.id, revision: task.revision, state: 'cancelled', reason: 'Stopped and cancelled by you' }, 'user');
      record(task.projectId, 'task.stopped', `${by} stopped “${task.title}” and cancelled it.`, task.id, 'user');
      return true;
    }
    // Stop and mark done: the work goes through the gate (review policy, then your verification), never straight to Done.
    const fresh = tasks().getTask(task.id)!;
    const implemented = fresh.state === 'implemented' ? fresh : tasks().setState({ projectId: task.projectId, id: task.id, revision: fresh.revision, state: 'implemented', reason: 'Stopped and marked done by you' }, 'user');
    record(task.projectId, 'task.stopped', `${by} stopped “${task.title}” and marked it done: it goes through review before it is Done.`, task.id, 'user');
    await startStage(implemented);
    return true;
  }

  // ── subtree holds and hiding (G10) ──────────────────────────────────────────
  const activeRunsIn = (projectId: string, ids: ReadonlySet<string>): ProjectTask[] => taskList(projectId).filter(t => ids.has(t.id) && LIVE.has(t.state) && t.runChatId);
  const holdView = (h: ReturnType<GovernanceStore['holds']>[number]): TaskHold => {
    const tree = treeOf(h.projectId), root = tree.find(t => t.id === h.rootTaskId), ids = new Set(subtreeIds(tree, h.rootTaskId));
    return { id: h.id, projectId: h.projectId, rootTaskId: h.rootTaskId, rootKey: root ? keyOf({ projectId: h.projectId, seq: root.seq }) : '', rootTitle: root?.title ?? '(deleted task)', mode: h.mode, release: h.release, status: h.status, reason: h.reason, taskIds: h.status === 'active' ? [...ids] : h.taskIds, actor: h.actor, createdAt: h.createdAt, releasedAt: h.releasedAt, activeRuns: h.status === 'active' ? activeRunsIn(h.projectId, ids).length : 0 };
  };
  async function createHold(input: Record<string, unknown>): Promise<TaskHold> {
    const projectId = id(input.projectId, 'project id'), taskId = id(input.taskId, 'task id'), mode = input.mode === 'cancel' ? 'cancel' : input.mode === 'pause' ? 'pause' : (() => { throw new Error('Choose pause or cancel.'); })();
    // A cancel hold always stays until you restore or dismiss it: closing itself would make Restore impossible.
    const release: HoldRelease = mode === 'pause' && input.release === 'after-runs' ? 'after-runs' : 'manual';
    const root = tasks().assertTaskProject(projectId, taskId), tree = treeOf(projectId), ids = subtreeIds(tree, taskId), idSet = new Set(ids);
    if (gov().holds(projectId, 'active').some(h => h.rootTaskId === taskId)) throw new Error('This task already has an active hold.');
    const key = keyOf(root);
    if (mode === 'cancel') { const typed = typeof input.confirm === 'string' ? input.confirm.trim().toLowerCase() : ''; if (typed !== key.toLowerCase() && typed !== root.title.trim().toLowerCase()) throw new Error(`Type ${key} to confirm cancelling this task and everything under it.`); }
    const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 300) : '';
    const restore: Record<string, string> = {};
    for (const t of taskList(projectId)) if (idSet.has(t.id)) restore[t.id] = t.state;
    const holdId = gov().createHold({ projectId, rootTaskId: taskId, mode, release, reason, taskIds: ids, restore, actor: 'You' });
    wakeQueue().cancelFor(projectId, idSet, `Dropped: ${key} is on hold.`);
    const running = activeRunsIn(projectId, idSet);
    // Pause: nothing under the task starts and its running work stops. Cancel: the same, and every open task is cancelled (the snapshot lets Restore undo it).
    let stopped = 0;
    for (const t of running) { try { stopIntent.set(t.runChatId!, 'hold'); await ctx.invoke('chat.stop', { id: t.runChatId! }); stopped++; } catch { stopIntent.delete(t.runChatId!); } }
    if (mode === 'cancel') {
      for (const t of taskList(projectId)) {
        if (!idSet.has(t.id) || DONE.has(t.state)) continue;
        try { tasks().setState({ projectId, id: t.id, revision: tasks().getTask(t.id)!.revision, state: 'cancelled', reason: `Cancelled with ${key}` }, 'user'); } catch { /* a task that raced is left as it is */ }
      }
    }
    record(projectId, 'task.hold', `${mode === 'cancel' ? 'Cancelled' : 'Paused'} ${key} “${clip(root.title, 60)}” and ${ids.length - 1} ${ids.length === 2 ? 'task' : 'tasks'} under it${stopped ? `; stopped ${stopped} running ${stopped === 1 ? 'run' : 'runs'}` : ''}${reason ? ` (${clip(reason, 80)})` : ''}.`, taskId, 'user');
    deps.changed(projectId, taskId);
    return holdView(gov().getHold(holdId)!);
  }
  /** Resume a pause hold, or restore a cancel hold. */
  function releaseHold(input: Record<string, unknown>): TaskHold {
    const projectId = id(input.projectId, 'project id'), h = gov().getHold(id(input.id, 'hold id'));
    if (!h || h.projectId !== projectId) throw new Error('That hold no longer exists.');
    if (h.status !== 'active') return holdView(h);
    const tree = treeOf(projectId), root = tree.find(t => t.id === h.rootTaskId), key = root ? keyOf({ projectId, seq: root.seq }) : 'the task';
    let restored = 0;
    if (h.mode === 'cancel') {
      for (const [taskId, state] of Object.entries(h.restore)) {
        const t = tasks().getTask(taskId);
        // Only tasks the hold itself cancelled go back; one you changed since is left alone.
        if (!t || t.state !== 'cancelled' || state === 'cancelled' || state === 'verified') continue;
        tasks().setState({ projectId, id: taskId, revision: t.revision, state: state === 'implemented' || state === 'review' || state === 'blocked' || state === 'failed' || state === 'backlog' ? state : 'todo', reason: `Restored with ${key}` }, 'user'); restored++;
      }
    }
    if (h.mode === 'pause') {
      // Runs the pause stopped were left blocked: put those tasks back to ready, so resuming really resumes them.
      for (const [taskId, state] of Object.entries(h.restore)) {
        const t = tasks().getTask(taskId);
        if ((state === 'running' || state === 'needs-input') && t && t.state === 'blocked') { tasks().setState({ projectId, id: taskId, revision: t.revision, state: 'todo', reason: `Resumed with ${key}` }, 'user'); restored++; }
      }
    }
    gov().setHoldStatus(h.id, h.mode === 'cancel' ? 'restored' : 'released');
    record(projectId, 'task.hold-released', h.mode === 'cancel' ? `Restored ${key}: ${restored} ${restored === 1 ? 'task' : 'tasks'} went back to where they were.` : `Resumed ${key} and the tasks under it${restored ? `; ${restored} stopped ${restored === 1 ? 'run is' : 'runs are'} ready to start again` : ''}.`, h.rootTaskId, 'user');
    deps.changed(projectId, h.rootTaskId);
    scheduleEval(projectId);
    return holdView(gov().getHold(h.id)!);
  }
  /** A hold with the "after runs" release closes itself when its last run settles. */
  function autoRelease(projectId: string) {
    for (const h of gov().holds(projectId, 'active')) {
      if (h.release !== 'after-runs') continue;
      const ids = new Set(subtreeIds(treeOf(projectId), h.rootTaskId));
      if (activeRunsIn(projectId, ids).length) continue;
      if (h.mode === 'pause') { gov().setHoldStatus(h.id, 'released'); record(projectId, 'task.hold-released', 'A pause hold ended on its own: the last run under it finished.', h.rootTaskId, 'system'); }
      else { gov().setHoldStatus(h.id, 'released'); record(projectId, 'task.hold-released', 'A cancel hold closed: every run under it has ended. The cancelled tasks stay cancelled.', h.rootTaskId, 'system'); }
      deps.changed(projectId, h.rootTaskId);
    }
  }

  // ── review and approval policy (C16) ────────────────────────────────────────
  const normalizePolicy = (input: PolicyInput | ExecutionPolicy | null | undefined, projectId: string): ExecutionPolicy | null => {
    if (!input) return null;
    if (!Array.isArray(input.stages) || input.stages.length > 4) throw new Error('A policy has up to 4 stages.');
    const stages = input.stages.map((s, i) => {
      if (s.kind !== 'review' && s.kind !== 'approval') throw new Error(`Stage ${i + 1} is a review or an approval.`);
      const a = s.approver;
      if (!a || (a.kind !== 'user' && a.kind !== 'agent')) throw new Error(`Stage ${i + 1} needs an approver.`);
      if (a.kind === 'agent') { const m = memberOf(projectId, id(a.memberId, 'approver')); if (!m || m.kind !== 'agent' || m.revokedAt || m.pendingAt) throw new Error(`The approver for stage ${i + 1} is not an active agent on this project.`); }
      return { id: `s${i + 1}`, kind: s.kind, approver: a.kind === 'user' ? { kind: 'user' as const } : { kind: 'agent' as const, memberId: a.memberId } };
    });
    if (!stages.length) return null;
    const rounds = (input as PolicyInput).maxReviewRounds ?? (input as ExecutionPolicy).maxReviewRounds ?? null;
    if (rounds !== null && (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 10)) throw new Error('Review rounds are 1 to 10.');
    return { stages, maxReviewRounds: rounds };
  };
  const effectivePolicy = (t: Pick<ProjectTaskRecord, 'id' | 'projectId'>): ExecutionPolicy | null => gov().policy(t.id) ?? settings(t.projectId).defaultPolicy;
  const stageNote = (p: ExecutionPolicy, i: number) => `${p.stages[i]!.kind === 'review' ? 'Review' : 'Approval'} ${i + 1} of ${p.stages.length}`;
  const stageApproverName = (projectId: string, a: ExecutionPolicy['stages'][number]['approver']) => a.kind === 'user' ? 'You' : nameOf(projectId, a.memberId);

  /** A finished task enters its policy: the first stage (or the one that asked for changes) waits for its approver. */
  /** An agent never approves its own work: a stage naming the task's owner comes to you instead. */
  function ownStage(task: ProjectTask, s: ExecutionPolicy['stages'][number]): { stage: ExecutionPolicy['stages'][number]; own: boolean } {
    return s.approver.kind === 'agent' && s.approver.memberId === ownerMemberId(task) ? { stage: { ...s, approver: { kind: 'user' } }, own: true } : { stage: s, own: false };
  }
  async function startStage(task: ProjectTask): Promise<void> {
    const policy = effectivePolicy(task);
    if (!policy?.stages.length) { gov().clearStage(task.id); return; }
    const prior = gov().stage(task.id);
    const index = prior && prior.status === 'changes_requested' ? Math.min(prior.stage, policy.stages.length - 1) : 0, { stage, own } = ownStage(task, policy.stages[index]!);
    const review = task.state === 'review' ? task : task.state === 'implemented' ? tasks().setState({ projectId: task.projectId, id: task.id, revision: task.revision, state: 'review', reason: `${stageNote(policy, index)} requested from ${stageApproverName(task.projectId, stage.approver)}` }, 'system') : task;
    const state: TaskStageState = { taskId: task.id, stage: index, stages: policy.stages.length, round: prior?.round ?? 0, status: stage.approver.kind === 'agent' ? 'reviewing' : 'awaiting', kind: stage.kind, approver: stage.approver, approverName: stageApproverName(task.projectId, stage.approver), reviewChatId: null, history: prior?.history ?? [], updatedAt: new Date(now()).toISOString(), feedback: own ? `${nameOf(task.projectId, ownerMemberId(task))} owns this task and cannot review their own work, so it comes to you.` : null };
    gov().setStage(task.projectId, state);
    record(task.projectId, 'task.stage', `${stageNote(policy, index)} requested from ${state.approverName} for “${clip(task.title, 60)}”.`, task.id, 'system');
    deps.changed(task.projectId, task.id);
    if (stage.approver.kind === 'agent') {
      try { await startAgentReview(review, state, stage.approver.memberId, policy); }
      catch (err) { gov().setStage(task.projectId, { ...state, status: 'escalated', feedback: `The reviewer could not start: ${err instanceof Error ? err.message : 'unknown error'}. You decide.` }); record(task.projectId, 'task.stage', `${state.approverName} could not review: ${err instanceof Error ? err.message : 'unknown error'}. It is waiting for you.`, task.id, 'system'); deps.changed(task.projectId, task.id); }
    }
  }
  /** A read-only chat for the reviewer agent, in the task's worktree. Its verdict is read from its final message. */
  async function startAgentReview(task: ProjectTask, state: TaskStageState, memberId: string, policy: ExecutionPolicy): Promise<void> {
    const frozen = projectHold(task.projectId); if (frozen) throw new Error(frozen);
    const reviewer = memberOf(task.projectId, memberId);
    if (!reviewer || reviewer.revokedAt || reviewer.pausedAt) throw new Error(`${reviewer?.name ?? 'The reviewer'} is not available.`);
    const prev = task.runChatId ? ctx.store.chat(task.runChatId) : undefined, folderId = prev?.folderId ?? deps.details(task.projectId).primaryFolderId;
    if (!folderId) throw new Error('The project has no folder to review in.');
    const chat = await ctx.invoke('chat.create', { folderId, projectId: task.projectId });
    if (reviewer.runner) await ctx.invoke('chat.selectProvider', { id: chat.id, providerId: reviewer.runner.providerId, model: reviewer.runner.model }).catch(() => undefined);
    const owner = ownerMemberId(task) ? nameOf(task.projectId, ownerMemberId(task)) : 'the owner';
    const last = prev ? [...timeline(prev.id)].reverse().find(i => i.kind === 'assistant' && i.text.trim())?.text ?? '' : '';
    const prompt = [`You are ${reviewer.name}${reviewer.title ? `, ${reviewer.title}` : ''}, reviewing work (${stageNote(policy, state.stage)}). You may read files; do not change anything.`, '', `Task: ${task.title}`, `Acceptance criteria:\n${task.acceptance || '(not specified)'}`, '', `${owner}'s report on the work:\n${clip(last, 3000) || '(no report)'}`, ...(state.history.length ? ['', 'Earlier decisions:', ...state.history.slice(-3).map(h => `- ${h.by}: ${h.decision === 'approved' ? 'approved' : 'asked for changes'}${h.note ? ` — ${clip(h.note, 200)}` : ''}`)] : []), '', 'Check the work against the acceptance criteria. Finish with exactly one fenced block:', '```muster-review', '{"decision":"approve","note":"what you checked"}', '```', 'or {"decision":"request_changes","note":"what must change"}. A request for changes needs a specific note.'].join('\n');
    await ctx.invoke('chat.update', { id: chat.id, title: `Review · ${task.title}`.slice(0, 256), mode: 'agent', draft: prompt });
    await ctx.invoke('chat.setPermissionMode', { id: chat.id, permissionMode: 'read-only' });
    gov().upsertRunMeta(task.projectId, chat.id, { taskId: task.id, memberId, reason: 'review', note: `${stageNote(policy, state.stage)} of ${task.id}` });
    gov().setStage(task.projectId, { ...state, reviewChatId: chat.id });
    await ctx.invoke('chat.send', { id: chat.id, text: prompt, requestId: randomUUID() });
  }
  /** Applies one decision. `by` is the approver's name; `human` resets the round counter. */
  async function decide(projectId: string, taskId: string, decision: Decision, rawNote: string, by: string, human: boolean): Promise<TaskStageState | null> {
    const task = tasks().assertTaskProject(projectId, taskId), state = gov().stage(taskId), policy = effectivePolicy(task);
    if (!state || !policy) throw new Error('This task is not waiting for a review or approval.');
    if (state.status === 'changes_requested' || state.status === 'approved') throw new Error('This task is not waiting for a decision.');
    if (task.state !== 'review' && task.state !== 'implemented') throw new Error('Only finished work can be reviewed.');
    const note = rawNote.trim().slice(0, 4000);
    if (decision === 'request_changes' && !note) throw new Error('Say what must change: the owner reads this note.');
    const at = new Date(now()).toISOString(), entry = { stage: state.stage, kind: state.kind, decision: decision === 'approve' ? 'approved' as const : 'changes_requested' as const, by, note, at, round: state.round + 1 };
    if (decision === 'request_changes') {
      let round = human ? 1 : state.round + 1;
      const max = policy.maxReviewRounds ?? DEFAULT_MAX_REVIEW_ROUNDS;
      const next = { ...gov().pushDecision(state, entry), round, status: 'changes_requested' as const, feedback: note, reviewChatId: null, updatedAt: at };
      const reopened = tasks().setState({ projectId, id: taskId, revision: task.revision, state: 'todo', reason: `Changes requested by ${by}` }, human ? 'user' : 'agent');
      gov().setStage(projectId, next);
      record(projectId, 'task.review-changes', `${by} asked for changes on “${clip(task.title, 60)}”: ${clip(note, 200)}`, taskId, human ? 'user' : 'agent');
      if (!human && round >= max) {
        // The reviewer and the owner have gone back and forth enough: it is your call now.
        gov().setStage(projectId, { ...next, status: 'escalated', feedback: `${round} rounds of changes with no agreement. ${note}` });
        tasks().setState({ projectId, id: taskId, revision: reopened.revision, state: 'review', reason: 'Escalated to you after repeated change requests' }, 'system');
        gov().addBreaker({ projectId, kind: 'review_loop', subject: taskId, summary: `${keyOf(task)} went ${round} rounds between ${by} and ${nameOf(projectId, ownerMemberId(task))}. It is waiting for you.`, evidence: next.history.slice(-5).map(h => `${h.by}: ${clip(h.note, 120)}`) });
        deps.changed(projectId, taskId); return gov().stage(taskId);
      }
      deps.changed(projectId, taskId);
      const owner = ownerMemberId(task);
      if (owner && agentGov(projectId, owner).heartbeat.wakeOnDecision) await wakeQueue().request({ projectId, memberId: owner, taskId, reason: 'decision', note: `${by} asked for changes: ${note}`, force: true });
      return gov().stage(taskId);
    }
    const policyStages = policy.stages.length, nextIndex = state.stage + 1;
    const approved = gov().pushDecision(state, entry);
    if (nextIndex < policyStages) {
      gov().setStage(projectId, { ...approved, stage: nextIndex, round: 0, status: 'awaiting', feedback: null, reviewChatId: null, updatedAt: at });
      record(projectId, 'task.review-approved', `${by} approved ${stageNote(policy, state.stage).toLowerCase()} for “${clip(task.title, 60)}”${note ? `: ${clip(note, 160)}` : ''}.`, taskId, human ? 'user' : 'agent');
      const refreshed = tasks().getTask(taskId)!;
      await startStageAt(refreshed, nextIndex, gov().stage(taskId)!);
      return gov().stage(taskId);
    }
    gov().setStage(projectId, { ...approved, status: 'approved', feedback: null, reviewChatId: null, updatedAt: at });
    record(projectId, 'task.review-approved', `${by} approved “${clip(task.title, 60)}”${note ? `: ${clip(note, 160)}` : ''}. Every stage is approved.`, taskId, human ? 'user' : 'agent');
    // The last approval is the verification: recorded as a review by the approver, with their note.
    await ctx.invoke('project.tasks.verify', { projectId, id: taskId, revision: tasks().getTask(taskId)!.revision, kind: 'review', notes: note || `Approved by ${by} (${policyStages} ${policyStages === 1 ? 'stage' : 'stages'}).`, reviewer: by });
    deps.changed(projectId, taskId);
    return gov().stage(taskId);
  }
  async function startStageAt(task: ProjectTask, index: number, state: TaskStageState): Promise<void> {
    const policy = effectivePolicy(task); if (!policy) return;
    const { stage, own } = ownStage(task, policy.stages[index]!);
    const next = { ...state, feedback: own ? `${nameOf(task.projectId, ownerMemberId(task))} owns this task and cannot review their own work, so it comes to you.` : null, stage: index, kind: stage.kind, approver: stage.approver, approverName: stageApproverName(task.projectId, stage.approver), status: stage.approver.kind === 'agent' ? 'reviewing' as const : 'awaiting' as const };
    gov().setStage(task.projectId, next);
    record(task.projectId, 'task.stage', `${stageNote(policy, index)} requested from ${next.approverName} for “${clip(task.title, 60)}”.`, task.id, 'system');
    deps.changed(task.projectId, task.id);
    if (stage.approver.kind === 'agent') await startAgentReview(task, next, stage.approver.memberId, policy).catch(err => { gov().setStage(task.projectId, { ...next, status: 'escalated', feedback: `The reviewer could not start: ${err instanceof Error ? err.message : 'unknown error'}. You decide.` }); deps.changed(task.projectId, task.id); });
  }
  /** The reviewer chat settled: read its verdict. No verdict hands the stage to you. */
  async function reviewSettled(chat: Chat, meta: { taskId: string | null; memberId: string | null }): Promise<void> {
    const projectId = chat.projectId!, taskId = meta.taskId; if (!taskId) return;
    const state = gov().stage(taskId); if (!state || state.reviewChatId !== chat.id || state.status !== 'reviewing') return;
    const text = [...timeline(chat.id)].reverse().find(i => i.kind === 'assistant' && i.text.trim())?.text ?? '', verdict = reviewVerdict(text), by = nameOf(projectId, meta.memberId);
    if (!verdict) { gov().setStage(projectId, { ...state, status: 'escalated', feedback: `${by}: ${REVIEW_TIMEOUT_NOTE} You decide.`, reviewChatId: chat.id }); record(projectId, 'task.stage', `${by} gave no verdict. It is waiting for you.`, taskId, 'system'); deps.changed(projectId, taskId); return; }
    try { await decide(projectId, taskId, verdict.decision, verdict.note, by, false); }
    catch (err) { gov().setStage(projectId, { ...state, status: 'escalated', feedback: `${by}'s verdict could not be applied: ${err instanceof Error ? err.message : 'error'}. You decide.` }); deps.changed(projectId, taskId); }
  }

  // ── watchdogs, monitors, recovery (C17, G9) ─────────────────────────────────
  const evalTimers = new Map<string, unknown>();
  /** Coalesces any number of triggers within 100 ms into one evaluation. */
  function scheduleEval(projectId: string) {
    if (disposed || evalTimers.has(projectId)) return;
    evalTimers.set(projectId, timers.set(() => { evalTimers.delete(projectId); void evaluateWatchdogs(projectId).catch(() => undefined); }, 100));
  }
  function pendingPath(projectId: string, ids: ReadonlySet<string>): boolean {
    if (gov().monitors(projectId).some(m => m.state === 'scheduled' && ids.has(m.taskId))) return true;
    if (gov().runsFor(projectId, { limit: 200 }).some(r => r.pendingAt && r.taskId && ids.has(r.taskId))) return true;
    return gov().wakes(projectId, { limit: 50 }).some(w => (w.status === 'throttled' || w.status === 'deferred') && w.taskId && ids.has(w.taskId));
  }
  /** One finding per distinct stopped state of a root task's subtree: every leaf has stopped, none is live, and something failed or is blocked. */
  async function evaluateWatchdogs(projectId: string): Promise<void> {
    if (!deps.exists(projectId)) return;
    const all = taskList(projectId), tree: TreeTask[] = all, byId = new Map(all.map(t => [t.id, t]));
    const roots = all.filter(t => !t.parentId && all.some(k => k.parentId === t.id));
    for (const root of roots) {
      const leaves = leavesOf(tree, root.id), ids = new Set(subtreeIds(tree, root.id));
      const stuck = leaves.filter(l => l.state === 'failed' || l.state === 'blocked');
      const live = leaves.some(l => LIVE.has(l.state) || l.state === 'review' || l.state === 'implemented');
      // A leaf that is ready to start is work waiting for its next run (yours or an automatic one), not a stop.
      const ready = leaves.some(l => l.state === 'todo' && (all.find(x => x.id === l.id)?.dependencies ?? []).every(d => byId.get(d)?.state === 'verified'));
      const open = gov().openWatchdogFor(root.id);
      if (!stuck.length || live || ready || pendingPath(projectId, ids) || holdFor(root)) { if (open && !stuck.length) gov().updateWatchdog(open.id, { state: 'dismissed', note: 'The subtree is moving again.' }); continue; }
      const fp = fingerprintOf(leaves);
      if (gov().watchdogSeen(root.id, fp)) continue;
      if (open) gov().updateWatchdog(open.id, { state: 'dismissed', note: 'Replaced by a newer stopped state.' });
      const summary = `${keyOf(root)} “${clip(root.title, 50)}” stopped: ${stuck.length} of ${leaves.length} ${leaves.length === 1 ? 'task' : 'tasks'} failed or blocked and nothing is running.`;
      const wid = gov().addWatchdog({ projectId, taskId: root.id, fingerprint: fp, summary, leaves: leaves.map(l => ({ id: l.id, key: keyOf({ projectId, seq: l.seq }), title: l.title, state: l.state })) });
      record(projectId, 'task.watchdog', summary, root.id, 'system');
      deps.changed(projectId, root.id);
      const agent = settings(projectId).watchdogAgentId;
      if (agent) await startWatchdogReview(wid, agent).catch(err => { record(projectId, 'task.watchdog', `The watchdog agent could not start: ${err instanceof Error ? err.message : 'error'}. Review it yourself.`, root.id, 'system'); });
      void byId;
    }
  }
  async function startWatchdogReview(watchdogId: string, memberId: string): Promise<Watchdog> {
    const w = gov().getWatchdog(watchdogId)!, projectId = w.projectId, m = memberOf(projectId, memberId);
    const frozen = projectHold(projectId); if (frozen) throw new Error(frozen);
    if (!m || m.revokedAt || m.pendingAt || m.pausedAt) throw new Error(`${m?.name ?? 'The watchdog agent'} is not available.`);
    const root = tasks().getTask(w.taskId)!, folderId = deps.details(projectId).primaryFolderId;
    if (!folderId) throw new Error('The project has no folder.');
    const chat = await ctx.invoke('chat.create', { folderId, projectId });
    if (m.runner) await ctx.invoke('chat.selectProvider', { id: chat.id, providerId: m.runner.providerId, model: m.runner.model }).catch(() => undefined);
    const lines = (w.leaves as { id: string; key: string; title: string; state: string }[]).map(l => { const t = tasks().getTask(l.id); return `- ${l.key} “${l.title}” [${l.state}]${t?.runError ? `: ${clip(t.runError, 200)}` : ''}`; });
    const prompt = [`You are ${m.name}, the watchdog for this project. Work on this subtree has stopped. Look at the evidence yourself (you may read files; do not change anything, and do not fix the work).`, '', `Root task: ${root.title}`, 'Stopped leaves:', ...lines, '', 'Decide one of: accept (the stop is fine or finished), reopen (the stopped tasks should run again), reassign (another agent should take them; name them). Finish with exactly one fenced block:', '```muster-watchdog', '{"verdict":"reopen","note":"why"}', '```'].join('\n');
    await ctx.invoke('chat.update', { id: chat.id, title: `Watchdog · ${root.title}`.slice(0, 256), mode: 'agent', draft: prompt });
    await ctx.invoke('chat.setPermissionMode', { id: chat.id, permissionMode: 'read-only' });
    gov().upsertRunMeta(projectId, chat.id, { taskId: w.taskId, memberId, reason: 'watchdog', note: watchdogId });
    gov().updateWatchdog(watchdogId, { state: 'reviewing', reviewChatId: chat.id, verdictBy: m.name });
    deps.changed(projectId, w.taskId);
    await ctx.invoke('chat.send', { id: chat.id, text: prompt, requestId: randomUUID() });
    return viewWatchdog(gov().getWatchdog(watchdogId)!);
  }
  const viewWatchdog = (w: NonNullable<ReturnType<GovernanceStore['getWatchdog']>>): Watchdog => {
    const t = tasks().getTask(w.taskId);
    return { id: w.id, projectId: w.projectId, taskId: w.taskId, key: t ? keyOf(t) : '', title: t?.title ?? '(deleted task)', fingerprint: w.fingerprint, state: w.state, summary: w.summary, leaves: w.leaves, verdictBy: w.verdictBy, note: w.note, createdAt: w.createdAt, resolvedAt: w.resolvedAt, reviewChatId: w.reviewChatId };
  };
  async function resolveWatchdog(projectId: string, watchdogId: string, verdict: WatchdogVerdict, note: string, reassignTo: string | null, by: string, actor: Actor): Promise<Watchdog> {
    const w = gov().getWatchdog(watchdogId);
    if (!w || w.projectId !== projectId) throw new Error('That finding no longer exists.');
    if (w.state !== 'open' && w.state !== 'reviewing') return viewWatchdog(w);
    const leaves = w.leaves as { id: string; title: string }[];
    let changedCount = 0;
    if (verdict === 'accept') { /* nothing to change: the finding is reviewed */ }
    else {
      let target: ProjectMember | undefined;
      if (verdict === 'reassign') {
        target = team().list(projectId).find(m => m.kind === 'agent' && !m.revokedAt && !m.pendingAt && (m.id === reassignTo || m.name.toLowerCase() === (reassignTo ?? '').toLowerCase()));
        if (!target) throw new Error('Choose an active agent to reassign to.');
      }
      for (const l of leaves) {
        const t = tasks().getTask(l.id);
        if (!t || (t.state !== 'failed' && t.state !== 'blocked')) continue;
        if (target) tasks().editTask({ projectId, id: t.id, revision: t.revision, patch: { owner: { kind: 'agent', id: target.id } } }, actor);
        const fresh = tasks().getTask(t.id)!;
        tasks().setState({ projectId, id: t.id, revision: fresh.revision, state: 'todo', reason: `${verdict === 'reopen' ? 'Reopened' : `Reassigned to ${target!.name}`} by the watchdog review` }, actor);
        changedCount++;
      }
    }
    gov().updateWatchdog(w.id, { state: verdict === 'accept' ? 'accepted' : verdict === 'reopen' ? 'reopened' : 'reassigned', verdictBy: by, note: note || null });
    record(projectId, 'task.watchdog', `${by} ${verdict === 'accept' ? 'accepted the stop' : verdict === 'reopen' ? `reopened ${changedCount} stopped ${changedCount === 1 ? 'task' : 'tasks'}` : `reassigned ${changedCount} stopped ${changedCount === 1 ? 'task' : 'tasks'}`} for ${keyOf(tasks().getTask(w.taskId) ?? { projectId, seq: null })}${note ? `: ${clip(note, 160)}` : ''}.`, w.taskId, actor);
    deps.changed(projectId, w.taskId);
    return viewWatchdog(gov().getWatchdog(w.id)!);
  }
  async function watchdogSettled(chat: Chat, meta: { taskId: string | null; memberId: string | null; note: string | null }): Promise<void> {
    const projectId = chat.projectId!, wid = meta.note, w = wid ? gov().getWatchdog(wid) : undefined;
    if (!w || w.state !== 'reviewing') return;
    const text = [...timeline(chat.id)].reverse().find(i => i.kind === 'assistant' && i.text.trim())?.text ?? '', v = watchdogVerdict(text), by = nameOf(projectId, meta.memberId);
    if (!v) { gov().updateWatchdog(w.id, { state: 'open', note: `${by} gave no verdict. You decide.` }); record(projectId, 'task.watchdog', `${by} gave no verdict on the stopped subtree. It is waiting for you.`, w.taskId, 'system'); deps.changed(projectId, w.taskId); return; }
    try { await resolveWatchdog(projectId, w.id, v.verdict, v.note, v.reassignTo, by, 'agent'); }
    catch (err) { gov().updateWatchdog(w.id, { state: 'open', note: `${by}'s verdict could not be applied: ${err instanceof Error ? err.message : 'error'}. You decide.` }); deps.changed(projectId, w.taskId); }
  }

  // Monitors: one timer, set for the earliest due check.
  let monitorTimer: unknown;
  function armMonitors() {
    if (monitorTimer) { timers.clear(monitorTimer); monitorTimer = undefined; }
    if (disposed) return;
    const next = gov().nextMonitorDue();
    if (!next) return;
    monitorTimer = timers.set(() => { monitorTimer = undefined; void fireMonitors(); }, Math.max(0, Date.parse(next.dueAt) - now()));
  }
  async function fireMonitors() {
    if (disposed) return;
    for (const m of gov().dueMonitors(new Date(now()).toISOString())) {
      try {
        const task = tasks().getTask(m.taskId);
        if (!task || DONE.has(task.state)) { gov().updateMonitor(m.id, { state: 'cleared' }); continue; }
        const attempts = m.attempts + 1, last = attempts >= m.maxAttempts || m.policy === 'escalate';
        const label = `${keyOf(task)} “${clip(task.title, 50)}”`;
        if (m.policy === 'wake_owner' && ownerMemberId(task)) {
          const r = await wakeQueue().request({ projectId: m.projectId, memberId: ownerMemberId(task)!, taskId: task.id, reason: 'monitor', note: m.note || `Follow-up check on ${label}.`, force: true });
          record(m.projectId, 'task.monitor', `Monitor on ${label} fired (${attempts} of ${m.maxAttempts}): ${r.status === 'started' ? 'woke the owner' : r.detail}`, task.id, 'system');
        } else if (m.policy === 'create_recovery_task') {
          const t = tasks().createTask({ projectId: m.projectId, title: `Check: ${task.title}`.slice(0, 500), acceptance: m.note || `Follow-up check on ${label}: find out why it has not finished and report.`, dependencies: [], owner: task.owner, parentId: task.id, priority: 1 }, 'system');
          record(m.projectId, 'task.monitor', `Monitor on ${label} fired (${attempts} of ${m.maxAttempts}): created recovery task ${keyOf(t)}.`, task.id, 'system');
        } else record(m.projectId, 'task.monitor', `Monitor on ${label} fired: it is waiting for you.`, task.id, 'system');
        if (last) gov().updateMonitor(m.id, { state: 'escalated', attempts, fired: true });
        else gov().updateMonitor(m.id, { attempts, fired: true, dueAt: new Date(now() + m.intervalMs * 2 ** (attempts - 1)).toISOString() });
        deps.changed(m.projectId, task.id);
      } catch { gov().updateMonitor(m.id, { state: 'escalated', fired: true }); }
    }
    armMonitors();
  }
  const monitorView = (m: ReturnType<GovernanceStore['getMonitor']> & object): TaskMonitor => { const t = tasks().getTask(m.taskId); return { id: m.id, projectId: m.projectId, taskId: m.taskId, key: t ? keyOf(t) : '', title: t?.title ?? '(deleted task)', dueAt: m.dueAt, policy: m.policy, attempts: m.attempts, maxAttempts: m.maxAttempts, note: m.note, state: m.state, createdAt: m.createdAt, lastFiredAt: m.lastFiredAt }; };

  // Recovery: what is stuck, computed when read (no polling), each with a way out.
  function recoveryItems(projectId: string): RecoveryItem[] {
    const out: RecoveryItem[] = [], all = taskList(projectId), holdAt = holdIndex(projectId);
    const runs = new Map(gov().runsFor(projectId, { limit: 300 }).map(r => [r.chatId, r]));
    const skip = (taskId: string, kind: string, since: string) => { const at = gov().recoveryDismissed(taskId, kind); return Boolean(at && at >= since); };
    for (const t of all) {
      const key = keyOf(t), meta = t.runChatId ? runs.get(t.runChatId) : undefined, hold = holdAt(t.id);
      if (LIVE.has(t.state) && t.runChatId) {
        const chat = ctx.store.chat(t.runChatId);
        if (chat && !ACTIVE.has(chat.status) && !meta?.pendingAt && chat.status !== 'queued' as never && !pendingMeta.has(chat.id) && Date.parse(t.updatedAt) < now() - 5_000 && !skip(t.id, 'orphaned_run', t.updatedAt))
          out.push({ id: `orphaned_run:${t.id}`, projectId, taskId: t.id, kind: 'orphaned_run', summary: `${key} is marked running but its run is no longer active.`, at: t.updatedAt, actions: ['rerun', 'block', 'cancel', 'dismiss'] });
      }
      if (t.state === 'todo' && t.owner.kind === 'agent') {
        const m = memberOf(projectId, t.owner.id);
        if (m && (m.revokedAt || (m.pendingAt && m.id !== DEFAULT_AGENT_ID)) && !skip(t.id, 'stranded_assignment', t.updatedAt)) out.push({ id: `stranded_assignment:${t.id}`, projectId, taskId: t.id, kind: 'stranded_assignment', summary: `${key} is assigned to ${m.name}, who ${m.revokedAt ? 'was removed' : 'is waiting for approval'}.`, at: t.updatedAt, actions: ['rerun', 'cancel', 'dismiss'] });
      }
      if (meta?.liveness === 'needs_followup' && t.state === 'blocked' && !skip(t.id, 'needs_followup', t.updatedAt)) out.push({ id: `needs_followup:${t.id}`, projectId, taskId: t.id, kind: 'needs_followup', summary: `${key}: ${t.runError ?? 'the agent ended its turns without doing the work'}`, at: t.updatedAt, actions: ['rerun', 'cancel', 'dismiss'] });
      if (meta?.pendingAt && Date.parse(meta.pendingAt) > now()) out.push({ id: `retry_waiting:${t.id}`, projectId, taskId: t.id, kind: 'retry_waiting', summary: `${key}: ${meta.note ?? 'a retry is waiting'}`, at: meta.pendingAt, actions: ['dismiss'] });
      if (hold) out.push({ id: `held:${t.id}`, projectId, taskId: t.id, kind: 'held', summary: `${key} is on hold: ${heldMessage(hold).replace(/^Held: /, '')}`, at: t.updatedAt, actions: ['resume'] });
    }
    // One "held" row per hold root is plenty.
    const seen = new Set<string>();
    return out.filter(i => { if (i.kind !== 'held') return true; const root = holdAt(i.taskId)?.id ?? i.taskId; if (seen.has(root)) return false; seen.add(root); return true; });
  }
  async function resolveRecovery(projectId: string, taskId: string, action: RecoveryAction): Promise<void> {
    const t = tasks().assertTaskProject(projectId, taskId);
    if (action === 'dismiss') { for (const k of ['orphaned_run', 'stranded_assignment', 'needs_followup']) gov().dismissRecovery(taskId, k); deps.changed(projectId, taskId); return; }
    if (action === 'resume') { const h = holdFor(t); if (!h) throw new Error('That task is not on hold.'); releaseHold({ projectId, id: h.id }); return; }
    if (action === 'cancel') { tasks().setState({ projectId, id: taskId, revision: t.revision, state: 'cancelled', reason: 'Cancelled from recovery' }, 'user'); deps.changed(projectId, taskId); return; }
    if (action === 'block') { tasks().setState({ projectId, id: taskId, revision: t.revision, state: 'blocked', reason: 'Marked blocked from recovery' }, 'user'); deps.changed(projectId, taskId); return; }
    // rerun: back to a startable state, then wake the owner on the usual path.
    let cur = t;
    if (LIVE.has(cur.state)) { if (cur.runChatId && ACTIVE.has(ctx.store.chat(cur.runChatId)?.status ?? '')) throw new Error('The run is still active. Stop it first.'); }
    if (cur.state !== 'todo' && cur.state !== 'backlog') cur = tasks().setState({ projectId, id: taskId, revision: cur.revision, state: 'todo', reason: 'Re-run from recovery' }, 'user');
    gov().clearRecoveryDismissals(taskId);
    const owner = ownerMemberId(cur);
    if (!owner) { deps.changed(projectId, taskId); return; }
    const m = memberOf(projectId, owner);
    if (m && (m.revokedAt)) throw new Error(`${m.name} was removed. Assign the task to an active agent first.`);
    const rec = await wakeQueue().request({ projectId, memberId: owner, taskId, reason: 'recovery', force: true });
    if (rec.status === 'refused') throw new Error(rec.detail);
  }


  // ── permissions (G12) ───────────────────────────────────────────────────────
  /** May `acting` (the agent whose run this is) create or assign work at `target`? A sentence when not. */
  function mayAssign(projectId: string, memberId: string, actingTask: ProjectTask, target: { taskId: string | null; create?: boolean }): string | null {
    const caps = agentGov(projectId, memberId).capabilities, tree = treeOf(projectId);
    if (!caps.canAssign) return `${nameOf(projectId, memberId)} is not allowed to create or assign tasks. Turn on “Can assign tasks” in their permissions.`;
    const under = (rootId: string) => target.taskId === null || new Set(subtreeIds(tree, rootId)).has(target.taskId);
    if (caps.trust === 'low-trust') {
      if (caps.containment === 'task' && target.create) return `${nameOf(projectId, memberId)} is contained to this one task and cannot create new ones.`;
      if (caps.containment === 'task' && target.taskId !== null && target.taskId !== actingTask.id) return `${nameOf(projectId, memberId)} is contained to this one task.`;
      if (caps.containment === 'task' && target.taskId === null) return `${nameOf(projectId, memberId)} is contained to this one task and cannot create new ones.`;
      if (caps.containment === 'root-task' && !under(rootOf(tree, actingTask.id))) return `${nameOf(projectId, memberId)} is contained to its root task and the tasks under it.`;
    }
    if (caps.assignScope === 'subtree' && !under(actingTask.id)) return `${nameOf(projectId, memberId)} may only assign work under its own task.`;
    return null;
  }
  /** A low-trust agent may hand work only to itself or to another low-trust agent, so delegation never raises access. A sentence when refused. */
  const lowTrustAssignee = (projectId: string, creatorId: string, assigneeId: string): string | null =>
    agentGov(projectId, creatorId).capabilities.trust === 'low-trust' && assigneeId !== creatorId && agentGov(projectId, assigneeId).capabilities.trust !== 'low-trust'
      ? `${nameOf(projectId, creatorId)} is low-trust and may only hand work to itself or another low-trust agent, not ${nameOf(projectId, assigneeId)}.` : null;
  const trustCeiling = (projectId: string, memberId: string | null): ChatPermissionMode | null => memberId && agentGov(projectId, memberId).capabilities.trust === 'low-trust' ? 'workspace' : null;
  /** The permission mode a task run gets: the usual intersection, further capped for low-trust agents. */
  function clampAccess(projectId: string, owner: TaskOwner, access: ChatPermissionMode): ChatPermissionMode {
    const cap = owner.kind === 'agent' ? trustCeiling(projectId, owner.id) : null;
    return cap ? clampPermission(cap, access) : access;
  }

  /** Blocks an agent put in its final message: secret requests, subtasks and reassignments, hires. Every refusal is written to the thread. */
  async function processBlocks(task: ProjectTask, chat: Chat, text: string): Promise<void> {
    const projectId = task.projectId, memberId = ownerMemberId(task);
    if (!text.trim() || !memberId) return;
    const who = nameOf(projectId, memberId);
    const sr = secretRequests(text);
    for (const r of sr.requests) {
      if (gov().pendingProposal(projectId, memberId, r.name)) continue;
      if (theVault().value(projectId, r.name) && (memberOf(projectId, memberId)?.secrets ?? []).includes(r.name)) continue;
      gov().addProposal({ projectId, memberId, memberName: who, taskId: task.id, name: r.name, purpose: r.purpose, expiresAt: new Date(now() + SECRET_PROPOSAL_TTL_MS).toISOString() });
      gov().addSecretEvent(projectId, r.name, 'propose', who, clip(r.purpose, 200), chat.id);
      record(projectId, 'task.secret-requested', `${who} asks for the secret ${r.name}: ${clip(r.purpose, 160)} You approve it by entering the value yourself.`, task.id, 'agent');
    }
    for (const e of sr.errors) record(projectId, 'task.secret-requested', `${who}'s secret request was not understood: ${e}`, task.id, 'system');
    const sub = subtaskRequests(text);
    if (sub.creates.length || sub.reassigns.length) {
      const refusal = mayAssign(projectId, memberId, task, { taskId: task.id, create: sub.creates.length > 0 });
      if (refusal && !agentGov(projectId, memberId).capabilities.canAssign) record(projectId, 'task.permission-denied', `${refusal} ${sub.creates.length + sub.reassigns.length} requested ${sub.creates.length + sub.reassigns.length === 1 ? 'change was' : 'changes were'} not applied.`, task.id, 'system');
      else if (refusal && sub.creates.length) record(projectId, 'task.permission-denied', `${refusal} ${sub.creates.length} requested ${sub.creates.length === 1 ? 'subtask was' : 'subtasks were'} not created.`, task.id, 'system');
      else {
        const members = team().list(projectId).filter(m => m.kind === 'agent' && !m.revokedAt && !m.pendingAt);
        const find = (nm: string | null) => nm ? members.find(m => m.id === nm || m.name.toLowerCase() === nm.toLowerCase()) : undefined;
        let made = 0;
        for (const c of sub.creates) {
          const assignee = c.assignee ? find(c.assignee) : undefined;
          const lowAssign = lowTrustAssignee(projectId, memberId, assignee?.id ?? memberId);
          if (assignee && lowAssign) { record(projectId, 'task.permission-denied', `${lowAssign} “${clip(c.title, 60)}” was not created.`, task.id, 'system'); continue; }
          if (c.assignee && !assignee) { record(projectId, 'task.permission-denied', `${who} named “${c.assignee}”, who is not an active agent here. “${clip(c.title, 60)}” was not created.`, task.id, 'system'); continue; }
          const t = tasks().createTask({ projectId, title: c.title, acceptance: c.acceptance, dependencies: [], owner: assignee ? { kind: 'agent', id: assignee.id } : task.owner, parentId: task.id, ...(c.priority !== null ? { priority: c.priority } : {}), ...(trustCeiling(projectId, memberId) ? { permissionMode: trustCeiling(projectId, memberId)! } : {}) }, 'agent');
          record(projectId, 'task.delegated', `${who} created ${keyOf(t)} “${clip(t.title, 60)}” under ${keyOf(task)}${assignee ? ` for ${assignee.name}` : ''}.`, t.id, 'agent'); made++;
        }
        for (const r of sub.reassigns) {
          const target = tasks().listTasks(projectId).items.find(t => keyOf(t).toLowerCase() === r.key.toLowerCase()), to = find(r.to);
          const why = !target ? `${r.key} does not exist.` : !to ? `“${r.to}” is not an active agent here.` : mayAssign(projectId, memberId, task, { taskId: target.id });
          const low = to ? lowTrustAssignee(projectId, memberId, to.id) : null;
          if (why || low || !target || !to) { record(projectId, 'task.permission-denied', `${who} could not reassign ${r.key}: ${why || low}`, task.id, 'system'); continue; }
          tasks().editTask({ projectId, id: target.id, revision: target.revision, patch: { owner: { kind: 'agent', id: to.id } } }, 'agent');
          record(projectId, 'task.delegated', `${who} reassigned ${keyOf(target)} to ${to.name}.`, target.id, 'agent'); made++;
        }
        if (made) deps.changed(projectId, task.id);
      }
    }
    for (const e of sub.errors) record(projectId, 'task.permission-denied', `${who}'s subtasks block was not understood: ${e}`, task.id, 'system');
    const hires = hireRequests(text);
    for (const h of hires.hires) {
      const caps = agentGov(projectId, memberId).capabilities;
      if (!caps.canHire) { record(projectId, 'task.permission-denied', `${who} proposed hiring ${h.name}, but is not allowed to add agents. Turn on “Can add agents” in their permissions.`, task.id, 'system'); continue; }
      if (caps.trust === 'low-trust') { record(projectId, 'task.permission-denied', `${who} is a low-trust agent and cannot add agents.`, task.id, 'system'); continue; }
      try {
        const boss = h.reportsTo ? team().list(projectId).find(m => m.kind === 'agent' && (m.id === h.reportsTo || m.name.toLowerCase() === h.reportsTo!.toLowerCase())) : undefined;
        const pending = team().settings(projectId).requireHireApproval;
        const m = team().add(projectId, { name: h.name, kind: 'agent', role: 'agent', pending, ...(h.title ? { title: h.title } : {}), reportsTo: boss?.id ?? memberId, instructions: h.instructions });
        record(projectId, pending ? 'member.hire-requested' : 'member.added', `${who} ${pending ? 'asked to add' : 'added'} ${m.name}${m.title ? ` as ${m.title}` : ''}${pending ? ': waiting for your approval' : ''}.`, m.id, 'agent');
        deps.changed(projectId, task.id, true);
      } catch (err) { record(projectId, 'task.permission-denied', `${who}'s hire of ${h.name} failed: ${err instanceof Error ? err.message : 'error'}`, task.id, 'system'); }
    }
    for (const e of hires.errors) record(projectId, 'task.permission-denied', `${who}'s hire block was not understood: ${e}`, task.id, 'system');
  }

  // ── run lifecycle: started and settled (G9, C8, C16, C17, G10, G33, C30) ───
  function started(chat: Chat): void {
    pendingMeta.delete(chat.id);
    if (!chat.projectId) return;
    const meta = gov().runMeta(chat.id);
    if (meta && meta.settledAt) gov().upsertRunMeta(chat.projectId, chat.id, { settledAt: null });
  }
  const chains = new Map<string, Promise<void>>();
  function settled(chat: Chat, status: string): void {
    if (disposed || !chat.projectId || !deps.exists(chat.projectId)) return;
    const prev = chains.get(chat.id) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => handleSettled(chat, status)).catch(() => undefined);
    chains.set(chat.id, next);
    void next.finally(() => { if (chains.get(chat.id) === next) chains.delete(chat.id); });
  }
  /** Resolves when every settle in flight has finished (tests, dispose). */
  const idle = async () => { while (chains.size) await Promise.all([...chains.values()]); };

  const retryTimers = new Map<string, unknown>();
  function scheduleRetry(task: ProjectTask, chat: Chat, n: number, error: string) {
    const delay = retryDelayMs(n), at = new Date(now() + delay).toISOString(), s = settings(task.projectId);
    gov().upsertRunMeta(task.projectId, chat.id, { retries: n, pendingAt: at, note: `Retry ${n} of ${s.maxRetries} in ${Math.round(delay / 1000)} s after a temporary failure.` });
    record(task.projectId, 'task.run-retry', `“${clip(task.title, 60)}” failed with a temporary error (${clip(redactSecrets(error), 120)}). Retry ${n} of ${s.maxRetries} in ${Math.round(delay / 1000)} s.`, task.id, 'system');
    const prior = retryTimers.get(chat.id); if (prior) timers.clear(prior);
    retryTimers.set(chat.id, timers.set(() => { retryTimers.delete(chat.id); void retryNow(task.id, chat.id, n); }, delay));
    deps.changed(task.projectId, task.id);
  }
  async function retryNow(taskId: string, chatId: string, n: number) {
    if (disposed) return;
    const task = tasks().getTask(taskId);
    // Someone moved the task meanwhile (restarted, cancelled, edited): that decision stands.
    if (!task || task.runChatId !== chatId || task.state !== 'failed') { gov().upsertRunMeta(task?.projectId ?? '', chatId, { pendingAt: null, note: 'The retry was dropped: the task changed in the meantime.' }); return; }
    try { await resume(task, chatId, 'The previous attempt failed with a temporary error. Continue where you left off and finish the task.', 'retry', `Retry ${n}: continuing after a temporary failure`, { retries: n }); }
    catch (err) { gov().upsertRunMeta(task.projectId, chatId, { pendingAt: null, note: `The retry could not start: ${err instanceof Error ? err.message : 'error'}` }); deps.changed(task.projectId, task.id); }
  }

  /** The run ended without a comment: ask once, then write one from the Receipt. Returns true when a follow-up run was started. */
  async function commentBackstop(task: ProjectTask, chat: Chat, facts: Facts): Promise<boolean> {
    const s = settings(task.projectId), meta = gov().runMeta(chat.id)!;
    if (s.runComment === 'off') { gov().upsertRunMeta(task.projectId, chat.id, { comment: 'off' }); return false; }
    if (facts.assistantText.trim()) { gov().upsertRunMeta(task.projectId, chat.id, { comment: 'agent' }); return false; }
    if (s.runComment === 'require' && meta.comment !== 'asked') {
      try { await resume(task, chat.id, commentRequiredPrompt, 'comment_required', `Asked ${nameOf(task.projectId, ownerMemberId(task))} to comment on the finished run`, { comment: 'asked' }); return true; }
      catch { /* fall through to the written summary */ }
    }
    const who = nameOf(task.projectId, ownerMemberId(task)) || 'The agent';
    const used = [...facts.tools].map(([n, c]) => `${n} ×${c}`).join(', ');
    const summary = `${who} ended this run without a comment${meta.comment === 'asked' ? ' (even after being asked)' : ''}. From its Receipt: ${facts.files.length ? `changed ${facts.files.length} ${facts.files.length === 1 ? 'file' : 'files'} (${facts.files.slice(0, 5).map(f => f.split('/').pop()).join(', ')}${facts.files.length > 5 ? ', …' : ''})` : facts.fileChanges ? `${facts.fileChanges} file ${facts.fileChanges === 1 ? 'change' : 'changes'}` : 'no file changes'}${used ? `; used ${used}` : '; no tools used'}. This note was written by Muster, not by the agent.`;
    record(task.projectId, 'task.run-no-comment', summary, task.id, 'system');
    gov().upsertRunMeta(task.projectId, chat.id, { comment: 'backstop' });
    return false;
  }

  async function handleSettled(chat: Chat, rawStatus: string): Promise<void> {
    const projectId = chat.projectId!, at = new Date(now()).toISOString();
    const meta = gov().runMeta(chat.id);
    // A reviewer or watchdog agent's own chat: read its verdict.
    if (meta?.reason === 'review') { gov().upsertRunMeta(projectId, chat.id, { settledAt: at }); await reviewSettled(chat, meta); return; }
    if (meta?.reason === 'watchdog') { gov().upsertRunMeta(projectId, chat.id, { settledAt: at }); await watchdogSettled(chat, meta); return; }
    const task = tasks().taskByRunChat(chat.id);
    if (!task || task.runChatId !== chat.id) return;
    const status: RunFacts['status'] = rawStatus === 'completed' ? 'completed' : rawStatus === 'failed' ? 'failed' : 'interrupted';
    if (!meta) gov().upsertRunMeta(projectId, chat.id, { taskId: task.id, memberId: ownerMemberId(task), reason: 'user' });
    gov().upsertRunMeta(projectId, chat.id, { settledAt: at, pendingAt: null });
    try {
      const intent = stopIntent.get(chat.id);
      if (intent) {
        stopIntent.delete(chat.id);
        if (intent === 'hold') { deps.changed(projectId, task.id); return; }
        await afterStop(tasks().getTask(task.id) ?? task, intent);
        return;
      }
      // The run itself leaves the task running again when a hold or pause caught it mid-flight.
      const s = settings(projectId), facts = factsOf(chat, status), m = gov().runMeta(chat.id)!;
      const liveness: Liveness = classifyRun(facts);
      gov().upsertRunMeta(projectId, chat.id, { liveness });
      if (status === 'failed') {
        const kind = failureKind(chat.error);
        if (kind === 'transient' && m.retries < s.maxRetries && !gate(task)) { scheduleRetry(tasks().getTask(task.id) ?? task, chat, m.retries + 1, chat.error ?? 'failed'); return; }
        if (kind === 'limit') { record(projectId, 'task.run-limit', `“${clip(task.title, 60)}” stopped on a usage limit. It will not retry by itself: run it again after the limit resets.`, task.id, 'system'); }
        return;
      }
      if (status === 'completed' && m.comment === 'asked') { await commentBackstop(tasks().getTask(task.id) ?? task, chat, facts); }
      else if (status === 'completed' && (liveness === 'empty_response' || liveness === 'plan_only') && !facts.askedYou) {
        if (m.continuations < s.maxContinuations && !gate(task)) {
          try { await resume(tasks().getTask(task.id) ?? task, chat.id, continuationPrompt(liveness), 'continuation', `Continued ${m.continuations + 1} of ${s.maxContinuations}: the last turn ${liveness === 'empty_response' ? 'did nothing' : 'only made a plan'}`, { continuations: m.continuations + 1 }); return; }
          catch { /* falls through to needs follow-up */ }
        }
        gov().upsertRunMeta(projectId, chat.id, { liveness: 'needs_followup', note: liveness === 'empty_response' ? 'The agent ended its turns without doing the work.' : 'The agent only described a plan and never did the work.' });
        const fresh = tasks().getTask(task.id)!;
        if (fresh.state === 'implemented') tasks().setState({ projectId, id: task.id, revision: fresh.revision, state: 'blocked', reason: liveness === 'empty_response' ? 'The agent ended its turns without doing the work. Re-run it, edit the task, or cancel it.' : 'The agent only described a plan and never did the work. Re-run it, edit the task, or cancel it.' }, 'system');
        record(projectId, 'task.run-needs-followup', `“${clip(task.title, 60)}” needs a follow-up: ${liveness === 'empty_response' ? 'the agent ended its turns without doing the work' : 'the agent only made a plan'}.`, task.id, 'system');
        deps.changed(projectId, task.id);
        return;
      }
      else if (status === 'completed' && (liveness === 'completed' || liveness === 'advanced')) { if (await commentBackstop(tasks().getTask(task.id) ?? task, chat, facts)) return; }
      if (status === 'completed') await processBlocks(tasks().getTask(task.id) ?? task, chat, facts.assistantText);
      const fresh = tasks().getTask(task.id);
      if (status === 'completed' && fresh?.state === 'implemented') await startStage(fresh);
    } finally {
      forgetLiterals(chat.id);
      try { autoRelease(projectId); budgetDirty.add(projectId); const later = timers.set(() => { budgetLater.delete(later); void refreshBudget(projectId, true); }, 1500); budgetLater.add(later); await wakeQueue().released(projectId, task.id); scheduleEval(projectId); } catch { /* housekeeping never fails a run */ }
      deps.changed(projectId, task.id);
    }
  }

  // ── agent configuration: heartbeat, capabilities, tool rules, identity (C14, G12, G13, C12) ──
  const agentMember = (projectId: string, memberId: string): ProjectMember => {
    const m = memberOf(projectId, id(memberId, 'agent id'));
    if (!m || m.kind !== 'agent') throw new Error('That agent is not on this project’s Roster.');
    return m;
  };
  function setAgent(input: Record<string, unknown>): AgentGovernance {
    const projectId = project(input), m = agentMember(projectId, String(input.memberId)), cur = agentGov(projectId, m.id), said: string[] = [];
    const patch: Parameters<GovernanceStore['setAgent']>[2] = {};
    if (input.heartbeat !== undefined) {
      if (!input.heartbeat || typeof input.heartbeat !== 'object') throw new Error('Invalid heartbeat.');
      patch.heartbeat = clampHeartbeat(input.heartbeat as Partial<AgentGovernance['heartbeat']>, cur.heartbeat);
      const hb = patch.heartbeat;
      if (hb.enabled !== cur.heartbeat.enabled || hb.intervalSec !== cur.heartbeat.intervalSec) said.push(hb.enabled ? `heartbeat every ${hb.intervalSec >= 3600 && hb.intervalSec % 3600 === 0 ? `${hb.intervalSec / 3600} h` : hb.intervalSec >= 60 && hb.intervalSec % 60 === 0 ? `${hb.intervalSec / 60} min` : `${hb.intervalSec} s`}` : 'heartbeat off');
      for (const k of ['wakeOnAssignment', 'wakeOnComment', 'wakeOnDecision'] as const) if (hb[k] !== cur.heartbeat[k]) said.push(`${k === 'wakeOnAssignment' ? 'wake on assignment' : k === 'wakeOnComment' ? 'wake on comment' : 'wake on decision'} ${hb[k] ? 'on' : 'off'}`);
      if (hb.minGapSec !== cur.heartbeat.minGapSec) said.push(`least ${hb.minGapSec} s between wakes`);
    }
    if (input.capabilities !== undefined) {
      const c = input.capabilities as Partial<AgentCapabilities> | null;
      if (!c || typeof c !== 'object') throw new Error('Invalid permissions.');
      const next: AgentCapabilities = { canHire: c.canHire ?? cur.capabilities.canHire, canAssign: c.canAssign ?? cur.capabilities.canAssign, assignScope: c.assignScope ?? cur.capabilities.assignScope, trust: c.trust ?? cur.capabilities.trust, containment: c.containment ?? cur.capabilities.containment };
      if (!['subtree', 'project'].includes(next.assignScope)) throw new Error('Choose where this agent may assign work.');
      if (!['standard', 'low-trust'].includes(next.trust)) throw new Error('Choose a trust level.');
      if (!['project', 'root-task', 'task'].includes(next.containment)) throw new Error('Choose a containment boundary.');
      if (next.trust === 'low-trust' && next.canHire) next.canHire = false;
      patch.capabilities = { canHire: next.canHire === true, canAssign: next.canAssign === true, assignScope: next.assignScope, trust: next.trust, containment: next.containment };
      const a = patch.capabilities, b = cur.capabilities;
      if (a.canHire !== b.canHire) said.push(`can${a.canHire ? '' : 'not'} add agents`);
      if (a.canAssign !== b.canAssign || a.assignScope !== b.assignScope) said.push(a.canAssign ? `can assign tasks (${a.assignScope === 'subtree' ? 'under its own task' : 'anywhere in the project'})` : 'cannot assign tasks');
      if (a.trust !== b.trust || (a.trust === 'low-trust' && a.containment !== b.containment)) said.push(a.trust === 'low-trust' ? `low-trust, contained to ${a.containment === 'project' ? 'the project' : a.containment === 'root-task' ? 'its root task' : 'one task'}` : 'standard trust');
    }
    if (input.toolRules !== undefined) { patch.toolRules = normalizeRules(input.toolRules, MAX_TOOL_RULES); if (JSON.stringify(patch.toolRules.map(r => [r.match, r.pattern, r.effect])) !== JSON.stringify(cur.toolRules.map(r => [r.match, r.pattern, r.effect]))) said.push(`${patch.toolRules.length} tool ${patch.toolRules.length === 1 ? 'rule' : 'rules'}`); }
    if (input.gitIdentity !== undefined) {
      patch.gitIdentity = input.gitIdentity === null ? null : validateIdentity(input.gitIdentity);
      if (JSON.stringify(patch.gitIdentity) !== JSON.stringify(cur.gitIdentity)) said.push(patch.gitIdentity ? `commits as ${patch.gitIdentity.name} <${patch.gitIdentity.email}>` : 'no git identity');
    }
    const out = gov().setAgent(projectId, m.id, patch);
    if (said.length) record(projectId, 'member.access', `${m.name}: ${said.join(', ')}`, m.id, 'user');
    if (patch.heartbeat) arm(projectId, m.id);
    deps.changed(projectId, '', true);
    return { ...out, secrets: m.secrets };
  }
  const project = (input: Record<string, unknown>) => { const projectId = id(input.projectId, 'project id'); if (!deps.exists(projectId)) throw new Error('Project not found.'); return projectId; };

  // ── instruction bundle and revisions (G11) ──────────────────────────────────
  /** AGENTS.md is the member's instructions text; the other files live beside it. */
  function bundleFiles(projectId: string, m: ProjectMember): BundleFile[] {
    const stored = gov().files(projectId, m.id).filter(f => f.name !== BUNDLE_MAIN), main: BundleFile = { name: BUNDLE_MAIN, text: m.instructions ?? '', updatedAt: m.updatedAt };
    const standard = BUNDLE_STANDARD.filter(n => n !== BUNDLE_MAIN).map(n => stored.find(f => f.name === n) ?? { name: n, text: '', updatedAt: null });
    return [main, ...standard, ...stored.filter(f => !(BUNDLE_STANDARD as readonly string[]).includes(f.name))];
  }
  const snapshotFiles = (files: readonly BundleFile[]): Record<string, string> => Object.fromEntries(files.filter(f => f.text !== '' || f.name === BUNDLE_MAIN).map(f => [f.name, f.text]));
  async function writeBundle(projectId: string, m: ProjectMember, next: Record<string, string>, note: string, actor: string) {
    const before = snapshotFiles(bundleFiles(projectId, m)), changed = changedNames(before, next);
    if (!changed.length) return { files: bundleFiles(projectId, m), revision: null };
    checkBundle(Object.entries(next).map(([name, text]) => ({ name, text })));
    gov().tx(() => {
      for (const [name, text] of Object.entries(next)) if (name !== BUNDLE_MAIN) { if (text === '') gov().deleteFile(projectId, m.id, name); else gov().putFile(projectId, m.id, name, text); }
      for (const name of Object.keys(before)) if (!(name in next) && name !== BUNDLE_MAIN) gov().deleteFile(projectId, m.id, name);
    });
    if (changed.includes(BUNDLE_MAIN)) await deps.team.handlers['project.members.update']!({ projectId, id: m.id, instructions: next[BUNDLE_MAIN] ?? '' });
    const rev = gov().addRevision(projectId, m.id, next, note, actor, changed);
    record(projectId, 'member.instructions', `${actor} updated ${m.name}'s instructions bundle (${changed.join(', ')}), revision ${rev.version}.`, m.id, 'user');
    deps.changed(projectId, '', true);
    return { files: bundleFiles(projectId, memberOf(projectId, m.id)!), revision: rev };
  }

  // ── tool policy (G13) ───────────────────────────────────────────────────────
  /** Decides an approval request for a task run, from the owner's rules. null: no rule applies (the usual flow decides). */
  function decideTool(chat: Chat, method: string, params: Record<string, unknown>): { effect: 'allow' | 'ask' | 'deny'; message: string } | null {
    if (disposed || !chat.projectId || !deps.exists(chat.projectId)) return null;
    const task = tasks().taskByRunChat(chat.id), memberId = task ? ownerMemberId(task) : gov().runMeta(chat.id)?.memberId ?? null;
    if (!memberId) return null;
    const rules = agentGov(chat.projectId, memberId).toolRules;
    if (!rules.length) return null;
    const action = actionOf(method, params);
    if (!action) return null;
    // Allow answers an approval for you, which can mean running outside the sandbox: a low-trust agent never gets that.
    const v: ToolVerdict | null = evaluateTool(rules, action, { allowRules: agentGov(chat.projectId, memberId).capabilities.trust !== 'low-trust' });
    if (!v) return null;
    const who = nameOf(chat.projectId, memberId), shown = clip(redactSecrets(v.subject), 120);
    if (v.effect === 'deny') {
      record(chat.projectId, 'task.tool-denied', `Blocked ${who}'s ${action.kind === 'command' ? 'command' : action.kind === 'file' ? 'file change' : 'connector call'} ${shown ? `“${shown}” ` : ''}by the rule ${v.rule.match} “${v.rule.pattern}”${v.rule.note ? ` (${v.rule.note})` : ''}.`, task?.id ?? null, 'system');
      return { effect: 'deny', message: `${who}'s tool policy blocks this: rule ${v.rule.match} “${v.rule.pattern}”${v.rule.note ? ` (${v.rule.note})` : ''}.` };
    }
    if (v.effect === 'allow') record(chat.projectId, 'task.tool-allowed', `Allowed ${who}'s ${action.kind === 'command' ? 'command' : action.kind === 'file' ? 'file change' : 'connector call'} ${shown ? `“${shown}” ` : ''}by the rule ${v.rule.match} “${v.rule.pattern}”.`, task?.id ?? null, 'system');
    return { effect: v.effect, message: '' };
  }

  // ── run seams: prompt lines, run options, dispatch preparation ───────────────
  /** The lines a task run gets about its agent: bundle, why it started, review feedback, what it may do. */
  function taskLines(task: ProjectTask, chatId: string): string[] {
    const projectId = task.projectId, mid = ownerMemberId(task), m = mid ? memberOf(projectId, mid) : undefined, out: string[] = [];
    if (!m || m.kind !== 'agent') return out;
    const meta = gov().runMeta(chatId), g = agentGov(projectId, m.id);
    const files = bundleFiles(projectId, m);
    const bundle = composeBundle(files, { timer: meta?.reason === 'timer', name: m.name });
    if (m.title || bundle.length) {
      const boss = m.reportsTo ? memberOf(projectId, m.reportsTo) : undefined;
      out.push(`You are ${m.name}${m.title ? `, ${m.title}` : ''}${boss ? `, reporting to ${boss.name}` : ''}.`, ...bundle);
    }
    if (meta && !meta.settledAt && meta.reason !== 'user' && meta.reason !== 'assignment') out.push(`Why this run started: ${RUN_REASON_LABEL[meta.reason]}${meta.note ? ` — ${clip(meta.note, 600)}` : ''}.`);
    const stage = gov().stage(task.id);
    if (stage?.status === 'changes_requested' && stage.feedback) out.push(`Changes were requested (round ${stage.round}) by ${stage.history.at(-1)?.by ?? 'your reviewer'} — address this first:`, clip(stage.feedback, 1500));
    const lend = lendable(projectId, m, chatId, false);
    if (lend.length) out.push(`Secrets lent to this run as environment variables: ${lend.join(', ')}. Never print or write their values.`);
    if (g.gitIdentity) out.push(`Commit as ${g.gitIdentity.name} <${g.gitIdentity.email}> (already set in your environment).`);
    out.push('Need a credential you were not given? Do not ask for it in chat. End your reply with ```muster-secret-request {"name":"NAME","purpose":"why"}```; the user approves it.');
    if (g.capabilities.canAssign) out.push(`You may create subtasks${g.capabilities.assignScope === 'project' ? ' anywhere in the project' : ' under this task'} and hand them to teammates: end your reply with \`\`\`muster-subtasks [{"title":"…","acceptance":"…","assignee":"Name"}]\`\`\`.`);
    if (g.capabilities.canHire) out.push('You may propose a new teammate: ```muster-hire {"name":"…","title":"…","instructions":"…"}```.');
    if (settings(projectId).runComment !== 'off') out.push('End every run with a short comment on the task: what you did, what changed, what is left.');
    return out;
  }
  const canLend = (providerId: string | undefined) => !providerId || providerId === 'claude-code' || providerId === 'opencode' || !isAdapterProvider(providerId);
  /** Names of the granted, current secrets this run can receive. `log` records the lending in the audit. */
  function lendable(projectId: string, m: ProjectMember, chatId: string, log: boolean): string[] {
    const chat = ctx.store.chat(chatId);
    if (!canLend(chat?.providerId)) return [];
    const out: string[] = [];
    for (const name of m.secrets) {
      if (theVault().value(projectId, name)) { out.push(name); if (log) gov().addSecretEvent(projectId, name, 'lend', m.name, 'lent to a run as an environment variable', chatId); }
      else if (log && theVault().expired(projectId, name)) gov().addSecretEvent(projectId, name, 'expire', m.name, 'expired: not lent', chatId);
    }
    return out;
  }
  const lent = new Set<string>();
  /** Run options for a task run: the agent's git identity and the secrets it was granted, as run environment. */
  function runOptions(chat: Chat): RunOptions | null {
    if (disposed || !chat.projectId || !deps.exists(chat.projectId)) return null;
    // A reviewer or watchdog chat is read-only work for a different agent: it is lent nothing, never its task owner's secrets or identity.
    const meta = gov().runMeta(chat.id);
    if (meta && (meta.reason === 'review' || meta.reason === 'watchdog')) return null;
    const task = tasks().taskByRunChat(chat.id);
    const mid = task ? ownerMemberId(task) : null, m = mid ? memberOf(chat.projectId, mid) : undefined;
    if (!task || !m || m.kind !== 'agent') return null;
    const g = agentGov(chat.projectId, m.id), overrides: Record<string, string> = {};
    if (g.gitIdentity) Object.assign(overrides, envOverrides(g.gitIdentity));
    if (canLend(chat.providerId)) for (const name of m.secrets) { const v = theVault().value(chat.projectId, name); if (v) overrides[`shell_environment_policy.set.${name}`] = v.value; }
    lendLiterals(chat.id, m.secrets.flatMap(n => canLend(chat.providerId) ? [theVault().value(chat.projectId!, n)?.value ?? ''] : []));
    if (m.secrets.length && !lent.has(chat.id)) { lent.add(chat.id); lendable(chat.projectId, m, chat.id, true); if (lent.size > 500) lent.clear(); }
    return Object.keys(overrides).length ? { configOverrides: overrides } : null;
  }
  /** Before a task run: say, in the activity feed, which identity its commits carry. Nothing is written to any git config. */
  async function prepareDispatch(task: ProjectTask, cwd: string | null): Promise<void> {
    const mid = ownerMemberId(task); if (!mid || !cwd) return;
    const g = agentGov(task.projectId, mid);
    if (!g.gitIdentity) return;
    record(task.projectId, 'task.git-identity', `${nameOf(task.projectId, mid)} commits in this run as ${g.gitIdentity.name} <${g.gitIdentity.email}> (set through the run environment; your git config is not touched).`, task.id, 'system');
  }
  /** Records the linked worktree Muster made for a task. Only such a folder may ever carry an agent's identity for a Git-tab commit. */
  function noteWorktree(projectId: string, taskId: string, folderId: string) { gov().noteWorktree(folderId, projectId, taskId); }
  /** The identity a Git-tab commit in this folder should carry: the owner of the task whose own worktree it is. Null for your checkout and any folder you added (an agent run there gets its identity through the run environment only). */
  function identityForFolder(folderId: string): { name: string; email: string } | null {
    const w = gov().worktreeTask(folderId); if (!w || !deps.exists(w.projectId)) return null;
    const task = taskList(w.projectId).find(t => t.id === w.taskId);
    return task && task.owner.kind === 'agent' ? agentGov(w.projectId, task.owner.id).gitIdentity ?? null : null;
  }

  // ── secrets (G23) ───────────────────────────────────────────────────────────
  /** A proposal with what already exists under its name, so the decision says whether it grants or replaces. */
  function enrich(p: SecretProposal): SecretProposal {
    const meta = gov().secretMeta(p.projectId, p.name);
    return { ...p, existing: meta ? { version: meta.version, heldBy: secretGrants(p.projectId).get(p.name) ?? [] } : null };
  }
  function secretGrants(projectId: string): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const m of team().list(projectId)) for (const n of m.secrets) out.set(n, [...(out.get(n) ?? []), m.name]);
    return out;
  }
  function expireProposals(projectId: string) { for (const p of gov().proposals(projectId, true)) if (Date.parse(p.expiresAt) <= now()) { gov().setProposalState(p.id, 'expired'); gov().addSecretEvent(projectId, p.name, 'expire', 'system', 'the request expired unanswered'); } }
  function grant(projectId: string, name: string, memberId: string, granted: boolean, actor: string) {
    const m = agentMember(projectId, memberId);
    if (!gov().secretMeta(projectId, name)) throw new Error('That secret does not exist.');
    const has = m.secrets.includes(name);
    if (has === granted) return;
    team().update(projectId, m.id, { secrets: granted ? [...m.secrets, name] : m.secrets.filter(n => n !== name) });
    gov().addSecretEvent(projectId, name, granted ? 'grant' : 'revoke', actor, `${granted ? 'lent to' : 'taken back from'} ${m.name}`);
    record(projectId, 'member.access', `${m.name}: ${granted ? 'lends' : 'no longer lends'} the secret ${name}`, m.id, 'user');
  }

  // ── aggregate reads ─────────────────────────────────────────────────────────
  function governanceState(projectId: string): GovernanceState {
    expireProposals(projectId);
    const all = taskList(projectId);
    return {
      settings: settings(projectId), holds: gov().holds(projectId).map(holdView).filter(h => h.status === 'active' || Date.now() - Date.parse(h.releasedAt ?? h.createdAt) < 7 * 86_400_000), hiddenTaskIds: gov().hidden(projectId),
      stages: gov().stages(projectId).filter(s => all.some(t => t.id === s.taskId)), policies: gov().policies(projectId),
      watchdogs: gov().watchdogs(projectId).map(viewWatchdog), monitors: gov().monitors(projectId).map(monitorView), breakers: gov().breakers(projectId, false).slice(0, 20),
      recovery: recoveryItems(projectId), proposals: gov().proposals(projectId).map(enrich), runs: gov().runsFor(projectId, { limit: 100 }), wakes: gov().wakes(projectId, { limit: 40 }),
    };
  }
  /** What needs you, as simple rows the Inbox maps: open findings, breakers, secret requests, escalated monitors and stages waiting on you. */
  function inboxItems(projectId: string) {
    expireProposals(projectId);
    const items: { id: string; kind: 'review' | 'blocked' | 'approval' | 'question' | 'other'; title: string; why: string; severity: 'high' | 'medium' | 'low'; at: string; taskId: string | null; agentId: string | null; area: string }[] = [];
    for (const w of gov().watchdogs(projectId, true)) { const t = tasks().getTask(w.taskId); items.push({ id: `watchdog:${w.id}`, kind: 'blocked', title: `${t ? keyOf(t) : 'A task'} · subtree stopped`, why: w.summary, severity: 'medium', at: w.createdAt, taskId: w.taskId, agentId: null, area: 'governance' }); }
    for (const b of gov().breakers(projectId)) items.push({ id: `breaker:${b.id}`, kind: 'other', title: b.kind === 'wake_storm' ? 'Wake storm stopped' : b.kind === 'review_loop' ? 'Review loop' : 'Circuit breaker', why: b.summary, severity: 'high', at: b.createdAt, taskId: b.kind === 'review_loop' ? b.subject : null, agentId: b.memberId ? `member:${b.memberId}` : null, area: 'governance' });
    for (const p of gov().proposals(projectId, true)) items.push({ id: `secret:${p.id}`, kind: 'approval', title: `${p.memberName} asks for the secret ${p.name}`, why: p.purpose, severity: 'high', at: p.createdAt, taskId: p.taskId, agentId: `member:${p.memberId}`, area: 'secrets' });
    for (const m of gov().monitors(projectId)) if (m.state === 'escalated') { const t = tasks().getTask(m.taskId); items.push({ id: `monitor:${m.id}`, kind: 'blocked', title: `${t ? keyOf(t) : 'A task'} · follow-up check`, why: m.note || `The follow-up check on “${t?.title ?? 'a task'}” found it unfinished after ${m.attempts} ${m.attempts === 1 ? 'attempt' : 'attempts'}.`, severity: 'medium', at: m.lastFiredAt ?? m.createdAt, taskId: m.taskId, agentId: null, area: 'governance' }); }
    for (const s of gov().stages(projectId)) if ((s.status === 'awaiting' || s.status === 'escalated') && tasks().getTask(s.taskId)) { const t = tasks().getTask(s.taskId)!; items.push({ id: `stage:${s.taskId}`, kind: 'review', title: `${keyOf(t)} · ${s.kind === 'review' ? 'review' : 'approval'} ${s.stage + 1} of ${s.stages}`, why: s.status === 'escalated' ? s.feedback ?? 'Waiting for your decision.' : `Waiting for ${s.approverName === 'You' ? 'your' : `${s.approverName}'s`} ${s.kind === 'review' ? 'review' : 'approval'}.`, severity: 'high', at: s.updatedAt, taskId: s.taskId, agentId: null, area: 'governance' }); }
    return items;
  }
  // ── wakes that follow what people do: assignment and comments (C14) ─────────
  const assignTimers = new Set<unknown>();
  /** Task created or reassigned to an agent whose heartbeat says "wake on assignment": one wake, a moment later, so an explicit Assign & start wins. */
  function onAssigned(projectId: string, taskId: string) {
    const h = timers.set(() => {
      assignTimers.delete(h);
      const t = tasks().getTask(taskId), mid = t ? ownerMemberId(t) : null;
      if (!t || !mid || t.state !== 'todo' || !agentGov(projectId, mid).heartbeat.wakeOnAssignment) return;
      void wakeQueue().request({ projectId, memberId: mid, taskId, reason: 'assignment' }).catch(() => undefined);
    }, 250);
    assignTimers.add(h);
  }
  /** A comment from you on a task an agent owns: a wake, when that agent's policy says so. An @mention of the owner makes the reason "mention". */
  function onCommented(taskId: string, body: string) {
    const t = tasks().getTask(taskId), mid = t ? ownerMemberId(t) : null;
    if (!t || !mid || !agentGov(t.projectId, mid).heartbeat.wakeOnComment) return;
    const mentioned = new RegExp(`(^|\\s)@${nameOf(t.projectId, mid).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(body);
    void wakeQueue().request({ projectId: t.projectId, memberId: mid, taskId, reason: mentioned ? 'mention' : 'comment', note: redactSecrets(body).slice(0, 1000) }).catch(() => undefined);
  }
  const offCommands = ctx.hooks.onCommand?.(({ command, input, output }) => {
    if (disposed) return;
    try {
      if (command === 'project.tasks.add') { const o = output as { id?: string; projectId?: string; owner?: TaskOwner } | undefined; if (o?.id && o.projectId && o.owner?.kind === 'agent') onAssigned(o.projectId, o.id); }
      else if (command === 'project.tasks.edit') { const patch = (input.patch ?? {}) as { owner?: TaskOwner }; const o = output as { id?: string; projectId?: string } | undefined; if (patch.owner?.kind === 'agent' && o?.id && o.projectId) onAssigned(o.projectId, o.id); }
      else if ((command === 'project.members.pause' || command === 'project.members.revoke' || command === 'project.members.restore') && typeof input.projectId === 'string' && typeof input.id === 'string') arm(input.projectId, input.id);
      else if (command === 'project.archive' || command === 'project.restore') { const pid = typeof input.id === 'string' ? input.id : ''; for (const a of gov().heartbeatAgents()) if (a.projectId === pid) arm(a.projectId, a.memberId); }
      if (command === 'project.members.pause' && input.paused === false && typeof input.projectId === 'string' && typeof input.id === 'string') {
        const open = gov().openBreaker(input.projectId, 'wake_storm', input.id);
        if (open) { gov().setBreakerState(open.id, 'resumed'); deps.changed(input.projectId); }
      }
      else if (command === 'mailbox.send') {
        const to = input.to as { kind?: string; id?: string } | undefined, sender = (output as { sender?: { kind?: string } } | undefined)?.sender;
        if (to?.kind === 'taskRun' && typeof to.id === 'string' && sender?.kind === 'user' && typeof input.body === 'string') onCommented(to.id, input.body);
      }
    } catch { /* observers never fail a command */ }
  });
  const commands = () => ({
    'project.gov.state': (input: Record<string, unknown>) => { armAll(); return governanceState(project(input)); },
    'project.gov.summary': (input: Record<string, unknown>) => { const projectId = project(input), active = gov().holds(projectId, 'active'), tree = treeOf(projectId); return { items: inboxItems(projectId), hidden: gov().hidden(projectId), held: [...new Set(active.flatMap(h => subtreeIds(tree, h.rootTaskId)))] }; },
    /** One task's governance for its thread: no project-wide recovery or run scans, so a live run's refreshes stay cheap. */
    'project.gov.task': (input: Record<string, unknown>) => {
      const projectId = project(input), taskId = id(input.taskId, 'task id'); tasks().assertTaskProject(projectId, taskId); expireProposals(projectId);
      const v = taskView(projectId, taskId), ids = new Set([taskId]);
      const hold = v.hold ? gov().getHold(v.hold.id) : undefined;
      return {
        stage: v.stage, policy: v.policy, effectivePolicy: v.effectivePolicy, hold: v.hold ? { id: v.hold.id, mode: v.hold.mode, rootKey: v.hold.rootKey, rootTitle: v.hold.rootTitle, reason: v.hold.reason } : null,
        hidden: v.hidden, runs: v.runs, monitor: gov().monitors(projectId).find(m => ids.has(m.taskId)) ? monitorView(gov().monitors(projectId).find(m => ids.has(m.taskId))!) : null,
        watchdog: gov().openWatchdogFor(taskId) ? viewWatchdog(gov().openWatchdogFor(taskId)!) : null,
        agents: team().list(projectId).filter(m => m.kind === 'agent' && m.id !== 'agent' && !m.revokedAt && !m.pendingAt).map(m => ({ memberId: m.id, name: m.name })),
        proposals: gov().proposals(projectId).filter(p => p.taskId === taskId).map(enrich), secureStorage: theVault().secure(), defaultPolicy: settings(projectId).defaultPolicy, holdStatus: hold?.status ?? null,
      };
    },
    'project.gov.settings.set': (input: Record<string, unknown>) => {
      const projectId = project(input), cur = settings(projectId), next: GovernanceSettings = { ...cur };
      if (input.runComment !== undefined) { if (!['off', 'notice', 'require'].includes(String(input.runComment))) throw new Error('Choose off, notice or require.'); next.runComment = input.runComment as GovernanceSettings['runComment']; }
      for (const k of ['maxContinuations', 'maxRetries'] as const) if (input[k] !== undefined) { const v = Number(input[k]); if (!Number.isSafeInteger(v) || v < 0 || v > 3) throw new Error(`${k === 'maxRetries' ? 'Retries' : 'Continuations'} are 0 to 3.`); next[k] = v; }
      if (input.budgetHardStop !== undefined) { next.budgetHardStop = input.budgetHardStop === true; budgetAt.delete(projectId); }
      if (input.stormPerMinute !== undefined) { const v = Number(input.stormPerMinute); if (!Number.isSafeInteger(v) || v < 2 || v > 120) throw new Error('The wake storm limit is 2 to 120 per minute.'); next.stormPerMinute = v; }
      if (input.watchdogAgentId !== undefined) { if (input.watchdogAgentId === null || input.watchdogAgentId === '') next.watchdogAgentId = null; else { const m = agentMember(projectId, String(input.watchdogAgentId)); next.watchdogAgentId = m.id; } }
      if (input.defaultPolicy !== undefined) next.defaultPolicy = normalizePolicy(input.defaultPolicy as PolicyInput | null, projectId);
      const out = gov().setSettings(projectId, next);
      void refreshBudget(projectId, true);
      record(projectId, 'project.governance', `Updated run policy: ${Object.keys(input).filter(k => k !== 'projectId').join(', ')}.`, null, 'user');
      deps.changed(projectId); return out;
    },
    'project.agent.gov.get': (input: Record<string, unknown>): AgentGovernanceView => {
      const projectId = project(input), m = agentMember(projectId, String(input.memberId)), g = agentGov(projectId, m.id);
      const base = deps.team.runAccess(projectId, { kind: 'agent', id: m.id }, 'scheduler').permissionMode ?? 'read-only', cap = trustCeiling(projectId, m.id);
      armAll();
      return { governance: g, files: bundleFiles(projectId, m), revisions: gov().revisions(projectId, m.id), wakes: gov().wakes(projectId, { memberId: m.id, limit: 30 }), runs: gov().runsFor(projectId, { memberId: m.id, limit: 30 }), ceiling: cap ? clampPermission(cap, base) : base, secureStorage: theVault().secure() };
    },
    'project.agent.gov.set': (input: Record<string, unknown>) => setAgent(input),
    'project.agent.wake': async (input: Record<string, unknown>): Promise<WakeRecord> => {
      const projectId = project(input), m = agentMember(projectId, String(input.memberId));
      const taskId = input.taskId === undefined ? null : id(input.taskId, 'task id');
      const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 1000) : undefined;
      return wakeQueue().request({ projectId, memberId: m.id, taskId: taskId ?? readyTaskFor(projectId, m.id)?.id ?? null, reason: 'on_demand', ...(note ? { note } : {}), force: true });
    },
    'project.agent.files.save': async (input: Record<string, unknown>) => {
      const projectId = project(input), m = agentMember(projectId, String(input.memberId)), f = validateFile(input.name, input.text);
      const next = snapshotFiles(bundleFiles(projectId, m)); next[f.name] = f.text; if (f.text === '' && f.name !== BUNDLE_MAIN) delete next[f.name];
      return writeBundle(projectId, m, next, typeof input.note === 'string' ? input.note : '', 'You');
    },
    'project.agent.files.remove': async (input: Record<string, unknown>) => {
      const projectId = project(input), m = agentMember(projectId, String(input.memberId)), name = String(input.name);
      if (name === BUNDLE_MAIN) throw new Error('AGENTS.md is the main instructions: empty it instead of removing it.');
      const next = snapshotFiles(bundleFiles(projectId, m)); if (!(name in next)) throw new Error('That file is not in the bundle.'); delete next[name];
      return writeBundle(projectId, m, next, typeof input.note === 'string' ? input.note : `Removed ${name}`, 'You');
    },
    'project.agent.revisions.restore': async (input: Record<string, unknown>) => {
      const projectId = project(input), m = agentMember(projectId, String(input.memberId)), rid = id(input.revisionId, 'revision id'), files = gov().revisionFiles(projectId, m.id, rid);
      if (!files) throw new Error('That revision no longer exists.');
      const version = gov().revisions(projectId, m.id, 100).find(r => r.id === rid)?.version;
      const out = await writeBundle(projectId, m, { [BUNDLE_MAIN]: '', ...files }, `Restored revision ${version ?? ''}`.trim(), 'You');
      if (!out.revision) throw new Error('That revision is already the current bundle.');
      return { files: out.files, revision: out.revision };
    },
    'project.tasks.policy.set': (input: Record<string, unknown>) => {
      const projectId = project(input), taskId = id(input.id, 'task id'); tasks().assertTaskProject(projectId, taskId);
      const policy = normalizePolicy(input.policy as PolicyInput | null, projectId);
      const ownerId = ownerMemberId(tasks().getTask(taskId)!);
      if (policy?.stages.some(s => s.approver.kind === 'agent' && s.approver.memberId === ownerId)) throw new Error(`${nameOf(projectId, ownerId)} owns this task and cannot be its own reviewer. Choose another agent, or yourself.`);
      gov().setPolicy(projectId, taskId, policy);
      const t = tasks().getTask(taskId)!;
      record(projectId, 'task.policy', policy ? `Set ${policy.stages.length === 1 ? 'a' : policy.stages.length} ${policy.stages.map(s => s.kind).join(' → ')} policy on ${keyOf(t)}: ${policy.stages.map(s => stageApproverName(projectId, s.approver)).join(' → ')}.` : `Removed the execution policy from ${keyOf(t)}.`, taskId, 'user');
      deps.changed(projectId, taskId); return { taskId, policy };
    },
    'project.tasks.decide': async (input: Record<string, unknown>) => {
      const projectId = project(input), taskId = id(input.id, 'task id'), d = input.decision;
      if (d !== 'approve' && d !== 'request_changes') throw new Error('Choose approve or request changes.');
      const stage = gov().stage(taskId);
      if (stage && stage.approver.kind === 'agent' && stage.status === 'reviewing' && stage.reviewChatId && ACTIVE.has(ctx.store.chat(stage.reviewChatId)?.status ?? '')) throw new Error(`${stage.approverName} is still reviewing. Wait for the verdict, or stop that review first.`);
      return decide(projectId, taskId, d, typeof input.note === 'string' ? input.note : '', 'You', true);
    },
    'project.holds.create': (input: Record<string, unknown>) => createHold(input),
    'project.holds.release': (input: Record<string, unknown>) => releaseHold(input),
    'project.tasks.hide': (input: Record<string, unknown>) => { const projectId = project(input), taskId = id(input.id, 'task id'); tasks().assertTaskProject(projectId, taskId); const hidden = input.hidden === true; gov().setHidden(projectId, taskId, hidden); record(projectId, 'task.hidden', `${hidden ? 'Hid' : 'Unhid'} ${keyOf(tasks().getTask(taskId)!)} from lists.`, taskId, 'user'); deps.changed(projectId, taskId); return { hidden }; },
    'project.tasks.stop': (input: Record<string, unknown>) => { const projectId = project(input), mode = input.mode; if (mode !== 'keep' && mode !== 'done' && mode !== 'cancel') throw new Error('Choose Stop, Stop and mark done, or Stop and cancel.'); return stopTask(projectId, id(input.id, 'task id'), mode); },
    'project.watchdogs.resolve': async (input: Record<string, unknown>) => {
      const projectId = project(input), v = input.verdict; if (v !== 'accept' && v !== 'reopen' && v !== 'reassign') throw new Error('Choose accept, reopen or reassign.');
      return resolveWatchdog(projectId, id(input.id, 'finding id'), v, typeof input.note === 'string' ? input.note : '', typeof input.reassignTo === 'string' ? input.reassignTo : null, 'You', 'user');
    },
    'project.watchdogs.review': async (input: Record<string, unknown>) => { const projectId = project(input), w = gov().getWatchdog(id(input.id, 'finding id')); if (!w || w.projectId !== projectId) throw new Error('That finding no longer exists.'); const agent = settings(projectId).watchdogAgentId; if (!agent) throw new Error('Choose a watchdog agent in the run policy first.'); if (w.state !== 'open') throw new Error('That finding is already being handled.'); return startWatchdogReview(w.id, agent); },
    'project.monitors.set': (input: Record<string, unknown>) => {
      const projectId = project(input), taskId = id(input.taskId, 'task id'), t = tasks().assertTaskProject(projectId, taskId);
      if (DONE.has(t.state)) throw new Error('A finished task needs no follow-up.');
      const minutes = Number(input.dueInMinutes);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60 * 24 * 30) throw new Error('A follow-up is 1 minute to 30 days from now.');
      const policy = input.policy as MonitorPolicy; if (!['wake_owner', 'create_recovery_task', 'escalate'].includes(policy)) throw new Error('Choose what happens when the check fires.');
      if (policy === 'wake_owner' && !ownerMemberId(t)) throw new Error('Only an agent-owned task can wake its owner. Choose another recovery policy.');
      const max = input.maxAttempts === undefined ? 3 : Number(input.maxAttempts); if (!Number.isSafeInteger(max) || max < 1 || max > 10) throw new Error('Attempts are 1 to 10.');
      const intervalMs = Math.round(minutes * 60_000), mid = gov().addMonitor({ projectId, taskId, dueAt: new Date(now() + intervalMs).toISOString(), policy, maxAttempts: max, note: typeof input.note === 'string' ? input.note.trim() : '', intervalMs });
      record(projectId, 'task.monitor', `Set a follow-up check on ${keyOf(t)} in ${minutes >= 60 ? `${Math.round(minutes / 6) / 10} h` : `${minutes} min`}: ${policy === 'wake_owner' ? 'wake the owner' : policy === 'create_recovery_task' ? 'create a recovery task' : 'escalate to you'}.`, taskId, 'user');
      armMonitors(); deps.changed(projectId, taskId); return monitorView(gov().getMonitor(mid)!);
    },
    'project.monitors.clear': (input: Record<string, unknown>) => { const projectId = project(input), m = gov().getMonitor(id(input.id, 'monitor id')); if (!m || m.projectId !== projectId) throw new Error('That check no longer exists.'); gov().updateMonitor(m.id, { state: 'cleared' }); armMonitors(); deps.changed(projectId, m.taskId); return { cleared: true as const }; },
    'project.breakers.resolve': async (input: Record<string, unknown>) => {
      const projectId = project(input), b = gov().getBreaker(id(input.id, 'event id'));
      if (!b || b.projectId !== projectId) throw new Error('That event no longer exists.');
      if (b.state !== 'open') return b;
      if (input.action === 'resume' && b.kind === 'wake_storm' && b.memberId) { try { await deps.team.handlers['project.members.pause']!({ projectId, id: b.memberId, paused: false }); } catch { /* already resumed */ } arm(projectId, b.memberId); }
      gov().setBreakerState(b.id, input.action === 'resume' ? 'resumed' : 'dismissed');
      record(projectId, 'task.breaker', input.action === 'resume' ? `Resumed after: ${b.summary}` : `Dismissed: ${b.summary}`, b.subject, 'user'); deps.changed(projectId, '', true);
      return gov().getBreaker(b.id)!;
    },
    'project.recovery.resolve': async (input: Record<string, unknown>) => { const projectId = project(input), a = input.action; if (!['rerun', 'block', 'cancel', 'dismiss', 'resume'].includes(String(a))) throw new Error('Choose a way to resolve this.'); await resolveRecovery(projectId, id(input.taskId, 'task id'), a as RecoveryAction); return { ok: true as const }; },
    'project.secrets.list': (input: Record<string, unknown>) => { const projectId = project(input); expireProposals(projectId); return { secrets: theVault().list(projectId, secretGrants(projectId)), proposals: gov().proposals(projectId).map(enrich), secureStorage: theVault().secure() }; },
    'project.secrets.save': (input: Record<string, unknown>) => {
      const projectId = project(input), name = validName(input.name), existed = Boolean(gov().secretMeta(projectId, name));
      const out = theVault().save(projectId, name, input.value, { actor: 'You', ...(typeof input.description === 'string' ? { description: input.description } : {}), ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt === null || input.expiresAt === '' ? null : String(input.expiresAt) } : {}) });
      record(projectId, 'project.secret', `${existed ? 'Rotated' : 'Added'} the secret ${name} (version ${out.version}).`, null, 'user'); deps.changed(projectId); return { ...out, grantedTo: secretGrants(projectId).get(name) ?? [] };
    },
    'project.secrets.rollback': (input: Record<string, unknown>) => { const projectId = project(input), out = theVault().rollback(projectId, input.name, Number(input.version), 'You'); record(projectId, 'project.secret', `Rolled ${out.name} back to version ${out.version}.`, null, 'user'); deps.changed(projectId); return { ...out, grantedTo: secretGrants(projectId).get(out.name) ?? [] }; },
    'project.secrets.remove': (input: Record<string, unknown>) => {
      const projectId = project(input), name = validName(input.name);
      for (const m of team().list(projectId)) if (m.secrets.includes(name)) team().update(projectId, m.id, { secrets: m.secrets.filter(n => n !== name) });
      theVault().remove(projectId, name, 'You'); record(projectId, 'project.secret', `Deleted the secret ${name} and every version of it.`, null, 'user'); deps.changed(projectId, '', true); return { removed: true as const };
    },
    'project.secrets.grant': (input: Record<string, unknown>) => { const projectId = project(input), name = validName(input.name); grant(projectId, name, String(input.memberId), input.granted === true, 'You'); deps.changed(projectId, '', true); return { ...theVault().view(projectId, name, []), grantedTo: secretGrants(projectId).get(name) ?? [] }; },
    'project.secrets.decide': (input: Record<string, unknown>) => {
      const projectId = project(input), p = gov().getProposal(id(input.id, 'request id'));
      if (!p || p.projectId !== projectId) throw new Error('That request no longer exists.');
      if (p.state !== 'pending') throw new Error('That request was already answered.');
      if (Date.parse(p.expiresAt) <= now()) { gov().setProposalState(p.id, 'expired'); throw new Error('That request expired. Ask the agent to request it again.'); }
      if (input.approve === true) {
        const exists = Boolean(gov().secretMeta(projectId, p.name)), hasValue = typeof input.value === 'string' && input.value.trim() !== '';
        if (exists && hasValue && input.replace !== true) throw new Error(`${p.name} already exists (held by ${(secretGrants(projectId).get(p.name) ?? []).join(', ') || 'no one'}). Grant the existing secret, or confirm that you want to replace its value for everyone who holds it.`);
        if (exists && !hasValue) { grant(projectId, p.name, p.memberId, true, 'You'); gov().setProposalState(p.id, 'approved'); gov().addSecretEvent(projectId, p.name, 'approve', 'You', `existing secret granted to ${p.memberName}`); record(projectId, 'task.secret-approved', `You granted the existing secret ${p.name} to ${p.memberName}.`, p.taskId, 'user'); deps.changed(projectId, p.taskId ?? '', true); return enrich(gov().getProposal(p.id)!); }
        theVault().save(projectId, p.name, input.value, { description: gov().secretMeta(projectId, p.name)?.description || p.purpose, actor: 'You' });
        try { grant(projectId, p.name, p.memberId, true, 'You'); } catch { /* the agent left the Roster: the secret is still stored */ }
        gov().setProposalState(p.id, 'approved'); gov().addSecretEvent(projectId, p.name, 'approve', 'You', exists ? `value replaced by you; granted to ${p.memberName}` : `entered by you for ${p.memberName}`);
        record(projectId, 'task.secret-approved', `You approved ${p.name} for ${p.memberName}${exists ? ' and replaced its value' : ''}. The agent never sees the value in chat; it receives it as an environment variable.`, p.taskId, 'user');
      } else { gov().setProposalState(p.id, 'denied'); gov().addSecretEvent(projectId, p.name, 'deny', 'You', `declined for ${p.memberName}`); record(projectId, 'task.secret-approved', `You declined ${p.memberName}'s request for ${p.name}.`, p.taskId, 'user'); }
      deps.changed(projectId, p.taskId ?? '', true); return enrich(gov().getProposal(p.id)!);
    },
    'project.secrets.audit': (input: Record<string, unknown>) => { const projectId = project(input), limit = input.limit === undefined ? 100 : Math.max(1, Math.min(500, Number(input.limit) || 100)); return { events: gov().secretEvents(projectId, typeof input.name === 'string' ? validName(input.name) : undefined, limit) }; },
  } satisfies Record<string, DomainHandler>);

  /** Per-task view for the thread: its stage state, policy, hold, hidden flag. */
  function taskView(projectId: string, taskId: string) {
    const t = tasks().getTask(taskId);
    return { stage: gov().stage(taskId), policy: gov().policy(taskId) ?? null, effectivePolicy: t ? effectivePolicy(t) : null, hold: t ? holdFor(t) : null, hidden: gov().hidden(projectId).includes(taskId), runs: gov().runsFor(projectId, { taskId, limit: 20 }) };
  }
  /** Called when a task or project is deleted. */
  const purgeTask = (taskId: string) => { gov().purgeTask(taskId); };
  const purgeProject = (projectId: string) => {
    // The encrypted values go with the project: nothing could reach them once the metadata is gone.
    for (const m of gov().secretsMeta(projectId)) { try { theVault().remove(projectId, m.name, 'You'); } catch { /* already gone */ } }
    gov().purgeProject(projectId); for (const [k] of heartbeatTimers) if (k.startsWith(`${projectId}:`)) { timers.clear(heartbeatTimers.get(k)); heartbeatTimers.delete(k); } };
  /** An agent was removed or revoked: its timer stops. */
  const memberGone = (projectId: string, memberId: string) => disarm(projectId, memberId);
  function dispose() {
    disposed = true; for (const h of budgetLater) timers.clear(h); budgetLater.clear(); offCommands?.(); for (const h of assignTimers) timers.clear(h); assignTimers.clear(); queue?.dispose();
    for (const h of heartbeatTimers.values()) timers.clear(h); heartbeatTimers.clear();
    for (const h of retryTimers.values()) timers.clear(h); retryTimers.clear();
    for (const h of evalTimers.values()) timers.clear(h); evalTimers.clear();
    if (monitorTimer) timers.clear(monitorTimer);
    store?.close(); store = undefined;
  }
  return {
    handlers: commands() as unknown as Record<string, DomainHandler>,
    gate, preflight, release, held, identityForFolder, noteWorktree, clampAccess, beforeSend, prepareDispatch, taskLines, runOptions, decideTool, started, settled, idle, purgeTask, purgeProject, memberGone, taskView, holdFor, evaluate: scheduleEval, armAll, dispose,
    /** For tests: the stores and queues behind the commands. */
    internals: { gov, wakeQueue, heartbeatTimers, retryTimers, tick, fireMonitors, evaluateWatchdogs, readyTaskFor, recoveryItems, effectivePolicy, startStage },
  };
}
export type Governance = ReturnType<typeof createGovernance>;
