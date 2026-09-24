import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {createCodexProjectSync,type SyncedProject} from '../src/runtime/codex-project-sync.ts';
import {createNativeThreadBridge} from '../src/runtime/codex-native.ts';

class RpcError extends Error { constructor(message:string,readonly code?:number){super(message);} }
interface Call {method:string;params:Record<string,unknown>;chatId?:string}

/** A fake Codex app-server: project/* on the host, thread/metadata/update per chat. */
function fakeCodex(options:{missing?:boolean;fail?:(method:string)=>Error|undefined}={}){
  const calls:Call[]=[];const projects=new Map<string,Record<string,unknown>>();const byKey=new Map<string,string>();let next=1;
  const threads=new Map<string,string>([['chat-a','thread-a'],['chat-b','thread-b']]);
  const answer=(method:string,params:Record<string,unknown>):Record<string,unknown>=>{
    if(options.missing)throw new RpcError(`Method not found: ${method}`,-32601);
    const failure=options.fail?.(method);if(failure)throw failure;
    if(method==='project/create'){const key=String(params.idempotencyKey);let id=byKey.get(key);if(!id){id=`cp-${next++}`;byKey.set(key,id);}projects.set(id,{id,...params});return {project:projects.get(id)!};}
    if(method==='project/update'){const id=String(params.projectId);if(!projects.has(id))throw new Error(`project not found: ${id}`);projects.set(id,{...projects.get(id),...params});return {project:projects.get(id)!};}
    if(method==='project/delete'){projects.delete(String(params.projectId));return {deleted:true};}
    if(method==='project/list')return {data:[...projects.values()],nextCursor:null};
    if(method==='thread/metadata/update')return {};
    throw new RpcError(`Method not found: ${method}`,-32601);
  };
  const bridge=createNativeThreadBridge({
    thread:chatId=>threads.has(chatId)?{threadId:threads.get(chatId)!,providerId:'codex',bindingId:'b'}:undefined,
    async call(chatId,method,params){calls.push({chatId,method,params});return answer(method,params);},
    async query(method,params){calls.push({method,params});return answer(method,params);},
  });
  return {bridge,calls,projects};
}
function harness(native:ReturnType<typeof fakeCodex>['bridge']|undefined,list:SyncedProject[]){
  const db=new DatabaseSync(':memory:');
  const folders:Record<string,string>={f1:'/work/one',f2:'/work/two'};
  const sync=createCodexProjectSync({db:()=>db,native:()=>native,projects:()=>list,folderPath:id=>folders[id]});
  return {db,sync,list};
}
const methods=(calls:Call[])=>calls.map(call=>call.method);

test('creates, updates only on change, and deletes Codex projects from Muster projects',async()=>{
  const codex=fakeCodex();const list:SyncedProject[]=[{id:'p1',name:'Alpha',goal:'Ship',folderIds:['f1','f2']}];
  const {sync}=harness(codex.bridge,list);
  await sync.sync();
  assert.deepEqual(methods(codex.calls),['project/create']);
  assert.deepEqual(codex.calls[0]!.params,{name:'Alpha',roots:[{path:'/work/one'},{path:'/work/two'}],metadata:{goal:'Ship',musterProjectId:'p1'},idempotencyKey:'muster-project:p1'});
  const codexId=sync.codexProjectId('p1');assert.equal(codexId,'cp-1');
  await sync.sync();assert.equal(codex.calls.length,1,'unchanged project is not re-sent');
  list[0]={...list[0]!,name:'Alpha 2',folderIds:['f2']};
  await sync.sync();
  assert.equal(codex.calls[1]!.method,'project/update');
  assert.deepEqual(codex.calls[1]!.params,{projectId:'cp-1',name:'Alpha 2',roots:[{path:'/work/two'}],metadata:{goal:'Ship',musterProjectId:'p1'}});
  list.length=0;
  await sync.sync();
  assert.deepEqual(codex.calls.at(-1),{method:'project/delete',params:{projectId:'cp-1'}});
  assert.equal(sync.codexProjectId('p1'),undefined);assert.equal(codex.projects.size,0);
});

test('create is idempotent per Muster project and a failed sync retries on the next pass',async()=>{
  let down=true;const codex=fakeCodex({fail:()=>down?new Error('codex app-server exited'):undefined});
  const {sync}=harness(codex.bridge,[{id:'p1',name:'Alpha',goal:'',folderIds:['f1']}]);
  await sync.sync();
  assert.equal(sync.codexProjectId('p1'),undefined,'transport failure leaves nothing mapped');assert.equal(sync.disabled,false);
  down=false;await sync.sync();
  assert.equal(sync.codexProjectId('p1'),'cp-1');
  assert.deepEqual(codex.calls.filter(call=>call.method==='project/create').map(call=>call.params.idempotencyKey),['muster-project:p1','muster-project:p1']);
});

test('a project deleted on the Codex side is recreated under a fresh idempotency key',async()=>{
  const codex=fakeCodex();const list:SyncedProject[]=[{id:'p1',name:'Alpha',goal:'',folderIds:['f1']}];
  const {sync}=harness(codex.bridge,list);
  await sync.sync();codex.projects.clear();
  list[0]={...list[0]!,goal:'New goal'};
  await sync.sync();
  assert.deepEqual(methods(codex.calls),['project/create','project/update','project/create']);
  assert.equal(codex.calls[2]!.params.idempotencyKey,'muster-project:p1:1');
  assert.equal(sync.codexProjectId('p1'),'cp-2');
});

test('a server without project/* switches sync off; no bridge means no calls',async()=>{
  const codex=fakeCodex({missing:true});
  const {sync}=harness(codex.bridge,[{id:'p1',name:'Alpha',goal:'',folderIds:['f1']}]);
  await sync.sync();assert.equal(sync.disabled,true);
  await sync.sync();await sync.assignThread('chat-a','p1');
  assert.equal(codex.calls.length,1,'method-not-found is cached for the session');
  const none=harness(undefined,[{id:'p1',name:'Alpha',goal:'',folderIds:['f1']}]);
  await none.sync.sync();await none.sync.assignThread('chat-a','p1');
  assert.equal(none.sync.codexProjectId('p1'),undefined);
});

test('threads are grouped under the project once, and cleared when the chat leaves it',async()=>{
  const codex=fakeCodex();
  const {sync}=harness(codex.bridge,[{id:'p1',name:'Alpha',goal:'',folderIds:['f1']}]);
  await sync.assignThread('chat-a','p1');
  assert.deepEqual(codex.calls.map(call=>[call.method,call.params]),[['project/create',codex.calls[0]!.params],['thread/metadata/update',{threadId:'thread-a',projectId:'cp-1'}]],'unmapped project is synced first');
  await sync.assignThread('chat-a','p1');assert.equal(codex.calls.length,2,'same thread+project is not repeated');
  await sync.assignThread('chat-b',null);assert.equal(codex.calls.length,2,'a never-grouped thread without a project needs no call');
  await sync.assignThread('chat-a',null);
  assert.deepEqual(codex.calls.at(-1),{chatId:'chat-a',method:'thread/metadata/update',params:{threadId:'thread-a',projectId:''}});
  await sync.assignThread('chat-cold','p1');assert.equal(codex.calls.length,3,'a chat without a live thread is skipped');
});

test('deleting a project forgets its thread grouping so a later project can regroup it',async()=>{
  const codex=fakeCodex();const list:SyncedProject[]=[{id:'p1',name:'Alpha',goal:'',folderIds:['f1']}];
  const {sync}=harness(codex.bridge,list);
  await sync.assignThread('chat-a','p1');
  list.splice(0,1,{id:'p2',name:'Beta',goal:'',folderIds:['f2']});
  await sync.sync();
  await sync.assignThread('chat-a','p2');
  assert.deepEqual(codex.calls.at(-1)!.params,{threadId:'thread-a',projectId:'cp-2'});
});
