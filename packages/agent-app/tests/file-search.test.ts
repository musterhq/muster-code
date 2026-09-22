import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {listFiles,searchFiles} from '../src/runtime/files.ts';

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
