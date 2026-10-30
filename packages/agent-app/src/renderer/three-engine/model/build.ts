/**
 * ModelPayload -> three.js objects, on the main thread, in small slices.
 *
 * Wrapping typed arrays in BufferAttributes is cheap; the expensive step is the first render after parts are added, which
 * uploads their buffers and textures to the GPU. So parts are added a few MB at a time across frames (an onBeforeRender hook
 * of the engine) and the first frame shows the first slice immediately. A 50 MB model therefore never produces one long task.
 */
import {
  BufferAttribute, BufferGeometry, Box3, Color, DoubleSide, FrontSide, BackSide, Group, LineBasicMaterial, LineSegments, LinearSRGBColorSpace, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  Points, PointsMaterial, SRGBColorSpace, Sphere, Texture, Vector2, Vector3, type Material, type Object3D,
} from 'three';
import {disposeTexture} from '../dispose.ts';
import type {Engine} from '../engine.ts';
import type {EngineTheme} from '../theme.ts';
import type {GeometryPayload, MaterialPayload, ModelPayload, ModelStats, PartPayload, TexturePayload} from './payload.ts';

export interface MountOptions {
  /** Geometry+texture bytes added per frame. Default 3 MiB: a few ms of upload on integrated GPUs. */
  bytesPerFrame?: number;
  /** Wall-clock cap per slice in ms (checked between parts). Default 6. */
  msPerFrame?: number;
  wireframe?: boolean;
}

export interface ModelHandle {
  group: Group;
  stats: ModelStats;
  /** Resolves once every part has been added (the model may be partially visible earlier). */
  done: Promise<void>;
  /** Fraction of parts added, 0..1. */
  progress(): number;
  setWireframe(on: boolean): void;
  applyTheme(theme: EngineTheme): void;
  /** Stop adding parts, free everything. */
  dispose(): void;
}

const SIDES = [FrontSide, BackSide, DoubleSide] as const;

class Builder {
  private geometries = new Map<number, BufferGeometry>();
  private materials = new Map<number, Material>();
  private textures = new Map<number, Texture>();
  private counted = { geometries: new Set<number>(), textures: new Set<number>() };
  readonly defaults = new Set<Material>();
  wireframe = false;

  constructor(private readonly payload: ModelPayload, private theme: EngineTheme) {}

  setTheme(theme: EngineTheme): void {
    this.theme = theme;
    for (const m of this.defaults) (m as MeshStandardMaterial).color?.setHex(theme.model);
  }

  private texture(index: number): Texture {
    let texture = this.textures.get(index);
    if (texture) return texture;
    const data: TexturePayload = this.payload.textures[index]!;
    texture = new Texture(data.image);
    texture.colorSpace = data.colorSpace === 'srgb' ? SRGBColorSpace : LinearSRGBColorSpace;
    texture.flipY = data.flipY;
    texture.wrapS = data.wrapS as Texture['wrapS']; texture.wrapT = data.wrapT as Texture['wrapT'];
    texture.repeat.set(data.repeat[0], data.repeat[1]); texture.offset.set(data.offset[0], data.offset[1]); texture.rotation = data.rotation;
    texture.anisotropy = 4;
    texture.needsUpdate = true;
    this.textures.set(index, texture);
    return texture;
  }

  /** Bytes this part adds to the current slice (geometry and textures not yet counted). */
  cost(part: PartPayload): number {
    let bytes = 0;
    if (!this.counted.geometries.has(part.geometry)) {
      const g = this.payload.geometries[part.geometry]!;
      bytes += g.position.byteLength + (g.normal?.byteLength ?? 0) + (g.uv?.byteLength ?? 0) + (g.color?.array.byteLength ?? 0) + (g.index?.byteLength ?? 0);
    }
    for (const index of Object.values(this.payload.materials[part.material]!.maps)) if (!this.counted.textures.has(index)) {
      const t = this.payload.textures[index]!; bytes += t.image.width * t.image.height * 5;
    }
    return bytes;
  }

  private geometry(index: number): BufferGeometry {
    let geometry = this.geometries.get(index);
    if (geometry) return geometry;
    const data: GeometryPayload = this.payload.geometries[index]!;
    geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(data.position, 3));
    if (data.normal) geometry.setAttribute('normal', new BufferAttribute(data.normal, 3));
    if (data.uv) geometry.setAttribute('uv', new BufferAttribute(data.uv, 2));
    if (data.color) geometry.setAttribute('color', new BufferAttribute(data.color.array, data.color.itemSize));
    if (data.index) geometry.setIndex(new BufferAttribute(data.index, 1));
    // Bounds come from the worker: three would otherwise scan every vertex on this thread at first cull.
    geometry.boundingBox = new Box3(new Vector3(...data.boundsMin), new Vector3(...data.boundsMax));
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new Sphere());
    this.geometries.set(index, geometry);
    return geometry;
  }

  private material(index: number, mode: PartPayload['mode']): Material {
    const key = index * 4 + (mode === 'triangles' ? 0 : mode === 'lines' ? 1 : 2);
    let material = this.materials.get(key);
    if (material) return material;
    const data: MaterialPayload = this.payload.materials[index]!;
    const common = {
      transparent: data.transparent, opacity: data.opacity, alphaTest: data.alphaTest, side: SIDES[data.side],
      vertexColors: data.vertexColors,
    };
    const map = (slot: keyof MaterialPayload['maps']) => (data.maps[slot] !== undefined ? this.texture(data.maps[slot]!) : null);
    if (mode === 'points') {
      material = new PointsMaterial({color: data.kind === 'default' ? this.theme.model : new Color().setRGB(...data.color), size: 2.5, sizeAttenuation: false, vertexColors: data.vertexColors});
      if (data.kind === 'default') this.defaults.add(material);
    } else if (mode === 'lines') {
      material = new LineBasicMaterial({color: data.kind === 'default' ? this.theme.model : new Color().setRGB(...data.color), vertexColors: data.vertexColors});
    } else if (data.kind === 'default') {
      // Geometry-only formats: a neutral, theme-derived finish. Double sided because STL/PLY winding is often inconsistent.
      material = new MeshStandardMaterial({color: this.theme.model, roughness: 0.55, metalness: 0.05, side: DoubleSide, vertexColors: data.vertexColors});
      this.defaults.add(material);
    } else if (data.kind === 'basic') {
      material = new MeshBasicMaterial({...common, color: new Color().setRGB(...data.color), map: map('map'), alphaMap: map('alphaMap')});
    } else {
      const standard = new MeshStandardMaterial({
        ...common, color: new Color().setRGB(...data.color), roughness: data.roughness, metalness: data.metalness,
        emissive: new Color().setRGB(...data.emissive), emissiveIntensity: data.emissiveIntensity, flatShading: data.flatShading,
        map: map('map'), normalMap: map('normalMap'), roughnessMap: map('roughnessMap'), metalnessMap: map('metalnessMap'), aoMap: map('aoMap'),
        emissiveMap: map('emissiveMap'), alphaMap: map('alphaMap'), bumpMap: map('bumpMap'),
      });
      standard.normalScale = new Vector2(data.normalScale, data.normalScale);
      material = standard;
    }
    material.name = data.name;
    (material as {wireframe?: boolean}).wireframe = this.wireframe && mode === 'triangles';
    this.materials.set(key, material);
    return material;
  }

  build(part: PartPayload): Object3D {
    const geometry = this.geometry(part.geometry);
    const material = this.material(part.material, part.mode);
    this.counted.geometries.add(part.geometry);
    for (const index of Object.values(this.payload.materials[part.material]!.maps)) this.counted.textures.add(index);
    const object = part.mode === 'points' ? new Points(geometry, material) : part.mode === 'lines' ? new LineSegments(geometry, material) : new Mesh(geometry, material);
    object.name = part.name;
    object.matrixAutoUpdate = false;
    object.matrix.fromArray(part.matrix);
    object.matrixWorldNeedsUpdate = true;
    return object;
  }

  setWireframe(on: boolean): void {
    this.wireframe = on;
    for (const [key, material] of this.materials) if ((key & 3) === 0) { (material as {wireframe?: boolean}).wireframe = on; material.needsUpdate = true; }
  }

  dispose(): void {
    for (const texture of this.textures.values()) disposeTexture(texture);
    for (const material of this.materials.values()) material.dispose();
    for (const geometry of this.geometries.values()) geometry.dispose();
    // Textures the builder never reached still hold decoded bitmaps.
    this.payload.textures.forEach((t, i) => { if (!this.textures.has(i)) { try { t.image.close(); } catch { /* closed */ } } });
    this.geometries.clear(); this.materials.clear(); this.textures.clear(); this.defaults.clear();
  }
}

/** Add `payload` to `engine`, framing the camera on its bounds first, and keep adding slices until every part is in. */
export function mountModel(engine: Engine, payload: ModelPayload, options: MountOptions = {}): ModelHandle {
  const builder = new Builder(payload, engine.currentTheme);
  builder.wireframe = options.wireframe ?? false;
  const group = new Group();
  group.name = 'model';
  engine.add(group);
  const radius = Math.max(1e-6, Math.hypot(...payload.stats.size) / 2);
  engine.frameSphere(new Sphere(new Vector3(...payload.stats.center), radius), {preset: 'iso', padding: 1.3});

  const budget = options.bytesPerFrame ?? 3 * 1024 * 1024, msBudget = options.msPerFrame ?? 6;
  let next = 0, disposed = false;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const parts = payload.parts;
  const slice = (): boolean => {
    if (disposed) return false;
    const started = performance.now();
    let bytes = 0;
    while (next < parts.length) {
      const part = parts[next]!;
      const cost = builder.cost(part);
      if (bytes > 0 && (bytes + cost > budget || performance.now() - started > msBudget)) break;
      group.add(builder.build(part));
      bytes += cost; next++;
    }
    if (next >= parts.length) { stop(); finish(); return false; }
    return true;
  };
  const stop = engine.onBeforeRender(slice);
  engine.invalidate();

  return {
    group, stats: payload.stats, done,
    progress: () => (parts.length ? next / parts.length : 1),
    setWireframe(on) { builder.setWireframe(on); engine.invalidate(); },
    applyTheme(theme) { builder.setTheme(theme); engine.invalidate(); },
    dispose() {
      if (disposed) return;
      disposed = true; stop(); finish();
      engine.content.remove(group);
      group.clear();
      builder.dispose();
      engine.invalidate();
    },
  };
}
