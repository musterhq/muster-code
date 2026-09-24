import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const outdir=path.join(root,'dist/tests/hindsight-panel');
await build({entryPoints:[path.join(root,'tests/hindsight-panel-lifecycle.tsx')],outdir,splitting:true,bundle:true,platform:'node',format:'esm',outExtension:{'.js':'.mjs'},packages:'external',loader:{'.css':'empty'},jsx:'automatic'});
// Heap-capped: a failing assertion on a linkedom node must fail fast, not walk the DOM.
const result=spawnSync(process.execPath,['--max-old-space-size=1536',path.join(outdir,'hindsight-panel-lifecycle.mjs')],{stdio:'inherit'});
process.exitCode=result.status??1;
