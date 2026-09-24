import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter,ProviderInput} from '../src/runtime/provider.ts';

const info:ProviderAdapter['info']=()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture'}]}];
async function directory(t:TestContext,prefix:string){const path=await mkdtemp(join(tmpdir(),prefix));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function until(check:()=>boolean){for(let i=0;i<500;i++){if(check())return;await new Promise(resolve=>setImmediate(resolve));}assert.fail('condition not reached');}

test('chat.send carries composer effort, several skills and invoked plugins into the provider run',async t=>{
  const dataDir=await directory(t,'muster-send-'),home=await directory(t,'muster-send-home-');
  const previous=process.env.HOME;process.env.HOME=home;t.after(()=>{process.env.HOME=previous;});
  for(const name of ['pdf','review']){const dir=join(home,'.codex','skills',name);await mkdir(dir,{recursive:true});await writeFile(join(dir,'SKILL.md'),`Use the ${name} checklist.`);}
  const pluginDir=join(home,'.codex','plugins','cache','openai-curated','gmail','0.1.0');
  await mkdir(join(pluginDir,'.codex-plugin'),{recursive:true});await mkdir(join(pluginDir,'skills','inbox'),{recursive:true});
  await writeFile(join(pluginDir,'.codex-plugin','plugin.json'),JSON.stringify({name:'gmail',interface:{displayName:'Gmail',shortDescription:'Read and manage Gmail'}}));
  await writeFile(join(pluginDir,'skills','inbox','SKILL.md'),'Triage the inbox.');
  const inputs:ProviderInput[]=[];
  const provider:ProviderAdapter={info,run:async input=>{inputs.push(input);return {status:'completed',finalMessage:'ok'};},stop:async()=>true,dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});
  const chat=await service.invoke('chat.create',{});
  const skills=await service.invoke('plugins.list',{});
  const plugins=await service.invoke('plugins.inventory',undefined);
  const gmail=plugins.find(entry=>entry.name==='gmail')!;assert.equal(gmail.displayName,'Gmail');
  await service.invoke('chat.send',{id:chat.id,text:'Ask $pdf $review @gmail',requestId:'r1',skillIds:skills.map(skill=>skill.id),pluginIds:[gmail.id],effort:'high'});
  await until(()=>inputs.length===1);
  assert.equal(inputs[0].reasoningEffort,'high');
  assert.match(inputs[0].prompt,/Use the pdf checklist\.[\s\S]*Use the review checklist\./);
  assert.match(inputs[0].prompt,/invoked the Gmail plugin \(@gmail\)[\s\S]*Triage the inbox\./);
  assert.match(inputs[0].prompt,/Current user request:\nAsk \$pdf \$review @gmail/);
  for(let i=0;i<50&&(await service.invoke('app.snapshot',undefined)).chats.find(entry=>entry.id===chat.id)?.status==='running';i++)await new Promise(resolve=>setTimeout(resolve,10));
  // The chosen effort sticks for later sends (and queued follow-ups) in this chat.
  await service.invoke('chat.send',{id:chat.id,text:'again',requestId:'r2'});
  await until(()=>inputs.length===2);
  assert.equal(inputs[1].reasoningEffort,'high');
  await assert.rejects(service.invoke('chat.send',{id:chat.id,text:'x',requestId:'r3',effort:'max' as never}),/Invalid reasoning effort/);
  await assert.rejects(service.invoke('chat.send',{id:chat.id,text:'x',requestId:'r4',pluginIds:[join(home,'nope')]}),/no longer installed/);
  await service.dispose();
});
