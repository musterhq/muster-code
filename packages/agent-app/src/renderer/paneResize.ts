/**
 * F40: the resource pane's width only ever changes because the user dragged (or keyboard-resized) its
 * separator. A drag whose pointerup never reached the renderer (released over the Browser tab's native
 * WebContentsView, which swallows the event) used to stay "armed": the next time the pointer crossed the
 * separator, the pane jumped wide with no button held. A move with no button pressed now ends the drag.
 */
export interface PaneDrag { x: number; width: number }
export const PANE_MIN_WIDTH = 280;

/** Width for a pointer move during a drag, or null when the drag has to end (no button is held). */
export function dragPaneWidth(drag: PaneDrag, event: {clientX: number; buttons: number}, maxWidth: number): number | null {
  if ((event.buttons & 1) === 0) return null;
  return Math.min(maxWidth, Math.max(PANE_MIN_WIDTH, drag.width + drag.x - event.clientX));
}
