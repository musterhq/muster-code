import type {BufferGeometry, Material, Object3D, Texture} from 'three';

/** Texture-valued material properties (standard, physical, basic, phong, matcap). */
const TEXTURE_SLOTS = ['map', 'lightMap', 'aoMap', 'emissiveMap', 'bumpMap', 'normalMap', 'displacementMap', 'roughnessMap', 'metalnessMap', 'alphaMap', 'envMap',
  'specularMap', 'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap', 'sheenColorMap', 'sheenRoughnessMap', 'transmissionMap', 'thicknessMap',
  'iridescenceMap', 'iridescenceThicknessMap', 'specularIntensityMap', 'specularColorMap', 'anisotropyMap', 'gradientMap', 'matcap'] as const;

/** Release the decoded pixels of a texture's source (ImageBitmap / VideoFrame) as well as its GPU copy. */
export function disposeTexture(texture: Texture | null | undefined): void {
  if (!texture) return;
  const image = texture.image as {close?: () => void} | undefined;
  texture.dispose();
  try { image?.close?.(); } catch { /* already closed */ }
}

export function disposeMaterial(material: Material): void {
  const record = material as unknown as Record<string, Texture | undefined>;
  for (const slot of TEXTURE_SLOTS) disposeTexture(record[slot]);
  material.dispose();
}

export interface DisposeOptions { geometries?: boolean; materials?: boolean }

/** Dispose everything below `root` (inclusive): geometries, materials and every texture slot. Safe to call twice. */
export function disposeObject(root: Object3D, options: DisposeOptions = {}): void {
  const geometries = new Set<BufferGeometry>(), materials = new Set<Material>();
  root.traverse(object => {
    const mesh = object as Object3D & {geometry?: BufferGeometry; material?: Material | Material[]};
    if (mesh.geometry && options.geometries !== false) geometries.add(mesh.geometry);
    if (mesh.material && options.materials !== false) for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(m);
  });
  for (const g of geometries) g.dispose();
  for (const m of materials) disposeMaterial(m);
}
