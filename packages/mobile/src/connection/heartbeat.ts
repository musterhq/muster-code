/** Notices a dead link fast (#326 phase 3). A phone that slept, lost Wi-Fi or switched networks often keeps a socket that
 *  looks open but carries nothing. The heartbeat pings the desktop every 15 seconds, and at once when asked (the app came
 *  back to the foreground); no answer within 5 seconds reports the link dead, once, so the app reconnects and resyncs. Any
 *  answer counts as alive, a refusal from an older desktop that doesn't know ping included. */
import {MobileError, type MobileConnection} from '../shared';

export const HEARTBEAT_MS = 15_000;
export const PING_TIMEOUT_MS = 5_000;
export interface Heartbeat { check(): void; stop(): void }

export function startHeartbeat(connection: MobileConnection, options: {onDead(): void; intervalMs?: number; timeoutMs?: number}): Heartbeat {
  const intervalMs = options.intervalMs ?? HEARTBEAT_MS, timeoutMs = options.timeoutMs ?? PING_TIMEOUT_MS;
  let stopped = false, waiting = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const dead = () => { if (stopped) return; stop(); options.onDead(); };
  const check = () => {
    if (stopped || waiting) return;
    waiting = true;
    deadline = setTimeout(dead, timeoutMs);
    connection.call('ping', {}).then(() => true, (error: unknown) => !(error instanceof MobileError) || !['closed', 'timeout'].includes(error.code))
      .then(alive => { waiting = false; clearTimeout(deadline); if (!alive) dead(); });
  };
  const timer = setInterval(check, intervalMs);
  const stop = () => { stopped = true; clearInterval(timer); clearTimeout(deadline); };
  return {check, stop};
}
