import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore} from '../src/runtime/store.ts';
import {createAgentService} from '../src/runtime/service.ts';
import {chatMenuTemplate,folderMenuTemplate} from '../src/main/chat-menu.ts';
import {chatGroup,dropSlot,edgeScrollStep,reorderedIds,stepReorder} from '../src/renderer/chatNavigation.ts';
import {chatOrder} from '../src/renderer/navHistory.ts';
import {customSnoozeInstant,snoozeChoices,snoozeLabel} from '../src/shared/snooze.ts';
import type {ProviderAdapter,ProviderResult} from '../src/runtime/provider.ts';
import type {AgentEvent,Chat} from '../src/shared/protocol.ts';

async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-snooze-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<500;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('condition not reached');}
const info:ProviderAdapter['info']=()=>[{id:'hybrow',name:'Hybrow',available:true,identityMasked:'Hidden',bindingId:'gateway',models:[{id:'claude/claude-fable-5',name:'Fable'}]}];
function gated(){
  let gate:PromiseWithResolvers<ProviderResult>|undefined;let runs=0;
  const provider:ProviderAdapter={info,async run(input){runs++;gate=Promise.withResolvers();input.onThreadReady?.(`thread-${runs}`);return gate.promise;},async stop(){return true;},dispose(){}};
  return {provider,runs:()=>runs,settle:(result:ProviderResult={status:'completed',finalMessage:'done'})=>gate!.resolve(result)};
}
const later=(ms:number)=>new Date(Date.now()+ms).toISOString();

test('CHAT-16 stable ordering: metadata-only edits keep updatedAt; run activity moves it',async t=>{
  const store=new AgentStore(await directory(t));t.after(()=>store.close());
  const chat=store.createChat({model:'m',mode:'agent'});
  const before=store.chat(chat.id)!.updatedAt;
  await new Promise(resolve=>setTimeout(resolve,5));
  for(const patch of [{title:'Renamed'},{pinned:true},{pinned:false},{draft:'typing'},{model:'other'},{archived:true},{archived:false}] as const)store.updateChat(chat.id,patch);
  store.rebindChat(chat.id,{projectId:null});
  store.snoozeChat(chat.id,later(60_000),false);store.wakeChat(chat.id,false);
  assert.equal(store.chat(chat.id)!.updatedAt,before,'rename, pin, draft, model, archive, rebind and snooze never reorder Recent');
  store.updateChat(chat.id,{status:'completed'});
  assert.notEqual(store.chat(chat.id)!.updatedAt,before,'a run settling is activity');
});

test('UX-12/UX-23 pin reorder takes the full visible list, keeps snoozed pins after it, and refuses a stale list',async t=>{
  const store=new AgentStore(await directory(t));t.after(()=>store.close());
  const [a,b,c,z]=[0,1,2,3].map(()=>store.createChat({model:'m',mode:'agent'}));
  for(const chat of [a,b,c,z])store.updateChat(chat!.id,{pinned:true});
  store.snoozeChat(z!.id,null,true);
  assert.throws(()=>store.reorderPins([a!.id,b!.id]),/pinned list changed/,'a partial list is refused without mutation');
  store.reorderPins([c!.id,a!.id,b!.id]);
  const order=store.snapshot().chats.filter(chat=>chat.pinned).sort((x,y)=>x.pinOrder!-y.pinOrder!).map(chat=>chat.id);
  assert.deepEqual(order,[c!.id,a!.id,b!.id,z!.id]);
});

test('NAV-05 folder order persists across restart; move up/down no-ops at the ends',async t=>{
  const dir=await directory(t);
  let store=new AgentStore(dir);
  const [one,two,three]=['/tmp/one','/tmp/two','/tmp/three'].map(path=>store.addFolder(path,path.slice(5)));
  store.moveFolder(three!.id,'up');
  store.moveFolder(one!.id,'up');
  assert.deepEqual(store.snapshot().folders.map(folder=>folder.name),['one','three','two']);
  assert.throws(()=>store.reorderFolders([one!.id]),/folder list changed/);
  store.reorderFolders([two!.id,one!.id,three!.id]);
  store.close();store=new AgentStore(dir);t.after(()=>store.close());
  assert.deepEqual(store.snapshot().folders.map(folder=>folder.name),['two','one','three'],'order survives a restart');
  const four=store.addFolder('/tmp/four','four');
  assert.equal(store.snapshot().folders.at(-1)!.id,four.id,'a new folder lands at the end');
});

test('CHAT-15 wake is one transition: conditional, due list, unread only for timed/activity wakes',async t=>{
  const store=new AgentStore(await directory(t));t.after(()=>store.close());
  const chat=store.createChat({model:'m',mode:'agent'});
  store.updateChat(chat.id,{draft:'keep me'});
  store.snoozeChat(chat.id,new Date(Date.now()-1000).toISOString(),false);
  assert.deepEqual(store.dueSnoozes(new Date()).due,[chat.id]);
  assert.equal(store.wakeChat(chat.id,true),true);
  assert.equal(store.wakeChat(chat.id,true),false,'a second wake (timer racing manual) is no transition');
  const woke=store.chat(chat.id)!;
  assert.equal(woke.unread,true);assert.equal(woke.draft,'keep me','the draft is intact');
  assert.equal(woke.snoozedUntil,undefined);
});

test('CHAT-15 service: validation, restart across the wake time notifies once, manual wake stays quiet, activity wakes',async t=>{
  const dir=await directory(t),events:AgentEvent[]=[];
  const run=gated();
  let service=createAgentService({dataDir:dir,provider:run.provider,onEvent:event=>events.push(event)});
  const sleeper=await service.invoke('chat.create',{});
  const other=await service.invoke('chat.create',{});
  await assert.rejects(service.invoke('chat.snooze',{id:sleeper.id,until:new Date(Date.now()-60_000).toISOString()}),/future/);
  await assert.rejects(service.invoke('chat.snooze',{id:sleeper.id}),/when this chat should wake/);
  const snoozed=await service.invoke('chat.snooze',{id:sleeper.id,until:later(1500)});
  assert.ok(snoozed.snoozedUntil);
  await service.dispose();
  // Restart after the wake time passed: the new process wakes it exactly once.
  await new Promise(resolve=>setTimeout(resolve,1600));
  events.length=0;
  service=createAgentService({dataDir:dir,provider:run.provider,onEvent:event=>events.push(event)});t.after(()=>service.dispose());
  const woke=events.filter(event=>event.type==='chatWoke');
  assert.equal(woke.length,1);assert.deepEqual({chatId:(woke[0] as {chatId:string}).chatId,reason:(woke[0] as {reason:string}).reason},{chatId:sleeper.id,reason:'time'});
  const after=(await service.invoke('app.snapshot',undefined)).chats.find(chat=>chat.id===sleeper.id)!;
  assert.equal(after.unread,true);assert.equal(after.snoozedUntil,undefined);
  // Manual wake: no notification, no unread.
  await service.invoke('chat.snooze',{id:other.id,until:later(3_600_000)});
  events.length=0;
  await service.invoke('chat.wake',{id:other.id});
  assert.equal(events.filter(event=>event.type==='chatWoke').length,0);
  // Until new activity: a settling run wakes it; the run was never stopped by the snooze.
  await service.invoke('chat.send',{id:other.id,text:'go',requestId:'go-1'});
  await service.invoke('chat.snooze',{id:other.id,untilActivity:true});
  assert.equal((await service.invoke('app.snapshot',undefined)).chats.find(chat=>chat.id===other.id)!.status,'running','snooze never stops a run');
  events.length=0;
  await until(()=>run.runs()===1);
  run.settle();
  await until(()=>events.some(event=>event.type==='chatWoke'));
  assert.equal((events.find(event=>event.type==='chatWoke') as {reason:string}).reason,'activity');
});

test('CHAT-16 auto-archive is opt-in and never takes pinned, snoozed, unread, active or queued chats',async t=>{
  const dir=await directory(t);
  const seed=new AgentStore(dir);
  const make=()=>seed.createChat({model:'m',mode:'agent'});
  const idle=make(),pinned=make(),snoozed=make(),unread=make(),fresh=make(),active=make();
  seed.updateChat(pinned.id,{pinned:true});
  seed.snoozeChat(snoozed.id,null,true);
  seed.setUnread(unread.id,true);
  const old=new Date(Date.now()-40*86_400_000).toISOString();
  seed.database().prepare('UPDATE chats SET updated_at = ? WHERE id != ?').run(old,fresh.id);
  seed.setActiveChat(active.id);
  seed.close();
  const events:AgentEvent[]=[];
  const service=createAgentService({dataDir:dir,provider:gated().provider,onEvent:event=>events.push(event)});t.after(()=>service.dispose());
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal((await service.invoke('app.snapshot',undefined)).chats.filter(chat=>chat.archived).length,0,'off by default');
  await service.invoke('settings.set',{key:'chats.autoArchiveDays',value:30});
  await until(async()=>(await service.invoke('app.snapshot',undefined)).chats.some(chat=>chat.archived));
  const archived=(await service.invoke('app.snapshot',undefined)).chats.filter(chat=>chat.archived).map(chat=>chat.id);
  assert.deepEqual(archived,[idle.id]);
  assert.ok(events.some(event=>event.type==='notice'&&/Archived 1 chat idle/.test(event.message)));
});

test('reorder helpers: insertion slots, keyboard step equals the drag result, bounded autoscroll',()=>{
  const ids=['a','b','c','d'];
  assert.deepEqual(reorderedIds(ids,'a',3),['b','c','a','d']);
  assert.deepEqual(reorderedIds(ids,'d',0),['d','a','b','c']);
  assert.equal(reorderedIds(ids,'b',1),null,'dropping where it already is sends nothing');
  assert.equal(reorderedIds(ids,'b',2),null);
  assert.deepEqual(stepReorder(ids,'b','down'),['a','c','b','d']);
  assert.deepEqual(stepReorder(ids,'b','up'),['b','a','c','d']);
  assert.equal(stepReorder(ids,'a','up'),null);assert.equal(stepReorder(ids,'d','down'),null);
  assert.equal(dropSlot(2,105,{top:100,height:20}),2);assert.equal(dropSlot(2,115,{top:100,height:20}),3);
  const rect={top:0,bottom:400};
  assert.equal(edgeScrollStep(200,rect),0);
  assert.ok(edgeScrollStep(5,rect)<0&&edgeScrollStep(-500,rect)>=-14,'bounded upward');
  assert.ok(edgeScrollStep(395,rect)>0&&edgeScrollStep(900,rect)<=14,'bounded downward');
});

test('Snoozed group, chat order, labels, presets and menus',()=>{
  const base=(id:string,patch:Partial<Chat>={}):Chat=>({id,title:id,pinned:false,archived:false,draft:'',status:'completed',updatedAt:'2026-09-20T00:00:00Z',model:'m',mode:'agent',...patch});
  const snapshot={folders:[],projects:[],chats:[base('pin',{pinned:true,pinOrder:1}),base('sleep',{pinned:true,snoozedUntil:'2026-09-30T09:00:00.000Z'}),base('plain'),base('old',{archived:true})]};
  assert.equal(chatGroup(snapshot.chats[1]!,snapshot),'snoozed','a snoozed pin waits in Snoozed');
  assert.deepEqual(chatOrder(snapshot,'recent').map(chat=>chat.id),['pin','plain','sleep','old']);
  assert.match(snoozeLabel({snoozeUntilActivity:true}),/new activity/);
  const previous=process.env.TZ;process.env.TZ='America/New_York';
  try {
    // The evening before US DST starts (8 Mar 2026): "Tomorrow" is still 9 AM local wall time.
    const choices=snoozeChoices(new Date(2026,2,7,20,0));
    const tomorrow=new Date(choices.find(choice=>choice.preset==='tomorrow')!.until!);
    assert.equal(tomorrow.getHours(),9);assert.equal(tomorrow.toISOString(),'2026-03-08T13:00:00.000Z');
    assert.ok(!choices.some(choice=>choice.preset==='later-today'),'no "later today" late in the evening');
    const monday=new Date(choices.find(choice=>choice.preset==='next-week')!.until!);
    assert.equal(monday.getDay(),1);assert.equal(monday.getHours(),9);
    assert.equal(customSnoozeInstant('2026-03-08T09:30',new Date(2026,2,7)),'2026-03-08T13:30:00.000Z');
    assert.equal(customSnoozeInstant('2020-01-01T09:00',new Date(2026,2,7)),null);
  } finally { if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous; }
  const pick=()=>{};
  const labels=(chat:Chat)=>chatMenuTemplate({chat,folders:[],projects:[],surface:'sidebar'},pick).map(item=>item.label);
  assert.ok(labels(base('x')).includes('Snooze'));
  assert.ok(labels(base('x',{snoozeUntilActivity:true})).includes('Wake Now'));
  const folder={id:'f',path:'/tmp/f',name:'f'};
  const first=folderMenuTemplate(folder,pick,{first:true,last:false});
  assert.equal(first.find(item=>item.label==='Move Up')!.enabled,false);
  assert.equal(first.find(item=>item.label==='Move Down')!.enabled,true);
});
