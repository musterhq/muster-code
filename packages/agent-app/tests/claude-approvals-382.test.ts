/** #382: a Claude Code chat in Workspace access gets shell approvals through Muster's approval cards. A fake `claude` process speaks the stream-json permission protocol. */
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ChildProcess} from 'node:child_process';
import {claudeArgs,claudeCodeAdapter,type Spawn} from '../src/runtime/adapters/claude-code.ts';
import type {AdapterRunInput} from '../src/runtime/adapters/types.ts';
import {createProviderAdapter} from '../src/runtime/provider.ts';
import {createAgentService} from '../src/runtime/service.ts';

const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
async function until(check:()=>boolean|Promise<boolean>,what:string){for(let i=0;i<300;i++){if(await check())return;await tick();}assert.fail(`${what} was not reached`);}

async function rig(t:TestContext){
  const dataDir=await mkdtemp(join(tmpdir(),'muster-382-'));
  const child=new EventEmitter() as EventEmitter&{stdout:PassThrough;stderr:PassThrough;stdin:PassThrough;kill():boolean};
  child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>true;
  let stdin='',args:string[]|undefined;child.stdin.on('data',chunk=>{stdin+=chunk;});
  const spawn:Spawn=(_command,spawned)=>{args=spawned;return child as unknown as ChildProcess;};
  const route={info:{id:'claude-code',name:'Claude Code',available:true,bindingId:'b1',identityMasked:'x',models:[{id:'claude-code/opus',name:'Opus'}]},command:'',env:{},sessionsRoot:'',adapter:claudeCodeAdapter({binary:'/bin/claude',spawn})};
  const provider=createProviderAdapter({instances:()=>[route]});
  const service=createAgentService({dataDir,provider,onEvent(){}});
  t.after(async()=>{await service.dispose();provider.dispose();await rm(dataDir,{recursive:true,force:true});});
  const emit=(...lines:unknown[])=>{for(const line of lines)child.stdout.write(JSON.stringify(line)+'\n');};
  const close=(code:number)=>{child.stdout.end();child.stderr.end();setImmediate(()=>child.emit('close',code));};
  // Stop (SIGINT) ends the fake process, as it ends the real one, so a failed assertion never hangs teardown.
  child.kill=()=>{close(130);return true;};
  const responses=()=>stdin.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as Record<string,any>).filter(line=>line.type==='control_response');
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'workspace'});
  await service.invoke('chat.send',{id:chat.id,text:'run the tests',requestId:'r382'});
  await until(()=>args!==undefined,'the Claude Code process starting');
  const timeline=async()=>(await service.invoke('chat.timeline',{id:chat.id})).items;
  return {service,chat,emit,close,responses,timeline,args:()=>args!};
}
const asks=(input:Record<string,unknown>)=>({type:'control_request',request_id:'req-1',request:{subtype:'can_use_tool',tool_name:'Bash',input,tool_use_id:'toolu_bash1'}});
const bash={command:'npm test',description:'Run the tests'};

// Spec: MUS-SPEC-05-382A (docs/spec/clauses/05-access-modes-and-approvals.md#mus-spec-05-382a)
test('Claude Code in Workspace access: a shell command waits for the approval card and runs once approved',async t=>{
  const r=await rig(t);
  assert.ok(r.args().includes('--permission-prompt-tool=stdio'),'Claude Code is asked to send its permission prompts to Muster');
  r.emit({type:'system',subtype:'init',session_id:'s1'},{type:'assistant',message:{id:'m1',content:[{type:'tool_use',id:'toolu_bash1',name:'Bash',input:bash}]}},asks(bash));
  await until(async()=>(await r.timeline()).some(item=>item.kind==='approval'),'the approval card');
  const card=(await r.timeline()).find(item=>item.kind==='approval')!;
  assert.equal(card.status,'pending');assert.equal(card.data?.kind,'command');assert.equal(card.data?.command,'npm test');
  await tick();assert.deepEqual(r.responses(),[],'Claude Code gets no answer before the user decides');
  await r.service.invoke('approval.respond',{id:card.id,approved:true,decision:'accept'});
  await until(()=>r.responses().length===1,'the answer to Claude Code');
  const [answer]=r.responses();
  assert.equal(answer!.response.subtype,'success');assert.equal(answer!.response.request_id,'req-1');
  assert.deepEqual(answer!.response.response,{behavior:'allow',updatedInput:bash});
  r.emit({type:'user',message:{content:[{type:'tool_result',tool_use_id:'toolu_bash1',content:'ok'}]}},{type:'result',subtype:'success',is_error:false,result:'Tests pass.'});r.close(0);
  await until(async()=>(await r.service.invoke('chat.select',{id:r.chat.id})).some(item=>item.kind==='assistant'&&/Tests pass/.test(item.text)),'the finished turn');
});

// Spec: MUS-SPEC-05-382B (docs/spec/clauses/05-access-modes-and-approvals.md#mus-spec-05-382b)
test('Claude Code in Workspace access: a declined shell command is refused and the turn still completes',async t=>{
  const input=(permissionMode:AdapterRunInput['permissionMode'])=>claudeArgs({chat:{id:'c'},cwd:'/w',prompt:'p',model:'claude-code/opus',permissionMode} as never,'s');
  assert.ok(!input('full').some(arg=>arg.startsWith('--permission-prompt-tool')),'Full access never prompts');
  assert.ok(!input('read-only').some(arg=>arg.startsWith('--permission-prompt-tool')),'Read only runs in plan mode and asks nothing');
  const r=await rig(t);
  r.emit({type:'system',subtype:'init',session_id:'s1'},asks(bash));
  await until(async()=>(await r.timeline()).some(item=>item.kind==='approval'),'the approval card');
  const card=(await r.timeline()).find(item=>item.kind==='approval')!;
  await r.service.invoke('approval.respond',{id:card.id,approved:false,decision:'decline'});
  await until(()=>r.responses().length===1,'the refusal to Claude Code');
  const refusal=r.responses()[0]!.response.response;
  assert.equal(refusal.behavior,'deny');assert.match(refusal.message,/declined/i);
  r.emit({type:'result',subtype:'success',is_error:false,result:'Skipped the tests.'});r.close(0);
  await until(async()=>(await r.service.invoke('chat.select',{id:r.chat.id})).some(item=>item.kind==='assistant'&&/Skipped the tests/.test(item.text)),'the finished turn');
});
