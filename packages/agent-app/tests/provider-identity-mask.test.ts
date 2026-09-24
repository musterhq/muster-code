import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';

test('the ChatGPT (OpenAI Direct) account is masked and revealable like Claude Code',async t=>{
  const home=await mkdtemp(join(tmpdir(),'muster-mask-home-')),dataDir=await mkdtemp(join(tmpdir(),'muster-mask-'));
  t.after(async()=>{await rm(home,{recursive:true,force:true});await rm(dataDir,{recursive:true,force:true});});
  const previous={HOME:process.env.HOME,CODEX_HOME:process.env.CODEX_HOME};process.env.HOME=home;delete process.env.CODEX_HOME;
  t.after(()=>{process.env.HOME=previous.HOME;if(previous.CODEX_HOME!==undefined)process.env.CODEX_HOME=previous.CODEX_HOME;});
  const claims=Buffer.from(JSON.stringify({email:'dhairya@example.com'})).toString('base64url');
  await mkdir(join(home,'.codex'),{recursive:true});
  await writeFile(join(home,'.codex','auth.json'),JSON.stringify({tokens:{access_token:'secret-token',id_token:`h.${claims}.s`,account_id:'acct'}}));
  const provider:ProviderAdapter={info:()=>[{id:'openai-direct',name:'OpenAI Direct',available:true,identityMasked:'ChatGPT account · hidden',models:[{id:'gpt-5.6-terra',name:'Terra'}]},{id:'hybrow',name:'Hybrow',available:true,identityMasked:'Gateway profile · account hidden',models:[]}],run:async()=>({status:'completed',finalMessage:''}),stop:async()=>true,dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const listed=await service.invoke('providers.list',undefined);
  const direct=listed.find(entry=>entry.id==='openai-direct')!;
  assert.equal(direct.identityMasked,'d***@example.com');assert.equal(direct.canReveal,true);
  assert.equal(listed.find(entry=>entry.id==='hybrow')!.canReveal,false);
  assert.ok(!JSON.stringify(listed).includes('secret-token'),'tokens never leave the runtime');
  assert.deepEqual(await service.invoke('providers.reveal',{id:'openai-direct'}),{identity:'dhairya@example.com'});
});
