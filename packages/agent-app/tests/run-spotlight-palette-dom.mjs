import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const outdir=path.join(root,'dist/tests/spotlight-palette-dom');
// Keep dynamic UI imports separate so Base UI detects the fixture DOM at load time.
await build({entryPoints:[path.join(root,'tests/spotlight-palette-dom.tsx')],outdir,splitting:true,bundle:true,platform:'node',format:'esm',outExtension:{'.js':'.mjs'},packages:'external',loader:{'.css':'empty'},jsx:'automatic'});
const result=spawnSync(process.execPath,['--max-old-space-size=1536',path.join(outdir,'spotlight-palette-dom.mjs')],{stdio:'inherit'});
process.exitCode=result.status??1;
