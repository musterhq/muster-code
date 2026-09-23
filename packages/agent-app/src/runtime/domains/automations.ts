import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Chat, ChatPermissionMode } from '../../shared/protocol.ts';
import { AUTOMATION_HISTORY, AUTOMATION_MAX, AUTOMATION_MAX_PROMPT, AUTOMATION_REPO_MAX_BACKOFF_MS, AUTOMATION_REPO_POLL_MS, AUTOMATION_WATCH_COOLDOWN_MS, type RepoTriggerEvent, PERMISSION_RANK, type Automation, type AutomationCatchUp, type AutomationInput, type AutomationOverlap, type AutomationPreview, type AutomationRun, type AutomationRunStatus, type AutomationSchedule, type AutomationTarget, type AutomationTrigger, type AutomationView } from '../../shared/domains/automations-protocol.ts';
import { describeSchedule, dueBetween, nextOccurrence, upcoming, validTimeZone, validateSchedule } from '../automation-schedule.ts';
import { WorkspaceWatchService } from '../workspace-watch.ts';
import { readRepoSnapshot, RepoPoller, repoWatchKey, type RepoEvent, type RepoWatch } from '../repo-triggers.ts';
import type { DomainContext, DomainModule } from './types.ts';
import { plural } from '../../shared/wording.ts';

/** Scheduler clock; tests shorten the tick and move `now`. */
export const automationTiming = { tickMs: 30_000, firstTickMs: 1_000, now: () => Date.now(), graceMs: 150_000, watchCooldownMs: AUTOMATION_WATCH_COOLDOWN_MS, watchQuietMs: 5_000, repoPollMs: AUTOMATION_REPO_POLL_MS, repoMaxBackoffMs: AUTOMATION_REPO_MAX_BACKOFF_MS };
const ACTIVE: readonly AutomationRunStatus[] = ['queued', 'running'];
const MODES = ['read-only', 'workspace', 'full'] as const;
const ID = /^[a-zA-Z0-9_-]{1,128}$/;

interface AutomationRow { id: string; name: string; prompt: string; target: string; schedule: string; timezone: string; permission_mode: string; overlap: string; catch_up: string; paused: number; created_at: string; updated_at: string; version: number; anchor: number; cursor: number; full_access_version: number | null }
interface RunRow { id: string; automation_id: string; scheduled_for: number; trigger: string; status: string; started_at: string | null; ended_at: string | null; chat_id: string | null; run_id: string | null; reason: string | null; version: number }

const toAutomation = (row: AutomationRow): Automation => ({ id: row.id, name: row.name, prompt: row.prompt, target: JSON.parse(row.target), schedule: JSON.parse(row.schedule), timezone: row.timezone, permissionMode: row.permission_mode as ChatPermissionMode, overlap: row.overlap as AutomationOverlap, catchUp: row.catch_up as AutomationCatchUp, paused: Boolean(row.paused), createdAt: row.created_at, updatedAt: row.updated_at, version: row.version });
const toRun = (row: RunRow): AutomationRun => ({ id: row.id, automationId: row.automation_id, scheduledFor: new Date(row.scheduled_for).toISOString(), trigger: row.trigger as AutomationTrigger, status: row.status as AutomationRunStatus, ...(row.started_at ? { startedAt: row.started_at } : {}), ...(row.ended_at ? { endedAt: row.ended_at } : {}), ...(row.chat_id ? { chatId: row.chat_id } : {}), ...(row.reason ? { reason: row.reason } : {}), version: row.version });
/** What a chat can actually do: only Agent mode uses its access setting (provider-run-lifecycle). */
export const effectiveAccess = (chat: Pick<Chat, 'mode' | 'permissionMode'>): ChatPermissionMode => chat.mode === 'agent' ? chat.permissionMode ?? 'workspace' : 'read-only';

const idOf = (value: unknown, label = 'id'): string => { if (typeof value !== 'string' || !ID.test(value)) throw new Error(`Invalid ${label}.`); return value; };
function scheduleOf(value: unknown): AutomationSchedule {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const schedule: AutomationSchedule | null = input.kind === 'interval' ? { kind: 'interval', minutes: Number(input.minutes) }
    : input.kind === 'daily' ? { kind: 'daily', time: String(input.time ?? ''), days: Array.isArray(input.days) ? input.days.map(Number) : [] }
    : input.kind === 'cron' ? { kind: 'cron', expr: String(input.expr ?? '').trim().replace(/\s+/g, ' ') }
    : input.kind === 'watch' ? { kind: 'watch', folderId: idOf(input.folderId, 'folder') }
    : input.kind === 'repo' ? { kind: 'repo', folderId: idOf(input.folderId, 'folder'), events: Array.isArray(input.events) ? input.events.map(String) as RepoTriggerEvent[] : [], ...(typeof input.branch === 'string' && input.branch.trim() ? { branch: input.branch.trim() } : {}) } : null;
  if (!schedule) throw new Error('Choose a schedule.');
  validateSchedule(schedule);
  return schedule;
}
function targetOf(value: unknown): AutomationTarget {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (input.kind === 'chat') return { kind: 'chat', chatId: idOf(input.chatId, 'chat') };
  if (input.kind !== 'new') throw new Error('Choose where runs happen.');
  const mode = input.mode ?? 'agent';
  if (mode !== 'ask' && mode !== 'plan' && mode !== 'agent') throw new Error('Invalid mode.');
  const model = typeof input.model === 'string' && input.model.trim() ? input.model.trim().slice(0, 256) : undefined;
  if (model && input.providerId === undefined) throw new Error('Choose the model’s provider.');
  return { kind: 'new', mode, ...(input.folderId ? { folderId: idOf(input.folderId, 'folder') } : {}), ...(input.projectId ? { projectId: idOf(input.projectId, 'project') } : {}), ...(model ? { providerId: idOf(input.providerId, 'provider'), model } : {}) };
}
function timeZoneOf(value: unknown): string {
  if (typeof value !== 'string' || !validTimeZone(value)) throw new Error('Choose a valid time zone.');
  return value;
}
function inputOf(raw: Record<string, unknown>): AutomationInput {
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > 120) throw new Error('Name the automation (up to 120 characters).');
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (!prompt) throw new Error('Write what the agent should do on each run.');
  if (prompt.length > AUTOMATION_MAX_PROMPT || prompt.includes('\0')) throw new Error(`Keep the prompt under ${AUTOMATION_MAX_PROMPT} characters.`);
  const permissionMode = raw.permissionMode ?? 'workspace';
  if (!MODES.includes(permissionMode as ChatPermissionMode)) throw new Error('Invalid access policy.');
  const overlap = raw.overlap ?? 'skip', catchUp = raw.catchUp ?? 'one';
  if (overlap !== 'skip' && overlap !== 'queue') throw new Error('Invalid overlap policy.');
  if (catchUp !== 'one' && catchUp !== 'none') throw new Error('Invalid catch-up policy.');
  return { name, prompt, target: targetOf(raw.target), schedule: scheduleOf(raw.schedule), timezone: timeZoneOf(raw.timezone), permissionMode: permissionMode as ChatPermissionMode, overlap, catchUp };
}

/** Automations: recurring agent runs on a schedule or on file changes. A 30s tick inside the runtime dispatches due runs through
 *  chat.create/chat.send with a requestId fixed per occurrence, so a retried or duplicated dispatch never sends twice. */
export function createAutomationsDomain(ctx: DomainContext): DomainModule {
  const db = ctx.db();
  db.exec(`CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, target TEXT NOT NULL, schedule TEXT NOT NULL, timezone TEXT NOT NULL, permission_mode TEXT NOT NULL, overlap TEXT NOT NULL, catch_up TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL, anchor INTEGER NOT NULL, cursor INTEGER NOT NULL, full_access_version INTEGER);
    CREATE TABLE IF NOT EXISTS automation_runs (id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, scheduled_for INTEGER NOT NULL, trigger TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT, ended_at TEXT, chat_id TEXT, run_id TEXT, reason TEXT, version INTEGER NOT NULL, UNIQUE(automation_id, scheduled_for));
    CREATE INDEX IF NOT EXISTS automation_runs_by_automation ON automation_runs(automation_id, scheduled_for DESC);
    CREATE TABLE IF NOT EXISTS automation_versions (automation_id TEXT NOT NULL, version INTEGER NOT NULL, config TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(automation_id, version))`);
  let disposed = false, reconciled = false;
  const dispatching = new Set<string>();
  const watchState = new Map<string, { lastRun: number; quietUntil: number; timer?: ReturnType<typeof setTimeout> }>();
  let watcher: WorkspaceWatchService | undefined;
  const watched = new Set<string>();

  const row = (id: string) => db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as AutomationRow | undefined;
  const existing = (id: unknown): AutomationRow => { const found = row(idOf(id)); if (!found) throw new Error('Automation not found.'); return found; };
  const rows = () => db.prepare('SELECT * FROM automations ORDER BY created_at').all() as unknown as AutomationRow[];
  const runRow = (id: string) => db.prepare('SELECT * FROM automation_runs WHERE id = ?').get(id) as RunRow | undefined;
  const activeRuns = (automationId: string) => db.prepare(`SELECT * FROM automation_runs WHERE automation_id = ? AND status IN ('queued','running') ORDER BY scheduled_for`).all(automationId) as unknown as RunRow[];
  const iso = (ms = automationTiming.now()) => new Date(ms).toISOString();

  function issuesFor(target: AutomationTarget, permissionMode: ChatPermissionMode, schedule?: AutomationSchedule): string[] {
    const issues: string[] = [];
    const folder = (folderId: string, label: string) => {
      const found = ctx.store.folder(folderId);
      if (!found) issues.push(`The ${label} folder was removed.`);
      else if (!existsSync(found.path)) issues.push(`${found.name} was moved or deleted. Relink it in the sidebar.`);
    };
    if (target.kind === 'chat') {
      const chat = ctx.store.chat(target.chatId);
      if (!chat) issues.push('The chat this automation continues was deleted.');
      else {
        if (chat.archived) issues.push(`“${chat.title}” is archived. Restore it to keep running here.`);
        if (PERMISSION_RANK[effectiveAccess(chat)] > PERMISSION_RANK[permissionMode]) issues.push(`“${chat.title}” now has more access than this automation allows. Lower the chat’s access or edit the automation.`);
      }
    } else {
      if (target.folderId) folder(target.folderId, 'target');
      if (target.projectId && !ctx.store.project(target.projectId)) issues.push('The Project this automation runs in was deleted.');
    }
    if (schedule?.kind === 'watch') folder(schedule.folderId, 'watched');
    if (schedule?.kind === 'repo') folder(schedule.folderId, 'watched repository');
    return issues;
  }
  function view(automation: AutomationRow): AutomationView {
    const value = toAutomation(automation), now = automationTiming.now();
    const recent = db.prepare('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY scheduled_for DESC LIMIT 8').all(automation.id) as unknown as RunRow[];
    const active = recent.find(run => ACTIVE.includes(run.status as AutomationRunStatus)), last = recent.find(run => !ACTIVE.includes(run.status as AutomationRunStatus));
    let next: number | null = null;
    if (!value.paused) try { next = nextOccurrence(value.schedule, value.timezone, Math.max(now, automation.cursor), automation.anchor); } catch { next = null; }
    let issues: string[] = [];
    try { issues = issuesFor(value.target, value.permissionMode, value.schedule); } catch { issues = []; }
    return { ...value, summary: describeSchedule(value.schedule), issues, ...(next !== null ? { nextRunAt: iso(next) } : {}), ...(last ? { lastRun: toRun(last) } : {}), ...(active ? { activeRun: toRun(active) } : {}) };
  }
  const list = () => rows().map(view);
  let broadcastQueued = false;
  /** One event per burst of changes; the payload is the whole (small, capped) list. */
  const broadcast = () => {
    if (broadcastQueued || disposed) return;
    broadcastQueued = true;
    queueMicrotask(() => { broadcastQueued = false; if (!disposed) try { ctx.emit({ type: 'automationsChanged', automations: list() }); } catch { /* the renderer re-reads on open */ } });
  };

  function insertRun(automation: AutomationRow, scheduledFor: number, trigger: AutomationTrigger, status: AutomationRunStatus, reason?: string): RunRow | undefined {
    const id = randomUUID(), started = status === 'running' ? iso() : null, ended = status === 'skipped' || status === 'missed' || status === 'failed' ? iso() : null;
    const result = db.prepare('INSERT OR IGNORE INTO automation_runs (id, automation_id, scheduled_for, trigger, status, started_at, ended_at, chat_id, run_id, reason, version) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)')
      .run(id, automation.id, scheduledFor, trigger, status, started, ended, reason ?? null, automation.version);
    if (!result.changes) return undefined;
    db.prepare(`DELETE FROM automation_runs WHERE automation_id = ? AND id NOT IN (SELECT id FROM automation_runs WHERE automation_id = ? ORDER BY scheduled_for DESC LIMIT ${AUTOMATION_HISTORY})`).run(automation.id, automation.id);
    broadcast();
    return runRow(id);
  }
  const finish = (runId: string, status: AutomationRunStatus, reason?: string) => {
    db.prepare(`UPDATE automation_runs SET status = ?, ended_at = ?, reason = COALESCE(?, reason) WHERE id = ? AND status IN ('queued','running')`).run(status, iso(), reason ?? null, runId);
    broadcast();
  };
  const busy = (chatId: string) => {
    const chat = ctx.store.chat(chatId);
    return Boolean(chat && (chat.status === 'running' || chat.status === 'stopping' || chat.recovery?.kind === 'recovery-needed' || ctx.store.queue(chatId).length));
  };
  /** The requestId is a pure function of the occurrence: a second dispatch of it is answered from the send receipt. */
  const requestIdFor = (automationId: string, scheduledFor: number) => `auto-${automationId}-${scheduledFor}`;

  async function dispatch(automation: AutomationRow, run: RunRow): Promise<void> {
    if (dispatching.has(run.id)) return;
    dispatching.add(run.id);
    try {
      const value = toAutomation(automation);
      const issues = issuesFor(value.target, value.permissionMode, value.schedule);
      if (issues.length) { finish(run.id, 'failed', issues[0]); return; }
      if (value.permissionMode === 'full' && automation.full_access_version !== automation.version) { finish(run.id, 'failed', 'Full access was not re-confirmed for this version. Edit the automation and confirm it.'); return; }
      db.prepare(`UPDATE automation_runs SET status = 'running', started_at = ? WHERE id = ?`).run(iso(), run.id);
      let chatId: string;
      if (value.target.kind === 'chat') chatId = value.target.chatId;
      else {
        const target = value.target;
        const chat = await ctx.invoke('chat.create', { ...(target.folderId ? { folderId: target.folderId } : {}), ...(target.projectId ? { projectId: target.projectId } : {}) });
        chatId = chat.id;
        db.prepare('UPDATE automation_runs SET chat_id = ? WHERE id = ?').run(chatId, run.id);
        await ctx.invoke('chat.update', { id: chatId, title: value.name, mode: target.mode });
        if (target.providerId && target.model) await ctx.invoke('chat.selectProvider', { id: chatId, providerId: target.providerId, model: target.model });
        // A scheduled run never gets more access than the automation was saved with.
        await ctx.invoke('chat.setPermissionMode', { id: chatId, permissionMode: value.permissionMode, ...(value.permissionMode === 'full' ? { acknowledgeFullAccess: true } : {}) });
      }
      db.prepare('UPDATE automation_runs SET chat_id = ? WHERE id = ?').run(chatId, run.id);
      const label = run.trigger === 'manual' ? 'Run now' : run.trigger === 'catch-up' ? 'Catch-up run' : run.trigger === 'watch' ? 'Files changed' : run.trigger === 'repo' ? 'Repository event' : 'Scheduled run';
      ctx.store.appendItem(chatId, 'notice', `${label} · ${value.name}`, 'completed', { kind: 'automation-run', automationId: value.id, automationRunId: run.id });
      // AUT-06: a repository trigger tells the agent what happened.
      const text = run.trigger === 'repo' && run.reason ? `${value.prompt}\n\nTriggered by: ${run.reason}` : value.prompt;
      const sent = await ctx.invoke('chat.send', { id: chatId, text, requestId: requestIdFor(value.id, run.scheduled_for) });
      db.prepare(`UPDATE automation_runs SET run_id = ? WHERE id = ? AND status = 'running'`).run(sent.runId, run.id);
      broadcast();
    } catch (error) {
      finish(run.id, 'failed', error instanceof Error ? error.message : String(error));
    } finally { dispatching.delete(run.id); }
  }

  /** Starts (or skips, or queues) one occurrence. Returns undefined when that occurrence already has a run. */
  function start(automation: AutomationRow, scheduledFor: number, trigger: AutomationTrigger, reason?: string): RunRow | undefined {
    const value = toAutomation(automation), active = activeRuns(automation.id);
    const running = active.find(run => run.status === 'running'), queued = active.find(run => run.status === 'queued');
    const chatBusy = value.target.kind === 'chat' && busy(value.target.chatId);
    if (running || queued || chatBusy) {
      const why = running || queued ? 'The previous run was still working.' : 'The chat was busy with another turn.';
      if (value.overlap === 'skip') return insertRun(automation, scheduledFor, trigger, 'skipped', why);
      // A bounded queue: one waiting run per automation; later occurrences fold into it.
      if (queued) return insertRun(automation, scheduledFor, trigger, 'skipped', 'A run was already queued behind the working one.');
      return insertRun(automation, scheduledFor, trigger, 'queued', reason);
    }
    const run = insertRun(automation, scheduledFor, trigger, 'running', reason);
    if (run) void dispatch(automation, run);
    return run;
  }
  /** A queued run goes as soon as nothing of its automation is working and its chat is free. */
  function drainQueue(automationId: string): void {
    const automation = row(automationId);
    if (!automation || disposed) return;
    const active = activeRuns(automationId), queued = active.find(run => run.status === 'queued');
    if (!queued || active.some(run => run.status === 'running')) return;
    const target = toAutomation(automation).target;
    if (target.kind === 'chat' && busy(target.chatId)) return;
    db.prepare(`UPDATE automation_runs SET status = 'running' WHERE id = ?`).run(queued.id);
    void dispatch(automation, { ...queued, status: 'running' });
  }

  /** After a restart, a run the app never finished dispatching is failed; a dispatched one takes its chat's outcome. */
  function reconcile(): void {
    reconciled = true;
    for (const run of db.prepare(`SELECT * FROM automation_runs WHERE status = 'running'`).all() as unknown as RunRow[]) {
      if (dispatching.has(run.id)) continue;
      const chat = run.chat_id ? ctx.store.chat(run.chat_id) : undefined;
      if (!run.run_id || !chat) { finish(run.id, 'failed', run.run_id ? 'The run’s chat was deleted.' : 'Muster closed before this run started.'); continue; }
      if (chat.status === 'running' || chat.status === 'stopping') continue;
      finish(run.id, chat.status === 'completed' ? 'completed' : chat.status === 'interrupted' ? 'interrupted' : 'failed', chat.status === 'failed' ? chat.error ?? 'The run failed.' : undefined);
    }
  }

  function tick(): void {
    if (disposed) return;
    const now = automationTiming.now();
    const automations = rows();
    if (!automations.length) return;
    if (!reconciled) reconcile();
    for (const automation of automations) {
      if (automation.paused) { drainQueue(automation.id); continue; }
      let schedule: AutomationSchedule;
      try { schedule = JSON.parse(automation.schedule); } catch { continue; }
      if (schedule.kind !== 'watch' && schedule.kind !== 'repo') {
        let due: { latest: number | null; count: number };
        try { due = dueBetween(schedule, automation.timezone, automation.cursor, now, automation.anchor); } catch { continue; }
        if (due.latest !== null) {
          db.prepare('UPDATE automations SET cursor = ? WHERE id = ?').run(due.latest, automation.id);
          const current = { ...automation, cursor: due.latest };
          // Sleep, a closed app or a long block: the due runs coalesce into one catch-up run, or one "missed" entry.
          const late = now - due.latest > automationTiming.graceMs, missed = due.count > 1 || late;
          if (missed && automation.catch_up === 'none') insertRun(current, due.latest, 'schedule', 'missed', `${plural(due.count, 'run')} missed while this Mac was asleep or Muster was closed.`);
          else start(current, due.latest, missed ? 'catch-up' : 'schedule', missed ? `Covers ${plural(due.count, 'missed run')}.` : undefined);
          broadcast();
        }
      }
      drainQueue(automation.id);
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const loop = (delay: number) => {
    timer = setTimeout(() => {
      try { tick(); } catch (error) { console.error('automations: tick failed', error); }
      if (!disposed) loop(automationTiming.tickMs);
    }, delay);
    timer.unref?.();
  };
  loop(automationTiming.firstTickMs);

  // File-watch triggers: at most one run per cooldown; changes while its own run works (or just after) never retrigger it.
  function onFolderChanged(folderId: string): void {
    const now = automationTiming.now();
    for (const automation of rows()) {
      if (automation.paused) continue;
      const schedule = JSON.parse(automation.schedule) as AutomationSchedule;
      if (schedule.kind !== 'watch' || schedule.folderId !== folderId) continue;
      if (activeRuns(automation.id).length) continue;
      const state = watchState.get(automation.id) ?? { lastRun: 0, quietUntil: 0 };
      watchState.set(automation.id, state);
      if (now < state.quietUntil || state.timer) continue;
      const wait = state.lastRun + automationTiming.watchCooldownMs - now;
      const fire = () => {
        state.timer = undefined;
        const current = row(automation.id);
        if (!current || current.paused || disposed) return;
        state.lastRun = automationTiming.now();
        start(current, state.lastRun, 'watch');
      };
      if (wait > 0) { state.timer = setTimeout(fire, wait); state.timer.unref?.(); } else fire();
    }
  }
  function syncWatches(): void {
    const wanted = new Map<string, string>();
    for (const automation of rows()) {
      if (automation.paused) continue;
      const schedule = JSON.parse(automation.schedule) as AutomationSchedule;
      const folder = schedule.kind === 'watch' ? ctx.store.folder(schedule.folderId) : undefined;
      if (folder) wanted.set(folder.id, folder.path);
    }
    syncRepoWatches();
    if (!wanted.size && !watcher) return;
    watcher ??= new WorkspaceWatchService(onFolderChanged, (folderId, error) => { watched.delete(folderId); console.error(`automations: watch for ${folderId} failed`, error); });
    for (const folderId of [...watched]) if (!wanted.has(folderId)) { watcher.unwatch(folderId); watched.delete(folderId); }
    for (const [folderId, path] of wanted) if (!watched.has(folderId)) { watched.add(folderId); watcher.watch(folderId, path).catch(() => watched.delete(folderId)); }
  }
  // AUT-06: repository/CI triggers. One poller per (folder, branch); each poll's events fan out to the automations
  // that asked for them, as one run each (the overlap policy still applies), so a burst of GitHub activity is one run.
  let repoPoller: RepoPoller | undefined;
  const repoAutomations = () => rows().filter(automation => !automation.paused).map(automation => ({ automation, schedule: JSON.parse(automation.schedule) as AutomationSchedule }))
    .filter((entry): entry is { automation: AutomationRow; schedule: Extract<AutomationSchedule, { kind: 'repo' }> } => entry.schedule.kind === 'repo');
  function onRepoEvents(watch: RepoWatch, events: RepoEvent[]): void {
    if (disposed) return;
    for (const { automation, schedule } of repoAutomations()) {
      if (repoWatchKey(schedule) !== repoWatchKey(watch)) continue;
      const mine = events.filter(event => schedule.events.includes(event.kind));
      if (!mine.length) continue;
      const reason = mine.slice(0, 3).map(event => event.description).join('; ') + (mine.length > 3 ? `; and ${mine.length - 3} more` : '');
      start(automation, automationTiming.now(), 'repo', reason.slice(0, 1000));
    }
  }
  function syncRepoWatches(): void {
    const wanted = new Map<string, RepoWatch>();
    for (const { schedule } of repoAutomations()) {
      if (!ctx.store.folder(schedule.folderId)) continue;
      const key = repoWatchKey(schedule), prior = wanted.get(key);
      wanted.set(key, { folderId: schedule.folderId, ...(schedule.branch ? { branch: schedule.branch } : {}), checks: (prior?.checks ?? false) || schedule.events.includes('check-failed') });
    }
    if (!wanted.size && !repoPoller) return;
    repoPoller ??= new RepoPoller({
      read: watch => { const folder = ctx.store.folder(watch.folderId); if (!folder) throw new Error('The watched folder was removed.'); return readRepoSnapshot(folder.path, { ...(watch.branch ? { branch: watch.branch } : {}), checks: watch.checks }); },
      onEvents: onRepoEvents,
      onError: (watch, error, retryInMs) => console.warn(`automations: repository poll for ${watch.folderId} failed; retrying in ${Math.round(retryInMs / 1000)}s`, error instanceof Error ? error.message : error),
      baseMs: automationTiming.repoPollMs, maxMs: automationTiming.repoMaxBackoffMs,
    });
    for (const key of repoPoller.keys()) if (!wanted.has(key)) repoPoller.unwatch(key);
    for (const watch of wanted.values()) repoPoller.watch(watch);
  }
  let watchesSynced = false;
  const ensureWatches = () => { if (!watchesSynced) { watchesSynced = true; try { syncWatches(); } catch { watchesSynced = false; } } };
  queueMicrotask(() => { if (!disposed && db.prepare(`SELECT 1 FROM automations WHERE schedule LIKE '%"watch"%' OR schedule LIKE '%"repo"%' LIMIT 1`).get()) ensureWatches(); });

  ctx.hooks.onRunSettled(settled => {
    const run = (db.prepare(`SELECT * FROM automation_runs WHERE status = 'running' AND chat_id = ? AND (run_id = ? OR run_id IS NULL) ORDER BY scheduled_for LIMIT 1`).get(settled.chat.id, settled.runId) as RunRow | undefined);
    if (!run) { for (const automation of db.prepare(`SELECT DISTINCT automation_id FROM automation_runs WHERE status = 'queued'`).all() as unknown as { automation_id: string }[]) setTimeout(() => drainQueue(automation.automation_id), 0); return; }
    const status: AutomationRunStatus = settled.status === 'completed' ? 'completed' : settled.status === 'interrupted' ? 'interrupted' : 'failed';
    finish(run.id, status, status === 'failed' ? settled.chat.error ?? 'The run failed.' : undefined);
    const state = watchState.get(run.automation_id);
    if (state) state.quietUntil = automationTiming.now() + automationTiming.watchQuietMs;
    setTimeout(() => drainQueue(run.automation_id), 0);
  });

  function save(automation: AutomationRow, input: AutomationInput, acknowledged: boolean, version: number): void {
    if (input.permissionMode === 'full' && !acknowledged) throw new Error('Confirm unrestricted filesystem, command execution and network access for this automation’s runs.');
    const now = iso();
    db.prepare(`INSERT INTO automations (id, name, prompt, target, schedule, timezone, permission_mode, overlap, catch_up, paused, created_at, updated_at, version, anchor, cursor, full_access_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, prompt = excluded.prompt, target = excluded.target, schedule = excluded.schedule, timezone = excluded.timezone, permission_mode = excluded.permission_mode, overlap = excluded.overlap, catch_up = excluded.catch_up, updated_at = excluded.updated_at, version = excluded.version, anchor = excluded.anchor, cursor = excluded.cursor, full_access_version = excluded.full_access_version`)
      .run(automation.id, input.name, input.prompt, JSON.stringify(input.target), JSON.stringify(input.schedule), input.timezone, input.permissionMode, input.overlap, input.catchUp, automation.paused, automation.created_at, now, version, automation.anchor, automation.cursor, input.permissionMode === 'full' ? version : null);
    db.prepare('INSERT OR REPLACE INTO automation_versions (automation_id, version, config, created_at) VALUES (?, ?, ?, ?)').run(automation.id, version, JSON.stringify(input), now);
    watchesSynced = false; ensureWatches(); broadcast();
  }
  /** A chat target is capped at the access the chat has when the automation is saved (never raised by the automation). */
  function checkedInput(raw: Record<string, unknown>): AutomationInput {
    const input = inputOf(raw);
    if (input.target.kind === 'chat') {
      const chat = ctx.store.chat(input.target.chatId);
      if (!chat) throw new Error('That chat no longer exists.');
      if (chat.archived) throw new Error('Restore that chat before scheduling runs in it.');
      if (PERMISSION_RANK[effectiveAccess(chat)] > PERMISSION_RANK[input.permissionMode]) throw new Error(`“${chat.title}” has more access than this automation allows. Raise the automation’s access or lower the chat’s.`);
    } else {
      if (input.target.folderId && !ctx.store.folder(input.target.folderId)) throw new Error('That folder is no longer in the sidebar.');
      if (input.target.projectId && !ctx.store.project(input.target.projectId)) throw new Error('That Project no longer exists.');
    }
    if (input.schedule.kind === 'watch' && !ctx.store.folder(input.schedule.folderId)) throw new Error('Choose a folder from the sidebar to watch.');
    if (input.schedule.kind === 'repo' && !ctx.store.folder(input.schedule.folderId)) throw new Error('Choose a folder from the sidebar whose repository to watch.');
    if (input.schedule.kind !== 'watch' && input.schedule.kind !== 'repo' && nextOccurrence(input.schedule, input.timezone, automationTiming.now(), automationTiming.now()) === null) throw new Error('This schedule never runs.');
    return input;
  }

  return {
    handlers: {
      'automations.list': () => { ensureWatches(); return list(); },
      'automations.create': raw => {
        const input = checkedInput(raw);
        if ((db.prepare('SELECT COUNT(*) AS count FROM automations').get() as { count: number }).count >= AUTOMATION_MAX) throw new Error(`Keep at most ${AUTOMATION_MAX} automations.`);
        const now = automationTiming.now(), id = randomUUID();
        const blank: AutomationRow = { id, name: '', prompt: '', target: '', schedule: '', timezone: '', permission_mode: '', overlap: '', catch_up: '', paused: 0, created_at: iso(now), updated_at: iso(now), version: 1, anchor: now, cursor: now, full_access_version: null };
        save(blank, input, raw.acknowledgeFullAccess === true, 1);
        return view(row(id)!);
      },
      'automations.update': raw => {
        const current = existing(raw.id), input = checkedInput(raw), now = automationTiming.now();
        // A new schedule starts counting from now: no backfill of occurrences the old one would have had.
        const rescheduled = current.schedule !== JSON.stringify(input.schedule) || current.timezone !== input.timezone;
        save({ ...current, ...(rescheduled ? { anchor: now, cursor: now } : {}) }, input, raw.acknowledgeFullAccess === true, current.version + 1);
        return view(row(current.id)!);
      },
      'automations.delete': raw => {
        const current = existing(raw.id);
        db.prepare('DELETE FROM automation_runs WHERE automation_id = ?').run(current.id);
        db.prepare('DELETE FROM automation_versions WHERE automation_id = ?').run(current.id);
        db.prepare('DELETE FROM automations WHERE id = ?').run(current.id);
        const state = watchState.get(current.id); if (state?.timer) clearTimeout(state.timer); watchState.delete(current.id);
        watchesSynced = false; ensureWatches(); broadcast();
      },
      'automations.pause': raw => {
        const current = existing(raw.id);
        db.prepare('UPDATE automations SET paused = 1, updated_at = ? WHERE id = ?').run(iso(), current.id);
        // A queued run is dropped; a working one finishes.
        for (const run of activeRuns(current.id)) if (run.status === 'queued') finish(run.id, 'skipped', 'Paused before it started.');
        watchesSynced = false; ensureWatches(); broadcast();
        return view(row(current.id)!);
      },
      'automations.resume': raw => {
        const current = existing(raw.id), now = automationTiming.now();
        // Resuming never replays what came due while paused.
        db.prepare('UPDATE automations SET paused = 0, cursor = ?, updated_at = ? WHERE id = ?').run(Math.max(current.cursor, now), iso(now), current.id);
        watchesSynced = false; ensureWatches(); broadcast();
        return view(row(current.id)!);
      },
      'automations.runNow': async raw => {
        const current = existing(raw.id), now = automationTiming.now();
        const run = start(current, now, 'manual');
        if (!run) throw new Error('A run for this moment already exists.');
        // Let the first dispatch step (and an early refusal) land before answering.
        await new Promise(resolve => setImmediate(resolve));
        return toRun(runRow(run.id) ?? run);
      },
      'automations.preview': raw => {
        const schedule = scheduleOf(raw.schedule), timezone = timeZoneOf(raw.timezone), now = automationTiming.now();
        const next = schedule.kind === 'watch' || schedule.kind === 'repo' ? [] : upcoming(schedule, timezone, now, 3, now).map(ms => iso(ms));
        const permission = MODES.includes(raw.permissionMode as ChatPermissionMode) ? raw.permissionMode as ChatPermissionMode : 'workspace';
        let issues: string[] = [];
        if (raw.target !== undefined) { try { issues = issuesFor(targetOf(raw.target), permission, schedule); } catch (error) { issues = [error instanceof Error ? error.message : String(error)]; } }
        if (schedule.kind !== 'watch' && schedule.kind !== 'repo' && !next.length) issues.push('This schedule never runs.');
        return { next, summary: describeSchedule(schedule), issues } satisfies AutomationPreview;
      },
      'automations.runs': raw => {
        const current = existing(raw.id), limit = typeof raw.limit === 'number' && Number.isInteger(raw.limit) ? Math.min(Math.max(raw.limit, 1), AUTOMATION_HISTORY) : 50;
        return (db.prepare('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY scheduled_for DESC LIMIT ?').all(current.id, limit) as unknown as RunRow[]).map(toRun);
      },
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      for (const state of watchState.values()) if (state.timer) clearTimeout(state.timer);
      watchState.clear(); watcher?.dispose(); watcher = undefined;
      repoPoller?.dispose(); repoPoller = undefined;
    },
  };
}
