import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,mkdir,rm,stat,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import {exportChat,redactSecrets} from '../src/runtime/chat-export.ts';
import {chatMenuTemplate,folderMenuTemplate,popupChoice,type ChatMenuCommand} from '../src/main/chat-menu.ts';
import {createSettleTracker} from '../src/main/chat-notifications.ts';
import type {ProviderAdapter,ProviderInput,ProviderResult} from '../src/runtime/provider.ts';
import type {Chat,TimelineItem} from '../src/shared/protocol.ts';

const info:ProviderAdapter['info']=()=>[{id:'hybrow',name:'Hybrow',available:true,identityMasked:'Hidden',bindingId:'gateway',models:[{id:'claude/claude-fable-5',name:'Fable'}]}];
async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-actions-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<500;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('condition not reached');}
function gated(t:TestContext){
  const inputs:ProviderInput[]=[];let gate:PromiseWithResolvers<ProviderResult>|undefined;const stopped:string[]=[];
  const provider:ProviderAdapter={info,async run(input){inputs.push(input);gate=Promise.withResolvers();input.onThreadReady?.(`thread-${inputs.length}`);return gate.promise;},
    async stop(id){stopped.push(id);gate?.resolve({status:'failed',finalMessage:'',dispatchState:'dispatched',recovery:{kind:'cancelled',retryable:false,reason:'Stopped.'}});return true;},dispose(){}};
  return {provider,inputs,stopped,settle:(result:ProviderResult={status:'completed',finalMessage:'done'})=>gate!.resolve(result)};
}
const snap=(service:ReturnType<typeof createAgentService>)=>service.invoke('app.snapshot',undefined);
const chatIn=async(service:ReturnType<typeof createAgentService>,id:string)=>(await snap(service)).chats.find(chat=>chat.id===id);

test('delete refuses a running chat unless forced, then removes rows, queue and attachment files',async t=>{
  const dataDir=await directory(t),run=gated(t);
  const service=createAgentService({dataDir,provider:run.provider,onEvent(){}});t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  const staged=await service.invoke('attachments.stage',{chatId:chat.id,name:'notes.txt',mime:'text/plain',dataBase64:Buffer.from('hello').toString('base64')});
  await service.invoke('chat.send',{id:chat.id,text:'work',requestId:'r1',attachmentIds:[staged.id]});
  await until(()=>run.inputs.length===1);
  await service.invoke('chat.queue.add',{id:chat.id,text:'later',requestId:'r2'});
  assert.ok(await stat(join(dataDir,'attachments',chat.id)).then(()=>true,()=>false),'attachment bytes exist before delete');
  await assert.rejects(service.invoke('chat.delete',{id:chat.id}),/still working/,'a running chat is not deleted by accident');
  assert.ok(await chatIn(service,chat.id));
  await service.invoke('chat.delete',{id:chat.id,force:true});
  assert.deepEqual(run.stopped,[chat.id],'force stops the run before deleting');
  assert.equal(await chatIn(service,chat.id),undefined);
  assert.equal(run.inputs.length,1,'the queued follow-up was never dispatched');
  await assert.rejects(service.invoke('chat.timeline',{id:chat.id}),/does not exist/);
  assert.equal(await stat(join(dataDir,'attachments',chat.id)).then(()=>true,()=>false),false,'attachment files are removed');
  const idle=await service.invoke('chat.create',{});
  await service.invoke('chat.delete',{id:idle.id});
  const after=await snap(service);
  assert.equal(after.chats.length,0);assert.equal(after.activeChatId,undefined,'a deleted active chat is no longer suggested');
});

test('a run that settles in the background marks the chat unread until it is opened; mark unread never reorders',async t=>{
  const dataDir=await directory(t),run=gated(t);
  const service=createAgentService({dataDir,provider:run.provider,onEvent(){}});t.after(()=>service.dispose());
  const background=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:background.id,text:'go',requestId:'bg'});
  await until(()=>run.inputs.length===1);
  const other=await service.invoke('chat.create',{});// becomes the active chat
  run.settle();
  await until(async()=>(await chatIn(service,background.id))?.status==='completed');
  assert.equal((await chatIn(service,background.id))?.unread,true,'finished out of sight → unread');
  await service.invoke('chat.timeline',{id:background.id,select:true});
  const seen=await chatIn(service,background.id);
  assert.equal(seen?.unread,undefined,'opening the chat clears unread');assert.ok(seen?.lastViewedAt);
  await service.invoke('chat.send',{id:background.id,text:'again',requestId:'fg'});
  await until(()=>run.inputs.length===2);run.settle();
  await until(async()=>(await chatIn(service,background.id))?.status==='completed');
  assert.equal((await chatIn(service,background.id))?.unread,undefined,'the chat on screen does not become unread');
  const before=(await chatIn(service,background.id))!.updatedAt;
  assert.equal((await service.invoke('chat.markUnread',{id:background.id})).unread,true);
  assert.equal((await chatIn(service,background.id))!.updatedAt,before,'Mark as unread keeps the row where it is');
  assert.equal((await service.invoke('chat.markUnread',{id:background.id,unread:false})).unread,undefined);
  await service.invoke('chat.select',{id:other.id});
});

test('attaching a folder rebinds an idle chat and clears its provider thread; running chats refuse',async t=>{
  const dataDir=await directory(t),folderPath=await directory(t),run=gated(t);
  const service=createAgentService({dataDir,provider:run.provider,onEvent(){}});t.after(()=>service.dispose());
  const folder=await service.invoke('folder.add',{path:folderPath});
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chat.id,text:'hi',requestId:'a'});
  await until(()=>run.inputs.length===1);
  await assert.rejects(service.invoke('chat.update',{id:chat.id,folderId:folder.id}),/Wait for this run/);
  run.settle();await until(async()=>(await chatIn(service,chat.id))?.status==='completed');
  assert.equal((await chatIn(service,chat.id))?.providerThreadId,'thread-1');
  const moved=await service.invoke('chat.update',{id:chat.id,folderId:folder.id});
  assert.equal(moved.folderId,folder.id);assert.equal(moved.providerThreadId,undefined,'the old thread ran elsewhere');
  const {items}=await service.invoke('chat.timeline',{id:chat.id});
  assert.ok(items.some(item=>item.kind==='notice'&&item.text.startsWith(`Now working in ${folder.name}`)),'the timeline records the move');
  await service.invoke('chat.send',{id:chat.id,text:'next',requestId:'b'});
  await until(()=>run.inputs.length===2);
  assert.equal(run.inputs[1]!.cwd,folder.path,'the next send runs in the attached folder');
  assert.equal(run.inputs[1]!.chat.providerThreadId,undefined,'and starts a fresh provider thread');
  run.settle();await until(async()=>(await chatIn(service,chat.id))?.status==='completed');
});

test('folders rename, relink, report missing paths and are removed only with their chats archived',async t=>{
  const dataDir=await directory(t),root=await directory(t),run=gated(t);
  const original=join(root,'repo'),moved=join(root,'repo-moved');await mkdir(original);
  const service=createAgentService({dataDir,provider:run.provider,onEvent(){}});t.after(()=>service.dispose());
  const folder=await service.invoke('folder.add',{path:original});
  const chat=await service.invoke('chat.create',{folderId:folder.id});
  assert.equal((await service.invoke('folder.rename',{id:folder.id,name:'  Client app '})).name,'Client app');
  assert.equal((await snap(service)).folders[0]!.missing,undefined);
  await rename(original,moved);
  const relinked=await service.invoke('folder.relink',{id:folder.id,path:moved});
  assert.ok(relinked.path.endsWith('repo-moved'));assert.equal((await snap(service)).folders[0]!.missing,undefined);
  await assert.rejects(service.invoke('folder.relink',{id:folder.id,path:join(root,'nowhere')}),/does not exist/);
  await assert.rejects(service.invoke('folder.remove',{id:folder.id}),/1 chat uses this folder/);
  assert.deepEqual(await service.invoke('folder.remove',{id:folder.id,archiveChats:true}),{archived:1});
  const after=await snap(service);
  assert.equal(after.folders.some(item=>item.id===folder.id),false);
  assert.equal(after.chats.find(item=>item.id===chat.id)?.archived,true,'its chat is archived, not deleted');
});

test('a folder deleted outside Muster is flagged missing in the snapshot',async t=>{
  const dataDir=await directory(t),path=await directory(t),run=gated(t);
  const first=createAgentService({dataDir,provider:run.provider,onEvent(){}});
  const folder=await first.invoke('folder.add',{path});await first.dispose();
  await rm(path,{recursive:true,force:true});
  const service=createAgentService({dataDir,provider:run.provider,onEvent(){}});t.after(()=>service.dispose());
  assert.equal((await snap(service)).folders.find(item=>item.id===folder.id)?.missing,true);
});

test('archiving a working chat leaves a warning in its timeline',async t=>{
  const dataDir=await directory(t),run=gated(t);
  const service=createAgentService({dataDir,provider:run.provider,onEvent(){}});t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chat.id,text:'go',requestId:'go'});
  await until(()=>run.inputs.length===1);
  await service.invoke('chat.update',{id:chat.id,archived:true});
  const {items}=await service.invoke('chat.timeline',{id:chat.id});
  assert.ok(items.some(item=>item.text.includes('Archiving stops nothing')));
  run.settle();await until(async()=>(await chatIn(service,chat.id))?.status==='completed');
});

test('export keeps chronology, tool summaries and attachment names, and redacts and lists what it leaves out',async t=>{
  const dataDir=await directory(t),run=gated(t);
  const service=createAgentService({dataDir,provider:run.provider,onEvent(){}});t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chat.id,text:'Use key sk-proj-abcdefghijklmnopqrstuvwx and deploy',requestId:'x'});
  await until(()=>run.inputs.length===1);run.settle({status:'completed',finalMessage:'Done. Set api_key=hunter2secret in CI.'});
  await until(async()=>(await chatIn(service,chat.id))?.status==='completed');
  const markdown=await service.invoke('chat.export',{id:chat.id,format:'markdown'});
  assert.ok(markdown.text.indexOf('## You')<markdown.text.indexOf('## Assistant'),'chronological');
  assert.ok(!markdown.text.includes('sk-proj-abcdefghijklmnopqrstuvwx')&&!markdown.text.includes('hunter2secret'),'secrets are masked');
  assert.ok(markdown.text.includes('api_key=[redacted]'),'labels are kept for readability');
  assert.ok(markdown.omitted.some(line=>/2 secret-looking strings/.test(line)));
  assert.match(markdown.fileName,/\.md$/);
  const json=JSON.parse((await service.invoke('chat.export',{id:chat.id,format:'json'})).text);
  assert.equal(json.schemaVersion,1);assert.deepEqual(json.items.map((item:{kind:string})=>item.kind),['user','assistant']);
  await assert.rejects(service.invoke('chat.export',{id:chat.id,format:'pdf' as 'json'}),/Markdown, HTML or JSON/);

  const at='2026-09-23T00:00:00.000Z',item=(kind:TimelineItem['kind'],text:string,data?:Record<string,unknown>,status?:string):TimelineItem=>({id:text,chatId:'c',kind,text,createdAt:at,...(data?{data}:{}),...(status?{status}:{})});
  const offline=exportChat({chat:{...chat,title:'Fix login'},items:[
    item('user','see attached',{attachments:[{name:'trace.log'}]}),item('reasoning','private thoughts'),
    item('tool','npm test\nFAIL token=abcdef123456',{name:'npm test',output:'FAIL token=abcdef123456',type:'commandExecution'},'failed'),
    item('question','The provider needs your input.',{questions:[{id:'q',question:'Password?',isSecret:true}],answers:{q:{answers:['[redacted]']}}}),
  ],exportedAt:at},'markdown');
  assert.ok(offline.text.includes('Attached: trace.log'));assert.ok(offline.text.includes('`npm test` (failed)'));
  assert.ok(!offline.text.includes('private thoughts')&&!offline.text.includes('abcdef123456'));
  assert.deepEqual(offline.omitted.map(line=>line.split(' (')[0]),['1 reasoning block','Raw output of 1 tool call','Contents of 1 attached file','1 secret answer to provider questions']);
  assert.equal(redactSecrets('https://user:pw@github.com/x Bearer abcdefghijklmnopqrstu'),'https://***@github.com/x Bearer [redacted]');
});

test('native chat menu mirrors Codex order with shortcut hints, and folder attach only for folderless chats',()=>{
  const base:Chat={id:'c',title:'T',pinned:true,archived:false,draft:'',status:'completed',updatedAt:'',model:'m',mode:'agent'};
  const picked:ChatMenuCommand[]=[];
  const folders=[{id:'f',name:'Repo',path:'/r'},{id:'g',name:'Gone',path:'/g',missing:true}];
  const labels=(chat:Chat,surface:'sidebar'|'header'='sidebar')=>chatMenuTemplate({chat,folders,projects:[{id:'p',name:'Launch',goal:'',folderIds:['f']}],surface},command=>picked.push(command)).map(item=>item.type==='separator'?'-':item.label);
  assert.deepEqual(labels(base),['Rename…','Unpin','Mark as Unread','Snooze','Archive','Permanently Delete…','-','Project','Folder','Copy','Export…','Share…','Fork','-','Open Command Activity','-','Move Pin Up','Move Pin Down']);
  assert.deepEqual(labels({...base,folderId:'f',pinned:false,unread:true},'header'),['Rename…','Pin','Mark as Read','Snooze','Archive','Permanently Delete…','-','Project','Copy','Export Conversation…','Share…','Fork','-','Open Terminal','Open Files and Changes',process.platform==='darwin'?'Open in Finder':'Open Folder']);
  const template=chatMenuTemplate({chat:base,folders,projects:[],surface:'sidebar'},command=>picked.push(command));
  assert.equal(template[0]!.accelerator,'Alt+CmdOrCtrl+R');assert.equal(template[2]!.accelerator,'Shift+CmdOrCtrl+U');assert.equal(template[4]!.registerAccelerator,false);
  const folderMenu=template.find(item=>item.label==='Folder')!.submenu as Electron.MenuItemConstructorOptions[];
  assert.deepEqual(folderMenu.map(item=>item.label??'-'),['Repo','-','Choose Folder…'],'missing folders are not offered');
  (folderMenu[0]!.click as ()=>void)();assert.deepEqual(picked.at(-1),{kind:'folder',folderId:'f'});
  const copy=(template.find(item=>item.label==='Copy')!.submenu as Electron.MenuItemConstructorOptions[]).map(item=>item.label);
  assert.deepEqual(copy,['Chat Link','Chat ID','Conversation as Markdown']);
  assert.deepEqual(folderMenuTemplate({...folders[1]!},()=>{}).map(item=>item.label??'-'),['New Chat Here','Browse Files',process.platform==='darwin'?'Reveal in Finder':'Show in Folder','-','Rename…','Relink Missing Folder…','Default Model…','-','Move Up','Move Down','-','Remove from Sidebar…']);
});

test('popupChoice keeps a click that lands just after the close callback',async()=>{
  assert.deepEqual(await popupChoice<string>((pick,closed)=>{closed();setTimeout(()=>pick('rename'),10);}),'rename');
  assert.equal(await popupChoice<string>((_pick,closed)=>closed()),null);
});

// NAV-12: Spotlight's chat search beyond titles — finds a chat by what was actually said in it.
test('chat.search finds a chat by message content, not just its title, with a bounded snippet',async t=>{
  const dataDir=await directory(t),run=gated(t);
  const service=createAgentService({dataDir,provider:run.provider,onEvent(){}});t.after(()=>service.dispose());
  const chatA=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chatA.id,text:'Let us switch the database layer to Hono for the proxy',requestId:'r1'});
  await until(()=>run.inputs.length===1);
  run.settle({status:'completed',finalMessage:'Sure, moving to Hono now.'});
  await until(async()=>(await chatIn(service,chatA.id))?.status==='completed');
  const chatB=await service.invoke('chat.create',{});
  await service.invoke('chat.update',{id:chatB.id,title:'Unrelated chat'});
  const results=await service.invoke('chat.search',{query:'hono'});
  assert.ok(results.some(row=>row.chatId===chatA.id),'matches the chat whose message mentions Hono (case-insensitive)');
  assert.ok(!results.some(row=>row.chatId===chatB.id),'a chat that never mentions it is not returned');
  assert.match(results.find(row=>row.chatId===chatA.id)!.snippet,/Hono/i,'the snippet carries the matched text');
  assert.deepEqual(await service.invoke('chat.search',{query:''}),[],'an empty query finds nothing (titles already cover that client-side)');
});

test('notifications fire once per run that settles out of sight',()=>{
  const track=createSettleTracker();
  const chat=(id:string,status:Chat['status'],error?:string)=>({id,title:id.toUpperCase(),status,...(error?{error}:{})}) as Chat;
  assert.deepEqual(track({chats:[chat('a','running'),chat('b','running')],activeChatId:'a'},true),[]);
  assert.deepEqual(track({chats:[chat('a','completed'),chat('b','failed','Boom\nstack')],activeChatId:'a'},true),[{chatId:'b',title:'B',body:'Failed: Boom',status:'failed'}],'the chat on screen in a focused window is not announced');
  track({chats:[chat('a','running')],activeChatId:'a'},false);
  assert.deepEqual(track({chats:[chat('a','completed')],activeChatId:'a'},false),[{chatId:'a',title:'A',body:'Finished',status:'completed'}],'an unfocused window announces even the active chat');
  assert.deepEqual(track({chats:[chat('a','completed')],activeChatId:'a'},false),[],'no repeat');
});

