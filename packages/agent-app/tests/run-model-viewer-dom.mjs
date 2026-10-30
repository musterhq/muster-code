// Bundles tests/model-viewer-dom.tsx with everything inlined (the viewer lazily imports the Draco decoder, whose wasm is bundled as bytes,
// which the per-suite `packages: external` build of test-renderer.mjs cannot do) and runs it in a clean process.
import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'dist/tests/model-viewer-dom.mjs');
await build({entryPoints: [path.join(root, 'tests/model-viewer-dom.tsx')], outfile, bundle: true, platform: 'node', format: 'esm', target: 'es2022', jsx: 'automatic', loader: {'.css': 'empty', '.wasm': 'binary'}, logLevel: 'error', absWorkingDir: root,
  banner: {js: "import {createRequire as __cr} from 'node:module'; const require = __cr(import.meta.url); globalThis.__dirname = '.';"}});
const result = spawnSync(process.execPath, ['--max-old-space-size=1536', outfile], {stdio: 'inherit', cwd: root, env: {...process.env, MUSTER_DEVICE_PLATFORM: process.env.MUSTER_DEVICE_PLATFORM ?? 'darwin'}});
process.exitCode = result.status ?? 1;
