/** Model pipeline: bytes -> ModelPayload for every format, companion resolution, failure paths. Bundled and run by tests/run-three-model.mjs (from `npm run test:renderer`) (needs the Draco wasm loader). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseModel} from '../src/renderer/three-engine/model/parse.ts';
import {splitGeometry, transferablesOf} from '../src/renderer/three-engine/model/serialize.ts';
import {ModelParseError, type CompanionResolver, type ModelPayload} from '../src/renderer/three-engine/model/payload.ts';
import {readAllChunks} from '../src/renderer/three-engine/model/load.ts';
import {checkerPng, cubeGlb, cubeGltf, cubeMtl, fbxAsciiCube, glbFrom, objCube, plyBinary, plyPointCloud, sphereMesh, stlAscii, stlBinary, terrainGlb} from './fixtures/model-fixtures.ts';
import {dracoCubeGlb, meshoptCubeGlb} from './fixtures/compressed-models.ts';

// Minimal image decoding: the worker uses createImageBitmap; Node has none, so decode "PNG" to a sized fake.
let bitmapsClosed = 0;
class FakeBitmap { constructor(readonly width: number, readonly height: number) {} close() { bitmapsClosed++; } }
Object.assign(globalThis, {self: globalThis, ProgressEvent: class extends Event {}, ImageBitmap: FakeBitmap, createImageBitmap: async () => new FakeBitmap(32, 32)});

const none: CompanionResolver = async () => null;
const buf = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const text = (s: string) => buf(new TextEncoder().encode(s));
const close = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) <= eps;

function assertCube(payload: ModelPayload, vertices = 24) {
  assert.equal(payload.stats.vertices, vertices);
  assert.equal(payload.stats.triangles, 12);
  for (const s of payload.stats.size) assert.ok(close(s, 1, 0.02), `size ${payload.stats.size}`);
  for (const c of payload.stats.center) assert.ok(close(c, 0, 0.02));
  assert.ok(payload.parts.length >= 1);
}

test('GLB cube: geometry, PBR material, stats, transferable buffers', async () => {
  const payload = await parseModel({format: 'glb', path: 'cube.glb', bytes: buf(cubeGlb())}, none);
  assertCube(payload);
  assert.equal(payload.materials[0]!.kind, 'standard');
  assert.ok(close(payload.materials[0]!.color[0], 0.8 ** 2.2, 0.2) || payload.materials[0]!.color[0] > 0.3);
  assert.ok(payload.geometries[0]!.normal && payload.geometries[0]!.uv && payload.geometries[0]!.index);
  const transfer = transferablesOf(payload);
  assert.equal(new Set(transfer).size, transfer.length, 'no buffer is listed twice');
  assert.ok(payload.stats.gpuBytes > 0);
});

test('GLB with an embedded texture decodes it once and links the material slot', async () => {
  bitmapsClosed = 0;
  const payload = await parseModel({format: 'glb', path: 'cube.glb', bytes: buf(cubeGlb({texture: checkerPng(32)}))}, none);
  assert.equal(payload.stats.textures, 1);
  assert.equal(payload.materials[0]!.maps.map, 0);
  assert.equal(payload.textures[0]!.colorSpace, 'srgb');
});

test('glTF with external .bin and texture resolves them relative to the model, inside the folder', async () => {
  const ext = cubeGltf({texture: checkerPng(16), external: true});
  const asked: string[] = [];
  const resolver: CompanionResolver = async path => { asked.push(path); return path === 'models/cube.bin' ? ext.bin : path === 'models/textures/checker.png' ? ext.image! : null; };
  const payload = await parseModel({format: 'gltf', path: 'models/cube-external.gltf', bytes: text(JSON.stringify(ext.json))}, resolver);
  assertCube(payload);
  assert.deepEqual(asked.sort(), ['models/cube.bin', 'models/textures/checker.png']);
  assert.equal(payload.stats.textures, 1);
});

test('glTF: a missing texture is a warning, a missing .bin is an error, and a path out of the folder is never requested', async () => {
  const ext = cubeGltf({texture: checkerPng(16), external: true});
  const noTexture: CompanionResolver = async path => (path.endsWith('.bin') ? ext.bin : null);
  const payload = await parseModel({format: 'gltf', path: 'a.gltf', bytes: text(JSON.stringify(ext.json))}, noTexture);
  assertCube(payload);
  assert.ok(payload.stats.warnings.some(w => /checker\.png/.test(w)), payload.stats.warnings.join('|'));
  await assert.rejects(parseModel({format: 'gltf', path: 'a.gltf', bytes: text(JSON.stringify(ext.json))}, none), /cube\.bin/);
  const asked: string[] = [];
  const evil = cubeGltf({external: true, extraJson: j => { j.buffers[0].uri = '../../etc/passwd'; }});
  await assert.rejects(parseModel({format: 'gltf', path: 'a.gltf', bytes: text(JSON.stringify(evil.json))}, async p => { asked.push(p); return null; }), ModelParseError);
  assert.deepEqual(asked, [], 'an escaping reference never reaches the reader');
});

test('glTF with a data: URI buffer needs no companion file', async () => {
  const base = cubeGltf({});
  const bin = Buffer.from(base.bin).toString('base64');
  base.json.buffers[0].uri = `data:application/octet-stream;base64,${bin}`;
  const payload = await parseModel({format: 'gltf', path: 'x.gltf', bytes: text(JSON.stringify(base.json))}, none);
  assertCube(payload);
});

test('Draco-compressed GLB decodes through the in-worker decoder', async () => {
  const payload = await parseModel({format: 'glb', path: 'draco.glb', bytes: buf(await dracoCubeGlb())}, none);
  assertCube(payload);
  assert.ok(payload.geometries[0]!.normal);
});

test('meshopt-compressed GLB decodes', async () => {
  const payload = await parseModel({format: 'glb', path: 'meshopt.glb', bytes: buf(await meshoptCubeGlb())}, none);
  assertCube(payload);
});

test('GLB: truncated and garbage files fail with a friendly error, not a hang or a crash', async () => {
  const good = cubeGlb();
  await assert.rejects(parseModel({format: 'glb', path: 'a.glb', bytes: buf(good.subarray(0, 60))}, none), /cut off/);
  await assert.rejects(parseModel({format: 'glb', path: 'a.glb', bytes: buf(new Uint8Array(200).fill(7))}, none), ModelParseError);
  await assert.rejects(parseModel({format: 'glb', path: 'a.glb', bytes: new ArrayBuffer(0)}, none), /empty/);
  await assert.rejects(parseModel({format: 'gltf', path: 'a.gltf', bytes: text('{not json')}, none), /JSON/);
  const empty = glbFrom({asset: {version: '2.0'}, scenes: [{nodes: []}], scene: 0}, new Uint8Array(4));
  await assert.rejects(parseModel({format: 'glb', path: 'a.glb', bytes: buf(empty)}, none), /no geometry/);
});

test('OBJ without a material library gets the theme default; normals are generated', async () => {
  const payload = await parseModel({format: 'obj', path: 'cube.obj', bytes: text(objCube(false))}, none);
  assert.equal(payload.stats.triangles, 12);
  assert.equal(payload.materials[0]!.kind, 'default');
  assert.ok(payload.geometries[0]!.normal);
});

test('OBJ + MTL + texture: the library and the image are read through the resolver', async () => {
  const asked: string[] = [];
  const resolver: CompanionResolver = async path => { asked.push(path); return path === 'obj/cube.mtl' ? new TextEncoder().encode(cubeMtl('tex/c.png')) : path === 'obj/tex/c.png' ? checkerPng(16) : null; };
  const payload = await parseModel({format: 'obj', path: 'obj/cube.obj', bytes: text(objCube(true).replace('cube.mtl', 'cube.mtl'))}, resolver);
  assert.ok(asked.includes('obj/cube.mtl') && asked.includes('obj/tex/c.png'), asked.join(','));
  assert.equal(payload.materials[0]!.kind, 'standard');
  assert.equal(payload.stats.textures, 1);
  assert.equal(payload.textures[0]!.flipY, false, 'flipped at decode time');
});

test('OBJ with a missing material library warns and still renders', async () => {
  const payload = await parseModel({format: 'obj', path: 'cube.obj', bytes: text(objCube(true))}, none);
  assert.ok(payload.stats.warnings.some(w => /material library/.test(w)));
  assert.equal(payload.stats.triangles, 12);
});

test('STL binary and ASCII', async () => {
  const sphere = await parseModel({format: 'stl', path: 's.stl', bytes: buf(stlBinary())}, none);
  assert.equal(sphere.stats.triangles, 12 * 16 * 2 - 0 || sphere.stats.triangles > 0, undefined as never);
  assert.ok(sphere.stats.triangles > 100);
  assert.equal(sphere.materials[0]!.kind, 'default');
  const ascii = await parseModel({format: 'stl', path: 'c.stl', bytes: text(stlAscii())}, none);
  assert.equal(ascii.stats.triangles, 12);
});

test('PLY mesh keeps vertex colours; a point cloud becomes points', async () => {
  const mesh = await parseModel({format: 'ply', path: 's.ply', bytes: buf(plyBinary(sphereMesh(1, 8, 12), true))}, none);
  assert.ok(mesh.geometries[0]!.color);
  assert.equal(mesh.parts[0]!.mode, 'triangles');
  assert.equal(mesh.materials[0]!.vertexColors, true);
  const points = await parseModel({format: 'ply', path: 'p.ply', bytes: text(plyPointCloud(300))}, none);
  assert.equal(points.parts[0]!.mode, 'points');
  assert.equal(points.stats.vertices, 300);
});

test('FBX (ASCII) cube', async () => {
  const payload = await parseModel({format: 'fbx', path: 'cube.fbx', bytes: text(fbxAsciiCube())}, none);
  assert.ok(payload.stats.triangles >= 12, `triangles ${payload.stats.triangles}`);
  assert.ok(payload.stats.size.every(s => s > 0.5));
});

test('FBX: a texture next to the file is resolved; one outside the folder is not requested', async () => {
  const asked: string[] = [];
  const resolver: CompanionResolver = async path => { asked.push(path); return path === 'm/checker.png' ? checkerPng(16) : null; };
  const good = await parseModel({format: 'fbx', path: 'm/cube.fbx', bytes: text(fbxAsciiCube('checker.png'))}, resolver);
  assert.equal(good.stats.textures, 1, good.stats.warnings.join('|'));
  asked.length = 0;
  const evil = await parseModel({format: 'fbx', path: 'm/cube.fbx', bytes: text(fbxAsciiCube('../../../secret.png'))}, resolver);
  assert.deepEqual(asked, []);
  assert.equal(evil.stats.textures, 0);
  assert.ok(evil.stats.warnings.length > 0);
});

test('chunked reads reassemble a file exactly and report progress', async () => {
  const data = new Uint8Array(10_000_003).map((_, i) => (i * 31) & 255);
  const progress: number[] = [];
  const calls: number[] = [];
  const buffer = await readAllChunks(async (offset, length) => { calls.push(length); return {size: data.length, bytes: data.slice(offset, offset + length)}; }, {chunk: 4_000_000, onProgress: f => progress.push(f)});
  assert.equal(buffer.byteLength, data.length);
  assert.ok(Buffer.from(buffer).equals(Buffer.from(data)));
  assert.equal(calls.length, 3);
  assert.equal(progress.at(-1), 1);
  await assert.rejects(readAllChunks(async () => ({size: 999_999_999, bytes: new Uint8Array(1)})), /larger than/);
});

test('a 50 MB terrain GLB parses and is cut into pieces that upload one frame at a time', async () => {
  const {glb, vertices, triangles} = terrainGlb(50 * 1024 * 1024);
  assert.ok(glb.length > 49 * 1024 * 1024 && glb.length < 54 * 1024 * 1024, `${glb.length}`);
  const started = performance.now();
  const payload = await parseModel({format: 'glb', path: 'terrain.glb', bytes: buf(glb)}, none);
  assert.equal(payload.stats.vertices, vertices, 'statistics describe the model, not the pieces');
  assert.equal(payload.stats.triangles, triangles);
  assert.equal(payload.stats.meshes, 1);
  assert.ok(payload.parts.length >= 8, `${payload.parts.length} pieces`);
  let pieceTriangles = 0, pieceVertices = 0, biggest = 0;
  for (const part of payload.parts) {
    const g = payload.geometries[part.geometry]!;
    pieceTriangles += g.index!.length / 3; pieceVertices += g.position.length / 3;
    biggest = Math.max(biggest, g.position.byteLength + (g.normal?.byteLength ?? 0) + (g.uv?.byteLength ?? 0) + g.index!.byteLength);
  }
  assert.equal(pieceTriangles, triangles, 'no triangle is lost or duplicated');
  assert.ok(pieceVertices < vertices * 1.2, `vertex duplication ${(pieceVertices / vertices).toFixed(2)}x`);
  assert.ok(biggest < 5 * 1024 * 1024, `largest piece ${(biggest / 1048576).toFixed(1)} MiB`);
  console.log(`50 MB GLB: ${vertices} vertices, ${triangles} triangles -> ${payload.parts.length} pieces, parsed in Node in ${(performance.now() - started).toFixed(0)} ms`);
});

test('splitGeometry: indexed pieces reference only their own vertices; non-indexed geometry is sliced without copying; unordered meshes are left whole', () => {
  const n = 500_000;
  const position = new Float32Array(n * 3).map((_, i) => i % 97), index = new Uint32Array(n * 3);
  for (let t = 0; t < n; t++) { index[t * 3] = t % n; index[t * 3 + 1] = (t + 1) % n; index[t * 3 + 2] = (t + 2) % n; }
  const pieces = splitGeometry({position, index, boundsMin: [0, 0, 0], boundsMax: [96, 96, 96]})!;
  assert.ok(pieces.length > 1);
  for (const p of pieces) { const max = p.position.length / 3; for (const i of p.index!) assert.ok(i < max); }
  const flat = splitGeometry({position: new Float32Array(3_000_000), boundsMin: [0, 0, 0], boundsMax: [0, 0, 0]})!;
  assert.ok(flat.length > 1);
  assert.equal(flat[0]!.position.buffer, flat[1]!.position.buffer, 'slices share the original buffer');
  // A mesh whose triangles touch vertices at random has no locality: splitting would duplicate most of it, so it stays whole.
  const m = 400_000, random = new Uint32Array(m * 3);
  let seed = 1; for (let i = 0; i < random.length; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; random[i] = seed % 150_000; }
  assert.equal(splitGeometry({position: new Float32Array(150_000 * 3), index: random, boundsMin: [0, 0, 0], boundsMax: [0, 0, 0]}), null);
});
