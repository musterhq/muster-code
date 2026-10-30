/**
 * Bounded local 3D-model access for `files.modelChunk` / `attachments.modelChunk`.
 * Same root confinement as files.asset (resolveInside + O_NOFOLLOW + fstat regular-file check), plus:
 *  - Only model formats (glb, gltf, obj, stl, ply, fbx) and the companion files a model references
 *    (mtl, bin and common image textures). Anything else is refused, so this cannot read arbitrary files.
 *  - Reads are chunked (default 4 MiB, max 8 MiB): a 50 MB model crosses IPC as ~13 small structured clones, so
 *    no single renderer task has to deserialize the whole file. The renderer reassembles and hands the buffer
 *    to a Web Worker; nothing is parsed here.
 *  - A hard size cap (MAX_MODEL_BYTES) and a signature check on the first chunk for the binary formats.
 * No filesystem paths leave this module.
 */
import { constants, promises as fs } from 'node:fs';
import { extname } from 'node:path';
import { resolveInside } from './paths.ts';

export const MAX_MODEL_BYTES = 128 * 1024 * 1024;
export const DEFAULT_MODEL_CHUNK = 4 * 1024 * 1024;
export const MAX_MODEL_CHUNK = 8 * 1024 * 1024;

export const MODEL_EXTENSIONS = new Set(['.glb', '.gltf', '.obj', '.stl', '.ply', '.fbx']);
/** Files a model may pull in next to itself. Textures are decoded in the worker with createImageBitmap. */
export const COMPANION_EXTENSIONS = new Set(['.mtl', '.bin', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

export interface ModelChunk { size: number; offset: number; bytes: Uint8Array }

/** Signature of the formats that have one; text formats (obj, gltf, ascii stl) are validated by their parser. */
function signatureError(extension: string, head: Buffer): string | null {
  if (extension === '.glb' && head.toString('latin1', 0, 4) !== 'glTF') return 'Not a GLB file (missing glTF header).';
  if (extension === '.ply' && head.toString('latin1', 0, 3) !== 'ply') return 'Not a PLY file (missing ply header).';
  if (extension === '.fbx' && !head.toString('latin1', 0, 64).includes('FBX')) return 'Not an FBX file (missing FBX header).';
  return null;
}

export async function readModelChunk(root: string, rel: string, offset = 0, length = DEFAULT_MODEL_CHUNK): Promise<ModelChunk> {
  const extension = extname(rel).toLowerCase();
  if (!MODEL_EXTENSIONS.has(extension) && !COMPANION_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported 3D model file: ${rel}. Only glb, gltf, obj, stl, ply and fbx models and their textures are allowed.`);
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1) throw new Error('Invalid model read range.');
  const abs = await resolveInside(root, rel);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error(`Path changed to a symlink during read: ${rel}`);
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Not a file: ${rel}`);
    if (stat.size > MAX_MODEL_BYTES) throw new Error(`3D file exceeds ${MAX_MODEL_BYTES / (1024 * 1024)} MiB limit: ${rel}`);
    if (offset > stat.size) throw new Error('Model read range is past the end of the file.');
    const want = Math.min(length, MAX_MODEL_CHUNK, stat.size - offset);
    const buffer = Buffer.alloc(want);
    const { bytesRead } = want ? await handle.read(buffer, 0, want, offset) : { bytesRead: 0 };
    if (bytesRead !== want) throw new Error(`The file changed while it was being read: ${rel}`);
    if (offset === 0 && MODEL_EXTENSIONS.has(extension)) {
      if (stat.size === 0) throw new Error('This 3D file is empty.');
      const bad = signatureError(extension, buffer);
      if (bad) throw new Error(bad);
    }
    // Hand back a plain Uint8Array over an exact-size ArrayBuffer (not a slice of Node's pool).
    return { size: stat.size, offset, bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length) };
  } finally {
    await handle.close();
  }
}
