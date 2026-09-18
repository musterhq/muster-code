import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'dist/tests/renderer-lifecycle.mjs');
await build({entryPoints:[path.join(root,'tests/renderer-lifecycle.tsx')],outfile,bundle:true,platform:'node',format:'esm',packages:'external',loader:{'.css':'empty'},jsx:'automatic'});
const result = spawnSync(process.execPath, [outfile], {stdio:'inherit'});
process.exitCode = result.status ?? 1;
