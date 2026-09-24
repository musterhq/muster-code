/** SBX-13 sleep/wake. Electron's powerMonitor tells main when the Mac suspends and resumes; main forwards
 *  that here (service.power) and this coordinator fans it out to the parts of the runtime that own timers
 *  or long-lived connections.
 *
 *  Contract for participants:
 *  - suspend: stop timers that would misfire on wake (they fire immediately, all at once, after a long sleep).
 *    Durable state (automation cursors, snooze instants, goal status) stays put; only in-memory timers pause.
 *  - resume: do each due thing ONCE. Automations coalesce missed runs via their cursor; snoozes wake by absolute
 *    instant; repo triggers take a fresh baseline instead of diffing across the gap; warm provider sessions are
 *    marked stale so the next send re-checks them rather than writing into a socket that died in sleep.
 *
 *  macOS may deliver resume without suspend (dark wake, a missed event) or repeat either one; both are
 *  idempotent here. lock-screen / unlock-screen are accepted and ignored: a locked Mac keeps running. */

export type PowerState = 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen';
export const POWER_STATES: readonly PowerState[] = ['suspend', 'resume', 'lock-screen', 'unlock-screen'];
export const isPowerState = (value: unknown): value is PowerState => typeof value === 'string' && (POWER_STATES as readonly string[]).includes(value);

export interface SuspendInfo { at: number }
export interface ResumeInfo {
  at: number;
  /** When the matching suspend arrived, or null when resume came without one. */
  suspendedAt: number | null;
  /** Wall-clock time spent asleep (0 without a matching suspend). */
  sleptMs: number;
}
export interface PowerParticipant {
  name: string;
  suspend?(info: SuspendInfo): void | Promise<void>;
  resume?(info: ResumeInfo): void | Promise<void>;
}
export interface PowerOutcome {
  state: PowerState;
  /** False for lock/unlock and for repeated suspends or resumes that changed nothing. */
  handled: boolean;
  sleptMs?: number;
  /** Participants whose hook threw; the others still ran. */
  failures: { name: string; error: string }[];
}
export interface PowerEventsOptions {
  now?: () => number;
  participants?: readonly PowerParticipant[];
  log?: (message: string) => void;
}
export interface PowerEvents {
  register(participant: PowerParticipant): () => void;
  handle(state: PowerState): Promise<PowerOutcome>;
  suspended(): boolean;
  /** Last resume (for callers that want to discount silence that spanned a sleep). */
  lastResume(): ResumeInfo | null;
}

export function createPowerEvents(options: PowerEventsOptions = {}): PowerEvents {
  const now = options.now ?? Date.now;
  const participants: PowerParticipant[] = [...(options.participants ?? [])];
  let suspendedAt: number | null = null;
  let resumed: ResumeInfo | null = null;
  // Hooks run one transition at a time, so a resume that arrives while suspend hooks are still settling waits for them.
  let chain: Promise<unknown> = Promise.resolve();

  async function fan(kind: 'suspend' | 'resume', info: SuspendInfo | ResumeInfo): Promise<PowerOutcome['failures']> {
    const failures: PowerOutcome['failures'] = [];
    for (const participant of [...participants]) {
      const hook = participant[kind] as ((value: typeof info) => void | Promise<void>) | undefined;
      if (!hook) continue;
      try { await hook.call(participant, info); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ name: participant.name, error: message });
        options.log?.(`power: ${participant.name} ${kind} failed: ${message}`);
      }
    }
    return failures;
  }

  function run(state: PowerState): Promise<PowerOutcome> {
    if (state === 'lock-screen' || state === 'unlock-screen') return Promise.resolve({ state, handled: false, failures: [] });
    if (state === 'suspend') {
      if (suspendedAt !== null) return Promise.resolve({ state, handled: false, failures: [] });
      const at = now();
      suspendedAt = at;
      return fan('suspend', { at }).then(failures => ({ state, handled: true, failures }));
    }
    const at = now();
    const since = suspendedAt;
    // A second resume with no suspend between them is a duplicate event: nothing new is due.
    if (since === null && resumed && at - resumed.at < 1_000) return Promise.resolve({ state, handled: false, failures: [] });
    suspendedAt = null;
    const info: ResumeInfo = { at, suspendedAt: since, sleptMs: since === null ? 0 : Math.max(0, at - since) };
    resumed = info;
    return fan('resume', info).then(failures => ({ state, handled: true, sleptMs: info.sleptMs, failures }));
  }

  return {
    register(participant) {
      participants.push(participant);
      return () => { const index = participants.indexOf(participant); if (index >= 0) participants.splice(index, 1); };
    },
    handle(state) {
      if (!isPowerState(state)) return Promise.reject(new Error('Unknown power state.'));
      const next = chain.then(() => run(state), () => run(state));
      chain = next.catch(() => undefined);
      return next;
    },
    suspended: () => suspendedAt !== null,
    lastResume: () => resumed,
  };
}
