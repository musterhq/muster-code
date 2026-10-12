# three-engine

The one three.js runtime in Muster. Model preview uses it today; the 3D device frame (workstream C) builds on the same API.
Import it lazily (`await import('../three-engine')`, or through a `React.lazy` component) so three.js stays out of the initial bundle.

```
three-engine/
  engine.ts        Engine: scene, camera, lights, on-demand loop, resize, picking, screenshot, dispose
  controls.ts      OrbitState (pure maths: inertia, snap-to-front, zoom, pan) + bindOrbitInput (pointer, wheel, keyboard)
  frameTexture.ts  FrameTexture: a texture fed by pushed frames (ImageBitmap, canvas, <video>)
  raycast.ts       pointer -> NDC -> hit with uv; uvToPixel / pixelToUv
  theme.ts         scene colours from the app's CSS tokens
  lighting.ts      studio / soft / flat rigs (no environment map, no PMREM stall)
  cameraPresets.ts front, back, left, right, top, bottom, iso
  dispose.ts       disposeObject / disposeTexture (also closes ImageBitmaps)
  model/           loaders, worker, payload, incremental mount (model preview only; the engine does not depend on it)
```

## Contract

| Rule | How it holds |
|---|---|
| Zero GPU when idle | Nothing is scheduled until `invalidate()`. The loop continues only while the camera is moving (`OrbitState.active`), a `hold()` is open, or a before-render hook returns `true`. Then it stops: no rAF, no timer. Measured: 0 rAF callbacks and 0 renders in 4 s idle. |
| Inactive window | Pass `activity` (`{active(), subscribe(cb)}`, e.g. `windowActivity.ts`). While inactive nothing renders; the first active moment renders one deferred frame. |
| Reduced motion | `reducedMotion` defaults to the OS setting: no inertia, snaps and zooms jump. |
| Atomic resize | A `ResizeObserver` callback sets size, projection and renders synchronously, so a resize never paints a stretched frame. The canvas is `position:absolute; inset:0`, so it can never size its own container. |
| Theme | Colours are read from `--bg-sunken`, `--bg`, `--text`, `--accent` (resolved through a 2D canvas, so `color-mix()` works) and re-read when `<html>` theme attributes or the OS scheme change. `onThemeChange` lets content recolour. |
| Dispose | `dispose()` cancels the frame, unbinds input and observers, disposes every geometry, material and texture (and closes ImageBitmaps), releases three.js's process-wide DFG texture listener, calls `renderer.dispose()` and `forceContextLoss()`, and removes the canvas. Idempotent. Verified over 200 open/close cycles in Chrome (no retained contexts, 0 DOM or listener growth). |

## Engine

```ts
const engine = new Engine({
  container,                       // positioned element (the engine sets position:relative if it is static)
  lighting: 'studio',              // 'studio' | 'soft' | 'flat'
  fov: 38,
  orbit: {                         // OrbitOptions, all optional
    inertiaKeep: 0.02,             // share of angular velocity kept after 1 s
    limits: {lockPolar: Math.PI / 2, minRadius, maxRadius, minPolar, maxPolar},
    snap: {azimuth: 0, polar: Math.PI / 2, autoSnapWithin: 0.6, tau: 0.09},  // see Snap below
  },
  activity, reducedMotion, interactive: true, label: '3D model: cube.glb',
});
engine.add(object3D);              // adds under engine.content and invalidates
engine.remove(object3D);           // disposes it unless {dispose: false}
engine.frame(object3D, {padding, preset: 'iso', animate});   // or frameSphere(sphere, opts)
engine.setCameraPreset('front', {animate: true, refit: true});
engine.snapToFront();
engine.invalidate();               // request one render (coalesced)
const release = engine.hold();     // render every frame until release() (continuous animation)
engine.onBeforeRender(dt => needsAnotherFrame);   // return true while animating
engine.afterNextRender(() => {});  // textures are on the GPU by then
engine.pick(clientX, clientY);     // -> PickHit | null (see Input mapping)
await engine.screenshot('image/png');
engine.forEachMaterial(m => { m.wireframe = true; });
engine.stats; Engine.live;         // diagnostics (frames, draw calls, triangles, live engines)
engine.dispose();
```

`createRenderer` and `scheduler` can be injected; the unit tests drive the engine with a fake renderer and a manual frame clock.

## Controls: inertia and snap-to-front

`engine.orbit` is an `OrbitState` (pure maths, no DOM). Pointer drag rotates, wheel and pinch zoom, shift-drag or right-drag pans,
arrow keys orbit, `+`/`-` zoom, `F` returns to the front. Releasing a drag flings with exponential decay (`inertiaKeep`); a pointer that
stopped before release does not fling.

*Snap*: `orbit.snapToFront()` eases (time constant `snap.tau`) to `snap.azimuth/polar` by the short way round. With
`snap.autoSnapWithin > 0` a fling that comes to rest within that many radians of the front view eases onto it by itself.
`limits.lockPolar` makes rotation yaw-only (a phone on a turntable).

## Device frame recipe (workstream C)

```ts
const engine = new Engine({container, lighting: 'soft', orbit: {
  limits: {lockPolar: Math.PI / 2, minRadius: 2, maxRadius: 8, minPolar: 0.05, maxPolar: 3.09},
  snap: {azimuth: 0, polar: Math.PI / 2, autoSnapWithin: 0.7, tau: 0.09},
}});
engine.add(phoneBody);                       // your own CC0 / original body mesh
const stream = engine.createFrameTexture();  // disposed with the engine
screenMesh.material = new MeshBasicMaterial({map: stream.texture, toneMapped: false});
engine.add(screenMesh);
engine.frame(phoneBody, {preset: 'front'});

// every decoded frame from the device stream (JPEG -> ImageBitmap):
stream.update(await createImageBitmap(blob), {own: true});   // previous bitmap is closed after the next render
// or mirror a <video>: render only when the decoder presents a frame
const detach = stream.attachVideo(video);

// touch on the 3D screen -> device pixel
canvas.addEventListener('pointerup', e => {
  const hit = engine.pick(e.clientX, e.clientY, screenMesh);
  if (hit?.uv && stream.size) sendTap(uvToPixel(hit.uv, stream.size.width, stream.size.height));
});
```

Texture orientation is uniform for every source type: it is uploaded unflipped and the texture transform maps image row 0 to `v = 1`
(the top of a three.js plane), so `uvToPixel(uv, w, h)` is `x = floor(u*w)`, `y = floor((1-v)*h)`. A paused stream or hidden panel costs
nothing: frames only call `invalidate()`. Drag on the canvas rotates through the same input binding; if the device screen needs raw
touches, pass `dragFilter: e => !engine.pick(e.clientX, e.clientY, screenMesh)`: a press that lands on the screen is yours (it never
starts a camera drag), a press on the bezel or the background still rotates. `interactive: false` removes the binding entirely.

## Models (`model/`)

Bytes are read in 4 MiB IPC chunks (`files.modelChunk` / `attachments.modelChunk`, confined to the open folder, extension allowlist, 128 MiB cap),
parsed in a dedicated Web Worker (GLB, glTF, OBJ+MTL, STL, PLY, FBX; Draco and meshopt for glTF), flattened to a transferable payload, and
mounted a few MB per frame (`mountModel`). Geometry over 6 MB is cut into about 3 MB pieces in the worker so no upload is a long task.
Companion files resolve against the model's own path and never leave the folder (`resolveCompanionPath`, then the host check).

Not supported yet: animations and skinning (static pose only), KTX2/Basis textures (clear message), second UV sets (shown on the first), FBX binary
files with unusual encodings are untested beyond three.js's own loader.
