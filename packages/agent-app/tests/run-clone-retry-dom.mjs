import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const outfile=path.join(root,'dist/tests/clone-retry-dom.mjs');
await build({entryPoints:[path.join(root,'tests/clone-retry-dom.tsx')],outfile,bundle:true,platform:'node',format:'esm',packages:'external',loader:{'.css':'empty'},jsx:'automatic'});
// Heap cap: a failing assert on a linkedom node makes util.inspect walk the whole DOM graph.
const result=spawnSync(process.execPath,['--max-old-space-size=1536',outfile],{stdio:'inherit'});
process.exitCode=result.status??1;
