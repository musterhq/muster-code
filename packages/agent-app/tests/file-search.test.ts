import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {listFiles,quickOpen,scoreQuickOpen,searchFiles} from '../src/runtime/files.ts';

test('Office owner lock files stay out of browsing and search', async t => {
  const root = await mkdtemp(join(tmpdir(),'muster-office-lock-'));
  t.after(async()=>{await rm(root,{recursive:true,force:true});});
  await mkdir(join(root,'docs'));
  await writeFile(join(root,'docs','~$preview-workbook.xlsx'),'lock');
  await writeFile(join(root,'docs','~$notes.txt'),'ordinary text');
  await writeFile(join(root,'docs','preview-workbook.xlsx'),'workbook');
  assert.deepEqual((await listFiles(root,'docs')).map(file=>file.name).sort(),['preview-workbook.xlsx','~$notes.txt']);
  assert.equal((await searchFiles(root,'','~$preview')).entries.length,0);
});

test('file search finds nested paths, bounds results and never follows outside links', async t => {
  const root = await mkdtemp(join(tmpdir(),'muster-search-'));
  const outside = await mkdtemp(join(tmpdir(),'muster-outside-'));
  t.after(async()=>{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});});
  await mkdir(join(root,'docs'));
  await writeFile(join(root,'docs','Guide.md'),'# Guide');
  await writeFile(join(outside,'secret.md'),'private');
  await symlink(outside,join(root,'outside'));
  assert.deepEqual((await searchFiles(root,'','guide')).entries.map(file=>file.path),['docs/Guide.md']);
  assert.equal((await searchFiles(root,'','secret')).entries.length,0);
  await assert.rejects(searchFiles(root,'../','guide'),/escape/);
  await assert.rejects(searchFiles(root,'',''),/file name/);
  await Promise.all(Array.from({length:101},(_,i)=>writeFile(join(root,'docs',`entry-${i}.txt`),'')));
  const limited=await searchFiles(root,'docs','entry-');
  assert.equal(limited.entries.length,100);assert.equal(limited.truncated,true);
});

test('listings sort directories first in natural order before truncating at 2000 entries', async t => {
  const root = await mkdtemp(join(tmpdir(),'muster-list-sort-'));
  t.after(async()=>{await rm(root,{recursive:true,force:true});});
  await Promise.all(Array.from({length:2100},(_,i)=>writeFile(join(root,`file${i}.txt`),'')));
  await mkdir(join(root,'zeta')); await mkdir(join(root,'alpha'));
  const entries = await listFiles(root,'');
  assert.equal(entries.length,2000);
  assert.deepEqual(entries.slice(0,2).map(entry=>entry.name),['alpha','zeta']);
  assert.deepEqual(entries.slice(2,5).map(entry=>entry.name),['file0.txt','file1.txt','file2.txt'],'natural order: file2 before file10');
  assert.equal(entries[entries.length-1].name,'file1997.txt','the first 1998 files in order, not an arbitrary subset');
});

test('quick-open scoring rejects non-subsequences and ranks filename/boundary matches above buried ones', async () => {
  assert.equal(scoreQuickOpen('src/renderer/store.ts','xyz'),null,'not a subsequence');
  const storeScore = scoreQuickOpen('src/renderer/store.ts','store')!;
  const deepScore = scoreQuickOpen('src/renderer/components/deep/nested/store.ts','store')!;
  assert.ok(storeScore>0 && deepScore>0);
  assert.ok(storeScore>deepScore,'a shorter path with the same filename match ranks higher');
  const boundaryScore = scoreQuickOpen('a/ws.ts','ws')!;
  const midWordScore = scoreQuickOpen('axws.ts','ws')!;
  assert.ok(boundaryScore>midWordScore,'a match starting at a path/word boundary outranks one that does not');
});

test('quick-open excludes node_modules/.git/dist/build and orders results by score', async t => {
  const root = await mkdtemp(join(tmpdir(),'muster-quickopen-'));
  t.after(async()=>{await rm(root,{recursive:true,force:true});});
  await mkdir(join(root,'src'),{recursive:true});
  await mkdir(join(root,'node_modules','pkg'),{recursive:true});
  await mkdir(join(root,'dist'),{recursive:true});
  await writeFile(join(root,'src','store.ts'),'');
  await writeFile(join(root,'src','storekeeper.ts'),'');
  await writeFile(join(root,'node_modules','pkg','store.js'),'');
  await writeFile(join(root,'dist','store.js'),'');
  const {results} = {results: await quickOpen(root,'store')};
  assert.deepEqual(results.map(r=>r.path).sort(),['src/store.ts','src/storekeeper.ts'].sort());
  assert.ok(results[0].score>=results[1].score);
});
