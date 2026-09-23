import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as fs from 'node:fs';
import {mkdtemp,rm,mkdir,writeFile,copyFile,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configuredProviderInstances,invalidateProviderInstances,PROVIDER_INSTANCES_STAT_INTERVAL_MS,type ProviderInstanceFs} from '../src/runtime/provider-instances.ts';

/** A configured install on disk plus a counting fs and a controllable clock. */
async function fixture(t:{after(fn:()=>Promise<void>):void}) {
  const home=await mkdtemp(join(tmpdir(),'muster-instances-cache-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const directory=join(home,'runtime'),codexHome=join(home,'codex'),cli=join(home,'cli'),catalog=join(home,'catalog.json'),auth=join(codexHome,'auth.json');
  await mkdir(join(directory,'resources'),{recursive:true});await mkdir(codexHome);
  await writeFile(cli,'#!/bin/sh\nexit 1\n',{mode:0o700});
  await copyFile(join(import.meta.dirname,'../../builtin/resources/codex-profile.cjs'),join(directory,'resources/codex-profile.cjs'));
  for(const profile of ['hybrow-gateway','openai-direct'])await writeFile(join(directory,'resources',`codex-${profile}.sh`),'#!/bin/sh\nexit 1\n',{mode:0o700});
  await writeFile(catalog,JSON.stringify({models:[{slug:'gpt-5.6-terra'},{slug:'claude/claude-fable-5'}]}));
  await writeFile(join(codexHome,'openai-direct.config.toml'),`model_provider="openai"\nmodel_catalog_json=${JSON.stringify(catalog)}\n`);
  await writeFile(join(codexHome,'hybrow-gateway.config.toml'),`model_provider="hybrow"\nmodel_catalog_json=${JSON.stringify(catalog)}\n[model_providers.hybrow]\nbase_url="https://router.hybrowlabs.com/v1"\nwire_api="responses"\n[model_providers.hybrow.auth]\ncommand="existing-helper"\nargs=[]\n`);
  await writeFile(auth,JSON.stringify({tokens:{account_id:'ACCOUNT-A',access_token:'TOKEN'}}));
  // Age every file so the recently-written guard does not defeat the stat throttle.
  const old=new Date(Date.now()-60_000);
  for(const file of [cli,catalog,auth,join(codexHome,'openai-direct.config.toml'),join(codexHome,'hybrow-gateway.config.toml'),...['hybrow-gateway','openai-direct'].map(p=>join(directory,'resources',`codex-${p}.sh`))])await utimes(file,old,old);
  const counts={opens:0,stats:0};
  const counting:Partial<ProviderInstanceFs>={openSync:(...args:Parameters<typeof fs.openSync>)=>{counts.opens++;return fs.openSync(...args);},statSync:((...args:Parameters<typeof fs.statSync>)=>{counts.stats++;return fs.statSync(...args);}) as ProviderInstanceFs['statSync']};
  let clock=Date.now();
  const options={directory,home,env:{CODEX_HOME:codexHome,MUSTER_CODEX_COMMAND:cli},fs:counting,now:()=>clock};
  const tick=(ms:number)=>{clock+=ms;};
  invalidateProviderInstances();
  return {options,counts,tick,catalog,auth,cli};
}

test('repeated info() calls are served from the memo without re-reading configuration',async t=>{
  const f=await fixture(t);
  const first=configuredProviderInstances(f.options);
  assert.ok(first.every(route=>route.info.available));
  const opens=f.counts.opens,stats=f.counts.stats;assert.ok(opens>0);
  // Inside the stat window: neither reads nor stats.
  f.tick(PROVIDER_INSTANCES_STAT_INTERVAL_MS-1);
  assert.equal(configuredProviderInstances(f.options),first);
  assert.equal(f.counts.opens,opens);assert.equal(f.counts.stats,stats);
  // Past the window: stat only; unchanged fingerprints keep the memo.
  f.tick(2);
  assert.equal(configuredProviderInstances(f.options),first);
  assert.equal(f.counts.opens,opens);assert.ok(f.counts.stats>stats);
});

test('an mtime or size change on any tracked file invalidates the memo',async t=>{
  const f=await fixture(t);
  const first=configuredProviderInstances(f.options);
  assert.deepEqual(first[1]?.info.models.map(m=>m.id),['gpt-5.6-terra']);
  await writeFile(f.catalog,JSON.stringify({models:[{slug:'gpt-5.6-terra'},{slug:'gpt-5.6-luna'},{slug:'claude/claude-fable-5'}]}));
  f.tick(PROVIDER_INSTANCES_STAT_INTERVAL_MS+1);
  const opens=f.counts.opens;
  const second=configuredProviderInstances(f.options);
  assert.notEqual(second,first);assert.ok(f.counts.opens>opens);
  assert.deepEqual(second[1]?.info.models.map(m=>m.id),['gpt-5.6-terra','gpt-5.6-luna']);
  // Account change flips the opaque binding; a deleted CLI flips availability.
  await writeFile(f.auth,JSON.stringify({tokens:{account_id:'ACCOUNT-B',access_token:'TOKEN'}}));
  f.tick(PROVIDER_INSTANCES_STAT_INTERVAL_MS+1);
  const third=configuredProviderInstances(f.options);
  assert.notEqual(third[1]?.info.bindingId,second[1]?.info.bindingId);
  await rm(f.cli);
  f.tick(PROVIDER_INSTANCES_STAT_INTERVAL_MS+1);
  assert.ok(configuredProviderInstances(f.options).every(route=>!route.info.available));
});

test('a file written moments ago is re-stat’ed on every call so a burst of writes is never missed',async t=>{
  const f=await fixture(t);
  await writeFile(f.auth,JSON.stringify({tokens:{account_id:'ACCOUNT-A',access_token:'TOKEN-1'}}));
  const first=configuredProviderInstances(f.options);
  await writeFile(f.auth,JSON.stringify({tokens:{account_id:'ACCOUNT-C',access_token:'TOKEN-2'}}));
  // No clock movement at all: the fresh auth.json is inside the recent-write window.
  assert.notEqual(configuredProviderInstances(f.options)[1]?.info.bindingId,first[1]?.info.bindingId);
});

test('invalidateProviderInstances forces a re-read inside the stat window',async t=>{
  const f=await fixture(t);
  const first=configuredProviderInstances(f.options);
  const opens=f.counts.opens;
  invalidateProviderInstances();
  const second=configuredProviderInstances(f.options);
  assert.notEqual(second,first);assert.ok(f.counts.opens>opens);
  assert.deepEqual(second.map(r=>r.info.bindingId),first.map(r=>r.info.bindingId));
});
