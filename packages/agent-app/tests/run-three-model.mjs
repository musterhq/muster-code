// Bundles tests/three-model.suite.ts (named .suite so `npm test`'s *.test.ts glob skips it) (Draco's wasm is imported as bytes) and runs them in a clean process.
import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'dist/tests/three-model.suite.mjs');
await build({entryPoints: [path.join(root, 'tests/three-model.suite.ts')], outfile, bundle: true, platform: 'node', format: 'esm', target: 'es2022', loader: {'.wasm': 'binary'}, external: ['draco3d', 'meshoptimizer', 'node:*'], logLevel: 'error',
  banner: {js: "import {createRequire as __cr} from 'node:module'; const require = __cr(import.meta.url); globalThis.__dirname = '.';"}});
const result = spawnSync(process.execPath, ['--max-old-space-size=1536', '--test', outfile], {stdio: 'inherit', cwd: root});
process.exitCode = result.status ?? 1;
