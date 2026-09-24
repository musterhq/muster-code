import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {createRequire} from 'node:module';
import {existsSync,readdirSync,readFileSync} from 'node:fs';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createProviderAdapter,type CoreClient,type ProviderInput} from '../src/runtime/provider.ts';
import type {Chat} from '../src/shared/protocol.ts';

/** R4 (DOGFOOD F19/F45/F55): the first send after a permission-mode, access or plan-mode change
 * failed 3/3. The bundled core keeps a warm app-server keyed by a scope that includes sandbox,
 * network and config, so a changed launch config spawned a SECOND app-server that resumed the
 * same thread while the first one still held it. This drives the real bundled core against a
 * fake app-server that, like Codex, refuses to resume a thread another live instance holds. */

const bundle=resolve(import.meta.dirname,'../dist/runtime/core-client.cjs');
type Log={pid:number;event:string;thread?:string;holder?:number};

async function fakeAppServer(t:TestContext){
  const root=await mkdtemp(join(tmpdir(),'muster-mode-change-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const alive=join(root,'alive'),locks=join(root,'locks'),log=join(root,'log.jsonl'),server=join(root,'fake-app-server.cjs'),command=join(root,'fake-codex.sh');
  await mkdir(alive);await mkdir(locks);
  await writeFile(server,`const fs=require('fs'),path=require('path');
const alive=${JSON.stringify(alive)},locks=${JSON.stringify(locks)},log=${JSON.stringify(log)};
const me=process.pid,mine=path.join(alive,String(me));
const record=(event,extra={})=>fs.appendFileSync(log,JSON.stringify({pid:me,event,...extra})+'\\n');
fs.writeFileSync(mine,'');record('spawn');
const release=()=>{try{fs.unlinkSync(mine);}catch{}for(const name of fs.readdirSync(locks)){const file=path.join(locks,name);try{if(fs.readFileSync(file,'utf8')===String(me))fs.unlinkSync(file);}catch{}}};
const quit=()=>{release();process.exit(0);};
process.on('SIGTERM',quit);process.stdin.on('end',quit);process.stdin.on('close',quit);
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
/** Codex holds a loaded thread per process: a resume while another live app-server holds it is refused. */
const take=thread=>{const file=path.join(locks,thread);let holder;try{holder=Number(fs.readFileSync(file,'utf8'));}catch{}
  if(holder&&holder!==me&&fs.existsSync(path.join(alive,String(holder))))return holder;fs.writeFileSync(file,String(me));};
let turns=0;
require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
  if(m.method==='thread/start'){const thread='th-'+me;take(thread);record('thread/start',{thread});return send({id:m.id,result:{thread:{id:thread}}});}
  if(m.method==='thread/resume'){const thread=m.params.threadId,holder=take(thread);
    if(holder){record('refused',{thread,holder});return send({id:m.id,error:{code:-32600,message:'thread '+thread+' is already loaded by another live app-server (pid '+holder+')'}});}
    record('thread/resume',{thread});return send({id:m.id,result:{thread:{id:thread}}});}
  if(m.method==='turn/start'){const thread=m.params.threadId,turn='tu-'+me+'-'+(++turns);record('turn/start',{thread});
    send({id:m.id,result:{turn:{id:turn}}});
    send({method:'item/completed',params:{threadId:thread,turnId:turn,item:{type:'agentMessage',text:'ok'}}});
    return send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}});}
  send({id:m.id,result:{}});});`);
  await writeFile(command,`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(server)} "$@"\n`,{mode:0o700});
  const entries=():Log[]=>existsSync(log)?readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as Log):[];
  const live=()=>readdirSync(alive).map(Number);
  return {root,command,entries,live};
}

/** The real bundled core, with runCodexAppServer counted so an automatic re-dispatch would show. */
function countedCore(options:{closeStale:boolean}){
  const real=createRequire(join(import.meta.dirname,'first-send-after-mode-change.cjs'))(bundle) as CoreClient;
  const calls:Record<string,unknown>[]=[];
  const core:CoreClient={...real,
    runCodexAppServer(args){calls.push(args);return real.runCodexAppServer(args);},
    // The control run disables the provider's stale-session close to prove the fake reproduces F19.
    clearCodexAppServerSessions(owner){if(options.closeStale)real.clearCodexAppServerSessions(owner);},
  };
  return {core,calls,clearAll:(owner:string)=>real.clearCodexAppServerSessions(owner)};
}

async function settledLive(live:()=>number[],expected:number){
  for(let i=0;i<100&&live().length!==expected;i++)await new Promise(done=>setTimeout(done,20));
  return live();
}

function harness(t:TestContext,fake:Awaited<ReturnType<typeof fakeAppServer>>,closeStale=true){
  const counted=countedCore({closeStale});
  const adapter=createProviderAdapter({core:counted.core,available:()=>true,command:fake.command});
  const owners=new Set<string>();
  t.after(()=>{adapter.dispose();for(const owner of owners)counted.clearAll(owner);});
  // The service persists the thread the provider reports; a later send resumes it.
  const chat={id:'mode-change',mode:'agent',providerId:'fixture',permissionMode:'workspace'} as Chat;
  const send=async(change:Partial<Chat>={})=>{
    Object.assign(chat,change);
    const before={calls:counted.calls.length,log:fake.entries().length};
    const input:ProviderInput={chat:{...chat},cwd:fake.root,prompt:'hello',onDelta(){},onReasoning(){},onEvent(){},async onRequest(){return undefined;},
      onThreadReady(threadId){Object.assign(chat,{providerThreadId:threadId,providerThreadProviderId:'fixture',providerThreadBindingId:'fixture-binding'});}};
    const result=await adapter.run(input);
    for(const call of counted.calls)owners.add(String(call.transportOwner));
    return {result,dispatches:counted.calls.length-before.calls,events:fake.entries().slice(before.log)};
  };
  return {send,chat};
}

const count=(events:Log[],event:string)=>events.filter(entry=>entry.event===event).length;

function assertCleanFirstAttempt(label:string,sent:Awaited<ReturnType<ReturnType<typeof harness>['send']>>,thread:string){
  assert.equal(sent.result.status,'completed',`${label}: ${sent.result.errorMessage ?? ''}`);
  assert.equal(sent.result.threadId,thread,`${label}: the same thread continues`);
  assert.equal(sent.dispatches,1,`${label}: exactly one dispatch, no automatic retry`);
  assert.equal(count(sent.events,'refused'),0,`${label}: no resume was refused`);
  assert.equal(count(sent.events,'spawn'),1,`${label}: one fresh app-server for the new launch config`);
  assert.equal(count(sent.events,'thread/resume'),1,`${label}: the thread is resumed once`);
  assert.equal(count(sent.events,'thread/start'),0,`${label}: no silent fallback to a new thread`);
  assert.equal(count(sent.events,'turn/start'),1,`${label}: one turn`);
}

test('first send after an access change succeeds on the first attempt with one live app-server',{skip:!existsSync(bundle)&&'dist/runtime/core-client.cjs missing; run npm run build'},async t=>{
  const fake=await fakeAppServer(t);
  const {send}=harness(t,fake);
  const first=await send();
  assert.equal(first.result.status,'completed',first.result.errorMessage ?? '');
  const thread=first.result.threadId!;
  assert.deepEqual(await settledLive(fake.live,1),[first.events[0]!.pid]);

  const widened=await send({permissionMode:'full'});
  assertCleanFirstAttempt('workspace → full',widened,thread);
  assert.deepEqual(await settledLive(fake.live,1),[widened.events[0]!.pid],'exactly one live app-server, the new one');

  const narrowed=await send({permissionMode:'read-only'});
  assertCleanFirstAttempt('full → read-only',narrowed,thread);
  assert.deepEqual(await settledLive(fake.live,1),[narrowed.events[0]!.pid]);
});

test('first send after entering and leaving plan mode succeeds on the first attempt with one live app-server',{skip:!existsSync(bundle)&&'dist/runtime/core-client.cjs missing; run npm run build'},async t=>{
  const fake=await fakeAppServer(t);
  const {send}=harness(t,fake);
  const first=await send();
  assert.equal(first.result.status,'completed',first.result.errorMessage ?? '');
  const thread=first.result.threadId!;

  const plan=await send({mode:'plan'});
  assertCleanFirstAttempt('agent → plan',plan,thread);
  assert.deepEqual(await settledLive(fake.live,1),[plan.events[0]!.pid]);

  const execute=await send({mode:'agent'});
  assertCleanFirstAttempt('plan → agent',execute,thread);
  assert.deepEqual(await settledLive(fake.live,1),[execute.events[0]!.pid]);
});

test('control: without closing the stale app-server the fake reproduces the F19 first-send failure',{skip:!existsSync(bundle)&&'dist/runtime/core-client.cjs missing; run npm run build'},async t=>{
  const fake=await fakeAppServer(t);
  const {send}=harness(t,fake,false);
  const first=await send();
  assert.equal(first.result.status,'completed',first.result.errorMessage ?? '');
  const second=await send({permissionMode:'full'});
  assert.equal(second.result.status,'failed');
  assert.match(second.result.errorMessage ?? '',/already loaded by another live app-server/);
  assert.equal(count(second.events,'refused'),1);
});
