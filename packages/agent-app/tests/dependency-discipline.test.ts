import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readdirSync,readFileSync} from 'node:fs';

const read=(file:string)=>readFileSync(new URL(`../${file}`,import.meta.url),'utf8');
function sources(dir:string):string[] {
  return readdirSync(new URL(`../${dir}`,import.meta.url),{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?sources(`${dir}/${entry.name}`):/\.(ts|tsx)$/.test(entry.name)?[`${dir}/${entry.name}`]:[]);
}

test('PER-10: Shiki ships one theme and per-language chunks, never its full bundles',()=>{
  const offenders=sources('src').filter(file=>/from ['"](shiki|shiki\/bundle\/[^'"]+|@shikijs\/themes|@shikijs\/langs)['"]/.test(read(file)));
  assert.deepEqual(offenders,[],'no whole-bundle Shiki imports');
  const worker=read('src/renderer/syntax-highlight-worker.ts');
  assert.deepEqual([...worker.matchAll(/@shikijs\/themes\/([\w-]+)/g)].map(match=>match[1]),['dark-plus']);
  assert.ok([...worker.matchAll(/import\('@shikijs\/langs\/[\w-]+'\)/g)].length<=60,'language grammars stay an explicit, lazily loaded list');
});

test('PER-10: stale renderer chunks from earlier builds are pruned before packaging',()=>{
  const build=read('scripts/build.mjs');
  assert.match(build,/function pruneStaleRendererOutputs/);assert.match(build,/pruneStaleRendererOutputs\(renderer\.metafile\)/);
  assert.match(build,/THIRD-PARTY-LICENSES\.txt/);
});

test('PER-10: one notices file, a full license bundle, and a size record per bundled dependency',()=>{
  assert.equal(existsSync(new URL('../THIRD_PARTY_NOTICES.md',import.meta.url)),false,'duplicate notices file removed');
  assert.match(read('THIRD-PARTY-NOTICES.md'),/T3 Code table interaction/);
  const report=JSON.parse(read('perf/dependency-sizes.json'));
  const bundled=report.packages.filter((row:any)=>row.name!=='(app source)');
  assert.ok(bundled.length>20);
  for(const row of bundled){assert.ok(row.bytes>0,row.name);assert.ok(typeof row.license==='string'&&row.license.length>0,row.name);}
  for(const name of ['react-dom','pdfjs-dist','@xterm/xterm','shiki'])assert.ok(bundled.some((row:any)=>row.name===name||row.name.startsWith(`${name}/`)||row.name.startsWith(`@shikijs/`)),name);
  const licenses=read('licenses/THIRD-PARTY-LICENSES.txt');
  for(const row of bundled)assert.ok(licenses.includes(`${row.name}@${row.version}`),`license bundle covers ${row.name}`);
  assert.ok(licenses.includes('node-pty@'));assert.ok(licenses.includes('Adapted source: t3code-MIT'));
});
