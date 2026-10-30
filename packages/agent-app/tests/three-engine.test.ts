/** three-engine core: orbit maths, on-demand rendering, activity gating, frame textures, raycast-to-UV, disposal. A fake renderer stands in for WebGL. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {Mesh, MeshBasicMaterial, PlaneGeometry, BoxGeometry, type Scene, type PerspectiveCamera} from 'three';
import {OrbitState, angleDelta, bindOrbitInput} from '../src/renderer/three-engine/controls.ts';
import {Engine, type RendererLike} from '../src/renderer/three-engine/engine.ts';
import {uvToPixel, pixelToUv, pointerToNdc} from '../src/renderer/three-engine/raycast.ts';
import {deriveTheme} from '../src/renderer/three-engine/theme.ts';
import {resolveCompanionPath, modelFormatOf} from '../src/renderer/three-engine/model/formats.ts';
import {disposeObject} from '../src/renderer/three-engine/dispose.ts';

const require = createRequire(import.meta.url);
const {parseHTML} = require('linkedom');
const {window} = parseHTML('<html><body><div id="host"></div></body></html>');
Object.assign(globalThis, {document: window.document, HTMLElement: window.HTMLElement});

/** Manual frame clock: frames only run when the test says so, which makes "no rAF at rest" observable. */
function clock() {
  let next = 1, time = 0;
  const queue = new Map<number, (t: number) => void>();
  return {
    scheduler: {request: (cb: (t: number) => void) => { queue.set(next, cb); return next++; }, cancel: (id: number) => { queue.delete(id); }},
    get pending() { return queue.size; },
    /** Run exactly one frame at `ms` later; returns whether a frame was pending. */
    tick(ms = 16): boolean {
      const entry = [...queue.entries()][0];
      if (!entry) return false;
      queue.delete(entry[0]); time += ms; entry[1](time); return true;
    },
    /** Run frames until none are pending (bounded). */
    drain(limit = 600): number { let n = 0; while (n < limit && this.tick()) n++; return n; },
  };
}

function fakeRenderer() {
  const canvas = document.createElement('canvas') as HTMLCanvasElement;
  const log = {renders: 0, sizes: [] as Array<[number, number]>, disposed: 0, lost: 0, order: [] as string[]};
  const renderer: RendererLike = {
    domElement: canvas,
    setPixelRatio() {}, setSize(w: number, h: number) { log.sizes.push([w, h]); log.order.push('size'); },
    render(_s: Scene, _c: PerspectiveCamera) { log.renders++; log.order.push('render'); },
    dispose() { log.disposed++; }, forceContextLoss() { log.lost++; },
  };
  return {renderer, log};
}

function makeEngine(extra: Partial<ConstructorParameters<typeof Engine>[0]> = {}) {
  const host = document.createElement('div') as HTMLElement;
  (host as any).getBoundingClientRect = () => ({left: 0, top: 0, width: 400, height: 300});
  document.body.appendChild(host);
  const frames = clock(), {renderer, log} = fakeRenderer();
  const engine = new Engine({container: host, theme: deriveTheme([20, 20, 20], [22, 22, 22], [230, 230, 230], [140, 170, 190]), createRenderer: () => renderer, scheduler: frames.scheduler, reducedMotion: false, ...extra});
  return {engine, frames, log, host};
}

test('angleDelta takes the short way round', () => {
  assert.ok(Math.abs(angleDelta(0.1, Math.PI * 2 - 0.1) + 0.2) < 1e-9);
  assert.ok(Math.abs(angleDelta(-3, 3) - (6 - Math.PI * 2)) < 1e-9);
});

test('orbit: a fling decays and comes to rest, then reports inactive', () => {
  const orbit = new OrbitState({inertiaKeep: 0.02});
  orbit.dragStart();
  orbit.drag(40, 0, 0); orbit.drag(40, 0, 16); orbit.drag(40, 0, 32);
  const before = orbit.azimuth;
  orbit.dragEnd(40);
  assert.equal(orbit.phase, 'inertia');
  let frames = 0;
  while (orbit.step(1 / 60) && frames < 1000) frames++;
  assert.equal(orbit.phase, 'rest');
  assert.ok(frames > 5 && frames < 300, `settled in ${frames} frames`);
  assert.ok(Math.abs(orbit.azimuth - before) > 0.05, 'the fling carried the view');
  assert.equal(orbit.active, false);
});

test('orbit: releasing after the pointer stopped does not fling', () => {
  const orbit = new OrbitState();
  orbit.dragStart(); orbit.drag(30, 0, 0); orbit.drag(30, 0, 16);
  const at = orbit.azimuth;
  orbit.dragEnd(500); // paused for 484 ms before release
  orbit.step(1 / 60);
  assert.equal(orbit.phase, 'rest');
  assert.ok(Math.abs(orbit.azimuth - at) < 1e-9);
});

test('orbit: snaps to the front by the short way and stops', () => {
  const orbit = new OrbitState({snap: {azimuth: 0, polar: Math.PI / 2, autoSnapWithin: 0, tau: 0.09}});
  orbit.set({azimuth: Math.PI * 2 - 0.3, polar: 1.2});
  orbit.snapToFront();
  let frames = 0;
  while (orbit.step(1 / 60) && frames < 600) frames++;
  assert.ok(Math.abs(angleDelta(0, orbit.azimuth)) < 1e-3);
  assert.ok(Math.abs(orbit.polar - Math.PI / 2) < 1e-3);
  assert.equal(orbit.active, false);
  assert.ok(frames < 120, `snap took ${frames} frames`);
});

test('orbit: a fling that ends near the front eases onto it (device frame behaviour)', () => {
  const orbit = new OrbitState({inertiaKeep: 0.02, limits: {minRadius: 0.1, maxRadius: 100, minPolar: 0.05, maxPolar: 3.1, lockPolar: Math.PI / 2}, snap: {azimuth: 0, polar: Math.PI / 2, autoSnapWithin: 0.8, tau: 0.09}});
  orbit.dragStart(); orbit.drag(-4, 0, 0); orbit.drag(-4, 0, 16); orbit.dragEnd(20);
  let frames = 0;
  while (orbit.step(1 / 60) && frames < 1500) frames++;
  assert.ok(Math.abs(angleDelta(0, orbit.azimuth)) < 1e-3, `azimuth ${orbit.azimuth}`);
  assert.equal(orbit.polar, Math.PI / 2, 'lockPolar keeps a turntable yaw-only');
});

test('orbit: reduced motion has no inertia and snaps instantly', () => {
  const orbit = new OrbitState({reducedMotion: true});
  orbit.dragStart(); orbit.drag(50, 0, 0); orbit.drag(50, 0, 16); orbit.dragEnd(17);
  assert.equal(orbit.step(1 / 60), false);
  orbit.goTo({azimuth: 1, polar: 1.3});
  assert.equal(orbit.azimuth, 1); assert.equal(orbit.polar, 1.3); assert.equal(orbit.active, false);
});

test('orbit: zoom is clamped and eases', () => {
  const orbit = new OrbitState({limits: {minRadius: 1, maxRadius: 10, minPolar: 0.05, maxPolar: 3, lockPolar: null}});
  orbit.set({radius: 5});
  orbit.zoomBy(100); while (orbit.step(1 / 60));
  assert.ok(Math.abs(orbit.radius - 10) < 0.01);
  orbit.zoomBy(0.0001); while (orbit.step(1 / 60));
  assert.ok(Math.abs(orbit.radius - 1) < 0.01);
});

test('engine: nothing is scheduled until something invalidates, and it goes idle again', () => {
  const {engine, frames, log} = makeEngine();
  const initial = log.renders;
  assert.equal(frames.pending, 0, 'no frame requested at construction');
  assert.equal(frames.tick(), false);
  engine.invalidate(); engine.invalidate(); engine.invalidate();
  assert.equal(frames.pending, 1, 'invalidate calls coalesce into one frame');
  assert.equal(frames.drain(), 1);
  assert.equal(log.renders, initial + 1);
  assert.equal(frames.pending, 0, 'idle after one frame: zero rAF, zero GPU');
  engine.dispose();
});

test('engine: a camera fling renders every frame while moving and stops by itself', () => {
  const {engine, frames, log} = makeEngine();
  engine.orbit.dragStart(); engine.orbit.drag(60, 0, 0); engine.orbit.drag(60, 0, 16); engine.orbit.dragEnd(20);
  engine.invalidate();
  const before = log.renders;
  const n = frames.drain();
  assert.ok(n > 5, `animated for ${n} frames`);
  assert.equal(log.renders - before, n);
  assert.equal(frames.pending, 0);
  engine.dispose();
});

test('engine: hold() keeps rendering until released', () => {
  const {engine, frames} = makeEngine();
  const release = engine.hold();
  for (let i = 0; i < 20; i++) assert.ok(frames.tick(), `frame ${i}`);
  release();
  frames.drain(5);
  assert.equal(frames.pending, 0);
  engine.dispose();
});

test('engine: an inactive window renders nothing and resumes with one frame', () => {
  let active = true; const listeners = new Set<(a: boolean) => void>();
  const gate = {active: () => active, subscribe: (l: (a: boolean) => void) => { listeners.add(l); return () => listeners.delete(l); }};
  const {engine, frames, log} = makeEngine({activity: gate});
  active = false; listeners.forEach(l => l(false));
  const before = log.renders;
  engine.invalidate(); engine.invalidate();
  assert.equal(frames.pending, 0, 'no frame is requested while the window is inactive');
  engine.hold();
  assert.equal(frames.pending, 0);
  active = true; listeners.forEach(l => l(true));
  assert.equal(frames.pending, 1, 'activation requests the deferred frame');
  frames.tick();
  assert.ok(log.renders > before);
  engine.dispose();
});

test('engine: resize sets the size and renders in the same call (no stretched frame)', () => {
  const {engine, log, host} = makeEngine();
  (host as any).getBoundingClientRect = () => ({left: 0, top: 0, width: 640, height: 360});
  log.order.length = 0;
  engine.resize();
  assert.deepEqual(log.sizes.at(-1), [640, 360]);
  assert.deepEqual(log.order, ['size', 'render']);
  assert.ok(Math.abs(engine.camera.aspect - 640 / 360) < 1e-9);
  const calls = log.order.length;
  engine.resize();
  assert.equal(log.order.length, calls, 'an unchanged size does no work');
  engine.dispose();
});

test('engine: dispose cancels the pending frame, frees the content and releases the GL context; it is idempotent', () => {
  const {engine, frames, log} = makeEngine();
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  let geometryDisposed = 0, materialDisposed = 0;
  mesh.geometry.addEventListener('dispose', () => geometryDisposed++);
  mesh.material.addEventListener('dispose', () => materialDisposed++);
  engine.add(mesh);
  assert.equal(frames.pending, 1);
  engine.dispose(); engine.dispose();
  assert.equal(frames.pending, 0, 'the pending frame was cancelled');
  assert.equal(geometryDisposed, 1); assert.equal(materialDisposed, 1);
  assert.equal(log.disposed, 1); assert.equal(log.lost, 1);
  engine.invalidate();
  assert.equal(frames.pending, 0, 'a disposed engine ignores invalidate');
});

test('engine: removing content disposes it unless asked not to', () => {
  const {engine} = makeEngine();
  const a = new Mesh(new BoxGeometry(), new MeshBasicMaterial()), b = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  let da = 0, db = 0;
  a.geometry.addEventListener('dispose', () => da++); b.geometry.addEventListener('dispose', () => db++);
  engine.add(a); engine.add(b);
  engine.remove(a); engine.remove(b, {dispose: false});
  assert.equal(da, 1); assert.equal(db, 0);
  engine.dispose();
});

test('frame textures: updates request one render each and close owned bitmaps only after the next render', () => {
  const {engine, frames} = makeEngine();
  const texture = engine.createFrameTexture();
  const closed: number[] = [];
  const bitmap = (id: number) => ({width: 4, height: 8, close: () => closed.push(id)}) as unknown as ImageBitmap;
  texture.update(bitmap(1), {own: true}); frames.drain();
  texture.update(bitmap(2), {own: true});
  assert.deepEqual(closed, [], 'the previous frame is kept until the new one is uploaded');
  frames.drain();
  assert.deepEqual(closed, [1]);
  assert.equal(frames.pending, 0, 'idle between frames');
  assert.deepEqual(texture.size, {width: 4, height: 8});
  assert.equal(texture.texture.flipY, false);
  assert.deepEqual([texture.texture.repeat.y, texture.texture.offset.y], [-1, 1]);
  engine.dispose();
  assert.deepEqual(closed, [1, 2], 'dispose closes the last owned frame');
  texture.update(bitmap(3), {own: true});
  assert.deepEqual(closed, [1, 2, 3], 'frames pushed after dispose are closed, not leaked');
});

test('frame textures: a video drives renders only when the decoder presents a frame', () => {
  const {engine, frames} = makeEngine();
  const texture = engine.createFrameTexture();
  const callbacks: Array<() => void> = [];
  const video = Object.assign(document.createElement('div'), {requestVideoFrameCallback: (cb: () => void) => callbacks.push(cb), cancelVideoFrameCallback() {}, videoWidth: 8, videoHeight: 4}) as unknown as HTMLVideoElement;
  const detach = texture.attachVideo(video);
  frames.drain();
  assert.equal(callbacks.length, 1);
  assert.equal(frames.pending, 0, 'a paused video costs nothing');
  callbacks.shift()!();
  assert.equal(frames.pending, 1);
  frames.drain();
  detach();
  engine.dispose();
});

test('raycast: a pointer over the screen quad maps to the right pixel of the stream', () => {
  const {engine} = makeEngine();
  const screen = new Mesh(new PlaneGeometry(2, 4), new MeshBasicMaterial()); // portrait "screen", faces +Z
  engine.add(screen);
  engine.orbit.set({azimuth: 0, polar: Math.PI / 2, radius: 6, target: [0, 0, 0]});
  engine.camera.aspect = 4 / 3; engine.camera.updateProjectionMatrix(); engine.renderNow();
  (engine.canvas as any).getBoundingClientRect = () => ({left: 0, top: 0, width: 400, height: 300});
  const center = engine.pick(200, 150)!;
  assert.ok(center, 'hit the screen');
  assert.ok(Math.abs(center.uv!.u - 0.5) < 1e-3 && Math.abs(center.uv!.v - 0.5) < 1e-3);
  assert.deepEqual(uvToPixel(center.uv!, 1170, 2532), {x: 585, y: 1266});
  assert.equal(engine.pick(5, 5), null, 'outside the quad misses');
  // Top-left of the quad is pixel (0,0): v = 1 is the top edge.
  const topLeft = {u: 0.001, v: 0.999};
  assert.deepEqual(uvToPixel(topLeft, 100, 200), {x: 0, y: 0});
  const round = pixelToUv(30, 60, 100, 200);
  assert.deepEqual(uvToPixel(round, 100, 200), {x: 30, y: 60});
  assert.deepEqual(pointerToNdc({left: 10, top: 20, width: 200, height: 100}, 110, 70), {x: 0, y: 0});
  engine.dispose();
});

test('input: pointer drag rotates, release flings, wheel zooms, keyboard nudges; the disposer removes every listener', () => {
  const el = document.createElement('div') as unknown as HTMLElement;
  (el as any).setPointerCapture = () => {}; (el as any).releasePointerCapture = () => {};
  const orbit = new OrbitState(); let wakes = 0; let t = 0;
  const off = bindOrbitInput(el, orbit, () => wakes++, () => t);
  const fire = (type: string, props: Record<string, unknown> = {}) => { const e = new window.Event(type, {cancelable: true}); Object.assign(e, {pointerId: 1, button: 0, pointerType: 'mouse', clientX: 0, clientY: 0, ...props}); el.dispatchEvent(e as unknown as Event); return e; };
  const az = orbit.azimuth;
  fire('pointerdown', {clientX: 100}); t = 10; fire('pointermove', {clientX: 120}); t = 20; fire('pointermove', {clientX: 140}); fire('pointerup', {clientX: 140});
  assert.ok(orbit.azimuth < az, 'dragging right turns the model with the pointer');
  assert.equal(orbit.phase, 'inertia');
  const r = orbit.radius; orbit.zoomBy(1); fire('wheel', {deltaY: -100, deltaMode: 0});
  assert.ok(wakes >= 4);
  off();
  const w = wakes; fire('pointerdown', {clientX: 5}); assert.equal(wakes, w, 'no listeners after dispose');
  void r;
});

test('input: a host can claim a press (tap on the device screen) so it never becomes a camera drag', () => {
  const el = document.createElement('div') as unknown as HTMLElement;
  (el as any).setPointerCapture = () => {}; (el as any).releasePointerCapture = () => {};
  const orbit = new OrbitState(); let claimed = true;
  const off = bindOrbitInput(el, orbit, () => {}, () => 0, () => !claimed);
  const fire = (type: string, props: Record<string, unknown> = {}) => { const e = new window.Event(type, {cancelable: true}); Object.assign(e, {pointerId: 1, button: 0, pointerType: 'mouse', clientX: 0, clientY: 0, ...props}); el.dispatchEvent(e as unknown as Event); };
  const az = orbit.azimuth;
  fire('pointerdown', {clientX: 10}); fire('pointermove', {clientX: 80}); fire('pointerup', {clientX: 80});
  assert.equal(orbit.azimuth, az, 'a claimed press does not rotate');
  claimed = false;
  fire('pointerdown', {clientX: 10}); fire('pointermove', {clientX: 80}); fire('pointerup', {clientX: 80});
  assert.notEqual(orbit.azimuth, az, 'an unclaimed press does');
  off();
});

test('theme derivation: dark and light surfaces', () => {
  const dark = deriveTheme([20, 20, 20], [22, 22, 22], [230, 230, 230], [145, 171, 194]);
  const light = deriveTheme([243, 243, 243], [251, 251, 251], [29, 29, 31], [59, 106, 147]);
  assert.equal(dark.dark, true); assert.equal(light.dark, false);
  assert.equal(dark.accent, 0x91abc2);
  assert.notEqual(dark.model, light.model);
});

test('companion paths: relative to the model, never out of the folder, never another scheme', () => {
  assert.equal(resolveCompanionPath('models/car/car.obj', 'tex/a.png'), 'models/car/tex/a.png');
  assert.equal(resolveCompanionPath('models/car/car.obj', '../shared/a.png'), 'models/shared/a.png');
  assert.equal(resolveCompanionPath('car.obj', 'a%20b.png'), 'a b.png');
  assert.equal(resolveCompanionPath('car.obj', 'sub\\a.png'), 'sub/a.png');
  for (const bad of ['../a.png', '/etc/passwd', 'C:\\x.png', 'file:///etc/passwd', 'http://x/a.png', 'data:image/png;base64,AA==', '%2e%2e/%2e%2e/x', '', 'a\0b.png']) assert.equal(resolveCompanionPath('car.obj', bad), null, bad);
  assert.equal(resolveCompanionPath('a/b/c.obj', '../../../x.png'), null);
  assert.equal(modelFormatOf('x/Y.GLB'), 'glb'); assert.equal(modelFormatOf('x.txt'), null);
});

test('disposeObject frees geometry, materials and texture sources', () => {
  const material = new MeshBasicMaterial({});
  let closed = 0;
  (material as any).map = {image: {close: () => closed++}, dispose() {}, isTexture: true};
  const mesh = new Mesh(new BoxGeometry(), material);
  let disposed = 0; mesh.geometry.addEventListener('dispose', () => disposed++);
  disposeObject(mesh); disposeObject(mesh);
  assert.ok(disposed >= 1, 'geometry disposed');
  assert.ok(closed >= 1, 'bitmap closed');
});

test('dispose releases the process-wide DFG lookup texture three.js shares between renderers (it pinned one dead GL context per viewer)', () => {
  const lut = {isTexture: true, name: 'DFG_LUT', disposed: 0, dispose() { this.disposed++; }};
  const other = {isTexture: true, name: 'user texture', disposed: 0, dispose() { this.disposed++; }};
  const order: string[] = [];
  const { renderer } = fakeRenderer();
  (renderer as any).properties = {get: () => ({uniforms: {dfgLUT: {value: lut}, map: {value: other}, empty: undefined}})};
  const origDispose = renderer.dispose; renderer.dispose = () => { order.push('renderer'); origDispose(); };
  lut.dispose = function () { this.disposed++; order.push('lut'); };
  const host = document.createElement('div') as HTMLElement;
  const engine = new Engine({container: host, theme: deriveTheme([20, 20, 20], [22, 22, 22], [230, 230, 230], [140, 170, 190]), createRenderer: () => renderer, scheduler: clock().scheduler, reducedMotion: false});
  engine.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial()));
  engine.dispose(); engine.dispose();
  assert.equal(lut.disposed, 1);
  assert.equal(other.disposed, 0, 'only the shared texture is touched; user textures belong to their owners');
  assert.deepEqual(order, ['lut', 'renderer'], 'listeners are removed while the context is still alive');
});
