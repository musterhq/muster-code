/** Pure geometry and ordering for the computer-use / browser picture-in-picture cluster: drag clamping, corner
 * snapping, the spring that settles a released drag, and the z-order raise. No DOM, so the tests drive it directly. */
export type PipCorner = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
export interface PipRect {left: number; top: number; width: number; height: number}
export interface PipPoint {x: number; y: number}
export interface PipSize {width: number; height: number}
/** Keep this much clear of the window edge (and of the title bar at the top). */
export const PIP_MARGIN = 12, PIP_TOP_MARGIN = 44;

const finite = (value: number, fallback = 0) => (Number.isFinite(value) ? value : fallback);

/** Keeps a dragged cluster fully inside the bounds. A cluster larger than the bounds pins to the top-left margin. */
export function clampPipPosition(pos: PipPoint, size: PipSize, bounds: PipRect, margin = PIP_MARGIN, topMargin = PIP_TOP_MARGIN): PipPoint {
  const minX = bounds.left + margin, minY = bounds.top + Math.max(margin, topMargin);
  const maxX = Math.max(minX, bounds.left + bounds.width - margin - size.width), maxY = Math.max(minY, bounds.top + bounds.height - margin - size.height);
  return {x: Math.round(Math.min(maxX, Math.max(minX, finite(pos.x, minX)))), y: Math.round(Math.min(maxY, Math.max(minY, finite(pos.y, minY))))};
}
/** The top-left a cluster has when parked in a corner of the bounds. */
export function pipCornerOrigin(corner: PipCorner, size: PipSize, bounds: PipRect, margin = PIP_MARGIN, topMargin = PIP_TOP_MARGIN): PipPoint {
  const x = corner.endsWith('right') ? bounds.left + bounds.width - margin - size.width : bounds.left + margin;
  const y = corner.startsWith('bottom') ? bounds.top + bounds.height - margin - size.height : bounds.top + Math.max(margin, topMargin);
  return clampPipPosition({x, y}, size, bounds, margin, topMargin);
}
/** The corner whose parked position is closest to where the cluster was dropped. */
export function nearestPipCorner(pos: PipPoint, size: PipSize, bounds: PipRect): PipCorner {
  let best: PipCorner = 'top-right', bestDistance = Infinity;
  for (const corner of ['top-right', 'top-left', 'bottom-right', 'bottom-left'] as const) {
    const origin = pipCornerOrigin(corner, size, bounds), distance = (origin.x - pos.x) ** 2 + (origin.y - pos.y) ** 2;
    if (distance < bestDistance) { best = corner; bestDistance = distance; }
  }
  return best;
}
/** Where a released drag settles: clamped into the bounds, then snapped to the nearest corner. */
export function settlePipDrop(pos: PipPoint, size: PipSize, bounds: PipRect): {corner: PipCorner; target: PipPoint} {
  const clamped = clampPipPosition(pos, size, bounds), corner = nearestPipCorner(clamped, size, bounds);
  return {corner, target: pipCornerOrigin(corner, size, bounds)};
}

export interface SpringState {x: number; y: number; vx: number; vy: number}
export const SPRING = {stiffness: 260, damping: 26, restDistance: 0.4, restSpeed: 8};
/** One semi-implicit Euler step of a critically-damped-ish spring toward `target`; `dt` is in seconds and capped so a long frame cannot overshoot. */
export function springStep(state: SpringState, target: PipPoint, dt: number, spring = SPRING): SpringState {
  const step = Math.min(Math.max(finite(dt), 0), 1 / 30);
  const ax = spring.stiffness * (target.x - state.x) - spring.damping * state.vx, ay = spring.stiffness * (target.y - state.y) - spring.damping * state.vy;
  const vx = state.vx + ax * step, vy = state.vy + ay * step;
  return {x: state.x + vx * step, y: state.y + vy * step, vx, vy};
}
export const springSettled = (state: SpringState, target: PipPoint, spring = SPRING) =>
  Math.hypot(target.x - state.x, target.y - state.y) < spring.restDistance && Math.hypot(state.vx, state.vy) < spring.restSpeed;

/** A pointer movement under this many pixels is a click, not a drag. */
export const DRAG_THRESHOLD = 4;
export const exceedsDragThreshold = (from: PipPoint, to: PipPoint) => Math.hypot(to.x - from.x, to.y - from.y) >= DRAG_THRESHOLD;

/** `raised` lists session keys, most recently raised first. Those present come first, in that order; the rest keep their order. */
export function orderByRaise<T>(items: readonly T[], keyOf: (item: T) => string, raised: readonly string[]): T[] {
  const rank = new Map(raised.map((key, index) => [key, index] as const));
  const lifted = items.filter(item => rank.has(keyOf(item))).sort((a, b) => rank.get(keyOf(a))! - rank.get(keyOf(b))!);
  return [...lifted, ...items.filter(item => !rank.has(keyOf(item)))];
}
/** Raising a key moves it to the front of the list; the list stays bounded. */
export const raiseKey = (raised: readonly string[], key: string, max = 16): string[] => [key, ...raised.filter(item => item !== key)].slice(0, max);

/** Persisted corner (per window: sessionStorage first, so a second window keeps its own). */
const CORNER_KEY = 'muster.pipCorner';
const CORNERS: readonly string[] = ['top-right', 'top-left', 'bottom-right', 'bottom-left'];
export const parsePipCorner = (value: unknown): PipCorner | undefined => (typeof value === 'string' && CORNERS.includes(value) ? (value as PipCorner) : undefined);
export function loadPipCorner(): PipCorner | undefined {
  for (const storage of [typeof sessionStorage === 'undefined' ? undefined : sessionStorage, typeof localStorage === 'undefined' ? undefined : localStorage]) {
    try { const corner = parsePipCorner(storage?.getItem(CORNER_KEY)); if (corner) return corner; } catch {}
  }
  return undefined;
}
export function savePipCorner(corner: PipCorner): void {
  for (const storage of [typeof sessionStorage === 'undefined' ? undefined : sessionStorage, typeof localStorage === 'undefined' ? undefined : localStorage]) {
    try { storage?.setItem(CORNER_KEY, corner); } catch {}
  }
}
