import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAdapterCatalog} from '../src/runtime/adapters/index.ts';

/** Opt-in live smoke test: MUSTER_LIVE_CLAUDE=1 runs one read-only Claude Code turn (haiku) through the real CLI. */
test('live Claude Code turn streams text and a tool item',{skip:process.env.MUSTER_LIVE_CLAUDE!=='1'},async t=>{
  const cwd=await mkdtemp(join(tmpdir(),'muster-live-claude-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  await writeFile(join(cwd,'marker.txt'),'muster-live-marker\n');
  const catalog=createAdapterCatalog({customs:()=>[]});await catalog.ready();
  const route=catalog.instances().find(r=>r.info.id==='claude-code');
  assert.ok(route?.info.available,route?.info.detail??'unavailable');
  let deltas='';const events:string[]=[];const threads:string[]=[];
  const result=await route.adapter!.run({chat:{id:'live',mode:'ask'} as never,cwd,prompt:'Read marker.txt with the Read tool, then reply with its exact contents only.',model:'claude-code/haiku',permissionMode:'read-only',signal:AbortSignal.timeout(120_000),
    onThreadReady:id=>threads.push(id),onTurnAccepted(){},onDelta:d=>{deltas+=d;},onReasoning(){},onEvent:(m,p)=>events.push(`${m}:${String((p.item as {type?:string}|undefined)?.type??'')}`)});
  console.log(JSON.stringify({status:result.status,error:result.errorMessage,deltas:deltas.slice(0,200),events,threads:threads.length}));
  assert.equal(result.status,'completed',result.errorMessage??'');
  assert.match(deltas+result.finalMessage,/muster-live-marker/);
  assert.ok(events.includes('item/started:fileRead'));
});
