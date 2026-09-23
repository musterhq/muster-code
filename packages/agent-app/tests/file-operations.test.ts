import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, test} from 'node:test';
import {createEntry, moveFile, mutablePath} from '../src/runtime/file-operations.ts';
import {readFile as readFileBody, writeFile as writeFileAtomic} from '../src/runtime/files.ts';

let root = '';
afterEach(async()=>{if(root){await rm(root,{recursive:true,force:true});root='';}});
async function workspace():Promise<string>{root=await mkdtemp(join(tmpdir(),'muster-file-operations-'));return root;}

test('create uses exclusive paths and preserves existing data on collisions',async()=>{
  const dir=await workspace();
  await createEntry(dir,'notes.md','file');
  assert.equal(await readFile(join(dir,'notes.md'),'utf8'),'');
  await writeFile(join(dir,'notes.md'),'keep me');
  await assert.rejects(createEntry(dir,'notes.md','file'),/already exists/i);
  assert.equal(await readFile(join(dir,'notes.md'),'utf8'),'keep me');
  await createEntry(dir,'docs','directory');
  await assert.rejects(createEntry(dir,'docs','directory'));
});

test('mutations reject absolute paths, traversal, protected metadata and symlink components',async()=>{
  const dir=await workspace(),outside=await mkdtemp(join(tmpdir(),'muster-file-outside-'));
  try {
    await mkdir(join(dir,'real'));
    await writeFile(join(dir,'real','safe.txt'),'safe');
    await symlink(outside,join(dir,'linked'));
    for(const path of ['../outside.txt','/tmp/outside.txt','.git/config','real/../safe.txt','linked/escape.txt']){
      await assert.rejects(mutablePath(dir,path),/./,`reject unsafe path: ${path}`);
    }
    await symlink(join(outside,'private.txt'),join(dir,'linked-file'));
    await assert.rejects(mutablePath(dir,'linked-file',true),/symlink/i);
    await assert.rejects(mutablePath(dir,''));
    assert.equal(await readFile(join(dir,'real','safe.txt'),'utf8'),'safe');
  } finally {await rm(outside,{recursive:true,force:true});}
});

test('move is same-volume, exclusive and leaves the source intact when the target exists',async()=>{
  const dir=await workspace();
  await writeFile(join(dir,'source.txt'),'source');
  await writeFile(join(dir,'taken.txt'),'destination');
  await assert.rejects(moveFile(dir,'source.txt','taken.txt'),/already exists/i);
  assert.equal(await readFile(join(dir,'source.txt'),'utf8'),'source');
  assert.equal(await readFile(join(dir,'taken.txt'),'utf8'),'destination');
  await moveFile(dir,'source.txt','renamed.txt');
  assert.equal(await readFile(join(dir,'renamed.txt'),'utf8'),'source');
  await assert.rejects(readFile(join(dir,'source.txt'),'utf8'),{code:'ENOENT'});
  await mkdir(join(dir,'folder'));
  await writeFile(join(dir,'folder','inside.txt'),'inside');
  await mkdir(join(dir,'folder-taken'));
  await assert.rejects(moveFile(dir,'folder','folder-taken'),/already exists/i);
  await moveFile(dir,'folder','folder-renamed');
  assert.equal(await readFile(join(dir,'folder-renamed','inside.txt'),'utf8'),'inside');
  await assert.rejects(readFile(join(dir,'folder','inside.txt'),'utf8'),{code:'ENOENT'});
});

test('files.write refuses a stale revision and otherwise writes atomically',async()=>{
  const dir=await workspace();
  await writeFile(join(dir,'doc.txt'),'original');
  const before=await readFileBody(dir,'doc.txt');
  assert.equal(before.text,'original');
  // A write with no expected revision always succeeds and moves the file forward.
  const first=await writeFileAtomic(dir,'doc.txt','v2',before.revision);
  assert.equal(first.conflict,false);
  // Reusing the now-stale revision is refused; the file on disk is untouched.
  const stale=await writeFileAtomic(dir,'doc.txt','v3-stale',before.revision);
  assert.equal(stale.conflict,true);
  assert.equal(await readFile(join(dir,'doc.txt'),'utf8'),'v2');
  // A fresh revision (or none at all) is accepted.
  const second=await writeFileAtomic(dir,'doc.txt','v3', first.conflict?undefined:first.revision);
  assert.equal(second.conflict,false);
  assert.equal(await readFile(join(dir,'doc.txt'),'utf8'),'v3');
});
