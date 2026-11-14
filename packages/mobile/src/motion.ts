/** One feel for every animation: durations and the swipe spring, all honouring the system's Reduce Motion setting. */
import {Easing, FadeIn, FadeOut, LinearTransition, ReduceMotion} from 'react-native-reanimated';

export const duration = {adjust: 120, exit: 150, enter: 200, layout: 180, pane: 260, rowIn: 140, rowOut: 100, floatIn: 180, floatOut: 120} as const;
export const spring = {damping: 26, mass: 0.7, stiffness: 330, overshootClamping: true, reduceMotion: ReduceMotion.System} as const;
export const paneEasing = Easing.inOut(Easing.cubic);
/** Layout animations for rows and floating controls (no-ops when Reduce Motion is on). */
export const rowLayout = LinearTransition.duration(duration.layout).reduceMotion(ReduceMotion.System);
export const rowEnter = FadeIn.duration(duration.rowIn).reduceMotion(ReduceMotion.System);
export const rowExit = FadeOut.duration(duration.rowOut).reduceMotion(ReduceMotion.System);
export const floatEnter = FadeIn.duration(duration.floatIn).reduceMotion(ReduceMotion.System);
export const floatExit = FadeOut.duration(duration.floatOut).reduceMotion(ReduceMotion.System);
