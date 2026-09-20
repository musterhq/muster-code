import assert from 'node:assert/strict';
import {test} from 'node:test';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {ProcessSessions} from '../src/runtime/process-sessions.ts';
import {MAX_COMMAND_OUTPUT} from '../src/runtime/command-output-buffer.ts';
import {isActiveProcess,mergeProcessSnapshot,mergeProcessSummary,type ProcessEvent,type ProcessSnapshot} from '../src/shared/process-protocol.ts';

async function fixture() {
  const directory=await fs.mkdtemp(join(tmpdir(),'muster-owned-process-'));
  const file=join(directory,'commands.json'),events:ProcessEvent[]=[],operations:string[]=[];
  let full=true,blockedRead:Promise<void>|undefined;
  const owners=new Set(['chat','other']);
  const registry=new ProcessSessions(file,async({chatId,operation})=>{
    operations.push(operation);
    if(operation==='read'&&blockedRead){const blocked=blockedRead;blockedRead=undefined;await blocked;}
    if(!owners.has(chatId))throw new Error('Unknown conversation');
    return {cwd:directory,fullAccessAcknowledged:full};
  },event=>events.push(event));
  await registry.ready();
  return {registry,directory,file,events,operations,owners,setFull(value:boolean){full=value;},blockNextRead(){let release!:()=>void;blockedRead=new Promise<void>(resolve=>{release=resolve;});return release;},async close(){await registry.dispose();await fs.rm(directory,{recursive:true,force:true});}};
}
async function until(registry:ProcessSessions,id:string,predicate:(session:ProcessSnapshot)=>boolean) {
  for(let attempt=0;attempt<160;attempt++){
    const session=(await registry.list({chatId:'chat'})).sessions.find(session=>session.processId===id);
    if(session&&predicate(session))return session;
    await delay(25);
  }
  throw new Error('Command fixture did not reach its expected state.');
}
const command=(requestId:string,source:string)=>({chatId:'chat',requestId,command:process.execPath,args:['-e',source],label:'Node fixture',purpose:'test' as const});

test('concurrent requests launch once, subscribe/attach streams, detach does not stop, and exit retains output',async()=>{
  const f=await fixture();
  try{
    await f.registry.attach({chatId:'chat',leaseId:'viewer'});
    const input=command('once','console.log("first");setTimeout(()=>console.log("last"),220)');
    const [first,duplicate]=await Promise.all([f.registry.start(input),f.registry.start(input)]);
    assert.equal(first.processId,duplicate.processId);
    await until(f.registry,first.processId,session=>session.output.includes('first'));
    await f.registry.detach({chatId:'chat',leaseId:'viewer'});
    const count=f.events.filter(event=>event.type==='processSession').length;
    const done=await until(f.registry,first.processId,session=>!isActiveProcess(session.status));
    assert.equal(done.status,'exited');assert.equal(done.exitCode,0);
    assert.equal(done.output,'first\nlast\n');assert.equal(f.events.filter(event=>event.type==='processSession').length,count);
    assert.equal(f.registry.hasRunning('chat'),false);
    const reattached=await f.registry.attach({chatId:'chat',leaseId:'next-viewer'});
    assert.equal(reattached.sessions[0].output,done.output);
    assert.equal((await f.registry.start(input)).processId,first.processId);
    await assert.rejects(f.registry.start({...input,command:'different'}),/different work/);
    assert.equal((await f.registry.list({chatId:'chat'})).sessions.length,1);
  }finally{await f.close();}
});

test('authority and exact owner refs protect launch/read/stop, while downgrade still permits stop',async()=>{
  const f=await fixture();
  try{
    f.setFull(false);
    await assert.rejects(f.registry.start(command('blocked','console.log("must not run")')),/Full access/);
    assert.equal((await f.registry.list({chatId:'chat'})).sessions.length,0);
    await assert.rejects(f.registry.list({chatId:'unknown'}),/Unknown conversation/);
    f.setFull(true);
    const started=await f.registry.start(command('owned','setInterval(()=>{},1000)'));
    await until(f.registry,started.processId,session=>session.status==='running');
    assert.equal(f.registry.hasRunning('chat'),true);
    await assert.rejects(f.registry.stop({chatId:'other',processId:started.processId}),/does not belong/);
    await f.registry.attach({chatId:'chat',leaseId:'lease'});
    await assert.rejects(f.registry.attach({chatId:'other',leaseId:'lease'}),/another conversation/);
    f.setFull(false);
    await f.registry.stop({chatId:'chat',processId:started.processId});
    const stopped=await until(f.registry,started.processId,session=>!isActiveProcess(session.status));
    assert.equal(stopped.status,'stopped');
    assert.ok(f.operations.includes('read')&&f.operations.includes('start')&&f.operations.includes('stop'));
  }finally{await f.close();}
});

test('output has a bounded tail, environment excludes ambient secrets, and launch errors are honest',async()=>{
  const f=await fixture();
  const key='MUSTER_PROCESS_FIXTURE_SECRET',prior=process.env[key];process.env[key]='do-not-inherit';
  try{
    const started=await f.registry.start(command('output',`process.stdout.write('x'.repeat(${MAX_COMMAND_OUTPUT+500}));process.stdout.write('TAIL:'+String(process.env.${key}));`));
    const done=await until(f.registry,started.processId,session=>!isActiveProcess(session.status));
    assert.equal(done.output.length,MAX_COMMAND_OUTPUT);assert.equal(done.truncated,true);assert.ok(done.output.endsWith('TAIL:undefined'));
    const failed=await f.registry.start({chatId:'chat',requestId:'missing',command:join(f.directory,'missing-program'),args:[]});
    const result=await until(f.registry,failed.processId,session=>!isActiveProcess(session.status));
    assert.equal(result.status,'failed');assert.match(result.error??'',/ENOENT/);
  }finally{if(prior===undefined)delete process.env[key];else process.env[key]=prior;await f.close();}
});

test('four owned groups are the limit; shutdown stops all and persists no process identifiers',async()=>{
  const f=await fixture();
  try{
    const started=await Promise.all(Array.from({length:4},(_,index)=>f.registry.start(command(`cap-${index}`,'setInterval(()=>{},1000)'))));
    await assert.rejects(f.registry.start(command('over-limit','console.log("not run")')),/maximum 4/);
    assert.equal((await f.registry.list({chatId:'chat'})).sessions.length,4);
    await Promise.all(started.map(row=>until(f.registry,row.processId,session=>session.status==='running')));
    await f.registry.dispose();
    const saved=JSON.parse(await fs.readFile(f.file,'utf8'));
    assert.equal(saved.sessions.length,4);assert.ok(saved.sessions.every((session:ProcessSnapshot)=>session.status==='stopped'));
    assert.equal(/"(?:pid|processGroupId)"/.test(JSON.stringify(saved)),false);
  }finally{await f.close();}
});

test('restart marks prior live records lost without spawning, durable retries remain idempotent',async()=>{
  const f=await fixture();let restored:ProcessSessions|undefined;
  try{
    const input=command('restart','console.log("only once")');
    const started=await f.registry.start(input);await until(f.registry,started.processId,session=>!isActiveProcess(session.status));
    await f.registry.dispose();
    const saved=JSON.parse(await fs.readFile(f.file,'utf8'));
    saved.sessions[0].status='running';saved.receipts[0].session.status='running';
    await fs.writeFile(f.file,JSON.stringify(saved));
    let launches=0;
    restored=new ProcessSessions(f.file,async({operation})=>{if(operation==='start')launches++;return {cwd:f.directory,fullAccessAcknowledged:true};},()=>{});
    await restored.ready();
    const recovered=(await restored.list({chatId:'chat'})).sessions[0];
    assert.equal(recovered.status,'lost');assert.equal(recovered.generation,started.generation+1);
    assert.match(recovered.error??'',/not restarted/);assert.equal(restored.hasRunning('chat'),false);
    assert.equal((await restored.summary()).sessions[0].status,'lost');
    const retried=await restored.start(input);assert.equal(retried.processId,started.processId);assert.equal(retried.status,'lost');assert.equal(launches,0);
    const stopped=await restored.stop({chatId:'chat',processId:started.processId});assert.equal(stopped.status,'lost');
  }finally{await restored?.dispose();await f.close();}
});

test('a redirected descendant cannot outlive a completed command leader',async()=>{
  const f=await fixture();
  try{
    const ready=join(f.directory,'child-ready'),survived=join(f.directory,'child-survived');
    const child=`require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(survived)},'survived'),350);`;
    const leader=`const fs=require('node:fs');const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});child.unref();const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(timer);process.exit(0);}},5);`;
    const started=await f.registry.start(command('descendant',leader));
    await until(f.registry,started.processId,session=>session.status==='exited');
    assert.equal(await fs.readFile(ready,'utf8'),'ready');
    await delay(450);
    await assert.rejects(fs.stat(survived),{code:'ENOENT'});
    assert.equal(f.registry.hasRunning('chat'),false);
  }finally{await f.close();}
});

test('Stop escalates an owned group that ignores graceful termination',async()=>{
  const f=await fixture();
  try{
    const started=await f.registry.start(command('ignores-term','process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)'));
    await until(f.registry,started.processId,session=>session.output.includes('ready'));
    await f.registry.stop({chatId:'chat',processId:started.processId});
    const stopped=await until(f.registry,started.processId,session=>session.status==='stopped');
    assert.equal(stopped.signal,'SIGKILL');
  }finally{await f.close();}
});

test('full snapshots merge by generation then sequence without replay or cross-chat aliasing',()=>{
  const base:ProcessSnapshot={chatId:'chat',processId:'owned',generation:1,sequence:1,status:'running',label:'Fixture',purpose:'test',startedAt:'',updatedAt:'',output:'a',truncated:false,exitCode:null};
  const streamed={...base,sequence:3,output:'abc'};
  const current=mergeProcessSnapshot([],streamed);
  assert.equal(mergeProcessSnapshot(current,base),current);
  assert.equal(mergeProcessSnapshot(current,streamed),current);
  const restart=mergeProcessSnapshot(current,{...base,generation:2,status:'lost'});
  assert.equal(restart[0].generation,2);assert.equal(restart[0].output,'a');
  assert.equal(mergeProcessSnapshot(restart,streamed),restart);
  assert.equal(mergeProcessSnapshot(current,{...base,chatId:'other'}).length,2);
});

test('inactive history is bounded while durable receipts prevent replay of pruned commands',async()=>{
  const f=await fixture();let restored:ProcessSessions|undefined;
  try{
    const firstInput=command('history-0','console.log("fixture")');
    const first=await f.registry.start(firstInput);
    await until(f.registry,first.processId,session=>!isActiveProcess(session.status));
    for(let index=1;index<33;index++){
      const row=await f.registry.start({...firstInput,requestId:`history-${index}`});
      await until(f.registry,row.processId,session=>!isActiveProcess(session.status));
    }
    const list=await f.registry.list({chatId:'chat'});
    assert.equal(list.sessions.length,32);assert.ok(!list.sessions.some(row=>row.processId===first.processId));
    const duplicate=await f.registry.start(firstInput);
    assert.equal(duplicate.processId,first.processId);assert.equal(duplicate.output,'');assert.match(duplicate.error??'',/no longer retained/);
    await f.registry.dispose();
    restored=new ProcessSessions(f.file,async()=>({cwd:f.directory,fullAccessAcknowledged:true}),()=>{});
    const afterRestart=await restored.start(firstInput);
    assert.equal(afterRestart.processId,first.processId);assert.equal((await restored.list({chatId:'chat'})).sessions.length,32);
  }finally{await restored?.dispose();await f.close();}
});

test('a failed shutdown checkpoint can be retried without admitting new work or losing receipts',async()=>{
  const f=await fixture();
  try{
    const started=await f.registry.start(command('checkpoint','console.log("saved once")'));
    await until(f.registry,started.processId,session=>!isActiveProcess(session.status));
    await fs.rm(f.file);await fs.mkdir(f.file);
    await assert.rejects(f.registry.dispose());
    await assert.rejects(f.registry.start(command('blocked-after-quit','console.log("must not run")')),/closing/);
    await fs.rmdir(f.file);await f.registry.dispose();
    const saved=JSON.parse(await fs.readFile(f.file,'utf8'));
    assert.equal(saved.receipts.length,1);assert.equal(saved.receipts[0].session.processId,started.processId);
  }finally{await f.close();}
});

test('closed viewers still receive lifecycle metadata, without output payloads or chunk broadcasts',async()=>{
  const f=await fixture();
  try{
    await f.registry.attach({chatId:'chat',leaseId:'closed'});await f.registry.detach({chatId:'chat',leaseId:'closed'});
    const started=await f.registry.start(command('metadata','let n=0;const timer=setInterval(()=>{console.log("PRIVATE_OUTPUT");if(++n===12)clearInterval(timer)},30)'));
    await until(f.registry,started.processId,session=>session.output.includes('PRIVATE_OUTPUT'));
    const count=f.events.filter(event=>event.type==='processMetadata').length;
    await delay(150);
    assert.equal(f.events.filter(event=>event.type==='processMetadata').length,count,'output chunks must not broadcast global metadata');
    await until(f.registry,started.processId,session=>session.status==='exited');await delay(5);
    const metadata=f.events.filter(event=>event.type==='processMetadata');
    assert.ok(metadata.some(event=>event.summary.sessions.some(row=>row.status==='running')));
    assert.equal(metadata.at(-1)!.summary.sessions[0].status,'exited');
    assert.equal(f.events.some(event=>event.type==='processSession'),false);
    for(const event of metadata){
      assert.equal(JSON.stringify(event).includes('PRIVATE_OUTPUT'),false);
      for(const row of event.summary.sessions)assert.deepEqual(Object.keys(row).sort(),['chatId','label','processId','purpose','startedAt','status','updatedAt']);
    }
    for(let index=1;index<metadata.length;index++)assert.ok(metadata[index].summary.revision>metadata[index-1].summary.revision);
  }finally{await f.close();}
});

test('late authorized snapshots cannot rewind a lifecycle update or resurrect removed owners',async()=>{
  const f=await fixture();let release:(()=>void)|undefined;
  try{
    const started=await f.registry.start(command('metadata-race','setInterval(()=>{},1000)'));
    await until(f.registry,started.processId,session=>session.status==='running');await delay(5);
    release=f.blockNextRead();const late=f.registry.summary();await delay(5);
    await f.registry.stop({chatId:'chat',processId:started.processId});
    await until(f.registry,started.processId,session=>session.status==='stopped');
    const terminal=await f.registry.summary();
    release();release=undefined;const earlier=await late;
    assert.equal(earlier.sessions[0].status,'running');assert.ok(earlier.revision<terminal.revision);
    assert.equal(mergeProcessSummary(terminal,earlier),terminal);
    f.owners.delete('chat');const removed=await f.registry.summary();
    assert.deepEqual(removed.sessions,[]);assert.equal(mergeProcessSummary(removed,terminal),removed);
    assert.equal(mergeProcessSummary(null,removed),removed);
  }finally{release?.();await f.close();}
});

test('global lifecycle broadcasts exclude an owner removed before command completion',async()=>{
  const f=await fixture();
  try{
    const started=await f.registry.start(command('removed-owner','setInterval(()=>{},1000)'));
    await until(f.registry,started.processId,session=>session.status==='running');await delay(5);
    f.owners.delete('chat');
    await f.registry.dispose();await delay(5);
    const metadata=f.events.filter(event=>event.type==='processMetadata');
    assert.deepEqual(metadata.at(-1)!.summary.sessions,[]);
  }finally{await f.close();}
});

test('unreadable startup history blocks commands but does not trap Quit or rewrite saved bytes',async()=>{
  const directory=await fs.mkdtemp(join(tmpdir(),'muster-corrupt-process-')),file=join(directory,'commands.json');
  const bytes='{invalid saved command history\n';await fs.writeFile(file,bytes);
  const registry=new ProcessSessions(file,async()=>({cwd:directory,fullAccessAcknowledged:true}),()=>{});
  try{
    await assert.rejects(registry.ready(),/invalid/);
    await assert.rejects(registry.start(command('must-not-launch','console.log("not run")')),/invalid/);
    assert.equal(registry.hasRunning('chat'),false);
    await registry.dispose();await registry.dispose();
    assert.equal(await fs.readFile(file,'utf8'),bytes);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
