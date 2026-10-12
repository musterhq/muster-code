/**
 * The structured-clone-safe description of a parsed model, produced in the worker and rebuilt into three.js objects
 * on the main thread. Typed arrays and ImageBitmaps are transferred, not copied.
 */
export type TextureSlot = 'map' | 'normalMap' | 'roughnessMap' | 'metalnessMap' | 'aoMap' | 'emissiveMap' | 'alphaMap' | 'bumpMap';

export interface TexturePayload {
  /** Decoded pixels. */
  image: ImageBitmap;
  /** three.js ColorSpace name: 'srgb' for colour maps, 'srgb-linear' otherwise. */
  colorSpace: string;
  flipY: boolean;
  wrapS: number; wrapT: number;
  repeat: [number, number]; offset: [number, number]; rotation: number;
}

export interface MaterialPayload {
  kind: 'standard' | 'basic' | 'default';
  name: string;
  color: [number, number, number];
  emissive: [number, number, number];
  emissiveIntensity: number;
  opacity: number;
  transparent: boolean;
  alphaTest: number;
  /** 0 front, 1 back, 2 double (three.js Side). */
  side: 0 | 1 | 2;
  metalness: number;
  roughness: number;
  vertexColors: boolean;
  flatShading: boolean;
  normalScale: number;
  maps: Partial<Record<TextureSlot, number>>;
}

export interface AttributePayload { array: Float32Array; itemSize: number }

export interface GeometryPayload {
  position: Float32Array;
  normal?: Float32Array;
  uv?: Float32Array;
  color?: AttributePayload;
  index?: Uint16Array | Uint32Array;
  /** Local-space bounds, so the host can set them without touching the (possibly released) arrays. */
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
}

export interface PartPayload {
  name: string;
  /** Index into `geometries`; instanced nodes share one geometry. */
  geometry: number;
  /** Index into `materials`. */
  material: number;
  /** Column-major world matrix. */
  matrix: number[];
  mode: 'triangles' | 'lines' | 'points';
}

export interface ModelStats {
  format: string;
  vertices: number;
  triangles: number;
  meshes: number;
  materials: number;
  textures: number;
  /** Axis-aligned size of the whole model in its own units. */
  size: [number, number, number];
  /** Centre of the model's bounds, so the camera can frame it before every part is built. */
  center: [number, number, number];
  /** Bytes of geometry plus texture pixels the GPU will hold (estimate). */
  gpuBytes: number;
  warnings: string[];
}

export interface ModelPayload {
  geometries: GeometryPayload[];
  materials: MaterialPayload[];
  textures: TexturePayload[];
  parts: PartPayload[];
  stats: ModelStats;
}

export class ModelParseError extends Error {
  constructor(message: string, readonly code: 'unsupported' | 'corrupt' | 'too-large' | 'empty' | 'extension' = 'corrupt') { super(message); this.name = 'ModelParseError'; }
}

/** Reads a companion file (texture, .bin, .mtl) for the model being parsed. Returns null when it is not available. */
export type CompanionResolver = (path: string) => Promise<Uint8Array | null>;

export interface ParseRequest {
  format: import('./formats.ts').ModelFormat;
  /** Folder-relative path of the model; companions resolve against its directory. */
  path: string;
  bytes: ArrayBuffer;
}
