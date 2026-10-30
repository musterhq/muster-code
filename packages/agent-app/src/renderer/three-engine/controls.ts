/**
 * Orbit controls with inertia, snap-to-front and zero cost at rest.
 *
 * `OrbitState` is plain math (no DOM, no three.js objects), so it is unit-testable in Node and the engine
 * only has to call `step(dt)` while it reports `active`. When `step` returns false nothing is animating and the
 * engine stops its frame loop entirely.
 *
 * Spherical convention (matches three.js `Spherical`): `azimuth` rotates around +Y, `polar` is measured from +Y.
 * The camera sits at `target + radius * (sin(polar) sin(azimuth), cos(polar), sin(polar) cos(azimuth))`, so
 * azimuth 0 / polar PI/2 looks at the target from +Z: the "front" view of a model that faces +Z.
 */
import type {PerspectiveCamera} from 'three';

export interface OrbitLimits {
  minRadius: number; maxRadius: number;
  /** Polar clamp in radians, kept off the poles to avoid gimbal flips. Set both to 0 and PI to allow the poles. */
  minPolar: number; maxPolar: number;
  /** Fixed polar angle: yaw-only rotation (a phone on a turntable). Overrides vertical drag. */
  lockPolar: number | null;
}

export interface SnapOptions {
  /** The view that counts as "front". */
  azimuth: number; polar: number;
  /** After a drag or fling settles within this many radians of the front view, ease to it. 0 disables auto-snap. */
  autoSnapWithin: number;
  /** Time constant of the ease, seconds. */
  tau: number;
}

export interface OrbitOptions {
  /** Radians per CSS pixel of drag. */
  rotateSpeed: number;
  /** Fraction of angular velocity kept per second after release (0.03 = decays to 3% in 1s). */
  inertiaKeep: number;
  /** Dolly smoothing time constant, seconds. */
  zoomTau: number;
  /** Reduce motion: no inertia, no easing; snaps and zooms jump to their end state. */
  reducedMotion: boolean;
  limits: OrbitLimits;
  snap: SnapOptions;
}

export const DEFAULT_ORBIT: OrbitOptions = {
  rotateSpeed: 0.0095,
  inertiaKeep: 0.02,
  zoomTau: 0.08,
  reducedMotion: false,
  limits: {minRadius: 0.05, maxRadius: 1e6, minPolar: 0.05, maxPolar: Math.PI - 0.05, lockPolar: null},
  snap: {azimuth: 0, polar: Math.PI / 2, autoSnapWithin: 0, tau: 0.09},
};

const TAU = Math.PI * 2;
/** Shortest signed angular difference b - a, in (-PI, PI]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU; else if (d <= -Math.PI) d += TAU;
  return d;
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const REST_SPEED = 0.02;   // rad/s below which a fling is considered finished
const REST_ANGLE = 0.0004; // rad within which a snap is considered arrived
const REST_ZOOM = 0.0005;  // relative radius error considered arrived

export type OrbitPhase = 'rest' | 'dragging' | 'inertia' | 'snapping';

export class OrbitState {
  azimuth = 0; polar = Math.PI / 2; radius = 3;
  target: [number, number, number] = [0, 0, 0];
  readonly options: OrbitOptions;
  phase: OrbitPhase = 'rest';
  private vAz = 0; private vPol = 0;
  private lastMoveAt = -Infinity;
  private radiusGoal = 3;
  private snapGoal: {azimuth: number; polar: number} | null = null;
  private targetGoal: [number, number, number] | null = null;

  constructor(options: Partial<OrbitOptions> = {}) {
    this.options = {...DEFAULT_ORBIT, ...options, limits: {...DEFAULT_ORBIT.limits, ...options.limits}, snap: {...DEFAULT_ORBIT.snap, ...options.snap}};
  }

  /** True while step() has more to do; the engine keeps requesting frames only while this holds. */
  get active(): boolean { return this.phase !== 'rest' || Math.abs(this.radiusGoal - this.radius) > this.radius * REST_ZOOM || this.targetGoal !== null; }

  set(view: {azimuth?: number; polar?: number; radius?: number; target?: [number, number, number]}): void {
    if (view.azimuth !== undefined) this.azimuth = view.azimuth;
    if (view.polar !== undefined) this.polar = this.clampPolar(view.polar);
    if (view.radius !== undefined) this.radius = this.radiusGoal = clamp(view.radius, this.options.limits.minRadius, this.options.limits.maxRadius);
    if (view.target) this.target = [...view.target];
    this.vAz = this.vPol = 0; this.snapGoal = null; this.targetGoal = null; this.phase = 'rest';
  }

  private clampPolar(p: number): number {
    const {lockPolar, minPolar, maxPolar} = this.options.limits;
    return lockPolar !== null ? lockPolar : clamp(p, minPolar, maxPolar);
  }

  /** Pointer went down: any inertia or snap in flight is cancelled and the user is in control. */
  dragStart(): void { this.vAz = this.vPol = 0; this.snapGoal = null; this.phase = 'dragging'; this.lastMoveAt = -Infinity; }

  /** Drag by (dx, dy) CSS pixels at time `now` (ms). Velocity is smoothed over recent moves for the fling. */
  drag(dx: number, dy: number, now: number): void {
    if (this.phase !== 'dragging') this.dragStart();
    const {rotateSpeed} = this.options;
    const dAz = -dx * rotateSpeed, dPol = -dy * rotateSpeed;
    this.azimuth += dAz;
    this.polar = this.clampPolar(this.polar + dPol);
    const dt = Math.max(1, now - this.lastMoveAt) / 1000;
    if (Number.isFinite(this.lastMoveAt) && dt < 0.1) {
      const k = 0.45; // exponential blend: the last ~3 moves dominate
      this.vAz = this.vAz * (1 - k) + (dAz / dt) * k;
      this.vPol = this.vPol * (1 - k) + (dPol / dt) * k;
    } else { this.vAz = dAz / dt; this.vPol = dPol / dt; }
    if (this.options.limits.lockPolar !== null) this.vPol = 0;
    this.lastMoveAt = now;
  }

  /** Pointer released at `now` (ms). A pointer that stopped moving before release does not fling. */
  dragEnd(now: number): void {
    if (this.phase !== 'dragging') return;
    if (now - this.lastMoveAt > 90 || this.options.reducedMotion) { this.vAz = this.vPol = 0; }
    this.phase = 'inertia'; // step() settles to rest (or to the front snap) on its first call
  }

  /** Dolly by a multiplicative factor (wheel / pinch / keys). 1.1 zooms out 10%. */
  zoomBy(factor: number): void {
    this.radiusGoal = clamp(this.radiusGoal * factor, this.options.limits.minRadius, this.options.limits.maxRadius);
    if (this.options.reducedMotion) this.radius = this.radiusGoal;
  }

  /** Pan the target in the view plane by a fraction of the current view height. */
  pan(dxView: number, dyView: number): void {
    const [x, y, z] = this.target;
    const right: [number, number, number] = [Math.cos(this.azimuth), 0, -Math.sin(this.azimuth)];
    const upY = Math.sin(this.polar);
    const upDir: [number, number, number] = [-Math.cos(this.polar) * Math.sin(this.azimuth), upY, -Math.cos(this.polar) * Math.cos(this.azimuth)];
    const s = this.radius;
    this.target = [x + (right[0] * dxView + upDir[0] * dyView) * s, y + (right[1] * dxView + upDir[1] * dyView) * s, z + (right[2] * dxView + upDir[2] * dyView) * s];
  }

  /** Rotate by fixed radian steps (keyboard). */
  nudge(dAzimuth: number, dPolar: number): void {
    if (this.options.reducedMotion) { this.azimuth += dAzimuth; this.polar = this.clampPolar(this.polar + dPolar); return; }
    this.vAz = 0; this.vPol = 0;
    this.snapGoal = {azimuth: this.azimuth + dAzimuth, polar: this.clampPolar(this.polar + dPolar)};
    this.phase = 'snapping';
  }

  /** Ease to a view (a camera preset or the front). Reduced motion jumps. `radius` eases with the dolly. */
  goTo(view: {azimuth: number; polar: number; radius?: number; target?: [number, number, number]}): void {
    const polar = this.clampPolar(view.polar);
    if (view.radius !== undefined) this.radiusGoal = clamp(view.radius, this.options.limits.minRadius, this.options.limits.maxRadius);
    if (view.target) this.targetGoal = [...view.target];
    this.vAz = this.vPol = 0;
    if (this.options.reducedMotion) {
      this.azimuth = view.azimuth; this.polar = polar; this.radius = this.radiusGoal;
      if (this.targetGoal) { this.target = this.targetGoal; this.targetGoal = null; }
      this.snapGoal = null; this.phase = 'rest'; return;
    }
    // Take the short way round: re-base azimuth so the goal is within PI of the current value.
    this.snapGoal = {azimuth: this.azimuth + angleDelta(this.azimuth, view.azimuth), polar};
    this.phase = 'snapping';
  }

  /** Ease to the configured front view. */
  snapToFront(): void { this.goTo({azimuth: this.options.snap.azimuth, polar: this.options.snap.polar}); }

  /** Distance (radians) from the front view, azimuth and polar combined. */
  distanceFromFront(): number {
    const {azimuth, polar} = this.options.snap;
    return Math.hypot(angleDelta(azimuth, this.azimuth), this.options.limits.lockPolar !== null ? 0 : polar - this.polar);
  }

  /** Advance `dt` seconds. Returns true when another frame is needed. */
  step(dt: number): boolean {
    dt = clamp(dt, 0, 0.1);
    const o = this.options;
    if (this.phase === 'inertia') {
      const decay = Math.pow(o.inertiaKeep, dt);
      this.azimuth += this.vAz * dt; this.polar = this.clampPolar(this.polar + this.vPol * dt);
      this.vAz *= decay; this.vPol *= decay;
      if (this.polar <= o.limits.minPolar || this.polar >= o.limits.maxPolar) this.vPol = 0;
      if (Math.hypot(this.vAz, this.vPol) < REST_SPEED) {
        this.vAz = this.vPol = 0;
        if (o.snap.autoSnapWithin > 0 && this.distanceFromFront() <= o.snap.autoSnapWithin) this.snapToFront();
        else this.phase = 'rest';
      }
    } else if (this.phase === 'snapping' && this.snapGoal) {
      const a = 1 - Math.exp(-dt / Math.max(1e-3, o.snap.tau));
      const dAz = this.snapGoal.azimuth - this.azimuth, dPol = this.snapGoal.polar - this.polar;
      this.azimuth += dAz * a; this.polar += dPol * a;
      if (Math.abs(dAz) < REST_ANGLE && Math.abs(dPol) < REST_ANGLE) {
        this.azimuth = this.snapGoal.azimuth; this.polar = this.snapGoal.polar; this.snapGoal = null; this.phase = 'rest';
      }
    }
    // Keep azimuth bounded so long sessions never lose float precision; the front-snap shortest path is unaffected.
    if (this.phase === 'rest' && Math.abs(this.azimuth) > TAU) this.azimuth = angleDelta(0, this.azimuth);
    if (Math.abs(this.radiusGoal - this.radius) > this.radius * REST_ZOOM) {
      this.radius += (this.radiusGoal - this.radius) * (1 - Math.exp(-dt / Math.max(1e-3, o.zoomTau)));
    } else this.radius = this.radiusGoal;
    if (this.targetGoal) {
      const a = 1 - Math.exp(-dt / Math.max(1e-3, o.snap.tau));
      const t = this.target, g = this.targetGoal;
      const next: [number, number, number] = [t[0] + (g[0] - t[0]) * a, t[1] + (g[1] - t[1]) * a, t[2] + (g[2] - t[2]) * a];
      this.target = next;
      if (Math.hypot(g[0] - next[0], g[1] - next[1], g[2] - next[2]) < this.radius * 1e-4) { this.target = g; this.targetGoal = null; }
    }
    return this.active;
  }

  /** Write this view to a camera (position + lookAt). Does not touch projection. */
  applyTo(camera: Pick<PerspectiveCamera, 'position' | 'up' | 'lookAt' | 'updateMatrixWorld'>): void {
    const sp = Math.sin(this.polar);
    camera.position.set(
      this.target[0] + this.radius * sp * Math.sin(this.azimuth),
      this.target[1] + this.radius * Math.cos(this.polar),
      this.target[2] + this.radius * sp * Math.cos(this.azimuth),
    );
    camera.lookAt(this.target[0], this.target[1], this.target[2]);
  }
}

/** Hooks the DOM pointer / wheel / key events of `el` to an OrbitState. `shouldStart` can veto a press so the host handles it itself. Returns a disposer that removes every listener. */
export function bindOrbitInput(el: HTMLElement, orbit: OrbitState, wake: () => void, clock: () => number = () => performance.now(), shouldStart: (event: PointerEvent) => boolean = () => true): () => void {
  const pointers = new Map<number, {x: number; y: number}>();
  let mode: 'rotate' | 'pan' | 'pinch' | null = null;
  let pinchDistance = 0;
  const wasDragging = () => mode !== null;

  const down = (event: PointerEvent) => {
    // A host can claim a press (a tap on a device screen) before it becomes a camera drag. Second fingers of a pinch are never claimed.
    if (pointers.size === 0 && !shouldStart(event)) return;
    if (event.pointerType === 'mouse' && event.button !== 0 && event.button !== 2 && event.button !== 1) return;
    el.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, {x: event.clientX, y: event.clientY});
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDistance = Math.hypot(a.x - b.x, a.y - b.y); mode = 'pinch';
    } else {
      mode = event.button === 2 || event.button === 1 || event.shiftKey ? 'pan' : 'rotate';
      if (mode === 'rotate') orbit.dragStart();
    }
    wake();
  };
  const move = (event: PointerEvent) => {
    const prev = pointers.get(event.pointerId);
    if (!prev || !mode) return;
    const dx = event.clientX - prev.x, dy = event.clientY - prev.y;
    prev.x = event.clientX; prev.y = event.clientY;
    if (mode === 'rotate') orbit.drag(dx, dy, clock());
    else if (mode === 'pan') orbit.pan(-dx / Math.max(1, el.clientHeight), dy / Math.max(1, el.clientHeight));
    else if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDistance > 0 && d > 0) orbit.zoomBy(pinchDistance / d);
      pinchDistance = d;
    }
    wake();
  };
  const up = (event: PointerEvent) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    el.releasePointerCapture?.(event.pointerId);
    if (pointers.size === 0) {
      if (mode === 'rotate') orbit.dragEnd(clock());
      mode = null;
    } else if (pointers.size === 1) { mode = null; }
    wake();
  };
  const wheel = (event: WheelEvent) => {
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    orbit.zoomBy(Math.exp(event.deltaY * unit * 0.0015));
    wake();
  };
  const key = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const step = event.shiftKey ? 0.5 : 0.12;
    switch (event.key) {
      case 'ArrowLeft': orbit.nudge(-step, 0); break;
      case 'ArrowRight': orbit.nudge(step, 0); break;
      case 'ArrowUp': orbit.nudge(0, -step); break;
      case 'ArrowDown': orbit.nudge(0, step); break;
      case '+': case '=': orbit.zoomBy(0.85); break;
      case '-': case '_': orbit.zoomBy(1 / 0.85); break;
      case 'f': case 'F': orbit.snapToFront(); break;
      default: return;
    }
    event.preventDefault();
    wake();
  };
  const lost = () => { if (wasDragging()) { pointers.clear(); if (mode === 'rotate') orbit.dragEnd(clock()); mode = null; wake(); } };
  const noMenu = (event: Event) => event.preventDefault();

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', lost);
  el.addEventListener('wheel', wheel, {passive: false});
  el.addEventListener('keydown', key);
  el.addEventListener('contextmenu', noMenu);
  return () => {
    el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
    el.removeEventListener('lostpointercapture', lost); el.removeEventListener('wheel', wheel);
    el.removeEventListener('keydown', key); el.removeEventListener('contextmenu', noMenu);
    pointers.clear();
  };
}
