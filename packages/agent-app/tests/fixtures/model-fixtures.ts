/**
 * Procedurally generated 3D test models. Every byte comes from this file, so the models are original work released
 * under CC0 1.0 (public domain dedication) with the rest of the fixtures; no third-party asset is involved.
 * `node --experimental-transform-types scripts/make-model-fixtures.mjs <dir>` writes them to disk for screenshots and
 * the performance harness.
 */
import {deflateSync} from 'node:zlib';

const f32 = (values: number[]) => new Uint8Array(new Float32Array(values).buffer);
const u16 = (values: number[]) => new Uint8Array(new Uint16Array(values).buffer);
const u32 = (values: number[]) => new Uint8Array(new Uint32Array(values).buffer);
const pad4 = (bytes: Uint8Array, fill = 0): Uint8Array => { const n = (4 - (bytes.length % 4)) % 4; if (!n) return bytes; const out = new Uint8Array(bytes.length + n).fill(fill); out.set(bytes); return out; };
const concat = (parts: Uint8Array[]): Uint8Array => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

/** Unit cube centred on the origin: 24 vertices (flat normals + uv), 36 indices. */
export function cubeMesh(size = 1): {position: number[]; normal: number[]; uv: number[]; index: number[]} {
  const h = size / 2;
  const faces: Array<{n: [number, number, number]; u: [number, number, number]; v: [number, number, number]}> = [
    {n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0]}, {n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0]},
    {n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0]}, {n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0]},
    {n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1]}, {n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1]},
  ];
  const position: number[] = [], normal: number[] = [], uv: number[] = [], index: number[] = [];
  faces.forEach((f, i) => {
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      position.push(...[0, 1, 2].map(k => (f.n[k]! + f.u[k]! * a + f.v[k]! * b) * h));
      normal.push(...f.n);
      uv.push((a + 1) / 2, (b + 1) / 2);
    }
    const o = i * 4;
    index.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });
  return {position, normal, uv, index};
}

/** A PNG (RGBA8) checkerboard, encoded here so no binary asset is needed. */
export function checkerPng(size = 32, a: [number, number, number] = [214, 90, 60], b: [number, number, number] = [240, 232, 214]): Uint8Array {
  const raw = new Uint8Array((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const c = ((x >> 3) + (y >> 3)) % 2 ? a : b;
      raw.set([c[0], c[1], c[2], 255], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const crcTable = Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (bytes: Uint8Array) => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length), view = new DataView(out.buffer);
    view.setUint32(0, data.length); out.set(new TextEncoder().encode(type), 4); out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13), hv = new DataView(ihdr.buffer);
  hv.setUint32(0, size); hv.setUint32(4, size); ihdr.set([8, 6, 0, 0, 0], 8);
  return concat([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array())]);
}

interface GltfOptions { texture?: Uint8Array | null; external?: boolean; extraJson?: (json: any) => void; mesh?: {position: number[]; normal: number[]; uv: number[]; index: number[]}; baseColor?: [number, number, number, number] }

/** A glTF 2.0 cube (PBR material, optional embedded or external texture). Returns the JSON and the BIN payload. */
export function cubeGltf(options: GltfOptions = {}): {json: any; bin: Uint8Array; image?: Uint8Array} {
  const mesh = options.mesh ?? cubeMesh(1);
  const positions = f32(mesh.position), normals = f32(mesh.normal), uvs = f32(mesh.uv), indices = pad4(u16(mesh.index));
  const views = [positions, normals, uvs, indices];
  const image = options.texture ?? undefined;
  if (image && !options.external) views.push(pad4(image));
  const offsets: number[] = []; let offset = 0;
  for (const v of views) { offsets.push(offset); offset += v.length; }
  const bin = concat(views);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.position.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k]!, mesh.position[i + k]!); max[k] = Math.max(max[k]!, mesh.position[i + k]!); }
  const json: any = {
    asset: {version: '2.0', generator: 'muster-test-fixtures (CC0)'},
    scene: 0, scenes: [{nodes: [0]}], nodes: [{mesh: 0, name: 'Cube'}],
    meshes: [{name: 'Cube', primitives: [{attributes: {POSITION: 0, NORMAL: 1, TEXCOORD_0: 2}, indices: 3, material: 0}]}],
    materials: [{name: 'Paint', pbrMetallicRoughness: {baseColorFactor: options.baseColor ?? [0.8, 0.35, 0.2, 1], metallicFactor: 0.1, roughnessFactor: 0.6}}],
    accessors: [
      {bufferView: 0, componentType: 5126, count: mesh.position.length / 3, type: 'VEC3', min, max},
      {bufferView: 1, componentType: 5126, count: mesh.normal.length / 3, type: 'VEC3'},
      {bufferView: 2, componentType: 5126, count: mesh.uv.length / 2, type: 'VEC2'},
      {bufferView: 3, componentType: 5123, count: mesh.index.length, type: 'SCALAR'},
    ],
    bufferViews: [
      {buffer: 0, byteOffset: offsets[0], byteLength: positions.length, target: 34962},
      {buffer: 0, byteOffset: offsets[1], byteLength: normals.length, target: 34962},
      {buffer: 0, byteOffset: offsets[2], byteLength: uvs.length, target: 34962},
      {buffer: 0, byteOffset: offsets[3], byteLength: mesh.index.length * 2, target: 34963},
    ],
    buffers: [{byteLength: bin.length, ...(options.external ? {uri: 'cube.bin'} : {})}],
  };
  if (image) {
    json.samplers = [{magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497}];
    json.textures = [{sampler: 0, source: 0}];
    json.materials[0].pbrMetallicRoughness.baseColorTexture = {index: 0};
    if (options.external) json.images = [{uri: 'textures/checker.png'}];
    else { json.images = [{bufferView: 4, mimeType: 'image/png'}]; json.bufferViews.push({buffer: 0, byteOffset: offsets[4], byteLength: image.length}); }
  }
  options.extraJson?.(json);
  return {json, bin, image: options.external ? image : undefined};
}

export function glbFrom(json: any, bin: Uint8Array): Uint8Array {
  const jsonBytes = pad4(new TextEncoder().encode(JSON.stringify(json)), 0x20), binBytes = pad4(bin);
  const total = 12 + 8 + jsonBytes.length + 8 + binBytes.length;
  const out = new Uint8Array(total), view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length, true); view.setUint32(16, 0x4e4f534a, true); out.set(jsonBytes, 20);
  const o = 20 + jsonBytes.length;
  view.setUint32(o, binBytes.length, true); view.setUint32(o + 4, 0x004e4942, true); out.set(binBytes, o + 8);
  return out;
}

export const cubeGlb = (options: GltfOptions = {}) => { const {json, bin} = cubeGltf(options); return glbFrom(json, bin); };

/** UV sphere as an indexed mesh, for STL/PLY/OBJ/FBX variety. */
export function sphereMesh(radius = 1, rings = 16, segments = 24): {position: number[]; normal: number[]; uv: number[]; index: number[]} {
  const position: number[] = [], normal: number[] = [], uv: number[] = [], index: number[] = [];
  for (let r = 0; r <= rings; r++) {
    const v = r / rings, phi = v * Math.PI;
    for (let s = 0; s <= segments; s++) {
      const u = s / segments, theta = u * Math.PI * 2;
      const n = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
      position.push(n[0]! * radius, n[1]! * radius, n[2]! * radius); normal.push(...n); uv.push(u, 1 - v);
    }
  }
  for (let r = 0; r < rings; r++) for (let s = 0; s < segments; s++) {
    const a = r * (segments + 1) + s, b = a + segments + 1;
    index.push(a, b, a + 1, b, b + 1, a + 1);
  }
  return {position, normal, uv, index};
}

export function objCube(withMaterial = false): string {
  const m = cubeMesh(1);
  const lines = ['# muster test fixture (CC0)', ...(withMaterial ? ['mtllib cube.mtl', 'usemtl Painted'] : []), 'o Cube'];
  for (let i = 0; i < m.position.length; i += 3) lines.push(`v ${m.position[i]} ${m.position[i + 1]} ${m.position[i + 2]}`);
  for (let i = 0; i < m.uv.length; i += 2) lines.push(`vt ${m.uv[i]} ${m.uv[i + 1]}`);
  for (let i = 0; i < m.normal.length; i += 3) lines.push(`vn ${m.normal[i]} ${m.normal[i + 1]} ${m.normal[i + 2]}`);
  for (let i = 0; i < m.index.length; i += 3) lines.push('f ' + [0, 1, 2].map(k => { const n = m.index[i + k]! + 1; return `${n}/${n}/${n}`; }).join(' '));
  return lines.join('\n') + '\n';
}
export const cubeMtl = (texture = 'textures/checker.png') => `# muster test fixture (CC0)\nnewmtl Painted\nKd 0.8 0.35 0.2\nKs 0.1 0.1 0.1\nNs 30\nmap_Kd ${texture}\n`;

export function stlBinary(mesh = sphereMesh(1, 12, 16)): Uint8Array {
  const tris = mesh.index.length / 3, out = new Uint8Array(84 + tris * 50), view = new DataView(out.buffer);
  out.set(new TextEncoder().encode('muster test fixture (CC0)'), 0);
  view.setUint32(80, tris, true);
  for (let t = 0; t < tris; t++) {
    const o = 84 + t * 50, ids = [0, 1, 2].map(k => mesh.index[t * 3 + k]!);
    const p = ids.map(i => [mesh.position[i * 3]!, mesh.position[i * 3 + 1]!, mesh.position[i * 3 + 2]!]);
    const e1 = [p[1]![0]! - p[0]![0]!, p[1]![1]! - p[0]![1]!, p[1]![2]! - p[0]![2]!], e2 = [p[2]![0]! - p[0]![0]!, p[2]![1]! - p[0]![1]!, p[2]![2]! - p[0]![2]!];
    const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    const len = Math.hypot(...n) || 1;
    n.forEach((c, k) => view.setFloat32(o + k * 4, c / len, true));
    p.forEach((v, i) => v.forEach((c, k) => view.setFloat32(o + 12 + i * 12 + k * 4, c, true)));
  }
  return out;
}
export function stlAscii(): string {
  const m = cubeMesh(1), lines = ['solid cube'];
  for (let t = 0; t < m.index.length; t += 3) {
    const n = m.normal.slice(m.index[t]! * 3, m.index[t]! * 3 + 3);
    lines.push(`facet normal ${n.join(' ')}`, ' outer loop');
    for (let k = 0; k < 3; k++) lines.push(`  vertex ${m.position.slice(m.index[t + k]! * 3, m.index[t + k]! * 3 + 3).join(' ')}`);
    lines.push(' endloop', 'endfacet');
  }
  lines.push('endsolid cube');
  return lines.join('\n') + '\n';
}

export function plyBinary(mesh = sphereMesh(1, 10, 14), colors = true): Uint8Array {
  const vertexCount = mesh.position.length / 3, faces = mesh.index.length / 3;
  const header = `ply\nformat binary_little_endian 1.0\ncomment muster test fixture (CC0)\nelement vertex ${vertexCount}\nproperty float x\nproperty float y\nproperty float z\nproperty float nx\nproperty float ny\nproperty float nz\n${colors ? 'property uchar red\nproperty uchar green\nproperty uchar blue\n' : ''}element face ${faces}\nproperty list uchar int vertex_indices\nend_header\n`;
  const stride = 24 + (colors ? 3 : 0), head = new TextEncoder().encode(header);
  const body = new Uint8Array(vertexCount * stride + faces * 13), view = new DataView(body.buffer);
  for (let i = 0; i < vertexCount; i++) {
    const o = i * stride;
    for (let k = 0; k < 3; k++) { view.setFloat32(o + k * 4, mesh.position[i * 3 + k]!, true); view.setFloat32(o + 12 + k * 4, mesh.normal[i * 3 + k]!, true); }
    if (colors) { body[o + 24] = Math.round((mesh.normal[i * 3]! * 0.5 + 0.5) * 255); body[o + 25] = Math.round((mesh.normal[i * 3 + 1]! * 0.5 + 0.5) * 255); body[o + 26] = Math.round((mesh.normal[i * 3 + 2]! * 0.5 + 0.5) * 255); }
  }
  let o = vertexCount * stride;
  for (let f = 0; f < faces; f++) { body[o++] = 3; for (let k = 0; k < 3; k++) { view.setInt32(o, mesh.index[f * 3 + k]!, true); o += 4; } }
  return concat([head, body]);
}
export function plyPointCloud(points = 500): string {
  const lines = ['ply', 'format ascii 1.0', `element vertex ${points}`, 'property float x', 'property float y', 'property float z', 'end_header'];
  for (let i = 0; i < points; i++) { const t = i / points * Math.PI * 8; lines.push(`${Math.cos(t) * (0.2 + i / points)} ${i / points * 2 - 1} ${Math.sin(t) * (0.2 + i / points)}`); }
  return lines.join('\n') + '\n';
}

/** ASCII FBX 7.4 with one mesh (a cube) and one material. */
export function fbxAsciiCube(texture?: string): string {
  const m = cubeMesh(1);
  const polygons: number[] = [];
  for (let i = 0; i < m.index.length; i += 3) polygons.push(m.index[i]!, m.index[i + 1]!, -(m.index[i + 2]! + 1));
  const texNodes = texture ? `
	Texture: 4000, "Texture::Checker", "" {
		Type: "TextureVideoClip"
		Version: 202
		TextureName: "Texture::Checker"
		FileName: "${texture}"
		RelativeFilename: "${texture}"
	}
	Video: 5000, "Video::Checker", "Clip" {
		Type: "Clip"
		FileName: "${texture}"
		RelativeFilename: "${texture}"
	}` : '';
  return `; FBX 7.4.0 project file
; Generated by the Muster CC0 test fixtures
FBXHeaderExtension:  {
	FBXHeaderVersion: 1003
	FBXVersion: 7400
}
GlobalSettings:  {
	Version: 1000
	Properties70:  {
		P: "UpAxis", "int", "Integer", "",1
		P: "UpAxisSign", "int", "Integer", "",1
		P: "FrontAxis", "int", "Integer", "",2
		P: "FrontAxisSign", "int", "Integer", "",1
		P: "CoordAxis", "int", "Integer", "",0
		P: "CoordAxisSign", "int", "Integer", "",1
		P: "UnitScaleFactor", "double", "Number", "",1
	}
}
Objects:  {
	Geometry: 1000, "Geometry::Cube", "Mesh" {
		Vertices: *${m.position.length} {
			a: ${m.position.join(',')}
		}
		PolygonVertexIndex: *${polygons.length} {
			a: ${polygons.join(',')}
		}
		GeometryVersion: 124
		LayerElementNormal: 0 {
			Version: 101
			Name: ""
			MappingInformationType: "ByVertice"
			ReferenceInformationType: "Direct"
			Normals: *${m.normal.length} {
				a: ${m.normal.join(',')}
			}
		}
		LayerElementUV: 0 {
			Version: 101
			Name: "UVMap"
			MappingInformationType: "ByVertice"
			ReferenceInformationType: "Direct"
			UV: *${m.uv.length} {
				a: ${m.uv.join(',')}
			}
		}
		Layer: 0 {
			Version: 100
			LayerElement:  {
				Type: "LayerElementNormal"
				TypedIndex: 0
			}
			LayerElement:  {
				Type: "LayerElementUV"
				TypedIndex: 0
			}
		}
	}
	Model: 2000, "Model::Cube", "Mesh" {
		Version: 232
		Properties70:  {
			P: "Lcl Translation", "Lcl Translation", "", "A",0,0,0
		}
	}
	Material: 3000, "Material::Paint", "" {
		Version: 102
		ShadingModel: "phong"
		Properties70:  {
			P: "DiffuseColor", "Color", "", "A",0.8,0.35,0.2
		}
	}${texNodes}
}
Connections:  {
	C: "OO",2000,0
	C: "OO",1000,2000
	C: "OO",3000,2000${texture ? `
	C: "OP",4000,3000, "DiffuseColor"
	C: "OO",5000,4000` : ''}
}
`;
}

/** A terrain-like GLB of roughly `targetBytes`, for the large-model budget. Positions + normals + uv + 32-bit indices. */
export function terrainGlb(targetBytes: number): {glb: Uint8Array; vertices: number; triangles: number} {
  // bytes per vertex = 32 (pos+normal+uv); per quad ~ 24 index bytes + 32 vertex bytes => ~56 bytes per grid cell.
  const n = Math.max(8, Math.floor(Math.sqrt(targetBytes / 56)));
  const vertices = (n + 1) * (n + 1);
  const position = new Float32Array(vertices * 3), normal = new Float32Array(vertices * 3), uv = new Float32Array(vertices * 2);
  const height = (x: number, z: number) => Math.sin(x * 3.1) * Math.cos(z * 2.3) * 0.25 + Math.sin(x * 11 + z * 7) * 0.03;
  for (let z = 0; z <= n; z++) for (let x = 0; x <= n; x++) {
    const i = z * (n + 1) + x, fx = x / n * 2 - 1, fz = z / n * 2 - 1, e = 1e-3;
    position.set([fx, height(fx, fz), fz], i * 3);
    const nx = height(fx - e, fz) - height(fx + e, fz), nz = height(fx, fz - e) - height(fx, fz + e), len = Math.hypot(nx, 2 * e, nz);
    normal.set([nx / len, 2 * e / len, nz / len], i * 3);
    uv.set([x / n, 1 - z / n], i * 2);
  }
  const index = new Uint32Array(n * n * 6);
  let o = 0;
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    const a = z * (n + 1) + x, b = a + n + 1;
    index.set([a, b, a + 1, b, b + 1, a + 1], o); o += 6;
  }
  const views = [new Uint8Array(position.buffer), new Uint8Array(normal.buffer), new Uint8Array(uv.buffer), new Uint8Array(index.buffer)];
  const offsets: number[] = []; let offset = 0;
  for (const v of views) { offsets.push(offset); offset += v.length; }
  const bin = concat(views);
  const json = {
    asset: {version: '2.0', generator: 'muster-test-fixtures (CC0)'}, scene: 0, scenes: [{nodes: [0]}], nodes: [{mesh: 0}],
    meshes: [{primitives: [{attributes: {POSITION: 0, NORMAL: 1, TEXCOORD_0: 2}, indices: 3, material: 0}]}],
    materials: [{pbrMetallicRoughness: {baseColorFactor: [0.45, 0.62, 0.5, 1], metallicFactor: 0, roughnessFactor: 0.8}}],
    accessors: [
      {bufferView: 0, componentType: 5126, count: vertices, type: 'VEC3', min: [-1, -0.3, -1], max: [1, 0.3, 1]},
      {bufferView: 1, componentType: 5126, count: vertices, type: 'VEC3'},
      {bufferView: 2, componentType: 5126, count: vertices, type: 'VEC2'},
      {bufferView: 3, componentType: 5125, count: index.length, type: 'SCALAR'},
    ],
    bufferViews: views.map((v, i) => ({buffer: 0, byteOffset: offsets[i], byteLength: v.length, target: i === 3 ? 34963 : 34962})),
    buffers: [{byteLength: bin.length}],
  };
  return {glb: glbFrom(json, bin), vertices, triangles: n * n * 2};
}
