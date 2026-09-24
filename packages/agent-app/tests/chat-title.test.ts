import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateChatTitle} from '../src/runtime/chat-title.ts';
import {AgentStore} from '../src/runtime/store.ts';

test('summary titles drop greetings, fillers and code, keep six key words, sentence case, ≤48 chars',()=>{
  assert.equal(generateChatTitle('Hey, can you please fix the login bug in the auth service?'),'Fix login bug in auth service');
  assert.equal(generateChatTitle('Good morning! I want you to add dark mode to the settings screen and persist it'),'Add dark mode to settings screen and persist');
  assert.equal(generateChatTitle('why does `npm test` hang on CI after upgrading to Node 24'),'Why does npm test hang on CI');
  assert.equal(generateChatTitle('```ts\nconst x = 1;\n```\nRefactor useStore into README.md sections'),'Refactor useStore into README.md sections');
  assert.equal(generateChatTitle('Hi!\nFix the flaky upload test'),'Fix flaky upload test','skips a greeting-only line');
  assert.equal(generateChatTitle('hello'),null,'a bare greeting names nothing');
  assert.equal(generateChatTitle('hi there','The migration renames the users table.'),'Migration renames users table','falls back to the reply');
  const long=generateChatTitle('internationalization localization accessibility compatibility maintainability observability')!;
  assert.ok(long.length<=48,long);
  assert.ok(!/ (?:in|of|to|and)$/.test(generateChatTitle('Move the logs of')!),'never ends on a connector');
});

test('titleSource: default until the first completed exchange, generated after, a rename always wins',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'muster-title-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=new AgentStore(dir);t.after(()=>store.close());
  const chat=store.createChat({model:'m',mode:'agent'});
  assert.equal(chat.titleSource,'default');assert.equal(chat.title,'New chat');
  store.recordSend(chat.id,'r1','hey can you migrate the billing service to postgres');
  assert.equal(store.chat(chat.id)!.title,'Migrate billing service to postgres','provisional title while the first turn runs');
  assert.equal(store.chat(chat.id)!.titleSource,'default');
  store.appendItem(chat.id,'assistant','Done.','completed');store.updateChat(chat.id,{status:'completed'});
  assert.equal(store.settleTitle(chat.id),true);
  assert.equal(store.chat(chat.id)!.titleSource,'generated');
  assert.equal(store.settleTitle(chat.id),false,'generated once');

  // A rename to the literal default name is still the user's choice: the first send must not overwrite it.
  const named=store.createChat({model:'m',mode:'agent'});
  store.updateChat(named.id,{title:'New chat'});
  assert.equal(store.chat(named.id)!.titleSource,'user');
  store.recordSend(named.id,'r2','rewrite the parser');
  assert.equal(store.chat(named.id)!.title,'New chat');
  store.updateChat(named.id,{status:'completed'});
  assert.equal(store.settleTitle(named.id),false);assert.equal(store.chat(named.id)!.title,'New chat');

  // A rename mid-run beats the generated title too.
  const renamed=store.createChat({model:'m',mode:'agent'});
  store.recordSend(renamed.id,'r3','summarise the quarterly report');
  store.updateChat(renamed.id,{title:'Q3 notes'});store.updateChat(renamed.id,{status:'completed'});
  assert.equal(store.settleTitle(renamed.id),false);assert.equal(store.chat(renamed.id)!.title,'Q3 notes');
});
