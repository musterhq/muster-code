import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const outdir=path.join(root,'dist/tests/git-components');
// Dynamic UI imports stay in their own chunks so Base UI sees the fixture DOM at load time.
await build({entryPoints:[path.join(root,'tests/git-components.tsx')],outdir,splitting:true,bundle:true,platform:'node',format:'esm',outExtension:{'.js':'.mjs'},packages:'external',loader:{'.css':'empty'},jsx:'automatic'});
// Heap cap: a failing assert on a linkedom node must fail fast instead of exhausting memory.
const result=spawnSync(process.execPath,['--max-old-space-size=1536',path.join(outdir,'git-components.mjs')],{stdio:'inherit'});
process.exitCode=result.status??1;
