// Writes the generated CC0 test models (tests/fixtures/model-fixtures.ts) to a directory.
// Usage: node --experimental-transform-types scripts/make-model-fixtures.mjs <outDir> [--large-mb 50]
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const fx = await import(new URL('../tests/fixtures/model-fixtures.ts', import.meta.url).href);
const out = path.resolve(process.argv[2] ?? 'model-fixtures');
const largeMb = Number(process.argv[process.argv.indexOf('--large-mb') + 1]) || 0;
mkdirSync(path.join(out, 'textures'), {recursive: true});
const write = (name, data) => writeFileSync(path.join(out, name), data);
write('cube.glb', fx.cubeGlb());
write('cube-textured.glb', fx.cubeGlb({texture: fx.checkerPng(64)}));
const external = fx.cubeGltf({texture: fx.checkerPng(64), external: true});
write('cube-external.gltf', JSON.stringify(external.json, null, 1)); write('cube.bin', external.bin); write('textures/checker.png', external.image);
write('cube.obj', fx.objCube(false)); write('cube-textured.obj', fx.objCube(true).replace('cube.mtl', 'cube-textured.mtl')); write('cube-textured.mtl', fx.cubeMtl());
write('sphere.stl', fx.stlBinary()); write('cube-ascii.stl', fx.stlAscii());
write('sphere.ply', fx.plyBinary()); write('spiral-points.ply', fx.plyPointCloud());
write('cube.fbx', fx.fbxAsciiCube());
write('broken.glb', fx.cubeGlb().subarray(0, 90)); write('empty.glb', new Uint8Array(0)); write('not-a-model.glb', new TextEncoder().encode('this is not a glb file'));
const compressed = await import(new URL('../tests/fixtures/compressed-models.ts', import.meta.url).href);
write('cube-draco.glb', await compressed.dracoCubeGlb()); write('cube-meshopt.glb', await compressed.meshoptCubeGlb());
if (largeMb) { const {glb, vertices, triangles} = fx.terrainGlb(largeMb * 1024 * 1024); write(`terrain-${largeMb}mb.glb`, glb); console.log(`terrain-${largeMb}mb.glb ${(glb.length / 1048576).toFixed(1)} MiB, ${vertices} vertices, ${triangles} triangles`); }
console.log(`wrote fixtures to ${out}`);
