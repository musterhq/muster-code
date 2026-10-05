/** The Paperclip implementation of `ServerBackend`: the existing REST client and mappers, behind the shared interface. */
import type { LedgerEntry, TaskCreateInput, ThreadCard, WorkspaceAgent, WorkspaceComment, WorkspaceCompany, WorkspaceListKind, WorkspaceRow, WorkspaceRun, WorkspaceTask, WorkspaceTaskDetail } from '../../shared/domains/paperclip-protocol.ts';
import { arr, buildInbox, mapAgent, mapApproval, mapAttention, mapComment, mapCompany, mapDocument, mapGoal, mapInteraction, mapIssue, mapMentions, mapPeople, mapProject, mapReceipt, mapRows, mapRun, mapWorkProduct } from '../paperclip-map.ts';
import { PaperclipClient, PaperclipError, openLiveEvents, type SocketFactory } from '../paperclip-client.ts';
import { toolsFromLog } from './paperclip-run-tools.ts';
import type { BackendOptions, ImportReader, Json, LiveHandlers, PersonalAccess, ServerBackend, ServerEndpoint, ServerHealth, ServerPart, ServerPerson, TaskChanges, TaskCommentRow, TaskDetailContext } from './backend.ts';

const allPages = async <T>(pages: AsyncIterable<T[]>): Promise<T[]> => { const rows: T[] = []; for await (const page of pages) for (const row of page) rows.push(row); return rows; };
const enc = encodeURIComponent;
/** How much of a run's log is scanned for tool calls. */
const LOG_BYTES = 2_000_000;

export class PaperclipBackend implements ServerBackend, PersonalAccess {
  readonly kind = 'paperclip' as const;
  readonly client: PaperclipClient;
  private readonly onUnauthorized: BackendOptions['onUnauthorized'];
  private readonly session: BackendOptions['session'];
  constructor(endpoint: ServerEndpoint, options: BackendOptions = {}) { this.onUnauthorized = options.onUnauthorized; this.session = options.session; this.client = new PaperclipClient(endpoint, options.fetch, { cache: options.cache, onUnauthorized: options.onUnauthorized }); }
  get endpoint(): ServerEndpoint { return this.client.endpoint; }
  get generation(): number { return this.client.generation; }
  invalidate(prefix?: string): void { this.client.invalidate(prefix); }

  async health(): Promise<ServerHealth> {
    const health = await this.client.get<Json>('/health');
    return { version: typeof health.version === 'string' ? health.version : undefined, deploymentMode: typeof health.deploymentMode === 'string' ? health.deploymentMode : undefined, compatibility: 'Paperclip-compatible' };
  }
  /** The signed-in person (`/cli-auth/me`, which a board key and the local board both answer). Cached for this connection; null (not asked again for a minute) when the server does not say. */
  private person: Promise<ServerPerson | null> | null = null;
  whoami(): Promise<ServerPerson | null> {
    this.person ??= this.client.get<Json>('/cli-auth/me').then(me => {
      const user = (me.user && typeof me.user === 'object' ? me.user : {}) as Json, id = typeof me.userId === 'string' && me.userId ? me.userId : typeof user.id === 'string' ? user.id : null;
      return id ? { id, name: typeof user.name === 'string' ? user.name : null, email: typeof user.email === 'string' ? user.email : null } : null;
    }, () => { setTimeout(() => { this.person = null; }, 60_000).unref?.(); return null; });
    return this.person;
  }
  async patchTask(taskId: string, changes: { status?: string; assigneeUserId?: string | null; assigneeAgentId?: string | null; comment?: string; commentClientRequestId?: string }): Promise<void> {
    await this.client.send('PATCH', `/issues/${enc(taskId)}`, changes);
    this.client.invalidate();
  }
  async rawComments(taskId: string): Promise<TaskCommentRow[]> {
    const rows = await allPages(this.client.commentPages(taskId));
    return rows.filter(c => !c.deletedAt).map(c => ({ id: String(c.id), body: typeof c.body === 'string' ? c.body : '', authorUserId: typeof c.authorUserId === 'string' ? c.authorUserId : null, authorAgentId: typeof c.authorAgentId === 'string' ? c.authorAgentId : null, createdAt: String(c.createdAt ?? '') }));
  }
  async putDocument(taskId: string, key: string, doc: { title: string; body: string; changeSummary: string }): Promise<void> {
    const path = `/issues/${enc(taskId)}/documents/${enc(key)}`;
    // An existing document needs its latest revision as the base; a new one has none.
    const existing = await this.client.get<Json>(path).catch(() => null);
    await this.client.send('PUT', path, { title: doc.title, format: 'markdown', body: doc.body, changeSummary: doc.changeSummary, ...(existing && typeof existing.latestRevisionId === 'string' ? { baseRevisionId: existing.latestRevisionId } : {}) });
  }
  async postCostEvent(companyId: string, body: Record<string, unknown>): Promise<void> { await this.client.send('POST', `/companies/${enc(companyId)}/cost-events`, body); }
  async issuePolicy(taskId: string): Promise<{ type: 'review' | 'approval'; participants: { kind: 'agent' | 'user'; id: string }[] }[]> {
    const issue = await this.client.get<Json>(`/issues/${enc(taskId)}`);
    const policy = (issue.executionPolicy && typeof issue.executionPolicy === 'object' ? issue.executionPolicy : {}) as Json;
    return arr(policy.stages).filter(st => st.type === 'review' || st.type === 'approval').map(st => ({
      type: st.type as 'review' | 'approval',
      participants: arr(st.participants).map(p => p.type === 'agent' && typeof p.agentId === 'string' ? { kind: 'agent' as const, id: p.agentId } : typeof p.userId === 'string' ? { kind: 'user' as const, id: p.userId } : null).filter((p): p is { kind: 'agent' | 'user'; id: string } => Boolean(p)),
    }));
  }
  async agentInstructions(agentId: string): Promise<string> {
    const bundle = await this.client.get<Json>(`/agents/${enc(agentId)}/instructions-bundle`);
    const entry = typeof bundle.entryFile === 'string' ? bundle.entryFile : 'AGENTS.md';
    const file = await this.client.get<Json>(`/agents/${enc(agentId)}/instructions-bundle/file?path=${enc(entry)}`);
    return typeof file.content === 'string' ? file.content : '';
  }

  async companies(): Promise<WorkspaceCompany[]> { return arr(await this.client.get<unknown>('/companies')).filter(c => c.status !== 'archived').map(mapCompany); }

  async read(company: WorkspaceCompany, previous?: { generation: number; companyId: string; part: ServerPart }, options: { fresh?: boolean } = {}): Promise<ServerPart> {
    const api = this.client, id = company.id, base = `/companies/${enc(id)}`;
    const [issues, agentsJson, projectsJson, goalsJson, runsJson, liveJson, attentionJson, approvalsJson, labelsJson, activityJson, directoryJson] = await Promise.all([
      allPages(api.issuePages(id, 'view=compact&includeBlockedBy=true', options.fresh)), api.get<unknown>(`${base}/agents`), api.get<unknown>(`${base}/projects`),
      api.get<unknown>(`${base}/goals`).catch(() => []), api.get<unknown>(`${base}/heartbeat-runs?limit=60&summary=true`),
      api.get<unknown>(`${base}/live-runs`).catch(() => []), api.get<unknown>(`${base}/attention`).catch(() => ({ items: [] })),
      api.get<unknown>(`${base}/approvals`).catch(() => []), api.get<unknown>(`${base}/labels`).catch(() => []), api.get<unknown>(`${base}/activity?limit=100`).catch(() => []), api.get<unknown>(`${base}/user-directory`).catch(() => ({ users: [] })),
    ]);
    if (previous && previous.generation === api.generation && previous.companyId === id) return previous.part;
    const agentList = arr(agentsJson).map(mapAgent), agents = new Map(agentList.map(a => [a.id, a]));
    const runs = [...arr(liveJson), ...arr(runsJson)].map(mapRun).filter((run, index, all) => all.findIndex(r => r.id === run.id) === index).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const liveTasks = new Set(runs.filter(r => r.status === 'running' || r.status === 'queued').map(r => r.taskId).filter((t): t is string => Boolean(t)));
    for (const agent of agentList) if (agent.status === 'active' && runs.some(r => r.agentId === agent.id && r.status === 'running')) agent.status = 'running';
    const me = (await this.whoami().catch(() => null))?.id ?? null;
    const people = mapPeople(directoryJson), peopleNames = new Map(people.map(p => [p.id, p.name]));
    const tasks = arr(issues).map(i => mapIssue(i, agents, liveTasks, me, peopleNames));
    // Memory counts are added per snapshot (not here), so the light badge read never browses memory.
    const projects = arr(projectsJson).map(p => mapProject(p, tasks));
    const projectName = new Map(projects.map(p => [p.id, p.name]));
    const inbox = [...buildInbox(arr((attentionJson as Json).items).map(mapAttention), tasks, runs, agents), ...mapMentions(arr(activityJson), me, agents, peopleNames)].map(item => {
      const projectId = item.taskId ? tasks.find(t => t.id === item.taskId)?.projectId ?? null : null;
      return { ...item, projectId, group: projectId ? projectName.get(projectId) ?? company.name : company.name, source: 'paperclip' as const };
    });
    const approvals = arr(approvalsJson).filter(a => a.status === 'pending' || a.status === 'revision_requested').map(a => mapApproval(a, agents));
    const labels = arr(labelsJson).map(l => ({ id: String(l.id), name: typeof l.name === 'string' ? l.name : 'Label', color: typeof l.color === 'string' ? l.color : null }));
    return { tasks, agents: agentList, projects, runs, inbox, goals: arr(goalsJson).map(mapGoal), approvals, labels, people };
  }

  async task(taskId: string, ctx: { agents: ReadonlyMap<string, WorkspaceAgent>; people: readonly { id: string; name: string }[]; live: ReadonlySet<string> }): Promise<WorkspaceTask | null> {
    let issue: Json;
    try { issue = await this.client.get<Json>(`/issues/${enc(taskId)}`); }
    catch (cause) { if (cause instanceof PaperclipError && cause.status === 404) return null; throw cause; }
    const me = (await this.whoami().catch(() => null))?.id ?? null;
    return mapIssue(issue, ctx.agents, ctx.live, me, new Map(ctx.people.map(p => [p.id, p.name])));
  }
  async taskDetail(taskId: string, ctx: TaskDetailContext): Promise<WorkspaceTaskDetail> {
    const c = this.client, agents = ctx.agents, part = ctx.part, key = enc(taskId);
    const [issue, comments, runs, interactions, approvals, documents, products] = await Promise.all([
      c.get<Json>(`/issues/${key}`), allPages(c.commentPages(taskId)), c.get<unknown>(`/issues/${key}/runs`).catch(() => []),
      c.get<unknown>(`/issues/${key}/interactions`).catch(() => []), c.get<unknown>(`/issues/${key}/approvals`).catch(() => []),
      c.get<unknown>(`/issues/${key}/documents`).catch(() => []), c.get<unknown>(`/issues/${key}/work-products`).catch(() => []),
    ]);
    // Documents with their revisions (a plan is the one with key `plan`), and the PRs, branches and artifacts agents produced.
    const documentCards = await Promise.all(arr(documents).map(async d => mapDocument(d, Number(d.latestRevisionNumber) > 1 ? arr(await c.get<unknown>(`/issues/${key}/documents/${enc(String(d.key))}/revisions`).catch(() => [])) : [], agents)));
    const liveTasks = new Set((part?.runs ?? []).filter(r => r.status === 'running').map(r => r.taskId).filter((t): t is string => Boolean(t)));
    const peopleNames = new Map((part?.people ?? []).map(p => [p.id, p.name])), meId = (await this.whoami().catch(() => null))?.id ?? null;
    const task = mapIssue(issue, agents, liveTasks, meId, peopleNames);
    const taskRuns = arr(runs).map(mapRun);
    if (taskRuns.some(r => r.status === 'running' || r.status === 'queued')) task.live = true;
    const assignee = task.assigneeId ? agents.get(task.assigneeId) : undefined;
    const children = (part?.tasks ?? []).filter(t => t.parentId === task.id);
    const cards: ThreadCard[] = [
      ...children.map(child => ({ kind: 'delegated' as const, id: `delegated:${child.id}`, at: child.createdAt, from: task.assigneeLabel ?? child.origin, to: child.assigneeLabel, taskId: child.id, key: child.key, title: child.title, brief: `${child.key} · ${child.title}` })),
      ...arr(interactions).map(i => mapInteraction(i, agents)), ...documentCards, ...arr(products).map(mapWorkProduct),
      ...arr(approvals).map(a => {
        const m = mapApproval(a, agents), open = a.status === 'pending' || a.status === 'revision_requested', payload = (a.payload ?? {}) as Json;
        return { kind: 'approval' as const, id: `approval:${a.id}`, at: String(a.createdAt ?? ''), title: open ? m.title : String(payload.title ?? payload.name ?? a.type ?? 'Approval'), status: String(a.status ?? 'pending'), ...(open ? { approvalId: String(a.id), detail: m.detail, requestedBy: m.requestedBy, verbs: m.verbs } : {}) };
      }),
    ];
    // Hand-offs: when the task moved to another agent (or came from its parent's owner), carry the Muster memory with it.
    const parent = task.parentId ? part?.tasks.find(t => t.id === task.parentId) : undefined;
    if (parent && parent.assigneeLabel && task.assigneeLabel && parent.assigneeLabel !== task.assigneeLabel) {
      const memory = await ctx.memory(task.id).catch(() => []);
      cards.push({ kind: 'handoff', id: `handoff:${task.id}`, at: task.createdAt, from: parent.assigneeLabel, to: task.assigneeLabel, summary: `${parent.key} → ${task.key}`, memory });
    }
    return {
      task, description: typeof issue.description === 'string' ? issue.description : '', comments: arr(comments).filter(x => !x.deletedAt).map(x => mapComment(x, agents, meId, peopleNames)),
      runs: taskRuns.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20),
      addressee: assignee ? { id: assignee.id, label: assignee.name } : null,
      composerNote: assignee ? null : task.assigneeUserId ? `With ${task.assigneeLabel ?? 'a person'}. Your comment is posted to the thread; @-mention a person or agent to bring them in.` : 'Unassigned. Your comment is posted to the thread; @-mention a person or agent to bring them in.',
      subtasks: children.map(t => t.id), blocking: (part?.tasks ?? []).filter(t => t.blockedByIds.includes(task.id)).map(t => t.id),
      receipts: arr(runs).map(r => mapReceipt(r, agents)).sort((a, b) => b.endedAt.localeCompare(a.endedAt)).slice(0, 50),
      cards: cards.sort((a, b) => a.at.localeCompare(b.at)),
      mentionable: [...(part?.people ?? []).filter(p => p.id !== meId).map(p => ({ id: p.id, name: p.name, kind: 'user' as const })), ...(part?.agents ?? []).filter(a => a.status !== 'terminated').map(a => ({ id: a.id, name: a.name, kind: 'agent' as const }))],
    };
  }

  async comment(taskId: string, body: string, agents: ReadonlyMap<string, WorkspaceAgent>, clientRequestId?: string): Promise<WorkspaceComment> {
    return mapComment(await this.client.send<Json>('POST', `/issues/${enc(taskId)}/comments`, { body, ...(clientRequestId ? { clientRequestId } : {}) }), agents);
  }
  async updateTask(taskId: string, changes: TaskChanges, agents: ReadonlyMap<string, WorkspaceAgent>): Promise<WorkspaceTask> {
    // Only what you changed is sent: the server's own PATCH, user-initiated.
    return mapIssue(await this.client.send<Json>('PATCH', `/issues/${enc(taskId)}`, changes), agents, new Set());
  }
  async createTask(input: TaskCreateInput, company: WorkspaceCompany, agents: ReadonlyMap<string, WorkspaceAgent>): Promise<WorkspaceTask> {
    const id = (value: unknown) => { if (typeof value !== 'string' || !/^[\w:.-]{1,128}$/.test(value)) throw new Error('Unknown item.'); return value; };
    const title = typeof input.title === 'string' && input.title.trim() ? input.title : (() => { throw new Error('Title is required.'); })();
    const body: Json = { title: title.slice(0, 500), status: 'todo', description: typeof input.description === 'string' ? input.description.slice(0, 20_000) : '', projectId: input.projectId };
    if (typeof input.priority === 'string' && ['critical', 'high', 'medium', 'low'].includes(input.priority)) body.priority = input.priority;
    if (typeof input.parentId === 'string' && input.parentId) body.parentId = id(input.parentId);
    if (typeof input.assigneeId === 'string' && input.assigneeId) { if (input.assigneeId.startsWith('user:')) body.assigneeUserId = id(input.assigneeId.slice(5)); else body.assigneeAgentId = id(input.assigneeId); }
    // Labels, a goal and the tasks that block this one: the server's own fields on create.
    if (Array.isArray(input.labelIds) && input.labelIds.length) body.labelIds = [...new Set(input.labelIds.slice(0, 20).map(v => id(v)))];
    if (typeof input.goalId === 'string' && input.goalId) body.goalId = id(input.goalId);
    if (Array.isArray(input.blockedByIds) && input.blockedByIds.length) body.blockedByIssueIds = [...new Set(input.blockedByIds.slice(0, 50).map(v => id(v)))];
    return mapIssue(await this.client.send<Json>('POST', `/companies/${enc(company.id)}/issues`, body), agents, new Set());
  }
  async pauseAgent(id: string): Promise<void> { await this.client.send('POST', `/agents/${enc(id)}/pause`); }
  async resumeAgent(id: string): Promise<void> { await this.client.send('POST', `/agents/${enc(id)}/resume`); }
  async cancelRun(id: string): Promise<void> { await this.client.send('POST', `/heartbeat-runs/${enc(id)}/cancel`); }
  async decideApproval(id: string, decision: 'approve' | 'reject' | 'request_revision', note: string | null): Promise<void> {
    const path = decision === 'approve' ? 'approve' : decision === 'reject' ? 'reject' : 'request-revision';
    await this.client.send('POST', `/approvals/${enc(id)}/${path}`, { decisionNote: note });
  }
  async respond(taskId: string, interactionId: string, input: { accept: boolean; reason?: string; answers?: { questionId: string; optionIds: string[]; otherText?: string | null }[] }): Promise<void> {
    const base = `/issues/${enc(taskId)}/interactions/${enc(interactionId)}`;
    if (input.answers) { await this.client.send('POST', `${base}/respond`, { answers: input.answers }); return; }
    await this.client.send('POST', `${base}/${input.accept ? 'accept' : 'reject'}`, input.accept ? {} : { ...(input.reason ? { reason: input.reason } : {}) });
  }

  async receipts(company: WorkspaceCompany, limit: number, agents: ReadonlyMap<string, WorkspaceAgent>): Promise<LedgerEntry[]> {
    const runs = await this.client.get<unknown>(`/companies/${enc(company.id)}/heartbeat-runs?limit=${Math.min(limit, 200)}`).catch(() => []);
    return arr(runs).map(r => mapReceipt(r, agents));
  }
  async dashboard(company: WorkspaceCompany, agents: ReadonlyMap<string, WorkspaceAgent>): Promise<{ receipts: LedgerEntry[]; activity: WorkspaceRow[]; budgets?: unknown }> {
    const base = `/companies/${enc(company.id)}`;
    const [runs, activity, overview] = await Promise.all([this.client.get<unknown>(`${base}/heartbeat-runs?limit=200`).catch(() => []), this.client.get<unknown>(`${base}/activity?limit=12`).catch(() => []), this.client.get<unknown>(`${base}/budgets/overview`).catch(() => null)]);
    return { receipts: arr(runs).map(r => mapReceipt(r, agents)), activity: mapRows('audit', activity), ...(overview ? { budgets: overview } : {}) };
  }
  async rows(kind: WorkspaceListKind, company: WorkspaceCompany): Promise<WorkspaceRow[]> {
    const base = `/companies/${enc(company.id)}`;
    return mapRows(kind, await this.client.get<unknown>(kind === 'artifacts' ? `${base}/artifacts` : kind === 'audit' ? `${base}/activity?limit=150` : `${base}/routines`));
  }
  async runDetail(runId: string, agents: ReadonlyMap<string, WorkspaceAgent>): Promise<{ run: WorkspaceRun; receipt: LedgerEntry } | null> {
    let raw: Json;
    try { raw = await this.client.get<Json>(`/heartbeat-runs/${enc(runId)}`); } catch (cause) { if (cause instanceof PaperclipError && cause.status === 404) return null; throw cause; }
    const receipt = mapReceipt(raw, agents), run = mapRun(raw);
    // The run's tool use is in its log. If the log cannot be read the receipt stays `unfetched`: "not read", never "none recorded".
    try {
      const log = await this.client.get<Json>(`/heartbeat-runs/${enc(runId)}/log?limitBytes=${LOG_BYTES}`);
      if (typeof log.content === 'string') { const { tools, tests } = toolsFromLog(log.content); delete receipt.toolsState; receipt.tools = tools; receipt.tests = tests; }
    } catch { /* keep unfetched */ }
    return { run, receipt };
  }
  linkFor(company: WorkspaceCompany, target: { runId?: string; agentId?: string | null; taskKey?: string }): string | null {
    const base = `${this.client.endpoint.baseUrl}/${company.prefix ? `${enc(company.prefix)}/` : ''}`;
    if (target.runId && target.agentId) return `${base}agents/${enc(target.agentId)}/runs/${enc(target.runId)}`;
    if (target.taskKey) return `${base}issues/${enc(target.taskKey)}`;
    return null;
  }
  importReader(): ImportReader {
    // The importer reads each page once: it keeps no parsed bodies, so a large org never sits in memory twice.
    const reader = new PaperclipClient(this.client.endpoint, this.fetcher, { cache: false, onUnauthorized: this.onUnauthorized });
    return { get: path => reader.get<unknown>(path), issuePages: (company, query) => reader.issuePages(company, query), commentPages: issue => reader.commentPages(issue) };
  }
  private get fetcher() { return this.client.fetcher; }
  openLive(company: WorkspaceCompany, handlers: LiveHandlers, factory?: SocketFactory) { return openLiveEvents(this.client, company.id, handlers, factory, this.session); }
}
export type { WorkspaceAgent };
