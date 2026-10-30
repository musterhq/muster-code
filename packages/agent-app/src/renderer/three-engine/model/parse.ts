/**
 * Format dispatch: bytes -> ModelPayload. Pure of DOM, so it runs in the model worker and in Node tests.
 * Companion files (textures, .bin, .mtl) are requested through `resolve`, which the host confines to the open folder.
 */
import {Group, LoadingManager, Loader, Mesh, Object3D, Points, ShaderMaterial, Texture, type BufferGeometry} from 'three';
import {FBXLoader} from 'three/examples/jsm/loaders/FBXLoader.js';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {MTLLoader} from 'three/examples/jsm/loaders/MTLLoader.js';
import {OBJLoader} from 'three/examples/jsm/loaders/OBJLoader.js';
import {PLYLoader} from 'three/examples/jsm/loaders/PLYLoader.js';
import {STLLoader} from 'three/examples/jsm/loaders/STLLoader.js';
import {MeshoptDecoder} from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import {resolveCompanionPath, type ModelFormat} from './formats.ts';
import {ModelParseError, type CompanionResolver, type ModelPayload} from './payload.ts';
import {serializeScene} from './serialize.ts';

/** Marker material: geometry-only formats get the theme's default material on the main thread. */
const DEFAULT_MATERIAL = new ShaderMaterial();

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Bytes of a `data:` URI. Never fetched: fetch of data: is not allowed by the renderer CSP and not needed. */
function dataUriBytes(uri: string): {bytes: Uint8Array; mime: string} | null {
  const match = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(uri);
  if (!match) return null;
  const isBase64 = match[2]!.includes(';base64');
  return {mime: match[1] || 'application/octet-stream', bytes: isBase64 ? base64ToBytes(match[3]!) : new TextEncoder().encode(decodeURIComponent(match[3]!))};
}

const GREY_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mO89v7LfwAHmQMbiVSGBwAAAABJRU5ErkJggg==';
const IMAGE_MIME: Record<string, string> = {png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp'};
const mimeOf = (path: string) => IMAGE_MIME[/\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/**
 * Texture loader that reads companion images through the resolver and decodes them with createImageBitmap.
 * Registered with LoadingManager.addHandler so MTL, FBX and glTF-external textures all come through it.
 * Tracks outstanding work so the caller can wait for every texture before serializing.
 */
class CompanionTextureLoader extends Loader {
  readonly pending = new Set<Promise<void>>();
  constructor(manager: LoadingManager, private readonly resolve: CompanionResolver, private readonly warnings: string[]) { super(manager); }

  override load(url: string, onLoad?: (texture: Texture) => void, _progress?: unknown, onError?: (error: unknown) => void): Texture {
    const texture = new Texture();
    // FBXLoader hands the directory over through setPath(); embedded blob:/data: sources are already absolute.
    if (this.path && !/^(blob|data):/.test(url)) url = this.path + url;
    const work = (async () => {
      let bytes: Uint8Array | null = null, mime = 'image/png', label = url;
      if (url.startsWith('data:')) { const decoded = dataUriBytes(url); bytes = decoded?.bytes ?? null; mime = decoded?.mime ?? mime; label = 'embedded texture'; }
      else if (url.startsWith('blob:')) { bytes = new Uint8Array(await (await fetch(url)).arrayBuffer()); label = 'embedded texture'; }
      else {
        const path = resolveCompanionPath('', url);
        label = url;
        bytes = path ? await this.resolve(path) : null;
        mime = mimeOf(url);
        if (!path) this.warnings.push(`Texture "${url}" points outside the folder and was not loaded.`);
      }
      if (!bytes) { texture.userData.missing = true; if (!this.warnings.some(w => w.includes(label))) this.warnings.push(`Texture "${label}" was not found next to the model.`); onError?.(new Error(`Missing ${label}`)); return; }
      try {
        // flipY at decode time: ImageBitmap uploads ignore UNPACK_FLIP_Y, and these formats use the OpenGL UV origin.
        const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], {type: mime}), {imageOrientation: 'flipY', premultiplyAlpha: 'none'});
        texture.image = bitmap;
        texture.flipY = false;
        texture.needsUpdate = true;
        onLoad?.(texture);
      } catch (error) {
        texture.userData.missing = true;
        this.warnings.push(`Texture "${label}" could not be decoded.`);
        onError?.(error);
      }
    })();
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
    return texture;
  }

  async settled(): Promise<void> { while (this.pending.size) await Promise.all([...this.pending]); }
}

function manager(resolve: CompanionResolver, warnings: string[]): {manager: LoadingManager; textures: CompanionTextureLoader} {
  const loadingManager = new LoadingManager();
  const textures = new CompanionTextureLoader(loadingManager, resolve, warnings);
  loadingManager.addHandler(/\.(png|jpe?g|webp|gif|bmp)$/i, textures);
  return {manager: loadingManager, textures};
}

/** Cheap pre-check of the glTF JSON (the GLB's first chunk, or the whole .gltf) for KHR_draco_mesh_compression. */
function usesDraco(bytes: ArrayBuffer, format: 'glb' | 'gltf'): boolean {
  try {
    let end = bytes.byteLength;
    let start = 0;
    if (format === 'glb') { start = 20; end = Math.min(bytes.byteLength, 20 + new DataView(bytes).getUint32(12, true)); }
    return new TextDecoder().decode(new Uint8Array(bytes, start, end - start)).includes('KHR_draco_mesh_compression');
  } catch { return false; }
}

/** A GLB declares its own length; a shorter file was cut off (a failed download, a full disk). Say so instead of surfacing a typed-array error. */
function checkGlb(bytes: ArrayBuffer): void {
  if (bytes.byteLength < 20) throw new ModelParseError('This GLB file is too short to be a model; it may have been cut off.');
  const view = new DataView(bytes);
  if (view.getUint32(0, true) !== 0x46546c67) throw new ModelParseError('This file is not a GLB (the glTF header is missing).');
  const declared = view.getUint32(8, true);
  if (declared > bytes.byteLength) throw new ModelParseError(`This GLB file looks cut off: its header says ${declared.toLocaleString()} bytes but only ${bytes.byteLength.toLocaleString()} are there.`);
}

async function parseGltf(format: 'glb' | 'gltf', bytes: ArrayBuffer, path: string, resolve: CompanionResolver, warnings: string[]): Promise<Object3D> {
  const {manager: loadingManager} = manager(resolve, warnings);
  const loader = new GLTFLoader(loadingManager);
  loader.setMeshoptDecoder(MeshoptDecoder);
  if (usesDraco(bytes, format)) {
    // The decoder (about 0.3 MB with its wasm) is only evaluated for files that need it.
    const {InlineDracoLoader} = await import('./dracoInline.ts');
    loader.setDRACOLoader(new InlineDracoLoader());
  }
  const urls: string[] = [];
  let data: ArrayBuffer | string = bytes;
  if (format === 'glb') checkGlb(bytes);
  try {
    if (format === 'gltf') {
      let json: any;
      try { json = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new ModelParseError('This glTF file is not valid JSON.'); }
      // External and data: references become blob URLs here, so nothing the parser loads touches the network or the disk.
      const toBlobUrl = (content: Uint8Array, mime: string) => { const url = URL.createObjectURL(new Blob([content as BlobPart], {type: mime})); urls.push(url); return url; };
      for (const [list, mime] of [[json.buffers, 'application/octet-stream'], [json.images, ''] as const] as const) {
        for (const entry of (list ?? []) as Array<{uri?: string}>) {
          if (typeof entry.uri !== 'string') continue;
          const embedded = dataUriBytes(entry.uri);
          if (embedded) { entry.uri = toBlobUrl(embedded.bytes, embedded.mime); continue; }
          const target = resolveCompanionPath(path, entry.uri);
          const content = target ? await resolve(target) : null;
          if (!content) {
            if (list === json.buffers) throw new ModelParseError(`The model needs "${entry.uri}", which was not found next to it.`, 'corrupt');
            warnings.push(`Texture "${entry.uri}" was not found next to the model.`);
            entry.uri = toBlobUrl(base64ToBytes(GREY_PIXEL_PNG), 'image/png'); // keeps texture indices valid
            continue;
          }
          entry.uri = toBlobUrl(content, mime || mimeOf(target!));
        }
      }
      data = JSON.stringify(json);
    }
    const gltf = await loader.parseAsync(data, '');
    return gltf.scene;
  } catch (error) {
    if (error instanceof ModelParseError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/ktx2|basis/i.test(message)) throw new ModelParseError('This model uses KTX2/Basis compressed textures, which Muster cannot preview yet.', 'unsupported');
    throw new ModelParseError(`The glTF could not be read: ${message.replace(/^THREE\.\w+:\s*/, '')}`);
  } finally {
    // Parsing is complete (parseAsync awaited textures), so the blob URLs are no longer needed.
    for (const url of urls) URL.revokeObjectURL(url);
  }
}

async function parseObj(bytes: ArrayBuffer, path: string, resolve: CompanionResolver, warnings: string[]): Promise<Object3D> {
  const text = new TextDecoder().decode(bytes);
  const loader = new OBJLoader();
  const library = /^mtllib\s+(.+?)\s*$/m.exec(text)?.[1];
  let hasMaterials = false;
  const {manager: loadingManager, textures} = manager(resolve, warnings);
  if (library) {
    const target = resolveCompanionPath(path, library);
    const mtl = target ? await resolve(target) : null;
    if (mtl) {
      const mtlLoader = new MTLLoader(loadingManager);
      const dir = target!.includes('/') ? target!.slice(0, target!.lastIndexOf('/') + 1) : '';
      const creator = mtlLoader.parse(new TextDecoder().decode(mtl), dir);
      creator.preload();
      loader.setMaterials(creator);
      hasMaterials = true;
    } else warnings.push(`The material library "${library}" was not found next to the model; showing it without materials.`);
  }
  let group: Group;
  try { group = loader.parse(text); } catch (error) { throw new ModelParseError(`The OBJ could not be read: ${error instanceof Error ? error.message : error}`); }
  await textures.settled();
  if (!hasMaterials) group.traverse(o => { if ((o as Mesh).isMesh || (o as Points).isPoints) (o as Mesh).material = DEFAULT_MATERIAL; });
  return group;
}

function geometryOnly(geometry: BufferGeometry, points: boolean): Object3D {
  return points ? new Points(geometry, DEFAULT_MATERIAL) : new Mesh(geometry, DEFAULT_MATERIAL);
}

function parseFbx(bytes: ArrayBuffer, path: string, resolve: CompanionResolver, warnings: string[]): Promise<Object3D> {
  const {manager: loadingManager, textures} = manager(resolve, warnings);
  const loader = new FBXLoader(loadingManager);
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  return (async () => {
    let group: Group;
    try { group = loader.parse(bytes, dir); } catch (error) { throw new ModelParseError(`The FBX could not be read: ${error instanceof Error ? error.message : error}`); }
    await textures.settled();
    return group;
  })();
}

/** Compute normals where the file has none, so lit materials never render black. */
function ensureNormals(root: Object3D): void {
  root.traverse(object => {
    const mesh = object as Mesh;
    if (mesh.isMesh && mesh.geometry && !mesh.geometry.getAttribute('normal') && mesh.geometry.getAttribute('position')) mesh.geometry.computeVertexNormals();
  });
}

export async function parseModel(request: {format: ModelFormat; path: string; bytes: ArrayBuffer}, resolve: CompanionResolver): Promise<ModelPayload> {
  const warnings: string[] = [];
  const {format, path, bytes} = request;
  if (!bytes.byteLength) throw new ModelParseError('This 3D file is empty.', 'empty');
  let root: Object3D;
  switch (format) {
    case 'glb': case 'gltf': root = await parseGltf(format, bytes, path, resolve, warnings); break;
    case 'obj': root = await parseObj(bytes, path, resolve, warnings); break;
    case 'fbx': root = await parseFbx(bytes, path, resolve, warnings); break;
    case 'stl': {
      let geometry: BufferGeometry;
      try { geometry = new STLLoader().parse(bytes); } catch (error) { throw new ModelParseError(`The STL could not be read: ${error instanceof Error ? error.message : error}`); }
      root = geometryOnly(geometry, false);
      break;
    }
    case 'ply': {
      let geometry: BufferGeometry;
      try { geometry = new PLYLoader().parse(bytes); } catch (error) { throw new ModelParseError(`The PLY could not be read: ${error instanceof Error ? error.message : error}`); }
      root = geometryOnly(geometry, geometry.getIndex() === null);
      break;
    }
    default: throw new ModelParseError(`Unsupported format: ${String(format)}`, 'unsupported');
  }
  ensureNormals(root);
  return serializeScene(root, format, warnings);
}
