import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const outdir=path.join(root,'dist/tests/sidebar-navigation');
// Keep dynamic UI imports separate so Base UI detects the fixture DOM at load time.
await build({entryPoints:[path.join(root,'tests/sidebar-navigation.tsx')],outdir,splitting:true,bundle:true,platform:'node',format:'esm',outExtension:{'.js':'.mjs'},packages:'external',loader:{'.css':'empty'},jsx:'automatic'});
const result=spawnSync(process.execPath,[path.join(outdir,'sidebar-navigation.mjs')],{stdio:'inherit'});
process.exitCode=result.status??1;
