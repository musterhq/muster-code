/** True while an input method is composing (or has just confirmed a composition): Enter then belongs to the IME, not to the app. */
export function imeComposing(event: {nativeEvent?: {isComposing?: boolean; keyCode?: number}; isComposing?: boolean; keyCode?: number}): boolean {
  const native = event.nativeEvent ?? event;
  return native.isComposing === true || native.keyCode === 229;
}
