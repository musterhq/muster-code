import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter,ProviderInput,ProviderResult} from '../src/runtime/provider.ts';
import type {Chat} from '../src/shared/protocol.ts';
import {checkoutSiblings,overlappingPaths,ownersByPath,pendingEditsByChat,worktreeBranchName,worktreeOption,type EditOwner} from '../src/renderer/parallelRuns.ts';

const chat=(id:string,over:Partial<Chat>={}):Chat=>({id,title:id.toUpperCase(),pinned:false,archived:false,draft:'',status:'idle',updatedAt:'2026-09-01',model:'m',mode:'agent',...over});
const folders=[{id:'f1',path:'/work/app'},{id:'f2',path:'/work/app/'},{id:'f3',path:'/work/other'}];

test('CHAT-06: same-checkout siblings are other unarchived chats mid-run in the same directory',()=>{
  const chats=[chat('me',{folderId:'f1'}),chat('a',{folderId:'f1',status:'running'}),chat('b',{folderId:'f2',status:'waiting'}),chat('c',{folderId:'f3',status:'running'}),
    chat('d',{folderId:'f1',status:'completed'}),chat('e',{folderId:'f1',status:'running',archived:true}),chat('g',{status:'running'})];
  assert.deepEqual(checkoutSiblings('me','f1',chats,folders).map(c=>c.id),['a','b'],'a second folder entry for the same path is the same checkout');
  assert.deepEqual(checkoutSiblings('me',undefined,chats,folders),[],'a chat without a folder never collides');
  assert.deepEqual(checkoutSiblings('me','f3',chats,folders).map(c=>c.id),['c']);
});

test('CHAT-06: pending-edit ownership, per chat and per path, and overlap with this chat',()=>{
  const owners:EditOwner[]=[
    {path:'src/a.ts',chatId:'me',title:'Me',status:'completed'},{path:'src/b.ts',chatId:'me',title:'Me',status:'completed'},
    {path:'src/a.ts',chatId:'x',title:'X',status:'running'},{path:'docs.md',chatId:'x',title:'X',status:'running'},{path:'old.ts',chatId:'x',title:'X',status:'running'},
    {path:'src/b.ts',chatId:'y',title:'Y',status:'completed'},
  ];
  const pending=new Set(['src/a.ts','src/b.ts','docs.md']);
  assert.deepEqual(Object.fromEntries(pendingEditsByChat(owners,['x','y'],pending)),{x:['docs.md','src/a.ts'],y:['src/b.ts']},'committed edits (old.ts) are no longer pending');
  assert.deepEqual(overlappingPaths(owners,'me',['x'],pending),['src/a.ts']);
  assert.deepEqual(overlappingPaths(owners,'me',['x','y'],pending),['src/a.ts','src/b.ts']);
  const byPath=ownersByPath(owners,pending);
  assert.deepEqual(byPath.get('src/a.ts')!.map(o=>o.chatId),['x','me'],'the running owner is listed first');
  assert.equal(byPath.has('old.ts'),false);
});

test('CHAT-06: worktree branch names are valid refs; the option says why it is unavailable',()=>{
  const at=new Date(2026,8,23,9,5);
  assert.equal(worktreeBranchName('Fix: login → OAuth (v2)!',at),'muster/fix-login-oauth-v2-0923-0905');
  assert.equal(worktreeBranchName('???',at),'muster/chat-0923-0905');
  assert.ok(worktreeBranchName('x'.repeat(200),at).length<60);
  assert.deepEqual(worktreeOption({isGitRepo:true,hasHistory:false,hasAttachments:true}).enabled,true,'an empty chat moves with its attachments');
  assert.equal(worktreeOption({isGitRepo:null,hasHistory:false,hasAttachments:false}).reason,'Checking Git…');
  assert.equal(worktreeOption({isGitRepo:false,hasHistory:false,hasAttachments:false}).reason,'This folder is not a Git repository');
  assert.match(worktreeOption({isGitRepo:true,hasHistory:true,hasAttachments:true}).reason!,/Attachments stay/);
  assert.match(worktreeOption({isGitRepo:true,hasHistory:false,hasAttachments:false,inProject:true}).reason!,/Project/);
});

// --- runtime: chat.editOwners and paged chat.search ----------------------------------------------
const info:ProviderAdapter['info']=()=>[{id:'hybrow',name:'Hybrow',available:true,identityMasked:'Hidden',bindingId:'gateway',models:[{id:'claude/claude-fable-5',name:'Fable'}]}];
async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-parallel-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<1000;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,3));}assert.fail('condition not reached');}

test('CHAT-06 runtime: chat.editOwners attributes each edited file to the chats that changed it',async t=>{
  const dataDir=await directory(t),root=join(dataDir,'repo');await mkdir(join(root,'src'),{recursive:true});
  const edits:Record<string,string[]>={first:[join(root,'src/a.ts'),'shared.ts'],second:['shared.ts','b.ts']};
  const inputs:ProviderInput[]=[];
  const provider:ProviderAdapter={info,async run(input){inputs.push(input);const paths=edits[input.prompt.includes('first')?'first':'second'];
    input.onEvent?.('item/completed',{item:{id:`fc-${inputs.length}`,type:'fileChange',status:'completed',changes:paths.map(path=>({path,kind:'update'}))}});
    return {status:'completed',finalMessage:'ok'} as ProviderResult;},async stop(){return true;},dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const folder=await service.invoke('folder.add',{path:root});
  const one=await service.invoke('chat.create',{folderId:folder.id}),two=await service.invoke('chat.create',{folderId:folder.id}),elsewhere=await service.invoke('chat.create',{});
  await service.invoke('chat.update',{id:one.id,title:'One'});await service.invoke('chat.update',{id:two.id,title:'Two'});
  await service.invoke('chat.send',{id:one.id,text:'first edit',requestId:'r1'});
  await until(async()=>(await service.invoke('app.snapshot',undefined)).chats.find(c=>c.id===one.id)?.status==='completed');
  await service.invoke('chat.send',{id:two.id,text:'second edit',requestId:'r2'});
  await until(async()=>(await service.invoke('app.snapshot',undefined)).chats.find(c=>c.id===two.id)?.status==='completed');
  const owners=await service.invoke('chat.editOwners',{folderId:folder.id});
  const pairs=owners.map(o=>`${o.path}:${o.title}`).sort();
  assert.deepEqual(pairs,['b.ts:Two','shared.ts:One','shared.ts:Two','src/a.ts:One'],'absolute and relative paths both land folder-relative');
  assert.ok(owners.every(o=>o.chatId!==elsewhere.id));
  assert.ok(owners.every(o=>o.status==='completed'));
  await assert.rejects(service.invoke('chat.editOwners',{folderId:'nope'}),/Folder does not exist/);
});

test('NAV-11 runtime: chat.search pages through every matching chat with highlight ranges',async t=>{
  const dataDir=await directory(t);
  const provider:ProviderAdapter={info,async run(){return {status:'completed',finalMessage:'Deploying the payments service now.'} as ProviderResult;},async stop(){return true;},dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const ids:string[]=[];
  for(let n=0;n<5;n++){const c=await service.invoke('chat.create',{});ids.push(c.id);await service.invoke('chat.send',{id:c.id,text:`chat ${n} please deploy payments`,requestId:`s${n}`});}
  await until(async()=>(await service.invoke('app.snapshot',undefined)).chats.filter(c=>c.status==='completed').length===5);
  const first=await service.invoke('chat.search',{query:'payments deploy',limit:2});
  const rest=await service.invoke('chat.search',{query:'payments deploy',offset:2,limit:10});
  assert.equal(first.length,2);assert.equal(rest.length,3);
  assert.deepEqual(new Set([...first,...rest].map(r=>r.chatId)),new Set(ids));
  const hit=first[0]!;
  assert.ok(hit.itemId&&hit.matches===2,'both the prompt and the reply matched');
  assert.deepEqual(hit.ranges!.map(([s,e])=>hit.snippet.slice(s,e).toLowerCase()).sort(),['deploy','payments']);
  await assert.rejects(service.invoke('chat.search',{query:'x',offset:-1}),/Invalid offset/);
});
