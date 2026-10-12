/**
 * Local conversion of Apple's AR Quick Look files into the 3D device frame (#363). Runs on the user's computer only,
 * after they opted in and main downloaded and checksum-verified the file from apple.com (src/main/devices/models.ts).
 * Nothing Apple-derived is ever committed or shipped by Muster.
 *
 * Steps (recorded here as the provenance of every converted file):
 *  1. Parse the USDZ with three.js's USDLoader (0.186). Apple's files keep their geometry in USD payloads, which the
 *     loader's crate parser does not read yet (PayloadListOp, type 55); `withPayloads` adds that one value type.
 *  2. Keep only the device body prim (`bodyNode`) and, inside it, the display mesh (`screenNode`); everything else
 *     (presentation duplicates, other models in the file) is dropped. World transforms are baked in.
 *  3. Normalise: rotate so the display faces +Z with its long side on +Y, centre on the display, scale the display
 *     height to SCREEN_HEIGHT (2.2 units).
 *  4. Replace the baked marketing picture with the live-screen placeholder (MeshBasicMaterial named SCREEN_NAME) and
 *     give the display planar 0..1 UVs, so the live feed maps onto it and touches map back.
 *  5. Export a binary glTF with textures capped at 1024 px, which main caches under app data.
 */
import {Box3, BufferAttribute, Group, Matrix4, Mesh, MeshBasicMaterial, Quaternion, Vector3, type BufferGeometry, type Material, type Object3D} from 'three';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {USDLoader} from 'three/addons/loaders/USDLoader.js';
// @ts-expect-error: the crate parser ships without type declarations.
import {USDCParser} from 'three/addons/loaders/usd/USDCParser.js';
import {SCREEN_HEIGHT, SCREEN_NAME} from './bodies.ts';

const PAYLOAD_LIST_OP = 55;
let patched = false;
/** Teaches three's crate parser USD's PayloadListOp (AOUSD core spec 16.3.10): the first payload becomes `@asset@<prim>`, the form its composer resolves. */
export function withPayloads(): void {
  if (patched) return;
  patched = true;
  const proto = (USDCParser as {prototype: Record<string, unknown>}).prototype;
  const original = proto._readScalarValue as (this: CrateParser, type: number) => unknown;
  proto._readScalarValue = function (this: CrateParser, type: number) {
    if (type !== PAYLOAD_LIST_OP) return original.call(this, type);
    const reader = this.reader, flags = reader.readUint8();
    const readList = () => {
      const count = Number(reader.readUint64()), items: {asset: string; prim: string}[] = [];
      for (let i = 0; i < count; i++) {
        const asset = this.tokens[this.strings[reader.readUint32()]!] ?? '', prim = this.paths[reader.readUint32()] ?? '';
        // Payload layer offsets were added in crate 0.8.
        if (this.version.major > 0 || this.version.minor >= 8) { reader.readFloat64(); reader.readFloat64(); }
        items.push({asset, prim});
      }
      return items;
    };
    // Lists in spec order: explicit, added, prepended, appended, deleted, ordered.
    const lists: Record<number, {asset: string; prim: string}[]> = {};
    for (const bit of [0x02, 0x04, 0x20, 0x40, 0x08, 0x10]) if (flags & bit) lists[bit] = readList();
    const first = (lists[0x20] ?? lists[0x02] ?? lists[0x40] ?? lists[0x04] ?? [])[0];
    return first ? `@${first.asset}@${first.prim && first.prim !== '/' ? `<${first.prim}>` : ''}` : null;
  };
}
interface CrateParser {reader: {readUint8(): number; readUint32(): number; readUint64(): number | bigint; readFloat64(): number}; tokens: string[]; strings: number[]; paths: string[]; version: {major: number; minor: number}}

const find = (root: Object3D, name: string, needMesh: boolean): Object3D | undefined => {
  let found: Object3D | undefined;
  root.traverse(node => { if (found || node.name !== name) return; if (!needMesh) { found = node; return; } let meshes = 0; node.traverse(child => { if ((child as Mesh).isMesh) meshes++; }); if (meshes) found = node; });
  return found;
};
/** Converts a verified USDZ into the normalised device GLB. Throws with a plain reason when the file is not as expected. */
export async function convertAppleModel(usdz: Uint8Array, bodyNode: string, screenNode: string): Promise<ArrayBuffer> {
  withPayloads();
  const loader = new USDLoader();
  const buffer = usdz.buffer.slice(usdz.byteOffset, usdz.byteOffset + usdz.byteLength) as ArrayBuffer;
  const parsed = await new Promise<Group>((resolve, reject) => { try { loader.parse(buffer, '', resolve as never, reject); } catch (error) { reject(error); } });
  parsed.updateMatrixWorld(true);
  const body = find(parsed, bodyNode, true);
  if (!body) throw new Error('The model file does not contain the expected device.');
  let screen: Mesh | undefined;
  body.traverse(node => { if (!screen && (node as Mesh).isMesh && (node.name === screenNode || node.parent?.name === screenNode)) screen = node as Mesh; });
  if (!screen) throw new Error('The model file has no display surface.');
  // Bake: copy every mesh under the body with its world matrix applied, into one clean group.
  const out = new Group(); out.name = 'apple-device';
  body.traverse(node => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    const geometry = (mesh.geometry as BufferGeometry).clone().applyMatrix4(mesh.matrixWorld);
    const copy = new Mesh(geometry, mesh === screen ? new MeshBasicMaterial({toneMapped: false}) : (mesh.material as Material));
    copy.name = mesh === screen ? SCREEN_NAME : mesh.name;
    out.add(copy);
  });
  const screenMesh = out.getObjectByName(SCREEN_NAME) as Mesh;
  normalise(out, screenMesh);
  planarUvs(screenMesh.geometry as BufferGeometry);
  // A texture whose picture did not decode (an unsupported format in this browser) is dropped, not exported empty.
  out.traverse(node => {
    const material = (node as Mesh).material as unknown as Record<string, unknown> | undefined;
    if (!material) return;
    for (const [key, value] of Object.entries(material)) {
      const image = (value as {isTexture?: boolean; image?: {width?: number}} | null)?.isTexture ? (value as {image?: {width?: number}}).image : undefined;
      if ((value as {isTexture?: boolean} | null)?.isTexture && !(image && (image.width ?? 0) > 0)) { material[key] = null; (material as {needsUpdate?: boolean}).needsUpdate = true; }
    }
  });
  const exporter = new GLTFExporter();
  return await exporter.parseAsync(out, {binary: true, maxTextureSize: 1024, onlyVisible: true}) as ArrayBuffer;
}

/** Display facing +Z, long side +Y, centred on the display, display height SCREEN_HEIGHT. The display may sit at any
 *  angle in Apple's file (an iPad on a stand), so its plane comes from its triangles and its long side from the spread
 *  of its points in that plane, not from an axis-aligned box. */
export function displayFrame(position: {count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number}, index: ArrayLike<number> | null): {center: Vector3; normal: Vector3; up: Vector3; height: number} {
  const p = (i: number) => new Vector3(position.getX(i), position.getY(i), position.getZ(i));
  const center = new Vector3();
  for (let i = 0; i < position.count; i++) center.add(p(i));
  center.divideScalar(Math.max(1, position.count));
  // Area-weighted normal, each triangle flipped to agree with the running sum (double-sided or mixed winding is fine).
  const normal = new Vector3(), e1 = new Vector3(), e2 = new Vector3(), cross = new Vector3();
  const triangles = index ? index.length / 3 : position.count / 3;
  for (let t = 0; t < triangles; t++) {
    const a = p(index ? index[t * 3]! : t * 3), b = p(index ? index[t * 3 + 1]! : t * 3 + 1), c = p(index ? index[t * 3 + 2]! : t * 3 + 2);
    cross.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a));
    if (normal.lengthSq() > 0 && cross.dot(normal) < 0) cross.negate();
    normal.add(cross);
  }
  normal.normalize();
  // Principal direction in the plane (2x2 covariance in any in-plane basis).
  const seed = Math.abs(normal.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  const a = new Vector3().crossVectors(seed, normal).normalize(), b = new Vector3().crossVectors(normal, a);
  let saa = 0, sab = 0, sbb = 0;
  for (let i = 0; i < position.count; i++) { const d = p(i).sub(center); const x = d.dot(a), y = d.dot(b); saa += x * x; sab += x * y; sbb += y * y; }
  const angle = 0.5 * Math.atan2(2 * sab, saa - sbb);
  const up = a.clone().multiplyScalar(Math.cos(angle)).add(b.clone().multiplyScalar(Math.sin(angle))).normalize();
  // Keep "up" pointing the way the file's own up (+Y) mostly points, so the device is not shown upside down.
  if (up.y < 0 || (Math.abs(up.y) < 1e-3 && up.z > 0)) up.negate();
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < position.count; i++) { const h = p(i).sub(center).dot(up); min = Math.min(min, h); max = Math.max(max, h); }
  center.add(up.clone().multiplyScalar((min + max) / 2));
  return {center, normal, up, height: max - min};
}
function normalise(group: Group, screen: Mesh): void {
  const geometry = screen.geometry as BufferGeometry;
  const frame = displayFrame(geometry.attributes.position!, geometry.index ? geometry.index.array : null);
  // Out of the screen is away from the body's centre.
  const bodyCenter = new Box3().setFromObject(group).getCenter(new Vector3());
  if (frame.center.clone().sub(bodyCenter).dot(frame.normal) < 0) frame.normal.negate();
  const right = new Vector3().crossVectors(frame.up, frame.normal).normalize();
  const rotation = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(right, frame.up, frame.normal)).invert();
  const scale = SCREEN_HEIGHT / Math.max(frame.height, 1e-6);
  const transform = new Matrix4().compose(new Vector3(), rotation, new Vector3(scale, scale, scale)).multiply(new Matrix4().makeTranslation(-frame.center.x, -frame.center.y, -frame.center.z));
  for (const child of group.children) ((child as Mesh).geometry as BufferGeometry).applyMatrix4(transform);
  // Centre exactly on the display rectangle.
  geometry.computeBoundingBox();
  const mid = geometry.boundingBox!.getCenter(new Vector3());
  for (const child of group.children) ((child as Mesh).geometry as BufferGeometry).translate(-mid.x, -mid.y, -mid.z);
}
/** u across the display's width, v up its height, 0..1 over its bounds. */
function planarUvs(geometry: BufferGeometry): void {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!, position = geometry.attributes.position!;
  const uv = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) { uv[i * 2] = (position.getX(i) - box.min.x) / (box.max.x - box.min.x || 1); uv[i * 2 + 1] = (position.getY(i) - box.min.y) / (box.max.y - box.min.y || 1); }
  geometry.setAttribute('uv', new BufferAttribute(uv, 2));
}
/** Loads a cached converted GLB. */
export async function loadDeviceGlb(glb: Uint8Array): Promise<Group> {
  const buffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer;
  const gltf = await new GLTFLoader().parseAsync(buffer, '');
  return gltf.scene;
}
