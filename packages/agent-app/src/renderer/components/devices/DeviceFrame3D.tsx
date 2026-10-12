/**
 * The 3D device frame (#363, lazy chunk with three.js): the live screen on a device body you can turn. Drag the body to
 * rotate it (it keeps the throw's momentum and springs back to face you near the front, double-click resets); touch
 * the screen to use the device, with every hit mapped from the screen texture back to device coordinates.
 *
 * Bodies: Apple's own iPhone/iPad models when the user opted in (downloaded from apple.com and converted on this
 * computer, see appleModels.ts), otherwise Muster's own procedural bodies (bodies.ts). The flat view is always one
 * click away, and anything 3D cannot do (no WebGL, a model that fails) falls back to it or to our own body quietly.
 */
import React, {useEffect, useRef, useState} from 'react';
import {CanvasTexture, Mesh, MeshBasicMaterial, Raycaster, SRGBColorSpace, Vector2, type Group, type Object3D} from 'three';
import type {DeviceSession, DeviceSetup} from '../../../shared/device-protocol';
import {invoke} from '../../bridge';
import {deviceUi} from '../../deviceSessions';
import {isWindowActive} from '../../windowActivity';
import type {DeviceFeed} from '../../devices/deviceFeed';
import {buildBody, SCREEN_NAME} from '../../devices/bodies';
import {atRest, drag, finish, release, settled, step, type Motion} from '../../devices/motion';
import {createStage, themeColors, type Stage} from '../../devices/stage';

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const modelCache = new Map<string, Promise<Uint8Array | null>>();

/** Apple's model for this simulator when the user opted in; null (use our own body) on any failure. */
async function appleModel(session: DeviceSession, known: DeviceSetup | undefined): Promise<Group | null> {
  if (session.platform !== 'ios' || session.formFactor === 'foldable') return null;
  const setup = known ?? await invoke('devices.setup', undefined).catch(() => undefined);
  if (!setup?.appleModels) return null;
  const id = session.formFactor === 'tablet' ? 'ipad' : 'iphone';
  let pending = modelCache.get(id);
  if (!pending) {
    pending = (async () => {
      const result = await invoke('devices.model', {id});
      if (result.glb) return result.glb;
      if (!result.usdz) return null;
      const {convertAppleModel} = await import('../../devices/appleModels');
      const glb = new Uint8Array(await convertAppleModel(result.usdz, result.bodyNode, result.screenNode));
      await invoke('devices.modelStore', {id, glb});
      return glb;
    })().catch(error => { console.warn(`Apple ${id} model unavailable, using Muster's own body:`, error instanceof Error ? error.message : error); return null; });
    modelCache.set(id, pending);
    void pending.then(value => { if (!value) modelCache.delete(id); });
  }
  const glb = await pending;
  if (!glb) return null;
  const {loadDeviceGlb} = await import('../../devices/appleModels');
  return loadDeviceGlb(glb).catch(() => null);
}

export default function DeviceFrame3D({session, feed, tick, onFallback}: {session: DeviceSession; feed?: DeviceFeed; tick: number; onFallback(): void}): React.ReactElement {
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<Stage | null>(null);
  const screen = useRef<Mesh | null>(null);
  const texture = useRef<CanvasTexture | null>(null);
  const motion = useRef<Motion>(atRest());
  const body = useRef<Object3D | null>(null);
  const [note, setNote] = useState<string>();
  const portrait = !feed?.width || feed.height >= feed.width;
  const portraitRef = useRef(portrait);
  portraitRef.current = portrait;

  // Stage and body: built once per device; rebuilt when the picture turns between portrait and landscape.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    let live = true, created: Stage;
    try { created = createStage(el); } catch { onFallback(); return; }
    stage.current = created;
    const tex = new CanvasTexture(feed?.canvas ?? document.createElement('canvas'));
    tex.colorSpace = SRGBColorSpace; tex.center.set(0.5, 0.5);
    texture.current = tex;
    const mount = (object: Object3D) => {
      if (!live) return;
      const found = object.getObjectByName(SCREEN_NAME) as Mesh | undefined;
      if (!found) { setNote('This model has no screen; showing Muster’s own.'); return; }
      found.material = new MeshBasicMaterial({map: texture.current ?? tex, toneMapped: false});
      screen.current = found;
      if (body.current) created.scene.remove(body.current);
      body.current = object;
      created.scene.add(object);
      created.fit(object);
      created.requestRender();
    };
    const aspect = feed?.width ? Math.min(feed.width, feed.height) / Math.max(feed.width, feed.height) : session.formFactor === 'tablet' ? 0.75 : 0.46;
    const own = () => buildBody(session.formFactor, aspect, {...themeColors(), trim: themeColors().body.clone().multiplyScalar(0.8), lens: themeColors().ground, screenOff: themeColors().ground});
    void appleModel(session, deviceUi().setup).then(model => {
      if (!live) return;
      if (model) mount(model);
      else {
        if (session.platform === 'ios' && deviceUi().setup?.appleModels) setNote('Apple’s model is not available right now; showing Muster’s own.');
        mount(own());
      }
    });
    created.setBeforeRender(dt => {
      if (!body.current) return false;
      // Never animate in a window nobody is looking at; settle at once instead.
      const active = isWindowActive();
      motion.current = active ? step(motion.current, dt, reducedMotion()) : finish(motion.current);
      const done = settled(motion.current) || !active;
      if (done) motion.current = finish(motion.current);
      // A landscape picture lies on a portrait body: turn the body a quarter.
      body.current.rotation.set(motion.current.pitch, motion.current.yaw, portraitRef.current ? 0 : Math.PI / 2);
      return !done;
    });
    return () => { live = false; created.dispose(); stage.current = null; screen.current = null; texture.current = null; body.current = null; };
  }, [session.deviceId, session.formFactor]);

  // A new picture: point the texture at the feed canvas and draw once.
  useEffect(() => {
    let tex = texture.current;
    if (!tex || !feed?.width) return;
    // WebGL keeps a texture's size once uploaded: a new source or a new size (rotation) gets a fresh texture.
    const size = `${feed.width}x${feed.height}`;
    if (tex.image !== feed.canvas || tex.userData.size !== size) {
      const next = new CanvasTexture(feed.canvas);
      next.colorSpace = SRGBColorSpace; next.center.set(0.5, 0.5); next.userData.size = size;
      const material = screen.current?.material as MeshBasicMaterial | undefined;
      if (material) { material.map = next; material.needsUpdate = true; }
      tex.dispose();
      texture.current = tex = next;
    }
    tex.rotation = portrait ? 0 : -Math.PI / 2;
    tex.needsUpdate = true;
    stage.current?.requestRender();
  }, [tick, feed, portrait]);

  // Pointer: on the screen it is a touch, elsewhere it turns the device.
  const pointer = useRef<{id: number; mode: 'touch' | 'turn'; x: number; y: number; t: number; vx: number; vy: number} | null>(null);
  const raycaster = useRef(new Raycaster());
  const hit = (event: React.PointerEvent): {x: number; y: number} | null => {
    const s = stage.current, el = canvas.current, mesh = screen.current, tex = texture.current;
    if (!s || !el || !mesh || !tex) return null;
    const r = el.getBoundingClientRect();
    raycaster.current.setFromCamera(new Vector2(((event.clientX - r.left) / r.width) * 2 - 1, -((event.clientY - r.top) / r.height) * 2 + 1), s.camera);
    const found = raycaster.current.intersectObject(mesh, false)[0];
    if (!found?.uv) return null;
    // The texture's own transform (rotation for landscape, flipY) maps a screen point back into the picture.
    const uv = tex.transformUv(found.uv.clone());
    return {x: Math.min(1, Math.max(0, uv.x)), y: Math.min(1, Math.max(0, uv.y))};
  };
  const send = (phase: 'begin' | 'move' | 'end', point: {x: number; y: number}) => window.musterDevices?.input(session.deviceId, {kind: 'touch', phase, ...point});
  const last = useRef<{x: number; y: number} | null>(null);
  return <div className="device-3d" data-note={note ? 'true' : undefined}>
    <canvas ref={canvas} className="device-3d-canvas" tabIndex={0} role="img" aria-label={`${session.name} in 3D. Drag the body to turn it, click the screen to tap, double-click to face it again.`}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const point = hit(event);
        pointer.current = {id: event.pointerId, mode: point ? 'touch' : 'turn', x: event.clientX, y: event.clientY, t: performance.now(), vx: 0, vy: 0};
        if (point) { last.current = point; send('begin', point); }
      }}
      onPointerMove={event => {
        const p = pointer.current;
        if (!p || p.id !== event.pointerId) return;
        if (p.mode === 'touch') { const point = hit(event); if (point) { last.current = point; send('move', point); } return; }
        const now = performance.now(), dt = Math.max(1, now - p.t), dx = event.clientX - p.x, dy = event.clientY - p.y;
        p.vx = dx / dt * 1000; p.vy = dy / dt * 1000; p.x = event.clientX; p.y = event.clientY; p.t = now;
        motion.current = drag(motion.current, dx, dy);
        stage.current?.requestRender();
      }}
      onPointerUp={event => {
        const p = pointer.current;
        if (!p || p.id !== event.pointerId) return;
        pointer.current = null;
        if (p.mode === 'touch') { send('end', hit(event) ?? last.current ?? {x: 0.5, y: 0.5}); return; }
        motion.current = release(motion.current, p.vx, p.vy);
        stage.current?.requestRender();
      }}
      onPointerCancel={() => { pointer.current = null; }}
      onDoubleClick={event => { if (!hit(event as unknown as React.PointerEvent)) { motion.current = {...motion.current, vyaw: -motion.current.yaw * 4, vpitch: -motion.current.pitch * 4}; motion.current = {...motion.current, yaw: Math.sign(motion.current.yaw) * Math.min(Math.abs(motion.current.yaw), 0.6), pitch: Math.sign(motion.current.pitch) * Math.min(Math.abs(motion.current.pitch), 0.6)}; stage.current?.requestRender(); } }}/>
    {note && <span className="device-3d-note" role="status">{note}</span>}
  </div>;
}
