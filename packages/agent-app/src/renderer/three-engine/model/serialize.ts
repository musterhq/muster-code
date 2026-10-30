/**
 * Object3D -> ModelPayload. Runs in the worker (and in Node tests). Static preview: animations, skinning and cameras are
 * dropped; every drawable is flattened to world-space parts with its geometry shared between instances.
 */
import {Box3, Matrix4, Vector3, type BufferAttribute, type BufferGeometry, type InterleavedBufferAttribute, type Material, type Object3D, type Texture} from 'three';
import {ModelParseError, type AttributePayload, type GeometryPayload, type MaterialPayload, type ModelPayload, type PartPayload, type TexturePayload, type TextureSlot} from './payload.ts';

type AnyAttribute = BufferAttribute | InterleavedBufferAttribute;
type SlotName = TextureSlot;
const SLOTS: SlotName[] = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'bumpMap'];
const LINEAR_SLOTS = new Set<SlotName>(['normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap', 'bumpMap']);

/** Plain Float32 copy of an attribute, de-interleaving and de-quantizing when needed. Avoids copying when it can. */
function toFloat32(attribute: AnyAttribute, itemSize: number): Float32Array {
  const plain = attribute as BufferAttribute & {isInterleavedBufferAttribute?: boolean};
  if (!plain.isInterleavedBufferAttribute && plain.array instanceof Float32Array && !attribute.normalized && attribute.itemSize === itemSize && plain.array.length === attribute.count * itemSize) return plain.array;
  const out = new Float32Array(attribute.count * itemSize);
  const read = [attribute.getX, attribute.getY, attribute.getZ, attribute.getW] as Array<(i: number) => number>;
  for (let i = 0; i < attribute.count; i++) for (let k = 0; k < Math.min(itemSize, attribute.itemSize); k++) out[i * itemSize + k] = read[k]!.call(attribute, i);
  return out;
}

function sideOf(material: Material): 0 | 1 | 2 { return material.side === 2 ? 2 : material.side === 1 ? 1 : 0; }
const rgb = (c: {r: number; g: number; b: number} | undefined, fallback: [number, number, number]): [number, number, number] => c ? [c.r, c.g, c.b] : fallback;

interface State {
  geometries: GeometryPayload[]; geometryIds: Map<string, number>;
  materials: MaterialPayload[]; materialIds: Map<Material | null, number>;
  textures: TexturePayload[]; textureIds: Map<string, number>;
  parts: PartPayload[]; warnings: string[];
  bitmaps: Array<Promise<void>>;
  geometryKeyCounter: WeakMap<BufferGeometry, number>; nextGeometryKey: number;
}

async function bitmapOf(texture: Texture): Promise<ImageBitmap | null> {
  const image = texture.image as unknown as {close?: () => void; width?: number; height?: number; data?: ArrayLike<number>} | null;
  if (!image) return null;
  if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) return image;
  if (typeof createImageBitmap === 'function' && image.data && image.width && image.height) {
    try {
      const rgba = new Uint8ClampedArray(image.width * image.height * 4);
      const src = image.data, channels = Math.round(src.length / (image.width * image.height));
      for (let i = 0, n = image.width * image.height; i < n; i++) {
        rgba[i * 4] = src[i * channels]!; rgba[i * 4 + 1] = src[i * channels + (channels > 2 ? 1 : 0)]!; rgba[i * 4 + 2] = src[i * channels + (channels > 2 ? 2 : 0)]!; rgba[i * 4 + 3] = channels === 4 ? src[i * channels + 3]! : 255;
      }
      return await createImageBitmap(new ImageData(rgba, image.width, image.height));
    } catch { return null; }
  }
  if (typeof createImageBitmap === 'function' && typeof (image as {width?: number}).width === 'number') {
    try { return await createImageBitmap(image as unknown as ImageBitmapSource); } catch { return null; }
  }
  return null;
}

function registerTexture(state: State, texture: Texture, slot: SlotName): number | undefined {
  const key = `${texture.uuid}:${LINEAR_SLOTS.has(slot) ? 'lin' : 'srgb'}`;
  const existing = state.textureIds.get(key);
  if (existing !== undefined) return existing;
  const index = state.textures.length;
  state.textureIds.set(key, index);
  const placeholder = {} as TexturePayload;
  state.textures.push(placeholder);
  state.bitmaps.push(bitmapOf(texture).then(bitmap => {
    if (!bitmap) { if (!texture.userData?.missing) state.warnings.push(`A ${slot} texture could not be decoded and was skipped.`); (placeholder as {image: unknown}).image = null; return; }
    Object.assign(placeholder, {
      image: bitmap, colorSpace: LINEAR_SLOTS.has(slot) ? 'srgb-linear' : 'srgb', flipY: false,
      wrapS: texture.wrapS, wrapT: texture.wrapT,
      repeat: [texture.repeat.x, texture.repeat.y], offset: [texture.offset.x, texture.offset.y], rotation: texture.rotation,
    } satisfies TexturePayload);
  }));
  return index;
}

function materialPayload(state: State, material: Material | null, hasVertexColors: boolean): number {
  const cached = state.materialIds.get(material);
  if (cached !== undefined) return cached;
  const record = (material ?? {}) as unknown as Record<string, any>;
  const type = (material as {type?: string} | null)?.type ?? '';
  const kind: MaterialPayload['kind'] = !material ? 'default'
    : /MeshStandardMaterial|MeshPhysicalMaterial/.test(type) ? 'standard'
    : /MeshPhongMaterial|MeshLambertMaterial|MeshToonMaterial|MeshMatcapMaterial/.test(type) ? 'standard'
    : /MeshBasicMaterial|PointsMaterial|LineBasicMaterial|LineDashedMaterial/.test(type) ? 'basic' : 'default';
  const payload: MaterialPayload = {
    kind, name: record.name ?? '',
    color: kind === 'default' ? [0.5, 0.5, 0.5] : rgb(record.color, [0.8, 0.8, 0.8]),
    emissive: kind === 'standard' ? rgb(record.emissive, [0, 0, 0]) : [0, 0, 0],
    emissiveIntensity: record.emissiveIntensity ?? 1,
    opacity: record.opacity ?? 1, transparent: Boolean(record.transparent) || (record.opacity ?? 1) < 1, alphaTest: record.alphaTest ?? 0,
    side: material ? sideOf(material) : 0,
    metalness: /Standard|Physical/.test(type) ? record.metalness ?? 0 : 0,
    roughness: /Standard|Physical/.test(type) ? record.roughness ?? 1 : /Phong/.test(type) ? Math.min(1, Math.max(0.15, 1 - (record.shininess ?? 30) / 150)) : 0.7,
    vertexColors: Boolean(record.vertexColors) || (kind === 'default' && hasVertexColors),
    flatShading: Boolean(record.flatShading), normalScale: record.normalScale?.x ?? 1, maps: {},
  };
  if (material && kind !== 'default') {
    for (const slot of SLOTS) {
      const texture = record[slot] as Texture | null | undefined;
      if (texture && (kind === 'standard' || slot === 'map' || slot === 'alphaMap')) {
        if (texture.channel && texture.channel > 0) state.warnings.push(`${slot} uses a second UV set; it is shown on the first.`);
        const id = registerTexture(state, texture, slot);
        if (id !== undefined) payload.maps[slot] = id;
      }
    }
  }
  const index = state.materials.length;
  state.materials.push(payload);
  state.materialIds.set(material, index);
  return index;
}

function geometryPayload(state: State, geometry: BufferGeometry, group?: {start: number; count: number}): number | null {
  const position = geometry.getAttribute('position') as AnyAttribute | undefined;
  if (!position || position.count === 0) return null;
  let key = state.geometryKeyCounter.get(geometry);
  if (key === undefined) { key = state.nextGeometryKey++; state.geometryKeyCounter.set(geometry, key); }
  const id = `${key}:${group ? `${group.start}:${group.count}` : 'all'}`;
  const found = state.geometryIds.get(id);
  if (found !== undefined) return found;
  const normal = geometry.getAttribute('normal') as AnyAttribute | undefined;
  const uv = geometry.getAttribute('uv') as AnyAttribute | undefined;
  const color = geometry.getAttribute('color') as AnyAttribute | undefined;
  const indexAttr = geometry.getIndex();
  const payload: GeometryPayload = {position: toFloat32(position, 3), boundsMin: [0, 0, 0], boundsMax: [0, 0, 0]};
  if (normal && normal.count === position.count) payload.normal = toFloat32(normal, 3);
  if (uv && uv.count === position.count) payload.uv = toFloat32(uv, 2);
  if (color && color.count === position.count) { const size = color.itemSize === 4 ? 4 : 3; payload.color = {array: toFloat32(color, size), itemSize: size} satisfies AttributePayload; }
  if (indexAttr) {
    const array = indexAttr.array as Uint16Array | Uint32Array | Uint8Array;
    const whole = array instanceof Uint8Array ? Uint16Array.from(array) : array;
    payload.index = group ? whole.subarray(group.start, group.start + group.count) : whole;
  } else if (group) {
    // Non-indexed multi-material geometry: build the index for this range.
    const indices = new Uint32Array(group.count);
    for (let i = 0; i < group.count; i++) indices[i] = group.start + i;
    payload.index = indices;
  }
  const box = new Box3().setFromBufferAttribute(position as BufferAttribute);
  payload.boundsMin = [box.min.x, box.min.y, box.min.z];
  payload.boundsMax = [box.max.x, box.max.y, box.max.z];
  state.geometries.push(payload);
  state.geometryIds.set(id, state.geometries.length - 1);
  return state.geometries.length - 1;
}

export async function serializeScene(root: Object3D, format: string, warnings: string[] = []): Promise<ModelPayload> {
  root.updateMatrixWorld(true);
  const state: State = {geometries: [], geometryIds: new Map(), materials: [], materialIds: new Map(), textures: [], textureIds: new Map(), parts: [], warnings, bitmaps: [], geometryKeyCounter: new WeakMap(), nextGeometryKey: 0};
  root.traverse(object => {
    const drawable = object as Object3D & {geometry?: BufferGeometry; material?: Material | Material[]; isMesh?: boolean; isPoints?: boolean; isLine?: boolean; isLineSegments?: boolean; isLineLoop?: boolean};
    if (!drawable.geometry || !drawable.material && !drawable.isMesh) return;
    const mode: PartPayload['mode'] | null = drawable.isMesh ? 'triangles' : drawable.isPoints ? 'points' : drawable.isLineSegments && !drawable.isLineLoop ? 'lines' : null;
    if (!mode) return;
    const matrix = drawable.matrixWorld.elements.slice();
    const hasColor = Boolean(drawable.geometry.getAttribute('color'));
    if (Array.isArray(drawable.material) && drawable.geometry.groups.length) {
      for (const group of drawable.geometry.groups) {
        const material = drawable.material[group.materialIndex ?? 0] ?? null;
        const total = drawable.geometry.getIndex()?.count ?? drawable.geometry.getAttribute('position').count;
        const count = Math.min(group.count, total - group.start);
        const geometry = geometryPayload(state, drawable.geometry, {start: group.start, count});
        if (geometry !== null) state.parts.push({name: drawable.name, geometry, material: materialPayload(state, material, hasColor), matrix, mode});
      }
    } else {
      const material = Array.isArray(drawable.material) ? drawable.material[0] ?? null : drawable.material ?? null;
      const geometry = geometryPayload(state, drawable.geometry);
      if (geometry !== null) state.parts.push({name: drawable.name, geometry, material: materialPayload(state, material, hasColor), matrix, mode});
    }
  });
  await Promise.all(state.bitmaps);
  if (!state.parts.length) throw new ModelParseError('This file has no geometry to display.', 'empty');
  // Drop textures that failed to decode and remap indices.
  const keep = state.textures.map(t => Boolean(t.image));
  const remap: number[] = []; let next = 0;
  state.textures.forEach((_, i) => { remap[i] = keep[i] ? next++ : -1; });
  const textures = state.textures.filter((_, i) => keep[i]);
  for (const material of state.materials) for (const slot of Object.keys(material.maps) as SlotName[]) { const to = remap[material.maps[slot]!]!; if (to < 0) delete material.maps[slot]; else material.maps[slot] = to; }

  // Statistics over instances (what is drawn), plus the world-space bounds.
  const bounds = new Box3(), corner = new Vector3(), world = new Matrix4();
  let vertices = 0, triangles = 0;
  for (const part of state.parts) {
    const g = state.geometries[part.geometry]!;
    vertices += g.position.length / 3;
    const indexCount = g.index?.length ?? g.position.length / 3;
    if (part.mode === 'triangles') triangles += Math.floor(indexCount / 3);
    world.fromArray(part.matrix);
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? g.boundsMax[0] : g.boundsMin[0], i & 2 ? g.boundsMax[1] : g.boundsMin[1], i & 4 ? g.boundsMax[2] : g.boundsMin[2]).applyMatrix4(world);
      bounds.expandByPoint(corner);
    }
  }
  let gpuBytes = 0;
  const seen = new Set<ArrayBufferLike>();
  for (const g of state.geometries) for (const array of [g.position, g.normal, g.uv, g.color?.array, g.index]) if (array && !seen.has(array.buffer)) { seen.add(array.buffer); gpuBytes += array.byteLength; }
  for (const t of textures) gpuBytes += Math.round(t.image.width * t.image.height * 4 * 1.33);
  const size = bounds.getSize(new Vector3()), center = bounds.getCenter(new Vector3());
  const meshes = state.parts.length;
  const split = splitLargeGeometries(state.geometries, state.parts);
  return {
    geometries: split.geometries, materials: state.materials, textures, parts: split.parts,
    stats: {format, vertices, triangles, meshes, materials: state.materials.length, textures: textures.length, size: [size.x, size.y, size.z], center: [center.x, center.y, center.z], gpuBytes, warnings: state.warnings},
  };
}

/** Geometry larger than this is cut into pieces so the GPU upload can be spread over several frames. */
export const SPLIT_ABOVE_BYTES = 6 * 1024 * 1024;
/** Target size of one piece (vertex + index data). */
export const SPLIT_CHUNK_BYTES = 3 * 1024 * 1024;

const bytesOf = (g: GeometryPayload) => g.position.byteLength + (g.normal?.byteLength ?? 0) + (g.uv?.byteLength ?? 0) + (g.color?.array.byteLength ?? 0) + (g.index?.byteLength ?? 0);

function boundsOf(position: Float32Array): {min: [number, number, number]; max: [number, number, number]} {
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < position.length; i += 3) for (let k = 0; k < 3; k++) { const v = position[i + k]!; if (v < min[k]!) min[k] = v; if (v > max[k]!) max[k] = v; }
  return {min, max};
}

/**
 * Cut one big triangle mesh into pieces of about SPLIT_CHUNK_BYTES. A piece is a mesh of its own (compact vertex arrays,
 * remapped indices), so each can be uploaded in a different frame. Returns null when splitting would duplicate too many
 * vertices (a mesh whose triangle order has no locality), in which case the geometry is kept whole.
 */
export function splitGeometry(g: GeometryPayload): GeometryPayload[] | null {
  const vertexCount = g.position.length / 3;
  const floatsPerVertex = 3 + (g.normal ? 3 : 0) + (g.uv ? 2 : 0) + (g.color?.itemSize ?? 0);
  if (!g.index) {
    const triangles = Math.floor(vertexCount / 3), perChunk = Math.max(1, Math.floor(SPLIT_CHUNK_BYTES / (floatsPerVertex * 4 * 3)));
    const pieces: GeometryPayload[] = [];
    for (let t = 0; t < triangles; t += perChunk) {
      const a = t * 3, b = Math.min(triangles, t + perChunk) * 3;
      const position = g.position.subarray(a * 3, b * 3), box = boundsOf(position);
      pieces.push({position, normal: g.normal?.subarray(a * 3, b * 3), uv: g.uv?.subarray(a * 2, b * 2), color: g.color && {array: g.color.array.subarray(a * g.color.itemSize, b * g.color.itemSize), itemSize: g.color.itemSize}, boundsMin: box.min, boundsMax: box.max});
    }
    return pieces.length > 1 ? pieces : null;
  }
  const index = g.index, triangles = Math.floor(index.length / 3);
  const perChunk = Math.max(1, Math.floor(SPLIT_CHUNK_BYTES / (12 + 0.6 * floatsPerVertex * 4)));
  const remap = new Int32Array(vertexCount).fill(-1);
  const touched = new Uint32Array(Math.min(vertexCount, perChunk * 3));
  const pieces: GeometryPayload[] = [];
  let totalTouched = 0;
  for (let t = 0; t < triangles; t += perChunk) {
    const end = Math.min(triangles, t + perChunk);
    const local = new Uint32Array((end - t) * 3);
    let count = 0;
    for (let i = t * 3, o = 0; i < end * 3; i++, o++) {
      const v = index[i]!;
      let m = remap[v]!;
      if (m < 0) { m = count; remap[v] = m; touched[count++] = v; }
      local[o] = m;
    }
    totalTouched += count;
    if (totalTouched > vertexCount * 1.6 + 1024) return null;
    const position = new Float32Array(count * 3);
    const normal = g.normal ? new Float32Array(count * 3) : undefined, uv = g.uv ? new Float32Array(count * 2) : undefined;
    const color = g.color ? new Float32Array(count * g.color.itemSize) : undefined;
    for (let i = 0; i < count; i++) {
      const v = touched[i]!;
      position[i * 3] = g.position[v * 3]!; position[i * 3 + 1] = g.position[v * 3 + 1]!; position[i * 3 + 2] = g.position[v * 3 + 2]!;
      if (normal) { normal[i * 3] = g.normal![v * 3]!; normal[i * 3 + 1] = g.normal![v * 3 + 1]!; normal[i * 3 + 2] = g.normal![v * 3 + 2]!; }
      if (uv) { uv[i * 2] = g.uv![v * 2]!; uv[i * 2 + 1] = g.uv![v * 2 + 1]!; }
      if (color) for (let k = 0; k < g.color!.itemSize; k++) color[i * g.color!.itemSize + k] = g.color!.array[v * g.color!.itemSize + k]!;
    }
    for (let i = 0; i < count; i++) remap[touched[i]!] = -1;
    const box = boundsOf(position);
    pieces.push({position, normal, uv, color: color && {array: color, itemSize: g.color!.itemSize}, index: count <= 65535 ? Uint16Array.from(local) : local, boundsMin: box.min, boundsMax: box.max});
  }
  return pieces.length > 1 ? pieces : null;
}

/** Replace oversized triangle geometries (and every part using them) by pieces; drops geometries nothing references. */
export function splitLargeGeometries(geometries: GeometryPayload[], parts: PartPayload[]): {geometries: GeometryPayload[]; parts: PartPayload[]} {
  const triangleOnly = geometries.map(() => true);
  for (const part of parts) if (part.mode !== 'triangles') triangleOnly[part.geometry] = false;
  const replacement = new Map<number, GeometryPayload[]>();
  geometries.forEach((g, i) => { if (triangleOnly[i] && bytesOf(g) > SPLIT_ABOVE_BYTES) { const pieces = splitGeometry(g); if (pieces) replacement.set(i, pieces); } });
  if (!replacement.size) return {geometries, parts};
  const outGeometries: GeometryPayload[] = [], firstIndex = new Map<number, number>();
  geometries.forEach((g, i) => {
    firstIndex.set(i, outGeometries.length);
    if (replacement.has(i)) outGeometries.push(...replacement.get(i)!); else outGeometries.push(g);
  });
  const outParts: PartPayload[] = [];
  for (const part of parts) {
    const pieces = replacement.get(part.geometry);
    const base = firstIndex.get(part.geometry)!;
    if (!pieces) outParts.push({...part, geometry: base});
    else pieces.forEach((_, k) => outParts.push({...part, geometry: base + k}));
  }
  return {geometries: outGeometries, parts: outParts};
}

/** Every distinct ArrayBuffer / ImageBitmap of a payload, for postMessage's transfer list. */
export function transferablesOf(payload: ModelPayload): Transferable[] {
  const out = new Set<Transferable>();
  for (const g of payload.geometries) for (const array of [g.position, g.normal, g.uv, g.color?.array, g.index]) if (array) out.add(array.buffer as ArrayBuffer);
  for (const t of payload.textures) out.add(t.image);
  return [...out];
}
