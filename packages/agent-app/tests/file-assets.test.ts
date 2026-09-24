import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { readAsset } from '../src/runtime/file-assets.ts';

let root: string;
let outside: string;

// --- Minimal valid fixtures, built byte-by-byte ---

function crc32(buffer: Buffer): number {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 0; // 8-bit grayscale
  const raw = Buffer.alloc(height * (1 + width)); // filter byte + pixels per row
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
function gif(width: number, height: number): Buffer {
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(width, 0); screen.writeUInt16LE(height, 2);
  return Buffer.concat([
    Buffer.from('GIF89a', 'latin1'), screen,
    Buffer.from([0x2c]), Buffer.alloc(4), screen.subarray(0, 4), Buffer.from([0x00]), // image descriptor
    Buffer.from([0x02, 0x02, 0x44, 0x01, 0x00]), // 2-bit LZW minimal data
    Buffer.from([0x3b]),
  ]);
}
function jpeg(width: number, height: number): Buffer {
  const sof = Buffer.alloc(19);
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08]);
  sof.writeUInt16BE(height, 5); sof.writeUInt16BE(width, 7);
  sof.set([0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00], 9);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}
function webpLossless(width: number, height: number): Buffer {
  const bits = (width - 1) | ((height - 1) << 14);
  const payload = Buffer.alloc(10);
  payload[0] = 0x2f; payload.writeUInt32LE(bits >>> 0, 1);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(4 + 8 + payload.length, 4);
  header.write('WEBP', 8, 'latin1');
  const chunk = Buffer.alloc(8);
  chunk.write('VP8L', 0, 'latin1'); chunk.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, chunk, payload]);
}

before(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'assets-root-'));
  outside = await fs.mkdtemp(join(tmpdir(), 'assets-outside-'));
  await fs.writeFile(join(root, 'ok.png'), png(3, 2));
  await fs.writeFile(join(root, 'ok.gif'), gif(4, 5));
  await fs.writeFile(join(root, 'ok.jpg'), jpeg(6, 7));
  await fs.writeFile(join(root, 'ok.webp'), webpLossless(8, 9));
  await fs.writeFile(join(outside, 'secret.png'), png(1, 1));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

test('decodes each supported format with correct metadata', async () => {
  const cases: Array<[string, string, number, number]> = [
    ['ok.png', 'image/png', 3, 2],
    ['ok.gif', 'image/gif', 4, 5],
    ['ok.jpg', 'image/jpeg', 6, 7],
    ['ok.webp', 'image/webp', 8, 9],
  ];
  for (const [name, mime, width, height] of cases) {
    const result = await readAsset(root, name);
    assert.equal(result.mime, mime, name);
    assert.equal(result.width, width, name);
    assert.equal(result.height, height, name);
    assert.equal(result.size, (await fs.stat(join(root, name))).size, name);
    assert.ok(result.dataUrl.startsWith(`data:${mime};base64,`), name);
    // Round-trip: data URL carries the exact file bytes.
    const decoded = Buffer.from(result.dataUrl.slice(result.dataUrl.indexOf(',') + 1), 'base64');
    assert.deepEqual(decoded, await fs.readFile(join(root, name)), name);
  }
});

test('rejects traversal and absolute escapes', async () => {
  await assert.rejects(readAsset(root, '../' + 'secret.png'), /escapes folder root/);
  await assert.rejects(readAsset(root, join(outside, 'secret.png')), /escapes folder root/);
});

test('rejects symlink pointing outside root', async () => {
  await fs.symlink(join(outside, 'secret.png'), join(root, 'sneaky.png'));
  await assert.rejects(readAsset(root, 'sneaky.png'), /outside folder root/);
});

test('accepts symlink staying inside root', async () => {
  await fs.symlink(join(root, 'ok.png'), join(root, 'alias.png'));
  const result = await readAsset(root, 'alias.png');
  assert.equal(result.mime, 'image/png');
});

test('rejects unsupported extensions without touching content', async () => {
  await fs.writeFile(join(root, 'doc.pdf'), '%PDF-1.4');
  await fs.writeFile(join(root, 'tool.exe'), Buffer.from([0x4d, 0x5a]));
  for (const name of ['doc.pdf', 'tool.exe', 'noext', 'photo.heic']) {
    await assert.rejects(readAsset(root, name), /Unsupported image type/);
  }
});

test('rejects extension/content mismatch', async () => {
  await fs.writeFile(join(root, 'masquerade.png'), gif(1, 1));
  await assert.rejects(readAsset(root, 'masquerade.png'), /mismatch/);
});

test('rejects non-image bytes behind an image extension', async () => {
  await fs.writeFile(join(root, 'script.png'), '#!/bin/sh\necho pwned\n');
  await assert.rejects(readAsset(root, 'script.png'), /Not a supported raster image/);
});

test('rejects oversize files before reading them', async () => {
  const big = join(root, 'big.png');
  const handle = await fs.open(big, 'w');
  await handle.truncate(8 * 1024 * 1024 + 1); // sparse; no 8 MiB write
  await handle.close();
  await assert.rejects(readAsset(root, 'big.png'), /8 MiB limit/);
});

test('rejects images exceeding the pixel budget', async () => {
  // Tiny file claiming enormous dimensions: the decompression-bomb shape.
  await fs.writeFile(join(root, 'bomb.gif'), gif(65000, 65000));
  await assert.rejects(readAsset(root, 'bomb.gif'), /exceed the allowed budget/);
  await fs.writeFile(join(root, 'wide.jpg'), jpeg(9000, 1));
  await assert.rejects(readAsset(root, 'wide.jpg'), /exceed the allowed budget/);
});

test('rejects truncated and corrupt images', async () => {
  await fs.writeFile(join(root, 'cut.png'), png(3, 2).subarray(0, 20));
  await assert.rejects(readAsset(root, 'cut.png'), /Truncated or corrupt/);
  await fs.writeFile(join(root, 'cut.gif'), gif(4, 5).subarray(0, 12)); // missing trailer
  await assert.rejects(readAsset(root, 'cut.gif'), /Truncated or corrupt/);
  const halfJpeg = jpeg(6, 7); // strip EOI marker
  await fs.writeFile(join(root, 'cut.jpg'), halfJpeg.subarray(0, halfJpeg.length - 2));
  await assert.rejects(readAsset(root, 'cut.jpg'), /Truncated or corrupt/);
  await fs.writeFile(join(root, 'cut.webp'), webpLossless(8, 9).subarray(0, 16));
  await assert.rejects(readAsset(root, 'cut.webp'), /Truncated or corrupt/);
  await fs.writeFile(join(root, 'zero.gif'), gif(0, 5));
  await assert.rejects(readAsset(root, 'zero.gif'), /Truncated or corrupt/);
});

test('rejects directories named like images', async () => {
  await fs.mkdir(join(root, 'dir.png'));
  await assert.rejects(readAsset(root, 'dir.png'), /EISDIR|Not a file/);
});

test('SVG is served as image/svg+xml with its declared size; scripts stay inert behind <img>', async () => {
  const svg = '<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40px"><script>alert(1)</script></svg>';
  await fs.writeFile(join(root, 'logo.svg'), svg);
  const result = await readAsset(root, 'logo.svg');
  assert.equal(result.mime, 'image/svg+xml');
  assert.ok(result.dataUrl.startsWith('data:image/svg+xml;base64,'));
  assert.deepEqual([result.width, result.height], [120, 40]);
  await fs.writeFile(join(root, 'box.svg'), '<svg viewBox="0 0 24 16" xmlns="http://www.w3.org/2000/svg"/>');
  assert.deepEqual(Object.values(await readAsset(root, 'box.svg')).slice(3), [24, 16]);
  await fs.writeFile(join(root, 'bare.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  assert.equal((await readAsset(root, 'bare.svg')).width, 0, 'no intrinsic size is measured by the renderer');
  await fs.writeFile(join(root, 'fake.svg'), '<html><body>not svg</body></html>');
  await assert.rejects(readAsset(root, 'fake.svg'), /Not a supported raster image/);
});

test('BMP and AVIF decode their dimensions', async () => {
  const bmp = Buffer.alloc(58); bmp.write('BM', 0, 'latin1'); bmp.writeUInt32LE(58, 2); bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(5, 18); bmp.writeInt32LE(-3, 22);
  await fs.writeFile(join(root, 'old.bmp'), bmp);
  const decodedBmp = await readAsset(root, 'old.bmp');
  assert.deepEqual([decodedBmp.mime, decodedBmp.width, decodedBmp.height], ['image/bmp', 5, 3]);
  const ftyp = Buffer.alloc(24); ftyp.writeUInt32BE(24, 0); ftyp.write('ftypavif', 4, 'latin1'); ftyp.write('mif1avif', 16, 'latin1');
  const ispe = Buffer.alloc(20); ispe.writeUInt32BE(20, 0); ispe.write('ispe', 4, 'latin1'); ispe.writeUInt32BE(640, 12); ispe.writeUInt32BE(480, 16);
  await fs.writeFile(join(root, 'next.avif'), Buffer.concat([ftyp, ispe]));
  const decodedAvif = await readAsset(root, 'next.avif');
  assert.deepEqual([decodedAvif.mime, decodedAvif.width, decodedAvif.height], ['image/avif', 640, 480]);
});

test('audio and video play from a signature-checked data URL', async () => {
  const wav = Buffer.alloc(44); wav.write('RIFF', 0, 'latin1'); wav.write('WAVE', 8, 'latin1');
  await fs.writeFile(join(root, 'take.wav'), wav);
  assert.equal((await readAsset(root, 'take.wav')).mime, 'audio/wav');
  const mp4 = Buffer.alloc(32); mp4.writeUInt32BE(32, 0); mp4.write('ftypisom', 4, 'latin1');
  await fs.writeFile(join(root, 'clip.mp4'), mp4);
  const video = await readAsset(root, 'clip.mp4');
  assert.equal(video.mime, 'video/mp4');
  assert.ok(video.dataUrl.startsWith('data:video/mp4;base64,'));
  await fs.writeFile(join(root, 'liar.mp3'), wav);
  await assert.rejects(readAsset(root, 'liar.mp3'), /Not a supported audio\/mpeg file/);
  const big = join(root, 'big.mov');
  const handle = await fs.open(big, 'w'); await handle.truncate(16 * 1024 * 1024 + 1); await handle.close();
  await assert.rejects(readAsset(root, 'big.mov'), /Media file exceeds 16 MiB limit/);
});
