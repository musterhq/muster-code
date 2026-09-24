import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore} from '../src/runtime/store.ts';

// UR-SR-a: no Agent/Ask/Plan picker exists, so a stored 'ask' chat must migrate to Agent (keeping read-only access)
// instead of being locked to read-only forever.
test('legacy Ask chats reopen as Agent chats with read-only access that the access chip can raise', async () => {
  const dataDir=await mkdtemp(join(tmpdir(),'muster-legacy-ask-'));
  try {
    let store=new AgentStore(dataDir);
    const ask=store.createChat({model:'m',mode:'ask'});
    const askFull=store.createChat({model:'m',mode:'ask',permissionMode:'full'});
    const plan=store.createChat({model:'m',mode:'plan'});
    store.close();
    store=new AgentStore(dataDir);
    const migrated=store.chat(ask.id)!;
    assert.equal(migrated.mode,'agent'); assert.equal(migrated.permissionMode,'read-only');
    assert.equal(store.chat(askFull.id)!.mode,'agent'); assert.equal(store.chat(askFull.id)!.permissionMode,'full');
    assert.equal(store.chat(plan.id)!.mode,'plan');
    const raised=store.updateChat(ask.id,{permissionMode:'workspace'});
    assert.equal(raised.permissionMode,'workspace');
    store.close();
  } finally { await rm(dataDir,{recursive:true,force:true}); }
});
