/**
 * Bounded local image asset access for `files.asset`. Same root confinement as
 * files.read (resolveInside), plus:
 *  - O_NOFOLLOW open of the resolved path closes the resolve->open race where
 *    the final component is swapped for a symlink; fstat re-checks regular file.
 *  - Only raster PNG/JPEG/GIF/WebP, verified by signature. Extension must match
 *    sniffed content; SVG/PDF/executables/unknown formats are rejected, never
 *    rendered.
 *  - Byte cap (8 MiB) and dimension/pixel budget guard renderer decode cost.
 * Output is a base64 data: URL; no filesystem paths or file:// URLs leak out.
 */
import { constants, promises as fs } from 'node:fs';
import { extname } from 'node:path';
import { resolveInside } from './paths.ts';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_DIMENSION = 8192;
const MAX_PIXELS = 16_777_216; // ~64 MiB decoded RGBA

type Format = 'png' | 'jpeg' | 'gif' | 'webp';
const MIME: Record<Format, string> = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const EXTENSIONS: Record<string, Format> = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.gif': 'gif', '.webp': 'webp' };

function corrupt(format: string): never {
  throw new Error(`Truncated or corrupt ${format} image.`);
}

/** Identify the container by magic bytes alone; null for anything else. */
function sniff(buffer: Buffer): Format | null {
  if (buffer.length >= 12) {
    if (buffer.readUInt32BE(0) === 0x89504e47 && buffer.readUInt32BE(4) === 0x0d0a1a0a) return 'png';
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
    const head6 = buffer.toString('latin1', 0, 6);
    if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'gif';
    if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  }
  return null;
}

function pngSize(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 33 || buffer.toString('latin1', 12, 16) !== 'IHDR') corrupt('PNG');
  // Trailer check catches truncation: a complete PNG ends with an IEND chunk.
  if (buffer.toString('latin1', buffer.length - 8, buffer.length - 4) !== 'IEND') corrupt('PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function jpegSize(buffer: Buffer): { width: number; height: number } {
  if (buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9) corrupt('JPEG');
  let pos = 2;
  while (pos + 4 <= buffer.length) {
    if (buffer[pos] !== 0xff) corrupt('JPEG');
    const marker = buffer[pos + 1];
    if (marker === 0xff) { pos += 1; continue; } // fill byte
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { pos += 2; continue; } // no payload
    const length = buffer.readUInt16BE(pos + 2);
    if (length < 2 || pos + 2 + length > buffer.length) corrupt('JPEG');
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      if (length < 7) corrupt('JPEG');
      return { width: buffer.readUInt16BE(pos + 7), height: buffer.readUInt16BE(pos + 5) };
    }
    if (marker === 0xda) break; // scan data before any frame header
    pos += 2 + length;
  }
  corrupt('JPEG');
}

function gifSize(buffer: Buffer): { width: number; height: number } {
  if (buffer[buffer.length - 1] !== 0x3b) corrupt('GIF'); // trailer byte
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

function webpSize(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 30 || buffer.readUInt32LE(4) + 8 > buffer.length) corrupt('WebP');
  const fourcc = buffer.toString('latin1', 12, 16);
  if (fourcc === 'VP8X') {
    return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  }
  if (fourcc === 'VP8L') {
    if (buffer[20] !== 0x2f) corrupt('WebP');
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (fourcc === 'VP8 ') {
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) corrupt('WebP');
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  corrupt('WebP');
}

const SIZERS: Record<Format, (buffer: Buffer) => { width: number; height: number }> = {
  png: pngSize, jpeg: jpegSize, gif: gifSize, webp: webpSize,
};

export interface AssetResult { mime: string; dataUrl: string; size: number; width: number; height: number }

export async function readAsset(root: string, rel: string): Promise<AssetResult> {
  const expected = EXTENSIONS[extname(rel).toLowerCase()];
  if (!expected) throw new Error(`Unsupported image type: ${rel}. Only PNG, JPEG, GIF, and WebP are allowed.`);
  const abs = await resolveInside(root, rel);
  // O_NOFOLLOW: resolveInside already returned a realpath, so a symlink at the
  // final component here means it was swapped after resolution — refuse it.
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
    if (stat.size > MAX_BYTES) throw new Error(`Image exceeds ${MAX_BYTES / (1024 * 1024)} MiB limit: ${rel}`);
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== buffer.length) corrupt('image');
    const format = sniff(buffer);
    if (!format) throw new Error(`Not a supported raster image: ${rel}`);
    if (format !== expected) throw new Error(`Extension/content mismatch: ${rel} contains ${MIME[format]} data.`);
    const { width, height } = SIZERS[format](buffer);
    if (width < 1 || height < 1) corrupt(MIME[format]);
    if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
      throw new Error(`Image dimensions ${width}x${height} exceed the allowed budget.`);
    }
    const mime = MIME[format];
    return { mime, dataUrl: `data:${mime};base64,${buffer.toString('base64')}`, size: buffer.length, width, height };
  } finally {
    await handle.close();
  }
}
