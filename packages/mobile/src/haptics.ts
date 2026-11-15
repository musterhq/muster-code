/** Haptics on key actions: a tap on send, success on approve, warning on decline, and a light texture while a reply streams
 *  (at most once every 320 ms, and never for a reply that was already streaming when the chat opened). */
import * as Haptics from 'expo-haptics';

const quiet = (work: Promise<unknown> | undefined) => { void Promise.resolve(work).catch(() => undefined); };
export const STREAM_TICK_MS = 320;
let lastTick = 0;
export const haptics = {
  tap: () => quiet(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  select: () => quiet(Haptics.selectionAsync()),
  success: () => quiet(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  warning: () => quiet(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
  streamTick(now = Date.now()) { if (now - lastTick < STREAM_TICK_MS) return; lastTick = now; quiet(Haptics.selectionAsync()); },
};
