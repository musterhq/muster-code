import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,mkdir,writeFile,copyFile,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configuredProviderInstances,invalidateProviderInstances,providerListingsSettled,resetProviderListings,setListingScheduler,setProviderListingStore} from '../src/runtime/provider-instances.ts';

const BASE='https://router.example.test/v1';
const TEMPLATE={slug:'codex/gpt-5.6-terra',display_name:'Terra',tool_mode:'code_mode_only',apply_patch_tool_type:'freeform',context_window:272000,max_context_window:272000,shell_type:'unified_exec'};
const LAUNCHER=join(import.meta.dirname,'../resources/codex-profile.cjs');

async function home(t:{after(fn:()=>Promise<void>):void}) {
  const root=await mkdtemp(join(tmpdir(),'muster-777-'));
  t.after(async()=>{resetProviderListings();setListingScheduler();setProviderListingStore(undefined);invalidateProviderInstances();await rm(root,{recursive:true,force:true});});
  const codexHome=join(root,'codex'),catalog=join(root,'catalog.json');await mkdir(codexHome);
  await writeFile(catalog,JSON.stringify({models:[TEMPLATE]}));
  await writeFile(join(codexHome,'hybrow.config.toml'),`model_provider="hybrow"\nmodel_catalog_json=${JSON.stringify(catalog)}\n[model_providers.hybrow]\nname="Hybrow OmniRoute"\nbase_url="${BASE}"\n`);
  return {root,codexHome,catalog};
}

/** Runs Muster's Codex launcher with a stand-in Codex that records the catalog it was given. */
async function launchedCatalog(env:Record<string,string>,root:string):Promise<{models:Array<Record<string,unknown>>}> {
  const fake=join(root,'codex.cjs'),seen=join(root,'seen.json');
  await writeFile(fake,`const fs=require('node:fs');const a=process.argv;const c=a[a.findIndex(v=>v.startsWith('model_catalog_json='))].slice(19);fs.writeFileSync(${JSON.stringify(seen)},fs.readFileSync(JSON.parse(c),'utf8'));`);
  const child=spawn(process.execPath,[LAUNCHER,'app-server','-c','model="intelligent-planner"'],{env:{...process.env,...env,MUSTER_CODEX_COMMAND:fake},stdio:['pipe','ignore','pipe']});
  child.stdin.end();
  await new Promise(resolve=>child.on('exit',resolve));
  return JSON.parse(await readFile(seen,'utf8'));
}

// Spec: MUS-SPEC-08-777A (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-777a)
// Protected: complete inline diff
test('#777 router models the catalog does not list run with the native apply_patch tool, so their edits show as inline diffs', async t=>{
  const {root,codexHome,catalog}=await home(t);
  invalidateProviderInstances();resetProviderListings();setProviderListingStore(join(root,'store'));
  setListingScheduler({set:()=>({}),clear:()=>{}});
  const listing=(async()=>new Response(JSON.stringify({data:[{id:'intelligent-planner',owned_by:'combo',capabilities:{tool_calling:true}},{id:'codex/gpt-5.6-terra',owned_by:'codex'}]}))) as unknown as typeof fetch;
  const options={directory:join(import.meta.dirname,'..'),home:root,env:{CODEX_HOME:codexHome,MUSTER_CODEX_COMMAND:process.execPath},fetch:listing};
  configuredProviderInstances(options);await providerListingsSettled();invalidateProviderInstances();
  const route=configuredProviderInstances(options).find(row=>row.info.id==='hybrow')!;
  assert.ok(route.info.models.some(model=>model.id==='intelligent-planner'),'the router agent is offered');

  const ran=await launchedCatalog(route.env,root);
  const planner=ran.models.find(model=>model.slug==='intelligent-planner');
  assert.ok(planner,'Codex is given a catalog entry for the router agent');
  assert.equal(planner.apply_patch_tool_type,'freeform');
  assert.equal(planner.tool_mode,undefined,'direct tools, so apply_patch is offered');
  assert.deepEqual(ran.models.find(model=>model.slug===TEMPLATE.slug),TEMPLATE,'catalog models are passed on unchanged');
  assert.deepEqual(JSON.parse(await readFile(catalog,'utf8')),{models:[TEMPLATE]},'the person\'s catalog file is not changed');
});
