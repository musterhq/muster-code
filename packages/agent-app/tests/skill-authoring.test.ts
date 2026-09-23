import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,mkdir,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSkill,skillSlug} from '../src/runtime/skill-authoring.ts';
import {discoverSkills} from '../src/runtime/plugin-library.ts';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';

async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-skill-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}

test('slugs are lowercase words joined by dashes',()=>{
  assert.equal(skillSlug('  Release Notes: Weekly!  '),'release-notes-weekly');
  assert.equal(skillSlug('Café Menü'),'cafe-menu');
  assert.equal(skillSlug('../../etc'),'etc');
  assert.equal(skillSlug('!!!'),'');
});

test('record a skill writes SKILL.md and openai.yaml that discovery lists at once; replacing needs confirmation',async t=>{
  const home=await directory(t);
  const previous=process.env.HOME;process.env.HOME=home;t.after(()=>{process.env.HOME=previous;});
  const created=await createSkill({name:'Release Notes',description:'Draft release notes\nfrom merged PRs',body:'# Release notes\n\n1. List merged PRs.'},home);
  assert.equal(created.slug,'release-notes');assert.equal(created.replaced,false);
  assert.equal(created.path,join(created.id,'SKILL.md'));
  const markdown=await readFile(created.path,'utf8');
  assert.equal(markdown,'---\nname: release-notes\ndescription: "Draft release notes from merged PRs"\n---\n\n# Release notes\n\n1. List merged PRs.\n');
  assert.match(await readFile(join(created.id,'agents','openai.yaml'),'utf8'),/display_name: "Release Notes"/);
  const listed=(await discoverSkills()).find(skill=>skill.name==='release-notes')!;
  assert.ok(listed);assert.equal(listed.id,created.id);assert.equal(listed.displayName,'Release Notes');assert.equal(listed.shortDescription,'Draft release notes from merged PRs');
  await assert.rejects(createSkill({name:'release notes',description:'Other',body:'Other'},home),/already exists\. Replace it\?/);
});

test('validation, overwrite and symlink refusal',async t=>{
  const home=await directory(t);
  await createSkill({name:'Triage',description:'Triage issues',body:'Steps'},home);
  await assert.rejects(createSkill({name:'Triage',description:'Triage issues',body:'Steps 2'},home),/already exists/);
  const replaced=await createSkill({name:'Triage',description:'Triage issues',body:'---\nname: evil\n---\nSteps 2',overwrite:true},home);
  assert.equal(replaced.replaced,true);
  assert.match(await readFile(replaced.path,'utf8'),/^---\nname: triage\n[\s\S]*\n---\n\nSteps 2\n$/,'user front matter cannot rename the skill');
  await assert.rejects(createSkill({name:'!!!',description:'x',body:'x'},home),/letters or numbers/);
  await assert.rejects(createSkill({name:'Ok',description:'',body:'x'},home),/Describe when/);
  await assert.rejects(createSkill({name:'Ok',description:'x',body:'  '},home),/Write the skill/);
  await assert.rejects(createSkill({name:'Big',description:'x',body:'x'.repeat(50*1024)},home),/48 KB/);
  const outside=await directory(t);await mkdir(join(home,'.codex','skills'),{recursive:true});
  await symlink(outside,join(home,'.codex','skills','linked'));
  await assert.rejects(createSkill({name:'Linked',description:'x',body:'x',overwrite:true},home),/not a plain skill folder/);
});

test('skills.create is a runtime command',async t=>{
  const dataDir=await directory(t),home=await directory(t);
  const previous=process.env.HOME;process.env.HOME=home;t.after(()=>{process.env.HOME=previous;});
  const provider:ProviderAdapter={info:()=>[],run:async()=>({status:'completed',finalMessage:''}),stop:async()=>true,dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const created=await service.invoke('skills.create',{name:'Weekly report',description:'Summarise the week',body:'Collect updates.'});
  assert.equal(created.slug,'weekly-report');
  assert.ok((await service.invoke('plugins.list',{})).some(skill=>skill.id===created.id),'the new skill is listed for / and +');
});
