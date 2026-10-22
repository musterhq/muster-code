/** The history HTTP routes resend must stay a valid conversation: it starts with a user message and never holds an empty reply. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {anthropicAdapter} from '../src/runtime/adapters/http-chat.ts';
import {ConversationMemory,type ChatMessage} from '../src/runtime/adapters/shared.ts';
import type {AdapterRunInput} from '../src/runtime/adapters/types.ts';

const sse=(events:unknown[])=>new Response(new ReadableStream({start(c){for(const e of events)c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`));c.close();}}),{status:200});
const input=(extra:Partial<AdapterRunInput>={}):AdapterRunInput=>({chat:{id:'c',mode:'agent'} as AdapterRunInput['chat'],cwd:'/w',prompt:'hi',model:'claude-x',permissionMode:'workspace',signal:new AbortController().signal,
  onThreadReady:()=>{},onTurnAccepted:()=>{},onDelta:()=>{},onReasoning:()=>{},onEvent:()=>{},...extra});

test('trimming to the newest 80 messages never leaves the history starting with a reply',()=>{
  const memory=new ConversationMemory();
  // A steer with no reply in between makes two user messages in a row, so the count is odd.
  const messages:ChatMessage[]=[{role:'user',content:'first'},{role:'user',content:'steer'}];
  for(let i=0;i<40;i++)messages.push({role:'assistant',content:`a${i}`},{role:'user',content:`u${i}`});
  const {threadId}=memory.open();
  memory.commit(threadId,messages);
  const {history}=memory.open(threadId);
  assert.equal(history[0]?.role,'user');
});

test('trimming by size never leaves the history starting with a reply',()=>{
  const memory=new ConversationMemory(64,100);
  const messages:ChatMessage[]=[{role:'user',content:'x'.repeat(60)},{role:'user',content:'steer'},{role:'assistant',content:'y'.repeat(60)},{role:'user',content:'q'},{role:'assistant',content:'z'}];
  const {threadId}=memory.open();
  memory.commit(threadId,messages);
  assert.equal(memory.open(threadId).history[0]?.role,'user');
});

test('a history saved by an older build is resent from its first user message, with no empty reply',async()=>{
  const {mkdtemp,rm,writeFile}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {randomUUID}=await import('node:crypto');
  const dir=await mkdtemp(join(tmpdir(),'muster-history-'));
  try{
    const threadId=randomUUID();
    await writeFile(join(dir,`${threadId}.json`),JSON.stringify([{role:'assistant',content:'orphan'},{role:'user',content:'q'},{role:'assistant',content:''},{role:'user',content:'q2'},{role:'assistant',content:'a'}]));
    const {history,resumed}=new ConversationMemory(64,400_000,()=>dir).open(threadId);
    assert.equal(resumed,true);
    assert.deepEqual(history.map(m=>m.content),['q','(no reply)','q2','a']);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('a turn that produced no text is not resent as an empty assistant message',async()=>{
  const bodies:Array<{messages:Array<{role:string;content:unknown}>}>=[];
  const replies=[[{type:'message_start',message:{usage:{input_tokens:3}}},{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'hmm'}},{type:'message_stop'}],
    [{type:'message_start',message:{usage:{input_tokens:3}}},{type:'content_block_delta',delta:{type:'text_delta',text:'ok'}},{type:'message_stop'}]];
  const adapter=anthropicAdapter({apiKey:()=>'k',memory:new ConversationMemory(),fetch:async(_url,init)=>{bodies.push(JSON.parse(String(init?.body)));return sse(replies[bodies.length-1]!);}});
  const first=await adapter.run(input());
  assert.equal(first.status,'completed');
  await adapter.run(input({prompt:'again',resumeThreadId:first.threadId}));
  for(const message of bodies[1]!.messages)assert.notEqual(typeof message.content==='string'?message.content.trim():'x','',`empty ${message.role} message resent`);
});
