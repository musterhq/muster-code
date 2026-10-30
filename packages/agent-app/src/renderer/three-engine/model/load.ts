import {MAX_MODEL_BYTES} from './formats.ts';
import {ModelParseError} from './payload.ts';

export const MODEL_CHUNK_BYTES = 4 * 1024 * 1024;

export interface ModelChunkResult { size: number; bytes: Uint8Array }
export type ChunkReader = (offset: number, length: number) => Promise<ModelChunkResult>;

/**
 * Read a whole file as a sequence of IPC chunks. Each chunk is a separate small structured clone, so no single task has to
 * deserialize (or the host serialize) the entire file, which is what keeps a 50 MB model from freezing the window.
 * Resolves to an ArrayBuffer that is ready to be transferred to the parse worker.
 */
export async function readAllChunks(read: ChunkReader, options: {signal?: AbortSignal; onProgress?: (fraction: number) => void; chunk?: number} = {}): Promise<ArrayBuffer> {
  const chunk = options.chunk ?? MODEL_CHUNK_BYTES;
  const first = await read(0, chunk);
  if (first.size > MAX_MODEL_BYTES) throw new ModelParseError('This 3D file is larger than the 128 MiB preview limit.', 'too-large');
  if (first.size === 0) throw new ModelParseError('This 3D file is empty.', 'empty');
  const out = new Uint8Array(first.size);
  out.set(first.bytes, 0);
  let offset = first.bytes.length;
  options.onProgress?.(offset / first.size);
  while (offset < first.size) {
    if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const next = await read(offset, Math.min(chunk, first.size - offset));
    if (!next.bytes.length) throw new ModelParseError('The file changed while it was being read.');
    out.set(next.bytes, offset);
    offset += next.bytes.length;
    options.onProgress?.(offset / first.size);
  }
  return out.buffer;
}

/** A companion read (texture, .bin, .mtl) is capped lower: these are small relative to the model. */
export async function readCompanion(read: (path: string, offset: number, length: number) => Promise<ModelChunkResult>, path: string): Promise<Uint8Array | null> {
  try {
    const bytes = await readAllChunks((offset, length) => read(path, offset, length));
    return new Uint8Array(bytes);
  } catch (error) {
    if (error instanceof ModelParseError && error.code === 'empty') return null;
    return null;
  }
}
