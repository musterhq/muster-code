/** One feel for every animation (v3): three springs, shared durations, and Reduce Motion, under which springs become a 150 ms
 *  crossfade and nothing shimmers or blinks. */
import {Easing, FadeIn, FadeOut, LinearTransition, ReduceMotion, useReducedMotion} from 'react-native-reanimated';

export const duration = {adjust: 120, exit: 150, enter: 200, layout: 180, pane: 260, rowIn: 140, rowOut: 100, floatIn: 180, floatOut: 120} as const;
/** snappy: controls and swipes; gentle: cards, sheets and capsules; bouncy: moments only (all clear, paired, run finished). */
export const springs = {
  snappy: {damping: 26, mass: 0.7, stiffness: 330},
  gentle: {damping: 20, mass: 1, stiffness: 180},
  bouncy: {damping: 14, mass: 0.8, stiffness: 260},
} as const;
export type SpringName = keyof typeof springs;
export const CROSSFADE_MS = 150;
/** The live line's shimmer sweep and the streaming caret's blink. */
export const SHIMMER_MS = 2200;
export const CARET_BLINK_MS = 1100;
/** The swipe spring (snappy, never overshooting a row's rest position). */
export const spring = {...springs.snappy, overshootClamping: true, reduceMotion: ReduceMotion.System} as const;
/** What an animation should do: spring with a preset, or (Reduce Motion) crossfade. */
export function springFor(name: SpringName, reduce: boolean): {kind: 'spring'; config: typeof springs[SpringName]} | {kind: 'fade'; duration: number} {
  return reduce ? {kind: 'fade', duration: CROSSFADE_MS} : {kind: 'spring', config: springs[name]};
}
/** Reduce Motion from the system, for components that run their own loops. */
export const useReduceMotion = (): boolean => useReducedMotion() ?? false;
export const paneEasing = Easing.inOut(Easing.cubic);
/** Layout animations for rows and floating controls (no-ops when Reduce Motion is on). */
export const rowLayout = LinearTransition.springify().damping(springs.gentle.damping).mass(springs.gentle.mass).stiffness(springs.gentle.stiffness).reduceMotion(ReduceMotion.System);
export const rowEnter = FadeIn.duration(duration.rowIn).reduceMotion(ReduceMotion.System);
export const rowExit = FadeOut.duration(duration.rowOut).reduceMotion(ReduceMotion.System);
export const floatEnter = FadeIn.duration(duration.floatIn).reduceMotion(ReduceMotion.System);
export const floatExit = FadeOut.duration(duration.floatOut).reduceMotion(ReduceMotion.System);
