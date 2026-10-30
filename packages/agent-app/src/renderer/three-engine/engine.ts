import {Box3, Color, Group, type Material, NeutralToneMapping, PerspectiveCamera, Scene, SRGBColorSpace, Sphere, Vector3, WebGLRenderer, type Object3D} from 'three';
import {CAMERA_PRESETS, type CameraPreset} from './cameraPresets.ts';
import {bindOrbitInput, OrbitState, type OrbitOptions} from './controls.ts';
import {disposeObject} from './dispose.ts';
import {FrameTexture, type FrameHost} from './frameTexture.ts';
import {createLighting, disposeLighting, type LightingPreset} from './lighting.ts';
import {pickObjects, pointerToNdc, type PickHit} from './raycast.ts';
import {readEngineTheme, watchTheme, type EngineTheme} from './theme.ts';

/** The slice of WebGLRenderer the engine uses; tests and exotic hosts can supply their own. */
export interface RendererLike {
  readonly domElement: HTMLCanvasElement;
  setPixelRatio(ratio: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  render(scene: Scene, camera: PerspectiveCamera): void;
  setClearColor?(color: Color, alpha?: number): void;
  dispose(): void;
  forceContextLoss?(): void;
  /** WebGLRenderer.properties: per-object GL state. Used only to find process-wide shared textures (see releaseSharedTextures). */
  readonly properties?: {get(object: object): {uniforms?: Record<string, {value?: unknown} | undefined>} | undefined};
  readonly info?: {memory: {geometries: number; textures: number}; render: {calls: number; triangles: number; frame: number}; programs?: unknown[] | null};
}

/** Window-activity gate (see windowActivity.ts). While inactive the engine renders nothing and resumes with one frame. */
export interface ActivityGate { active(): boolean; subscribe(listener: (active: boolean) => void): () => void }

export interface FrameScheduler { request(callback: (time: number) => void): number; cancel(handle: number): void }

export interface EngineOptions {
  container: HTMLElement;
  /** Defaults to the live theme tokens of `container`; re-read automatically when the app theme changes. */
  theme?: EngineTheme;
  lighting?: LightingPreset;
  fov?: number;
  orbit?: Partial<OrbitOptions>;
  activity?: ActivityGate;
  /** Default: the user's prefers-reduced-motion setting. */
  reducedMotion?: boolean;
  /** false: no pointer/keyboard binding (the host drives the camera or does its own hit testing). Default true. */
  interactive?: boolean;
  /** Return false to keep a press from starting a camera drag (it is yours: a tap on the 3D screen). Called on pointerdown only. */
  dragFilter?: (event: PointerEvent) => boolean;
  /** Accessible name announced for the canvas. */
  label?: string;
  antialias?: boolean;
  createRenderer?: (canvas: HTMLCanvasElement) => RendererLike;
  scheduler?: FrameScheduler;
  /** Cap on devicePixelRatio. 2 keeps a 5K display from rendering 4x the pixels for no visible gain. */
  maxPixelRatio?: number;
}

export interface EngineStats { frames: number; lastRenderMs: number; pendingFrame: boolean; holds: number; drawCalls: number; triangles: number; geometries: number; textures: number }

export interface FrameOptions { padding?: number; preset?: CameraPreset | null; animate?: boolean }

/**
 * The shared three.js runtime. See README.md in this folder for the full contract.
 *
 * Rendering is demand-driven: nothing runs until something calls `invalidate()` (input, a new frame texture, a model
 * added, a resize, a theme change). The loop then continues only while the camera is moving or a hold is active, and
 * stops. At rest there is no requestAnimationFrame, no timer and no GPU work.
 */
export class Engine {
  /** Every engine that has been created and not yet disposed. Diagnostics and leak tests read this; nothing else should. */
  static readonly live = new Set<Engine>();
  readonly container: HTMLElement;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly renderer: RendererLike;
  readonly orbit: OrbitState;
  /** Everything the host adds goes under here, so lights and helpers never mix with content. */
  readonly content = new Group();
  readonly canvas: HTMLCanvasElement;

  private theme: EngineTheme;
  private lights: Group | null = null;
  private lightingPreset: LightingPreset;
  private readonly scheduler: FrameScheduler;
  private frameHandle = 0;
  private lastTime: number | null = null;
  private holds = new Set<symbol>();
  private beforeHooks = new Set<(dt: number) => boolean | void>();
  private afterOnce: Array<() => void> = [];
  private disposers: Array<() => void> = [];
  private frameTextures = new Set<FrameTexture>();
  private activeGate = true;
  private dirty = false;
  private disposed = false;
  private size = {width: 0, height: 0, ratio: 1};
  private bounds = new Sphere(new Vector3(), 1);
  private readonly maxPixelRatio: number;
  readonly stats: EngineStats = {frames: 0, lastRenderMs: 0, pendingFrame: false, holds: 0, drawCalls: 0, triangles: 0, geometries: 0, textures: 0};

  constructor(private readonly options: EngineOptions) {
    this.container = options.container;
    this.maxPixelRatio = options.maxPixelRatio ?? 2;
    this.scheduler = options.scheduler ?? {request: cb => requestAnimationFrame(cb), cancel: id => cancelAnimationFrame(id)};
    this.renderer = options.createRenderer ? options.createRenderer(document.createElement('canvas')) : createWebGLRenderer(options.antialias ?? true);
    this.canvas = this.renderer.domElement;
    this.theme = options.theme ?? readEngineTheme(this.container);
    this.lightingPreset = options.lighting ?? 'studio';
    const reduced = options.reducedMotion ?? (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
    this.orbit = new OrbitState({...options.orbit, reducedMotion: options.orbit?.reducedMotion ?? reduced});
    this.camera = new PerspectiveCamera(options.fov ?? 38, 1, 0.01, 1000);
    this.scene.add(this.content);
    this.applyTheme();
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', options.label ?? '3D view');
    // Absolutely positioned: the canvas never contributes to its container's size, so the container's size is only ever
    // decided by layout (a canvas that sizes its own parent turns every resize into a feedback loop).
    this.canvas.style.cssText = 'position:absolute;inset:0;display:block;width:100%;height:100%;touch-action:none;outline:none';
    if (typeof getComputedStyle === 'function' && getComputedStyle(this.container).position === 'static') this.container.style.position = 'relative';
    this.container.appendChild(this.canvas);

    if (options.interactive !== false) {
      this.canvas.tabIndex = 0;
      this.canvas.setAttribute('aria-roledescription', '3D viewer');
      this.disposers.push(bindOrbitInput(this.canvas, this.orbit, () => this.invalidate(), undefined, event => options.dragFilter?.(event) ?? true));
    }
    // Atomic resize: the size, projection and a synchronous render happen in the same callback, so a resize never paints a stretched frame.
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => this.resize());
      observer.observe(this.container);
      this.disposers.push(() => observer.disconnect());
    }
    this.disposers.push(watchTheme(() => { if (!options.theme) this.setTheme(readEngineTheme(this.container)); }));
    if (options.activity) {
      this.activeGate = options.activity.active();
      this.disposers.push(options.activity.subscribe(active => { this.activeGate = active; if (active && this.dirty) this.invalidate(); }));
    }
    this.resize();
    Engine.live.add(this);
  }

  // ---- theme and lighting -------------------------------------------------

  get currentTheme(): EngineTheme { return this.theme; }

  private themeListeners = new Set<(theme: EngineTheme) => void>();

  /** Notified after the scene colours change (app theme switch), so content with theme-derived materials can follow. */
  onThemeChange(listener: (theme: EngineTheme) => void): () => void {
    this.themeListeners.add(listener);
    return () => { this.themeListeners.delete(listener); };
  }

  setTheme(theme: EngineTheme): void {
    this.theme = theme;
    this.applyTheme();
    for (const listener of [...this.themeListeners]) listener(theme);
    this.invalidate();
  }

  setLighting(preset: LightingPreset): void {
    this.lightingPreset = preset;
    this.applyTheme();
    this.invalidate();
  }

  private applyTheme(): void {
    this.scene.background = new Color(this.theme.background);
    this.renderer.setClearColor?.(new Color(this.theme.background), 1);
    if (this.lights) { this.scene.remove(this.lights); disposeLighting(this.lights); }
    this.lights = createLighting(this.lightingPreset, this.theme);
    this.scene.add(this.lights);
  }

  // ---- sizing ---------------------------------------------------------------

  /** Measure the container and resize canvas + projection + frame in one step. Called by the ResizeObserver. */
  resize(): void {
    if (this.disposed) return;
    const rect = this.container.getBoundingClientRect?.();
    const width = Math.max(1, Math.round(rect?.width || this.container.clientWidth || 1)), height = Math.max(1, Math.round(rect?.height || this.container.clientHeight || 1));
    const ratio = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio || 1 : 1, this.maxPixelRatio);
    if (width === this.size.width && height === this.size.height && ratio === this.size.ratio) return;
    this.size = {width, height, ratio};
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderNow();
  }

  get viewport(): {width: number; height: number; pixelRatio: number} { return {width: this.size.width, height: this.size.height, pixelRatio: this.size.ratio}; }

  // ---- render loop -----------------------------------------------------------

  /** Request a render. Coalesced: any number of calls before the next frame produce one render. */
  invalidate(): void {
    if (this.disposed) return;
    this.dirty = true;
    if (!this.activeGate || this.frameHandle) return;
    this.frameHandle = this.scheduler.request(time => this.tick(time));
    this.stats.pendingFrame = true;
  }

  /**
   * Keep rendering every frame until the returned release function is called (a continuous animation such as a
   * spinning demo). Prefer `invalidate()` per new frame; a hold defeats the idle guarantee while it is active.
   */
  hold(): () => void {
    const key = Symbol('hold');
    this.holds.add(key);
    this.stats.holds = this.holds.size;
    this.invalidate();
    return () => { this.holds.delete(key); this.stats.holds = this.holds.size; };
  }

  /** Runs before every render with the elapsed seconds. Return true to ask for another frame (an animation in progress). */
  onBeforeRender(hook: (dt: number) => boolean | void): () => void {
    this.beforeHooks.add(hook);
    return () => { this.beforeHooks.delete(hook); };
  }

  /** Run `callback` once after the next render completes (textures are on the GPU by then). Triggers that render. */
  afterNextRender(callback: () => void): void {
    this.afterOnce.push(callback);
    this.invalidate();
  }

  private tick(time: number): void {
    this.frameHandle = 0;
    this.stats.pendingFrame = false;
    if (this.disposed) return;
    if (!this.activeGate) return; // stays dirty; resumes with one frame on activation
    const dt = this.lastTime === null ? 0 : Math.min(0.1, Math.max(0, (time - this.lastTime) / 1000));
    this.lastTime = time;
    let more = this.orbit.step(dt);
    for (const hook of [...this.beforeHooks]) if (hook(dt) === true) more = true;
    this.renderNow();
    if (more || this.holds.size > 0) { this.frameHandle = this.scheduler.request(t => this.tick(t)); this.stats.pendingFrame = true; }
    else this.lastTime = null; // idle: the next burst starts with a fresh dt
  }

  /** Render immediately (synchronously). Used by resize and screenshot; ordinary updates should call invalidate(). */
  renderNow(): void {
    if (this.disposed) return;
    this.orbit.applyTo(this.camera);
    const started = typeof performance !== 'undefined' ? performance.now() : 0;
    this.renderer.render(this.scene, this.camera);
    this.stats.lastRenderMs = (typeof performance !== 'undefined' ? performance.now() : 0) - started;
    this.stats.frames++;
    this.dirty = false;
    const info = this.renderer.info;
    if (info) { this.stats.drawCalls = info.render.calls; this.stats.triangles = info.render.triangles; this.stats.geometries = info.memory.geometries; this.stats.textures = info.memory.textures; }
    const done = this.afterOnce; this.afterOnce = [];
    for (const callback of done) { try { callback(); } catch (error) { console.error('three-engine afterNextRender callback failed', error); } }
  }

  // ---- content and camera -----------------------------------------------------

  add(object: Object3D): void { this.content.add(object); this.invalidate(); }

  remove(object: Object3D, options: {dispose?: boolean} = {dispose: true}): void {
    this.content.remove(object);
    if (options.dispose !== false) disposeObject(object);
    this.invalidate();
  }

  /** Fit the camera to `object` (default: all content) and optionally settle on a preset view. */
  frame(object: Object3D = this.content, options: FrameOptions = {}): Sphere {
    const box = new Box3().setFromObject(object);
    return this.frameSphere(box.isEmpty() ? new Sphere(new Vector3(), 1) : box.getBoundingSphere(new Sphere()), options);
  }

  /** Fit the camera to a known bounding sphere (used before content has been built). */
  frameSphere(sphere: Sphere, options: FrameOptions = {}): Sphere {
    sphere = sphere.clone();
    sphere.radius = Math.max(sphere.radius, 1e-6);
    this.bounds = sphere;
    const fit = this.fitRadius(options.padding);
    this.camera.near = Math.max(fit / 1000, 1e-5);
    this.camera.far = fit * 100;
    this.camera.updateProjectionMatrix();
    const limits = this.orbit.options.limits;
    limits.minRadius = sphere.radius * 0.15;
    limits.maxRadius = fit * 12;
    const preset = options.preset === null ? null : CAMERA_PRESETS[options.preset ?? 'iso'];
    const target: [number, number, number] = [sphere.center.x, sphere.center.y, sphere.center.z];
    if (options.animate && preset) this.orbit.goTo({azimuth: preset.azimuth, polar: preset.polar, radius: fit, target});
    else this.orbit.set({target, radius: fit, ...(preset ? {azimuth: preset.azimuth, polar: preset.polar} : {})});
    this.invalidate();
    return sphere;
  }

  /** Bounding sphere computed by the last frame() call. */
  get contentBounds(): Sphere { return this.bounds; }

  /** Ease to a named view; the radius is kept unless `refit` is set. */
  setCameraPreset(name: CameraPreset, options: {animate?: boolean; refit?: boolean} = {}): void {
    const preset = CAMERA_PRESETS[name];
    const radius = options.refit ? this.fitRadius() : undefined;
    if (options.animate === false) this.orbit.set({azimuth: preset.azimuth, polar: preset.polar, ...(radius ? {radius} : {})});
    else this.orbit.goTo({azimuth: preset.azimuth, polar: preset.polar, ...(radius ? {radius} : {})});
    this.invalidate();
  }

  /** Ease to the configured front view (the Home / "F" action). */
  snapToFront(): void { this.orbit.snapToFront(); this.invalidate(); }

  private fitRadius(padding = 1.08): number {
    const vfov = (this.camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    return (this.bounds.radius / Math.sin(Math.min(vfov, hfov) / 2)) * padding;
  }

  // ---- textures and input -------------------------------------------------------

  /** A texture you push frames into (device stream, canvas, <video>). Disposed with the engine. */
  createFrameTexture(): FrameTexture {
    const host: FrameHost = {invalidate: () => this.invalidate(), afterNextRender: cb => this.afterNextRender(cb)};
    const texture = new FrameTexture(host);
    this.frameTextures.add(texture);
    return texture;
  }

  /**
   * Raycast from a pointer position. `targets` defaults to all content. Returns the nearest hit with its texture
   * coordinate, so a tap on the 3D screen mesh maps to a pixel via `uvToPixel(hit.uv, frameWidth, frameHeight)`.
   */
  pick(clientX: number, clientY: number, targets: Object3D | Object3D[] = this.content): PickHit | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = pointerToNdc(rect, clientX, clientY);
    this.camera.updateMatrixWorld();
    this.scene.updateMatrixWorld(true);
    return pickObjects(this.camera, targets, ndc.x, ndc.y);
  }

  // ---- output ----------------------------------------------------------------------

  /** Render once at the current size and encode the canvas. Resolves null when the browser cannot encode it. */
  screenshot(type: 'image/png' | 'image/jpeg' = 'image/png', quality = 0.92): Promise<Blob | null> {
    this.renderNow();
    return new Promise(resolve => {
      try { this.canvas.toBlob(blob => resolve(blob), type, quality); } catch { resolve(null); }
    });
  }

  /** Apply `visit` to every material below content (wireframe toggle, opacity). */
  forEachMaterial(visit: (material: import('three').Material) => void): void {
    this.content.traverse(object => {
      const material = (object as {material?: import('three').Material | import('three').Material[]}).material;
      if (!material) return;
      for (const m of Array.isArray(material) ? material : [material]) visit(m);
    });
    this.invalidate();
  }

  get isDisposed(): boolean { return this.disposed; }

  // ---- teardown -------------------------------------------------------------------

  /** Cancel the frame loop, unbind input, free every geometry/material/texture and release the GL context. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    Engine.live.delete(this);
    const shared = sharedTextures(this.renderer, this.scene); // before content is disposed: a disposed material loses its GL state
    if (this.frameHandle) this.scheduler.cancel(this.frameHandle);
    this.frameHandle = 0;
    for (const dispose of this.disposers.splice(0)) { try { dispose(); } catch { /* ignore */ } }
    this.holds.clear(); this.beforeHooks.clear(); this.themeListeners.clear();
    for (const texture of this.frameTextures) texture.dispose();
    this.frameTextures.clear();
    disposeObject(this.content);
    this.content.clear();
    if (this.lights) { disposeLighting(this.lights); this.scene.remove(this.lights); this.lights = null; }
    this.scene.background = null;
    const pending = this.afterOnce; this.afterOnce = [];
    for (const callback of pending) { try { callback(); } catch { /* ignore */ } }
    for (const texture of shared) texture.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
    this.canvas.remove();
    this.canvas.width = this.canvas.height = 1; // drop the backbuffer allocation immediately
  }
}

/**
 * three.js keeps a few textures at module scope and shares them between every renderer in the page (the DFG lookup table
 * used by physical materials is one). Each renderer registers a 'dispose' listener on them that closes over its GL context,
 * and renderer.dispose() never removes it, so every viewer that is opened and closed would pin one dead context (about 50 KB
 * of JS wrappers, measured). Disposing the shared texture while the renderer is still alive runs and removes those listeners;
 * a renderer that is still in use simply re-uploads it on its next frame.
 */
function sharedTextures(renderer: RendererLike, scene: Scene): Set<{dispose(): void}> {
  const shared = new Set<{dispose(): void}>();
  const properties = renderer.properties;
  if (!properties) return shared;
  scene.traverse(object => {
    const material = (object as {material?: Material | Material[]}).material;
    if (!material) return;
    for (const m of Array.isArray(material) ? material : [material]) {
      const uniforms = properties.get(m)?.uniforms;
      if (!uniforms) continue;
      for (const uniform of Object.values(uniforms)) {
        const value = uniform?.value as {isTexture?: boolean; name?: string; dispose?: () => void} | null | undefined;
        if (value?.isTexture && value.name === 'DFG_LUT' && value.dispose) shared.add(value as {dispose(): void});
      }
    }
  });
  return shared;
}

function createWebGLRenderer(antialias: boolean): RendererLike {
  const renderer = new WebGLRenderer({antialias, alpha: false, powerPreference: 'default', preserveDrawingBuffer: false});
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NeutralToneMapping;
  return renderer as unknown as RendererLike;
}

export function createEngine(options: EngineOptions): Engine { return new Engine(options); }
