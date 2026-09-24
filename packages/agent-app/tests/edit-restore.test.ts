import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm,mkdir,writeFile,readFile,stat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import {externalActions,ownedPaths} from '../src/runtime/edit-restore.ts';
import type {ProviderAdapter,ProviderInput} from '../src/runtime/provider.ts';
import type {TimelineItem} from '../src/shared/protocol.ts';

const info:ProviderAdapter['info']=()=>[{id:'hybrow',name:'Hybrow',available:true,identityMasked:'Hidden',bindingId:'gateway',models:[{id:'claude/claude-fable-5',name:'Fable'}]}];
async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-restore-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<1500;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,4));}assert.fail('condition not reached');}
const git=(cwd:string,...args:string[])=>execFileSync('git',['-c','user.email=t@t','-c','user.name=t',...args],{cwd});

type Step=(root:string)=>Promise<Array<Record<string,unknown>>>;
/** Each run waits for its pre-run baseline (as a real turn's first write effectively does), then applies its scripted step. */
async function setup(t:TestContext,steps:Step[]){
  const dataDir=await directory(t),inputs:ProviderInput[]=[];
  const root=join(dataDir,'repo');await mkdir(root);
  git(root,'init','-q');await writeFile(join(root,'a.ts'),'original a\n');await writeFile(join(root,'keep.ts'),'keep\n');git(root,'add','.');git(root,'commit','-qm','init');
  let service!:ReturnType<typeof createAgentService>;
  const provider:ProviderAdapter={info,async run(input){inputs.push(input);input.onThreadReady?.(`thread-${inputs.length}`);
    await service.invoke('review.baselines' as never,{chatId:input.chat.id} as never);
    const step=steps[inputs.length-1];
    for(const item of step?await step(root):[])input.onEvent?.('item/completed',{item});
    return {status:'completed',finalMessage:`reply-${inputs.length}`};},async stop(){return true;},dispose(){}};
  service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const folder=await service.invoke('folder.add',{path:root});
  const chat=await service.invoke('chat.create',{folderId:folder.id});
  const items=async(id=chat.id)=>(await service.invoke('chat.timeline',{id})).items;
  const settled=async(turns:number)=>until(async()=>{const c=(await service.invoke('app.snapshot',undefined)).chats.find(x=>x.id===chat.id)!;return c.status==='completed'&&(await items()).filter(i=>i.kind==='assistant').length>=turns;});
  return {service,inputs,root,folder,chat,items,settled};
}
const change=(id:string,changes:Array<Record<string,unknown>>)=>({id,type:'fileChange',status:'completed',changes});

test('owned paths come only from agent file changes inside the folder; commands are counted, never owned',()=>{
  const item=(data:Record<string,unknown>):TimelineItem=>({id:String(Math.random()),chatId:'c',kind:'tool',text:'',createdAt:'',data});
  const items=[item({type:'fileChange',changes:[{path:'/repo/src/a.ts'},{path:'b.ts',movePath:'c.ts'},{path:'/elsewhere/x.ts'},{path:'../up.ts'},{path:'/repo/.git/config'}]}),item({type:'commandExecution',command:'npm i'}),item({type:'mcpToolCall',tool:'deploy'})];
  assert.deepEqual(ownedPaths(items,['/repo']),['b.ts','c.ts','src/a.ts']);
  assert.equal(externalActions(items),2);
});

test('restore previews, puts back owned files, deletes created ones, leaves other changes, then replaces the turn',async t=>{
  const {service,inputs,root,chat,items,settled}=await setup(t,[
    async()=>[],
    async root=>{await writeFile(join(root,'a.ts'),'agent a\n');await writeFile(join(root,'new.ts'),'agent new\n');
      return [change('fc1',[{path:join(root,'a.ts'),kind:'update'},{path:'new.ts',kind:'add'}]),{id:'cmd1',type:'commandExecution',command:'npm test',status:'completed',exitCode:0}];},
  ]);
  await service.invoke('chat.send',{id:chat.id,text:'plan',requestId:'r1'});await settled(1);
  await service.invoke('chat.send',{id:chat.id,text:'edit files',requestId:'r2'});await settled(2);
  // A change the user made meanwhile: never Muster's to restore.
  await writeFile(join(root,'keep.ts'),'user edit\n');
  const prompt=(await items()).filter(i=>i.kind==='user')[1]!;
  assert.equal((await service.invoke('chat.editOptions',{id:chat.id,itemId:prompt.id})).canReplace,false,'plain replace stays blocked');
  const preview=await service.invoke('chat.editRestorePreview',{id:chat.id,itemId:prompt.id});
  assert.equal(preview.available,true,preview.reason??'');
  assert.deepEqual(preview.files.map(f=>[f.path,f.action]),[['a.ts','restore'],['new.ts','delete']]);
  assert.deepEqual(preview.left,['keep.ts']);
  assert.equal(preview.external,1);
  assert.equal(preview.files[0]!.adds,1);assert.equal(preview.files[0]!.dels,1);

  // A file edited after the preview refuses the whole restore and touches nothing.
  await writeFile(join(root,'a.ts'),'edited again\n');
  await assert.rejects(service.invoke('chat.editResend',{id:chat.id,itemId:prompt.id,text:'edit less',requestId:'x1',mode:'restore',restoreFiles:preview.files.map(({path,afterHash})=>({path,afterHash}))}),/changed since the preview|after the preview/);
  assert.equal(await readFile(join(root,'new.ts'),'utf8'),'agent new\n','nothing was restored');
  assert.equal((await items()).filter(i=>i.kind==='user').length,2,'the conversation is untouched');
  await writeFile(join(root,'a.ts'),'agent a\n');

  // A stale list (not what the preview now shows) is refused too.
  await assert.rejects(service.invoke('chat.editResend',{id:chat.id,itemId:prompt.id,text:'edit less',requestId:'x2',mode:'restore',restoreFiles:[{path:'a.ts',afterHash:'0'.repeat(40)}]}),/review the list again/);

  const fresh=await service.invoke('chat.editRestorePreview',{id:chat.id,itemId:prompt.id});
  const result=await service.invoke('chat.editResend',{id:chat.id,itemId:prompt.id,text:'edit less',requestId:'x3',mode:'restore',restoreFiles:fresh.files.map(({path,afterHash})=>({path,afterHash}))});
  assert.equal(result.chatId,chat.id);assert.equal(result.forked,false);
  assert.deepEqual(result.restored,['a.ts','new.ts']);
  assert.equal(await readFile(join(root,'a.ts'),'utf8'),'original a\n');
  await assert.rejects(stat(join(root,'new.ts')),'a file the agent created is removed');
  assert.equal(await readFile(join(root,'keep.ts'),'utf8'),'user edit\n','a change Muster did not make is left alone');
  await settled(2);
  const texts=(await items()).map(i=>i.kind==='notice'?`notice:${i.text}`:i.text);
  assert.equal(texts[0],'plan');
  const notice=texts.find(text=>text.startsWith('notice:Restored'))!;
  assert.match(notice,/Restored 2 files/);assert.match(notice,/1 command or tool call that ran after it was not undone/);
  assert.ok(texts.includes('edit less'));assert.ok(!texts.includes('edit files'),'the edited turn is gone');
  assert.equal(inputs.length,3);
});

test('restore is blocked without a folder, outside Git, and while another chat works in the same folder',async t=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const {service,root,folder,chat,items,settled}=await setup(t,[
    async root=>{await writeFile(join(root,'a.ts'),'agent\n');return [change('fc1',[{path:'a.ts',kind:'update'}])];},
    async()=>{await gate;return [];},
  ]);
  await service.invoke('chat.send',{id:chat.id,text:'edit',requestId:'b1'});await settled(1);
  const prompt=(await items()).find(i=>i.kind==='user')!;
  assert.equal((await service.invoke('chat.editRestorePreview',{id:chat.id,itemId:prompt.id})).available,true);
  const other=await service.invoke('chat.create',{folderId:folder.id});
  await service.invoke('chat.send',{id:other.id,text:'busy',requestId:'b2'});
  await until(async()=>(await service.invoke('app.snapshot',undefined)).chats.find(c=>c.id===other.id)!.status==='running');
  const blocked=await service.invoke('chat.editRestorePreview',{id:chat.id,itemId:prompt.id});
  assert.equal(blocked.available,false);assert.match(blocked.reason!,/working in this folder/);
  await assert.rejects(service.invoke('chat.editResend',{id:chat.id,itemId:prompt.id,text:'x',requestId:'b3',mode:'restore',restoreFiles:[]}),/working in this folder[\s\S]*fork instead/);
  assert.equal(await readFile(join(root,'a.ts'),'utf8'),'agent\n');
  release();

  const plain=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:plain.id,text:'hi',requestId:'b4'});
  await until(async()=>(await service.invoke('app.snapshot',undefined)).chats.find(c=>c.id===plain.id)!.status==='completed');
  const plainPrompt=(await service.invoke('chat.timeline',{id:plain.id})).items.find(i=>i.kind==='user')!;
  assert.match((await service.invoke('chat.editRestorePreview',{id:plain.id,itemId:plainPrompt.id})).reason!,/no folder/);

  const loose=join(root,'..','loose');await mkdir(loose);
  const looseFolder=await service.invoke('folder.add',{path:loose});
  const looseChat=await service.invoke('chat.create',{folderId:looseFolder.id});
  await service.invoke('chat.send',{id:looseChat.id,text:'hi',requestId:'b5'});
  await until(async()=>(await service.invoke('app.snapshot',undefined)).chats.find(c=>c.id===looseChat.id)!.status==='completed');
  const loosePrompt=(await service.invoke('chat.timeline',{id:looseChat.id})).items.find(i=>i.kind==='user')!;
  assert.match((await service.invoke('chat.editRestorePreview',{id:looseChat.id,itemId:loosePrompt.id})).reason!,/not a Git repository/);
});
