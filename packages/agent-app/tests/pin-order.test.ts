import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AgentStore} from '../src/runtime/store.ts';

async function withStore(t: any): Promise<AgentStore> {
  const dataDir=await mkdtemp(join(tmpdir(),'muster-pin-'));
  const store=new AgentStore(dataDir);
  t.after(async()=>{store.close();await rm(dataDir,{recursive:true,force:true});});
  return store;
}

const pinnedIds=(store:AgentStore)=>store.snapshot().chats
  .filter(c=>c.pinned&&!c.archived)
  .sort((a,b)=>(a.pinOrder??Infinity)-(b.pinOrder??Infinity))
  .map(c=>c.id);

test('movePin swaps neighbors, no-ops at edges, and unpin frees the slot',async t=>{
  const store=await withStore(t);
  const [a,b,c]=['a','b','c'].map(()=>store.createChat({model:'test',mode:'agent'}));
  for(const chat of [a,b,c]) store.updateChat(chat.id,{pinned:true});
  assert.deepEqual(pinnedIds(store),[a.id,b.id,c.id]);
  store.updateChat(a.id,{pinned:true});
  assert.deepEqual(pinnedIds(store),[a.id,b.id,c.id], 'repeated pin requests preserve the existing order');

  store.movePin(c.id,'up');
  assert.deepEqual(pinnedIds(store),[a.id,c.id,b.id]);

  // Edges: top can't move up, bottom can't move down.
  store.movePin(a.id,'up');
  store.movePin(b.id,'down');
  assert.deepEqual(pinnedIds(store),[a.id,c.id,b.id]);

  // Unpinned chats reject reorder; unpin clears order and re-pin appends at end.
  assert.throws(()=>store.movePin(store.createChat({model:'test',mode:'agent'}).id,'up'),/not pinned/i);
  store.updateChat(a.id,{pinned:false});
  store.updateChat(a.id,{pinned:true});
  assert.deepEqual(pinnedIds(store),[c.id,b.id,a.id]);
});

test('legacy NULL pin_order rows normalize on first move instead of freezing',async t=>{
  const store=await withStore(t);
  const [a,b]=['a','b'].map(()=>store.createChat({model:'test',mode:'agent'}));
  for(const chat of [a,b]) store.updateChat(chat.id,{pinned:true});
  // Simulate pre-migration rows: pinned without explicit order.
  (store as any).db.prepare('UPDATE chats SET pin_order = NULL WHERE pinned = 1').run();

  store.movePin(b.id,'up');
  assert.deepEqual(pinnedIds(store),[b.id,a.id]);
});

test('archived pins cannot reorder visible pins and ordering survives reopen',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'muster-pin-restart-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const first=new AgentStore(dir);
 const a=first.createChat({model:'test',mode:'agent'}),b=first.createChat({model:'test',mode:'agent'});
 first.updateChat(a.id,{pinned:true});first.updateChat(b.id,{pinned:true});
 first.movePin(b.id,'up');first.close();
 const second=new AgentStore(dir);t.after(()=>second.close());
 assert.deepEqual(pinnedIds(second),[b.id,a.id]);
 second.updateChat(b.id,{archived:true});
 assert.throws(()=>second.movePin(b.id,'down'),/restore/i);
 assert.deepEqual(pinnedIds(second),[a.id]);
 second.updateChat(b.id,{archived:false});
 assert.deepEqual(pinnedIds(second),[b.id,a.id]);
});
