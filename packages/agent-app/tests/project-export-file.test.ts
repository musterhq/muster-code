import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { projectExportFilename, writeProjectExportFile } from '../src/main/project-export-file.ts';

test('Project export filename is safe and preserves readable names',()=>{
 assert.equal(projectExportFilename('Roadmap / R&D'),'Roadmap - R&D-export.json');
 assert.equal(projectExportFilename('...'), 'project-export.json');
});

test('Project export atomically replaces only the user-selected destination',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'muster-export-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const target=join(dir,'project.json');await writeFile(target,'old');
 await writeProjectExportFile(target,'{"schemaVersion":2}\n');
 assert.equal(await readFile(target,'utf8'),'{"schemaVersion":2}\n');
 assert.deepEqual((await readdir(dir)).sort(),['project.json']);
});

test('Project export failure keeps an existing directory intact and removes temporary output',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'muster-export-failure-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const target=join(dir,'directory');await mkdir(target);await writeFile(join(target,'sentinel'),'keep');
 await assert.rejects(writeProjectExportFile(target,'new export'));
 assert.equal(await readFile(join(target,'sentinel'),'utf8'),'keep');assert.deepEqual((await readdir(dir)).sort(),['directory']);
});
