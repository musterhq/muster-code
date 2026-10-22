import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('terminal pane retries failed loads with a bounded budget and manual recovery',async()=>{
const root=new URL('../',import.meta.url);
const outfile=fileURLToPath(new URL('dist/tests/terminal-load-retry-dom.mjs',root));
await build({entryPoints:[fileURLToPath(new URL('tests/terminal-load-retry-dom.tsx',root))],outfile,bundle:true,platform:'node',format:'esm',packages:'external',loader:{'.css':'empty'},jsx:'automatic'});
const result=spawnSync(process.execPath,['--max-old-space-size=1024',outfile],{stdio:'inherit'});
assert.equal(result.status,0,'terminal load retry DOM checks pass');
});
