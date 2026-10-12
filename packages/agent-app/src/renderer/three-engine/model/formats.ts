export type ModelFormat = 'glb' | 'gltf' | 'obj' | 'stl' | 'ply' | 'fbx';

export const MODEL_FORMATS: readonly ModelFormat[] = ['glb', 'gltf', 'obj', 'stl', 'ply', 'fbx'];
export const MODEL_EXTENSION_PATTERN = /\.(glb|gltf|obj|stl|ply|fbx)$/i;

export function modelFormatOf(path: string): ModelFormat | null {
  const match = MODEL_EXTENSION_PATTERN.exec(path);
  return match ? (match[1]!.toLowerCase() as ModelFormat) : null;
}

export const FORMAT_LABEL: Record<ModelFormat, string> = {glb: 'GLB', gltf: 'glTF', obj: 'OBJ', stl: 'STL', ply: 'PLY', fbx: 'FBX'};

/** Largest file the viewer will open; matches the reader's cap in runtime/file-models.ts. */
export const MAX_MODEL_BYTES = 128 * 1024 * 1024;

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Resolve a reference found inside a model (a texture, a .bin, an .mtl) against the model's own path.
 * Returns a folder-relative path, or null when the reference must not be followed: another scheme (http:, file:,
 * data: are all refused here; data: payloads are decoded in the parser, never fetched), an absolute path, or a
 * path that climbs out of the folder root. The host re-checks confinement; this is the first of two gates.
 */
export function resolveCompanionPath(modelPath: string, reference: string): string | null {
  let ref = reference.trim();
  if (!ref || ref.includes('\0')) return null;
  try { ref = decodeURIComponent(ref); } catch { return null; }
  ref = ref.replace(/\\/g, '/').replace(/[?#].*$/, '');
  if (!ref || SCHEME.test(ref) || ref.startsWith('/') || /^[a-z]:/i.test(ref)) return null;
  const base = modelPath.replace(/\\/g, '/').split('/').slice(0, -1);
  const out = [...base];
  for (const part of ref.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (!out.length) return null; out.pop(); } else out.push(part);
  }
  return out.length ? out.join('/') : null;
}
