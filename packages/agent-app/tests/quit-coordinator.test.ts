import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createQuitCoordinator,quitChoice,quitPrompt,withinDeadline} from '../src/main/quit-coordinator.ts';

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

test('quit with running work offers keep-in-background, stop-and-quit and cancel; no default loses work', () => {
  const prompt = quitPrompt({runs: 2, commands: true});
  assert.deepEqual(prompt.buttons, ['Keep Working in Background', 'Stop Work and Quit', 'Cancel']);
  assert.equal(quitChoice(prompt, prompt.defaultId), 'background', 'Return keeps work running');
  assert.equal(quitChoice(prompt, prompt.cancelId), 'cancel', 'Escape cancels');
  assert.equal(quitChoice(prompt, 1), 'stop');
  assert.equal(quitChoice(prompt, 9), 'cancel', 'an unknown response never quits');
  assert.match(prompt.detail, /2 agent runs are running, with background commands/);
  assert.match(quitPrompt({runs: 1, commands: false}).detail, /^1 agent run is running\./);
  assert.match(quitPrompt({runs: 0, commands: true}).detail, /^Background commands are running\./);
});
