/** files.modelChunk / attachments.modelChunk reader: confinement, allowlist, chunking, signatures. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readModelChunk, MAX_MODEL_CHUNK} from '../src/runtime/file-models.ts';
import {isCommandName} from '../src/main/commands.ts';
import {createAgentService} from '../src/runtime/service.ts';
import {cubeGlb, stlBinary, plyBinary, checkerPng} from './fixtures/model-fixtures.ts';

const root = mkdtempSync(join(tmpdir(), 'muster-model-'));
const outside = mkdtempSync(join(tmpdir(), 'muster-outside-'));
mkdirSync(join(root, 'sub'));
writeFileSync(join(root, 'cube.glb'), cubeGlb());
writeFileSync(join(root, 'sub', 'tex.png'), checkerPng(16));
writeFileSync(join(root, 'sphere.stl'), stlBinary());
writeFileSync(join(root, 'notes.txt'), 'secret');
writeFileSync(join(root, 'fake.glb'), 'not a glb at all');
writeFileSync(join(root, 'empty.glb'), '');
writeFileSync(join(root, 'bad.ply'), 'hello');
writeFileSync(join(outside, 'leak.glb'), cubeGlb());
writeFileSync(join(outside, 'leak.png'), checkerPng(8));
symlinkSync(join(outside, 'leak.glb'), join(root, 'linked.glb'));
symlinkSync(outside, join(root, 'dir-link'));
test.after(() => { rmSync(root, {recursive: true, force: true}); rmSync(outside, {recursive: true, force: true}); });

test('commands are registered for both surfaces', () => {
  assert.ok(isCommandName('files.modelChunk'));
  assert.ok(isCommandName('attachments.modelChunk'));
});

test('reads a model in chunks that add up to the file', async () => {
  const whole = cubeGlb();
  const first = await readModelChunk(root, 'cube.glb', 0, 1000);
  assert.equal(first.size, whole.length);
  assert.equal(first.bytes.length, 1000);
  const rest = await readModelChunk(root, 'cube.glb', 1000, 1 << 20);
  assert.equal(rest.bytes.length, whole.length - 1000);
  assert.deepEqual(Buffer.concat([first.bytes, rest.bytes]), Buffer.from(whole));
});

test('a chunk is never larger than the cap, whatever the caller asks', async () => {
  const chunk = await readModelChunk(root, 'cube.glb', 0, 10 * MAX_MODEL_CHUNK);
  assert.ok(chunk.bytes.length <= MAX_MODEL_CHUNK);
});

test('companion textures in subfolders are readable; other file types are refused', async () => {
  assert.ok((await readModelChunk(root, 'sub/tex.png', 0, 100)).bytes.length > 0);
  await assert.rejects(readModelChunk(root, 'notes.txt', 0, 10), /Unsupported 3D model file/);
  await assert.rejects(readModelChunk(root, 'cube.glb.bak', 0, 10), /Unsupported/);
});

test('paths cannot leave the folder: dot-dot, absolute, symlinked files and symlinked directories', async () => {
  await assert.rejects(readModelChunk(root, '../' + outside.split('/').pop() + '/leak.glb', 0, 10), /escapes folder root/);
  await assert.rejects(readModelChunk(root, join(outside, 'leak.glb'), 0, 10), /escapes folder root|outside folder root/);
  await assert.rejects(readModelChunk(root, 'linked.glb', 0, 10), /outside folder root/);
  await assert.rejects(readModelChunk(root, 'dir-link/leak.png', 0, 10), /outside folder root/);
  await assert.rejects(readModelChunk(root, 'a\0.glb', 0, 10), /NUL/);
});

test('signatures and sizes are validated on the first chunk', async () => {
  await assert.rejects(readModelChunk(root, 'fake.glb', 0, 100), /Not a GLB/);
  await assert.rejects(readModelChunk(root, 'bad.ply', 0, 100), /Not a PLY/);
  await assert.rejects(readModelChunk(root, 'empty.glb', 0, 100), /empty/);
  assert.ok((await readModelChunk(root, 'sphere.stl', 0, 100)).size > 84);
  writeFileSync(join(root, 'real.ply'), plyBinary());
  assert.ok((await readModelChunk(root, 'real.ply', 0, 64)).bytes.length === 64);
});

test('invalid ranges are rejected', async () => {
  await assert.rejects(readModelChunk(root, 'cube.glb', -1, 10), /Invalid model read range/);
  await assert.rejects(readModelChunk(root, 'cube.glb', 0, 0), /Invalid model read range/);
  await assert.rejects(readModelChunk(root, 'cube.glb', 1.5, 10), /Invalid model read range/);
  await assert.rejects(readModelChunk(root, 'cube.glb', 10_000_000, 10), /past the end/);
  await assert.rejects(readModelChunk(root, 'cube.glb', Number.NaN, 10), /Invalid model read range/);
});

test('the runtime service answers files.modelChunk for a folder it knows, and refuses what readModelChunk refuses', async t => {
  const service = createAgentService({dataDir: join(root, 'service-state'), onEvent: () => {}});
  t.after(() => service.dispose());
  const folder = await service.invoke('folder.add', {path: root});
  const first = await service.invoke('files.modelChunk', {folderId: folder.id, path: 'cube.glb', offset: 0, length: 64});
  assert.equal(first.bytes.length, 64);
  assert.equal(first.size, cubeGlb().length);
  assert.equal(Buffer.from(first.bytes).toString('latin1', 0, 4), 'glTF');
  await assert.rejects(service.invoke('files.modelChunk', {folderId: folder.id, path: '../x.glb', offset: 0, length: 8}), /escapes folder root|Unsupported|outside/);
  await assert.rejects(service.invoke('files.modelChunk', {folderId: 'nope', path: 'cube.glb', offset: 0, length: 8}), /Folder/);
  await assert.rejects(service.invoke('files.modelChunk', {folderId: folder.id, path: 'cube.glb', offset: 'x' as unknown as number, length: 8}), /Invalid model read range/);
});
