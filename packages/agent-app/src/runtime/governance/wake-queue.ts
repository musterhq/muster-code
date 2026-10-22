/**
 * Wake coalescing and throttling (C30) for every way an agent can be woken: assignment, comment, mention, decision,
 * timer, monitor, on demand. One request becomes one of: a started run, a merge into a wake already waiting, a delay
 * until the agent's minimum gap has passed, a deferral until the live run ends, or a refusal that says why.
 * Event-driven: a delayed wake holds exactly one timer; nothing polls. A waiting wake lives on its row too (merged reasons,
 * notes, force, due time), so `restore()` resumes it after a restart instead of losing it.
 */
import type { GovernanceSettings, HeartbeatPolicy, RunReason, WakeRecord } from '../../shared/domains/project-governance-protocol.ts';
import type { GovernanceStore, WakeWait } from './store.ts';

/** Which reason leads when several are merged (the run shows the first). */
const PRIORITY: RunReason[] = ['decision', 'review', 'children_completed', 'comment_required', 'mention', 'comment', 'assignment', 'monitor', 'watchdog', 'on_demand', 'recovery', 'automation', 'timer', 'continuation', 'retry', 'user'];
export const leadReason = (reasons: readonly RunReason[]): RunReason => [...reasons].sort((a, b) => PRIORITY.indexOf(a) - PRIORITY.indexOf(b))[0] ?? 'user';

export interface WakeTarget { name: string; paused: boolean; revoked: boolean; pending: boolean }
export interface WakeTask { state: string; held: string | null; live: boolean; title: string }
export interface WakeDeps {
  store: GovernanceStore;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  settings(projectId: string): GovernanceSettings;
  heartbeat(projectId: string, memberId: string): HeartbeatPolicy;
  member(projectId: string, memberId: string): WakeTarget | undefined;
  task(projectId: string, taskId: string): WakeTask | undefined;
  /** Is the whole project paused or suspended? Returns a sentence or null. */
  projectHold(projectId: string): string | null;
  /** Starts the run. Resolves with the chat when a run began; throws a sentence when it could not. */
  deliver(w: { projectId: string; memberId: string; taskId: string | null; reason: RunReason; reasons: RunReason[]; notes: string[] }): Promise<{ chatId: string | null }>;
  /** The storm breaker: pause the agent and raise the problem. */
  storm(w: { projectId: string; memberId: string; count: number; perMinute: number }): Promise<void> | void;
  changed(projectId: string): void;
}
export interface WakeRequest { projectId: string; memberId: string; taskId: string | null; reason: RunReason; note?: string; /** On-demand and decision wakes skip the minimum gap (never the storm cap or a hold). */ force?: boolean }
interface Pending { wakeId: string; reasons: Set<RunReason>; notes: string[]; kind: 'throttle' | 'deferred'; timer?: unknown; projectId: string; memberId: string; taskId: string | null; force: boolean; dueAt?: number }
/** Notes one waiting wake carries; the oldest go first. */
const MAX_NOTES = 50;

export class WakeQueue {
  private pending = new Map<string, Pending>();
  private disposed = false;
  private restored = false;
  constructor(private d: WakeDeps) {}
  /** What a waiting wake's row keeps so a restart can resume it. */
  private waiting = (p: Pick<Pending, 'reasons' | 'notes' | 'force' | 'dueAt'>): WakeWait => ({ reasons: [...p.reasons], notes: p.notes, force: p.force, dueAt: p.dueAt === undefined ? null : new Date(p.dueAt).toISOString() });
  private key = (p: string, m: string, t: string | null) => `${p}:${m}:${t ?? ''}`;
  pendingCount() { return this.pending.size; }

  /** Why this wake cannot happen at all, or null. */
  private refusal(r: WakeRequest, m: WakeTarget | undefined, t: WakeTask | undefined): string | null {
    if (!m || m.revoked) return 'That agent is not on the Roster any more.';
    if (m.pending) return `${m.name} is waiting for approval to join.`;
    if (m.paused) return `${m.name} is paused. Resume ${m.name} first.`;
    const hold = this.d.projectHold(r.projectId); if (hold) return hold;
    if (r.taskId) {
      if (!t) return 'That task no longer exists.';
      if (t.held) return t.held;
      if (t.state === 'verified' || t.state === 'cancelled') return `"${t.title}" is ${t.state === 'verified' ? 'done' : 'cancelled'}, so there is nothing to wake ${m.name} for.`;
    }
    return null;
  }
  private record(r: WakeRequest, status: WakeRecord['status'], detail: string, extra: { merged?: number; chatId?: string | null; delivered?: boolean; waiting?: WakeWait } = {}) {
    return this.d.store.addWake({ projectId: r.projectId, memberId: r.memberId, taskId: r.taskId, reason: r.reason, status, detail, note: r.note ?? null, ...extra });
  }

  async request(r: WakeRequest): Promise<WakeRecord> {
    const m = this.d.member(r.projectId, r.memberId), t = r.taskId ? this.d.task(r.projectId, r.taskId) : undefined;
    const why = this.refusal(r, m, t);
    if (why) return this.record(r, 'refused', why);
    const key = this.key(r.projectId, r.memberId, r.taskId), waiting = this.pending.get(key);
    // Coalesce into a wake that is already waiting: one run will carry every reason and note.
    if (waiting) return this.merge(r, waiting);
    const policy = this.d.heartbeat(r.projectId, r.memberId);
    // A run is live on this task: deliver once it ends, as one follow-up.
    if (t?.live) return this.wait(r, 'deferred', `${m!.name} is working on this task now; one follow-up starts when the run ends.`, 0);
    // Storm cap: wakes per minute across the project.
    const storm = await this.stormed(r.projectId, r.memberId);
    if (storm) return this.record(r, 'storm', `${storm.count} wakes in the last minute reached the limit of ${storm.perMinute}. ${m!.name} was paused until you resume it.`);
    // The storm check yielded: another request for this key may have started waiting meanwhile. Join it rather than start a second timer.
    const raced = this.pending.get(key); if (raced) return this.merge(r, raced);
    const last = this.d.store.lastStart(r.projectId, r.memberId), gapMs = policy.minGapSec * 1000;
    const wait = last && !r.force ? Date.parse(last) + gapMs - this.d.now() : 0;
    if (wait > 0) return this.wait(r, 'throttle', `Throttled: ${m!.name} was woken ${Math.max(1, Math.round((gapMs - wait) / 1000))} s ago; this starts in ${Math.ceil(wait / 1000)} s.`, wait);
    return this.start(r, [r.reason], r.note ? [r.note] : [], null);
  }

  private merge(r: WakeRequest, waiting: Pending): WakeRecord {
    waiting.reasons.add(r.reason); if (r.note) { waiting.notes.push(r.note); if (waiting.notes.length > MAX_NOTES) waiting.notes.splice(0, waiting.notes.length - MAX_NOTES); } waiting.force ||= Boolean(r.force);
    const merged = (this.d.store.getWake(waiting.wakeId)?.merged ?? 1) + 1;
    this.d.store.updateWake(waiting.wakeId, { merged, detail: `${waiting.kind === 'deferred' ? 'Waiting for the current run to end' : 'Waiting for the minimum gap'}; ${merged} requests will start one run.`, waiting: this.waiting(waiting) });
    this.d.changed(r.projectId);
    return this.record(r, 'coalesced', `Merged into a wake already waiting (${[...waiting.reasons].join(', ')}).`, { merged: 1 });
  }
  /** The storm cap is per agent: only the agent that is storming is paused. Checked on every path that starts a run. */
  private async stormed(projectId: string, memberId: string): Promise<{ count: number; perMinute: number } | null> {
    const perMinute = this.d.settings(projectId).stormPerMinute, count = this.d.store.wakeCount(projectId, new Date(this.d.now() - 60_000).toISOString(), memberId);
    if (count < perMinute) return null;
    await this.d.storm({ projectId, memberId, count, perMinute });
    return { count, perMinute };
  }
  private wait(r: WakeRequest, kind: Pending['kind'], detail: string, ms: number): WakeRecord {
    const key = this.key(r.projectId, r.memberId, r.taskId);
    const p: Omit<Pending, 'wakeId'> = { reasons: new Set([r.reason]), notes: r.note ? [r.note] : [], kind, projectId: r.projectId, memberId: r.memberId, taskId: r.taskId, force: Boolean(r.force), ...(kind === 'throttle' ? { dueAt: this.d.now() + ms } : {}) };
    const rec = this.record(r, kind === 'throttle' ? 'throttled' : 'deferred', detail, { waiting: this.waiting(p) });
    this.arm(key, Object.assign(p, { wakeId: rec.id }), ms);
    this.d.changed(r.projectId);
    return rec;
  }
  /** Holds a waiting wake in memory; a throttle gets its one timer. */
  private arm(key: string, p: Pending, ms: number) {
    if (p.kind === 'throttle') p.timer = this.d.setTimer(() => void this.fire(key), ms);
    this.pending.set(key, p);
  }
  /**
   * After a restart: every wake still waiting comes back from its row. A throttle past its due time fires now and one not
   * yet due waits out the rest; a deferred wake whose run ended while the app was closed is delivered now, one whose run is
   * still live keeps waiting. A wake whose agent or task is gone is refused. Rows already delivered are never read back.
   */
  async restore(): Promise<void> {
    if (this.restored || this.disposed) return;
    this.restored = true;
    const now = this.d.now(), due: string[] = [], ended: string[] = [], touched = new Set<string>();
    for (const w of this.d.store.waitingWakes()) {
      touched.add(w.projectId);
      const m = w.memberId ? this.d.member(w.projectId, w.memberId) : undefined, t = w.taskId ? this.d.task(w.projectId, w.taskId) : undefined;
      const gone = !w.memberId || !m || m.revoked ? 'that agent is not on the Roster any more' : w.taskId && !t ? 'that task no longer exists' : null;
      if (gone) { this.d.store.updateWake(w.id, { status: 'refused', detail: `Dropped after a restart: ${gone}.` }); continue; }
      const key = this.key(w.projectId, w.memberId!, w.taskId);
      if (this.pending.has(key)) { this.d.store.updateWake(w.id, { status: 'refused', detail: 'Dropped after a restart: another wake for the same work is already waiting.' }); continue; }
      const kind: Pending['kind'] = w.status === 'throttled' ? 'throttle' : 'deferred', dueAt = w.waiting.dueAt ? Date.parse(w.waiting.dueAt) : NaN;
      const p: Pending = { wakeId: w.id, reasons: new Set(w.waiting.reasons), notes: w.waiting.notes.slice(-MAX_NOTES), kind, projectId: w.projectId, memberId: w.memberId!, taskId: w.taskId, force: w.waiting.force, ...(kind === 'throttle' && Number.isFinite(dueAt) ? { dueAt } : {}) };
      if (kind === 'throttle' && p.dueAt !== undefined && p.dueAt > now) { this.arm(key, p, p.dueAt - now); continue; }
      this.pending.set(key, p);
      if (kind === 'throttle') due.push(key); else if (!t?.live) ended.push(key);
    }
    for (const key of due) await this.fire(key);
    for (const key of ended) await this.deliverDeferred(key);
    for (const projectId of touched) this.d.changed(projectId);
  }
  private async fire(key: string) {
    const p = this.pending.get(key); if (!p || this.disposed) return;
    const req: WakeRequest = { projectId: p.projectId, memberId: p.memberId, taskId: p.taskId, reason: leadReason([...p.reasons]), force: true };
    const m = this.d.member(p.projectId, p.memberId), t = p.taskId ? this.d.task(p.projectId, p.taskId) : undefined;
    const why = this.refusal(req, m, t);
    if (why) { this.pending.delete(key); this.d.store.updateWake(p.wakeId, { status: 'refused', detail: `Dropped: ${why}` }); this.d.changed(p.projectId); return; }
    if (t?.live) { const next: Pending = { ...p, kind: 'deferred', timer: undefined, dueAt: undefined }; this.pending.set(key, next); this.d.store.updateWake(p.wakeId, { status: 'deferred', detail: 'Waiting for the current run to end.', waiting: this.waiting(next) }); return; }
    // The wake stays pending through the storm check, so a request arriving meanwhile joins it instead of starting a run of its own.
    const stormFire = await this.stormed(p.projectId, p.memberId);
    if (this.pending.get(key) !== p) return; // cancelled or disposed while the check ran
    this.pending.delete(key);
    if (stormFire) { this.d.store.updateWake(p.wakeId, { status: 'storm', detail: `Dropped: ${stormFire.count} wakes in a minute reached the limit of ${stormFire.perMinute}.` }); this.d.changed(p.projectId); return; }
    // The row stops waiting before the run is asked for, so a restart mid-start never delivers it twice; it counts as a start at once, so the minimum gap holds while the run is being asked for.
    this.d.store.updateWake(p.wakeId, { status: 'started', detail: 'Starting after waiting.', delivered: true });
    try { const out = await this.d.deliver({ projectId: p.projectId, memberId: p.memberId, taskId: p.taskId, reason: leadReason([...p.reasons]), reasons: [...p.reasons], notes: p.notes }); this.d.store.updateWake(p.wakeId, { status: 'started', detail: `Started after waiting${p.reasons.size > 1 ? `; ${p.reasons.size} reasons merged` : ''}.`, chatId: out.chatId, delivered: true }); }
    catch (err) { this.d.store.updateWake(p.wakeId, { status: 'refused', detail: err instanceof Error ? err.message : 'The run could not start.' }); }
    this.d.changed(p.projectId);
  }
  private async start(r: WakeRequest, reasons: RunReason[], notes: string[], reuse: string | null): Promise<WakeRecord> {
    const rec = reuse ? this.d.store.getWake(reuse)! : this.record(r, 'started', 'Started.', { delivered: true });
    try {
      const out = await this.d.deliver({ projectId: r.projectId, memberId: r.memberId, taskId: r.taskId, reason: r.reason, reasons, notes });
      this.d.store.updateWake(rec.id, { status: 'started', chatId: out.chatId, delivered: true, detail: 'Started.' });
    } catch (err) {
      this.d.store.updateWake(rec.id, { status: 'refused', detail: err instanceof Error ? err.message : 'The run could not start.' });
    }
    this.d.changed(r.projectId);
    return this.d.store.getWake(rec.id)!;
  }
  /** A run on the task ended: deliver the follow-up that was waiting for it. */
  async released(projectId: string, taskId: string): Promise<void> {
    for (const [key, p] of [...this.pending]) if (p.projectId === projectId && p.taskId === taskId && p.kind === 'deferred') await this.deliverDeferred(key);
    this.d.changed(projectId);
  }
  private async deliverDeferred(key: string): Promise<void> {
    const p = this.pending.get(key); if (!p || this.disposed) return;
    const { projectId, taskId } = p, req: WakeRequest = { projectId, memberId: p.memberId, taskId, reason: leadReason([...p.reasons]), force: true };
    const why = this.refusal(req, this.d.member(projectId, p.memberId), taskId ? this.d.task(projectId, taskId) : undefined);
    if (why) { this.pending.delete(key); this.d.store.updateWake(p.wakeId, { status: 'refused', detail: `Dropped: ${why}` }); return; }
    // Pending through the storm check (a request meanwhile joins this wake), and a start as soon as the run is asked for (as in fire()).
    const stormRel = await this.stormed(projectId, p.memberId);
    if (this.pending.get(key) !== p) return;
    this.pending.delete(key);
    if (stormRel) { this.d.store.updateWake(p.wakeId, { status: 'storm', detail: `Dropped: ${stormRel.count} wakes in a minute reached the limit of ${stormRel.perMinute}.` }); return; }
    this.d.store.updateWake(p.wakeId, { status: 'started', detail: 'Starting after the previous run ended.', delivered: true });
    try { const out = await this.d.deliver({ projectId, memberId: p.memberId, taskId, reason: leadReason([...p.reasons]), reasons: [...p.reasons], notes: p.notes }); this.d.store.updateWake(p.wakeId, { status: 'started', detail: 'Started after the previous run ended.', chatId: out.chatId, delivered: true }); }
    catch (err) { this.d.store.updateWake(p.wakeId, { status: 'refused', detail: err instanceof Error ? err.message : 'The run could not start.' }); }
  }
  /** Drops waiting wakes for a task (it was cancelled or held). */
  cancelFor(projectId: string, taskIds: ReadonlySet<string>, detail: string): void {
    for (const [key, p] of [...this.pending]) {
      if (p.projectId !== projectId || !p.taskId || !taskIds.has(p.taskId)) continue;
      if (p.timer) this.d.clearTimer(p.timer);
      this.pending.delete(key); this.d.store.updateWake(p.wakeId, { status: 'refused', detail });
    }
  }
  dispose() { this.disposed = true; for (const p of this.pending.values()) if (p.timer) this.d.clearTimer(p.timer); this.pending.clear(); }
}
