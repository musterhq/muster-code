/** Two-finger trackpad swipe = Back/Forward, like a browser. Swiping right (content moving right) goes back.
 *  Only horizontal gestures that nothing under the pointer can scroll count; a gesture fires once, then waits for the trackpad to settle. */

export const SWIPE_DISTANCE = 160;
const GESTURE_IDLE_MS = 260;

export interface SwipeDetector { wheel(event: {deltaX: number; deltaY: number; ctrlKey?: boolean; at: number; scrollable: boolean}): 'back' | 'forward' | null }

export function createSwipeDetector(distance = SWIPE_DISTANCE): SwipeDetector {
  let total = 0, last = -Infinity, spent = false;
  return {
    wheel({deltaX, deltaY, ctrlKey, at, scrollable}) {
      if (at - last > GESTURE_IDLE_MS) { total = 0; spent = false; }
      last = at;
      // A gesture a pane under the pointer scrolled sideways belongs to that pane until the trackpad settles, even once it hits its edge.
      if (scrollable) { total = 0; spent = true; return null; }
      // Pinch-zoom and mostly-vertical scrolls are not navigation.
      if (ctrlKey || Math.abs(deltaX) <= Math.abs(deltaY) * 1.5) { total = 0; return null; }
      if (spent) return null;
      total += deltaX;
      if (Math.abs(total) < distance) return null;
      spent = true;
      return total < 0 ? 'back' : 'forward';
    },
  };
}

const IGNORED = 'input, textarea, select, [contenteditable="true"], .xterm, canvas, webview, [data-no-swipe]';

/** True when the target, or a pane around it, can still scroll in the gesture's direction. */
function scrollsSideways(target: EventTarget | null, deltaX: number): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== document.documentElement; el = el.parentElement) {
    if (el.matches(IGNORED)) return true;
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    const overflow = getComputedStyle(el).overflowX;
    if (overflow !== 'auto' && overflow !== 'scroll') continue;
    if (deltaX < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
  }
  return false;
}

export function installSwipeNavigation(go: (direction: 'back' | 'forward') => void, target: Window = window): () => void {
  const detector = createSwipeDetector();
  const onWheel = (event: WheelEvent) => {
    if (event.deltaMode !== 0) return; // trackpads report pixels; mouse wheels (lines) never navigate
    const direction = detector.wheel({deltaX: event.deltaX, deltaY: event.deltaY, ctrlKey: event.ctrlKey, at: event.timeStamp, scrollable: Math.abs(event.deltaX) > Math.abs(event.deltaY) && scrollsSideways(event.target, event.deltaX)});
    if (direction) go(direction);
  };
  target.addEventListener('wheel', onWheel, {passive: true});
  return () => target.removeEventListener('wheel', onWheel);
}
