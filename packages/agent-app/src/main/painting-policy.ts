/**
 * When the renderer may throttle timers and animation frames. A window the user cannot see always may; a
 * visible but unfocused window keeps full rate only while a run is streaming into it, so an idle window left
 * in the background stops burning CPU.
 */
export function shouldThrottleBackground(state: {visible: boolean; minimized: boolean; focused: boolean; runningChats: number}): boolean {
  if (!state.visible || state.minimized) return true;
  return !state.focused && state.runningChats === 0;
}
