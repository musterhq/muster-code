import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DesktopWorkspaces,commandAuthority,computerAuthority} from '../src/main/desktop-workspaces.ts';
import type {Snapshot} from '../src/shared/protocol.ts';
import type {AgentService} from '../src/main/service-loader.ts';
import type {ProcessSessions} from '../src/runtime/process-sessions.ts';
import type {ScopedComputers} from '../src/runtime/scoped-computers.ts';

const snapshot:Snapshot={version:1,folders:[{id:'folder1',name:'Test',path:'/tmp'}],projects:[],chats:[{id:'chat1',folderId:'folder1',title:'Test',pinned:false,archived:false,draft:'',status:'idle',updatedAt:'',model:'test',mode:'agent',permissionMode:'full'}]};
test('host command authority is per-chat Full+Agent while stopping remains available after downgrade',async()=>{
  const allowed=await commandAuthority(snapshot,'/tmp',{chatId:'chat1',operation:'start'});
  assert.deepEqual(allowed,{cwd:'/tmp',fullAccessAcknowledged:true});
  for(const changes of [{status:'running'},{status:'stopping'},{permissionMode:'workspace'},{mode:'plan'},{archived:true},{folderId:'missing'},{recovery:{kind:'recovery-needed'}}]){
    const altered={...snapshot,chats:[{...snapshot.chats[0],...changes}]} as Snapshot;
    await assert.rejects(commandAuthority(altered,'/tmp',{chatId:'chat1',operation:'start'}));
    await commandAuthority(altered,'/tmp',{chatId:'chat1',operation:'stop'});
  }
  await assert.rejects(commandAuthority(snapshot,'/tmp',{chatId:'missing',operation:'start'}));
  assert.throws(()=>computerAuthority(snapshot,{kind:'project',id:'chat1'}));
  assert.equal(computerAuthority(snapshot,{kind:'chat',id:'chat1'}).label,'Test');
});
function harness() {
  const started=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let running=false,changes=0,stops=0;
  const processes={start:async()=>{started.resolve();await release.promise;running=true;return {};},hasRunning:()=>running,stop:async()=>{stops++;running=false;},dispose:async()=>{running=false;}} as unknown as ProcessSessions;
  const service={invoke:async()=>{changes++;return {};},dispose:async()=>{}} as unknown as AgentService;
  const computers={dispose:async()=>{}} as ScopedComputers;
  return {work:new DesktopWorkspaces(service,processes,computers),started,release,get changes(){return changes;},get stops(){return stops;}};
}
test('policy change cannot overtake accepted command during asynchronous receipt persistence',async()=>{
  const h=harness();const start=h.work.invoke('processes.start',{chatId:'chat1',requestId:'one',command:'echo one'});
  await h.started.promise;
  const change=h.work.invoke('chat.setPermissionMode',{id:'chat1',permissionMode:'read-only'});
  h.release.resolve();await start;
  await assert.rejects(change,/background commands/);assert.equal(h.changes,0);
  await h.work.invoke('processes.stop',{chatId:'chat1',processId:'one'});assert.equal(h.stops,1);
  await h.work.invoke('chat.setPermissionMode',{id:'chat1',permissionMode:'read-only'});assert.equal(h.changes,1);
});
test('shutdown closes queued admission and waits in-flight launch before cleanup',async()=>{
  const h=harness();const start=h.work.invoke('processes.start',{chatId:'chat1',requestId:'one',command:'echo one'});await h.started.promise;
  const queued=h.work.invoke('chat.send',{id:'chat1',text:'hello',requestId:'two'});
  const rejected=assert.rejects(queued,/stopping/);
  const shutdown=h.work.dispose();h.release.resolve();await start;await rejected;await shutdown;
  assert.equal(h.changes,0);
  await assert.rejects(h.work.invoke('processes.start',{chatId:'chat1',requestId:'three',command:'echo three'}),/stopping/);
});
