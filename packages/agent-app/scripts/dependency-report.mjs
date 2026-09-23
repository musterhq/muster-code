// PER-10: dependency size and license discipline.
//
// Bundles the app's own entry points in memory (same esbuild settings as
// scripts/build.mjs, nothing written to dist/), attributes every output byte to
// the npm package it came from, and writes:
//   perf/dependency-sizes.json         bytes per dependency (+ per output target), license and version
//   licenses/THIRD-PARTY-LICENSES.txt  full license text of every bundled package plus the adapted sources
// build.mjs ships the license bundle in dist/renderer; Help > Third-Party Notices opens it.
// Usage: node scripts/dependency-report.mjs [--check]   (--check fails when a bundled package has no license text)
import * as esbuild from 'esbuild';
import {existsSync,mkdirSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const src=(...p)=>path.join(root,'src',...p);
const common={bundle:true,minify:true,write:false,metafile:true,logLevel:'silent',absWorkingDir:root,define:{'process.env.NODE_ENV':'"production"'}};
const targets=[
  {name:'renderer',entryPoints:[src('renderer','main.tsx'),src('renderer','diff-worker.ts'),src('renderer','syntax-highlight-worker.ts')],outdir:path.join(root,'.dependency-report'),splitting:true,platform:'browser',format:'esm',target:'es2022',jsx:'automatic',loader:{'.ttf':'file','.woff2':'file'}},
  {name:'main',entryPoints:[src('main','index.ts')],outfile:path.join(root,'.dependency-report/main.cjs'),platform:'node',format:'cjs',target:'node22',external:['electron','node-pty']},
  {name:'preload',entryPoints:[src('preload','index.ts')],outfile:path.join(root,'.dependency-report/preload.cjs'),platform:'node',format:'cjs',target:'node22',external:['electron']},
  {name:'runtime',entryPoints:[src('runtime','service.ts')],outfile:path.join(root,'.dependency-report/service.cjs'),platform:'node',format:'cjs',target:'node22',external:['electron']},
];

/** node_modules/<pkg> or node_modules/@scope/<pkg> of an esbuild input path (the innermost one). */
function packageOf(input){
  const parts=input.split('/');const at=parts.lastIndexOf('node_modules');
  if(at<0)return null;
  const name=parts[at+1]?.startsWith('@')?`${parts[at+1]}/${parts[at+2]}`:parts[at+1];
  return {name,dir:parts.slice(0,at+1+name.split('/').length).join('/')};
}
function licenseOf(dir){
  const abs=path.resolve(root,dir);
  let pkg={};try{pkg=JSON.parse(readFileSync(path.join(abs,'package.json'),'utf8'));}catch{/* no manifest */}
  const license=typeof pkg.license==='string'?pkg.license:pkg.license?.type??(Array.isArray(pkg.licenses)?pkg.licenses.map(l=>l.type).join(' OR '):'UNKNOWN');
  const file=existsSync(abs)?readdirSync(abs).find(name=>/^(licen[cs]e|copying)(\.|-|$)/i.test(name)):undefined;
  return {version:pkg.version??'unknown',license,text:file?readFileSync(path.join(abs,file),'utf8').trim():'',file:file??null};
}

const started=Date.now();
const packages=new Map();
const totals={};
for(const target of targets){
  const {name,...options}=target;
  const result=await esbuild.build({...common,...options});
  let first=0;
  for(const [output,meta] of Object.entries(result.metafile.outputs)){
    if(output.endsWith('.map'))continue;
    first+=meta.bytes;
    for(const [input,{bytesInOutput}] of Object.entries(meta.inputs)){
      const owner=packageOf(input);const key=owner?.name??'(app source)';
      const entry=packages.get(key)??{name:key,dir:owner?.dir??null,bytes:0,targets:{}};
      entry.bytes+=bytesInOutput;entry.targets[name]=(entry.targets[name]??0)+bytesInOutput;
      packages.set(key,entry);
    }
  }
  totals[name]=first;
}
const rows=[...packages.values()].filter(entry=>entry.bytes>0).sort((a,b)=>b.bytes-a.bytes).map(entry=>{
  const meta=entry.dir?licenseOf(entry.dir):{version:JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).version,license:'UNLICENSED',text:'',file:null};
  return {...entry,version:meta.version,license:meta.license,licenseFile:meta.file,_text:meta.text};
});
const direct=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).dependencies??{};
const report={
  generatedAt:new Date().toISOString(),
  note:'Minified bytes each package contributes to the shipped bundles (renderer chunks are lazy where split). Regenerate with node scripts/dependency-report.mjs and commit with any dependency change.',
  totals,
  packages:rows.map(({_text,dir,...row})=>({...row,direct:Object.hasOwn(direct,row.name)})),
  unbundledDirectDependencies:Object.keys(direct).filter(name=>!packages.has(name)).map(name=>({name,reason:name==='node-pty'?'native, shipped from node_modules by the packager':'not reached from any entry point (loaded at runtime or unused)'})),
};
mkdirSync(path.join(root,'perf'),{recursive:true});
writeFileSync(path.join(root,'perf/dependency-sizes.json'),`${JSON.stringify(report,null,2)}\n`);

const missing=rows.filter(row=>row.dir&&!row._text);
const sections=rows.filter(row=>row.dir).map(row=>`================================================================================\n${row.name}@${row.version} (${row.license})\n================================================================================\n${row._text||`License text not found in the package; declared license: ${row.license}.`}\n`);
// Native modules shipped outside the bundle, and adapted source with their own license files.
for(const extra of [{name:'node-pty',dir:'node_modules/node-pty'}]){const meta=licenseOf(extra.dir);sections.push(`================================================================================\n${extra.name}@${meta.version} (${meta.license}) — native module shipped beside the bundle\n================================================================================\n${meta.text}\n`);}
for(const file of readdirSync(path.join(root,'licenses')).filter(name=>name.endsWith('.txt')&&name!=='THIRD-PARTY-LICENSES.txt').sort())
  sections.push(`================================================================================\nAdapted source: ${file.replace(/\.txt$/,'')}\n================================================================================\n${readFileSync(path.join(root,'licenses',file),'utf8').trim()}\n`);
const header=`Muster Agent third-party licenses\nGenerated by scripts/dependency-report.mjs. Attribution notes: THIRD-PARTY-NOTICES.md.\n${rows.filter(row=>row.dir).length} bundled packages, 1 native module, ${readdirSync(path.join(root,'licenses')).filter(name=>name.endsWith('.txt')&&name!=='THIRD-PARTY-LICENSES.txt').length} adapted sources.\n\n`;
writeFileSync(path.join(root,'licenses/THIRD-PARTY-LICENSES.txt'),header+sections.join('\n'));

const mb=n=>`${(n/1024/1024).toFixed(2)} MB`;
console.log(`dependency report in ${Date.now()-started} ms: ${rows.length} sources; totals ${Object.entries(totals).map(([k,v])=>`${k} ${mb(v)}`).join(', ')}`);
for(const row of rows.slice(0,15))console.log(`  ${row.name.padEnd(34)} ${(row.bytes/1024).toFixed(1).padStart(9)} KB  ${row.license}`);
if(missing.length){console.warn(`No license text in: ${missing.map(row=>row.name).join(', ')}`);if(process.argv.includes('--check'))process.exitCode=1;}
