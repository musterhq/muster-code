/**
 * The 3D device frame (#363, lazy chunk), built on the shared three-engine (#362): the live screen on the device's own
 * body, which you can turn. The body comes from the same frame spec as the flat view (bodies.ts ← shared/device-frames.ts),
 * so an iPhone has its island and side buttons, a Pixel its punch-hole and camera bar, a tablet its even bezels, and an
 * open foldable switches body when the emulator changes posture (its picture changes shape).
 *
 * Dragging the body or the background turns it (yaw only, with momentum; near the front it eases back, F or a
 * double-click faces it again); a press on the screen is a touch, mapped from the screen's texture coordinate back to
 * the device's pixel (engine.pick + uvToPixel). Rendering is on demand: a new frame or an interaction, nothing else.
 * No WebGL falls back to the flat view.
 */
import React, {useEffect, useRef} from 'react';
import {Color, MeshBasicMaterial, SRGBColorSpace, type Mesh, type Object3D} from 'three';
import type {DeviceSession} from '../../../shared/device-protocol';
import {frameForPicture, type FrameSpec} from '../../../shared/device-frames';
import {isWindowActive, onWindowActivity} from '../../windowActivity';
import {useFeedPaint, type DeviceFeed} from '../../devices/deviceFeed';
import {buildBody, SCREEN_NAME} from '../../devices/bodies';
import {orientScreen} from './orientScreen';
import {frameOf, frameTurns} from './DeviceFrameFlat';
import {Engine, uvToPixel, type FrameTexture} from '../../three-engine';

const BODY: Record<FrameSpec['color'], number> = {dark: 0x1c1d20, titanium: 0x6a6761, light: 0xd7d5d0};
const bodyColors = (spec: FrameSpec) => {
  const body = new Color().setHex(BODY[spec.color], SRGBColorSpace);
  return {body, trim: body.clone().multiplyScalar(0.82), lens: new Color().setHex(0x0b0b0c, SRGBColorSpace), screenOff: new Color().setHex(0x000000, SRGBColorSpace)};
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
  const picture = feed?.width ? {width: feed.width, height: feed.height} : undefined;
  const spec = frameForPicture(frameOf(session), picture);
  // The picture in the other orientation than the device's natural one turns the body a quarter.
  const turned = frameTurns(spec, picture, session.screen?.orientation) % 2 === 1;
  const turnedRef = useRef(turned);
  turnedRef.current = turned;
  // The body is rebuilt only when the device's shape changes: another spec (a foldable's posture) or picture proportions.
  const naturalAspect = picture ? (turned ? picture.height / picture.width : picture.width / picture.height) : 0;
  const shapeKey = `${spec.id}:${naturalAspect.toFixed(3)}`;

  const applyOrientation = () => {
    if (!body.current || !screen.current) return;
    body.current.rotation.z = turnedRef.current ? Math.PI / 2 : 0;
    orientScreen(screen.current, turnedRef.current);
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
  const mount = (object: Object3D) => {
    const e = engine.current;
    if (!e) return;
    const found = object.getObjectByName(SCREEN_NAME) as Mesh | undefined;
    if (!found) return;
    screen.current = found;
    if (body.current) e.remove(body.current);
    body.current = object;
    e.add(object);
    streamSize.current = '';
    const target = ensureStream(), current = feedRef.current;
    if (target && current?.width) target.update(current.canvas);
    applyOrientation();
    e.frame(object, {preset: 'front', padding: 0.86});
  };

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let created: Engine;
    try {
      created = new Engine({container: el, lighting: 'soft', fov: 30, label: `${session.name} in 3D. Drag to turn it, press F or double-click to face it, click the screen to tap.`,
        orbit: {limits: {lockPolar: Math.PI / 2, minRadius: 1.5, maxRadius: 14, minPolar: 0.05, maxPolar: 3.09}, snap: {azimuth: 0, polar: Math.PI / 2, autoSnapWithin: 0.7, tau: 0.09}},
        activity: {active: isWindowActive, subscribe: onWindowActivity},
        // A press on the live screen is a touch for the device, never a camera drag.
        dragFilter: event => !screen.current || !created.pick(event.clientX, event.clientY, screen.current)});
    } catch { onFallback(); return; }
    engine.current = created;
    return () => { stream.current = null; streamSize.current = ''; created.dispose(); engine.current = null; screen.current = null; body.current = null; };
  }, [session.deviceId]);
  useEffect(() => {
    if (!engine.current) return;
    const current = feedRef.current;
    mount(buildBody(spec, current?.width ? (turned ? {width: current.height, height: current.width} : {width: current.width, height: current.height}) : undefined, bodyColors(spec)));
  }, [session.deviceId, shapeKey]);

  // A new picture: hand the feed canvas to the frame texture (the engine renders once), outside React.
  useFeedPaint(feed, current => { ensureStream()?.update(current.canvas); });
  useEffect(() => { applyOrientation(); }, [turned]);

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
    onDoubleClick={event => { if (!touchAt(event)) engine.current?.snapToFront(); }} data-frame={spec.id}>
  </div>;
}
