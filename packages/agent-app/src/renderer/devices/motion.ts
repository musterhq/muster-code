/**
 * Turning the 3D device (#363): drag rotates it, a release keeps the throw's momentum, and near the front it springs
 * back to face the user. Pure state and steps (no DOM, no three), so the tests drive it frame by frame; the viewer
 * runs animation frames only while `settled()` is false.
 *
 * The drag gain (0.006 rad per CSS px) and velocity cap (7.5 rad/s) follow T3 Code's measurements of comparable
 * viewers (pingdotgg/t3code#12787, MIT); the spring and friction constants are ours.
 */
export interface Motion {yaw: number; pitch: number; vyaw: number; vpitch: number}
export const MOTION = {gain: 0.006, maxSpeed: 7.5, friction: 4.2, snapWithin: 0.65, stiffness: 38, damping: 11, maxPitch: 0.9, maxYaw: Math.PI * 0.95, rest: 0.0015};
export const atRest = (): Motion => ({yaw: 0, pitch: 0, vyaw: 0, vpitch: 0});
const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));

/** A pointer moved by (dx, dy) CSS pixels while dragging. */
export function drag(m: Motion, dx: number, dy: number): Motion {
  return {...m, yaw: clamp(m.yaw + dx * MOTION.gain, MOTION.maxYaw), pitch: clamp(m.pitch + dy * MOTION.gain, MOTION.maxPitch), vyaw: 0, vpitch: 0};
}
/** The drag ended with this pointer velocity (CSS px per second): the device keeps turning from it. */
export function release(m: Motion, vx: number, vy: number): Motion {
  return {...m, vyaw: clamp(vx * MOTION.gain, MOTION.maxSpeed), vpitch: clamp(vy * MOTION.gain, MOTION.maxSpeed)};
}
/** One step of `dt` seconds: momentum with friction; near the front, a spring brings it face-on. */
export function step(m: Motion, dt: number, reducedMotion = false): Motion {
  const t = Math.min(Math.max(dt, 0), 1 / 30);
  if (reducedMotion) return Math.abs(m.yaw) < MOTION.snapWithin && Math.abs(m.pitch) < MOTION.snapWithin ? atRest() : {...m, vyaw: 0, vpitch: 0};
  const near = Math.abs(m.yaw) < MOTION.snapWithin && Math.abs(m.pitch) < MOTION.snapWithin;
  let {yaw, pitch, vyaw, vpitch} = m;
  if (near) {
    vyaw += (-MOTION.stiffness * yaw - MOTION.damping * vyaw) * t;
    vpitch += (-MOTION.stiffness * pitch - MOTION.damping * vpitch) * t;
  } else {
    const decay = Math.exp(-MOTION.friction * t);
    vyaw *= decay; vpitch *= decay;
  }
  yaw = clamp(yaw + vyaw * t, MOTION.maxYaw); pitch = clamp(pitch + vpitch * t, MOTION.maxPitch);
  if (Math.abs(pitch) >= MOTION.maxPitch) vpitch = 0;
  return {yaw, pitch, vyaw, vpitch};
}
/** Nothing left to animate: at the front and still, or stopped somewhere the user left it. */
export function settled(m: Motion): boolean {
  const still = Math.abs(m.vyaw) < MOTION.rest * 20 && Math.abs(m.vpitch) < MOTION.rest * 20;
  const front = Math.abs(m.yaw) < MOTION.rest && Math.abs(m.pitch) < MOTION.rest;
  const near = Math.abs(m.yaw) < MOTION.snapWithin && Math.abs(m.pitch) < MOTION.snapWithin;
  return still && (front || !near);
}
/** Snap to the exact front once settled near it, so the screen renders pixel-aligned. */
export const finish = (m: Motion): Motion => Math.abs(m.yaw) < 0.01 && Math.abs(m.pitch) < 0.01 ? atRest() : {...m, vyaw: 0, vpitch: 0};
/** A screen hit's texture coordinate as a device touch point (texture v grows upwards, device y downwards). */
export const uvToDevice = (u: number, v: number): {x: number; y: number} => ({x: Math.min(1, Math.max(0, u)), y: Math.min(1, Math.max(0, 1 - v))});
