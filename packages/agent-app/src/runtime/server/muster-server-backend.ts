/**
 * The Muster Server implementation of `ServerBackend`: our own packages/server over `POST /rpc` and the `/events` WebSocket.
 *
 * A Muster Server hosts the same agent runtime as this app, so its workspace is read with the commands the app already speaks
 * (`paperclip.snapshot`, `paperclip.task`, `project.*`…), run on the server under the signed-in person's role, and normalised here
 * to the linked-server shapes the Inbox, Projects, Roster, Ledger and approvals already render. Chats live on the server, so rows
 * that would open a local chat are rewritten: a pending approval or question becomes a card answered in place.
 */
import type {
  ApprovalDecision, LedgerEntry, PaperclipQuestion, TaskCreateInput, TaskStartResult, ThreadCard, WorkspaceAgent, WorkspaceCompany, WorkspaceComment, WorkspaceInboxItem, WorkspaceListKind, WorkspaceRow,
  WorkspaceSnapshot, WorkspaceTask, WorkspaceTaskDetail, WorkspaceApproval,
} from '../../shared/domains/paperclip-protocol.ts';
import { PaperclipError, nodeSocket, type LiveSocket, type SocketFactory } from '../paperclip-client.ts';
import type { BackendOptions, ImportReader, Json, LiveHandlers, ServerBackend, ServerEndpoint, ServerHealth, ServerPart, TaskChanges, TaskDetailContext } from './backend.ts';

export const SERVER_ORG_ID = 'server';
const TIMEOUT_MS = 15_000;
const LIVE_EVENTS = new Set(['snapshot', 'projectChanged', 'mailboxChanged', 'workChanged', 'projectsWorkspaceChanged']);
const hostOf = (baseUrl: string) => { try { return new URL(baseUrl).host; } catch { return 'Muster Server'; } };

export class MusterServerBackend implements ServerBackend {
  readonly kind = 'muster-server' as const;
  generation = 0;
  private lastSignature = '';
  private raw: WorkspaceSnapshot | null = null;
  private readonly request: (input: string, init?: RequestInit) => Promise<Response>;
  constructor(readonly endpoint: ServerEndpoint, private readonly options: BackendOptions = {}) { this.request = options.fetch ?? ((input, init) => fetch(input, init)); }
  invalidate(): void { this.lastSignature = ''; }
  get orgName(): string { return this.options.orgName ?? hostOf(this.endpoint.baseUrl); }
  private company(): WorkspaceCompany { return { id: SERVER_ORG_ID, name: this.orgName, prefix: '' }; }

  // --- transport ---------------------------------------------------------------------------------------------------
  private async post<T>(path: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.request(`${this.endpoint.baseUrl}${path}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'content-type': 'application/json', accept: 'application/json', ...(this.endpoint.token ? { authorization: `Bearer ${this.endpoint.token}` } : {}) }, body: JSON.stringify(body),
      });
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
      throw new PaperclipError(`Muster Server at ${this.endpoint.baseUrl} ${timedOut ? 'timed out' : 'is not reachable'}.`, 0, 'network');
    }
    let json: { ok?: boolean; error?: string; value?: unknown } & Json;
    try { json = await response.json() as typeof json; } catch { throw new PaperclipError(`${this.endpoint.baseUrl} is not a Muster Server (HTTP ${response.status}).`, response.status, 'service'); }
    if (response.status === 401) {
      const replaced = this.options.onUnauthorized?.(Boolean(this.endpoint.token), 401);
      if (replaced) throw new PaperclipError(replaced, 401, 'auth');
    }
    if (response.status === 401) throw new PaperclipError(this.endpoint.token ? `Muster Server refused the sign-in (401). ${json.error ?? ''}`.trim() : 'This Muster Server needs you to sign in. Open Settings › Integrations › Muster Server.', 401, 'auth');
    if (!response.ok || json.ok === false) throw new PaperclipError(json.error ?? `Muster Server answered ${response.status}.`, response.status, 'service');
    return json as T;
  }
  async rpc<T>(command: string, input: unknown = {}): Promise<T> { return (await this.post<{ value: T }>('/rpc', { command, input })).value; }

  async health(): Promise<ServerHealth> {
    const me = await this.rpc<{ server?: { version?: string } }>('server.me');
    return { version: me.server?.version, deploymentMode: 'self-hosted', compatibility: null };
  }
  async companies(): Promise<WorkspaceCompany[]> { return [this.company()]; }

  // --- reading -------------------------------------------------------------------------------------------------------
  async read(_company: WorkspaceCompany, previous?: { generation: number; companyId: string; part: ServerPart }): Promise<ServerPart> {
    const snapshot = await this.rpc<WorkspaceSnapshot>('paperclip.snapshot', {});
    this.raw = snapshot;
    // `fetchedAt` changes on every read; everything else is what the screens show.
    const signature = JSON.stringify({ ...snapshot, fetchedAt: '' });
    if (previous && previous.generation === this.generation && signature === this.lastSignature) return previous.part;
    this.lastSignature = signature; this.generation++;
    return this.normalise(snapshot);
  }

  private normalise(snapshot: WorkspaceSnapshot): ServerPart {
    const company = this.company();
    const projectName = new Map(snapshot.projects.map(p => [p.id, p.name]));
    const inbox: WorkspaceInboxItem[] = [];
    const approvals: WorkspaceApproval[] = [];
    for (const item of snapshot.inbox) {
      // Mail is the server's own mailbox and a chat is on the server: neither opens here.
      if (item.kind === 'mail') continue;
      const { chatIds: _chats, ...rest } = item;
      const gate = item.id.startsWith('gate:');
      const next: WorkspaceInboxItem = { ...rest, source: 'paperclip', group: item.projectId ? projectName.get(item.projectId) ?? item.group ?? company.name : item.group ?? company.name,
        ...(gate ? { approvalId: item.id, approvalVerbs: ['approve', 'reject'] as ApprovalDecision[] } : {}) };
      inbox.push(next);
      if (gate) approvals.push({ id: item.id, type: 'automation_run', status: 'pending', title: item.title, detail: item.why, requestedBy: null, agentId: null, issueIds: [], at: item.at, verbs: ['approve', 'reject'] });
    }
    return {
      tasks: snapshot.tasks.map(t => ({ ...t, source: 'paperclip' as const })),
      agents: snapshot.agents.map(a => ({ ...a, source: 'paperclip' as const })),
      projects: snapshot.projects.map(p => ({ ...p, source: 'paperclip' as const, memory: null })),
      runs: snapshot.runs.map(({ chatId: _chat, ...r }) => ({ ...r, source: 'paperclip' as const })),
      inbox, goals: snapshot.goals, approvals, labels: snapshot.labels ?? [],
    };
  }

  async taskDetail(taskId: string, ctx: TaskDetailContext): Promise<WorkspaceTaskDetail> {
    const d = await this.rpc<WorkspaceTaskDetail>('paperclip.task', { id: taskId });
    const agents = ctx.agents;
    const cards: ThreadCard[] = [];
    for (const card of d.cards) {
      // Governance and secret cards act on the server's own projects through commands this window cannot route: they stay on the server.
      if (card.kind === 'stage' || card.kind === 'ask' || card.kind === 'suggestion' || card.kind === 'secret') continue;
      if (card.kind === 'needs' && card.pending) {
        const item = card.pending, { chatId: _chat, pending: _pending, ...rest } = card;
        if (item.kind === 'approval') { cards.push({ ...rest, interactionId: `chat-approval:${item.id}`, acceptLabel: 'Approve', rejectLabel: 'Reject' }); continue; }
        const questions = pendingQuestions(item.data);
        if (questions.length) { cards.push({ ...rest, interactionId: `chat-question:${item.id}`, questions, submitLabel: 'Send answer' }); continue; }
        cards.push({ ...rest, interactionId: null });
        continue;
      }
      if (card.kind === 'needs') { const { chatId: _c, ...rest } = card; cards.push(rest); continue; }
      cards.push(card);
    }
    return {
      ...d, task: { ...d.task, source: 'paperclip' }, cards,
      runs: d.runs.map(({ chatId: _chat, ...r }) => ({ ...r, source: 'paperclip' as const })),
      receipts: d.receipts.map(retagReceipt),
      // Agents here come from the linked server's last read; the detail's own list stays authoritative for mentions.
      mentionable: d.mentionable.length ? d.mentionable : [...agents.values()].map(a => ({ id: a.id, name: a.name })),
    };
  }

  // --- acting (only ever sent when you press something) ----------------------------------------------------------------------
  async comment(taskId: string, body: string): Promise<WorkspaceComment> { return this.rpc<WorkspaceComment>('paperclip.comment', { taskId, body }); }
  async updateTask(taskId: string, changes: TaskChanges): Promise<WorkspaceTask> {
    const input: Json = { taskId };
    if (changes.status !== undefined) input.status = changes.status;
    if (changes.priority !== undefined) input.priority = changes.priority;
    if (changes.assigneeAgentId !== undefined) input.assigneeId = changes.assigneeAgentId;
    return { ...(await this.rpc<WorkspaceTask>('paperclip.task.update', input)), source: 'paperclip' };
  }
  async createTask(input: TaskCreateInput): Promise<WorkspaceTask> {
    const { labelIds: _l, goalId: _g, blockedByIds: _b, start: _s, ...rest } = input;
    return { ...(await this.rpc<WorkspaceTask>('paperclip.task.create', { ...rest, assigneeId: input.assigneeId || 'user:local' })), source: 'paperclip' };
  }
  async pauseAgent(id: string): Promise<void> { await this.rpc('paperclip.agent.pause', { id }); }
  async resumeAgent(id: string): Promise<void> { await this.rpc('paperclip.agent.resume', { id }); }
  async cancelRun(id: string): Promise<void> { await this.rpc('paperclip.run.cancel', { id }); }
  async decideApproval(id: string, decision: ApprovalDecision, _note?: string | null): Promise<void> {
    if (decision === 'request_revision') throw new Error('This request can be approved or declined.');
    if (id.startsWith('gate:')) { await this.rpc('automations.gate.decide', { id: id.slice(5), approve: decision === 'approve' }); return; }
    await this.rpc('approval.respond', { id, approved: decision === 'approve' });
  }
  async respond(_taskId: string, interactionId: string, input: { accept: boolean; reason?: string; answers?: { questionId: string; optionIds: string[]; otherText?: string | null }[] }): Promise<void> {
    if (interactionId.startsWith('chat-approval:')) { await this.rpc('approval.respond', { id: interactionId.slice('chat-approval:'.length), approved: input.accept }); return; }
    if (interactionId.startsWith('chat-question:') && input.answers) {
      await this.rpc('question.respond', { id: interactionId.slice('chat-question:'.length), answers: Object.fromEntries(input.answers.map(a => [a.questionId, { answers: [...a.optionIds, ...(a.otherText ? [a.otherText] : [])] }])) });
      return;
    }
    throw new Error('That request is no longer waiting for you.');
  }
  async startTask(taskId: string): Promise<TaskStartResult> { return this.rpc<TaskStartResult>('paperclip.task.start', { taskId }); }

  async receipts(_company: WorkspaceCompany, limit: number): Promise<LedgerEntry[]> {
    return (await this.rpc<{ entries: LedgerEntry[] }>('paperclip.ledger', { limit })).entries.map(retagReceipt);
  }
  async dashboard(company: WorkspaceCompany): Promise<{ receipts: LedgerEntry[]; activity: WorkspaceRow[] }> {
    const [receipts, activity] = await Promise.all([this.receipts(company, 200).catch(() => []), this.rows('audit').catch(() => [])]);
    return { receipts, activity: activity.slice(0, 12) };
  }
  async rows(kind: WorkspaceListKind): Promise<WorkspaceRow[]> {
    return (await this.rpc<{ rows: WorkspaceRow[] }>('paperclip.list', { kind })).rows.map(r => ({ ...r, source: 'paperclip' as const }));
  }
  startFor(taskId: string) { return this.startTask(taskId); }

  // --- import: a read-only Paperclip-shaped view of this server's own data (the importer reads one shape) -----------------------
  importReader(): ImportReader {
    const company = this.company();
    let snap: Promise<WorkspaceSnapshot> | undefined;
    const snapshot = () => snap ??= this.rpc<WorkspaceSnapshot>('paperclip.snapshot', {});
    const notFound = (path: string) => new PaperclipError(`Muster Server has nothing at ${path.split('?')[0]}.`, 404, 'service');
    const detail = (id: string) => this.rpc<WorkspaceTaskDetail>('paperclip.task', { id });
    const issueJson = (t: WorkspaceTask, description = ''): Json => ({
      id: t.id, identifier: t.key, title: t.title, description, status: t.status, priority: t.priority, projectId: t.projectId, parentId: t.parentId, goalId: t.goalId,
      assigneeAgentId: t.assigneeId && !t.assigneeId.startsWith('user:') ? t.assigneeId : null, createdAt: t.createdAt, updatedAt: t.updatedAt, startedAt: t.startedAt, completedAt: t.completedAt,
      blockedBy: t.blockedByIds.map(id => ({ id })), labels: (t.labels ?? []).map(l => ({ name: l.name, color: l.color })),
    });
    const ADAPTER: Record<string, string> = { 'claude-code': 'claude_local', codex: 'codex_local', opencode: 'opencode_local' };
    const agentJson = (a: WorkspaceAgent): Json => ({
      id: a.id, name: a.name, role: a.role, title: a.title, status: a.status === 'pending' ? 'pending_approval' : a.status, reportsTo: a.reportsTo, capabilities: a.capabilities,
      adapterType: a.runner ? ADAPTER[a.runner.providerId] ?? a.runner.providerId : a.adapter, adapterConfig: { model: a.runner?.model ?? a.model },
    });
    async function* issues(this: MusterServerBackend, query: string): AsyncGenerator<Json[]> {
      const { tasks } = await snapshot();
      const wantBody = !query.includes('view=compact');
      for (let i = 0; i < tasks.length; i += 25) {
        const page = tasks.slice(i, i + 25);
        yield await Promise.all(page.map(async t => issueJson(t, wantBody ? (await detail(t.id).catch(() => null))?.description ?? '' : '')));
      }
    }
    const reader = this;
    return {
      async get(path: string): Promise<unknown> {
        const clean = path.split('?')[0]!;
        const s = await snapshot();
        if (clean === '/companies') return [{ id: company.id, name: company.name, issuePrefix: '' }];
        if (clean === `/companies/${company.id}/projects`) return s.projects.map(p => ({ id: p.id, name: p.name, description: p.description, status: p.status, codebase: { ...(p.repo ? { repoUrl: `https://${p.repo}` } : {}), ...(p.cwd ? { localFolder: p.cwd } : {}) } }));
        if (clean === `/companies/${company.id}/agents`) return s.agents.filter(a => a.memberId !== 'agent').map(agentJson);
        if (clean === `/companies/${company.id}/goals`) return s.goals.map(g => ({ id: g.id, title: g.title, status: g.status, level: g.level, parentId: g.parentId, ownerAgentId: g.ownerAgentId }));
        if (clean === `/companies/${company.id}/issues`) { const rows: Json[] = []; for await (const page of issues.call(reader, path.split('?')[1] ?? '')) rows.push(...page); return rows; }
        const one = /^\/issues\/([^/]+)$/.exec(clean);
        if (one) { const task = s.tasks.find(t => t.id === decodeURIComponent(one[1]!) || t.key === decodeURIComponent(one[1]!)); if (!task) throw notFound(path); return issueJson(task, (await detail(task.id).catch(() => null))?.description ?? ''); }
        throw notFound(path);
      },
      issuePages: (_company, query) => issues.call(reader, query),
      async *commentPages(issueId: string): AsyncGenerator<Json[]> {
        const d = await detail(issueId).catch(() => null);
        yield (d?.comments ?? []).map(c => ({ id: c.id, body: c.body, createdAt: c.createdAt, authorType: c.author.kind, ...(c.author.kind === 'agent' && c.author.id ? { authorAgentId: c.author.id } : {}) }));
      },
    };
  }

  // --- live -----------------------------------------------------------------------------------------------------------------
  openLive(_company: WorkspaceCompany, handlers: LiveHandlers, factory: SocketFactory = nodeSocket): LiveSocket {
    let closed = false, down = false;
    const fail = () => { if (!down && !closed) { down = true; handlers.onDown(); } };
    const url = new URL(`${this.endpoint.baseUrl}/events`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: ReturnType<SocketFactory>;
    try { socket = factory(url.toString(), this.endpoint.token); } catch { queueMicrotask(fail); return { close() { closed = true; } }; }
    socket.onopen = () => handlers.onOpen();
    socket.onmessage = event => {
      try {
        const parsed = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data as ArrayBuffer).toString('utf8')) as { type?: unknown } & Record<string, unknown>;
        if (parsed.type === 'server:revoked') { fail(); return; }
        if (typeof parsed.type === 'string' && LIVE_EVENTS.has(parsed.type)) handlers.onEvent(parsed.type, parsed);
      } catch { /* a malformed frame is ignored */ }
    };
    socket.onerror = fail;
    socket.onclose = fail;
    return { close() { closed = true; try { socket.close(); } catch { /* already closed */ } } };
  }
}

/** A server entry reads as the linked server's own receipt: no local chat to open and no hash chain of ours to verify. */
const retagReceipt = (e: LedgerEntry): LedgerEntry => ({ ...e, source: 'paperclip', chatId: null, seq: null, prevHash: null, hash: null });

/** A pending question of a run on the server, as the choices card the Inbox and thread already render. */
function pendingQuestions(data: Json | undefined): PaperclipQuestion[] {
  const list = Array.isArray(data?.questions) ? data!.questions as Json[] : [];
  return list.filter(q => typeof q.id === 'string').map(q => ({
    id: String(q.id), prompt: typeof q.question === 'string' ? q.question : typeof q.header === 'string' ? q.header : 'Question', helpText: null, multi: false, allowOther: q.isOther === true || !Array.isArray(q.options) || q.options.length === 0,
    options: (Array.isArray(q.options) ? q.options as Json[] : []).filter(o => typeof o.label === 'string').map(o => ({ id: String(o.label), label: String(o.label), description: typeof o.description === 'string' ? o.description : null })),
  }));
}
export type { WorkspaceSnapshot };
