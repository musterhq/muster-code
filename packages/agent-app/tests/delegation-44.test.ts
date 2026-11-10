// #44: agents start and control agents on any provider. Driven through the real service with a fake provider whose
// turns call the muster_delegation tools over the real loopback host, exactly as the per-chat MCP process does.
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter,ProviderInput,ProviderResult} from '../src/runtime/provider.ts';
import type {Chat,TimelineItem} from '../src/shared/protocol.ts';

type Service=ReturnType<typeof createAgentService>;
type Tools={call(tool:string,args?:Record<string,unknown>):Promise<{text:string;isError:boolean}>};
type Script=(input:ProviderInput,tools:Tools)=>Promise<string|ProviderResult>|string|ProviderResult;

const info:ProviderAdapter['info']=()=>[
  {id:'alpha',name:'Alpha',available:true,identityMasked:'alpha',models:[{id:'alpha-1',name:'Alpha One'}]},
  {id:'beta',name:'Beta',available:true,identityMasked:'beta',models:[{id:'beta-1',name:'Beta One'}]},
];
const TOKEN='mcp_servers.muster_delegation.env.MUSTER_CHAT_TOKEN';
async function directory(t:TestContext,prefix='muster-44-'){const path=await mkdtemp(join(tmpdir(),prefix));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function until(check:()=>boolean|Promise<boolean>,label='condition'){for(let i=0;i<2500;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail(`${label} not reached`);}
function deferred<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
const settle=()=>new Promise(resolve=>setTimeout(resolve,60));

/** The real tool host, called as the chat's MCP process calls it: the endpoint file, the bearer token and the run's chat token. */
async function callTool(dataDir:string,chatId:string,chatToken:string,tool:string,args:Record<string,unknown>={}):Promise<{text:string;isError:boolean;status:number}> {
  const {url,token}=JSON.parse(await readFile(join(dataDir,'agent-tools','delegation','muster_delegation-endpoint.json'),'utf8'));
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`,'x-muster-chat-token':chatToken},body:JSON.stringify({chatId,tool,arguments:args})});
  if(!response.ok)return {text:'',isError:true,status:response.status};
  const body=await response.json() as {content:{text:string}[];isError?:boolean};
  return {text:body.content.map(part=>part.text).join('\n'),isError:body.isError===true,status:response.status};
}

function harness(dataDir:string){
  const inputs:ProviderInput[]=[],tokens=new Map<string,string>(),steers:{chatId:string;text:string}[]=[],stops:string[]=[];
  const active=new Map<string,(result:ProviderResult)=>void>();
  let script:Script=()=>'ok';
  const tools=(chatId:string):Tools=>({call:(tool,args={})=>callTool(dataDir,chatId,tokens.get(chatId)??'',tool,args)});
  const provider:ProviderAdapter={info,
    async run(input){
      inputs.push(input);
      const token=input.configOverrides?.[TOKEN];if(typeof token==='string')tokens.set(input.chat.id,token);
      const stopped=new Promise<ProviderResult>(resolve=>active.set(input.chat.id,resolve));
      const work=(async():Promise<ProviderResult>=>{const out=await script(input,tools(input.chat.id));if(typeof out!=='string')return out;if(out)input.onDelta(out);return {status:'completed',finalMessage:out};})();
      try{return await Promise.race([work,stopped]);}finally{active.delete(input.chat.id);}
    },
    async stop(chatId){stops.push(chatId);active.get(chatId)?.({status:'failed',finalMessage:'',dispatchState:'dispatched',recovery:{kind:'cancelled',retryable:false,reason:'Stopped.'}});return true;},
    async steer(chatId,text){if(!active.has(chatId))return false;steers.push({chatId,text});return true;},
    dispose(){}};
  return {provider,inputs,tokens,steers,stops,tools,set script(value:Script){script=value;},
    turns:(chatId:string)=>inputs.filter(input=>input.chat.id===chatId)};
}

async function setup(t:TestContext,options:{dataDir?:string;access?:Chat['permissionMode']}={}){
  const dataDir=options.dataDir??await directory(t),work=await directory(t,'muster-44-work-');
  const fake=harness(dataDir);
  const service=createAgentService({dataDir,provider:fake.provider,onEvent(){}});t.after(()=>service.dispose());
  const folder=await service.invoke('folder.add',{path:work});
  const chat=async(title:string,access:Chat['permissionMode']=options.access??'workspace')=>{
    const created=await service.invoke('chat.create',{folderId:folder.id});
    await service.invoke('chat.update',{id:created.id,title});
    await service.invoke('chat.selectProvider',{id:created.id,providerId:'alpha',model:'alpha-1'});
    return service.invoke('chat.setPermissionMode',{id:created.id,permissionMode:access!,...(access==='full'?{acknowledgeFullAccess:true}:{})});
  };
  return {dataDir,service,fake,folder,chat};
}
const timeline=(service:Service,id:string)=>service.invoke('chat.timeline',{id}) as Promise<TimelineItem[]>;
const notices=async(service:Service,id:string,kind:string)=>(await timeline(service,id)).filter(item=>item.kind==='notice'&&item.data?.kind===kind);
const chatOf=async(service:Service,id:string)=>(await service.invoke('app.snapshot',undefined)).chats.find(chat=>chat.id===id);
const idIn=(text:string)=>/Started ([a-zA-Z0-9-]{8,}) /.exec(text)?.[1]??'';
async function send(service:Service,id:string,text:string){return service.invoke('chat.send',{id,text,requestId:`req-${Math.random().toString(36).slice(2)}`});}
const idle=async(service:Service,id:string)=>{const chat=await chatOf(service,id);return !!chat&&!['running','stopping','queued','waiting'].includes(chat.status);};

// Spec: MUS-SPEC-14-44A (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-44a)
test('delegate_task with wait starts a child chat on another provider in the parent\'s folder and returns its final reply',async t=>{
  const {service,fake,folder,chat}=await setup(t);
  const parent=await chat('Planner');
  let result={text:'',isError:false};
  fake.script=async(input,tools)=>{
    if(input.chat.id===parent.id&&/Summarise/.test(input.prompt)){result=await tools.call('delegate_task',{prompt:'Summarise the README in one line.',provider:'Beta',model:'beta-1',title:'Summarise README',wait:true});return 'Delegated.';}
    if(input.chat.id!==parent.id)return 'README says hello.';
    return 'ok';
  };
  await send(service,parent.id,'Summarise the README with a helper.');
  await until(()=>result.text!=='','the delegate_task result');
  assert.equal(result.isError,false,result.text);
  assert.match(result.text,/Summarise README" on Beta One: finished/);
  assert.match(result.text,/Final reply:\nREADME says hello\./);
  const children=await service.invoke('delegation.children',{chatId:parent.id});
  assert.equal(children.length,1);
  const child=(await chatOf(service,children[0]!.id))!;
  assert.equal(child.providerId,'beta');assert.equal(child.model,'beta-1');assert.equal(child.title,'Summarise README');
  assert.equal(child.folderId,folder.id,'the parent\'s folder');assert.equal(child.permissionMode,'workspace','the parent\'s access');
  assert.equal(fake.turns(child.id)[0]!.prompt.includes('Summarise the README in one line.'),true);
  const from=await notices(service,child.id,'delegated-from');
  assert.equal(from.length,1);assert.equal(from[0]!.text,'Started by Planner');assert.equal(from[0]!.data?.parentChatId,parent.id);
  await until(()=>idle(service,parent.id),'the parent turn');await settle();
  const rows=await notices(service,parent.id,'delegated-task');
  assert.deepEqual(rows.map(row=>row.text),['Started Summarise README on Beta One','Summarise README finished']);
  assert.equal(rows[0]!.data?.childChatId,child.id);
  assert.equal(fake.turns(parent.id).length,1,'a parent that waited is not woken again with the same result');
});

// Spec: MUS-SPEC-14-44B (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-44b)
test('an idle parent wakes with the child\'s result when an async child finishes; a busy parent gets it after its turn',async t=>{
  const {service,fake,chat}=await setup(t);
  const parent=await chat('Lead');
  const childGates=[deferred(),deferred()],parentHold=deferred();
  let started:string[]=[];
  fake.script=async(input,tools)=>{
    if(input.chat.id===parent.id&&/Start two/.test(input.prompt)){
      for(const name of ['Audit API','Audit UI'])started.push(idIn((await tools.call('delegate_task',{prompt:`${name} for bugs.`,title:name})).text));
      return 'Both started.';
    }
    if(input.chat.id===parent.id&&/Hold/.test(input.prompt)){await parentHold.promise;return 'Held.';}
    if(input.chat.id!==parent.id){const n=/Audit API/.test(input.prompt)?0:1;await childGates[n]!.promise;return n===0?'Found 3 bugs in the API.':'The UI is clean.';}
    return 'Thanks, noted.';
  };
  await send(service,parent.id,'Start two audits.');
  await until(()=>started.length===2&&started.every(Boolean),'two children');
  await until(()=>idle(service,parent.id),'the parent turn ends');
  // Idle parent: the first child's result starts a turn at once.
  childGates[0]!.resolve();
  await until(()=>fake.turns(parent.id).length===2,'the parent wakes');
  const wake=fake.turns(parent.id)[1]!.prompt;
  assert.match(wake,/a chat you delegated finished/);assert.match(wake,/Found 3 bugs in the API\./);assert.match(wake,new RegExp(started[0]!));
  await until(()=>idle(service,parent.id),'the wake turn ends');
  // Busy parent: the second child's result waits for the parent's turn, then wakes it once.
  await send(service,parent.id,'Hold on.');
  await until(()=>fake.turns(parent.id).length===3,'the parent is busy');
  childGates[1]!.resolve();
  await until(async()=>(await chatOf(service,started[1]!))?.status==='completed','second child done');await settle();
  assert.equal(fake.turns(parent.id).length,3,'not while the parent works');
  assert.equal((await chatOf(service,parent.id))!.queue?.length,1,'the report waits in the parent\'s queue');
  parentHold.resolve();
  await until(()=>fake.turns(parent.id).length===4,'the parent reads the report after its turn');
  assert.match(fake.turns(parent.id)[3]!.prompt,/The UI is clean\./);
  await until(()=>idle(service,parent.id),'done');await settle();
  assert.equal(fake.turns(parent.id).length,4,'each result wakes the parent once');
  const rows=(await notices(service,parent.id,'delegated-task')).map(row=>row.text);
  assert.deepEqual(rows.filter(text=>/finished/.test(text)).sort(),['Audit API finished','Audit UI finished']);
});

// Spec: MUS-SPEC-14-44C (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-44c)
test('message_task steers a working child, and gives an idle child a new turn',async t=>{
  const {service,fake,chat}=await setup(t);
  const parent=await chat('Lead');
  const gate=deferred();let childId='';
  fake.script=async(input,tools)=>{
    if(input.chat.id===parent.id&&/Start/.test(input.prompt)){childId=idIn((await tools.call('delegate_task',{prompt:'Write the tests.',title:'Tests'})).text);return 'Started.';}
    if(input.chat.id===childId&&/Write the tests/.test(input.prompt)){await gate.promise;return 'Wrote 4 tests.';}
    if(input.chat.id===childId)return 'Added the edge case.';
    return 'ok';
  };
  await send(service,parent.id,'Start the tests.');
  await until(()=>!!childId&&fake.turns(childId).length===1,'child working');
  await until(()=>idle(service,parent.id),'parent idle');
  const steer=await fake.tools(parent.id).call('message_task',{id:childId,text:'Also cover empty input.'});
  assert.equal(steer.isError,false,steer.text);assert.match(steer.text,/^Steered Tests/);
  assert.deepEqual(fake.steers,[{chatId:childId,text:'Also cover empty input.'}]);
  gate.resolve();
  await until(async()=>(await chatOf(service,childId))?.status==='completed','child finished');
  await until(()=>idle(service,parent.id),'parent read the report');
  const more=await fake.tools(parent.id).call('message_task',{id:childId,text:'Now add the unicode case.'});
  assert.match(more.text,/^Sent to Tests/);
  await until(()=>fake.turns(childId).length===2,'a new child turn');
  assert.match(fake.turns(childId)[1]!.prompt,/Now add the unicode case\./);
  await until(async()=>(await chatOf(service,childId))?.status==='completed','second child turn');
  const read=await fake.tools(parent.id).call('read_task',{id:childId,last:2});
  assert.match(read.text,/Last replies:\nWrote 4 tests\.\n---\nAdded the edge case\./);
});

// Spec: MUS-SPEC-14-44D (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-44d)
test('interrupt_task stops a child and the chat it started, and a stop does not wake the parent',async t=>{
  const {service,fake,chat}=await setup(t);
  const parent=await chat('Lead');
  let childId='',grandchildId='';const forever=deferred();
  fake.script=async(input,tools)=>{
    if(input.chat.id===parent.id&&/Start/.test(input.prompt)){childId=idIn((await tools.call('delegate_task',{prompt:'Refactor the parser.',title:'Refactor'})).text);return 'Started.';}
    if(input.chat.id===childId){grandchildId=idIn((await tools.call('delegate_task',{prompt:'Benchmark the parser.',title:'Benchmark'})).text);await forever.promise;return 'never';}
    if(input.chat.id===grandchildId){await forever.promise;return 'never';}
    return 'ok';
  };
  await send(service,parent.id,'Start the refactor.');
  await until(()=>!!grandchildId&&fake.turns(grandchildId).length===1,'grandchild working');
  await until(()=>idle(service,parent.id),'parent idle');
  const stopped=await fake.tools(parent.id).call('interrupt_task',{id:childId});
  assert.equal(stopped.isError,false,stopped.text);assert.match(stopped.text,/Stopped 2 chats \(Refactor and the chats it started\)/);
  assert.deepEqual(new Set(fake.stops),new Set([childId,grandchildId]));
  await until(async()=>(await chatOf(service,childId))?.status==='interrupted'&&(await chatOf(service,grandchildId))?.status==='interrupted','both stopped');
  await settle();
  assert.equal(fake.turns(parent.id).length,1,'a stop is not reported back as a new turn');
  assert.ok((await notices(service,parent.id,'delegated-task')).some(row=>row.text==='Refactor was stopped'));
  const list=await fake.tools(parent.id).call('list_tasks');
  assert.match(list.text,new RegExp(`${childId} "Refactor" on Alpha One: stopped\\n  ${grandchildId} "Benchmark" on Alpha One: stopped`));
});

// Spec: MUS-SPEC-14-44E (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-44e)
test('read_task returns status, the final reply and changed files, and reading a result first withdraws its queued report',async t=>{
  const {service,fake,chat}=await setup(t);
  const parent=await chat('Lead');
  let childId='',read={text:'',isError:false};const childGate=deferred(),parentGate=deferred();
  fake.script=async(input,tools)=>{
    if(input.chat.id===parent.id&&/Start/.test(input.prompt)){
      childId=idIn((await tools.call('delegate_task',{prompt:'Seed the docs.',title:'Seed docs'})).text);
      const early=await tools.call('read_task',{id:childId});assert.match(early.text,/Seed docs" on Alpha One: running\nNo reply yet\./);
      childGate.resolve();await parentGate.promise;
      read=await tools.call('read_task',{id:childId});return 'Read it.';
    }
    if(input.chat.id===childId){await childGate.promise;input.onEvent('item/completed',{item:{id:'f-1',type:'fileChange',status:'completed',changes:[{path:'SEEDS.md',kind:{type:'add'}}]}});return 'Seeded SEEDS.md.';}
    return 'ok';
  };
  await send(service,parent.id,'Start seeding.');
  await until(async()=>!!childId&&(await chatOf(service,childId))?.status==='completed','child done');await settle();
  assert.equal((await chatOf(service,parent.id))!.queue?.length,1,'the report is queued while the parent works');
  parentGate.resolve();
  await until(()=>read.text!=='','read_task');
  assert.match(read.text,/Seed docs" on Alpha One: finished\nFinal reply:\nSeeded SEEDS\.md\.\nChanged files: SEEDS\.md/);
  await until(()=>idle(service,parent.id),'parent done');await settle();
  assert.equal(fake.turns(parent.id).length,1,'the parent read the result itself, so the queued report was withdrawn');
  assert.equal((await chatOf(service,parent.id))!.queue?.length??0,0);
});

// Spec: MUS-SPEC-14-44F (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-44f)
test('children get the parent\'s access and never more; read-only chats get no tools; depth, concurrency and unconfigured models are refused',async t=>{
  const {service,fake,chat,dataDir}=await setup(t);
  const reader=await chat('Reader','read-only'),full=await chat('Builder','full'),lead=await chat('Lead');
  const results:Record<string,{text:string;isError:boolean}[]>={};
  const gates:ReturnType<typeof deferred>[]=[];const chain:string[]=[];
  fake.script=async(input,tools)=>{
    const say=(key:string,value:{text:string;isError:boolean})=>{(results[key]??=[]).push(value);return value;};
    if(input.chat.id===reader.id)return 'Only reading.';
    if(input.chat.id===full.id&&/Start/.test(input.prompt)){say('full',await tools.call('delegate_task',{prompt:'Deploy preview.',title:'Deploy'}));return 'ok';}
    if(input.chat.id===lead.id&&/Chain/.test(input.prompt)){chain.push(lead.id);say('chain',await tools.call('delegate_task',{prompt:'Level 1 go deeper.',title:'Level 1'}));return 'ok';}
    if(/Level (\d) go deeper/.test(input.prompt)){const n=Number(/Level (\d)/.exec(input.prompt)![1]);chain.push(input.chat.id);say('chain',await tools.call('delegate_task',{prompt:`Level ${n+1} go deeper.`,title:`Level ${n+1}`}));return `level ${n}`;}
    if(input.chat.id===lead.id&&/Fan out/.test(input.prompt)){
      for(let i=0;i<5;i++)say('fan',await tools.call('delegate_task',{prompt:`Shard ${i}.`,title:`Shard ${i}`}));
      say('model',await tools.call('delegate_task',{prompt:'x',model:'gpt-unknown'}));
      say('provider',await tools.call('delegate_task',{prompt:'x',provider:'gamma',model:'g-1'}));
      say('folder',await tools.call('delegate_task',{prompt:'x',folder:'/etc'}));
      return 'ok';
    }
    if(/Shard \d/.test(input.prompt)){const gate=deferred();gates.push(gate);await gate.promise;return 'shard done';}
    return 'ok';
  };
  await send(service,reader.id,'Look around.');
  await until(()=>fake.turns(reader.id).length===1,'reader turn');
  assert.equal(fake.turns(reader.id)[0]!.configOverrides?.['mcp_servers.muster_delegation.command'],undefined,'no delegation tools in read-only');
  assert.equal(fake.turns(reader.id)[0]!.configOverrides?.[TOKEN],undefined);
  await until(()=>idle(service,reader.id),'reader idle');
  // A token for the read-only chat (as if a stale process had one) is still refused by the runner.
  const forged=await callTool(dataDir,reader.id,'0'.repeat(64),'delegate_task',{prompt:'x'});
  assert.equal(forged.status,403,'a chat without its own token cannot call');

  await send(service,full.id,'Start the deploy.');
  await until(()=>results.full?.length===1,'full delegation');
  const fullChild=(await service.invoke('delegation.children',{chatId:full.id}))[0]!;
  assert.equal((await chatOf(service,fullChild.id))!.permissionMode,'full','a Full access parent passes Full access on');
  await until(()=>idle(service,full.id),'full idle');
  await service.invoke('chat.setPermissionMode',{id:full.id,permissionMode:'workspace'});

  await send(service,lead.id,'Chain three deep.');
  await until(()=>(results.chain?.length??0)===4,'four delegate attempts down the chain');
  const chainResults=results.chain!;
  assert.deepEqual(chainResults.map(result=>result.isError),[false,false,false,true]);
  assert.match(chainResults[3]!.text,/at most 3 chats deep, and this chat is already 3 deep/);
  for(const id of chain.slice(1))assert.equal((await chatOf(service,id))!.permissionMode,'workspace');
  await until(async()=>{for(const id of chain)if(!await idle(service,id))return false;return true;},'chain idle');

  const before=(await service.invoke('app.snapshot',undefined)).chats.length;
  await send(service,lead.id,'Fan out.');
  await until(()=>results.folder?.length===1,'fan out');
  assert.deepEqual(results.fan!.map(result=>result.isError),[false,false,false,false,true]);
  assert.match(results.fan![4]!.text,/4 chats you started are still working \(at most 4 at once\)/);
  assert.match(results.model![0]!.text,/"gpt-unknown" is not a model you have set up\. Set up: Alpha \(alpha\): alpha-1; Beta \(beta\): beta-1\./);
  assert.match(results.provider![0]!.text,/"gamma" is not a provider you have set up/);
  assert.match(results.folder![0]!.text,/only delegate into a folder this chat can use/);
  assert.equal((await service.invoke('app.snapshot',undefined)).chats.length,before+4,'refused calls create no chat');
  for(const gate of gates)gate.resolve();
});

// Spec: MUS-SPEC-05-44G (docs/spec/clauses/05-access-modes-and-approvals.md#mus-spec-05-44g)
test('a child\'s approval shows on its parent too and can be answered from either chat',async t=>{
  const {service,fake,chat}=await setup(t);
  const parent=await chat('Lead');
  let childId='';const decisions:string[]=[];
  fake.script=async(input,tools)=>{
    if(input.chat.id===parent.id&&/Start/.test(input.prompt)){childId=idIn((await tools.call('delegate_task',{prompt:'Clean the build.',title:'Clean'})).text);return 'Started.';}
    if(input.chat.id===childId){
      for(const command of ['rm -rf build','rm -rf dist']){
        const answer=await input.onRequest('item/commandExecution/requestApproval',{command,cwd:'/tmp',reason:'Clean up'});
        decisions.push(`${command}: ${String((answer as {decision?:string})?.decision)}`);
      }
      return 'Cleaned.';
    }
    return 'ok';
  };
  await send(service,parent.id,'Start cleaning.');
  const pending=async(id:string)=>(await timeline(service,id)).filter(item=>item.kind==='approval'&&item.status==='pending');
  await until(async()=>(await pending(parent.id)).length===1,'the copy on the parent');
  const [copy]=await pending(parent.id),[own]=await pending(childId);
  assert.equal(copy!.text,own!.text);assert.match(own!.text,/rm -rf build/);
  assert.deepEqual(copy!.data?.delegated,{chatId:childId,itemId:own!.id,title:'Clean'});
  await service.invoke('approval.respond',{id:copy!.id,approved:true});
  await until(()=>decisions.length===1,'the child got the parent\'s answer');
  assert.equal(decisions[0],'rm -rf build: accept');
  const settled=async(id:string,itemId:string)=>(await timeline(service,id)).find(item=>item.id===itemId)?.status;
  assert.equal(await settled(childId,own!.id),'approved');assert.equal(await settled(parent.id,copy!.id),'approved');
  // The second one is answered in the child: the parent's copy closes too.
  await until(async()=>(await pending(childId)).length===1&&(await pending(parent.id)).length===1,'second request');
  const [second]=await pending(childId),[secondCopy]=await pending(parent.id);
  await service.invoke('approval.respond',{id:second!.id,approved:false});
  await until(()=>decisions.length===2,'declined');
  assert.equal(decisions[1],'rm -rf dist: decline');
  assert.equal(await settled(parent.id,secondCopy!.id),'declined');
});

// Spec: MUS-SPEC-14-44H (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-44h)
test('only a parent or its ancestors may control a child; a sibling or the child itself is refused',async t=>{
  const {service,fake,chat}=await setup(t);
  const parent=await chat('Lead'),sibling=await chat('Neighbour');
  let childId='',grandchildId='';const hold=deferred();
  fake.script=async(input,tools)=>{
    if(input.chat.id===parent.id&&/Start/.test(input.prompt)){childId=idIn((await tools.call('delegate_task',{prompt:'Plan the release.',title:'Release'})).text);return 'ok';}
    if(input.chat.id===childId&&/Plan the release/.test(input.prompt)){grandchildId=idIn((await tools.call('delegate_task',{prompt:'Draft notes.',title:'Notes'})).text);return 'planned';}
    if(input.chat.id===grandchildId){await hold.promise;return 'notes';}
    return 'ok';
  };
  await send(service,sibling.id,'Hello.');
  await send(service,parent.id,'Start.');
  await until(()=>!!grandchildId&&fake.turns(grandchildId).length===1,'grandchild working');
  await until(async()=>await idle(service,parent.id)&&await idle(service,sibling.id)&&await idle(service,childId),'others idle');
  for(const tool of ['read_task','message_task','wait_task','interrupt_task']){
    const refused=await fake.tools(sibling.id).call(tool,{id:childId,text:'Stop everything.',timeout_seconds:1});
    assert.equal(refused.isError,true,tool);assert.match(refused.text,/is not a chat you started/);
  }
  const upward=await fake.tools(childId).call('interrupt_task',{id:parent.id});
  assert.equal(upward.isError,true);assert.match(upward.text,/is not a chat you started/);
  assert.equal(fake.steers.length,0);assert.deepEqual(fake.stops,[]);
  assert.equal((await fake.tools(sibling.id).call('list_tasks')).text,'You have not started any chats.');
  // The grandparent may: it is an ancestor.
  const fromRoot=await fake.tools(parent.id).call('read_task',{id:grandchildId});
  assert.equal(fromRoot.isError,false);assert.match(fromRoot.text,/"Notes" on Alpha One: running/);
  hold.resolve();
});

// Spec: MUS-SPEC-14-44I (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-44i)
test('links survive a restart: the parent still lists, reads and controls its child, and others still cannot',async t=>{
  const dataDir=await directory(t);
  let childId='';
  {
    const {service,fake,chat}=await setup(t,{dataDir});
    const parent=await chat('Lead');await chat('Neighbour');
    fake.script=async(input,tools)=>{
      if(input.chat.id===parent.id&&/Start/.test(input.prompt)){childId=idIn((await tools.call('delegate_task',{prompt:'Count the files.',title:'Count',wait:true})).text);return 'ok';}
      if(input.chat.id!==parent.id)return '42 files.';
      return 'ok';
    };
    await send(service,parent.id,'Start.');
    await until(async()=>(await notices(service,parent.id,'delegated-task')).length===2,'child finished');
    await until(()=>idle(service,parent.id),'parent idle');
    service.dispose();
  }
  const fake=harness(dataDir);
  const service=createAgentService({dataDir,provider:fake.provider,onEvent(){}});t.after(()=>service.dispose());
  const chats=(await service.invoke('app.snapshot',undefined)).chats;
  const parent=chats.find(chat=>chat.title==='Lead')!,neighbour=chats.find(chat=>chat.title==='Neighbour')!;
  childId=(await service.invoke('delegation.children',{chatId:parent.id}))[0]?.id??'';
  assert.ok(childId,'the link is still there');
  const seen:Record<string,string>={};
  fake.script=async(input,tools)=>{
    if(input.chat.id===parent.id){seen.list=(await tools.call('list_tasks')).text;seen.read=(await tools.call('read_task',{id:childId})).text;}
    if(input.chat.id===neighbour.id)seen.neighbour=(await tools.call('read_task',{id:childId})).text;
    return 'ok';
  };
  await send(service,parent.id,'What did you start?');await send(service,neighbour.id,'Peek.');
  await until(()=>!!seen.read&&!!seen.neighbour,'tool calls after restart');
  assert.match(seen.list!,new RegExp(`${childId} "Count" on Alpha One: finished`));
  assert.match(seen.read!,/Final reply:\n42 files\./);
  assert.match(seen.neighbour!,/is not a chat you started/);
  assert.equal((await notices(service,childId,'delegated-from'))[0]?.text,'Started by Lead');
});

// Spec: MUS-SPEC-14-44J (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-44j)
test('stopping a parent\'s children stops every working chat below it',async t=>{
  const {service,fake,chat}=await setup(t);
  const parent=await chat('Lead');
  const ids:string[]=[];const forever=deferred();
  fake.script=async(input,tools)=>{
    if(input.chat.id===parent.id&&/Start/.test(input.prompt)){for(const title of ['One','Two'])ids.push(idIn((await tools.call('delegate_task',{prompt:`${title} job.`,title})).text));return 'ok';}
    if(ids.includes(input.chat.id)){await forever.promise;return 'never';}
    return 'ok';
  };
  await send(service,parent.id,'Start two.');
  await until(()=>ids.length===2&&ids.every(id=>fake.turns(id).length===1),'children working');
  const listed=await service.invoke('delegation.children',{chatId:parent.id});
  assert.deepEqual(listed.map(task=>[task.title,task.status,task.model,task.depth]),[['One','running','alpha-1',1],['Two','running','alpha-1',1]]);
  assert.deepEqual(await service.invoke('delegation.stopChildren',{chatId:parent.id}),{stopped:2});
  await until(async()=>{for(const id of ids)if((await chatOf(service,id))?.status!=='interrupted')return false;return true;},'children stopped');
});
