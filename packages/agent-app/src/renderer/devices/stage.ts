/**
 * The 3D stage for the device frame (#363). Deliberately small and engine-shaped: renderer, scene, camera, theme
 * lighting, render-on-demand, atomic resize and full disposal. When the shared `three-engine` of workstream B (#362)
 * is in this build, this file becomes a thin adapter over it; everything device-specific lives in DeviceFrame3D.
 *
 * Idle cost is zero: nothing renders unless a frame arrives, the user interacts, or a motion is settling.
 */
import {ACESFilmicToneMapping, Color, DirectionalLight, HemisphereLight, PerspectiveCamera, PMREMGenerator, Scene, SRGBColorSpace, WebGLRenderer, type Material, type Mesh, type Object3D, type Texture} from 'three';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';

export interface Stage {
  scene: Scene; camera: PerspectiveCamera; renderer: WebGLRenderer;
  /** Renders once on the next animation frame (coalesced). */
  requestRender(): void;
  /** Called before each render, e.g. to apply motion; return true to keep rendering next frame. */
  setBeforeRender(fn: (dt: number) => boolean): void;
  fit(object: Object3D, margin?: number): void;
  dispose(): void;
}
/** A colour token resolved by the browser (tokens may be color-mix() or var() chains three cannot parse). */
const token = (name: string, fallback: string) => {
  try {
    const probe = document.createElement('span');
    probe.style.color = `var(${name}, ${fallback})`;
    probe.style.display = 'none';
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value || fallback;
  } catch { return fallback; }
};
/** Theme colours for the scene: read from CSS tokens so every theme (built-in or imported) lights the device its way. */
export function themeColors() {
  return {body: toColor(token('--device-body', 'gray')), light: toColor(token('--device-light', 'white')), ground: toColor(token('--bg-sunken', 'black'))};
}
/** CSS colour strings as the browser serialises them: rgb()/rgba() or color(srgb …) for mixed colours. */
export function toColor(value: string): Color {
  const srgb = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(value);
  if (srgb) return new Color().setRGB(Number(srgb[1]), Number(srgb[2]), Number(srgb[3]), SRGBColorSpace);
  const rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(value);
  if (rgb) return new Color().setRGB(Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255, SRGBColorSpace);
  return new Color(value);
}

export function createStage(canvas: HTMLCanvasElement): Stage {
  const renderer = new WebGLRenderer({canvas, antialias: true, alpha: true, powerPreference: 'low-power', preserveDrawingBuffer: false});
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.setClearColor(0x000000, 0);
  const scene = new Scene();
  const colors = themeColors();
  const pmrem = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04).texture;
  scene.environment = environment;
  room.dispose(); pmrem.dispose();
  scene.add(new HemisphereLight(colors.light, colors.ground, 0.9));
  const key = new DirectionalLight(colors.light, 1.4); key.position.set(2.5, 3, 4); scene.add(key);
  const camera = new PerspectiveCamera(28, 1, 0.1, 100);
  camera.position.set(0, 0, 8);
  let frame = 0, last = 0, disposed = false;
  let before: (dt: number) => boolean = () => false;
  const resize = () => {
    const box = canvas.parentElement?.getBoundingClientRect();
    if (!box || !box.width || !box.height) return false;
    const w = Math.round(box.width), h = Math.round(box.height);
    if (canvas.width === Math.round(w * renderer.getPixelRatio()) && canvas.height === Math.round(h * renderer.getPixelRatio())) return false;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    return true;
  };
  const draw = (now: number) => {
    frame = 0;
    if (disposed) return;
    const dt = last ? (now - last) / 1000 : 1 / 60; last = now;
    resize();
    const again = before(dt);
    renderer.render(scene, camera);
    if (again) frame = requestAnimationFrame(draw); else last = 0;
  };
  const requestRender = () => { if (!frame && !disposed) frame = requestAnimationFrame(draw); };
  // Resize and redraw in the same frame, so the canvas never shows a stretched picture.
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => requestRender());
  if (canvas.parentElement) observer?.observe(canvas.parentElement);
  return {
    scene, camera, renderer, requestRender,
    setBeforeRender(fn) { before = fn; },
    fit(object, margin = 1.18) {
      // Distance that fits a portrait 2.2-unit screen plus bezel with the camera's vertical field of view.
      const height = 2.6 * margin, width = height * 0.75;
      const fov = (camera.fov * Math.PI) / 180;
      const byHeight = height / 2 / Math.tan(fov / 2), byWidth = width / 2 / Math.tan(fov / 2) / Math.max(0.2, camera.aspect);
      camera.position.set(0, 0, Math.max(byHeight, byWidth) + 0.6);
      camera.lookAt(0, 0, 0);
      void object;
    },
    dispose() {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      scene.traverse(node => {
        const mesh = node as Mesh;
        mesh.geometry?.dispose();
        for (const material of ([] as Material[]).concat((mesh.material as Material | Material[] | undefined) ?? [])) {
          for (const value of Object.values(material)) if ((value as Texture)?.isTexture) (value as Texture).dispose();
          material.dispose();
        }
      });
      environment.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
