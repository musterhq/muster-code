import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const outdir=path.join(root,'dist/tests/composer-s3a-components');
// Keep dynamic UI imports separate so Base UI detects the fixture DOM at load time (the Full-access dialog renders).
await build({entryPoints:[path.join(root,'tests/composer-s3a-components.tsx')],outdir,splitting:true,bundle:true,platform:'node',format:'esm',outExtension:{'.js':'.mjs'},packages:'external',loader:{'.css':'empty'},jsx:'automatic'});
// Heap cap: a failing assert on a linkedom node makes util.inspect walk the whole DOM graph.
const result=spawnSync(process.execPath,['--max-old-space-size=1536',path.join(outdir,'composer-s3a-components.mjs')],{stdio:'inherit'});
process.exitCode=result.status??1;
