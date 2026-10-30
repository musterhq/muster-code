/** Draco and meshopt compressed GLB generators (CC0, built here from the cube in model-fixtures.ts with the encoders in devDependencies). */
import {createRequire} from 'node:module';
import {cubeMesh, glbFrom} from './model-fixtures.ts';

const require = createRequire(import.meta.url);
const concat = (parts: Uint8Array[]): Uint8Array => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const pad4 = (b: Uint8Array) => { const n = (4 - (b.length % 4)) % 4; if (!n) return b; const out = new Uint8Array(b.length + n); out.set(b); return out; };

export async function dracoCubeGlb(): Promise<Uint8Array> {
  const draco3d = require('draco3d');
  const draco = await draco3d.createEncoderModule({});
  const m = cubeMesh(1);
  const mesh = new draco.Mesh(), builder = new draco.MeshBuilder();
  builder.AddFacesToMesh(mesh, m.index.length / 3, new Uint32Array(m.index));
  const posId = builder.AddFloatAttributeToMesh(mesh, draco.POSITION, m.position.length / 3, 3, new Float32Array(m.position));
  const normalId = builder.AddFloatAttributeToMesh(mesh, draco.NORMAL, m.normal.length / 3, 3, new Float32Array(m.normal));
  const uvId = builder.AddFloatAttributeToMesh(mesh, draco.TEX_COORD, m.uv.length / 2, 2, new Float32Array(m.uv));
  const encoder = new draco.Encoder();
  encoder.SetSpeedOptions(5, 5);
  encoder.SetAttributeQuantization(draco.POSITION, 14); encoder.SetAttributeQuantization(draco.NORMAL, 10); encoder.SetAttributeQuantization(draco.TEX_COORD, 12);
  encoder.SetEncodingMethod(draco.MESH_EDGEBREAKER_ENCODING);
  const out = new draco.DracoInt8Array();
  const length = encoder.EncodeMeshToDracoBuffer(mesh, out);
  if (length <= 0) throw new Error('Draco encoding failed');
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = out.GetValue(i) & 255;
  draco.destroy(out); draco.destroy(encoder); draco.destroy(builder); draco.destroy(mesh);
  const bin = pad4(bytes);
  const json = {
    asset: {version: '2.0', generator: 'muster-test-fixtures (CC0)'}, extensionsUsed: ['KHR_draco_mesh_compression'], extensionsRequired: ['KHR_draco_mesh_compression'],
    scene: 0, scenes: [{nodes: [0]}], nodes: [{mesh: 0}],
    meshes: [{primitives: [{attributes: {POSITION: 0, NORMAL: 1, TEXCOORD_0: 2}, indices: 3, material: 0, extensions: {KHR_draco_mesh_compression: {bufferView: 0, attributes: {POSITION: posId, NORMAL: normalId, TEXCOORD_0: uvId}}}}]}],
    materials: [{pbrMetallicRoughness: {baseColorFactor: [0.2, 0.5, 0.85, 1], metallicFactor: 0, roughnessFactor: 0.5}}],
    accessors: [
      {componentType: 5126, count: 24, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5]},
      {componentType: 5126, count: 24, type: 'VEC3'}, {componentType: 5126, count: 24, type: 'VEC2'},
      {componentType: 5125, count: 36, type: 'SCALAR'},
    ],
    bufferViews: [{buffer: 0, byteOffset: 0, byteLength: bytes.length}], buffers: [{byteLength: bin.length}],
  };
  return glbFrom(json, bin);
}

export async function meshoptCubeGlb(): Promise<Uint8Array> {
  const {MeshoptEncoder} = await import('meshoptimizer');
  await MeshoptEncoder.ready;
  const m = cubeMesh(1);
  const positions = new Uint8Array(new Float32Array(m.position).buffer), normals = new Uint8Array(new Float32Array(m.normal).buffer), uvs = new Uint8Array(new Float32Array(m.uv).buffer);
  const indices = new Uint8Array(new Uint32Array(m.index).buffer);
  const exact = [
    MeshoptEncoder.encodeVertexBuffer(positions, 24, 12), MeshoptEncoder.encodeVertexBuffer(normals, 24, 12),
    MeshoptEncoder.encodeVertexBuffer(uvs, 24, 8), MeshoptEncoder.encodeIndexBuffer(indices, 36, 4),
  ];
  const encoded = exact; // byteLength in the extension is the exact encoded length; offsets stay 4-byte aligned below
  const offsets: number[] = []; let o = 0;
  for (const e of exact) { offsets.push(o); o += Math.ceil(e.length / 4) * 4; }
  const bin = concat(exact.map(pad4));
  const raw = [positions.length, normals.length, uvs.length, indices.length];
  const strides = [12, 12, 8, 4];
  const json = {
    asset: {version: '2.0', generator: 'muster-test-fixtures (CC0)'}, extensionsUsed: ['EXT_meshopt_compression'], extensionsRequired: ['EXT_meshopt_compression'],
    scene: 0, scenes: [{nodes: [0]}], nodes: [{mesh: 0}],
    meshes: [{primitives: [{attributes: {POSITION: 0, NORMAL: 1, TEXCOORD_0: 2}, indices: 3, material: 0}]}],
    materials: [{pbrMetallicRoughness: {baseColorFactor: [0.3, 0.7, 0.4, 1], metallicFactor: 0, roughnessFactor: 0.5}}],
    accessors: [
      {bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5]},
      {bufferView: 1, componentType: 5126, count: 24, type: 'VEC3'}, {bufferView: 2, componentType: 5126, count: 24, type: 'VEC2'},
      {bufferView: 3, componentType: 5125, count: 36, type: 'SCALAR'},
    ],
    bufferViews: encoded.map((e, i) => ({
      buffer: 0, byteOffset: 0, byteLength: raw[i], byteStride: i === 3 ? undefined : strides[i],
      extensions: {EXT_meshopt_compression: {buffer: 0, byteOffset: offsets[i], byteLength: e.length, byteStride: strides[i], count: i === 3 ? 36 : 24, mode: i === 3 ? 'TRIANGLES' : 'ATTRIBUTES'}},
    })),
    buffers: [{byteLength: bin.length}, {byteLength: Math.max(...raw), extensions: {EXT_meshopt_compression: {fallback: true}}}],
  };
  // Every bufferView's own `buffer` is the (absent) fallback buffer, as the extension specifies.
  json.bufferViews.forEach(view => { view.buffer = 1; });
  return glbFrom(json, bin);
}
