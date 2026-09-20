import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createQuitCoordinator,withinDeadline} from '../src/main/quit-coordinator.ts';

test('repeated quit shares confirmation and cannot bypass pending checkpoint', async () => {
  const checkpoint=Promise.withResolvers<void>();
  let confirmations=0,preparations=0,exits=0;
  const quit=createQuitCoordinator({confirm:async()=>{confirmations++;return true;},prepare:()=>{preparations++;return checkpoint.promise;},exit:()=>{exits++;},onError:()=>assert.fail('unexpected failure')});
  const first=quit.request();
  assert.equal(first,quit.request());
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(quit.allowed,false);assert.equal(exits,0);assert.equal(quit.pending,true);
  assert.equal(first,quit.request());checkpoint.resolve();await first;
  assert.equal(confirmations,1);assert.equal(preparations,1);assert.equal(exits,1);assert.equal(quit.allowed,true);
});

test('cancel keeps runtime alive and a later quit can succeed',async()=>{
  let allow=false,preparations=0,exits=0;
  const quit=createQuitCoordinator({confirm:async()=>allow,prepare:async()=>{preparations++;},exit:()=>{exits++;},onError:()=>assert.fail('unexpected failure')});
  await quit.request();assert.equal(preparations,0);assert.equal(quit.allowed,false);
  allow=true;await quit.request();assert.equal(preparations,1);assert.equal(exits,1);
});

test('deadline keeps exit blocked; the same underlying disposal can finish for retry',async()=>{
  const disposal=Promise.withResolvers<void>();let exits=0,errors=0;
  const quit=createQuitCoordinator({confirm:async()=>true,prepare:()=>withinDeadline(disposal.promise,5),exit:()=>{exits++;},onError:()=>{errors++;}});
  await quit.request();assert.equal(errors,1);assert.equal(exits,0);assert.equal(quit.allowed,false);
  disposal.resolve();await quit.request();assert.equal(exits,1);assert.equal(quit.allowed,true);
});
