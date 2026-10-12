/** #400 runtime half: batched streaming writes, message boundaries, output on demand, sub-agent groups, turn digest. */
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service.ts';
import {AgentStore} from '../src/runtime/store.ts';
import {DIFF_PREVIEW_CHARS,OUTPUT_PREVIEW_CHARS,changeCounts,itemDetail,wireItem} from '../src/runtime/transcript-wire.ts';
import {testCounts,turnDigest} from '../src/shared/turn-digest.ts';
import type {ProviderAdapter,ProviderInput,ProviderResult} from '../src/runtime/provider.ts';
import type {TimelineItem} from '../src/shared/protocol.ts';

const info:ProviderAdapter['info']=()=>[{id:'hybrow',name:'Hybrow',available:true,identityMasked:'Hidden',bindingId:'gateway',models:[{id:'claude/claude-fable-5',name:'Fable'}]}];
async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-x1-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<1000;i++){if(await check())return;await delay(3);}assert.fail('condition not reached');}
async function serve(t:TestContext,script:(input:ProviderInput)=>Promise<void>){
  const provider:ProviderAdapter={info,async run(input){input.onThreadReady?.('thread-1');await script(input);return {status:'completed',finalMessage:''} as ProviderResult;},async stop(){return true;},dispose(){}};
  const service=createAgentService({dataDir:await directory(t),provider,onEvent(){}});t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  const send=async(text:string)=>{await service.invoke('chat.send',{id:chat.id,text,requestId:crypto.randomUUID()});await until(async()=>(await service.invoke('app.snapshot',undefined)).chats.find(c=>c.id===chat.id)?.status==='completed');};
  return {service,chat,send,timeline:(full=false)=>service.invoke('chat.timeline',{id:chat.id,full})};
}

test('streaming a 2,000-token answer writes its row at least 10x less often than once per token',async t=>{
  const TOKENS=2000;
  const {send,timeline}=await serve(t,async input=>{for(let i=0;i<TOKENS;i++){input.onDelta(`t${i} `);if(i%25===24)await delay(2);}});
  const before=(await timeline()).revision;
  await send('stream please');
  const after=await timeline();
  const answer=after.items.find(item=>item.kind==='assistant')!;
  assert.equal(answer.text.split(' ').filter(Boolean).length,TOKENS,'every token reaches the row');
  assert.equal(answer.status,'completed');
  // Each timeline write bumps the chat's revision; the run also writes the prompt, the digest and the status.
  const writes=after.revision-before;
  console.log(`[x1] streaming writes per answer: ${writes} for ${TOKENS} deltas (was ${TOKENS + 3})`);
  assert.ok(writes*10<=TOKENS,`expected at most ${TOKENS/10} writes, saw ${writes}`);
});

test('the store stages rows and flushes them before any timeline read',async t=>{
  const store=new AgentStore(await directory(t));t.after(()=>store.close());
  const chat=store.createChat({model:'m',mode:'agent'});
  const row=store.appendItem(chat.id,'assistant','','running');
  const writes=store.timelineWriteCount();
  for(let i=0;i<500;i++)store.stageItem(row.id,'x'.repeat(i+1),'running');
  assert.equal(store.timelineWriteCount(),writes,'staging writes nothing');
  assert.equal(store.peekItem(row.id)?.text.length,500,'peek sees the staged text without writing');
  assert.equal(store.timelineWriteCount(),writes);
  assert.equal(store.timeline(chat.id)[0]!.text.length,500,'a read flushes first');
  assert.equal(store.timelineWriteCount(),writes+1,'500 stages cost one write');
  store.stageItem(row.id,'staged','running');store.updateItem(row.id,'final','completed');
  assert.equal(store.item(row.id)?.text,'final','a direct write supersedes the staged text');
  assert.equal(store.item(row.id)?.status,'completed');
});

test('two provider messages stay two replies even with no tool between them',async t=>{
  const {send,timeline}=await serve(t,async input=>{
    input.onEvent('item/started',{item:{type:'agentMessage',id:'m1'}});
    input.onEvent('item/agentMessage/delta',{itemId:'m1',delta:'Let me look back.'});input.onDelta('Let me look back.');
    input.onEvent('item/agentMessage/delta',{itemId:'m2',delta:'The'});input.onDelta('The');
    input.onEvent('item/agentMessage/delta',{itemId:'m2',delta:' answer.'});input.onDelta(' answer.');
    input.onEvent('muster/messageBoundary',{});input.onDelta('Third.');
  });
  await send('go');
  const replies=(await timeline()).items.filter(item=>item.kind==='assistant').map(item=>item.text);
  assert.deepEqual(replies,['Let me look back.','The answer.','Third.']);
});

test('tool output and big diffs travel as capped previews; chat.itemDetail returns the rest',async t=>{
  const long=Array.from({length:4000},(_,i)=>`line ${i}`).join('\n');
  const bigDiff='@@ -1,1 +1,6000 @@\n'+Array.from({length:6000},(_,i)=>`+added ${i}`).join('\n');
  const {service,chat,send,timeline}=await serve(t,async input=>{
    input.onEvent('item/started',{item:{type:'commandExecution',id:'c1',command:'npm run build'}});
    input.onEvent('item/commandExecution/outputDelta',{itemId:'c1',delta:long});
    input.onEvent('item/completed',{item:{type:'commandExecution',id:'c1',command:'npm run build',exitCode:0,status:'completed'}});
    input.onEvent('item/completed',{item:{type:'fileChange',id:'f1',status:'completed',changes:[{path:'big.ts',kind:'add',diff:bigDiff},{path:'small.ts',kind:'update',diff:'@@ -1 +1 @@\n-a\n+b'}]}});
  });
  await send('build');
  const shown=(await timeline()).items,tool=shown.find(item=>item.data?.type==='commandExecution')!;
  assert.ok((tool.data!.output as string).length<=OUTPUT_PREVIEW_CHARS,'the stream carries a preview');
  assert.equal(tool.data!.outputWithheld,true);
  assert.ok((tool.data!.output as string).endsWith('line 3999'),'the newest output is kept');
  const edit=shown.find(item=>item.data?.type==='fileChange')!,changes=edit.data!.changes as Record<string,unknown>[];
  assert.equal(changes[0]!.diffWithheld,true);assert.equal(changes[0]!.diff,undefined);
  assert.equal(changes[0]!.adds,6000,'counts survive withholding');
  assert.equal(changes[1]!.diff,'@@ -1 +1 @@\n-a\n+b','a small diff travels whole');
  const full=(await timeline(true)).items.find(item=>item.id===tool.id)!;
  assert.equal((full.data!.output as string).length,long.length,'full:true keeps the row whole for runtime callers');
  const detail=await service.invoke('chat.itemDetail',{chatId:chat.id,itemId:tool.id});
  assert.equal(detail.output?.text,long,'the detail returns the whole output');
  const diff=await service.invoke('chat.itemDetail',{chatId:chat.id,itemId:edit.id});
  assert.equal(diff.changes?.[0]?.diff,bigDiff);
  await assert.rejects(service.invoke('chat.itemDetail',{chatId:chat.id,itemId:'nope'}),/no longer/);
});

test('wire helpers: previews, counts and detail caps',()=>{
  const item:TimelineItem={id:'i',chatId:'c',kind:'tool',text:'',createdAt:'',data:{type:'fileChange',changes:[{path:'a',kind:'update',diff:'x'.repeat(DIFF_PREVIEW_CHARS+1)}]}};
  assert.notEqual(wireItem(item),item);
  const small:TimelineItem={...item,data:{type:'commandExecution',output:'ok'}};
  assert.equal(wireItem(small),small,'rows under every cap pass through unchanged');
  assert.deepEqual(changeCounts({diff:'@@ -1,2 +1,2 @@\n-a\n+b\n c\n'}),{adds:1,dels:1});
  assert.deepEqual(changeCounts({kind:'add',diff:'a\nb\n'}),{adds:2,dels:0});
  assert.deepEqual(changeCounts({before:'a\n',after:'a\nb\nc\n'}),{adds:3,dels:1});
  const detail=itemDetail({...item,data:{output:'tail'}},{text:'whole log',start:10,size:20});
  assert.deepEqual(detail.output,{text:'whole log',truncated:true,totalBytes:20});
});

test('sub-agent rows of one run share a group, and the turn gets a digest',async t=>{
  const {send,timeline}=await serve(t,async input=>{
    input.onEvent('item/started',{item:{type:'collabAgentToolCall',id:'a1',tool:'spawn_agent',receiverThreadIds:['t1']}});
    input.onEvent('item/started',{item:{type:'collabAgentToolCall',id:'a2',tool:'spawn_agent',receiverThreadIds:['t2']}});
    input.onEvent('item/completed',{item:{type:'collabAgentToolCall',id:'a1',tool:'spawn_agent',receiverThreadIds:['t1'],status:'completed'}});
    input.onEvent('item/completed',{item:{type:'fileChange',id:'f1',status:'completed',changes:[{path:'a.ts',kind:'update',diff:'@@ -1 +1 @@\n-a\n+b'}]}});
    input.onEvent('item/completed',{item:{type:'commandExecution',id:'c1',command:'npm test',aggregatedOutput:'# pass 3\n# fail 0',exitCode:0,status:'completed'}});
    input.onDelta('Done.');
  });
  await send('work');
  const items=(await timeline()).items,groups=new Set(items.filter(item=>item.data?.type==='collabAgentToolCall').map(item=>item.data!.subagentGroup));
  assert.equal(groups.size,1,'one group for the run');assert.ok([...groups][0]);
  assert.equal(items.find(item=>item.kind==='user')!.data?.turnDigest,'Edited 1 file, ran tests (3 passed), ran 2 sub-agents');
});

test('turn digest is deterministic and short',()=>{
  const tool=(data:Record<string,unknown>,id=String(Math.random())):TimelineItem=>({id,chatId:'c',kind:'tool',text:'',status:'completed',createdAt:'',data});
  assert.equal(turnDigest([]),'');
  assert.equal(turnDigest([tool({type:'commandExecution',command:'ls'}),tool({type:'commandExecution',command:'pwd'})]),'Ran 2 commands');
  assert.equal(turnDigest([
    tool({type:'fileChange',changes:[{path:'a'},{path:'b'}]}),
    tool({type:'commandExecution',command:'pytest -q',output:'1 failed, 2 passed'}),
    tool({type:'commandExecution',command:'pytest -q',output:'3 passed in 0.1s'}),
    tool({type:'mcpToolCall',tool:'navigate',arguments:JSON.stringify({url:'https://news.example.com/x'})}),
    tool({type:'mcpToolCall',tool:'navigate',arguments:JSON.stringify({url:'https://www.example.org'})}),
    tool({type:'mcpToolCall',tool:'navigate',arguments:JSON.stringify({url:'https://example.org/again'})}),
    tool({type:'webSearch',query:'q'}),
  ]),'Edited 2 files, ran tests (3 passed), opened 2 sites','the last test run wins and only three parts are kept');
  assert.deepEqual(testCounts('Tests:       2 failed, 9 passed, 11 total'),{passed:9,failed:2});
  assert.deepEqual(testCounts('ℹ pass 4\nℹ fail 0'),{passed:4});
  assert.equal(testCounts('nothing here'),undefined);
});
