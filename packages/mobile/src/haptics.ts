/** Haptics (v3): selection for chips, swipe thresholds and stream ticks (at most every 320 ms, and never for a reply that was
 *  already streaming when the chat opened); light for send, copy, Stop and undo; medium for start, pair and lift; success for
 *  approve, answer, commit, all clear and a finished run; warning for decline, failure and locked. */
import * as Haptics from 'expo-haptics';

const quiet = (work: Promise<unknown> | undefined) => { void Promise.resolve(work).catch(() => undefined); };
export const STREAM_TICK_MS = 320;
/** A moment that follows an answer (all clear) gives no second success inside this window. */
export const MOMENT_WINDOW_MS = 1500;
let lastTick = 0, lastSuccess = 0;
export const haptics = {
  select: () => quiet(Haptics.selectionAsync()),
  light: () => quiet(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  medium: () => quiet(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
  success: () => { lastSuccess = Date.now(); quiet(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)); },
  /** Success for a moment, unless an answer just gave one. */
  moment: () => { if (Date.now() - lastSuccess > MOMENT_WINDOW_MS) haptics.success(); },
  warning: () => quiet(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
  streamTick(now = Date.now()) { if (now - lastTick < STREAM_TICK_MS) return; lastTick = now; quiet(Haptics.selectionAsync()); },
};
