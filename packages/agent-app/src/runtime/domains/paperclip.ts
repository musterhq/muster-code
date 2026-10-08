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
 *   `projectsWorkspaceChanged` event per half second (every 5 s while no workspace screen is visible, for the Inbox badge); an isolated change is announced within milliseconds.
 * - Only when the socket is refused AND a workspace screen is visible does a poll run (15 s, backing off to 60 s).
 *   Hidden means no timers at all. Muster's own data needs none: its changes already arrive as events.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { MemoryRecord } from '../../shared/domains/memory-protocol.ts';
import {
  budgetUse, PAPERCLIP_LOCAL_URL, WORKSPACE_PRIORITIES, WORKSPACE_STATUSES, type ApprovalDecision, type DashboardData, type LedgerView, type LiveChannel, type PaperclipConfigView, type PaperclipCostsView, type PaperclipRunView, type PaperclipLink, type PaperclipMode, type PaperclipTestResult,
  type ServerOutputFile, type ThreadCard, type WorkspaceAgent, type WorkspaceApproval, type WorkspaceBadge, type WorkspaceInboxItem, type WorkspaceList, type WorkspaceListKind, type WorkspaceMemory, type WorkspaceProject,
  type WorkspacePriority, type WorkspaceRow, type WorkspaceSnapshot, type WorkspaceSource, type WorkspaceStatus, type WorkspaceTask, type WorkspaceTaskDetail,
} from '../../shared/domains/paperclip-protocol.ts';
import { normalizeRemote } from '../memory-identity.ts';
import { PaperclipError, type FetchLike, type LiveSocket, type SocketFactory } from '../paperclip-client.ts';
import type { ServerBackend, ServerPart } from '../server/backend.ts';
import { LEGACY_PAPERCLIP_SECRET } from '../server/config.ts';
import { createServerSignIn } from '../server-auth.ts';
import { createAutoAuth } from '../server/auto-auth.ts';
import { detectBackend } from '../server/detect.ts';
import { normalizeBaseUrl as normalizeUrl } from '../paperclip-client.ts';
import { connectionFor, isLoopback as connectionLoopback, originOf } from '../server/connection.ts';
import { arr, mapBudgets } from '../paperclip-map.ts';
import { cachedOutput, localOutput, MAX_OUTPUT_BYTES, nameWithExtension, outputCacheRoot, outputMime, previewOutput, projectRelativePath, sanitizeOutputName, storeOutput } from '../server-outputs.ts';
import { OrgReader, serverHubFor } from '../server/orgs.ts';
import { leadAgentIds, normalizeOrgSetting, scopeInbox } from '../../shared/org-work.ts';
import { SecretStore } from '../secret-store.ts';
import { attachTurnLedger, TurnLedger } from '../turn-ledger.ts';
import { importLedgerHistory, paperclipHistory, type HistoryResult } from '../ledger-history.ts';
import { LocalWorkspace, type Invoke, type LocalPart } from '../workspace-local.ts';
import { importFromPaperclip, planImport, SqliteImportStore } from '../paperclip-import.ts';
import { buildCosts, groupsFromReceipts } from '../insight/costs.ts';
import { buildDashboard, DASHBOARD_DAYS, ledgerAggregates, monthStart } from '../workspace-dashboard.ts';
import type { DomainContext, DomainModule } from './types.ts';
import { device } from '../../shared/device-noun.ts';

const POLL_MAX_MS = 60_000, EMIT_VISIBLE_MS = 500, EMIT_HIDDEN_MS = 5_000, EMIT_LEAD_MS = 40;
/** A server that refused the live socket for this credential (a hosted Paperclip-compatible server only lets a browser session or an agent key onto it, never a board key) is asked again only this often; in between, polling with ETags is the whole story. */
const SOCKET_RETRY_MS = 60_000;
/** The fallback poll (a hosted server that refuses the live socket): near-real-time while things change, quiet once they stop. Always ETag revalidated, and never while hidden. */
const POLL_FAST_MS = 2_500, POLL_IDLE_MS = 15_000, POLL_QUIET_AFTER_MS = 60_000, SESSION_REFRESH_MS = 6 * 60 * 60_000;
/** Frames that fire many times a second while an agent works and change nothing the UI shows. */
const NOISY = new Set(['heartbeat.run.log', 'heartbeat.run.event', 'heartbeat.run.progress', 'plugin.ui.updated']);
/** Needs you + Problems: the only kinds that badge. */
const URGENT = new Set(['question', 'approval', 'blocked', 'failed_run', 'agent_error', 'budget', 'mention']);

/** Kept for callers that read it from here (tests, older code): the entry migrated Paperclip tokens stay in. */
export const PAPERCLIP_SECRET_ID = LEGACY_PAPERCLIP_SECRET;
/** A server on this Mac (127.0.0.0/8, localhost, ::1): its folder paths are this Mac's. */
export const isLoopback = connectionLoopback;
type Json = Record<string, unknown>;
type PaperclipPart = ServerPart;

export interface PaperclipDomainOptions {
  fetch?: FetchLike; socket?: SocketFactory; secrets?: () => SecretStore | undefined;
  /** `git config --get remote.origin.url` for a folder path (tests inject it). */
  remoteOf?: (path: string) => Promise<string | undefined>;
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
  /** #302: a forced refresh this soon after a completed read (with nothing changed since) is answered from it. Default 2500; 0 turns it off. */
  refreshCoalesceMs?: number;
  /** The most one server output may weigh (50 MB); tests lower it. */
  outputMaxBytes?: number;
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
  const conn = connectionFor(context, { fetch: options.fetch, secrets: options.secrets });
  const secrets = () => conn.secrets();
  const view = (): PaperclipConfigView => conn.view();

  // --- the server connection (Paperclip or Muster Server, whichever the URL is) ----------------------------------------------
  let backend: ServerBackend | null = null;
  /** The org's name on a Muster Server with no company of its own: "This Mac", or the server's host. */
  const originLabel = (): string => { if (conn.config.mode === 'local') return device().title; try { return new URL(conn.config.baseUrl).host; } catch { return 'Muster Server'; } };
  const connection = (): ServerBackend | null => {
    const endpoint = conn.endpoint();
    if (!endpoint) return null;
    const kind = conn.config.backend ?? 'paperclip';
    if (!backend || backend.kind !== kind || backend.endpoint.baseUrl !== endpoint.baseUrl || backend.endpoint.token !== endpoint.token) { closeSocket(); backend = conn.makeBackend(kind, endpoint, { orgName: originLabel() }); built = null; }
    return backend;
  };
  // Every org the person belongs to, side by side (sidebar, My work, Inbox): one reader over this same backend, shared with the checkout domain.
  const hub = serverHubFor(context);
  hub.backend = connection;
  hub.reader = new OrgReader({
    backend: connection, settings: () => conn.config.orgs, activeId: () => built?.companyId ?? conn.config.companyId ?? companies[0]?.id ?? null,
    serverLabel: () => { try { return new URL(conn.baseUrl()).host; } catch { return originLabel(); } }, badge: taskId => hub.badge?.(taskId) ?? null, remembered: () => conn.person(), remember: person => conn.setPerson(person),
  });
  /** An approval an import carried over can be decided only while a server is linked (the decision goes to its approval endpoints). */
  const linkedApproval = (sourceId: string, projectId: string | null) => {
    if (!sourceId.startsWith('approval:') || !connection() || !projectId) return false;
    let source; try { source = imports()?.projectSource(projectId); } catch { return false; }
    const linkedCompany = built?.companyId ?? conn.config.companyId ?? companies[0]?.id ?? null;
    if (!source?.companyId || source.companyId !== linkedCompany) return false;
    return !source.serverOrigin || source.serverOrigin === originOf(conn.baseUrl());
  };

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
  const REFRESH_COALESCE_MS = options.refreshCoalesceMs ?? 2500;
  let readDoneAt = 0, readEpoch = -1, changeEpoch = 0;
  const chooseCompany = async (api: ServerBackend) => {
    companies = await api.companies();
    const chosen = companies.find(c => c.id === conn.config.companyId) ?? companies[0];
    if (!chosen) throw new PaperclipError('This Muster Server has no orgs yet. Create one on the server first.', 404, 'service');
    return chosen;
  };
  const readPaperclip = async (api: ServerBackend): Promise<PaperclipPart> => {
    const company = await chooseCompany(api);
    const fresh = live.fresh; live.fresh = false;
    const part = await api.read(company, built ? { generation: built.generation, companyId: built.companyId, part: built.part } : undefined, { fresh });
    if (built && built.part === part && built.companyId === company.id) return part;
    built = { generation: api.generation, companyId: company.id, part, agents: new Map(part.agents.map(a => [a.id, a])) };
    return part;
  };
  /** The connection changed (here, or by signing in from Settings): drop what was read from the old one and tell the screens. */
  /** The session cookie arrived, expired or was cleared: only the live socket is rebuilt; the next read tries it first. */
  const offSession = conn.onSession(() => { live.refusedAt = 0; closeSocket(); backend = null; built = null; if (conn.sessionState() !== 'expired') ensureSocket(); queueEmit(['config']); });
  const offConnection = conn.onChange(() => { changeEpoch++; hub.reader?.reset(); live.refusedAt = 0; closeSocket(); stopPoll(); built = null; backend = null; companies = []; lastError = undefined; queueEmit(['config', 'tasks', 'runs', 'agents', 'inbox']); });
  /** Records the last read's outcome. Going offline (ok → stale) or coming back (stale → ok) is an update the screens
   *  must see at once: the banner and "· offline" come from it, so it is emitted rather than waiting for a reload. */
  const linkError = (next: string | undefined) => {
    const changed = Boolean(next) !== Boolean(lastError);
    const cameBack = changed && !next;
    lastError = next;
    if (cameBack) hub.onOnline?.();
    if (changed) queueEmit(['config', 'inbox', 'tasks']);
  };
  const paperclipPart = async (refresh: boolean): Promise<{ part: PaperclipPart | null; link: PaperclipLink | null }> => {
    if (conn.config.mode !== 'off' && conn.config.backend === null) await conn.resolveBackend().catch(() => undefined);
    const api = connection();
    if (!api) return { part: null, link: null };
    // #302: startup has several callers asking for a forced refresh. A forced refresh right after a completed read,
    // with nothing changed since (no write, live event or connection change bumps `changeEpoch`), is answered from that read.
    const coalesced = refresh && !inflight && built !== null && readEpoch === changeEpoch && Date.now() - readDoneAt < REFRESH_COALESCE_MS;
    if (refresh && !coalesced) api.invalidate();
    if (!coalesced) {
      const startedAt = changeEpoch;
      inflight ??= readPaperclip(api).then(part => { linkError(undefined); ensureSocket(); readDoneAt = Date.now(); readEpoch = startedAt; return part; }, cause => {
        linkError(cause instanceof Error ? cause.message : String(cause));
        if (built) return built.part;
        throw cause;
      }).finally(() => { inflight = null; });
    }
    try {
      const part = coalesced ? built!.part : await inflight!;
      return { part, link: { origin: originLabel(), company: companies.find(c => c.id === built?.companyId) ?? null, companies, live: live.channel, ...(conn.view().reconnect && live.channel !== 'socket' ? { reconnect: true, baseUrl: conn.baseUrl() } : {}), ...(lastError ? { stale: lastError, cached: true } : {}) } };
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
    const projects2 = projects.filter(x => !(x.source === 'paperclip' && hidden.has(x.id))).map(x => x.source === 'paperclip' ? { ...x, org: theirs.link?.company?.name ?? 'Muster Server' } : x);
    const tasks = [...mine.tasks, ...theirTasks], runs = [...mine.runs, ...(p?.runs ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const rank = { high: 0, medium: 1, low: 2 } as const;
    // A Paperclip task already imported into Muster needs you once: its Muster copy stands for it in the Inbox and badge.
    let imported = new Set<string>(); try { imported = imports()?.importedSources('task') ?? imported; } catch { /* no import store */ }
    // An approval carried over by an import is decided in the linked Paperclip (when there is one), from its row.
    const carried = (i: WorkspaceInboxItem): WorkspaceInboxItem => i.id.startsWith('import:approval:') && linkedApproval(i.id.slice('import:'.length), i.projectId ?? null) ? { ...i, approvalId: i.id.slice('import:approval:'.length), approvalVerbs: ['approve', 'reject', 'request_revision'] } : i;
    const gates: WorkspaceInboxItem[] = (over?.inbox ?? []).map(g => ({ ...g, taskId: null, agentId: null, runId: null, source: 'local' as const }));
    // The server's Inbox lists only what asks the signed-in person (never another person's task), from every ticked org, each tagged with its org.
    const serverInbox = await scopedServerInbox(p, theirs.link?.company ?? null);
    const inbox = [...mine.inbox.map(carried), ...gates, ...await budgetInbox(mine.projects), ...serverInbox.filter(i => !i.taskId || !imported.has(i.taskId))].sort((a, b) => rank[a.severity] - rank[b.severity] || b.at.localeCompare(a.at));
    return {
      paperclip: theirs.link, tasks, agents: [...mine.agents, ...(p?.agents ?? [])], projects: projects2, goals: p?.goals ?? [], runs, inbox, ...(p ? { approvals: p.approvals, labels: p.labels, people: await peopleOf(p) } : {}), agentCounts: p ?  { active: p.agents.filter(a => a.status !== 'paused' && a.status !== 'terminated' && a.status !== 'pending').length, paused: p.agents.filter(a => a.status === 'paused').length, resumable: resumable(p) } : { active: 0, paused: 0, resumable: resumable(null) },
      counts: { liveRuns: runs.filter(r => r.status === 'running').length, inbox: inbox.filter(i => i.kind !== 'mail').length, failedRuns: runs.filter(r => r.status === 'failed').length, openTasks: tasks.filter(t => t.status !== 'done' && t.status !== 'cancelled').length },
      fetchedAt: new Date().toISOString(),
    };
  };
  /** The linked org's Inbox items that ask the person, plus the same from the other ticked orgs. A server that cannot say who the person is (a Muster Server) is shown unscoped, as before. */
  const scopedServerInbox = async (p: PaperclipPart | null | undefined, company: PaperclipLink['company']): Promise<WorkspaceInboxItem[]> => {
    if (!p) return [];
    const api0 = connection();
    if (!api0?.whoami || !hub.reader) return p.inbox;
    const me = await hub.reader.me();
    // A server that does not say who the person is cannot be scoped: the old unscoped Inbox is kept for it (My work and the sidebar then show nothing).
    if (!me) return p.inbox;
    const setting = company ? normalizeOrgSetting(conn.config.orgs[company.id]) : normalizeOrgSetting(undefined);
    const own = company && !setting.enabled ? [] : scopeInbox(p.inbox, p.tasks, me, { team: setting.sidebar === 'team', reporting: { agentIds: leadAgentIds(me, p.tasks, p.agents) } }).map(i => company ? { ...i, org: { id: company.id, name: company.name } } : i);
    const others = await hub.reader.otherInbox(company?.id ?? null).catch(() => []);
    return [...own, ...others];
  };
  /** The linked org's people, with the signed-in one marked: what the owner pickers and @-mentions list. */
  const peopleOf = async (p: PaperclipPart): Promise<{ id: string; name: string; me?: boolean }[]> => {
    const me = hub.reader ? await hub.reader.me().catch(() => null) : null;
    const list = (p.people ?? []).map(x => me && x.id === me.id ? { id: x.id, name: x.name || me.name || 'Me', me: true } : x);
    return me && !list.some(x => x.id === me.id) ? [{ id: me.id, name: me.name ?? 'Me', me: true }, ...list] : list;
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
  const api = (): ServerBackend => { const c = connection(); if (!c) throw new Error('Muster Server is not connected. Connect it in Settings › Integrations.'); return c; };

  // --- live updates -----------------------------------------------------------------------------------------------------
  const live = { fresh: false, lastEmitAt: 0, emitDue: 0, refusedAt: 0, channel: 'off' as LiveChannel, visible: false, socket: null as LiveSocket | null, socketCompany: '', pollTimer: null as ReturnType<typeof setTimeout> | null, pollDelay: POLL_FAST_MS, lastChangeAt: 0, refreshTimer: null as ReturnType<typeof setTimeout> | null, emitTimer: null as ReturnType<typeof setTimeout> | null, pending: new Set<string>(), taskIds: new Set<string>() };
  function closeSocket() { if (live.refreshTimer) timers.clearTimeout(live.refreshTimer); live.refreshTimer = null; live.socket?.close(); live.socket = null; live.socketCompany = ''; if (live.channel === 'socket') live.channel = 'off'; }
  const stopPoll = () => { if (live.pollTimer) timers.clearTimeout(live.pollTimer); live.pollTimer = null; };
  /** (Re)arms the coalescing timer. A screen coming into view shortens a wait that was set while nothing was watching (5 s), never lengthens one. */
  const armEmit = () => {
    if (!live.pending.size && !live.taskIds.size) return;
    // At most two events a second while watched, but an isolated change is announced at once (a few ms, to batch what arrives together), not after a full second.
    const wait = live.visible ? Math.max(EMIT_LEAD_MS, EMIT_VISIBLE_MS - (Date.now() - live.lastEmitAt)) : EMIT_HIDDEN_MS, due = Date.now() + wait;
    if (live.emitTimer) { if (due >= live.emitDue) return; timers.clearTimeout(live.emitTimer); }
    live.emitDue = due;
    live.emitTimer = timers.setTimeout(() => {
      live.emitTimer = null; live.lastEmitAt = Date.now();
      const scopes = [...live.pending] as ('tasks' | 'runs' | 'agents' | 'inbox' | 'config')[], taskIds = [...live.taskIds];
      live.pending.clear(); live.taskIds.clear();
      context.emit({ type: 'projectsWorkspaceChanged', scopes, taskIds });
    }, wait);
  };
  const queueEmit = (scopes: string[], taskId?: string) => {
    changeEpoch++;
    for (const s of scopes) live.pending.add(s);
    if (taskId) live.taskIds.add(taskId);
    armEmit();
  };
  const schedulePoll = () => {
    stopPoll();
    if (!live.visible || live.channel === 'socket' || !connection()) return;
    live.channel = 'poll';
    if (!live.lastChangeAt) live.lastChangeAt = Date.now();
    live.pollTimer = timers.setTimeout(async () => {
      live.pollTimer = null;
      const c = connection();
      if (!c || !live.visible) return;
      const before = c.generation;
      await paperclipPart(false);
      const changed = c.generation !== before;
      if (changed) live.lastChangeAt = Date.now();
      // Near-real-time while things are changing (about 2.5 s), 15 s once nothing has changed for a minute, backing off when the server does not answer.
      live.pollDelay = lastError ? Math.min(live.pollDelay * 2, POLL_MAX_MS) : Date.now() - live.lastChangeAt >= POLL_QUIET_AFTER_MS ? POLL_IDLE_MS : POLL_FAST_MS;
      if (changed) queueEmit(['tasks', 'runs', 'agents', 'inbox']);
      ensureSocket();
      schedulePoll();
    }, live.pollDelay);
  };
  /** One socket while a server is linked (an idle socket costs nothing); it feeds the Inbox badge even when no screen shows workspace data. */
  function ensureSocket() {
    const c = connection();
    if (!c || !built) return;
    if (live.socket && live.socketCompany === built.companyId) return;
    // A session the server stopped accepting cannot work again until Reconnect brings a fresh one; a board key alone is asked again now and then.
    if (conn.config.signedIn && conn.sessionState() === 'expired') return;
    if (live.refusedAt && Date.now() - live.refusedAt < SOCKET_RETRY_MS) return;
    closeSocket();
    const target = built.companyId, company = companies.find(x => x.id === target) ?? { id: target, name: originLabel(), prefix: '' };
    live.socketCompany = target;
    live.socket = c.openLive(company, {
      onOpen() {
        live.channel = 'socket'; stopPoll(); conn.markSessionActive();
        // The session is extended the way the server's own web app does (Better Auth get-session) while the socket is up.
        if (conn.sessionCookie()) { if (live.refreshTimer) timers.clearTimeout(live.refreshTimer); live.refreshTimer = timers.setTimeout(function again() { live.refreshTimer = null; void conn.checkSession().then(() => { if (live.socket && conn.sessionCookie()) live.refreshTimer = timers.setTimeout(again, SESSION_REFRESH_MS); }); }, SESSION_REFRESH_MS); }
      },
      onEvent(type, payload) {
        if (NOISY.has(type)) return;
        live.fresh = true;
        c.invalidate(`/companies/${encodeURIComponent(target)}`);
        const entity = typeof payload.entityType === 'string' ? payload.entityType : '';
        const taskId = typeof payload.issueId === 'string' ? payload.issueId : entity === 'issue' && typeof payload.entityId === 'string' ? payload.entityId : typeof payload.taskId === 'string' ? payload.taskId : undefined;
        if (taskId) c.invalidate(`/issues/${taskId}`);
        queueEmit(c.kind === 'muster-server' ? ['tasks', 'runs', 'agents', 'inbox'] : type.startsWith('heartbeat.') ? ['runs', 'tasks', 'inbox'] : type === 'agent.status' ? ['agents', 'inbox'] : ['tasks', 'inbox'], taskId);
      },
      // A live socket dropping is often the first sign the server went away: tell the screens, which re-read and show it.
      // (A socket that never opened says nothing new, so a refused socket never wakes the renderer.)
      onDown() { const wasLive = live.channel === 'socket'; if (!wasLive) { live.refusedAt = Date.now(); if (conn.sessionCookie()) void conn.checkSession(); } live.socket = null; live.socketCompany = ''; live.channel = 'off'; if (wasLive) queueEmit(['config']); schedulePoll(); },
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
        const receipts = await c.receipts(companies.find(x => x.id === built!.companyId) ?? { id: built.companyId, name: originLabel(), prefix: '' }, limit, built.agents).catch(() => []), seen = new Set(receipts.map(r => r.runId));
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
      if (!task) throw new Error('That task is not on the connected Muster Server.');
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
      const asks = await context.invoke('project.interactions.list', { projectId, taskId }).catch(() => ({ items: [] }));
      for (const it of asks.items) cards.push({ kind: 'ask', id: `ask:${it.id}`, at: it.createdAt, interaction: it });
      const sug = await context.invoke('project.suggestions.list', { projectId, taskId }).catch(() => ({ items: [] }));
      for (const x of sug.items.filter(y => y.state === 'open')) cards.push({ kind: 'suggestion', id: `suggestion:${x.id}`, at: x.createdAt, suggestion: x });
      for (const p of gov.proposals) cards.push({ kind: 'secret', id: `secret:${p.id}`, at: p.createdAt, proposal: p, secureStorage: gov.secureStorage });
      governance = { stage: gov.stage, policy: gov.policy, effectivePolicy: gov.effectivePolicy, hold: gov.hold, hidden: gov.hidden, runs: gov.runs, monitor: gov.monitor, watchdog: gov.watchdog, agents: gov.agents };
    }
    return { ...detail, comments, cards, receipts, ...(governance ? { governance } : {}) };
  };
  const paperclipDetail = async (taskId: string): Promise<WorkspaceTaskDetail> => {
    const c = api();
    await paperclipPart(false);
    return c.taskDetail(taskId, {
      agents: built?.agents ?? new Map<string, WorkspaceAgent>(), part: built?.part,
      memory: id => memoryFor(id).then(m => m.records.slice(0, 4).map(r => ({ text: r.text, source: r.source === 'hindsight' ? 'Hindsight' : m.scope.label })), () => []),
    });
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
        remote = await c.rows(kind, companies.find(x => x.id === built!.companyId) ?? { id: built.companyId, name: originLabel(), prefix: '' });
        // An event about a task belongs to that task's project: what lets a project's Activity show only its own.
        if (kind === 'audit') { const projectOfTask = new Map(built.part.tasks.map(t => [t.id, t.projectId])); remote = remote.map(r => r.projectId || !r.taskId ? r : { ...r, projectId: projectOfTask.get(r.taskId) ?? null }); }
      } catch (cause) { note = `Muster Server could not be read: ${cause instanceof Error ? cause.message : String(cause)}`; }
    }
    return { kind, rows: [...mine, ...remote].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')).slice(0, 400), note };
  };

  /** One server output opened on this Mac: the same file in the project's Work locally folder when there is one, else the server's content in a private per-server cache. */
  const outputCache = () => outputCacheRoot(context.dataDir, originOf(conn.baseUrl()) ?? conn.baseUrl());
  const openOutput = async (outputId: string, projectHint: string | undefined, preferServer: boolean): Promise<ServerOutputFile> => {
    const c = api();
    await paperclipPart(false);
    if (!built) throw new Error(lastError ?? 'Muster Server could not be reached.');
    const company = companies.find(x => x.id === built!.companyId) ?? { id: built.companyId, name: originLabel(), prefix: '' };
    const row = (await c.rows('artifacts', company)).find(r => r.id === outputId);
    const output = row?.output;
    if (!row || !output) throw new Error('This output is no longer on the server. Refresh the Outputs tab.');
    const projectId = row.projectId ?? projectHint ?? null;
    const label = (path: string, mime?: string) => { const name = path.split('/').pop() || row.title; return { id: outputId, name, mime: mime ?? outputMime(null, name) }; };
    if (output.source === 'work_product' && output.openPath && /^https?:\/\//i.test(output.openPath)) return { kind: 'link', ...label(row.title, 'text/uri-list'), path: '', size: 0, url: output.openPath };
    // The same file in the folder this Mac bound for the project (Work locally), when the output names a path in the server's workspace.
    if (!preferServer && projectId && (output.openPath || output.workProductId)) {
      const project = built.part.projects.find(p => p.id === projectId);
      // The server's own record of a workspace file says exactly which project-relative path it is; a bare path is reduced to one.
      const recorded = output.source === 'work_product' && !output.contentPath && c.workspaceFile ? await c.workspaceFile(output).catch(() => null) : null;
      const rel = recorded?.relativePath ? projectRelativePath(recorded.relativePath, []) : output.openPath ? projectRelativePath(output.openPath, project?.cwd ? [project.cwd] : []) : null;
      const bindings = rel ? await context.invoke('checkout.bindings', {} as never).then(r => r.bindings, () => []) : [];
      const binding = bindings.find(b => b.projectId === projectId && (!b.orgId || b.orgId === built!.companyId)) ?? bindings.find(b => b.projectId === projectId);
      const hit = rel && binding ? await localOutput(binding.path, rel) : null;
      if (hit && rel && binding) return { kind: 'local', ...label(rel), path: hit.path, size: hit.size, folderPath: binding.path, relPath: rel };
    }
    if (!output.downloadable || !c.outputContent) throw new Error(output.openPath ? 'The server keeps no copy of this output: it is a path in the server’s own workspace. Use Open on server, or link a folder with Work locally to open it here.' : 'The server keeps no file for this output. Use Open on server.');
    const root = outputCache(), cap = options.outputMaxBytes ?? MAX_OUTPUT_BYTES;
    // An attachment never changes once uploaded, so its copy is reused; a document is read again every time.
    if (output.contentPath) {
      const hit = await cachedOutput(root, outputId);
      if (hit) { const size = (await stat(hit)).size; return { kind: 'cached', id: outputId, name: basename(hit), path: hit, mime: outputMime(output.contentType, basename(hit)), size }; }
    }
    const file = await c.outputContent(output, cap);
    const first = sanitizeOutputName(file.name ?? row.title, 'output'), mime = outputMime(file.contentType, first), name = sanitizeOutputName(nameWithExtension(first, mime));
    const path = await storeOutput(root, outputId, name, file.bytes, cap);
    return { kind: 'cached', id: outputId, name, path, mime, size: file.bytes.byteLength };
  };

  /** One run of the linked server by id (the snapshot only keeps the latest), with its tool use and the server's own pages for it. */
  const runView = async (runId: string): Promise<PaperclipRunView> => {
    const c = connection();
    if (!c) return { run: null, receipt: null, missing: true, links: { run: null, task: null } };
    await paperclipPart(false);
    const company = companies.find(x => x.id === built?.companyId) ?? { id: built?.companyId ?? '', name: originLabel(), prefix: '' };
    const known = built?.part.runs.find(r => r.id === runId) ?? null;
    const found = c.runDetail ? await c.runDetail(runId, built?.agents ?? new Map()) : known ? { run: known, receipt: null } : null;
    const run = found?.run ?? known;
    if (!run) return { run: null, receipt: null, missing: true, links: { run: null, task: null } };
    const task = run.taskId ? built?.part.tasks.find(t => t.id === run.taskId) : undefined;
    return { run: { ...run, ...(known ?? {}) }, receipt: found?.receipt ?? null, missing: false, links: { run: c.linkFor?.(company, { runId: run.id, agentId: run.agentId }) ?? null, task: task ? c.linkFor?.(company, { taskKey: task.key }) ?? null : null } };
  };
  const COSTS_UNAVAILABLE = 'Costs for server projects come from the server; not available here yet.';
  /** A connected project's costs, from the server's own run records. The local Ledger has none for it. */
  const serverCosts = async (projectId: string, daysInput: unknown, offsetInput: unknown): Promise<PaperclipCostsView> => {
    const c = connection();
    if (!c) return { report: null, note: COSTS_UNAVAILABLE };
    await paperclipPart(false);
    if (!built) return { report: null, note: COSTS_UNAVAILABLE };
    const project = built.part.projects.find(p => p.id === projectId);
    if (!project) return { report: null, note: 'This project was not found among the connected server’s projects.' };
    const days = daysInput === 7 || daysInput === 30 || daysInput === 90 ? daysInput : 30;
    const offset = typeof offsetInput === 'number' && Math.abs(offsetInput) <= 14 * 60 ? Math.round(offsetInput) : 0;
    const company = companies.find(x => x.id === built!.companyId) ?? { id: built.companyId, name: originLabel(), prefix: '' };
    const limit = 200;
    let receipts; try { receipts = await c.receipts(company, limit, built.agents); } catch { return { report: null, note: COSTS_UNAVAILABLE }; }
    const inProject = new Set(built.part.tasks.filter(t => t.projectId === projectId).map(t => t.id));
    const mine = receipts.filter(r => r.projectId === projectId || (r.taskId !== null && inProject.has(r.taskId)));
    const report = buildCosts(groupsFromReceipts(mine, offset, projectId), { days, offsetMin: offset, now: Date.now(), projectNames: new Map([[projectId, project.name]]), windows: [], ledgerSince: mine.map(r => r.endedAt).sort()[0] ?? null, truncated: receipts.length >= limit });
    const reported = mine.some(r => r.tokens !== null || r.costUsd !== null);
    return { report, note: mine.length && !reported ? `The server reported no token or cost data for this project’s ${mine.length} ${mine.length === 1 ? 'run' : 'runs'}.` : null };
  };

  const badge = async (): Promise<WorkspaceBadge> => {
    const [mail, snap] = await Promise.all([context.invoke('mailbox.list', { limit: 1 }).then(m => m.unacked).catch(() => 0), snapshotInflight ?? merge(false, false)]);
    const hidden = dismissed();
    // A snoozed item (for this very `at`, until its time) stays off the badge until it wakes.
    const meta = new Map(((await context.invoke('work.inbox.state', {}).catch(() => ({ items: [] }))).items).map(m => [m.id, m]));
    const asleep = (i: { id: string; at: string }) => { const m = meta.get(`ws:${i.id}`); return Boolean(m?.snoozedUntil && Date.parse(m.snoozedUntil) > Date.now() && m.snoozedFor === i.at); };
    const urgent = snap.inbox.filter(i => URGENT.has(i.kind) && hidden.get(`ws:${i.id}`) !== i.at && !asleep(i));
    let orgs: Record<string, string> = {}; try { orgs = imports()?.projectOrgs() ?? {}; } catch { /* no import store */ }
    return { connected: Boolean(snap.paperclip), inbox: urgent.length, liveRuns: snap.counts.liveRuns, mail, chatIds: [...new Set(urgent.flatMap(i => i.chatIds ?? []))], company: snap.paperclip?.company?.name ?? companies.find(c => c.id === (conn.config.companyId ?? companies[0]?.id))?.name ?? null, orgs };
  };

  /** Starts a Muster task's first run on its owner's runner, in a new worktree of the project's folder (never the checkout). */
  const startTask = async (taskId: string) => {
    if (await owner('task', taskId) === 'paperclip') {
      // A Muster Server runs its own agents: starting is its command. Any other server's tasks run there.
      const c = api();
      if (!c.startTask) throw new Error('This task runs on the server. Import it first to run it here.');
      const started = await c.startTask(taskId);
      queueEmit(['tasks', 'runs'], taskId);
      return started;
    }
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
        const company = companies.find(x => x.id === built!.companyId) ?? { id: built.companyId, name: originLabel(), prefix: '' };
        const remote = await c.dashboard(company, built.agents);
        if (remote.budgets) budgets = { ...mapBudgets(remote.budgets), company: company.name };
        const inProject = projectId ? new Set(built.part.tasks.filter(t => t.projectId === projectId).map(t => t.id)) : null;
        paperclip = { receipts: remote.receipts.filter(r => !inProject || (r.taskId !== null && inProject.has(r.taskId))), tasks: built.part.tasks.filter(t => !projectId || t.projectId === projectId), activity: remote.activity, name: company.name };
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

  /** Browser-approval sign-in (the ServerAuth seam): the approved key is stored like a pasted token, bound to its origin. */
  const auth = createAutoAuth(conn.fetcher, origin => conn.config.backend && originOf(conn.config.baseUrl) === origin ? conn.config.backend : null);
  const signIn = createServerSignIn(auth, {
    timers,
    changed: () => context.emit({ type: 'projectsWorkspaceChanged', scopes: ['config'], taskIds: [] }),
    approved: result => conn.adoptSignIn({ ...result, backend: auth.backendFor(result.origin) }),
  });
  const text = (value: unknown, label: string, max: number) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`); if (value.length > max) throw new Error(`${label} is too long.`); return value; };
  const id = (value: unknown) => { if (typeof value !== 'string' || !/^[\w:.-]{1,128}$/.test(value)) throw new Error('Unknown item.'); return value; };
  const sourceOf = (value: unknown): WorkspaceSource => value === 'paperclip' ? 'paperclip' : 'local';

  /** Where an import or its plan reads from: the saved connection, or what the form says (mode, URL, token), on whichever backend that URL is. */
  const importSource = async (input: { mode?: unknown; baseUrl?: unknown; token?: unknown }) => {
    const mode = input.mode === 'local' || input.mode === 'custom' ? input.mode : conn.config.mode === 'off' ? 'local' : conn.config.mode;
    const typed = typeof input.baseUrl === 'string' ? input.baseUrl : conn.config.baseUrl;
    const baseUrl = mode === 'local' ? (conn.config.mode === 'local' ? conn.baseUrl() : PAPERCLIP_LOCAL_URL) : normalizeUrl(typed);
    const token = typeof input.token === 'string' && input.token ? input.token : conn.tokenFor(baseUrl);
    const same = originOf(baseUrl) === originOf(conn.config.baseUrl) && conn.config.backend;
    let kind = same ? conn.config.backend! : null;
    if (!kind) { const found = await detectBackend(baseUrl, conn.fetcher); kind = found.ok ? found.kind : 'paperclip'; /* inconclusive: read it as the REST server it most likely is; a real failure surfaces from the first read */ }
    const reader = conn.makeBackend(kind, { baseUrl, token }, { cache: false, orgName: originLabel() }).importReader();
    return { reader, baseUrl, mode, onThisMac: mode === 'local' || isLoopback(baseUrl) };
  };

  return {
    handlers: {
      'paperclip.config.get': () => ({ ...view(), live: live.channel }),
      'paperclip.signin.start': input => signIn.start(input.baseUrl),
      'paperclip.signin.status': () => signIn.state(),
      'paperclip.session.set': input => ({ state: conn.setSession(String(input.baseUrl ?? ''), input.cookie) }),
      'paperclip.session.clear': () => { conn.clearSession(); return { ok: true as const }; },
      'paperclip.signin.cancel': () => signIn.cancel(),
      'paperclip.signin.signout': async () => {
        if (!conn.config.signedIn) throw new Error(device().title+' is not signed in with browser approval.');
        const baseUrl = conn.baseUrl(), key = conn.tokenFor(baseUrl);
        const outcome = key ? await signIn.revoke(baseUrl, key) : { revoked: false as boolean, message: undefined as string | undefined };
        conn.forgetSignIn();
        signIn.reset();
        return { config: view(), revoked: outcome.revoked, ...(outcome.message ? { message: outcome.message } : {}) };
      },
      'paperclip.disconnect': async () => {
        // Disconnect: a key this app was given by browser approval is revoked on the server; every key, session and the link itself is forgotten here.
        let revoked = false, message: string | undefined;
        if (conn.config.signedIn) {
          const baseUrl = conn.baseUrl(), key = conn.tokenFor(baseUrl);
          if (key) { const outcome = await signIn.revoke(baseUrl, key); revoked = outcome.revoked; message = outcome.message; }
        }
        conn.disconnect(); signIn.reset();
        return { config: view(), revoked, ...(message ? { message } : {}) };
      },
      'paperclip.config.set': input => {
        const next = conn.configure(input as never);
        closeSocket(); stopPoll(); built = null; backend = null; companies = []; lastError = undefined;
        queueEmit(['config', 'tasks', 'runs', 'agents', 'inbox']);
        return next;
      },
      'paperclip.test': input => conn.test(input),
      'paperclip.snapshot': input => snapshot(input.refresh === true),
      'paperclip.task': async input => { const taskId = id(input.id); return await owner('task', taskId) === 'paperclip' ? paperclipDetail(taskId) : localDetail(taskId); },
      'paperclip.run': input => runView(id(input.id)),
      'paperclip.costs': input => serverCosts(id(input.projectId), input.days, input.utcOffsetMinutes),
      'paperclip.comment': async input => {
        const taskId = id(input.taskId), body = text(input.body, 'Message', 20_000);
        if (await owner('task', taskId) === 'local') { const comment = await local.comment(taskId, body); queueEmit(['tasks'], taskId); return comment; }
        const created = await api().comment(taskId, body, built?.agents ?? new Map());
        queueEmit(['tasks'], taskId);
        return created;
      },
      'paperclip.task.update': async input => {
        const taskId = id(input.taskId), changes: Json = {};
        if (input.status !== undefined) { if (!WORKSPACE_STATUSES.includes(input.status as WorkspaceStatus)) throw new Error('Unknown status.'); changes.status = input.status; }
        if (input.priority !== undefined) { if (!WORKSPACE_PRIORITIES.includes(input.priority as WorkspacePriority)) throw new Error('Unknown priority.'); changes.priority = input.priority; }
        if (input.assigneeId !== undefined) {
          // An agent, or nobody (null, or you: a Paperclip task owned by the board is simply unassigned from an agent).
          if (input.assigneeId !== null && typeof input.assigneeId !== 'string') throw new Error('Unknown assignee.');
          const person = typeof input.assigneeId === 'string' && input.assigneeId.startsWith('user:') ? input.assigneeId.slice(5) : null;
          // A person (their server user id) takes the task and the agent is cleared; an agent takes it and any person is cleared; null clears both.
          changes.assigneeAgentId = input.assigneeId === null || person !== null ? null : id(input.assigneeId);
          if (connection()?.kind === 'paperclip') changes.assigneeUserId = person !== null && person !== 'local' ? id(person) : null;
        }
        if (!Object.keys(changes).length) throw new Error('Nothing to change.');
        if (await owner('task', taskId) === 'local') {
          if (changes.priority !== undefined || changes.assigneeAgentId !== undefined || changes.assigneeUserId !== undefined) throw new Error('Change a Muster task’s priority or owner in its project’s task list.');
          return local.setStatus(taskId, changes.status as WorkspaceStatus);
        }
        // Only what you changed is sent: Paperclip's own PATCH, user-initiated.
        const updated = await api().updateTask(taskId, changes as never, built?.agents ?? new Map());
        queueEmit(['tasks', 'inbox'], taskId);
        return updated;
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
        text(input.title, 'Title', 500);
        await paperclipPart(false);
        const company = companies.find(x => x.id === built?.companyId) ?? { id: built?.companyId ?? '', name: originLabel(), prefix: '' };
        const created = await api().createTask({ ...(input as never as Record<string, unknown>), projectId } as never, company, built?.agents ?? new Map());
        queueEmit(['tasks', 'inbox']);
        return created;
      },
      'paperclip.agent.pause': async input => { const agentId = id(input.id); if (await owner('agent', agentId) === 'local') await local.setPaused(agentId, true); else await api().pauseAgent(agentId); queueEmit(['agents', 'runs']); return { ok: true }; },
      'paperclip.agent.resume': async input => { const agentId = id(input.id); if (await owner('agent', agentId) === 'local') await local.setPaused(agentId, false); else await api().resumeAgent(agentId); queueEmit(['agents', 'runs']); return { ok: true }; },
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
        try { for (const agent of agents) { await c.pauseAgent(agent.id); paused.push(agent.id); } }
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
        for (const agent of agents) await c.resumeAgent(agent.id);
        forgetPaused(scope);
        queueEmit(['agents', 'runs']);
        return { changed: agents.length };
      },
      'paperclip.approval.decide': async input => {
        const approvalId = id(input.id), decision = input.decision as ApprovalDecision;
        if (decision !== 'approve' && decision !== 'reject' && decision !== 'request_revision') throw new Error('Unknown decision.');
        const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 4000) : null;
        if (decision === 'request_revision' && !note) throw new Error('Say what should change.');
        // Only ever sent when you press the button: the server's own approval endpoints.
        await api().decideApproval(approvalId, decision, note);
        // The decision is the server's now; what an import recorded about it follows (so the Inbox row clears at once).
        try { imports()?.decideHistory(`approval:${approvalId}`, decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'revision_requested', note ?? '', decision === 'request_revision'); } catch { /* nothing imported */ }
        queueEmit(['tasks', 'inbox', 'agents']);
        return { ok: true as const };
      },
      'paperclip.run.cancel': async input => { const runId = id(input.id); if (await owner('run', runId) === 'local') await local.cancelRun(runId); else await api().cancelRun(runId); queueEmit(['runs', 'tasks']); return { ok: true }; },
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
          await api().respond(taskId, interactionId, { accept: true, answers });
          queueEmit(['tasks', 'inbox'], taskId);
          return { ok: true };
        }
        await api().respond(taskId, interactionId, { accept: input.accept === true, ...(reason ? { reason } : {}) });
        queueEmit(['tasks', 'inbox'], taskId);
        return { ok: true };
      },
      'paperclip.import': async input => {
        const { reader, baseUrl, onThisMac } = await importSource(input);
        // The importer reads each page once (see PaperclipBackend.importReader): it keeps no parsed bodies, so a large org never sits in memory twice.
        const store = imports();
        if (!store) throw new Error('The import store is unavailable.');
        let target = typeof input.companyId === 'string' ? id(input.companyId) : conn.config.companyId;
        if (!target) target = String(arr(await reader.get('/companies'))[0]?.id ?? '');
        if (!target) throw new Error('That Muster Server has no orgs to import.');
        // GET only: the importer is handed nothing that can write to the server.
        // Folder paths and CODEX_HOME are this Mac's only when the server runs here (This Mac, or a Custom URL on loopback);
        // a remote server's paths are never touched.
        const targets = input.targets && typeof input.targets === 'object' ? Object.fromEntries(Object.entries(input.targets).filter(([k, v]) => /^[\w:.-]{1,128}$/.test(k) && v === 'skip').map(([k]) => [k, 'skip' as const])) : undefined;
        const owners = input.owners && typeof input.owners === 'object' ? Object.fromEntries(Object.entries(input.owners).filter(([k, v]) => /^[\w:.-]{1,128}$/.test(k) && (v === 'mine' || v === 'made')).map(([k, v]) => [k, v as 'mine' | 'made'])) : undefined;
        const report = await importFromPaperclip(target, { get: path => reader.get(path), issuePages: (company, query) => reader.issuePages(company, query), commentPages: issue => reader.commentPages(issue), invoke: context.invoke as Invoke, store, folders, exists: path => existsSync(path), local: onThisMac, serverOrigin: originOf(baseUrl) ?? undefined, ...(owners ? { owners } : {}), remoteOf, ...(targets ? { targets } : {}), ...(onThisMac ? { codexHome: codexHomeOf } : {}) });
        queueEmit(['tasks', 'agents', 'inbox']);
        // The imported runs show in the Ledger as imported history (#190).
        try { if (ledger().importHistory(paperclipHistory(context.db()))) queueEmit(['runs']); } catch { /* the Ledger never fails an import */ }
        return report;
      },
      'paperclip.task.start': input => startTask(id(input.taskId)),
      'paperclip.dashboard': input => dashboard(typeof input.utcOffsetMinutes === 'number' ? Math.max(-840, Math.min(840, input.utcOffsetMinutes)) : 0, typeof input.projectId === 'string' && input.projectId ? id(input.projectId) : undefined),
      'paperclip.import.plan': async input => {
        const { reader, onThisMac } = await importSource(input);
        const store = imports();
        if (!store) throw new Error('The import store is unavailable.');
        // GET only, and nothing is written: a preview of what the import would make.
        return planImport(typeof input.companyId === 'string' ? id(input.companyId) : conn.config.companyId, { get: path => reader.get(path), issuePages: (company, query) => reader.issuePages(company, query), invoke: context.invoke as Invoke, store, local: onThisMac });
      },
      'paperclip.memory': input => memoryFor(id(input.taskId)),
      'paperclip.list': input => {
        const kind = input.kind as WorkspaceListKind;
        if (!['artifacts', 'audit', 'routines'].includes(kind)) throw new Error('Unknown list.');
        return list(kind);
      },
      'paperclip.output.fetch': async input => {
        if (typeof input.id !== 'string' || !/^[\w:.-]{1,200}$/.test(input.id)) throw new Error('Unknown output.');
        return openOutput(input.id, typeof input.projectId === 'string' ? input.projectId : undefined, input.preferServer === true);
      },
      'paperclip.output.preview': async input => previewOutput(connection() ? [outputCache()] : [], input.path as string),
      'paperclip.watch': input => {
        live.visible = input.visible === true;
        if (!connection()) { stopPoll(); return { live: 'events' as LiveChannel }; }
        if (!live.visible) { stopPoll(); live.lastChangeAt = 0; live.pollDelay = POLL_FAST_MS; }
        else { live.lastChangeAt = Date.now(); live.pollDelay = POLL_FAST_MS; armEmit(); ensureSocket(); if (!live.socket) schedulePoll(); }
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
      'paperclip.inbox.restore': input => { dismissDb().prepare('DELETE FROM inbox_dismissals WHERE id = ?').run(id(input.id)); queueEmit(['inbox']); return { ok: true as const }; },
      'paperclip.inbox.dismissed': () => ({ items: [...dismissed()].map(([itemId, at]) => ({ id: itemId, at })) }),
    },
    dispose() { history.disposed = true; if (history.timer) timers.clearTimeout(history.timer); history.timer = null; offLedger(); offConnection(); offSession(); signIn.dispose(); closeSocket(); stopPoll(); if (live.emitTimer) timers.clearTimeout(live.emitTimer); live.emitTimer = null; },
    power(event) { if (event.state === 'suspend') { closeSocket(); stopPoll(); } else if (live.visible) { ensureSocket(); if (!live.socket) schedulePoll(); } },
  };
}
