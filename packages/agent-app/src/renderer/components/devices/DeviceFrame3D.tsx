/**
 * The 3D device frame (#363, lazy chunk), built on the shared three-engine (#362): the live screen on a device body you
 * can turn. Dragging the body or the background turns it (yaw only, with momentum; near the front it eases back, F or
 * a double-click faces it again); a press on the screen is a touch, mapped from the screen's texture coordinate back to
 * the device's pixel (engine.pick + uvToPixel). Rendering is on demand: a new frame or an interaction, nothing else.
 *
 * Bodies: Apple's own iPhone/iPad models when the user opted in (downloaded from apple.com and converted on this
 * computer, see appleModels.ts), otherwise Muster's own procedural bodies (bodies.ts). The flat view is always one click
 * away; no WebGL falls back to it, and a model that fails falls back to our own body with a quiet note.
 */
import React, {useEffect, useRef, useState} from 'react';
import {Color, MeshBasicMaterial, SRGBColorSpace, type Group, type Mesh, type Object3D} from 'three';
import type {DeviceSession, DeviceSetup} from '../../../shared/device-protocol';
import {invoke} from '../../bridge';
import {deviceUi} from '../../deviceSessions';
import {isWindowActive, onWindowActivity} from '../../windowActivity';
import {useFeedPaint, type DeviceFeed} from '../../devices/deviceFeed';
import {buildBody, SCREEN_NAME} from '../../devices/bodies';
import {orientScreen} from './orientScreen';
import {Engine, resolveCssColor, uvToPixel, type FrameTexture} from '../../three-engine';

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

const tokenColor = (name: string, fallback: [number, number, number]) => {
  const value = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement).getPropertyValue(name).trim() : '';
  const rgb = resolveCssColor(value) ?? fallback;
  return new Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, SRGBColorSpace);
};
const bodyColors = () => {
  const body = tokenColor('--device-body', [52, 54, 59]), ground = tokenColor('--bg-sunken', [12, 12, 12]);
  return {body, trim: body.clone().multiplyScalar(0.8), lens: ground, screenOff: ground};
};
export default function DeviceFrame3D({session, feed, onFallback}: {session: DeviceSession; feed?: DeviceFeed; onFallback(): void}): React.ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<Engine | null>(null);
  const screen = useRef<Mesh | null>(null);
  const body = useRef<Object3D | null>(null);
  const stream = useRef<FrameTexture | null>(null);
  const streamSize = useRef('');
  const feedRef = useRef(feed);
  feedRef.current = feed;
  const [note, setNote] = useState<string>();
  const landscape = !!feed?.width && feed.width > feed.height;
  const landscapeRef = useRef(landscape);
  landscapeRef.current = landscape;

  const applyOrientation = () => {
    if (!body.current || !screen.current) return;
    body.current.rotation.z = landscapeRef.current ? Math.PI / 2 : 0;
    orientScreen(screen.current, landscapeRef.current);
    engine.current?.invalidate();
  };
  // A fresh texture for a new picture size (WebGL keeps a texture's size once uploaded).
  const ensureStream = (): FrameTexture | null => {
    const e = engine.current, current = feedRef.current;
    if (!e || !current?.width) return stream.current;
    const size = `${current.width}x${current.height}`;
    if (!stream.current || streamSize.current !== size) {
      stream.current?.dispose();
      stream.current = e.createFrameTexture();
      streamSize.current = size;
      if (screen.current) screen.current.material = new MeshBasicMaterial({map: stream.current.texture, toneMapped: false});
    }
    return stream.current;
  };

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let live = true;
    let created: Engine;
    try {
      created = new Engine({container: el, lighting: 'soft', fov: 30, label: `${session.name} in 3D. Drag to turn it, press F or double-click to face it, click the screen to tap.`,
        orbit: {limits: {lockPolar: Math.PI / 2, minRadius: 1.5, maxRadius: 14, minPolar: 0.05, maxPolar: 3.09}, snap: {azimuth: 0, polar: Math.PI / 2, autoSnapWithin: 0.7, tau: 0.09}},
        activity: {active: isWindowActive, subscribe: onWindowActivity},
        // A press on the live screen is a touch for the device, never a camera drag.
        dragFilter: event => !screen.current || !created.pick(event.clientX, event.clientY, screen.current)});
    } catch { onFallback(); return; }
    engine.current = created;
    const mount = (object: Object3D) => {
      if (!live) return;
      const found = object.getObjectByName(SCREEN_NAME) as Mesh | undefined;
      if (!found) { setNote('This model has no screen; showing Muster’s own.'); return; }
      found.material = new MeshBasicMaterial({color: bodyColors().screenOff, toneMapped: false});
      screen.current = found;
      if (body.current) created.remove(body.current);
      body.current = object;
      created.add(object);
      streamSize.current = '';
      const target = ensureStream(), current = feedRef.current;
      if (target && current?.width) target.update(current.canvas);
      applyOrientation();
      created.frame(object, {preset: 'front', padding: 0.86});
    };
    const current = feedRef.current;
    const aspect = current?.width ? Math.min(current.width, current.height) / Math.max(current.width, current.height) : session.formFactor === 'tablet' ? 0.75 : 0.46;
    void appleModel(session, deviceUi().setup).then(model => {
      if (!live) return;
      if (model) mount(model);
      else {
        if (session.platform === 'ios' && deviceUi().setup?.appleModels) setNote('Apple’s model is not available right now; showing Muster’s own.');
        mount(buildBody(session.formFactor, aspect, bodyColors()));
      }
    });
    // Our own body follows the theme; Apple's keeps its own materials.
    const offTheme = created.onThemeChange(() => {
      if (!body.current?.name.startsWith('muster-')) return;
      const colors = bodyColors();
      body.current.traverse(node => { const material = (node as Mesh).material as {color?: Color; metalness?: number} | undefined; if (material?.color && material.metalness !== undefined && material.metalness > 0.4) material.color.copy(colors.body); });
      created.invalidate();
    });
    return () => { live = false; offTheme(); stream.current = null; streamSize.current = ''; created.dispose(); engine.current = null; screen.current = null; body.current = null; };
  }, [session.deviceId, session.formFactor]);

  // A new picture: hand the feed canvas to the frame texture (the engine renders once), outside React.
  useFeedPaint(feed, current => { ensureStream()?.update(current.canvas); });
  useEffect(() => { applyOrientation(); }, [landscape]);

  const pointer = useRef<{id: number; last: {x: number; y: number}} | null>(null);
  const touchAt = (event: {clientX: number; clientY: number}): {x: number; y: number} | null => {
    const e = engine.current, mesh = screen.current, size = stream.current?.size;
    if (!e || !mesh || !size) return null;
    const hit = e.pick(event.clientX, event.clientY, mesh);
    if (!hit?.uv) return null;
    const pixel = uvToPixel(hit.uv, size.width, size.height);
    return {x: (pixel.x + 0.5) / size.width, y: (pixel.y + 0.5) / size.height};
  };
  const send = (phase: 'begin' | 'move' | 'end', point: {x: number; y: number}) => window.musterDevices?.input(session.deviceId, {kind: 'touch', phase, ...point});
  return <div className="device-3d" ref={host}
    onPointerDown={event => {
      if (event.button !== 0) return;
      const point = touchAt(event);
      if (!point) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      pointer.current = {id: event.pointerId, last: point};
      send('begin', point);
    }}
    onPointerMove={event => { const p = pointer.current; if (!p || p.id !== event.pointerId) return; const point = touchAt(event); if (point) { p.last = point; send('move', point); } }}
    onPointerUp={event => { const p = pointer.current; if (!p || p.id !== event.pointerId) return; pointer.current = null; send('end', touchAt(event) ?? p.last); }}
    onPointerCancel={() => { pointer.current = null; }}
    onDoubleClick={event => { if (!touchAt(event)) engine.current?.snapToFront(); }}>
    {note && <span className="device-3d-note" role="status">{note}</span>}
  </div>;
}
