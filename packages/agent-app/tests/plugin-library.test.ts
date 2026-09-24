import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isEnabled,qualifiedSkillName,skillShadows,type ExtensionEnablement} from '../src/shared/domains/extensions-protocol.ts';
import {discoverSkills,resolveAttachedSkill,setDiscoveryGates,setExtensionSkillRoots} from '../src/runtime/plugin-library.ts';
import {parseSkill,readLocalSkill,restoreLocalSkill,saveLocalSkill} from '../src/runtime/skill-editor.ts';

async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-lib-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}

test('enablement precedence: folder beats project beats user; no row means enabled',()=>{
  const rows:ExtensionEnablement[]=[{extensionId:'x',scope:'user',scopeId:'',enabled:false},{extensionId:'x',scope:'project',scopeId:'p1',enabled:true},{extensionId:'x',scope:'folder',scopeId:'f1',enabled:false}];
  assert.equal(isEnabled(rows,'x'),false);
  assert.equal(isEnabled(rows,'x',{projectId:'p1'}),true);
  assert.equal(isEnabled(rows,'x',{projectId:'p1',folderId:'f1'}),false);
  assert.equal(isEnabled(rows,'x',{folderId:'f2',projectId:'p2'}),false,'falls back to user');
  assert.equal(isEnabled(rows,'y',{folderId:'f1'}),true);
});

test('qualified names and shadowing: folder > user > global',()=>{
  const entries=[
    {id:'g',name:'review',provenance:'extension:acme'},
    {id:'u',name:'review',provenance:'~/.agents/skills'},
    {id:'f',name:'review',provenance:'.agents/skills (app)'},
    {id:'solo',name:'solo',provenance:'~/.codex/skills'},
  ];
  assert.deepEqual(entries.map(qualifiedSkillName),['acme:review','.agents:review','app:review','.codex:solo']);
  const shadows=skillShadows(entries);
  assert.equal(shadows.get('g'),'app:review');assert.equal(shadows.get('u'),'app:review');
  assert.ok(!shadows.has('f'));assert.ok(!shadows.has('solo'));
});

test('installed extension roots join discovery and the enablement gate hides and refuses disabled skills',async t=>{
  const root=await directory(t);
  await mkdir(join(root,'notes@1.0.0','skills','jot'),{recursive:true});
  await writeFile(join(root,'notes@1.0.0','skills','jot','SKILL.md'),'---\nname: jot\ndescription: Jot\n---\nJot it.');
  await mkdir(join(root,'solo@2.0.0'),{recursive:true});
  await writeFile(join(root,'solo@2.0.0','SKILL.md'),'---\nname: solo\ndescription: Solo\n---\nSolo.');
  t.after(()=>{setExtensionSkillRoots([]);setDiscoveryGates({skill:null,plugin:null});});
  setExtensionSkillRoots([{path:join(root,'notes@1.0.0','skills'),provenance:'extension:notes'},{path:root,only:'solo@2.0.0',name:'solo',provenance:'extension:solo'}]);
  const mine=(list:Awaited<ReturnType<typeof discoverSkills>>)=>list.filter(skill=>skill.provenance.startsWith('extension:')).map(skill=>`${skill.provenance}/${skill.name}`).sort();
  assert.deepEqual(mine(await discoverSkills()),['extension:notes/jot','extension:solo/solo']);
  setDiscoveryGates({skill:skill=>skill.provenance!=='extension:notes'});
  assert.deepEqual(mine(await discoverSkills()),['extension:solo/solo']);
  assert.deepEqual(mine(await discoverSkills([],{all:true})),['extension:notes/jot','extension:solo/solo'],'the manager still sees disabled items');
  const jot=(await discoverSkills([],{all:true})).find(skill=>skill.name==='jot')!;
  await assert.rejects(resolveAttachedSkill(jot.id),/disabled/);
  setDiscoveryGates({skill:null});
  assert.equal((await resolveAttachedSkill(jot.id))?.name,'jot');
});

test('skill editor: create, edit with a history copy, restore, rename, assets',async t=>{
  const home=await directory(t);
  await assert.rejects(saveLocalSkill({name:'Bad Name',description:'x',body:'y'},home),/lowercase/);
  const created=await saveLocalSkill({name:'release-notes',description:'Write release notes',body:'Step one.'},home);
  assert.match(created.path,/\/\.agents\/skills\/release-notes\/SKILL\.md$/);
  assert.deepEqual(created.history,[]);
  assert.match(await readFile(created.path,'utf8'),/^---\nname: release-notes\ndescription: "Write release notes"\n---\n\nStep one.\n$/);
  await assert.rejects(saveLocalSkill({name:'release-notes',description:'dup',body:'dup'},home),/already exists/);
  const edited=await saveLocalSkill({name:'release-notes',description:'Write release notes',body:'Step two.',previousName:'release-notes'},home);
  assert.equal(edited.body,'Step two.');assert.equal(edited.history.length,1);
  await mkdir(join(home,'.agents','skills','release-notes','scripts'));
  await writeFile(join(home,'.agents','skills','release-notes','scripts','gen.sh'),'echo');
  const restored=await restoreLocalSkill('release-notes',edited.history[0]!.id,home);
  assert.equal(restored.body,'Step one.');assert.equal(restored.history.length,2);
  assert.deepEqual(restored.assets,['scripts/gen.sh']);
  const renamed=await saveLocalSkill({name:'changelog',description:'Write release notes',body:'Step one.',previousName:'release-notes'},home);
  assert.equal(renamed.name,'changelog');assert.deepEqual(renamed.assets,['scripts/gen.sh']);assert.equal(renamed.history.length,3);
  assert.equal((await readLocalSkill('changelog',home)).description,'Write release notes');
  assert.deepEqual(parseSkill('x',"---\nname: x\ndescription: 'it''s'\n---\nbody"),{name:'x',description:"it's",body:'body'});
});
