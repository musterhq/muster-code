import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const outdir=path.join(root,'dist/tests/highlighted-code-streaming');
await build({entryPoints:[path.join(root,'tests/highlighted-code-streaming.tsx')],outdir,splitting:true,bundle:true,platform:'node',format:'esm',outExtension:{'.js':'.mjs'},packages:'external',loader:{'.css':'empty'},jsx:'automatic'});
const result=spawnSync(process.execPath,[path.join(outdir,'highlighted-code-streaming.mjs')],{stdio:'inherit'});
process.exitCode=result.status??1;
