/**
 * Paperclip in Muster (#115). Handlers are keyed by the command names in shared/domains/paperclip-protocol.ts.
 *
 * One snapshot merges Muster's own Projects with the linked Paperclip's (Settings › Integrations), each row tagged with
 * its `source`; commands route by id to whichever side owns the row. The Paperclip token lives in the encrypted secret
 * store and never leaves this process.
 *
 * Cost model (the founder's hard requirement): nothing runs while nobody looks.
 * - Paperclip reads are conditional GETs (ETag), coalesced, and rebuilt only when a body changed.
 * - Live updates come from Paperclip's company WebSocket; run-log noise is dropped and the rest coalesces into at most one
 *   `projectsWorkspaceChanged` event per second (every 5 s while no workspace screen is visible, for the Inbox badge).
 * - Only when the socket is refused AND a workspace screen is visible does a poll run (15 s, backing off to 60 s).
 *   Hidden means no timers at all. Muster's own data needs none: its changes already arrive as events.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryRecord } from '../../shared/domains/memory-protocol.ts';
import {
  budgetUse, PAPERCLIP_LOCAL_URL, WORKSPACE_PRIORITIES, WORKSPACE_STATUSES, type ApprovalDecision, type DashboardData, type LedgerView, type LiveChannel, type PaperclipConfigView, type PaperclipLink, type PaperclipMode, type PaperclipTestResult,
  type ThreadCard, type WorkspaceAgent, type WorkspaceApproval, type WorkspaceBadge, type WorkspaceInboxItem, type WorkspaceList, type WorkspaceListKind, type WorkspaceMemory, type WorkspaceProject,
  type WorkspacePriority, type WorkspaceRow, type WorkspaceSnapshot, type WorkspaceSource, type WorkspaceStatus, type WorkspaceTask, type WorkspaceTaskDetail,
} from '../../shared/domains/paperclip-protocol.ts';
import { normalizeRemote } from '../memory-identity.ts';
import { PaperclipClient, PaperclipError, normalizeBaseUrl, openLiveEvents, type FetchLike, type LiveSocket, type SocketFactory } from '../paperclip-client.ts';
import { arr, buildInbox, mapAgent, mapApproval, mapBudgets, mapDocument, mapWorkProduct, mapAttention, mapComment, mapCompany, mapGoal, mapInteraction, mapIssue, mapProject, mapReceipt, mapRows, mapRun } from '../paperclip-map.ts';
import { activeSecretStore, SecretStore } from '../secret-store.ts';
import { attachTurnLedger, TurnLedger } from '../turn-ledger.ts';
import { importLedgerHistory, paperclipHistory, type HistoryResult } from '../ledger-history.ts';
import { LocalWorkspace, type Invoke, type LocalPart } from '../workspace-local.ts';
import { importFromPaperclip, planImport, SqliteImportStore } from '../paperclip-import.ts';
import { buildDashboard, DASHBOARD_DAYS, ledgerAggregates, monthStart } from '../workspace-dashboard.ts';
import type { DomainContext, DomainModule } from './types.ts';

export const PAPERCLIP_SECRET_ID = 'paperclip-board-token';
const POLL_MS = 15_000, POLL_MAX_MS = 60_000, EMIT_VISIBLE_MS = 1_000, EMIT_HIDDEN_MS = 5_000;
/** Paperclip serves its issue lists from a 2 s cache that a change does not clear: a read right after an event can return the old list, so one more read follows once it has expired. */
const SETTLE_MS = 2_400;
/** Frames that fire many times a second while an agent works and change nothing the UI shows. */
const NOISY = new Set(['heartbeat.run.log', 'heartbeat.run.event', 'heartbeat.run.progress', 'plugin.ui.updated']);
/** Needs you + Problems: the only kinds that badge. */
const URGENT = new Set(['question', 'approval', 'blocked', 'failed_run', 'agent_error', 'budget']);

/** `tokenOrigin` is the origin the stored token was saved for: the token is sent to that origin and nowhere else. */
interface StoredConfig { mode: PaperclipMode; baseUrl: string; companyId: string | null; tokenOrigin: string | null }
const DEFAULT_CONFIG: StoredConfig = { mode: 'off', baseUrl: PAPERCLIP_LOCAL_URL, companyId: null, tokenOrigin: null };
/** A Custom URL on this Mac (127.0.0.0/8, localhost, ::1) is a local Paperclip: its folder paths are this Mac's. */
export const isLoopback = (baseUrl: unknown): boolean => { try { const host = new URL(normalizeBaseUrl(baseUrl)).hostname.replace(/^\[|\]$/g, '').toLowerCase(); return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host); } catch { return false; } };
const originOf = (baseUrl: unknown): string | null => { try { return new URL(normalizeBaseUrl(baseUrl)).origin; } catch { return null; } };
type Json = Record<string, unknown>;
interface PaperclipPart { tasks: WorkspaceTask[]; agents: WorkspaceAgent[]; projects: WorkspaceProject[]; runs: WorkspaceSnapshot['runs']; inbox: WorkspaceInboxItem[]; goals: WorkspaceSnapshot['goals']; approvals: WorkspaceApproval[]; labels: NonNullable<WorkspaceSnapshot['labels']> }

export interface PaperclipDomainOptions {
  fetch?: FetchLike; socket?: SocketFactory; secrets?: () => SecretStore | undefined;
  /** `git config --get remote.origin.url` for a folder path (tests inject it). */
  remoteOf?: (path: string) => Promise<string | undefined>;
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}

const gitRemote = (path: string) => new Promise<string | undefined>(resolve => {
  execFile('git', ['config', '--get', 'remote.origin.url'], { cwd: path, timeout: 1500, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined));
});
/** Model and provider from a Codex agent's own config.toml (only those two keys are read; nothing else is kept). */
const codexHomeOf = (agent: Record<string, unknown>): { provider?: string; model?: string } | null => {
  const env = (agent.adapterConfig as { env?: Record<string, unknown> } | undefined)?.env ?? {};
  const raw = env.CODEX_HOME, home = typeof raw === 'string' ? raw : raw && typeof raw === 'object' && typeof (raw as { value?: unknown }).value === 'string' ? (raw as { value: string }).value : null;
  if (!home || !home.startsWith('/')) return null;
  try {
    const toml = readFileSync(join(home, 'config.toml'), 'utf8'), read = (key: string) => new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm').exec(toml)?.[1];
    return { provider: read('model_provider'), model: read('model') };
  } catch { return null; }
};
/** Drains a paged list into one array. */
const allPages = async <T>(pages: AsyncIterable<T[]>): Promise<T[]> => { const rows: T[] = []; for await (const page of pages) for (const row of page) rows.push(row); return rows; };
const parseJson = (text: string): Json => { try { const value = JSON.parse(text) as unknown; return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}; } catch { return {}; } };
const STOP = new Set(['the', 'and', 'for', 'with', 'into', 'from', 'that', 'this', 'are', 'was', 'has', 'have', 'not', 'but', 'you', 'our', 'its', 'all', 'can', 'will', 'fix', 'add', 'make', 'use', 'new', 'task', 'issue']);
const terms = (text: string) => new Set(text.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(w => w.length >= 3 && !STOP.has(w)));
/** Ranks memories by the words they share with the task; ties go to the newest. */
export function rankMemories(records: readonly MemoryRecord[], query: string, limit = 8): MemoryRecord[] {
  const want = terms(query);
  if (!want.size) return [];
  return records.map(record => { const have = terms(record.text); let score = 0; for (const w of want) if (have.has(w)) score++; return { record, score }; })
    .filter(r => r.score > 0).sort((a, b) => b.score - a.score || (b.record.observedAt ?? '').localeCompare(a.record.observedAt ?? '')).slice(0, limit).map(r => r.record);
}

export function createPaperclipDomain(context: DomainContext, options: PaperclipDomainOptions = {}): DomainModule {
  const timers = options.timers ?? { setTimeout, clearTimeout };
  const secrets = () => options.secrets?.() ?? activeSecretStore() ?? new SecretStore(context.dataDir);
  const configPath = join(context.dataDir, 'paperclip.json');
  let config: StoredConfig = (() => {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<StoredConfig>;
      return { mode: raw.mode === 'local' || raw.mode === 'custom' ? raw.mode : 'off', baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : PAPERCLIP_LOCAL_URL, companyId: typeof raw.companyId === 'string' ? raw.companyId : null, tokenOrigin: typeof raw.tokenOrigin === 'string' ? raw.tokenOrigin : null };
    } catch { return { ...DEFAULT_CONFIG }; }
  })();
  const saveConfig = (next: StoredConfig) => {
    mkdirSync(context.dataDir, { recursive: true });
    const temp = `${configPath}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(temp, configPath);
    config = next;
  };
  /** The stored token, only for the origin it was saved for; any other URL gets none. */
  const tokenFor = (baseUrl: unknown): string | undefined => { const origin = originOf(baseUrl); return origin && origin === config.tokenOrigin ? secrets().get(PAPERCLIP_SECRET_ID) : undefined; };
  const view = (): PaperclipConfigView => { const status = secrets().status(PAPERCLIP_SECRET_ID); return { mode: config.mode, baseUrl: config.mode === 'local' ? PAPERCLIP_LOCAL_URL : config.baseUrl, hasToken: status.stored && config.tokenOrigin !== null && config.tokenOrigin === originOf(config.baseUrl), secureStorage: status.secureStorage, companyId: config.companyId }; };

  // --- the Paperclip connection ------------------------------------------------------------------------------------
  let client: PaperclipClient | null = null;
  const endpointFor = (mode: PaperclipMode, baseUrl: string, token: string | undefined) => ({ baseUrl: mode === 'local' ? PAPERCLIP_LOCAL_URL : normalizeBaseUrl(baseUrl), token: mode === 'custom' ? token : undefined });
  const connection = (): PaperclipClient | null => {
    if (config.mode === 'off') return null;
    const endpoint = endpointFor(config.mode, config.baseUrl, tokenFor(config.baseUrl));
    if (!client || client.endpoint.baseUrl !== endpoint.baseUrl || client.endpoint.token !== endpoint.token) { closeSocket(); client = new PaperclipClient(endpoint, options.fetch); built = null; }
    return client;
  };
  /** An approval an import carried over can be decided only while a Paperclip is linked (the decision goes to its approval endpoints). */
  const linkedApproval = (sourceId: string, projectId: string | null) => {
    if (!sourceId.startsWith('approval:') || !connection() || !projectId) return false;
    let source; try { source = imports()?.projectSource(projectId); } catch { return false; }
    const linkedCompany = built?.companyId ?? config.companyId ?? companies[0]?.id ?? null;
    if (!source?.companyId || source.companyId !== linkedCompany) return false;
    return !source.serverOrigin || source.serverOrigin === originOf(config.mode === 'local' ? PAPERCLIP_LOCAL_URL : config.baseUrl);
  };
  const originLabel = () => config.mode === 'local' ? 'This Mac' : (() => { try { return new URL(config.baseUrl).host; } catch { return 'Paperclip'; } })();

  // --- Muster's side ---------------------------------------------------------------------------------------------------
  const remotes = new Map<string, Promise<string | undefined>>();
  const remoteOf = (path: string) => { let hit = remotes.get(path); if (!hit) { hit = (options.remoteOf ?? gitRemote)(path).then(url => url ? normalizeRemote(url) : undefined); remotes.set(path, hit); } return hit; };
  const folders = () => context.store.snapshot().folders;
  const knownRepo = new Map<string, string | null>();
  let importStore: SqliteImportStore | undefined;
  const imports = () => { try { return importStore ??= new SqliteImportStore(context.db()); } catch { return undefined; } };
  const local = new LocalWorkspace(context.invoke as Invoke, folderId => {
    const folder = folderId ? folders().find(f => f.id === folderId) : undefined;
    if (!folder) return { repo: null, cwd: null };
    if (!knownRepo.has(folder.path)) { knownRepo.set(folder.path, null); void remoteOf(folder.path).then(repo => knownRepo.set(folder.path, repo ?? null)); }
    return { repo: knownRepo.get(folder.path) ?? null, cwd: folder.path };
  }, imports);

  /** The Muster folder whose memory a project's work recalls: same path, else same origin remote. */
  const folderFor = async (repo: string | null, cwd: string | null): Promise<{ id: string; name: string } | undefined> => {
    let match: { id: string; name: string } | undefined;
    for (const f of folders()) {
      if (cwd && f.path === cwd) return f;
      if (repo && !match && (await remoteOf(f.path)) === repo) match = f;
    }
    return match;
  };
  const memoryCounts = new Map<string, { at: number; value: WorkspaceProject['memory'] }>();
  const projectMemory = async (project: WorkspaceProject): Promise<WorkspaceProject['memory']> => {
    const key = `${project.repo}|${project.cwd}`, hit = memoryCounts.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.value;
    const folder = await folderFor(project.repo, project.cwd);
    const value = folder ? { label: folder.name, count: await context.invoke('memory.browse', { folderId: folder.id }).then(b => b.records.length).catch(() => 0) } : null;
    memoryCounts.set(key, { at: Date.now(), value });
    return value;
  };

  // --- Paperclip's side ------------------------------------------------------------------------------------------------
  let built: { generation: number; companyId: string; part: PaperclipPart; agents: Map<string, WorkspaceAgent> } | null = null;
  let companies: PaperclipLink['companies'] = [];
  let inflight: Promise<PaperclipPart> | null = null, lastError: string | undefined;
  const companyId = async (api: PaperclipClient): Promise<string> => {
    companies = arr(await api.get<unknown>('/companies')).filter(c => c.status !== 'archived').map(mapCompany);
    const chosen = companies.find(c => c.id === config.companyId) ?? companies[0];
    if (!chosen) throw new PaperclipError('This Paperclip has no companies yet. Create one in Paperclip first.', 404, 'service');
    return chosen.id;
  };
  const readPaperclip = async (api: PaperclipClient): Promise<PaperclipPart> => {
    const id = await companyId(api), base = `/companies/${encodeURIComponent(id)}`;
    const [issues, agentsJson, projectsJson, goalsJson, runsJson, liveJson, attentionJson, approvalsJson, labelsJson] = await Promise.all([
      allPages(api.issuePages(id, 'view=compact&includeBlockedBy=true')), api.get<unknown>(`${base}/agents`), api.get<unknown>(`${base}/projects`),
      api.get<unknown>(`${base}/goals`).catch(() => []), api.get<unknown>(`${base}/heartbeat-runs?limit=60&summary=true`),
      api.get<unknown>(`${base}/live-runs`).catch(() => []), api.get<unknown>(`${base}/attention`).catch(() => ({ items: [] })),
      api.get<unknown>(`${base}/approvals`).catch(() => []), api.get<unknown>(`${base}/labels`).catch(() => []),
    ]);
    if (built && built.generation === api.generation && built.companyId === id) return built.part;
    const agentList = arr(agentsJson).map(mapAgent), agents = new Map(agentList.map(a => [a.id, a]));
    const runs = [...arr(liveJson), ...arr(runsJson)].map(mapRun).filter((run, index, all) => all.findIndex(r => r.id === run.id) === index).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const liveTasks = new Set(runs.filter(r => r.status === 'running' || r.status === 'queued').map(r => r.taskId).filter((t): t is string => Boolean(t)));
    for (const agent of agentList) if (agent.status === 'active' && runs.some(r => r.agentId === agent.id && r.status === 'running')) agent.status = 'running';
    const tasks = arr(issues).map(i => mapIssue(i, agents, liveTasks));
    const company = companies.find(c => c.id === id) ?? null;
    // Memory counts are added per snapshot (not here), so the light badge read never browses memory.
    const projects = arr(projectsJson).map(p => mapProject(p, tasks));
    const projectName = new Map(projects.map(p => [p.id, p.name]));
    const inbox = buildInbox(arr((attentionJson as Json).items).map(mapAttention), tasks, runs, agents).map(item => {
      const projectId = item.taskId ? tasks.find(t => t.id === item.taskId)?.projectId ?? null : null;
      return { ...item, projectId, group: projectId ? projectName.get(projectId) ?? company?.name ?? 'Paperclip' : company?.name ?? 'Paperclip', source: 'paperclip' as const };
    });
    const approvals = arr(approvalsJson).filter(a => a.status === 'pending' || a.status === 'revision_requested').map(a => mapApproval(a, agents));
    const labels = arr(labelsJson).map(l => ({ id: String(l.id), name: typeof l.name === 'string' ? l.name : 'Label', color: typeof l.color === 'string' ? l.color : null }));
    const part: PaperclipPart = { tasks, agents: agentList, projects, runs, inbox, goals: arr(goalsJson).map(mapGoal), approvals, labels };
    built = { generation: api.generation, companyId: id, part, agents };
    return part;
  };
  /** Records the last read's outcome. Going offline (ok → stale) or coming back (stale → ok) is an update the screens
   *  must see at once: the banner and "· offline" come from it, so it is emitted rather than waiting for a reload. */
  const linkError = (next: string | undefined) => {
    const changed = Boolean(next) !== Boolean(lastError);
    lastError = next;
    if (changed) queueEmit(['config', 'inbox', 'tasks']);
  };
  const paperclipPart = async (refresh: boolean): Promise<{ part: PaperclipPart | null; link: PaperclipLink | null }> => {
    const api = connection();
    if (!api) return { part: null, link: null };
    if (refresh) api.invalidate();
    inflight ??= readPaperclip(api).then(part => { linkError(undefined); ensureSocket(); return part; }, cause => {
      linkError(cause instanceof Error ? cause.message : String(cause));
      if (built) return built.part;
      throw cause;
    }).finally(() => { inflight = null; });
    try {
      const part = await inflight;
      return { part, link: { origin: originLabel(), company: companies.find(c => c.id === built?.companyId) ?? null, companies, live: live.channel, ...(lastError ? { stale: lastError, cached: true } : {}) } };
    } catch (cause) {
      return { part: null, link: { origin: originLabel(), company: null, companies, live: 'off', stale: cause instanceof Error ? cause.message : String(cause), cached: false } };
    }
  };

  // --- budget alerts -------------------------------------------------------------------------------------------------------
  /** A Muster project at 80% or 100% of its monthly budget (dollars, or tokens when nothing is priced) needs you. One item
   *  per level and month, so dismissing the 80% alert still lets the 100% one through. */
  const budgetInbox = async (projects: readonly WorkspaceProject[]): Promise<WorkspaceInboxItem[]> => {
    const items: WorkspaceInboxItem[] = [];
    const now = Date.now(), offset = -new Date(now).getTimezoneOffset(), month = monthStart(now, offset);
    for (const project of projects) {
      if (project.source !== 'local') continue;
      const settings = await context.invoke('project.team.settings', { projectId: project.id }).catch(() => null);
      if (!settings || (settings.monthlyBudgetUsd == null && settings.monthlyBudgetTokens == null)) continue;
      let spend; try { ledger(); spend = ledgerAggregates(context.db(), { since: month, monthStart: month, offset, skipImportedPaperclip: false, projectId: project.id }).spend; } catch { continue; }
      const use = budgetUse({ usd: settings.monthlyBudgetUsd, tokens: settings.monthlyBudgetTokens ?? null }, { usd: spend.priced ? spend.usd : null, tokens: spend.tokens ?? 0 });
      if (!use || use.ratio < 0.8) continue;
      const over = use.ratio >= 1, pct = Math.round(use.ratio * 100);
      const amount = use.unit === 'usd' ? `$${use.used.toFixed(2)} of $${use.limit.toFixed(2)}` : `${Math.round(use.used).toLocaleString('en-US')} of ${use.limit.toLocaleString('en-US')} tokens`;
      items.push({ id: `budget:${project.id}:${month.slice(0, 7)}:${over ? 100 : 80}`, kind: 'budget', title: `${project.name} ${over ? 'is over' : 'is at'} ${pct}% of its monthly budget`, why: `${amount} this month. ${over ? 'Raise the budget or pause its agents.' : 'Soft alert at 80%.'}`, severity: over ? 'high' : 'medium', at: month, taskId: null, agentId: null, runId: null, projectId: project.id, group: project.name, source: 'local' });
    }
    return items;
  };

  // --- the merged snapshot ---------------------------------------------------------------------------------------------
  let snapshotInflight: Promise<WorkspaceSnapshot> | null = null;
  /** `withMemory: false` is the light read behind the Inbox badge: no memory browsing and no folder matching per project. */
  const merge = async (refresh: boolean, withMemory: boolean): Promise<WorkspaceSnapshot> => {
    const [mine, theirs] = await Promise.all([local.snapshot().catch(() => ({ tasks: [], agents: [], projects: [], runs: [], inbox: [] }) as LocalPart), paperclipPart(refresh)]);
    const p = theirs.part;
    const projects = withMemory ? await Promise.all([...mine.projects, ...(p?.projects ?? [])].map(async project => ({ ...project, memory: await projectMemory(project) }))) : [...mine.projects, ...(p?.projects ?? [])];
    // The work layer's overlay (labels, pull request state, project status, target date, star and hide, automation approvals).
    const over = await context.invoke('work.overlay', {}).catch(() => null);
    if (over) {
      for (const t of mine.tasks) { const labels = over.labels[t.id], pr = over.prs[t.id], goal = over.goals[t.id]; if (labels) t.labels = labels; if (pr) t.pr = pr; if (goal) t.goalId = goal; }
      for (const project of projects) { const m = over.projects[project.id]; if (m && project.source === 'local') Object.assign(project, { status: m.status, targetDate: m.targetDate, starred: m.starred, hidden: m.hidden }); }
      for (const a of mine.agents) { const m = over.agents[a.id]; if (m) Object.assign(a, m); }
    }
    // A Paperclip project already imported into Muster is shown once, as its Muster copy (and its tasks), under the same org.
    let importedProjects = new Set<string>(); try { importedProjects = imports()?.importedSources('project') ?? importedProjects; } catch { /* no import store */ }
    const hidden = new Set((p?.projects ?? []).filter(x => importedProjects.has(x.id)).map(x => x.id));
    const theirTasks = (p?.tasks ?? []).filter(t => !t.projectId || !hidden.has(t.projectId));
    const projects2 = projects.filter(x => !(x.source === 'paperclip' && hidden.has(x.id))).map(x => x.source === 'paperclip' ? { ...x, org: theirs.link?.company?.name ?? 'Paperclip' } : x);
    const tasks = [...mine.tasks, ...theirTasks], runs = [...mine.runs, ...(p?.runs ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const rank = { high: 0, medium: 1, low: 2 } as const;
    // A Paperclip task already imported into Muster needs you once: its Muster copy stands for it in the Inbox and badge.
    let imported = new Set<string>(); try { imported = imports()?.importedSources('task') ?? imported; } catch { /* no import store */ }
    // An approval carried over by an import is decided in the linked Paperclip (when there is one), from its row.
    const carried = (i: WorkspaceInboxItem): WorkspaceInboxItem => i.id.startsWith('import:approval:') && linkedApproval(i.id.slice('import:'.length), i.projectId ?? null) ? { ...i, approvalId: i.id.slice('import:approval:'.length), approvalVerbs: ['approve', 'reject', 'request_revision'] } : i;
    const gates: WorkspaceInboxItem[] = (over?.inbox ?? []).map(g => ({ ...g, taskId: null, agentId: null, runId: null, source: 'local' as const }));
    const inbox = [...mine.inbox.map(carried), ...gates, ...await budgetInbox(mine.projects), ...(p?.inbox ?? []).filter(i => !i.taskId || !imported.has(i.taskId))].sort((a, b) => rank[a.severity] - rank[b.severity] || b.at.localeCompare(a.at));
    return {
      paperclip: theirs.link, tasks, agents: [...mine.agents, ...(p?.agents ?? [])], projects: projects2, goals: p?.goals ?? [], runs, inbox, ...(p ? { approvals: p.approvals, labels: p.labels } : {}), agentCounts: p ?  { active: p.agents.filter(a => a.status !== 'paused' && a.status !== 'terminated' && a.status !== 'pending').length, paused: p.agents.filter(a => a.status === 'paused').length, resumable: resumable(p) } : { active: 0, paused: 0, resumable: resumable(null) },
      counts: { liveRuns: runs.filter(r => r.status === 'running').length, inbox: inbox.filter(i => i.kind !== 'mail').length, failedRuns: runs.filter(r => r.status === 'failed').length, openTasks: tasks.filter(t => t.status !== 'done' && t.status !== 'cancelled').length },
      fetchedAt: new Date().toISOString(),
    };
  };
  const snapshot = (refresh = false): Promise<WorkspaceSnapshot> => {
    snapshotInflight ??= merge(refresh, true).finally(() => { snapshotInflight = null; });
    return snapshotInflight;
  };
  /** Which side owns an id (a task id or key, an agent, a run, a project). Paperclip's rows are known from its last read. */
  const owner = async (kind: 'task' | 'agent' | 'run' | 'project', id: string): Promise<WorkspaceSource> => {
    if (!connection()) return 'local';
    const has = () => {
      const part = built?.part;
      if (!part) return false;
      return kind === 'task' ? part.tasks.some(t => t.id === id || t.key === id) : kind === 'agent' ? part.agents.some(a => a.id === id) : kind === 'run' ? part.runs.some(r => r.id === id) : part.projects.some(p => p.id === id);
    };
    // A row created since the last read (a new task, a fresh run) is not in the cache yet: read once more before deciding.
    if (!has()) await paperclipPart(false);
    return has() || (kind === 'task' && /^[A-Z][A-Z0-9]*-\d+$/.test(id)) ? 'paperclip' : 'local';
  };
  const api = (): PaperclipClient => { const c = connection(); if (!c) throw new Error('Paperclip is not linked. Link it in Settings › Integrations.'); return c; };

  // --- live updates -----------------------------------------------------------------------------------------------------
  const live = { channel: 'off' as LiveChannel, visible: false, socket: null as LiveSocket | null, socketCompany: '', pollTimer: null as ReturnType<typeof setTimeout> | null, settleTimer: null as ReturnType<typeof setTimeout> | null, pollDelay: POLL_MS, emitTimer: null as ReturnType<typeof setTimeout> | null, pending: new Set<string>(), taskIds: new Set<string>() };
  function closeSocket() { if (live.settleTimer) timers.clearTimeout(live.settleTimer); live.settleTimer = null; live.socket?.close(); live.socket = null; live.socketCompany = ''; if (live.channel === 'socket') live.channel = 'off'; }
  const stopPoll = () => { if (live.pollTimer) timers.clearTimeout(live.pollTimer); live.pollTimer = null; };
  const queueEmit = (scopes: string[], taskId?: string) => {
    for (const s of scopes) live.pending.add(s);
    if (taskId) live.taskIds.add(taskId);
    if (live.emitTimer) return;
    live.emitTimer = timers.setTimeout(() => {
      live.emitTimer = null;
      const scopes = [...live.pending] as ('tasks' | 'runs' | 'agents' | 'inbox' | 'config')[], taskIds = [...live.taskIds];
      live.pending.clear(); live.taskIds.clear();
      context.emit({ type: 'projectsWorkspaceChanged', scopes, taskIds });
    }, live.visible ? EMIT_VISIBLE_MS : EMIT_HIDDEN_MS);
  };
  const schedulePoll = () => {
    stopPoll();
    if (!live.visible || live.channel === 'socket' || !connection()) return;
    live.channel = 'poll';
    live.pollTimer = timers.setTimeout(async () => {
      live.pollTimer = null;
      const c = connection();
      if (!c || !live.visible) return;
      const before = c.generation;
      await paperclipPart(false);
      live.pollDelay = lastError ? Math.min(live.pollDelay * 2, POLL_MAX_MS) : POLL_MS;
      if (c.generation !== before) queueEmit(['tasks', 'runs', 'agents', 'inbox']);
      ensureSocket();
      schedulePoll();
    }, live.pollDelay);
  };
  /** One socket while Paperclip is linked (an idle socket costs nothing); it feeds the Inbox badge even when no screen shows workspace data. */
  function ensureSocket() {
    const c = connection();
    if (!c || !built) return;
    if (live.socket && live.socketCompany === built.companyId) return;
    closeSocket();
    const target = built.companyId;
    live.socketCompany = target;
    live.socket = openLiveEvents(c, target, {
      onOpen() { live.channel = 'socket'; stopPoll(); },
      onEvent(type, payload) {
        if (NOISY.has(type)) return;
        c.invalidate(`/companies/${encodeURIComponent(target)}`);
        const entity = typeof payload.entityType === 'string' ? payload.entityType : '';
        const taskId = typeof payload.issueId === 'string' ? payload.issueId : entity === 'issue' && typeof payload.entityId === 'string' ? payload.entityId : undefined;
        if (taskId) c.invalidate(`/issues/${taskId}`);
        queueEmit(type.startsWith('heartbeat.') ? ['runs', 'tasks', 'inbox'] : type === 'agent.status' ? ['agents', 'inbox'] : ['tasks', 'inbox'], taskId);
        if (!live.settleTimer) live.settleTimer = timers.setTimeout(() => { live.settleTimer = null; c.invalidate(`/companies/${encodeURIComponent(target)}`); queueEmit(['tasks', 'inbox']); }, SETTLE_MS);
      },
      // A live socket dropping is often the first sign Paperclip went away: tell the screens, which re-read and show it.
      // (A socket that never opened says nothing new, so a refused socket never wakes the renderer.)
      onDown() { const wasLive = live.channel === 'socket'; live.socket = null; live.socketCompany = ''; live.channel = 'off'; if (wasLive) queueEmit(['config']); schedulePoll(); },
    }, options.socket);
  }

  // --- the turn ledger ---------------------------------------------------------------------------------------------------
  let ledgerStore: TurnLedger | undefined;
  const ledger = () => ledgerStore ??= new TurnLedger(context.db());
  const offLedger = attachTurnLedger(context, ledger, entry => queueEmit(['runs'], entry.taskId ?? undefined), run => local.attribution(run.projectId, run.chatId));
  const ledgerView = async (limit: number): Promise<LedgerView> => {
    let entries = ledger().list({ limit });
    const c = connection();
    if (c) {
      await paperclipPart(false);
      if (built) {
        const runs = await c.get<unknown>(`/companies/${encodeURIComponent(built.companyId)}/heartbeat-runs?limit=${Math.min(limit, 200)}`).catch(() => []);
        const receipts = arr(runs).map(r => mapReceipt(r, built!.agents)), seen = new Set(receipts.map(r => r.runId));
        // An imported Paperclip run that the linked Paperclip still reports is shown once, as Paperclip's own receipt.
        entries = [...entries.filter(e => !(e.source === 'history' && e.chatId === null && seen.has(e.runId))), ...receipts];
      }
    }
    return { entries: entries.sort((a, b) => b.endedAt.localeCompare(a.endedAt)), chain: ledger().verify() };
  };
  // Imported history (#190): past turns come in once, in the background, a batch per tick. It starts on the first badge
  // read (the sidebar asks a few seconds after the window painted) or when the Ledger opens, never on the startup path.
  const history = { run: null as Promise<HistoryResult> | null, timer: null as ReturnType<typeof setTimeout> | null, done: false, disposed: false };
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  const importHistory = (): Promise<HistoryResult> => {
    if (history.run) return history.run;
    history.run = importLedgerHistory(context.db(), ledger(), {
      pause: tick, stopped: () => history.disposed,
      pricing: (providerId, model) => { try { return (context.modelCatalog?.().providers.find(p => p.id === providerId) as unknown as { models?: { id: string; pricing?: never }[] } | undefined)?.models?.find(m => m.id === model)?.pricing ?? null; } catch { return null; } },
    }).then(result => { history.done = true; if (result.turns) queueEmit(['runs']); return result; }).catch(() => ({ chats: 0, turns: 0 })).finally(() => { history.run = null; });
    return history.run;
  };
  const scheduleHistory = () => {
    if (history.done || history.run || history.timer || history.disposed) return;
    history.timer = timers.setTimeout(() => { history.timer = null; void importHistory(); }, 0);
  };

  // --- Pause all / Resume all ---------------------------------------------------------------------------------------------
  // What Pause all paused, per scope ('local', or 'paperclip:<company>'), so Resume all wakes only those and never an
  // agent you had paused on purpose. A marker row ('') records that Pause all ran even when it changed nothing.
  let pausedReady = false;
  const pausedDb = () => { const db = context.db(); if (!pausedReady) { db.exec('CREATE TABLE IF NOT EXISTS pause_all_sets (scope TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(scope, id))'); pausedReady = true; } return db; };
  const recordPaused = (scope: string, ids: readonly string[]) => { const insert = pausedDb().prepare('INSERT OR IGNORE INTO pause_all_sets (scope, id) VALUES (?, ?)'); for (const x of ['', ...ids]) insert.run(scope, x); };
  /** The ids Pause all paused, or null when it never ran for this scope (then Resume all wakes every paused agent). */
  const pausedSet = (scope: string): string[] | null => { const rows = pausedDb().prepare('SELECT id FROM pause_all_sets WHERE scope = ?').all(scope) as { id: string }[]; return rows.length ? rows.map(r => r.id).filter(Boolean) : null; };
  const forgetPaused = (scope: string, id?: string) => { if (id === undefined) pausedDb().prepare('DELETE FROM pause_all_sets WHERE scope = ?').run(scope); else pausedDb().prepare('DELETE FROM pause_all_sets WHERE scope = ? AND id = ?').run(scope, id); };

  /** What Resume can wake: only what Muster's Pause stopped (company-wide, all Muster projects, or one project's Roster). */
  const resumable = (p: PaperclipPart | null): NonNullable<WorkspaceSnapshot['agentCounts']>['resumable'] => {
    const rows = (pausedDb().prepare("SELECT scope, id FROM pause_all_sets WHERE id <> ''").all() as { scope: string; id: string }[]);
    const paused = new Set((p?.agents ?? []).filter(a => a.status === 'paused').map(a => a.id)), projects: Record<string, number> = {};
    for (const r of rows) if (r.scope.startsWith('local:')) projects[r.scope.slice(6)] = (projects[r.scope.slice(6)] ?? 0) + 1;
    return { paperclip: rows.filter(r => r.scope === `paperclip:${built?.companyId ?? ''}` && paused.has(r.id)).length, local: rows.filter(r => r.scope === 'local').length, projects };
  };

  // --- Inbox dismissals ------------------------------------------------------------------------------------------------
  // Keyed by item id and the item's time: a dismissed failure stays hidden, a new one (a later time) shows again.
  let dismissReady = false;
  const dismissDb = () => { const db = context.db(); if (!dismissReady) { db.exec('CREATE TABLE IF NOT EXISTS inbox_dismissals (id TEXT PRIMARY KEY, at TEXT NOT NULL, dismissed_at TEXT NOT NULL)'); dismissReady = true; } return db; };
  const dismissed = (): Map<string, string> => { try { return new Map((dismissDb().prepare('SELECT id, at FROM inbox_dismissals').all() as { id: string; at: string }[]).map(r => [r.id, r.at])); } catch { return new Map(); } };

  // --- memory ------------------------------------------------------------------------------------------------------------
  const memoryFor = async (taskId: string): Promise<WorkspaceMemory> => {
    let title: string, repo: string | null = null, cwd: string | null = null, projectName: string | null = null, localProjectId: string | null = null;
    if (await owner('task', taskId) === 'local') {
      const { project, view: task } = await local.projectFor(taskId);
      title = task.title; projectName = project.name; localProjectId = project.id;
      const primary = folders().find(f => f.id === project.primaryFolderId);
      if (primary) { cwd = primary.path; repo = (await remoteOf(primary.path)) ?? null; }
    } else {
      const part = built?.part;
      const task = part?.tasks.find(t => t.id === taskId || t.key === taskId);
      if (!task) throw new Error('That task is not in the linked Paperclip.');
      title = task.title;
      const project = part?.projects.find(p => p.id === task.projectId);
      repo = project?.repo ?? null; cwd = project?.cwd ?? null; projectName = project?.name ?? null;
    }
    // The repository's bank: a Muster folder with the same origin remote (or the same path) shares memory with this task.
    const folder = await folderFor(repo, cwd);
    const scopeId = folder?.id ?? (localProjectId ? `project:${localProjectId}` : undefined);
    const browse = await context.invoke('memory.browse', scopeId ? { folderId: scopeId } : {});
    let records = rankMemories(browse.records, title);
    let engine = browse.status.connection;
    if (engine === 'connected' || engine === 'unchecked') {
      try {
        const recalled = await context.invoke('memory.recall', { ...(scopeId ? { folderId: scopeId } : {}), query: title, budget: 'low', maxTokens: 1024 });
        const seen = new Set(records.map(r => r.text));
        records = [...records, ...recalled.records.filter(r => !seen.has(r.text)).slice(0, 6)];
        engine = 'connected';
      } catch { engine = engine === 'connected' ? 'local-only' : engine; }
    }
    const scope: WorkspaceMemory['scope'] = folder ? { kind: 'repository', label: folder.name, folderId: folder.id } : localProjectId ? { kind: 'project', label: projectName ?? 'Project', folderId: `project:${localProjectId}` } : { kind: 'personal', label: 'Personal', folderId: null };
    const where = folder ? `the ${folder.name} folder${repo ? ` (${repo})` : ''}` : scope.kind === 'project' ? `the ${scope.label} project` : 'your personal memory';
    const total = browse.records.length;
    const note = records.length ? `Recalled from ${where} by matching this task’s title. An agent working on it would get these notes.`
      : total ? `${total} ${total === 1 ? 'memory' : 'memories'} in ${where}, none about this task yet.`
      : folder || scope.kind === 'project' ? `No memories in ${where} yet. When Muster chats in this repository remember decisions, fixes or preferences, the ones about this task appear here.`
      : `No Muster folder matches ${repo ?? projectName ?? 'this task’s project'}${repo ? '' : ' (it has no git remote)'}. Open the repository in Muster: its memories will be recalled here.`;
    return { scope, repo, query: title, records, engine, note };
  };

  // --- the task thread ---------------------------------------------------------------------------------------------------
  const localDetail = async (taskId: string): Promise<WorkspaceTaskDetail> => {
    const detail = await local.detail(taskId);
    // The work layer's labels, pull requests and goal for this task (the same overlay the snapshot carries).
    const over = await context.invoke('work.overlay', {}).catch(() => null);
    if (over) { const t = detail.task; if (over.labels[t.id]) t.labels = over.labels[t.id]; if (over.prs[t.id]) t.pr = over.prs[t.id]; if (over.goals[t.id]) t.goalId = over.goals[t.id]; }
    const chatIds = detail.runs.map(r => r.chatId).filter((c): c is string => Boolean(c));
    const cards: ThreadCard[] = [...detail.cards];
    // Handoff packets carry the memory Muster hands the next run (PRJ-18).
    const packet = await context.invoke('project.handoff.latest', { projectId: detail.task.projectId ?? '', taskId }).then(r => r.packet).catch(() => null);
    if (packet) cards.push({ kind: 'handoff', id: `handoff:${packet.id}`, at: packet.createdAt, from: 'You', to: detail.task.assigneeLabel, summary: `Handoff v${packet.version}${packet.stale ? ' (stale)' : ''} · ${packet.decisions.length} decisions · ${packet.artifacts.length} artifacts`, memory: packet.memory.map(m => ({ text: m.text, source: m.scope })) });
    // Decisions carried over from Paperclip: read-only; pending ones are also in the Inbox as Needs you.
    for (const h of imports()?.history(detail.task.projectId ?? undefined).filter(x => x.taskId === taskId) ?? []) {
      if (h.kind.startsWith('approval')) cards.push({ kind: 'approval', id: `import:${h.sourceId}`, at: h.at, title: h.title, status: h.status, ...(h.pending && linkedApproval(h.sourceId, h.projectId) ? { approvalId: h.sourceId.slice('approval:'.length), verbs: ['approve', 'reject', 'request_revision'] as ApprovalDecision[] } : {}) });
      else if (h.kind.startsWith('document:')) { const doc = parseJson(h.detail); cards.push({ kind: 'document', id: `import:${h.sourceId}`, at: h.at, key: h.kind.slice('document:'.length), title: h.title, format: String(doc.format ?? 'markdown'), body: String(doc.body ?? ''), revision: Number(h.status) || 1, revisions: Array.isArray(doc.revisions) ? doc.revisions as never : [] }); }
      else if (h.kind.startsWith('work_product:')) { const w = parseJson(h.detail); cards.push({ kind: 'workproduct', id: `import:${h.sourceId}`, at: h.at, type: h.kind.slice('work_product:'.length), title: h.title, status: h.status, provider: typeof w.provider === 'string' ? w.provider : null, url: typeof w.url === 'string' ? w.url : null, summary: typeof w.summary === 'string' ? w.summary : '' }); }
      else cards.push({ kind: 'needs', id: `import:${h.sourceId}`, at: h.at, from: null, prompt: h.title, detail: null, status: h.pending ? 'pending' : h.status === 'cancelled' || h.status === 'withdrawn' ? 'cancelled' : 'resolved', resolution: h.detail || null, interactionId: null, acceptLabel: null, rejectLabel: null });
    }
    // A run waiting on you: its real pending question or approval, answered in place so that run continues.
    let waiting = false;
    for (const run of detail.runs.filter(r => r.status === 'running' && r.chatId)) {
      const items = await context.invoke('chat.timeline', { id: run.chatId! }).then(t => t.items, () => []);
      for (const item of items) {
        if ((item.kind !== 'question' && item.kind !== 'approval') || item.status !== 'pending') continue;
        waiting = true;
        const questions = item.kind === 'question' && Array.isArray(item.data?.questions) ? (item.data.questions as { question?: unknown }[]).map(q => typeof q.question === 'string' ? q.question : '').filter(Boolean) : [];
        cards.push({ kind: 'needs', id: `needs:${item.id}`, at: item.createdAt, from: detail.task.assigneeLabel, prompt: questions.join('\n') || item.text, detail: null, status: 'pending', resolution: null, interactionId: null, acceptLabel: null, rejectLabel: null, chatId: run.chatId ?? null, pending: item });
      }
    }
    const asking = detail.runs.find(r => r.status === 'running' && r.chatId);
    if (!waiting && detail.task.status === 'in_review' && asking) cards.push({ kind: 'needs', id: `needs:${taskId}`, at: detail.task.updatedAt, from: detail.task.assigneeLabel, prompt: 'The agent is waiting for your answer in its run.', detail: null, status: 'pending', resolution: null, interactionId: null, acceptLabel: null, rejectLabel: null, chatId: asking.chatId ?? null, pending: null });
    const receipts = chatIds.length ? ledger().list({ chatIds, limit: 50 }) : [];
    // The task is the conversation: each run's final answer is a turn in the thread, carrying that run's Receipt.
    const comments = [...detail.comments];
    for (const run of detail.runs) {
      if (!run.chatId) continue;
      const items = await context.invoke('chat.timeline', { id: run.chatId }).then(t => t.items, () => []);
      const last = [...items].reverse().find(i => i.kind === 'assistant' && i.text.trim());
      if (!last) continue;
      const receipt = receipts.filter(r => r.chatId === run.chatId).sort((a, b) => b.endedAt.localeCompare(a.endedAt))[0];
      comments.push({ id: `run:${run.id}:${last.id}`, author: { kind: 'agent', id: run.agentId, label: detail.task.assigneeLabel ?? 'Agent' }, body: last.text, createdAt: last.createdAt, runId: receipt?.runId ?? null });
    }
    comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    // Governance: the review stage card, hold, policy, why runs started, follow-up check, stopped-subtree finding.
    const projectId = detail.task.projectId ?? '';
    const gov = projectId ? await context.invoke('project.gov.task', { projectId, taskId }).catch(() => null) : null;
    let governance: WorkspaceTaskDetail['governance'];
    if (gov) {
      if (gov.stage) cards.push({ kind: 'stage', id: `stage:${taskId}`, at: gov.stage.updatedAt, stage: gov.stage });
      for (const p of gov.proposals) cards.push({ kind: 'secret', id: `secret:${p.id}`, at: p.createdAt, proposal: p, secureStorage: gov.secureStorage });
      governance = { stage: gov.stage, policy: gov.policy, effectivePolicy: gov.effectivePolicy, hold: gov.hold, hidden: gov.hidden, runs: gov.runs, monitor: gov.monitor, watchdog: gov.watchdog, agents: gov.agents };
    }
    return { ...detail, comments, cards, receipts, ...(governance ? { governance } : {}) };
  };
  const paperclipDetail = async (taskId: string): Promise<WorkspaceTaskDetail> => {
    const c = api();
    await paperclipPart(false);
    const agents = built?.agents ?? new Map<string, WorkspaceAgent>(), part = built?.part;
    const key = encodeURIComponent(taskId);
    const [issue, comments, runs, interactions, approvals, documents, products] = await Promise.all([
      c.get<Json>(`/issues/${key}`), allPages(c.commentPages(taskId)), c.get<unknown>(`/issues/${key}/runs`).catch(() => []),
      c.get<unknown>(`/issues/${key}/interactions`).catch(() => []), c.get<unknown>(`/issues/${key}/approvals`).catch(() => []),
      c.get<unknown>(`/issues/${key}/documents`).catch(() => []), c.get<unknown>(`/issues/${key}/work-products`).catch(() => []),
    ]);
    // Documents with their revisions (a plan is the one with key `plan`), and the PRs, branches and artifacts agents produced.
    const documentCards = await Promise.all(arr(documents).map(async d => mapDocument(d, Number(d.latestRevisionNumber) > 1 ? arr(await c.get<unknown>(`/issues/${key}/documents/${encodeURIComponent(String(d.key))}/revisions`).catch(() => [])) : [], agents)));
    const liveTasks = new Set((part?.runs ?? []).filter(r => r.status === 'running').map(r => r.taskId).filter((t): t is string => Boolean(t)));
    const task = mapIssue(issue, agents, liveTasks);
    const taskRuns = arr(runs).map(mapRun);
    if (taskRuns.some(r => r.status === 'running' || r.status === 'queued')) task.live = true;
    const assignee = task.assigneeId ? agents.get(task.assigneeId) : undefined;
    const children = (part?.tasks ?? []).filter(t => t.parentId === task.id);
    const cards: ThreadCard[] = [
      ...children.map(child => ({ kind: 'delegated' as const, id: `delegated:${child.id}`, at: child.createdAt, from: task.assigneeLabel ?? child.origin, to: child.assigneeLabel, taskId: child.id, key: child.key, title: child.title, brief: `${child.key} · ${child.title}` })),
      ...arr(interactions).map(i => mapInteraction(i, agents)), ...documentCards, ...arr(products).map(mapWorkProduct),
      ...arr(approvals).map(a => { const m = mapApproval(a, agents), open = a.status === 'pending' || a.status === 'revision_requested'; return { kind: 'approval' as const, id: `approval:${a.id}`, at: String(a.createdAt ?? ''), title: open ? m.title : String((a.payload as Json | undefined)?.title ?? (a.payload as Json | undefined)?.name ?? a.type ?? 'Approval'), status: String(a.status ?? 'pending'), ...(m.detail ? { detail: m.detail } : {}), requestedBy: m.requestedBy, ...(open ? { approvalId: String(a.id), verbs: m.verbs } : {}) }; }),
    ];
    // Hand-offs: when the task moved to another agent (or came from its parent's owner), carry the Muster memory with it.
    const parent = task.parentId ? part?.tasks.find(t => t.id === task.parentId) : undefined;
    if (parent && parent.assigneeLabel && task.assigneeLabel && parent.assigneeLabel !== task.assigneeLabel) {
      const memory = await memoryFor(task.id).then(m => m.records.slice(0, 4).map(r => ({ text: r.text, source: r.source === 'hindsight' ? 'Hindsight' : m.scope.label })), () => []);
      cards.push({ kind: 'handoff', id: `handoff:${task.id}`, at: task.createdAt, from: parent.assigneeLabel, to: task.assigneeLabel, summary: `${parent.key} → ${task.key}`, memory });
    }
    return {
      task, description: typeof issue.description === 'string' ? issue.description : '', comments: arr(comments).filter(x => !x.deletedAt).map(x => mapComment(x, agents)),
      runs: taskRuns.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20),
      addressee: assignee ? { id: assignee.id, label: assignee.name } : null,
      composerNote: assignee ? null : 'Unassigned. Your comment is posted to the thread; @-mention an agent to bring it in.',
      subtasks: children.map(t => t.id), blocking: (part?.tasks ?? []).filter(t => t.blockedByIds.includes(task.id)).map(t => t.id),
      receipts: arr(runs).map(r => mapReceipt(r, agents)).sort((a, b) => b.endedAt.localeCompare(a.endedAt)).slice(0, 50),
      cards: cards.sort((a, b) => a.at.localeCompare(b.at)),
      mentionable: (part?.agents ?? []).filter(a => a.status !== 'terminated').map(a => ({ id: a.id, name: a.name })),
    };
  };

  // --- lists (Outputs, Ledger activity, Paperclip routines) -------------------------------------------------------------
  const localRows = async (kind: WorkspaceListKind): Promise<WorkspaceRow[]> => {
    if (kind === 'routines') return [];
    const projects = (await context.invoke('project.list', undefined)).filter(p => !p.archived);
    const works = await Promise.all(projects.map(p => context.invoke('project.work', { projectId: p.id, activityLimit: 100 }).then(w => ({ p, w }))));
    if (kind === 'audit') return works.flatMap(({ p, w }) => w.activity.items.map(a => ({ id: `act:${a.id}`, title: a.summary, detail: `${p.name} · ${a.actor}`, status: a.kind, at: a.createdAt, source: 'local' as const, projectId: p.id })));
    const manual = works.flatMap(({ p, w }) => w.tasks.items.flatMap(t => t.artifacts.map((path, i) => ({ id: `art:${t.id}:${i}`, title: path.split('/').pop() || path, detail: `${p.name} · ${t.title} · ${path}`, status: null, at: t.updatedAt, source: 'local' as const, projectId: p.id, path, taskId: t.id }))));
    // What the agents actually produced: the files their turns changed (from the Ledger's Receipts, newest change per
    // path), the canvases made in the project's chats or folders, and the files attached to those chats.
    const changed: WorkspaceRow[] = [];
    for (const p of projects) {
      const seen = new Set<string>();
      for (const entry of ledger().list({ projectId: p.id, limit: 200 })) for (const file of entry.files ?? []) {
        if (seen.has(file.path)) continue;
        seen.add(file.path);
        changed.push({ id: `file:${p.id}:${file.path}`, title: file.path.split('/').pop() || file.path, detail: `${p.name} · ${entry.agent} · ${file.path}`, status: file.status, at: entry.endedAt, source: 'local', projectId: p.id, path: file.path, taskId: entry.taskId, agent: entry.agent });
      }
    }
    const chats = (context.store.snapshot().chats ?? []).filter(c => c.projectId && projects.some(p => p.id === c.projectId));
    const projectOfChat = new Map(chats.map(c => [c.id, c.projectId!]));
    const byId = new Map(projects.map(p => [p.id, p]));
    const canvases = await context.invoke('artifacts.canvas.list', {}).then(r => r.canvases, () => []);
    const drawn = canvases.flatMap(c => {
      const projectId = (c.chatId && projectOfChat.get(c.chatId)) || projects.find(p => c.folderId && p.folderIds.includes(c.folderId))?.id;
      const p = projectId ? byId.get(projectId) : undefined;
      return p ? [{ id: `canvas:${c.id}`, title: c.title || 'Canvas', detail: `${p.name} · Canvas`, status: 'canvas', at: c.updatedAt, source: 'local' as const, projectId: p.id }] : [];
    });
    const recent = [...chats].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).slice(0, 50);
    const attached = (await Promise.all(recent.map(c => context.invoke('attachments.list', { chatId: c.id }).then(list => list.filter(a => a.state === 'sent').map(a => ({ id: `attachment:${a.id}`, title: a.name, detail: `${byId.get(c.projectId!)?.name ?? 'Project'} · Attached in ${c.title || 'a chat'}`, status: 'attachment', at: c.updatedAt ?? null, source: 'local' as const, projectId: c.projectId! })), () => [])))).flat();
    return [...manual, ...changed, ...drawn, ...attached];
  };
  const list = async (kind: WorkspaceListKind): Promise<WorkspaceList> => {
    const mine = await localRows(kind).catch(() => [] as WorkspaceRow[]);
    const c = connection();
    let remote: WorkspaceRow[] = [], note = '';
    if (c) {
      try {
        await paperclipPart(false);
        if (!built) throw new Error(lastError ?? 'not reachable');
        const base = `/companies/${encodeURIComponent(built.companyId)}`;
        remote = mapRows(kind, await c.get<unknown>(kind === 'artifacts' ? `${base}/artifacts` : kind === 'audit' ? `${base}/activity?limit=150` : `${base}/routines`));
      } catch (cause) { note = `Paperclip could not be read: ${cause instanceof Error ? cause.message : String(cause)}`; }
    }
    return { kind, rows: [...mine, ...remote].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')).slice(0, 400), note };
  };

  const badge = async (): Promise<WorkspaceBadge> => {
    const [mail, snap] = await Promise.all([context.invoke('mailbox.list', { limit: 1 }).then(m => m.unacked).catch(() => 0), snapshotInflight ?? merge(false, false)]);
    const hidden = dismissed();
    // A snoozed item (for this very `at`, until its time) stays off the badge until it wakes.
    const meta = new Map(((await context.invoke('work.inbox.state', {}).catch(() => ({ items: [] }))).items).map(m => [m.id, m]));
    const asleep = (i: { id: string; at: string }) => { const m = meta.get(`ws:${i.id}`); return Boolean(m?.snoozedUntil && Date.parse(m.snoozedUntil) > Date.now() && m.snoozedFor === i.at); };
    const urgent = snap.inbox.filter(i => URGENT.has(i.kind) && hidden.get(`ws:${i.id}`) !== i.at && !asleep(i));
    let orgs: Record<string, string> = {}; try { orgs = imports()?.projectOrgs() ?? {}; } catch { /* no import store */ }
    return { connected: Boolean(snap.paperclip), inbox: urgent.length, liveRuns: snap.counts.liveRuns, mail, chatIds: [...new Set(urgent.flatMap(i => i.chatIds ?? []))], company: snap.paperclip?.company?.name ?? companies.find(c => c.id === (config.companyId ?? companies[0]?.id))?.name ?? null, orgs };
  };

  /** Starts a Muster task's first run on its owner's runner, in a new worktree of the project's folder (never the checkout). */
  const startTask = async (taskId: string) => {
    if (await owner('task', taskId) === 'paperclip') throw new Error('This task runs in Paperclip. Import it first to run it in Muster.');
    const { project, view: task } = await local.projectFor(taskId);
    // Paused means nothing new starts until you resume, by hand or by the scheduler.
    if ((await context.invoke('project.work', { projectId: project.id, activityLimit: 1 })).scheduler.paused) throw new Error(`${project.name} is paused, so nothing new starts. Resume its agents first.`);
    const held = task.assigneeId?.startsWith('member:') ? (await context.invoke('project.members.list', { projectId: project.id })).members.find(m => m.id === task.assigneeId!.slice(7) && m.pausedAt) : undefined;
    if (held) throw new Error(`${held.name} is paused, so nothing of theirs starts. Resume ${held.name} first.`);
    const source = folders().find(f => f.id === project.primaryFolderId);
    if (!source) throw new Error('Link the project’s folder first: runs happen in a worktree of it.');
    const meta = imports()?.projectMeta(project.id), base = typeof meta?.defaultRef === 'string' ? meta.defaultRef : undefined;
    const branch = `muster/${task.key.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`;
    // A worktree of its own: the run never touches the project's checkout. Starting again reuses this task's worktree.
    const reuse = (await context.invoke('git.worktree.list', { folderId: source.id }).catch(() => [])).find(w => !w.main && !w.prunable && (w.branch === branch || w.branch === `refs/heads/${branch}`));
    const worktree = reuse ? { folder: await context.invoke('folder.add', { path: reuse.path }), path: reuse.path, branch } : await context.invoke('git.worktree.create', { folderId: source.id, branch, ...(base ? { base } : {}) });
    try {
      context.hooks.noteTaskWorktree?.(project.id, taskId, worktree.folder.id);
      if (!project.folderIds.includes(worktree.folder.id)) await context.invoke('project.linkFolder', { id: project.id, folderId: worktree.folder.id });
      // The run uses its owner's runner and model (set on the Roster member); the project's default model is left alone.
      const fresh = (await context.invoke('project.work', { projectId: project.id, activityLimit: 1 })).tasks.items.find(t => t.id === taskId);
      if (!fresh) throw new Error('That task no longer exists.');
      const run = await context.invoke('project.tasks.dispatch', { projectId: project.id, id: taskId, revision: fresh.revision, folderId: worktree.folder.id });
      queueEmit(['tasks', 'runs'], taskId);
      return { ...run, worktree: worktree.path, branch: worktree.branch };
    } catch (cause) {
      // Nothing ran: take back the worktree and folder this Start made (the branch stays, and a reused worktree is kept).
      if (!reuse) {
        await context.invoke('project.unlinkFolder', { id: project.id, folderId: worktree.folder.id }).catch(() => undefined);
        await context.invoke('git.worktree.remove', { folderId: source.id, path: worktree.path }).catch(() => undefined);
        await context.invoke('folder.remove', { id: worktree.folder.id }).catch(() => undefined);
      }
      throw cause;
    }
  };

  // --- the Dashboard (#132) -------------------------------------------------------------------------------------------------
  const dashboard = async (offset: number, projectId?: string) => {
    const now = Date.now(), since = new Date(now - (DASHBOARD_DAYS + 1) * 86_400_000).toISOString();
    ledger();
    const c = connection();
    let paperclip: Parameters<typeof buildDashboard>[0]['paperclip'] = null, budgets: DashboardData['budgets'];
    if (c && (!projectId || await owner('project', projectId) === 'paperclip')) {
      await paperclipPart(false);
      if (built) {
        const base = `/companies/${encodeURIComponent(built.companyId)}`;
        const [runs, activity, overview] = await Promise.all([c.get<unknown>(`${base}/heartbeat-runs?limit=200`).catch(() => []), c.get<unknown>(`${base}/activity?limit=12`).catch(() => []), c.get<unknown>(`${base}/budgets/overview`).catch(() => null)]);
        if (overview) budgets = { ...mapBudgets(overview), company: companies.find(x => x.id === built?.companyId)?.name ?? 'Paperclip' };
        const inProject = projectId ? new Set(built.part.tasks.filter(t => t.projectId === projectId).map(t => t.id)) : null;
        paperclip = { receipts: arr(runs).map(r => mapReceipt(r, built!.agents)).filter(r => !inProject || (r.taskId !== null && inProject.has(r.taskId))), tasks: built.part.tasks.filter(t => !projectId || t.projectId === projectId), activity: mapRows('audit', activity), name: companies.find(x => x.id === built?.companyId)?.name ?? 'Paperclip' };
      }
    }
    const [aggregates, stats] = [
      ledgerAggregates(context.db(), { since, monthStart: monthStart(now, offset), offset, skipImportedPaperclip: paperclip !== null, ...(projectId ? { projectId } : {}) }),
      // A project's Dashboard tab and Budget read that project's tasks, runs and activity; a Paperclip project has none here.
      projectId && paperclip ? null : await context.invoke('project.stats', { days: DASHBOARD_DAYS + 1, utcOffsetMinutes: offset, activityLimit: 12, ...(projectId ? { projectId } : {}) }).catch(() => null),
    ];
    const result = buildDashboard({ now, offset, ledger: aggregates, local: stats, paperclip });
    return budgets ? { ...result, budgets } : result;
  };

  const text = (value: unknown, label: string, max: number) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`); if (value.length > max) throw new Error(`${label} is too long.`); return value; };
  const id = (value: unknown) => { if (typeof value !== 'string' || !/^[\w:.-]{1,128}$/.test(value)) throw new Error('Unknown item.'); return value; };
  const sourceOf = (value: unknown): WorkspaceSource => value === 'paperclip' ? 'paperclip' : 'local';

  return {
    handlers: {
      'paperclip.config.get': () => view(),
      'paperclip.config.set': input => {
        const mode = input.mode === 'local' || input.mode === 'custom' ? input.mode : 'off';
        const baseUrl = mode === 'custom' ? normalizeBaseUrl(input.baseUrl) : mode === 'local' ? PAPERCLIP_LOCAL_URL : config.baseUrl;
        // A token belongs to one custom origin. This Mac needs none, so a token sent with another mode is ignored; moving
        // to a different origin without a new token forgets the old one rather than sending it to the new host.
        let tokenOrigin = config.tokenOrigin;
        const forget = () => { if (secrets().status(PAPERCLIP_SECRET_ID).stored) secrets().clear(PAPERCLIP_SECRET_ID); tokenOrigin = null; };
        if (input.token === '') forget();
        else if (mode === 'custom' && typeof input.token === 'string') { secrets().set(PAPERCLIP_SECRET_ID, input.token); tokenOrigin = originOf(baseUrl); }
        else if (mode === 'custom' && tokenOrigin !== originOf(baseUrl)) forget();
        const companyId = input.companyId === null ? null : typeof input.companyId === 'string' ? id(input.companyId) : config.companyId;
        saveConfig({ mode, baseUrl, companyId, tokenOrigin });
        closeSocket(); stopPoll(); built = null; client = null; companies = []; lastError = undefined;
        queueEmit(['config', 'tasks', 'runs', 'agents', 'inbox']);
        return view();
      },
      'paperclip.test': async (input): Promise<PaperclipTestResult> => {
        const mode = input.mode === 'local' || input.mode === 'custom' || input.mode === 'off' ? input.mode : config.mode;
        if (mode === 'off') return { ok: true, stage: 'ok', message: 'Paperclip is not linked. Projects show Muster’s own work only.' };
        let endpoint;
        const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl : config.baseUrl;
        try { endpoint = endpointFor(mode, baseUrl, typeof input.token === 'string' && input.token ? input.token : tokenFor(baseUrl)); }
        catch (cause) { return { ok: false, stage: 'config', message: cause instanceof Error ? cause.message : String(cause) }; }
        const probe = new PaperclipClient(endpoint, options.fetch), started = Date.now();
        // A token over plain http to another machine crosses the network in clear text: say so, but let the test run.
        const warning = mode === 'custom' && new URL(endpoint.baseUrl).protocol === 'http:' && !isLoopback(endpoint.baseUrl)
          ? `${endpoint.token ? 'Your API token' : 'An API token added here'} would be sent over plain http to ${new URL(endpoint.baseUrl).host}, readable by anyone on the network. Use an https:// address.` : undefined;
        try {
          const health = await probe.get<Json>('/health');
          const list = arr(await probe.get<unknown>('/companies')).map(mapCompany);
          const deploymentMode = typeof health.deploymentMode === 'string' ? health.deploymentMode : undefined;
          return { ok: true, stage: 'ok', ...(warning ? { warning } : {}), latencyMs: Date.now() - started, version: typeof health.version === 'string' ? health.version : undefined, deploymentMode, companies: list,
            message: `Connected to Paperclip ${health.version ?? ''} (${deploymentMode === 'local_trusted' ? 'local, no sign-in' : deploymentMode ?? 'unknown mode'}). ${list.length} ${list.length === 1 ? 'company' : 'companies'}.`.replace('  ', ' ') };
        } catch (cause) {
          return { ok: false, stage: cause instanceof PaperclipError ? cause.stage : 'network', ...(warning ? { warning } : {}), message: cause instanceof Error ? cause.message : String(cause), latencyMs: Date.now() - started };
        }
      },
      'paperclip.snapshot': input => snapshot(input.refresh === true),
      'paperclip.task': async input => { const taskId = id(input.id); return await owner('task', taskId) === 'paperclip' ? paperclipDetail(taskId) : localDetail(taskId); },
      'paperclip.comment': async input => {
        const taskId = id(input.taskId), body = text(input.body, 'Message', 20_000);
        if (await owner('task', taskId) === 'local') { const comment = await local.comment(taskId, body); queueEmit(['tasks'], taskId); return comment; }
        const created = await api().send<Json>('POST', `/issues/${encodeURIComponent(taskId)}/comments`, { body });
        queueEmit(['tasks'], taskId);
        return mapComment(created, built?.agents ?? new Map());
      },
      'paperclip.task.update': async input => {
        const taskId = id(input.taskId), changes: Json = {};
        if (input.status !== undefined) { if (!WORKSPACE_STATUSES.includes(input.status as WorkspaceStatus)) throw new Error('Unknown status.'); changes.status = input.status; }
        if (input.priority !== undefined) { if (!WORKSPACE_PRIORITIES.includes(input.priority as WorkspacePriority)) throw new Error('Unknown priority.'); changes.priority = input.priority; }
        if (input.assigneeId !== undefined) {
          // An agent, or nobody (null, or you: a Paperclip task owned by the board is simply unassigned from an agent).
          if (input.assigneeId !== null && typeof input.assigneeId !== 'string') throw new Error('Unknown assignee.');
          changes.assigneeAgentId = input.assigneeId === null || input.assigneeId.startsWith('user:') ? null : id(input.assigneeId);
        }
        if (!Object.keys(changes).length) throw new Error('Nothing to change.');
        if (await owner('task', taskId) === 'local') {
          if (changes.priority !== undefined || changes.assigneeAgentId !== undefined) throw new Error('Change a Muster task’s priority or owner in its project’s task list.');
          return local.setStatus(taskId, changes.status as WorkspaceStatus);
        }
        // Only what you changed is sent: Paperclip's own PATCH, user-initiated.
        const updated = await api().send<Json>('PATCH', `/issues/${encodeURIComponent(taskId)}`, changes);
        queueEmit(['tasks', 'inbox'], taskId);
        return mapIssue(updated, built?.agents ?? new Map(), new Set());
      },
      'paperclip.task.create': async input => {
        const projectId = typeof input.projectId === 'string' && input.projectId ? id(input.projectId) : null;
        if (!projectId || await owner('project', projectId) === 'local') {
          const task = await local.createTask(input as never);
          queueEmit(['tasks']);
          // Assign & start: the owner's first run, on its runner, in a new worktree of the project's folder.
          if (input.start !== true) return task;
          if (task.assigneeId === 'user:local') return { ...task, startError: 'You own this task. Assign it to an agent on the Roster to start it.' };
          try { return { ...task, started: await startTask(task.id) }; }
          catch (cause) { return { ...task, startError: cause instanceof Error ? cause.message : String(cause) }; }
        }
        const title = text(input.title, 'Title', 500), c = api();
        const body: Json = { title, status: 'todo', description: typeof input.description === 'string' ? input.description.slice(0, 20_000) : '', projectId };
        if (typeof input.priority === 'string' && ['critical', 'high', 'medium', 'low'].includes(input.priority)) body.priority = input.priority;
        if (typeof input.parentId === 'string' && input.parentId) body.parentId = id(input.parentId);
        if (typeof input.assigneeId === 'string' && input.assigneeId && !input.assigneeId.startsWith('user:')) body.assigneeAgentId = id(input.assigneeId);
        // Labels, a goal and the tasks that block this one: Paperclip's own fields on create.
        if (Array.isArray(input.labelIds) && input.labelIds.length) body.labelIds = [...new Set(input.labelIds.slice(0, 20).map(v => id(v)))];
        if (typeof input.goalId === 'string' && input.goalId) body.goalId = id(input.goalId);
        if (Array.isArray(input.blockedByIds) && input.blockedByIds.length) body.blockedByIssueIds = [...new Set(input.blockedByIds.slice(0, 50).map(v => id(v)))];
        const created = await c.send<Json>('POST', `/companies/${encodeURIComponent(built!.companyId)}/issues`, body);
        queueEmit(['tasks', 'inbox']);
        return mapIssue(created, built?.agents ?? new Map(), new Set());
      },
      'paperclip.agent.pause': async input => { const agentId = id(input.id); if (await owner('agent', agentId) === 'local') await local.setPaused(agentId, true); else await api().send('POST', `/agents/${encodeURIComponent(agentId)}/pause`); queueEmit(['agents', 'runs']); return { ok: true }; },
      'paperclip.agent.resume': async input => { const agentId = id(input.id); if (await owner('agent', agentId) === 'local') await local.setPaused(agentId, false); else await api().send('POST', `/agents/${encodeURIComponent(agentId)}/resume`); queueEmit(['agents', 'runs']); return { ok: true }; },
      'paperclip.pauseAll': async input => {
        if (sourceOf(input.source) === 'local') {
          // One project's Roster (from a project page) or every project's scheduler (the hub). Only what is paused here is remembered.
          if (typeof input.projectId === 'string' && input.projectId) {
            const projectId = id(input.projectId), roster = (await local.snapshot()).agents.filter(a => a.projectId === projectId && a.pausable && a.status !== 'paused' && a.status !== 'pending');
            const paused: string[] = [];
            try { for (const agent of roster) { await local.setPaused(agent.id, true); paused.push(agent.id); } } finally { recordPaused(`local:${projectId}`, paused); }
            queueEmit(['agents', 'runs', 'tasks']);
            return { changed: paused.length };
          }
          const ids = await local.pauseAll(); recordPaused('local', ids); queueEmit(['agents', 'runs', 'tasks']); return { changed: ids.length };
        }
        const c = api(); await paperclipPart(true);
        // An agent already paused, still waiting for approval, or terminated is left exactly as it is.
        const agents = (built?.part.agents ?? []).filter(a => a.status !== 'paused' && a.status !== 'terminated' && a.status !== 'pending');
        const paused: string[] = [];
        try { for (const agent of agents) { await c.send('POST', `/agents/${encodeURIComponent(agent.id)}/pause`); paused.push(agent.id); } }
        finally { if (built) recordPaused(`paperclip:${built.companyId}`, paused); }
        queueEmit(['agents', 'runs']);
        return { changed: paused.length };
      },
      'paperclip.resumeAll': async input => {
        if (sourceOf(input.source) === 'local') {
          if (typeof input.projectId === 'string' && input.projectId) {
            const projectId = id(input.projectId), scope = `local:${projectId}`, only = pausedSet(scope);
            const roster = (await local.snapshot()).agents.filter(a => a.projectId === projectId && a.pausable && a.status === 'paused' && (only ?? []).includes(a.id));
            for (const agent of roster) await local.setPaused(agent.id, false);
            forgetPaused(scope);
            queueEmit(['agents']);
            return { changed: roster.length };
          }
          const changed = await local.resumeProjects(pausedSet('local') ?? []); forgetPaused('local'); queueEmit(['agents']); return { changed };
        }
        const c = api(); await paperclipPart(true);
        const scope = `paperclip:${built?.companyId ?? ''}`, only = pausedSet(scope);
        // Only what Pause stopped wakes: with no record there is nothing of ours to resume (an agent you paused stays paused).
        const agents = (built?.part.agents ?? []).filter(a => a.status === 'paused' && (only ?? []).includes(a.id));
        for (const agent of agents) await c.send('POST', `/agents/${encodeURIComponent(agent.id)}/resume`);
        forgetPaused(scope);
        queueEmit(['agents', 'runs']);
        return { changed: agents.length };
      },
      'paperclip.approval.decide': async input => {
        const approvalId = id(input.id), decision = input.decision as ApprovalDecision;
        const path = decision === 'approve' ? 'approve' : decision === 'reject' ? 'reject' : decision === 'request_revision' ? 'request-revision' : null;
        if (!path) throw new Error('Unknown decision.');
        const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 4000) : null;
        if (decision === 'request_revision' && !note) throw new Error('Say what should change.');
        // Only ever sent when you press the button: Paperclip's own approval endpoints.
        await api().send('POST', `/approvals/${encodeURIComponent(approvalId)}/${path}`, { decisionNote: note });
        // The decision is Paperclip's now; what an import recorded about it follows (so the Inbox row clears at once).
        try { imports()?.decideHistory(`approval:${approvalId}`, decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'revision_requested', note ?? '', decision === 'request_revision'); } catch { /* nothing imported */ }
        queueEmit(['tasks', 'inbox', 'agents']);
        return { ok: true as const };
      },
      'paperclip.run.cancel': async input => { const runId = id(input.id); if (await owner('run', runId) === 'local') await local.cancelRun(runId); else await api().send('POST', `/heartbeat-runs/${encodeURIComponent(runId)}/cancel`); queueEmit(['runs', 'tasks']); return { ok: true }; },
      'paperclip.interaction.respond': async input => {
        const taskId = id(input.taskId), interactionId = id(input.interactionId);
        const reason = typeof input.reason === 'string' ? input.reason.slice(0, 4000) : undefined;
        if (Array.isArray(input.answers)) {
          // A question set: Paperclip's respond endpoint, with exactly the options you picked (and any text you typed).
          const answers = input.answers.slice(0, 20).map(a => {
            const answer = a as { questionId?: unknown; optionIds?: unknown; otherText?: unknown };
            const key = (v: unknown) => { if (typeof v !== 'string' || !v.trim() || v.length > 160 || /[\u0000-\u001f]/.test(v)) throw new Error('Unknown answer.'); return v; };
            const optionIds = Array.isArray(answer.optionIds) ? answer.optionIds.slice(0, 129).map(key) : [];
            const otherText = typeof answer.otherText === 'string' && answer.otherText.trim() ? answer.otherText.slice(0, 100_000) : null;
            if (!optionIds.length && !otherText) throw new Error('Answer every question.');
            return { questionId: key(answer.questionId), optionIds, ...(otherText ? { otherText } : {}) };
          });
          if (!answers.length) throw new Error('Answer every question.');
          await api().send('POST', `/issues/${encodeURIComponent(taskId)}/interactions/${encodeURIComponent(interactionId)}/respond`, { answers });
          queueEmit(['tasks', 'inbox'], taskId);
          return { ok: true };
        }
        await api().send('POST', `/issues/${encodeURIComponent(taskId)}/interactions/${encodeURIComponent(interactionId)}/${input.accept === true ? 'accept' : 'reject'}`, input.accept === true ? {} : { ...(reason ? { reason } : {}) });
        queueEmit(['tasks', 'inbox'], taskId);
        return { ok: true };
      },
      'paperclip.import': async input => {
        const mode = input.mode === 'local' || input.mode === 'custom' ? input.mode : config.mode === 'off' ? 'local' : config.mode;
        const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl : config.baseUrl;
        // The importer reads each page once: it keeps no parsed bodies, so a large org never sits in memory twice.
        const reader = new PaperclipClient(endpointFor(mode, baseUrl, typeof input.token === 'string' && input.token ? input.token : tokenFor(baseUrl)), options.fetch, { cache: false });
        const store = imports();
        if (!store) throw new Error('The import store is unavailable.');
        let target = typeof input.companyId === 'string' ? id(input.companyId) : config.companyId;
        if (!target) target = String(arr(await reader.get<unknown>('/companies'))[0]?.id ?? '');
        if (!target) throw new Error('That Paperclip has no companies to import.');
        // GET only: the importer is handed nothing that can write to Paperclip.
        // Folder paths and CODEX_HOME are this Mac's only when Paperclip runs here (This Mac, or a Custom URL on loopback);
        // a remote server's paths are never touched.
        const targets = input.targets && typeof input.targets === 'object' ? Object.fromEntries(Object.entries(input.targets).filter(([k, v]) => /^[\w:.-]{1,128}$/.test(k) && v === 'skip').map(([k]) => [k, 'skip' as const])) : undefined;
        const owners = input.owners && typeof input.owners === 'object' ? Object.fromEntries(Object.entries(input.owners).filter(([k, v]) => /^[\w:.-]{1,128}$/.test(k) && (v === 'mine' || v === 'made')).map(([k, v]) => [k, v as 'mine' | 'made'])) : undefined;
        const onThisMac = mode === 'local' || isLoopback(baseUrl);
        const report = await importFromPaperclip(target, { get: path => reader.get<unknown>(path), issuePages: (company, query) => reader.issuePages(company, query), commentPages: issue => reader.commentPages(issue), invoke: context.invoke as Invoke, store, folders, exists: path => existsSync(path), local: onThisMac, serverOrigin: originOf(mode === 'local' ? PAPERCLIP_LOCAL_URL : baseUrl) ?? undefined, ...(owners ? { owners } : {}), remoteOf, ...(targets ? { targets } : {}), ...(onThisMac ? { codexHome: codexHomeOf } : {}) });
        queueEmit(['tasks', 'agents', 'inbox']);
        // The imported runs show in the Ledger as imported history (#190).
        try { if (ledger().importHistory(paperclipHistory(context.db()))) queueEmit(['runs']); } catch { /* the Ledger never fails an import */ }
        return report;
      },
      'paperclip.task.start': input => startTask(id(input.taskId)),
      'paperclip.dashboard': input => dashboard(typeof input.utcOffsetMinutes === 'number' ? Math.max(-840, Math.min(840, input.utcOffsetMinutes)) : 0, typeof input.projectId === 'string' && input.projectId ? id(input.projectId) : undefined),
      'paperclip.import.plan': async input => {
        const mode = input.mode === 'local' || input.mode === 'custom' ? input.mode : config.mode === 'off' ? 'local' : config.mode;
        const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl : config.baseUrl;
        const reader = new PaperclipClient(endpointFor(mode, baseUrl, typeof input.token === 'string' && input.token ? input.token : tokenFor(baseUrl)), options.fetch, { cache: false });
        const store = imports();
        if (!store) throw new Error('The import store is unavailable.');
        // GET only, and nothing is written: a preview of what the import would make.
        return planImport(typeof input.companyId === 'string' ? id(input.companyId) : config.companyId, { get: path => reader.get<unknown>(path), issuePages: (company, query) => reader.issuePages(company, query), invoke: context.invoke as Invoke, store, local: mode === 'local' || isLoopback(baseUrl) });
      },
      'paperclip.memory': input => memoryFor(id(input.taskId)),
      'paperclip.list': input => {
        const kind = input.kind as WorkspaceListKind;
        if (!['artifacts', 'audit', 'routines'].includes(kind)) throw new Error('Unknown list.');
        return list(kind);
      },
      'paperclip.watch': input => {
        live.visible = input.visible === true;
        if (!connection()) { stopPoll(); return { live: 'events' as LiveChannel }; }
        if (!live.visible) stopPoll();
        else { ensureSocket(); if (!live.socket) schedulePoll(); }
        return { live: live.channel };
      },
      'paperclip.badge': () => { scheduleHistory(); return badge(); },
      'paperclip.ledger': input => { scheduleHistory(); return ledgerView(typeof input.limit === 'number' ? Math.min(Math.max(input.limit, 1), 1000) : 200); },
      'paperclip.ledger.backfill': async () => { if (history.timer) { timers.clearTimeout(history.timer); history.timer = null; } const result = await importHistory(); return { chats: result.chats, turns: result.turns }; },
      'paperclip.inbox.dismiss': input => {
        const itemId = typeof input.id === 'string' && /^[\w:.@-]{1,200}$/.test(input.id) ? input.id : null, at = typeof input.at === 'string' && input.at.length <= 64 ? input.at : null;
        if (!itemId || at === null) throw new Error('Unknown item.');
        dismissDb().prepare('INSERT INTO inbox_dismissals (id, at, dismissed_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at, dismissed_at = excluded.dismissed_at').run(itemId, at, new Date().toISOString());
        if (itemId.startsWith('ws:')) queueEmit(['inbox']);
        return { ok: true as const };
      },
      'paperclip.inbox.dismissed': () => ({ items: [...dismissed()].map(([itemId, at]) => ({ id: itemId, at })) }),
    },
    dispose() { history.disposed = true; if (history.timer) timers.clearTimeout(history.timer); history.timer = null; offLedger(); closeSocket(); stopPoll(); if (live.emitTimer) timers.clearTimeout(live.emitTimer); live.emitTimer = null; },
    power(event) { if (event.state === 'suspend') { closeSocket(); stopPoll(); } else if (live.visible) { ensureSocket(); if (!live.socket) schedulePoll(); } },
  };
}
