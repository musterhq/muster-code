// Bundles tests/html-sandbox-security.suite.ts and runs it in a clean process (headless Chrome; skipped without Chrome).
import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'dist/tests/html-sandbox-security.suite.mjs');
await build({entryPoints: [path.join(root, 'tests/html-sandbox-security.suite.ts')], outfile, bundle: true, platform: 'node', format: 'esm', target: 'es2022', external: ['node:*'], logLevel: 'error'});
const result = spawnSync(process.execPath, ['--max-old-space-size=1024', '--test', outfile], {stdio: 'inherit', cwd: root});
process.exitCode = result.status ?? 1;
