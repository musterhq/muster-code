/**
 * The Inbox badge's safety-net poll (#393). With a board key a server often refuses the live socket, so nothing tells the badge when
 * an agent asks something. Every 60 s it is read again, but only when the window is in use, a server is linked, and no event has
 * already refreshed it within that time. The read itself is ETag-revalidated by the runtime, so an unchanged answer is a 304.
 * A hidden, minimized or unfocused window does no work at all (the tick checks `isWindowActive`), so idle CPU stays near zero.
 */
import { isWindowActive } from './windowActivity.ts';

type Every = (run: () => void, ms: number) => () => void;
/** A plain interval that never keeps a process alive (the tick itself skips an inactive window). */
const every: Every = (run, ms) => { const timer = setInterval(() => { if (isWindowActive()) run(); }, ms); (timer as { unref?: () => void }).unref?.(); return () => clearInterval(timer); };

export const BADGE_POLL_MS = 60_000;
export interface BadgePollState { connected: boolean; windowActive: boolean; sinceLastReadMs: number }
export const shouldPollBadge = (s: BadgePollState): boolean => s.connected && s.windowActive && s.sinceLastReadMs >= BADGE_POLL_MS - 1_000;

/** Starts the poll; returns its disposer. `lastReadAt` is when the badge was last loaded by anything. */
export function startBadgePoll(deps: { connected(): boolean; lastReadAt(): number; load(): void; active?(): boolean; every?: Every }): () => void {
  return (deps.every ?? every)(() => {
    if (shouldPollBadge({ connected: deps.connected(), windowActive: deps.active?.() ?? true, sinceLastReadMs: Date.now() - deps.lastReadAt() })) deps.load();
  }, BADGE_POLL_MS);
}
