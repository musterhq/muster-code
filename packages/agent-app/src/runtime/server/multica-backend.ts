/**
 * The Multica implementation of `ServerBackend` (https://github.com/multica-ai/multica): a Multica server's REST API, read and written with
 * a personal access token (`mul_…`, Multica › Settings › Tokens, or the one `multica login` makes), sent as `Authorization: Bearer` to the
 * server's own origin only and never through a redirect.
 *
 * How Multica's concepts land in the shared workspace shapes:
 * - a Multica **workspace** is an org (`WorkspaceCompany`); every workspace-scoped call names it in `X-Workspace-ID`, as Multica's CLI does;
 * - **projects** (`title`) and **issues** (`identifier` such as `RAGN-180`) are projects and tasks;
 * - **statuses** are Multica's seven built-in keys, the same seven Muster uses; a custom status falls back to its lifecycle category;
 * - **priorities**: Multica's `urgent` is Muster's Critical; `none` reads as Low and is never sent back unless you change it;
 * - **assignees** are a member (`assignee_type: member`, the person's user id) or an agent (`agent`); a squad is shown by name and kept;
 * - **comments** are `content` in Markdown. Muster writes mentions as `[@Name](agent://id)` / `(user://id)`; they are sent in Multica's
 *   own form, `[@Name](mention://agent/id)` / `(mention://member/id)`, so a mention wakes the agent or notifies the person the way it does in Multica.
 *
 * Multica has no run list, approvals, documents or cost events in this API, so those reads are empty and the check-out's work log and cost
 * events are not sent (said in the hand-back instead). Live updates poll (Multica's `/ws` takes a browser session, not a token).
 */
import type { LedgerEntry, TaskCreateInput, WorkspaceAgent, WorkspaceComment, WorkspaceCompany, WorkspaceListKind, WorkspacePriority, WorkspaceProject, WorkspaceRow, WorkspaceStatus, WorkspaceTask, WorkspaceTaskDetail } from '../../shared/domains/paperclip-protocol.ts';
import { WORKSPACE_STATUSES } from '../../shared/domains/paperclip-protocol.ts';
import { PaperclipError, type LiveSocket } from '../paperclip-client.ts';
import type { BackendOptions, ImportReader, Json, LiveHandlers, PersonalAccess, ServerBackend, ServerEndpoint, ServerHealth, ServerPart, ServerPerson, TaskChanges, TaskCommentRow, TaskDetailContext } from './backend.ts';

const TIMEOUT_MS = 15_000;
/** Multica lists at most 100 issues a page; a workspace is read up to this many pages (2,000 issues). */
const ISSUE_PAGE = 100, MAX_ISSUE_PAGES = 20;
/** The agent list carries each agent's whole instructions; it, the members and the labels are read at most this often. */
const SLOW_MS = 60_000;
const enc = encodeURIComponent;
const str = (v: unknown): string | null => typeof v === 'string' && v ? v : null;
const arr = (v: unknown): Json[] => Array.isArray(v) ? v.filter((x): x is Json => Boolean(x) && typeof x === 'object') : [];
const hostOf = (baseUrl: string) => { try { return new URL(baseUrl).host; } catch { return baseUrl; } };

/** Multica's priority words and Muster's. */
const FROM_PRIORITY: Record<string, WorkspacePriority> = { urgent: 'critical', high: 'high', medium: 'medium', low: 'low', none: 'low' };
const TO_PRIORITY: Record<WorkspacePriority, string> = { critical: 'urgent', high: 'high', medium: 'medium', low: 'low' };
/** A custom status keeps its lifecycle: what Muster shows for each of Multica's four categories. */
const FROM_CATEGORY: Record<string, WorkspaceStatus> = { unstarted: 'todo', started: 'in_progress', done: 'done', closed: 'cancelled' };
const statusOf = (i: Json): WorkspaceStatus => (WORKSPACE_STATUSES as readonly string[]).includes(String(i.status)) ? i.status as WorkspaceStatus : FROM_CATEGORY[String(i.status_category)] ?? 'todo';
const AGENT_STATE: Record<string, WorkspaceAgent['status']> = { idle: 'idle', working: 'running', blocked: 'paused', error: 'error', offline: 'idle' };

/** Muster's mention links in Multica's own form (and back, for reading Muster's footers and markers). */
export const toMulticaMentions = (body: string) => body.replace(/\]\(agent:\/\/([0-9A-Za-z-]+)\)/g, '](mention://agent/$1)').replace(/\]\(user:\/\/([0-9A-Za-z-]+)\)/g, '](mention://member/$1)');
const fromMulticaMentions = (body: string) => body.replace(/\]\(mention:\/\/agent\/([0-9A-Za-z-]+)\)/g, '](agent://$1)').replace(/\]\(mention:\/\/member\/([0-9A-Za-z-]+)\)/g, '](user://$1)');

export class MulticaBackend implements ServerBackend, PersonalAccess {
  readonly kind = 'multica' as const;
  generation = 0;
  private readonly request: (input: string, init?: RequestInit) => Promise<Response>;
  /** Which workspace each issue lives in (issue routes need the workspace header). Filled by every read. */
  private readonly issueWorkspace = new Map<string, string>();
  private readonly slugs = new Map<string, string>();
  private readonly slow = new Map<string, { at: number; value: unknown }>();
  private readonly signatures = new Map<string, string>();
  constructor(readonly endpoint: ServerEndpoint, private readonly options: BackendOptions = {}) { this.request = options.fetch ?? ((input, init) => fetch(input, init)); }
  invalidate(): void { this.signatures.clear(); }

  // --- transport ------------------------------------------------------------------------------------------------------------------
  /** One call. The token goes to this origin only (`redirect: 'error'`); errors carry the server's own `error` sentence. */
  async call<T>(method: string, path: string, options: { workspaceId?: string; body?: unknown } = {}): Promise<T> {
    const host = hostOf(this.endpoint.baseUrl);
    let response: Response;
    try {
      response = await this.request(`${this.endpoint.baseUrl}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: 'application/json', ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.endpoint.token ? { authorization: `Bearer ${this.endpoint.token}` } : {}), ...(options.workspaceId ? { 'x-workspace-id': options.workspaceId } : {}) },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
      throw new PaperclipError(`Multica at ${host} ${timedOut ? 'did not answer in time' : 'is not reachable'}.`, 0, 'network');
    }
    const text = await response.text().catch(() => '');
    let json: unknown = null;
    try { json = text ? JSON.parse(text) as unknown : null; } catch { /* not JSON */ }
    const said = json && typeof json === 'object' && !Array.isArray(json) && typeof (json as Json).error === 'string' ? String((json as Json).error) : text.trim().startsWith('<') ? '' : text.trim().slice(0, 300);
    if (response.status === 401) {
      const replaced = this.options.onUnauthorized?.(Boolean(this.endpoint.token), 401);
      if (replaced) throw new PaperclipError(replaced, 401, 'auth');
      throw new PaperclipError(this.endpoint.token ? `Multica at ${host} did not accept this token${said ? `: ${said}` : ''}. Create a new personal access token in Multica and connect again.` : `Multica at ${host} needs a personal access token. In Multica, create one (it starts with mul_) and paste it under Other ways to connect.`, 401, 'auth');
    }
    if (!response.ok) throw new PaperclipError(`Multica at ${host} said: ${said || `HTTP ${response.status}`}${said ? ` (${response.status})` : ''}.`, response.status, 'service');
    if (json === null && text) throw new PaperclipError(`${host} answered with something that is not Multica’s API (HTTP ${response.status}). Check the address.`, response.status, 'service');
    return json as T;
  }
  private get<T>(path: string, workspaceId?: string) { return this.call<T>('GET', path, workspaceId ? { workspaceId } : {}); }
  private async cached<T>(key: string, read: () => Promise<T>): Promise<T> {
    const hit = this.slow.get(key);
    if (hit && Date.now() - hit.at < SLOW_MS) return hit.value as T;
    const value = await read();
    this.slow.set(key, { at: Date.now(), value });
    return value;
  }
  /** The workspace an issue is in: known from a read, else asked of each workspace in turn. */
  private async workspaceOf(issueId: string): Promise<string> {
    const known = this.issueWorkspace.get(issueId);
    if (known) return known;
    for (const company of await this.companies()) {
      const issue = await this.get<Json>(`/api/issues/${enc(issueId)}`, company.id).catch(() => null);
      if (issue && typeof issue.id === 'string') { this.issueWorkspace.set(issueId, company.id); this.issueWorkspace.set(issue.id, company.id); if (typeof issue.identifier === 'string') this.issueWorkspace.set(issue.identifier, company.id); return company.id; }
    }
    throw new PaperclipError('That issue is not in any Multica workspace this token can open.', 404, 'service');
  }
  private remember(issue: Json, workspaceId: string): void { for (const key of [issue.id, issue.identifier]) if (typeof key === 'string') this.issueWorkspace.set(key, workspaceId); }

  // --- who and where ----------------------------------------------------------------------------------------------------------
  async health(): Promise<ServerHealth> {
    const health = await this.get<Json>('/health');
    const commit = str(health?.commit);
    return { version: commit ? commit.slice(0, 7) : undefined, deploymentMode: 'Multica', compatibility: 'Multica' };
  }
  private person: Promise<ServerPerson | null> | null = null;
  whoami(): Promise<ServerPerson | null> {
    this.person ??= this.get<Json>('/api/me').then(me => typeof me?.id === 'string' ? { id: me.id, name: str(me.name), email: str(me.email) } : null, cause => { this.person = null; throw cause; });
    return this.person;
  }
  async companies(): Promise<WorkspaceCompany[]> {
    const rows = arr(await this.get<unknown>('/api/workspaces'));
    for (const w of rows) if (typeof w.id === 'string' && typeof w.slug === 'string') this.slugs.set(w.id, w.slug);
    return rows.filter(w => typeof w.id === 'string').map(w => ({ id: String(w.id), name: str(w.name) ?? str(w.slug) ?? 'Workspace', prefix: str(w.issue_prefix) ?? '' }));
  }

  // --- reading ----------------------------------------------------------------------------------------------------------------
  private async issues(workspaceId: string): Promise<Json[]> {
    const out: Json[] = [];
    for (let page = 0; page < MAX_ISSUE_PAGES; page++) {
      const body = await this.get<Json>(`/api/issues?limit=${ISSUE_PAGE}&offset=${page * ISSUE_PAGE}`, workspaceId);
      const rows = arr(body?.issues);
      out.push(...rows);
      if (!body?.has_more || rows.length === 0) break;
    }
    return out;
  }
  private agentsOf(workspaceId: string) { return this.cached(`agents:${workspaceId}`, async () => arr(await this.get<unknown>('/api/agents', workspaceId)).map(a => mapAgent(a))); }
  private peopleOf(workspaceId: string) { return this.cached(`people:${workspaceId}`, async () => arr(await this.get<unknown>(`/api/workspaces/${enc(workspaceId)}/members`, workspaceId)).map(m => ({ id: String(m.user_id ?? m.id), name: str(m.name) ?? str(m.email)?.split('@')[0] ?? 'Member' }))); }
  private labelsOf(workspaceId: string) { return this.cached(`labels:${workspaceId}`, async () => arr((await this.get<Json>('/api/labels', workspaceId).catch(() => ({ labels: [] })))?.labels).map(l => ({ id: String(l.id), name: str(l.name) ?? 'Label', color: str(l.color) }))); }
  private names(agents: readonly WorkspaceAgent[], people: readonly { id: string; name: string }[], me: string | null) {
    return { agents: new Map(agents.map(a => [a.id, a])), people: new Map(people.map(p => [p.id, p.name])), me };
  }

  async read(company: WorkspaceCompany, previous?: { generation: number; companyId: string; part: ServerPart }): Promise<ServerPart> {
    const ws = company.id;
    const [issuesJson, projectsJson, agents, people, labels, me] = await Promise.all([
      this.issues(ws), this.get<Json>('/api/projects', ws), this.agentsOf(ws), this.peopleOf(ws).catch(() => []), this.labelsOf(ws), this.whoami().catch(() => null),
    ]);
    for (const i of issuesJson) this.remember(i, ws);
    const signature = JSON.stringify([issuesJson, projectsJson, agents, people, labels]);
    if (previous && previous.companyId === ws && previous.generation === this.generation && this.signatures.get(ws) === signature) return previous.part;
    this.signatures.set(ws, signature); this.generation++;
    const names = this.names(agents, people, me?.id ?? null);
    const tasks = issuesJson.map(i => mapIssue(i, names));
    const projects = arr(projectsJson?.projects).map(p => mapProject(p, tasks));
    return { tasks, agents, projects, runs: [], inbox: [], goals: [], approvals: [], labels, people };
  }
  async task(taskId: string, ctx: { agents: ReadonlyMap<string, WorkspaceAgent>; people: readonly { id: string; name: string }[] }): Promise<WorkspaceTask | null> {
    let ws: string;
    try { ws = await this.workspaceOf(taskId); } catch { return null; }
    let issue: Json;
    try { issue = await this.get<Json>(`/api/issues/${enc(taskId)}`, ws); } catch (cause) { if (cause instanceof PaperclipError && cause.status === 404) return null; throw cause; }
    const me = (await this.whoami().catch(() => null))?.id ?? null;
    return mapIssue(issue, { agents: ctx.agents, people: new Map(ctx.people.map(p => [p.id, p.name])), me });
  }
  async taskDetail(taskId: string, ctx: TaskDetailContext): Promise<WorkspaceTaskDetail> {
    const ws = await this.workspaceOf(taskId);
    const [issue, comments, me] = await Promise.all([this.get<Json>(`/api/issues/${enc(taskId)}`, ws), this.get<unknown>(`/api/issues/${enc(taskId)}/comments`, ws), this.whoami().catch(() => null)]);
    const people = ctx.part?.people ?? await this.peopleOf(ws).catch(() => []);
    const agentList = ctx.agents.size ? [...ctx.agents.values()] : await this.agentsOf(ws).catch(() => []);
    const names = this.names(agentList, people, me?.id ?? null);
    const task = mapIssue(issue, names);
    const assignee = task.assigneeId && !task.assigneeId.startsWith('user:') ? names.agents.get(task.assigneeId) : undefined;
    const children = (ctx.part?.tasks ?? []).filter(t => t.parentId === task.id);
    return {
      task, description: str(issue.description) ?? '',
      comments: arr(comments).map(c => mapComment(c, names)),
      runs: [], addressee: assignee ? { id: assignee.id, label: assignee.name } : null,
      composerNote: assignee ? null : `${task.assigneeLabel ? `With ${task.assigneeLabel}.` : 'Unassigned.'} Your comment is posted to the issue on Multica; @-mention a person or agent to bring them in.`,
      subtasks: children.map(t => t.id), blocking: [], receipts: [], cards: [],
      mentionable: [...people.filter(p => p.id !== me?.id).map(p => ({ id: p.id, name: p.name, kind: 'user' as const })), ...agentList.filter(a => a.status !== 'terminated').map(a => ({ id: a.id, name: a.name, kind: 'agent' as const }))],
    };
  }

  // --- acting (only ever sent when you press something; what comes back is the server's answer) -------------------------------
  async comment(taskId: string, body: string, agents: ReadonlyMap<string, WorkspaceAgent>): Promise<WorkspaceComment> {
    const ws = await this.workspaceOf(taskId);
    const created = await this.call<Json>('POST', `/api/issues/${enc(taskId)}/comments`, { workspaceId: ws, body: { content: toMulticaMentions(body) } });
    const me = (await this.whoami().catch(() => null))?.id ?? null;
    return mapComment(created, { agents, people: new Map(), me });
  }
  private assigneeBody(changes: { assigneeAgentId?: string | null; assigneeUserId?: string | null }): Json {
    if (changes.assigneeAgentId) return { assignee_type: 'agent', assignee_id: changes.assigneeAgentId };
    if (changes.assigneeUserId) return { assignee_type: 'member', assignee_id: changes.assigneeUserId };
    if (changes.assigneeAgentId !== undefined || changes.assigneeUserId !== undefined) return { assignee_type: null, assignee_id: null };
    return {};
  }
  async updateTask(taskId: string, changes: TaskChanges, agents: ReadonlyMap<string, WorkspaceAgent>): Promise<WorkspaceTask> {
    const ws = await this.workspaceOf(taskId);
    const body: Json = { ...(changes.status !== undefined ? { status: changes.status } : {}), ...(changes.priority !== undefined ? { priority: TO_PRIORITY[changes.priority] } : {}), ...this.assigneeBody(changes) };
    const updated = await this.call<Json>('PUT', `/api/issues/${enc(taskId)}`, { workspaceId: ws, body });
    this.invalidate();
    const [people, me] = await Promise.all([this.peopleOf(ws).catch(() => []), this.whoami().catch(() => null)]);
    return mapIssue(updated, { agents, people: new Map(people.map(p => [p.id, p.name])), me: me?.id ?? null });
  }
  async createTask(input: TaskCreateInput, company: WorkspaceCompany, agents: ReadonlyMap<string, WorkspaceAgent>): Promise<WorkspaceTask> {
    const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 500) : (() => { throw new Error('Title is required.'); })();
    const body: Json = { title, status: 'todo', description: typeof input.description === 'string' ? input.description.slice(0, 20_000) : '' };
    if (typeof input.priority === 'string' && input.priority in TO_PRIORITY) body.priority = TO_PRIORITY[input.priority as WorkspacePriority];
    if (input.projectId) body.project_id = input.projectId;
    if (typeof input.parentId === 'string' && input.parentId) body.parent_issue_id = input.parentId;
    if (typeof input.assigneeId === 'string' && input.assigneeId && input.assigneeId !== 'user:local') Object.assign(body, input.assigneeId.startsWith('user:') ? { assignee_type: 'member', assignee_id: input.assigneeId.slice(5) } : { assignee_type: 'agent', assignee_id: input.assigneeId });
    if (Array.isArray(input.labelIds) && input.labelIds.length) body.label_ids = [...new Set(input.labelIds.slice(0, 20))];
    const created = await this.call<Json>('POST', '/api/issues', { workspaceId: company.id, body });
    this.remember(created, company.id); this.invalidate();
    const [people, me] = await Promise.all([this.peopleOf(company.id).catch(() => []), this.whoami().catch(() => null)]);
    return mapIssue(created, { agents, people: new Map(people.map(p => [p.id, p.name])), me: me?.id ?? null });
  }
  async pauseAgent(): Promise<void> { throw new Error('Multica agents are paused on Multica itself; Muster cannot pause them.'); }
  async resumeAgent(): Promise<void> { throw new Error('Multica agents are resumed on Multica itself; Muster cannot resume them.'); }
  async cancelRun(): Promise<void> { throw new Error('Cancel this run on Multica.'); }
  async decideApproval(): Promise<void> { throw new Error('Multica has no approvals to decide here.'); }
  async respond(): Promise<void> { throw new Error('That request is no longer waiting for you.'); }

  // --- check-out (PersonalAccess): Multica's own fields; nothing Multica lacks is faked --------------------------------------------
  async patchTask(taskId: string, changes: { status?: WorkspaceStatus; assigneeUserId?: string | null; assigneeAgentId?: string | null; comment?: string }): Promise<void> {
    const ws = await this.workspaceOf(taskId);
    const body: Json = { ...(changes.status !== undefined ? { status: changes.status } : {}), ...this.assigneeBody(changes) };
    if (Object.keys(body).length) await this.call('PUT', `/api/issues/${enc(taskId)}`, { workspaceId: ws, body });
    if (typeof changes.comment === 'string' && changes.comment) await this.call('POST', `/api/issues/${enc(taskId)}/comments`, { workspaceId: ws, body: { content: toMulticaMentions(changes.comment) } });
    this.invalidate();
  }
  async rawComments(taskId: string): Promise<TaskCommentRow[]> {
    const ws = await this.workspaceOf(taskId);
    return arr(await this.get<unknown>(`/api/issues/${enc(taskId)}/comments`, ws)).map(c => ({
      id: String(c.id), body: fromMulticaMentions(str(c.content) ?? ''), authorUserId: c.author_type === 'member' ? str(c.author_id) : null, authorAgentId: c.author_type === 'agent' ? str(c.author_id) : null, createdAt: String(c.created_at ?? ''),
    }));
  }
  /** Multica issues have no documents: the local work log stays on this computer (the hand-back comment carries the summary). */
  async putDocument(): Promise<void> { /* nothing to write to */ }
  /** Multica has no cost-event API: local turns' costs stay in Muster's own ledger. */
  async postCostEvent(): Promise<void> { /* nothing to write to */ }
  async agentInstructions(agentId: string): Promise<string> {
    for (const company of await this.companies()) {
      const agent = await this.get<Json>(`/api/agents/${enc(agentId)}`, company.id).catch(() => null);
      if (agent && typeof agent.id === 'string') return str(agent.instructions) ?? '';
    }
    return '';
  }
  /** Multica's project workflows are not review/approval stages: there is no policy to follow here. */
  async issuePolicy(): Promise<[]> { return []; }

  // --- what this API does not have -----------------------------------------------------------------------------------------------
  async receipts(): Promise<LedgerEntry[]> { return []; }
  async dashboard(): Promise<{ receipts: LedgerEntry[]; activity: WorkspaceRow[] }> { return { receipts: [], activity: [] }; }
  async rows(_kind: WorkspaceListKind): Promise<WorkspaceRow[]> { return []; }
  linkFor(company: WorkspaceCompany, target: { taskKey?: string }): string | null {
    const slug = this.slugs.get(company.id);
    return slug && target.taskKey ? `${this.endpoint.baseUrl}/${enc(slug)}/issues/${enc(target.taskKey)}` : null;
  }
  /** Projects for Settings' list (the only import-style read Multica answers); anything else is refused in plain words. */
  importReader(): ImportReader {
    const refuse = () => { throw new PaperclipError('Import a copy is not available for Multica servers. Their issues are shown live under Projects.', 400, 'service'); };
    return {
      get: async path => {
        const projects = /^\/companies\/([^/]+)\/projects$/.exec(path.split('?')[0]!);
        if (projects) return arr((await this.get<Json>('/api/projects', decodeURIComponent(projects[1]!)))?.projects).map(p => ({ id: p.id, name: p.title, description: p.description ?? '', status: p.status }));
        if (path.split('?')[0] === '/companies') return (await this.companies()).map(c => ({ id: c.id, name: c.name, issuePrefix: c.prefix }));
        return refuse();
      },
      issuePages: () => refuse(), commentPages: () => refuse(),
    };
  }
  /** Multica's `/ws` takes a browser session, not a token: updates arrive by polling. */
  openLive(_company: WorkspaceCompany, handlers: LiveHandlers): LiveSocket { let closed = false; queueMicrotask(() => { if (!closed) handlers.onDown(); }); return { close() { closed = true; } }; }
}

interface Names { agents: ReadonlyMap<string, WorkspaceAgent>; people: ReadonlyMap<string, string>; me: string | null }
const personLabel = (id: string, names: Names) => names.me && id === names.me ? 'You' : names.people.get(id) ?? 'A teammate';

function mapAgent(a: Json): WorkspaceAgent {
  return {
    id: String(a.id), name: str(a.name) ?? 'Agent', role: 'agent', title: null, model: str(a.model), adapter: str(a.runtime_mode), source: 'paperclip',
    status: a.archived_at ? 'terminated' : AGENT_STATE[String(a.status)] ?? 'idle', reportsTo: null, lastActiveAt: str(a.updated_at), error: null,
    capabilities: str(a.description), pausable: false,
  };
}
export function mapIssue(i: Json, names: Names): WorkspaceTask {
  const id = String(i.id), type = str(i.assignee_type), who = str(i.assignee_id);
  const agent = type === 'agent' && who ? who : null, user = type === 'member' && who ? who : null;
  const creator = str(i.creator_id), creatorAgent = i.creator_type === 'agent' ? creator : null, creatorUser = i.creator_type === 'member' ? creator : null;
  return {
    id, key: str(i.identifier) ?? id.slice(0, 8), title: str(i.title) ?? 'Untitled', status: statusOf(i), priority: FROM_PRIORITY[String(i.priority)] ?? 'low', source: 'paperclip',
    projectId: str(i.project_id), parentId: str(i.parent_issue_id), goalId: null,
    assigneeId: agent ?? (user ? `user:${user}` : null),
    assigneeLabel: agent ? names.agents.get(agent)?.name ?? 'Agent' : user ? personLabel(user, names) : type === 'squad' ? 'A squad' : null,
    assigneeUserId: user, responsibleUserId: null, createdByUserId: creatorUser, createdByAgentId: creatorAgent,
    createdAt: String(i.created_at ?? ''), updatedAt: str(i.last_activity_at) ?? String(i.updated_at ?? ''), startedAt: str(i.start_date), completedAt: null,
    live: false, blockedByIds: [],
    origin: creatorAgent ? names.agents.get(creatorAgent)?.name ?? 'Agent' : creatorUser ? personLabel(creatorUser, names) : null,
    ...(arr(i.labels).length ? { labels: arr(i.labels).map(l => ({ name: str(l.name) ?? '', color: str(l.color) })).filter(l => l.name) } : {}),
  };
}
function mapProject(p: Json, tasks: readonly WorkspaceTask[]): WorkspaceProject {
  const id = String(p.id), mine = tasks.filter(t => t.projectId === id);
  return {
    id, name: str(p.title) ?? str(p.name) ?? 'Project', status: str(p.status) ?? 'planned', description: str(p.description) ?? '', source: 'paperclip',
    repo: null, cwd: null, taskCount: mine.length || (typeof p.issue_count === 'number' ? p.issue_count : 0),
    openCount: mine.filter(t => t.status !== 'done' && t.status !== 'cancelled').length, paused: false, memory: null,
    ...(p.status === 'archived' || p.archived_at ? { status: 'archived' } : {}),
  };
}
function mapComment(c: Json, names: Names): WorkspaceComment {
  const type = str(c.author_type), who = str(c.author_id);
  const kind = type === 'agent' ? 'agent' : type === 'member' ? 'user' : 'system';
  return {
    id: String(c.id), body: fromMulticaMentions(str(c.content) ?? ''), createdAt: String(c.created_at ?? ''),
    author: { kind, id: who, label: kind === 'agent' && who ? names.agents.get(who)?.name ?? 'Agent' : kind === 'user' && who ? personLabel(who, names) : 'Multica' },
  };
}
