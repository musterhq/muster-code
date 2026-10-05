/**
 * Check out → work locally → hand back (#117). The orchestration over the pure pieces (lease.ts, reports.ts, costs.ts, tiers.ts), the store, and the
 * server's existing surface (assignee, comments, documents, cost events). Every effect on the server is the person's own action, taken in a visible
 * step of the app, and goes through the outbox so a dropped connection loses nothing.
 *
 * The rule: the ASSIGNEE decides where work runs. A task assigned to a human runs on that human's Mac through Muster; an agent never wakes on it.
 * (Paperclip wakes only the assigned agent, so assigning the task to the person is the exclusion.) "Run on server" is the explicit escape hatch.
 */
import type { WorkspaceAgent, WorkspaceCompany, WorkspaceStatus, WorkspaceTask } from '../../shared/domains/paperclip-protocol.ts';
import { engineOf, type LocalOrgAgent, type LocalOrgCopy, type PolicyStage } from '../../shared/domains/checkout-protocol.ts';
import type {
  AutoMode, CheckoutEvent, CheckoutLease, CheckoutPlan, CheckoutStartInput, HandBackInput, HandBackPreview, LeaseView, LocalBinding, ModelChoice, OutboxStatus, PendingPost,
} from '../../shared/domains/checkout-protocol.ts';
import { agentBrief, mapAgentToLocal, type LocalProvider } from './tiers.ts';
import { costEventFor, payerOf, type ProviderPayInfo } from './costs.ts';
import { canCheckout, checkoutComment, checkoutText, deriveLease, LeaseError, markerFor, newLease, transition, toView } from './lease.ts';
/** How long an automatic hand-back can be taken back. */
export const UNDO_MS = 2 * 60_000;
/** One context summary at most this often. */
export const CONTEXT_EVERY_MS = 30 * 60_000;
import {
  batchReports, contextReport, decisionReport, handBackBody, postedKeys, prReport, releaseBody, renderWorkLog, reportComment, testsReport, WORK_LOG_KEY,
  type Report, type TestResult, type TurnReceipt,
} from './reports.ts';
import type { CheckoutStore } from './store.ts';
import type { GitPort } from './git-port.ts';
import type { OrgReader } from '../server/orgs.ts';
import type { PersonalAccess, ServerBackend, ServerPart } from '../server/backend.ts';
import { PaperclipError } from '../paperclip-client.ts';

export type LocalProviderInfo = LocalProvider & ProviderPayInfo;
export interface ChatPort {
  addFolder(path: string): Promise<{ id: string }>;
  create(folderId: string): Promise<{ id: string }>;
  select(chatId: string, providerId: string, model: string): Promise<void>;
  rename(chatId: string, title: string): Promise<void>;
  /** Plain text of the chat's tool outputs and messages, newest last: where test summaries are read from. */
  transcript(chatId: string): Promise<string[]>;
}
export interface WorktreePort { create(root: string, branch: string, base: string): Promise<{ path: string; branch: string }> }
/** The turn the local runtime recorded (tokens, tests, model), read after a run settles. */
export interface TurnFacts { tokens: { input: number; cached: number; output: number } | null; tests: number; model: string | null; provider: string | null; costUsd: number | null; durationMs: number | null; outcome: string }
export interface CheckoutDeps {
  store: CheckoutStore;
  backend(): ServerBackend | null;
  reader: OrgReader;
  git: GitPort;
  worktrees: WorktreePort;
  chats: ChatPort;
  providers(): LocalProviderInfo[];
  turnFacts(chatId: string, runId: string): Promise<TurnFacts | null>;
  serverLabel(): string;
  deviceNameDefault(): string;
  now(): number;
  emit(taskId: string | null): void;
  /** Typed events for toasts: a finished task handed back by itself (Undo), or one that looks finished on "Ask me". */
  notify?(event: Extract<CheckoutEvent, { type: 'handedBack' | 'handBackReady' }>): void;
  /** Opens a PR for the branch (GitHub). Absent or failing: the branch is pushed and the link is left for the person. */
  openPr?(worktree: string, base: string, title: string, body: string): Promise<string | null>;
  /** A folder of this Mac whose origin remote is the project's repository (`github.com/org/repo`), or null. */
  detectFolder?(repo: string | null): Promise<string | null>;
  /** Waits before a flush (so a burst of turns makes one document write). Tests pass an immediate one. */
  later?(fn: () => void, ms: number): void;
}

const iso = (ms: number) => new Date(ms).toISOString();
const mention = (kind: 'agent' | 'user', id: string, name: string) => `[@${name}](${kind}://${id})`;
const personal = (backend: ServerBackend | null): ServerBackend & PersonalAccess => {
  if (!backend) throw new Error('Muster Server is not connected. Connect it in Settings › Integrations.');
  if (!backend.whoami || !backend.patchTask || !backend.rawComments || !backend.putDocument || !backend.postCostEvent || !backend.agentInstructions || !backend.issuePolicy) throw new Error('Work locally needs a server that can assign tasks to people. This one cannot be worked on locally yet.');
  return backend as ServerBackend & PersonalAccess;
};
const isNetwork = (cause: unknown): boolean => !(cause instanceof PaperclipError) || cause.status === 0 || cause.status >= 500 || cause.status === 401 || cause.status === 408 || cause.status === 429 || cause.stage === 'network';

/** The two ways a hand-back can reach the next person or agent; today only reassign. Swappable (reviewers/approvers) without touching the flow. */
export interface HandBackStrategy {
  readonly id: string;
  /** Moves the task to the reviewer and returns the @mention line the summary comment ends with. */
  apply(input: { backend: ServerBackend & PersonalAccess; task: WorkspaceTask; reviewer: HandBackInput['reviewer']; reviewerName: string }): { mentionLine: string; patch: { status: WorkspaceStatus; assigneeUserId: string | null; assigneeAgentId: string | null } };
}
/** Status In review, assigned to the reviewer (a QA agent wakes; a person is notified), and the summary @mentions them. */
export const reassignStrategy: HandBackStrategy = {
  id: 'reassign',
  apply: ({ reviewer, reviewerName }) => ({
    mentionLine: `${mention(reviewer.kind, reviewer.id, reviewerName)} this is ready for your review.`,
    patch: { status: 'in_review', assigneeUserId: reviewer.kind === 'user' ? reviewer.id : null, assigneeAgentId: reviewer.kind === 'agent' ? reviewer.id : null },
  }),
};

export class CheckoutService {
  private readonly flushing = new Map<string, Promise<void>>();
  private readonly timers = new Set<string>();
  constructor(private readonly d: CheckoutDeps, private readonly strategy: HandBackStrategy = reassignStrategy) {}

  get deviceId(): string { return this.d.store.deviceId(); }
  get device(): string { return this.d.store.deviceName(this.d.deviceNameDefault()); }
  private view(lease: CheckoutLease): LeaseView { return toView({ ...lease, pending: this.d.store.pendingCount(lease.taskId) }, this.deviceId, this.d.now(), this.d.store.staleHours()); }

  // --- finding the task -------------------------------------------------------------------------------------------------------------
  /**
   * Finds a task's org, part and the person. When the task is offline (switched off by the person, or the server did not answer) it answers
   * from the last copy instead of asking the network, so hand-back and release can still be queued.
   */
  private async locate(ref: string, opts: { cacheOnly?: boolean } = {}): Promise<{ company: WorkspaceCompany; part: ServerPart; task: WorkspaceTask; me: { id: string; name: string | null }; backend: ServerBackend & PersonalAccess }> {
    const backend = personal(this.d.backend());
    const lease = this.d.store.leases().find(l => l.taskId === ref || l.key === ref);
    const cacheOnly = opts.cacheOnly ?? Boolean(lease?.offline);
    const me = cacheOnly ? this.d.reader.remembered() ?? await this.d.reader.me() : await this.d.reader.me();
    if (!me) throw new Error('Muster Server did not say who you are, so this task cannot be checked out. Sign in again in Settings › Integrations.');
    const find = (part: ServerPart | undefined) => part?.tasks.find(t => t.id === ref || t.key === ref);
    const cached = this.d.reader.knownOrgs();
    for (const company of cached) { const part = this.d.reader.cached(company.id), task = find(part); if (part && task) return { company, part, task, me, backend }; }
    if (cacheOnly) throw new Error('This task is not in the last copy of the server. Go online to continue.');
    const companies = await this.d.reader.orgs();
    for (const company of companies) { const part = this.d.reader.cached(company.id), task = find(part); if (part && task) return { company, part, task, me, backend }; }
    for (const company of companies) { const part = await this.d.reader.part(company, true).catch(() => undefined), task = find(part); if (part && task) return { company, part, task, me, backend }; }
    throw new Error('That task is not on the connected Muster Server.');
  }
  private agentsOf(part: ServerPart): Map<string, WorkspaceAgent> { return new Map(part.agents.map(a => [a.id, a])); }

  // --- the plan the dialog shows ---------------------------------------------------------------------------------------------------------
  async plan(ref: string): Promise<CheckoutPlan> {
    const { company, part, task, me, backend } = await this.locate(ref);
    const project = task.projectId ? part.projects.find(p => p.id === task.projectId) : undefined;
    const server = this.d.serverLabel(), binding = task.projectId ? this.d.store.binding(server, company.id, task.projectId) : null;
    const comments = await backend.rawComments(task.id).catch(() => []);
    const derived = deriveLease({ assigneeUserId: task.assigneeUserId ?? null }, comments, me.id, this.deviceId);
    const providers = this.d.providers().filter(p => p.available);
    const own = task.assigneeId && !task.assigneeId.startsWith('user:') ? task.assigneeId : null;
    const agents = part.agents.filter(a => a.status !== 'terminated').map(a => ({ id: a.id, name: a.name, adapter: a.adapter, model: a.model, suggested: a.id === own, mapsTo: mapAgentToLocal({ adapter: a.adapter, model: a.model }, providers)?.label ?? null }))
      .sort((a, b) => Number(b.suggested) - Number(a.suggested) || a.name.localeCompare(b.name));
    return {
      task: { id: task.id, key: task.key, title: task.title, status: task.status, orgId: company.id, orgName: company.name, projectId: task.projectId, projectName: project?.name ?? null, assignee: task.assigneeLabel },
      assignedToMe: task.assigneeUserId === me.id, device: this.device,
      willPost: { comment: checkoutText(this.device), status: 'in_progress', reassign: task.assigneeUserId !== me.id },
      binding, detectedFolder: binding ? null : await (this.d.detectFolder?.(project?.repo ?? null) ?? Promise.resolve(null)).catch(() => null), devBranch: binding?.devBranch ?? null, agents, providers: providers.map(p => ({ id: p.id, name: p.name, models: p.models })),
      otherMac: derived && !derived.thisMac ? derived.device : null,
      firstTime: this.d.store.leases().length === 0,
    };
  }

  // --- bindings --------------------------------------------------------------------------------------------------------------------------
  async bind(orgId: string, projectId: string, path: string, devBranch?: string): Promise<LocalBinding> {
    if (!path || path.includes('\0') || !(await this.d.git.isRepo(path))) throw new Error('That folder is not a git repository. Choose the folder where you cloned this project.');
    const part = this.d.reader.cached(orgId) ?? await (async () => { const c = (await this.d.reader.orgs()).find(x => x.id === orgId); if (!c) throw new Error('Unknown org.'); return this.d.reader.part(c); })();
    const project = part.projects.find(p => p.id === projectId);
    if (!project) throw new Error('That project is not on the connected Muster Server.');
    const binding: LocalBinding = { orgId, projectId, projectName: project.name, path, devBranch: await this.d.git.defaultBranch(path, devBranch), boundAt: iso(this.d.now()) };
    this.d.store.bind(this.d.serverLabel(), binding);
    this.d.emit(null);
    return binding;
  }

  // --- check out ------------------------------------------------------------------------------------------------------------------------
  async start(input: CheckoutStartInput): Promise<LeaseView> {
    if (input.confirm !== true) throw new Error('Check out shows what it will post first. Confirm to continue.');
    const { company, part, task, me, backend } = await this.locate(input.taskId);
    if (task.status === 'done' || task.status === 'cancelled') throw new Error(`${task.key} is ${task.status === 'done' ? 'done' : 'cancelled'}. Reopen it on the server first.`);
    const existing = this.d.store.lease(task.id);
    if (existing && existing.state === 'checked_out') throw new LeaseError(`${task.key} is already checked out on this Mac.`, 'conflict');
    const assignedToMe = task.assigneeUserId === me.id;
    if (!assignedToMe && !input.take) throw new Error(`${task.key} is not assigned to you. Use “Take it” to reassign it to yourself first.`);
    const server = this.d.serverLabel();
    // The other Mac that holds it blocks a second check-out (release it there, or take it over).
    const comments = await backend.rawComments(task.id).catch(() => []);
    const derived = deriveLease({ assigneeUserId: task.assigneeUserId ?? null }, comments, me.id, this.deviceId);
    const gate = canCheckout(derived, this.deviceId, input.take === true);
    if (!gate.ok) throw new LeaseError(gate.reason, 'conflict');

    // The checkout folder for this org project, remembered per Mac.
    let binding = task.projectId ? this.d.store.binding(server, company.id, task.projectId) : null;
    if (!binding && input.folder && task.projectId) binding = await this.bind(company.id, task.projectId, input.folder, input.devBranch);
    if (!binding) throw new Error(`Choose where ${task.projectId ? 'this project’s' : 'the'} code lives on this Mac first (Check out › Choose folder).`);

    const model = this.resolveModel(input.model, part);
    const branch = `muster/${task.key}`;
    // Local steps first (they fail more often and can be undone), then the server's.
    const tree = await this.d.worktrees.create(binding.path, branch, binding.devBranch);
    const baseSha = await this.d.git.headSha(binding.path, binding.devBranch).catch(() => null);
    const folder = await this.d.chats.addFolder(tree.path);
    const chat = await this.d.chats.create(folder.id);
    await this.d.chats.select(chat.id, model.providerId, model.model);
    await this.d.chats.rename(chat.id, `${task.key} · ${task.title}`.slice(0, 120)).catch(() => undefined);

    const at = iso(this.d.now());
    const previous = { status: task.status, assigneeUserId: task.assigneeUserId ?? null, assigneeAgentId: task.assigneeId && !task.assigneeId.startsWith('user:') ? task.assigneeId : null };
    const lease: CheckoutLease = { ...newLease({ taskId: task.id, orgId: company.id, key: task.key, title: task.title, projectId: task.projectId, deviceId: this.deviceId, device: this.device, model: input.model, modelLabel: model.label, at, previous }), worktree: tree.path, branch: tree.branch, chatId: chat.id, folderId: folder.id, baseSha };
    this.d.store.putLease(lease);
    // The org as it stands now, copied read-only so the whole workflow runs here (definitions only: no keys, no adapter environment).
    await this.copyOrg(task.id).catch(() => undefined);
    this.enqueuePatch(task.id, company.id, `checkout:${at}`, { status: 'in_progress', assigneeUserId: me.id, assigneeAgentId: null }, at);
    this.d.store.enqueue({ taskId: task.id, orgId: company.id, type: 'comment', key: `checkout:${at}`, kind: 'checkout', body: checkoutComment(this.device, this.deviceId, me.name ?? me.id, at), at });
    await this.flush(task.id);
    this.d.emit(task.id);
    return this.view(this.d.store.lease(task.id)!);
  }
  private enqueuePatch(taskId: string, orgId: string, key: string, patch: Record<string, unknown>, at: string): void {
    this.d.store.enqueue({ taskId, orgId, type: 'patch', key: `patch:${key}`, kind: 'patch', body: JSON.stringify(patch), at });
  }
  private resolveModel(choice: ModelChoice, part: ServerPart): { providerId: string; model: string; label: string } {
    const providers = this.d.providers().filter(p => p.available);
    if (choice.kind === 'own') {
      const p = providers.find(x => x.id === choice.providerId);
      if (!p) throw new Error('That provider is not available on this Mac. Pick another, or connect it in Accounts & providers.');
      const m = p.models.find(x => x.id === choice.model) ?? (() => { throw new Error(`${p.name} has no model “${choice.model}”.`); })();
      return { providerId: p.id, model: m.id, label: `${p.name} · ${m.name}` };
    }
    const agent = part.agents.find(a => a.id === choice.agentId);
    if (!agent) throw new Error('That org agent is not on the server any more.');
    const mapped = mapAgentToLocal({ adapter: agent.adapter, model: agent.model }, providers);
    if (!mapped) throw new Error('No provider is available on this Mac to match the org agent. Pick “My own”, or connect a provider.');
    return { providerId: mapped.providerId, model: mapped.model, label: `${agent.name} → ${mapped.label}` };
  }

  // --- what the local chat is told about the task -----------------------------------------------------------------------------------------
  // --- the local copy of the org -----------------------------------------------------------------------------------------------------------
  /** Takes (or refreshes) the read-only copy: agents with their instructions, skills, adapter and model; the task's context; the execution policy. */
  async copyOrg(ref: string): Promise<LocalOrgCopy> {
    const { company, part, task, backend } = await this.locate(ref, { cacheOnly: false });
    const agents = this.agentsOf(part);
    const list = part.agents.filter(a => a.status !== 'terminated').slice(0, 60);
    const instructions = new Map<string, string>();
    for (let n = 0; n < list.length; n += 6) await Promise.all(list.slice(n, n + 6).map(async a => { instructions.set(a.id, await backend.agentInstructions(a.id).catch(() => '')); }));
    const detail = await backend.taskDetail(task.id, { agents, part, memory: async () => [] });
    const people = new Map((part.people ?? []).map(p => [p.id, p.name]));
    const policy: PolicyStage[] = (await backend.issuePolicy(task.id).catch(() => [])).map(st => ({ type: st.type, participants: st.participants.map(p => ({ ...p, name: p.kind === 'agent' ? agents.get(p.id)?.name ?? 'Agent' : people.get(p.id) ?? 'A person' })) }));
    const byId = new Map(part.tasks.map(t => [t.id, t]));
    const ref2 = (t: WorkspaceTask) => ({ key: t.key, title: t.title, status: t.status });
    const project = task.projectId ? part.projects.find(p => p.id === task.projectId) : undefined;
    const copy: LocalOrgCopy = {
      orgId: company.id, orgName: company.name, server: this.d.serverLabel(), takenAt: iso(this.d.now()),
      agents: list.map((a): LocalOrgAgent => ({ id: a.id, name: a.name, role: a.role, title: a.title, reportsTo: a.reportsTo, adapter: a.adapter, model: a.model, skills: a.skills ?? [], instructions: (instructions.get(a.id) ?? '').slice(0, 24_000) })),
      project: project ? { id: project.id, name: project.name, repo: project.repo, serverWorkspace: project.cwd } : null,
      task: {
        id: task.id, key: task.key, title: task.title, description: detail.description.slice(0, 8000),
        parent: task.parentId && byId.get(task.parentId) ? { key: byId.get(task.parentId)!.key, title: byId.get(task.parentId)!.title } : null,
        blockedBy: task.blockedByIds.map(id => byId.get(id)).filter((t): t is WorkspaceTask => Boolean(t)).map(ref2), subtasks: detail.subtasks.map(id => byId.get(id)).filter((t): t is WorkspaceTask => Boolean(t)).map(ref2),
        documents: detail.cards.filter((c): c is Extract<typeof c, { kind: 'document' }> => c.kind === 'document').map(c => ({ key: c.key, title: c.title })),
        thread: detail.comments.filter(c => !c.body.includes('muster:lease') && !c.body.includes('muster:report')).slice(-30).map(c => ({ author: c.author.label, body: c.body.slice(0, 1500), at: c.createdAt })),
        decisions: this.d.store.history(task.id, 'decision').map(r => r.body.replace(/^\*\*Decision\*\*\s*/, '').trim()),
      },
      policy,
    };
    this.d.store.putOrgCopy(task.id, copy);
    return copy;
  }
  orgCopy(ref: string): LocalOrgCopy | null { const l = this.d.store.leases().find(x => x.taskId === ref || x.key === ref); return this.d.store.orgCopy(l?.taskId ?? ref); }

  /**
   * What the local session is told: the task and its whole context from the local copy, the org's workflow (maker, then the reviewers and approvers
   * the policy names), and, for "Org agents", the maker's own instructions. A local review session gets the reviewer's role instead.
   */
  async brief(chatId: string): Promise<string | null> {
    const lease = this.d.store.leaseForChat(chatId);
    if (!lease) return null;
    const copy = this.d.store.orgCopy(lease.taskId), me = this.d.reader.remembered();
    if (!copy) return `Server task ${lease.key}: ${lease.title}. Work from this chat; Muster reports your milestones and syncs when it can.`;
    const t = copy.task, review = lease.reviewChats.find(r => r.chatId === chatId);
    const agentName = (id: string | null) => copy.agents.find(a => a.id === id)?.name;
    const lines = [`You are working locally on server task ${t.key}: ${t.title} (${copy.orgName}${copy.project ? ` · ${copy.project.name}` : ''}). Everything runs on this Mac, in this worktree; nothing runs on the server until hand-back.`, t.description && `Description:\n${t.description}`];
    if (t.parent) lines.push(`Parent task: ${t.parent.key} · ${t.parent.title}.`);
    if (t.blockedBy.length) lines.push(`Blocked by: ${t.blockedBy.map(b => `${b.key} (${b.status.replace('_', ' ')})`).join(', ')}.`);
    if (t.subtasks.length) lines.push(`Subtasks: ${t.subtasks.map(b => `${b.key} ${b.title} (${b.status.replace('_', ' ')})`).join('; ')}.`);
    if (t.documents.length) lines.push(`Documents on the task: ${t.documents.map(d => d.title || d.key).join(', ')}.`);
    if (t.thread.length) lines.push('Recent thread (newest last):', ...t.thread.slice(-12).map(c => `- ${c.author}${me && c.body.includes(`user://${me.id}`) ? ' (asked you)' : ''}: ${c.body.replace(/\s+/g, ' ').slice(0, 500)}`));
    if (t.decisions.length) lines.push('Decisions already made on this task:', ...t.decisions.map(d => `- ${d}`));
    if (copy.policy.length) lines.push(`The org's workflow for this task: the maker works, then ${copy.policy.map(st => `${st.type === 'review' ? 'review' : 'approval'} by ${st.participants.map(p => p.name).join(' or ') || 'someone'}`).join(', then ')}.`);
    const makerId = lease.model.kind === 'org-agent' ? lease.model.agentId : lease.previous.assigneeAgentId;
    if (review) {
      const reviewer = copy.agents.find(a => a.id === review.agentId);
      lines.push(`In this session you are the REVIEWER${reviewer ? `, in the role of "${reviewer.name}"` : ''}. Read the changes in this worktree against ${lease.baseSha?.slice(0, 8) ?? 'the base branch'}, run the tests, and report findings in plain words: what is right, what must change. Do not edit files.`);
      if (reviewer && lease.model.kind === 'org-agent') lines.push(agentBrief(reviewer, reviewer.instructions));
    } else if (lease.model.kind === 'org-agent') {
      const maker = copy.agents.find(a => a.id === (lease.model as { agentId: string }).agentId);
      if (maker) lines.push(agentBrief(maker, maker.instructions), maker.skills.length ? `Skills the org gave this role: ${maker.skills.join(', ')}.` : '');
    } else if (makerId && agentName(makerId)) lines.push(`The org's maker for this task is ${agentName(makerId)}; you are standing in for that role with your own model.`);
    lines.push('Say what you decided and why in plain words: Muster reports your milestones to the task as the person working here.');
    if (!review) lines.push('When the task is finished and the tests pass, end your final message with this block so Muster can hand the work back for review (do not write it before then):\n```muster-handback\n{"done":true,"summary":"one or two sentences on what changed"}\n```\nOpening a pull request or pushing the branch also counts as finished.');
    return lines.filter(Boolean).join('\n\n');
  }

  /** Changes the engine or model of a checked-out task (the next message uses it), and whether the reviewer step runs here. */
  async setEngine(ref: string, input: { model?: ModelChoice; reviewLocally?: boolean }): Promise<LeaseView> {
    const lease = this.requireOpen(ref);
    let next = lease;
    if (input.model) {
      const { part } = await this.locate(lease.taskId);
      const resolved = this.resolveModel(input.model, part);
      if (lease.chatId) await this.d.chats.select(lease.chatId, resolved.providerId, resolved.model);
      next = { ...next, model: input.model, modelLabel: resolved.label };
    }
    if (typeof input.reviewLocally === 'boolean') next = { ...next, reviewLocally: input.reviewLocally };
    this.d.store.putLease({ ...next, lastActivityAt: iso(this.d.now()) });
    this.d.emit(lease.taskId);
    return this.view(this.d.store.lease(lease.taskId)!);
  }
  /** A local review session in the task's worktree, with a reviewer from the policy (or the one named, or a QA role). Never sends anything to the server. */
  async startReview(ref: string, agentId?: string): Promise<{ chatId: string; reviewer: string }> {
    const lease = this.requireOpen(ref);
    const copy = this.d.store.orgCopy(lease.taskId) ?? await this.copyOrg(lease.taskId).catch(() => null);
    const candidates = copy?.agents ?? [];
    const policyAgent = copy?.policy.find(st => st.type === 'review')?.participants.find(p => p.kind === 'agent')?.id;
    const reviewer = candidates.find(a => a.id === (agentId ?? policyAgent)) ?? candidates.find(a => /qa|quality|review|test/i.test(`${a.role} ${a.title ?? ''} ${a.name}`));
    if (!lease.folderId) throw new Error('This task has no local worktree to review.');
    const chat = await this.d.chats.create(lease.folderId);
    // Org agents: the reviewer's own tier on the person's providers. My subscriptions: the same model as the work.
    const providers = this.d.providers().filter(p => p.available);
    const mapped = lease.model.kind === 'org-agent' && reviewer ? mapAgentToLocal({ adapter: reviewer.adapter, model: reviewer.model }, providers) : null;
    const route = mapped ? { providerId: mapped.providerId, model: mapped.model } : this.resolveRoute(lease.model, providers);
    await this.d.chats.select(chat.id, route.providerId, route.model);
    await this.d.chats.rename(chat.id, `${lease.key} · review${reviewer ? ` · ${reviewer.name}` : ''}`).catch(() => undefined);
    const at = iso(this.d.now());
    this.d.store.putLease({ ...lease, reviewChats: [...lease.reviewChats, { chatId: chat.id, agentId: reviewer?.id ?? null, label: reviewer?.name ?? 'Reviewer', at }], lastActivityAt: at });
    this.d.emit(lease.taskId);
    return { chatId: chat.id, reviewer: reviewer?.name ?? 'Reviewer' };
  }
  private resolveRoute(model: ModelChoice, providers: LocalProviderInfo[]): { providerId: string; model: string } {
    if (model.kind === 'own') return { providerId: model.providerId, model: model.model };
    const first = providers.find(p => p.models.length);
    if (!first) throw new Error('No provider is available on this Mac for the review.');
    return { providerId: first.id, model: first.models[0]!.id };
  }

  // --- reports -----------------------------------------------------------------------------------------------------------------------------
  private async postedKeysOf(backend: PersonalAccess, taskId: string): Promise<Set<string>> { return postedKeys((await backend.rawComments(taskId)).map(c => c.body)); }

  async decision(ref: string, text: string): Promise<{ posted: boolean; queued: boolean }> {
    const lease = this.d.store.leases().find(l => l.taskId === ref || l.key === ref);
    if (!lease || lease.state !== 'checked_out') throw new LeaseError('Check this task out first.', 'none');
    const body = text.trim().slice(0, 4000);
    if (!body) throw new Error('Write the decision first.');
    const at = iso(this.d.now());
    this.d.store.enqueue({ taskId: lease.taskId, orgId: lease.orgId, type: 'comment', key: `decision:${hash(body)}`, kind: 'decision', body: decisionReport(`decision:${hash(body)}`, at, body).body, at });
    this.touch(lease.taskId);
    await this.flush(lease.taskId);
    this.d.emit(lease.taskId);
    return { posted: this.d.store.pendingCount(lease.taskId) === 0, queued: this.d.store.pendingCount(lease.taskId) > 0 };
  }
  /** A context summary (also written by the person or the local agent); only the newest of a flush is posted. */
  async context(ref: string, summary: string): Promise<void> {
    const lease = this.d.store.leases().find(l => l.taskId === ref || l.key === ref);
    if (!lease || lease.state !== 'checked_out' || !summary.trim()) return;
    const at = iso(this.d.now()), key = `context:${at}`;
    this.d.store.enqueue({ taskId: lease.taskId, orgId: lease.orgId, type: 'comment', key, kind: 'context', body: contextReport(key, at, summary).body, at });
    this.touch(lease.taskId);
    this.scheduleFlush(lease.taskId);
    this.d.emit(lease.taskId);
  }
  private touch(taskId: string): void {
    const lease = this.d.store.lease(taskId);
    if (lease?.state === 'checked_out') this.d.store.putLease(transition(lease, { type: 'activity', at: iso(this.d.now()) }));
  }

  /** Called when a local run settles: one receipt row, one cost event, a debounced document write. Never one comment per turn. */
  async onTurn(chatId: string, runId: string, status: string): Promise<void> {
    const lease = this.d.store.leaseForChat(chatId);
    if (!lease || !lease.worktree) return;
    const facts = await this.d.turnFacts(chatId, runId).catch(() => null);
    const before = this.d.store.receipts(lease.taskId);
    const stat = lease.baseSha ? await this.d.git.stat(lease.worktree, lease.baseSha).catch(() => null) : null;
    const prevAdded = before.reduce((n, r) => n + (r.files?.added ?? 0), 0), prevRemoved = before.reduce((n, r) => n + (r.files?.removed ?? 0), 0);
    const receipt: TurnReceipt = {
      runId, at: iso(this.d.now()), model: facts?.model ?? null, provider: facts?.provider ?? null, source: lease.model.kind === 'org-agent' ? 'org-agent' : 'own', role: lease.reviewChats.some(r => r.chatId === chatId) ? 'reviewer' : 'maker',
      files: stat ? { count: stat.count, added: Math.max(0, stat.added - prevAdded), removed: Math.max(0, stat.removed - prevRemoved) } : null,
      tests: facts?.tests ?? 0, tokens: facts?.tokens ?? null, durationMs: facts?.durationMs ?? null, outcome: facts?.outcome ?? status,
      costUsd: facts?.costUsd ?? null, costSource: payerOf(this.d.providers().find(p => p.id === (facts?.provider ?? ''))),
      ...(await this.describeTurn(chatId)),
    };
    if (!this.d.store.addReceipt(lease.taskId, receipt)) return;
    // The cost entry: stands in for the org agent (the server requires one), billed to the person (personal) or the org.
    const me = await this.d.reader.me(), part = this.d.reader.cached(lease.orgId);
    if (me && part) {
      const agentId = lease.model.kind === 'org-agent' ? lease.model.agentId : lease.previous.assigneeAgentId ?? part.agents.find(a => a.role === 'ceo')?.id ?? part.agents[0]?.id;
      const provider = this.d.providers().find(p => p.id === (facts?.provider ?? ''));
      if (agentId) this.d.store.enqueue({ taskId: lease.taskId, orgId: lease.orgId, type: 'cost', key: `cost:${runId}`, kind: 'cost', at: receipt.at, body: JSON.stringify(costEventFor({ engine: engineOf(lease.model), receipt, costUsd: facts?.costUsd ?? null, agentId, issueId: lease.taskId, projectId: lease.projectId, userId: me.id, provider })) });
    }
    // Test results, when the turn ran a test command: one milestone (only the newest of a flush is posted).
    if (receipt.tests > 0) {
      const result = await this.testResult(chatId).catch(() => null);
      if (result) { receipt.testSummary = { passed: result.passed ?? 0, failed: result.failed ?? 0 }; this.d.store.updateReceipt(lease.taskId, receipt); }
      // One comment per distinct result: the same outcome after another turn says nothing new.
      if (result) { const key = `tests:${result.passed ?? 0}-${result.failed ?? 0}`; this.d.store.enqueue({ taskId: lease.taskId, orgId: lease.orgId, type: 'comment', key, kind: 'tests', body: testsReport(key, receipt.at, result).body, at: receipt.at }); }
    }
    // A context summary (what the agent says it is doing), at most one every half hour: the thread gets the story, not a comment per turn.
    const lastContext = this.d.store.history(lease.taskId, 'context').at(-1);
    if (receipt.summary && receipt.role !== 'reviewer' && (!lastContext || this.d.now() - Date.parse(lastContext.at) > CONTEXT_EVERY_MS)) {
      const key = `context:${receipt.at}`;
      this.d.store.enqueue({ taskId: lease.taskId, orgId: lease.orgId, type: 'comment', key, kind: 'context', body: contextReport(key, receipt.at, receipt.summary).body, at: receipt.at });
    }
    this.touch(lease.taskId);
    this.scheduleFlush(lease.taskId);
    this.d.emit(lease.taskId);
    // Finished? Only the maker's turns count (a local review is feedback, not completion).
    if (receipt.role !== 'reviewer' && status === 'completed') await this.afterTurn(lease.taskId, chatId, receipt).catch(() => undefined);
  }
  /** A title and summary for a turn's work-log section: the first line and the opening of the agent's final message. */
  private async describeTurn(chatId: string): Promise<{ title?: string; summary?: string }> {
    try {
      const last = [...(await this.d.chats.transcript(chatId))].reverse().find(t => t.trim()) ?? '';
      const line = last.split('\n').map(l => l.replace(/^[#*\-\s>]+/, '').trim()).find(Boolean) ?? '';
      return line ? { title: line.slice(0, 90), summary: last.replace(/\s+/g, ' ').trim().slice(0, 280) } : {};
    } catch { return {}; }
  }
  /** The newest test summary in the chat's tool output. */
  private async testResult(chatId: string): Promise<TestResult | null> {
    const parsed = parseTestSummary((await this.d.chats.transcript(chatId)).slice(-40).join('\n'));
    return parsed ? { ran: true, passed: parsed.passed, failed: parsed.failed, baselineFailed: null } : null;
  }

  // --- the outbox: flush now, or after a short wait --------------------------------------------------------------------------------------
  private scheduleFlush(taskId: string): void {
    if (this.timers.has(taskId)) return;
    this.timers.add(taskId);
    const run = () => { this.timers.delete(taskId); void this.flush(taskId); };
    if (this.d.later) this.d.later(run, 2500); else setTimeout(run, 2500).unref?.();
  }
  flush(taskId?: string, force = false): Promise<void> {
    const ids = taskId ? [taskId] : [...new Set(this.d.store.pending().map(r => r.taskId)), ...this.d.store.leases().filter(l => this.d.store.docDirty(l.taskId)).map(l => l.taskId)];
    // Calls for one task run one after the other: a caller that arrives mid-flush gets a fresh run after it, not the finished one's result.
    return Promise.all([...new Set(ids)].map(id => { const run = (this.flushing.get(id) ?? Promise.resolve()).then(() => this.flushLoop(id, force)); this.flushing.set(id, run); return run.finally(() => { if (this.flushing.get(id) === run) this.flushing.delete(id); }); })).then(() => undefined);
  }
  /** One flush, then again while more arrived during it (a turn that settled mid-flush), but never spinning on a server that keeps refusing. */
  private async flushLoop(taskId: string, force: boolean): Promise<void> {
    for (let round = 0; round < 4; round++) {
      const before = this.d.store.pendingCount(taskId) + Number(this.d.store.docDirty(taskId));
      await this.flushOne(taskId, force && round === 0);
      const lease = this.d.store.lease(taskId), left = this.d.store.pendingCount(taskId) + Number(this.d.store.docDirty(taskId));
      if (!left || lease?.offline || lease?.conflict || left >= before) return;
    }
  }
  private async flushOne(taskId: string, force = false): Promise<void> {
    const store = this.d.store;
    let lease = store.lease(taskId);
    // Offline by choice: nothing leaves this Mac. Everything stays queued (with its own client id) until the switch is turned off.
    if (lease?.offline === 'manual') return;
    // A conflict found by the last re-read waits for the person's choice.
    if (lease?.conflict && !force) return;
    let backend: (ServerBackend & PersonalAccess) | null = null;
    try { backend = personal(this.d.backend()); } catch { return; }
    const done = () => iso(this.d.now());
    try {
      // Coming back from offline: the task may have moved meanwhile (reassigned, closed). Look before sending anything.
      if (lease && (lease.recheck || lease.offline === 'auto') && !force && store.pending(taskId).length) {
        const conflict = await this.detectConflict(lease);
        if (conflict) { store.putLease(transition(lease, { type: 'conflict', at: done(), conflict })); store.setSyncState(done(), 'The task changed on the server while you were offline.'); this.d.emit(taskId); return; }
      }
      await this.sendRows(backend, taskId);
      if (store.docDirty(taskId)) await this.writeWorkLog(backend, taskId);
      lease = store.lease(taskId);
      if (lease && (lease.offline === 'auto' || lease.recheck)) store.putLease({ ...transition(lease, { type: 'online', at: done() }), recheck: false });
      store.setSyncState(done(), null);
    } catch (cause) {
      store.setSyncState(done(), message(cause));
      // The server cannot be reached: work on offline. The queue keeps every post; the next flush (or Sync) tries again.
      const now = store.lease(taskId);
      if (now && isNetwork(cause) && now.offline !== 'manual') store.putLease(transition(now, { type: 'offline', at: done(), mode: 'auto' }));
    } finally {
      const after = store.lease(taskId);
      if (after) store.putLease(after);
      this.d.emit(taskId);
    }
  }
  /** Rows go in order. Consecutive comments are batched (newest context/tests only, no repeats, nothing the server already shows). */
  private async sendRows(backend: ServerBackend & PersonalAccess, taskId: string): Promise<void> {
    const store = this.d.store, rows = store.pending(taskId);
    const agents = this.d.reader.cached(store.lease(taskId)?.orgId ?? '')?.agents;
    const agentMap = new Map((agents ?? []).map(a => [a.id, a]));
    const done = () => iso(this.d.now());
    let i = 0;
    while (i < rows.length) {
      const row = rows[i]!;
      if (row.type === 'patch') {
        try { await backend.patchTask(taskId, JSON.parse(row.body) as Parameters<PersonalAccess['patchTask']>[1]); store.markPosted(row.id, done()); }
        catch (cause) { store.markFailed(row.id, message(cause), !isNetwork(cause)); if (isNetwork(cause)) throw cause; }
        i++; continue;
      }
      if (row.type === 'cost') {
        try { await backend.postCostEvent(store.lease(taskId)?.orgId ?? row.orgId, JSON.parse(row.body) as Record<string, unknown>); store.markPosted(row.id, done()); }
        catch (cause) { store.markFailed(row.id, message(cause), !isNetwork(cause)); if (isNetwork(cause)) throw cause; }
        i++; continue;
      }
      const group: typeof rows = [];
      while (i < rows.length && rows[i]!.type === 'comment') group.push(rows[i++]!);
      const already = await this.postedKeysOf(backend, taskId);
      const { post, dropped } = batchReports(group.map(r => store.toReport(r)), already);
      for (const r of dropped) { const row2 = group.find(g => g.key === r.key); if (row2) store.markPosted(row2.id, done()); }
      for (const r of post) {
        const row2 = group.find(g => g.key === r.key)!;
        try { await backend.comment!(taskId, reportComment(r), agentMap, row2.clientId); store.markPosted(row2.id, done()); }
        catch (cause) { store.markFailed(row2.id, message(cause), !isNetwork(cause)); if (isNetwork(cause)) throw cause; }
      }
    }
  }
  /** What a re-read of the task finds different from what check-out left: a different assignee, or a status that is no longer In progress. */
  private async detectConflict(lease: CheckoutLease): Promise<NonNullable<CheckoutLease['conflict']> | null> {
    if (lease.runOnServer) return null;
    const company = (await this.d.reader.orgs()).find(c => c.id === lease.orgId);
    if (!company) return null;
    const part = await this.d.reader.part(company, true), task = part.tasks.find(t => t.id === lease.taskId);
    const me = await this.d.reader.me();
    if (!task || !me) return null;
    const changes: string[] = [];
    if (task.assigneeUserId !== me.id) changes.push(`It is now assigned to ${task.assigneeLabel ?? 'nobody'}.`);
    if (task.status === 'done' || task.status === 'cancelled') changes.push(`It was marked ${task.status === 'done' ? 'Done' : 'Cancelled'}.`);
    else if (task.status !== 'in_progress' && lease.state === 'checked_out') changes.push(`Its status is now ${task.status.replace('_', ' ')}.`);
    else if (task.status !== 'in_progress' && lease.state !== 'checked_out' && !changes.length) changes.push(`Its status is now ${task.status.replace('_', ' ')}.`);
    return changes.length ? { at: iso(this.d.now()), changes, status: task.status, assignee: task.assigneeLabel } : null;
  }
  private async writeWorkLog(backend: PersonalAccess, taskId: string): Promise<void> {
    const lease = this.d.store.lease(taskId); if (!lease) return;
    const receipts = this.d.store.receipts(taskId), me = await this.d.reader.me();
    const body = renderWorkLog({ key: lease.key, title: lease.title, person: me?.name ?? 'You', device: lease.device, branch: lease.branch ?? '', since: lease.since.slice(0, 16).replace('T', ' '), state: lease.state === 'checked_out' ? 'in progress' : lease.state === 'handed_back' ? 'handed back' : 'released', modelLabel: lease.modelLabel }, receipts);
    await backend.putDocument(taskId, WORK_LOG_KEY, { title: 'Local work log', body, changeSummary: `${receipts.length} local ${receipts.length === 1 ? 'turn' : 'turns'}` });
    this.d.store.markDocPosted(taskId);
  }
  async outbox(): Promise<OutboxStatus> { return { pending: this.d.store.pendingCount(), ...this.d.store.syncState() }; }
  async sync(): Promise<OutboxStatus> { await this.flush(); return this.outbox(); }

  // --- automatic hand-back -----------------------------------------------------------------------------------------------------------------
  /**
   * People forget to hand back, so Muster does it when the local work is finished. Finished means one of these signals, none of them a keyword guess:
   *  - the PR was opened (its link is in the agent's final message) or the branch was pushed from the worktree (the remote-tracking ref is HEAD);
   *  - the agent ended its final message with the structured `muster-handback` block (`{"done":true}`), as the briefing asks it to when the work is done
   *    and the tests pass. That covers "done" or "ship it" said in the local chat: the agent reads it and writes the block.
   * Never while tests are failing, and never without a test run: those post a progress note and the task stays checked out.
   */
  private async afterTurn(taskId: string, chatId: string, receipt: TurnReceipt): Promise<void> {
    const lease = this.d.store.lease(taskId);
    if (!lease || lease.state !== 'checked_out' || lease.runOnServer || !lease.worktree || !lease.branch) return;
    const text = [...(await this.d.chats.transcript(chatId).catch(() => []))].reverse().find(t => t.trim()) ?? '';
    const signal = await this.finishedSignal(lease, text);
    if (!signal) return;
    // The pull request is a milestone in its own right, even when hand-back has to wait.
    if (signal.prUrl) this.d.store.enqueue({ taskId, orgId: lease.orgId, type: 'comment', key: `pr:${hash(signal.prUrl)}`, kind: 'pr', body: prReport(`pr:${hash(signal.prUrl)}`, iso(this.d.now()), signal.prUrl, lease.branch).body, at: iso(this.d.now()) });
    const receipts = this.d.store.receipts(taskId), latest = [...receipts].reverse().find(r => r.testSummary);
    const note = async (key: string, body: string) => { if (this.d.store.enqueue({ taskId, orgId: lease.orgId, type: 'comment', key, kind: 'note', body, at: iso(this.d.now()) })) this.scheduleFlush(taskId); };
    if (latest?.testSummary && latest.testSummary.failed > 0) { await note(`blocked:tests:${latest.testSummary.passed}-${latest.testSummary.failed}`, `**Not handing back yet.** The work looks finished (${signal.label}) but ${latest.testSummary.failed} ${latest.testSummary.failed === 1 ? 'test is' : 'tests are'} failing (${latest.testSummary.passed} passed). It stays checked out on ${lease.device}.`); return; }
    if (!receipts.some(r => r.tests > 0)) { await note('blocked:no-tests', `**Not handing back yet.** The work looks finished (${signal.label}) but no tests have run. It stays checked out on ${lease.device}; run the tests and it will go back for review.`); return; }
    const recipient = await this.recipientFor(lease).catch(() => null);
    if (!recipient) { await note('blocked:no-recipient', `**Not handing back yet.** The work looks finished (${signal.label}) but there is no reviewer or originator to give it to. Hand it back from the task when you choose who.`); return; }
    if (this.d.store.autoMode(this.d.serverLabel(), lease.orgId, lease.projectId) === 'ask') { this.d.notify?.({ type: 'handBackReady', taskId, key: lease.key, to: recipient.name, recipient: { kind: recipient.kind, id: recipient.id }, reason: signal.label }); return; }
    const done = await this.handBack({ taskId, reviewer: { kind: recipient.kind, id: recipient.id }, ...(signal.prUrl ? { prUrl: signal.prUrl } : {}), ...(signal.summary ? { summary: signal.summary } : {}), push: !signal.pushed && !signal.prUrl });
    void done;
    this.d.notify?.({ type: 'handedBack', taskId, key: lease.key, to: recipient.name, undoUntil: iso(this.d.now() + UNDO_MS) });
  }
  private async finishedSignal(lease: CheckoutLease, finalText: string): Promise<{ label: string; prUrl?: string; pushed?: boolean; summary?: string } | null> {
    const block = /```muster-handback[^\n]*\n([\s\S]*?)```/.exec(finalText);
    let done: { summary?: string } | null = null;
    if (block) { try { const j = JSON.parse(block[1]!) as { done?: unknown; summary?: unknown }; if (j.done === true) done = { summary: typeof j.summary === 'string' ? j.summary.slice(0, 2000) : undefined }; } catch { /* a malformed block is not a signal */ } }
    const pr = /https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/pull\/\d+/.exec(finalText)?.[0];
    const pushed = lease.worktree && lease.branch ? await this.d.git.pushedHead(lease.worktree, lease.branch).catch(() => false) : false;
    if (pr) return { label: 'the pull request is open', prUrl: pr, pushed, ...(done?.summary ? { summary: done.summary } : {}) };
    if (pushed) return { label: 'the branch is pushed', pushed: true, ...(done?.summary ? { summary: done.summary } : {}) };
    return done ? { label: 'the agent says it is done', ...(done.summary ? { summary: done.summary } : {}) } : null;
  }
  /** Who a finished task goes to: the task's own review and approval policy first, then whoever opened it, then a QA agent. */
  private async recipientFor(lease: CheckoutLease): Promise<{ kind: 'agent' | 'user'; id: string; name: string } | null> {
    const { part, task, me } = await this.locate(lease.taskId, { cacheOnly: true });
    const copy = this.d.store.orgCopy(lease.taskId);
    const stage = copy?.policy.find(st => st.type === 'review' && st.participants.length) ?? copy?.policy.find(st => st.participants.length);
    const named = stage?.participants.find(p => p.id !== me.id) ?? stage?.participants[0];
    if (named) return { kind: named.kind, id: named.id, name: named.name };
    if (task.createdByAgentId) { const a = part.agents.find(x => x.id === task.createdByAgentId && x.status !== 'terminated'); if (a) return { kind: 'agent', id: a.id, name: a.name }; }
    if (task.createdByUserId && task.createdByUserId !== me.id) return { kind: 'user', id: task.createdByUserId, name: part.people?.find(p => p.id === task.createdByUserId)?.name ?? 'the originator' };
    const qa = part.agents.find(a => a.status !== 'terminated' && /qa|quality|review|test/i.test(`${a.role} ${a.title ?? ''} ${a.name}`));
    return qa ? { kind: 'agent', id: qa.id, name: qa.name } : null;
  }
  /** A quiet session gets one short "paused" note per quiet stretch; unfinished work is never handed back because of silence. */
  async checkIdle(): Promise<number> {
    let posted = 0;
    for (const lease of this.d.store.openLeases()) {
      if (lease.offline === 'manual') continue;
      const idleMs = this.d.store.idleMinutes() * 60_000, last = Date.parse(lease.lastActivityAt), noted = lease.pausedNoteAt ? Date.parse(lease.pausedNoteAt) : 0;
      if (!(this.d.now() - last >= idleMs) || noted > last) continue;
      const at = iso(this.d.now()), mins = Math.round((this.d.now() - last) / 60_000);
      this.d.store.enqueue({ taskId: lease.taskId, orgId: lease.orgId, type: 'comment', key: `paused:${lease.lastActivityAt}`, kind: 'note', body: `**Paused.** No activity for ${mins} minutes. It is still checked out on ${lease.device}; nothing was handed back.`, at });
      this.d.store.putLease(transition(lease, { type: 'paused', at })); posted++;
      this.scheduleFlush(lease.taskId);
    }
    return posted;
  }
  /** Takes a hand-back back (for about two minutes, while nobody has acted on it): the task returns to the person, In progress, with a short comment. */
  async undoHandBack(ref: string): Promise<LeaseView> {
    const lease = this.d.store.leases().filter(l => l.taskId === ref || l.key === ref).sort((a, b) => b.since.localeCompare(a.since))[0];
    if (!lease || lease.state !== 'handed_back' || !lease.endedAt) throw new LeaseError('There is no hand-back to undo.', 'none');
    if (this.d.now() - Date.parse(lease.endedAt) > UNDO_MS) throw new Error('This hand-back can no longer be undone: more than two minutes have passed.');
    const me = (await this.d.reader.me()) ?? this.d.reader.remembered();
    if (!me) throw new Error('Muster Server did not say who you are. Sign in again in Settings › Integrations.');
    // Only while the task is still where hand-back left it: if the reviewer has already acted, it is theirs now. (A fresh read; unreachable means the queue decides.)
    const fresh = await (async () => { const company = (await this.d.reader.orgs()).find(c => c.id === lease.orgId); return company ? (await this.d.reader.part(company, true)).tasks.find(t => t.id === lease.taskId) : undefined; })().catch(() => undefined);
    if (fresh && !this.d.store.pending(lease.taskId).length && fresh.status !== 'in_review') throw new Error('The reviewer has already acted on this task, so it cannot be taken back.');
    const at = iso(this.d.now()), key = `undo:${at}`;
    this.d.store.enqueue({ taskId: lease.taskId, orgId: lease.orgId, type: 'comment', key, kind: 'checkout', at, body: `Hand-back undone · working locally on ${lease.device} · via Muster\n\n${markerFor('checkout', { device: lease.device, 'device-id': lease.deviceId, by: me.name ?? me.id, at })}` });
    this.enqueuePatch(lease.taskId, lease.orgId, key, { status: 'in_progress', assigneeUserId: me.id, assigneeAgentId: null }, at);
    this.d.store.putLease(transition(lease, { type: 'reopen', at }));
    await this.flush(lease.taskId);
    this.d.emit(lease.taskId);
    return this.view(this.d.store.lease(lease.taskId)!);
  }
  autoMode(ref: { taskId?: string; orgId?: string; projectId?: string }): AutoMode {
    const lease = ref.taskId ? this.d.store.leases().find(l => l.taskId === ref.taskId || l.key === ref.taskId) : undefined;
    return this.d.store.autoMode(this.d.serverLabel(), lease?.orgId ?? ref.orgId ?? '', lease ? lease.projectId : ref.projectId ?? null);
  }
  setAutoMode(ref: { taskId?: string; orgId?: string; projectId?: string }, mode: AutoMode): AutoMode {
    const lease = ref.taskId ? this.d.store.leases().find(l => l.taskId === ref.taskId || l.key === ref.taskId) : undefined;
    this.d.store.setAutoMode(this.d.serverLabel(), lease?.orgId ?? ref.orgId ?? '', lease ? lease.projectId : ref.projectId ?? null, mode);
    this.d.emit(lease?.taskId ?? null);
    return mode;
  }

  // --- hand back ----------------------------------------------------------------------------------------------------------------------------
  async handBackPreview(ref: string): Promise<HandBackPreview> {
    const lease = this.requireOpen(ref), { part, task } = await this.locate(lease.taskId);
    const receipts = this.d.store.receipts(lease.taskId);
    const testsRun = receipts.some(r => r.tests > 0);
    const newest = this.d.store.history(lease.taskId, 'tests').at(-1);
    const decisions = this.d.store.history(lease.taskId, 'decision').map(r => r.body.replace(/^\*\*Decision\*\*\s*/, '').trim());
    const qa = (a: WorkspaceAgent) => /qa|quality|review|test/i.test(`${a.role} ${a.title ?? ''} ${a.name}`);
    const copy = this.d.store.orgCopy(lease.taskId), policy = copy?.policy ?? [];
    // The task's own policy names who reviews first; otherwise a QA agent; otherwise whoever opened the task.
    const policyFirst = policy.find(st => st.type === 'review')?.participants[0] ?? policy[0]?.participants[0];
    const agentsList = part.agents.filter(a => a.status !== 'terminated').map(a => ({ kind: 'agent' as const, id: a.id, name: a.name, suggested: policyFirst ? policyFirst.kind === 'agent' && policyFirst.id === a.id : qa(a) }));
    const hasQa = agentsList.some(a => a.suggested) || Boolean(policyFirst), me = await this.d.reader.me();
    // The default reviewer: a QA agent; otherwise whoever opened the task (the originator). Anyone else in the org can be picked.
    const people = (part.people ?? []).filter(p => p.id !== me?.id).map(p => ({ kind: 'user' as const, id: p.id, name: p.name, suggested: policyFirst ? policyFirst.kind === 'user' && policyFirst.id === p.id : !hasQa && p.id === task.createdByUserId }));
    const reviewers: HandBackPreview['reviewers'] = [...agentsList, ...people].sort((a, b) => Number(b.suggested) - Number(a.suggested) || a.name.localeCompare(b.name));
    return {
      taskId: lease.taskId, branch: lease.branch ?? '', testsRun, testsLine: newest ? newest.body.replace(/^\*\*Test results\*\*\s*/, '').trim() : testsRun ? 'A test command ran in this task.' : 'No test command ran yet.',
      prUrl: lease.prUrl, summary: `${lease.key}: ${lease.title}`, decisions, reviewers, policy, reviewedLocally: lease.reviewChats.map(r => r.label), blocked: testsRun ? null : 'Run the tests, or write why they were not run.',
    };
  }
  async handBack(input: HandBackInput): Promise<LeaseView> {
    const lease = this.requireOpen(input.taskId), { company, part, task, me, backend } = await this.locate(lease.taskId);
    const receipts = this.d.store.receipts(lease.taskId), testsRun = receipts.some(r => r.tests > 0);
    if (!testsRun && !input.testsNote?.trim()) throw new Error('Run the tests, or write why they were not run.');
    const reviewer = part.agents.find(a => a.id === input.reviewer.id && input.reviewer.kind === 'agent');
    const person = input.reviewer.kind === 'user' ? part.people?.find(p => p.id === input.reviewer.id) : undefined;
    const reviewerName = input.reviewer.kind === 'agent' ? reviewer?.name ?? (() => { throw new Error('That reviewer is not on the server.'); })() : person?.name ?? 'the reviewer';
    const at = iso(this.d.now());
    // 1. push the branch, open or link the PR
    let prUrl = input.prUrl?.trim() || lease.prUrl, pushNote = '';
    if (lease.worktree && lease.branch && input.push !== false) {
      const pushed = await this.d.git.push(lease.worktree, lease.branch);
      if (!pushed.pushed) pushNote = pushed.message;
      if (pushed.pushed && !prUrl && this.d.openPr) prUrl = await this.d.openPr(lease.worktree, lease.previous.status ? (this.d.store.binding(this.d.serverLabel(), company.id, task.projectId ?? '')?.devBranch ?? 'main') : 'main', `${task.key}: ${task.title}`, `Server task ${task.key}. Handed back from Muster.`).catch(() => null) ?? null;
    }
    if (prUrl) this.d.store.enqueue({ taskId: lease.taskId, orgId: lease.orgId, type: 'comment', key: `pr:${hash(prUrl)}`, kind: 'pr', body: prReport(`pr:${hash(prUrl)}`, at, prUrl, lease.branch ?? '').body, at });
    // 2. the evidence: the newest test result, else the written reason
    const parsed = await this.testResult(lease.chatId ?? '').catch(() => null);
    const tests: TestResult = testsRun ? { ran: true, passed: parsed?.passed, failed: parsed?.failed, baselineFailed: null } : { ran: false, note: input.testsNote };
    const decisions = this.d.store.history(lease.taskId, 'decision').map(r => r.body.replace(/^\*\*Decision\*\*\s*/, '').trim());
    const total = receipts.reduce((t, r) => ({ added: t.added + (r.files?.added ?? 0), removed: t.removed + (r.files?.removed ?? 0), files: Math.max(t.files, r.files?.count ?? 0) }), { added: 0, removed: 0, files: 0 });
    const strategy = this.strategy.apply({ backend, task, reviewer: input.reviewer, reviewerName });
    const summary = handBackBody({ branch: lease.branch ?? '', changed: `${total.files} ${total.files === 1 ? 'file' : 'files'} changed (+${total.added} −${total.removed}) over ${receipts.length} local ${receipts.length === 1 ? 'turn' : 'turns'}. The log is in the “Local work log” document.`, decisions, tests, prUrl: prUrl ?? null, reviewedLocally: lease.reviewChats.map(r => r.label), openQuestions: [input.openQuestions?.trim(), pushNote ? `${pushNote} Muster will not retry the push by itself; push \`${lease.branch}\` when you are online.` : ''].filter(Boolean).join('\n\n') || undefined, reviewerName, summary: input.summary }) + `\n\n${strategy.mentionLine}`;
    const key = `handback:${at}`;
    // 3. the summary comment and the reassignment, in that order, through the outbox. The lease ends only after both are queued.
    this.d.store.enqueue({ taskId: lease.taskId, orgId: lease.orgId, type: 'comment', key, kind: 'handback', body: summary, at });
    this.enqueuePatch(lease.taskId, lease.orgId, key, strategy.patch, at);
    this.d.store.markDocDirty(lease.taskId);
    const ended = transition(lease, { type: 'handback', at, prUrl: prUrl ?? null });
    this.d.store.putLease(ended);
    await this.flush(lease.taskId);
    void me;
    this.d.emit(lease.taskId);
    return this.view(this.d.store.lease(lease.taskId)!);
  }

  // --- release and the escape hatch ----------------------------------------------------------------------------------------------------------
  async release(ref: string, note?: string): Promise<LeaseView> {
    const lease = this.requireOpen(ref), at = iso(this.d.now());
    const key = `release:${at}`;
    this.d.store.enqueue({ taskId: lease.taskId, orgId: lease.orgId, type: 'comment', key, kind: 'release', body: releaseBody(lease.device, note), at });
    const back = lease.previous;
    // Back as it was: the old agent (it wakes again), or the person's own task, or whoever held it, in the status it had.
    const status: WorkspaceStatus = back.status;
    this.enqueuePatch(lease.taskId, lease.orgId, key, { status, assigneeUserId: back.assigneeAgentId ? null : back.assigneeUserId, assigneeAgentId: back.assigneeAgentId }, at);
    this.d.store.putLease(transition(lease, { type: 'release', at }));
    await this.flush(lease.taskId);
    this.d.emit(lease.taskId);
    return this.view(this.d.store.lease(lease.taskId)!);
  }
  /** Explicit: the task's agent runs it on the server while it stays the person's (they remain accountable). Off by default. */
  async runOnServer(ref: string, on: boolean): Promise<LeaseView> {
    const lease = this.requireOpen(ref), { me, part } = await this.locate(lease.taskId), at = iso(this.d.now());
    const agentId = lease.model.kind === 'org-agent' ? lease.model.agentId : lease.previous.assigneeAgentId ?? part.agents.find(a => a.role === 'ceo')?.id;
    if (on && !agentId) throw new Error('No org agent is available to run this on the server.');
    const key = `server:${on}:${at}`;
    const agent = part.agents.find(a => a.id === agentId);
    this.d.store.enqueue({ taskId: lease.taskId, orgId: lease.orgId, type: 'comment', key, kind: 'note', at, body: on ? `Running this on the server with ${agent?.name ?? 'the org agent'} · it stays with ${me.name ?? 'me'} · via Muster` : 'Back on this Mac · via Muster' });
    this.enqueuePatch(lease.taskId, lease.orgId, key, on ? { assigneeAgentId: agentId, assigneeUserId: null, status: 'in_progress' } : { assigneeUserId: me.id, assigneeAgentId: null }, at);
    this.d.store.putLease(transition(lease, { type: 'run-on-server', on, at }));
    await this.flush(lease.taskId);
    this.d.emit(lease.taskId);
    return this.view(this.d.store.lease(lease.taskId)!);
  }
  // --- offline, queued posts, conflicts --------------------------------------------------------------------------------------------------------
  /** "Work offline": nothing is sent until it is switched off. Turning it off re-reads the task, then sends the queue in order. */
  async setOffline(ref: string, on: boolean): Promise<LeaseView> {
    const lease = this.d.store.leases().filter(l => l.taskId === ref || l.key === ref).sort((a, b) => b.since.localeCompare(a.since))[0];
    if (!lease) throw new LeaseError('This task is not checked out.', 'none');
    const at = iso(this.d.now());
    this.d.store.putLease(on ? transition(lease, { type: 'offline', at, mode: 'manual' }) : { ...transition(lease, { type: 'online', at }), recheck: true });
    this.d.emit(lease.taskId);
    if (!on) await this.flush(lease.taskId);
    return this.view(this.d.store.lease(lease.taskId)!);
  }
  pending(ref: string): { rows: PendingPost[]; conflict: CheckoutLease['conflict'] } {
    const lease = this.d.store.leases().find(l => l.taskId === ref || l.key === ref);
    if (!lease) return { rows: [], conflict: null };
    const rows = this.d.store.pending(lease.taskId).map((r): PendingPost => ({ id: r.id, type: r.type, kind: r.kind, at: r.at, body: r.type === 'comment' ? r.body : '', editable: r.type === 'comment', summary: pendingSummary(r.type, r.kind, r.body) }));
    return { rows, conflict: lease.conflict };
  }
  editPending(id: number, body: string): void {
    const row = this.d.store.row(id);
    if (!row || row.postedAt || row.type !== 'comment') throw new Error('That update was already sent, or cannot be edited.');
    if (!body.trim()) throw new Error('A comment cannot be empty. Discard it instead.');
    this.d.store.editBody(id, body.trim());
    this.d.emit(row.taskId);
  }
  /** After a conflict: Send anyway posts the queue as it is (edit first with `editPending`), Discard drops it. */
  async resolve(ref: string, choice: 'send' | 'discard'): Promise<LeaseView> {
    const lease = this.d.store.leases().find(l => l.taskId === ref || l.key === ref);
    if (!lease) throw new LeaseError('This task is not checked out.', 'none');
    if (choice === 'discard') { this.d.store.discard(lease.taskId); this.d.store.putLease(transition(lease, { type: 'resolve', at: iso(this.d.now()) })); this.d.emit(lease.taskId); }
    else { this.d.store.putLease(transition(lease, { type: 'resolve', at: iso(this.d.now()) })); await this.flush(lease.taskId, true); }
    return this.view(this.d.store.lease(lease.taskId)!);
  }
  remind(ref: string): void { const lease = this.requireOpen(ref); this.d.store.putLease(transition(lease, { type: 'remind', at: iso(this.d.now()) })); this.d.emit(lease.taskId); }

  // --- reads ------------------------------------------------------------------------------------------------------------------------------------
  get(ref: string): LeaseView | null { const l = this.d.store.leases().find(x => x.taskId === ref || x.key === ref); return l ? this.view(l) : null; }
  leases(): LeaseView[] { return this.d.store.leases().map(l => this.view(l)); }
  private requireOpen(ref: string): CheckoutLease {
    const lease = this.d.store.leases().filter(l => l.taskId === ref || l.key === ref).sort((a, b) => b.since.localeCompare(a.since))[0];
    if (!lease) throw new LeaseError('This task is not checked out.', 'none');
    if (lease.state !== 'checked_out') throw new LeaseError('This task was already handed back or released.', 'ended');
    return lease;
  }
}

/** One line for a queued post in the "N updates waiting" list. */
const pendingSummary = (type: string, kind: string, body: string): string => type === 'patch' ? 'Change the task’s status and assignee' : type === 'cost' ? 'Cost entry for a local turn'
  : ({ checkout: 'Check-out comment', decision: 'Decision', context: 'Context summary', pr: 'Pull request link', tests: 'Test results', handback: 'Hand-back summary', release: 'Release note', note: 'Note' } as Record<string, string>)[kind] ?? `Comment: ${body.slice(0, 60)}`;
const message = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
/** A short stable hash for report keys (not security). */
export function hash(text: string): string { let h = 5381; for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }

/** Pass and fail counts from the last test summary in some output: node:test, Jest/Vitest and pytest. */
export function parseTestSummary(output: string): { passed: number; failed: number } | null {
  const text = output.replace(/\u001b\[[0-9;]*m/g, '');
  const tap = [...text.matchAll(/^ℹ pass (\d+)[^]*?^ℹ fail (\d+)/gm)].at(-1);
  if (tap) return { passed: Number(tap[1]), failed: Number(tap[2]) };
  // Jest, Vitest and pytest print "N failed, M passed" on one line near the end.
  const line = text.split('\n').reverse().find(l => /\b\d+ (passed|failed)\b/.test(l));
  if (line) return { passed: Number(/(\d+) passed/.exec(line)?.[1] ?? 0), failed: Number(/(\d+) failed/.exec(line)?.[1] ?? 0) };
  return null;
}
