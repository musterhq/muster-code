/** Startup bundle: what main.js loads before first paint. Forms and pages that only open on demand stay in their lazy chunks. */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {test} from 'node:test';
import {build} from 'esbuild';

test('the startup bundle leaves the hub setup forms and the project task page to their lazy chunks',async t=>{
  const root=path.resolve(import.meta.dirname,'..');const outdir=await mkdtemp(path.join(tmpdir(),'muster-bundle-'));t.after(()=>rm(outdir,{recursive:true,force:true}));
  const result=await build({entryPoints:[path.join(root,'src/renderer/main.tsx')],outdir,bundle:true,splitting:true,platform:'browser',format:'esm',target:'es2022',jsx:'automatic',loader:{'.ttf':'file','.woff2':'file'},minify:true,define:{'process.env.NODE_ENV':'"production"'},metafile:true,write:false,logLevel:'error',absWorkingDir:root});
  const outputs=result.metafile!.outputs,main=Object.keys(outputs).find(k=>k.endsWith('/main.js'))!;
  const eager=new Set<string>();const walk=(file:string)=>{if(eager.has(file))return;eager.add(file);for(const i of outputs[file]!.imports)if(i.kind==='import-statement')walk(i.path);};walk(main);
  const inputs=new Set([...eager].flatMap(file=>Object.keys(outputs[file]!.inputs)));
  for(const lazy of ['src/renderer/components/HubSetup.tsx','src/renderer/components/ProjectTasks.tsx'])assert.ok(![...inputs].some(i=>i.endsWith(lazy)),`${lazy} is not loaded at startup`);
});
