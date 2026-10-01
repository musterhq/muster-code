/**
 * Wake coalescing and throttling (C30) for every way an agent can be woken: assignment, comment, mention, decision,
 * timer, monitor, on demand. One request becomes one of: a started run, a merge into a wake already waiting, a delay
 * until the agent's minimum gap has passed, a deferral until the live run ends, or a refusal that says why.
 * Event-driven: a delayed wake holds exactly one timer; nothing polls.
 */
import type { GovernanceSettings, HeartbeatPolicy, RunReason, WakeRecord } from '../../shared/domains/project-governance-protocol.ts';
import type { GovernanceStore } from './store.ts';

/** Which reason leads when several are merged (the run shows the first). */
const PRIORITY: RunReason[] = ['decision', 'review', 'comment_required', 'mention', 'comment', 'assignment', 'monitor', 'watchdog', 'on_demand', 'recovery', 'automation', 'timer', 'continuation', 'retry', 'user'];
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
interface Pending { wakeId: string; reasons: Set<RunReason>; notes: string[]; kind: 'throttle' | 'deferred'; timer?: unknown; projectId: string; memberId: string; taskId: string | null; force: boolean }

export class WakeQueue {
  private pending = new Map<string, Pending>();
  private disposed = false;
  constructor(private d: WakeDeps) {}
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
  private record(r: WakeRequest, status: WakeRecord['status'], detail: string, extra: { merged?: number; chatId?: string | null; delivered?: boolean } = {}) {
    return this.d.store.addWake({ projectId: r.projectId, memberId: r.memberId, taskId: r.taskId, reason: r.reason, status, detail, note: r.note ?? null, ...extra });
  }

  async request(r: WakeRequest): Promise<WakeRecord> {
    const m = this.d.member(r.projectId, r.memberId), t = r.taskId ? this.d.task(r.projectId, r.taskId) : undefined;
    const why = this.refusal(r, m, t);
    if (why) return this.record(r, 'refused', why);
    const key = this.key(r.projectId, r.memberId, r.taskId), waiting = this.pending.get(key);
    // Coalesce into a wake that is already waiting: one run will carry every reason and note.
    if (waiting) {
      waiting.reasons.add(r.reason); if (r.note) waiting.notes.push(r.note); waiting.force ||= Boolean(r.force);
      const merged = (this.d.store.getWake(waiting.wakeId)?.merged ?? 1) + 1;
      this.d.store.updateWake(waiting.wakeId, { merged, detail: `${waiting.kind === 'deferred' ? 'Waiting for the current run to end' : 'Waiting for the minimum gap'}; ${merged} requests will start one run.` });
      this.d.changed(r.projectId);
      return this.record(r, 'coalesced', `Merged into a wake already waiting (${[...waiting.reasons].join(', ')}).`, { merged: 1 });
    }
    const policy = this.d.heartbeat(r.projectId, r.memberId);
    // A run is live on this task: deliver once it ends, as one follow-up.
    if (t?.live) return this.wait(r, 'deferred', `${m!.name} is working on this task now; one follow-up starts when the run ends.`, 0);
    // Storm cap: wakes per minute across the project.
    const settings = this.d.settings(r.projectId), since = new Date(this.d.now() - 60_000).toISOString();
    const count = this.d.store.wakeCount(r.projectId, since);
    if (count >= settings.stormPerMinute) {
      await this.d.storm({ projectId: r.projectId, memberId: r.memberId, count, perMinute: settings.stormPerMinute });
      return this.record(r, 'storm', `${count} wakes in the last minute reached the limit of ${settings.stormPerMinute}. ${m!.name} was paused until you resume it.`);
    }
    const last = this.d.store.lastStart(r.projectId, r.memberId), gapMs = policy.minGapSec * 1000;
    const wait = last && !r.force ? Date.parse(last) + gapMs - this.d.now() : 0;
    if (wait > 0) return this.wait(r, 'throttle', `Throttled: ${m!.name} was woken ${Math.max(1, Math.round((gapMs - wait) / 1000))} s ago; this starts in ${Math.ceil(wait / 1000)} s.`, wait);
    return this.start(r, [r.reason], r.note ? [r.note] : [], null);
  }

  private wait(r: WakeRequest, kind: Pending['kind'], detail: string, ms: number): WakeRecord {
    const rec = this.record(r, kind === 'throttle' ? 'throttled' : 'deferred', detail), key = this.key(r.projectId, r.memberId, r.taskId);
    const p: Pending = { wakeId: rec.id, reasons: new Set([r.reason]), notes: r.note ? [r.note] : [], kind, projectId: r.projectId, memberId: r.memberId, taskId: r.taskId, force: Boolean(r.force) };
    if (kind === 'throttle') p.timer = this.d.setTimer(() => void this.fire(key), ms);
    this.pending.set(key, p); this.d.changed(r.projectId);
    return rec;
  }
  private async fire(key: string) {
    const p = this.pending.get(key); if (!p || this.disposed) return;
    this.pending.delete(key);
    const req: WakeRequest = { projectId: p.projectId, memberId: p.memberId, taskId: p.taskId, reason: leadReason([...p.reasons]), force: true };
    const m = this.d.member(p.projectId, p.memberId), t = p.taskId ? this.d.task(p.projectId, p.taskId) : undefined;
    const why = this.refusal(req, m, t);
    if (why) { this.d.store.updateWake(p.wakeId, { status: 'refused', detail: `Dropped: ${why}` }); this.d.changed(p.projectId); return; }
    if (t?.live) { this.pending.set(key, { ...p, kind: 'deferred', timer: undefined }); this.d.store.updateWake(p.wakeId, { status: 'deferred', detail: 'Waiting for the current run to end.' }); return; }
    try { const out = await this.d.deliver({ projectId: p.projectId, memberId: p.memberId, taskId: p.taskId, reason: req.reason, reasons: [...p.reasons], notes: p.notes }); this.d.store.updateWake(p.wakeId, { status: 'started', detail: `Started after waiting${p.reasons.size > 1 ? `; ${p.reasons.size} reasons merged` : ''}.`, chatId: out.chatId, delivered: true }); }
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
    for (const [key, p] of [...this.pending]) {
      if (p.projectId !== projectId || p.taskId !== taskId || p.kind !== 'deferred') continue;
      this.pending.delete(key);
      const req: WakeRequest = { projectId, memberId: p.memberId, taskId, reason: leadReason([...p.reasons]), force: true };
      const why = this.refusal(req, this.d.member(projectId, p.memberId), this.d.task(projectId, taskId));
      if (why) { this.d.store.updateWake(p.wakeId, { status: 'refused', detail: `Dropped: ${why}` }); continue; }
      try { const out = await this.d.deliver({ projectId, memberId: p.memberId, taskId, reason: req.reason, reasons: [...p.reasons], notes: p.notes }); this.d.store.updateWake(p.wakeId, { status: 'started', detail: 'Started after the previous run ended.', chatId: out.chatId, delivered: true }); }
      catch (err) { this.d.store.updateWake(p.wakeId, { status: 'refused', detail: err instanceof Error ? err.message : 'The run could not start.' }); }
    }
    this.d.changed(projectId);
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
