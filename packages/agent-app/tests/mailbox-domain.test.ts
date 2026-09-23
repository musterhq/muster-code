import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {AgentStore} from '../src/runtime/store.ts';
import {createDomainHooks} from '../src/runtime/domains/hooks.ts';
import {createMailbox} from '../src/runtime/domains/mailbox.ts';
import type {DomainContext} from '../src/runtime/domains/types.ts';
import {MAILBOX_TOOL_SPECS,MailboxToolHost} from '../src/runtime/mailbox-agent-tools.ts';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter,ProviderInput} from '../src/runtime/provider.ts';
import type {AgentEvent,Chat} from '../src/shared/protocol.ts';
import {MAILBOX_TURN_MESSAGES} from '../src/shared/domains/mailbox-protocol.ts';

async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-mailbox-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
const text=(result:{content:{text:string}[]})=>result.content.map(part=>part.text).join('\n');

/** Real store and hook runtime; `invoke` answers the few cross-domain commands the mailbox uses. */
async function harness(t:TestContext,options:{tools?:boolean}={}){
  const dataDir=await directory(t),store=new AgentStore(dataDir);t.after(()=>store.close());
  const hooks=createDomainHooks(),events:AgentEvent[]=[],invoked:{command:string;input:Record<string,unknown>}[]=[];
  let clock=Date.parse('2026-09-23T10:00:00.000Z');
  const tasks:{id:string;title:string;runChatId?:string}[]=[];
  const steer={ok:false};
  const context={dataDir,store,db:()=>store.database(),emit:(event:AgentEvent)=>events.push(event),emitSnapshot(){},folderFor:()=>{throw new Error('no folders');},hooks:hooks.hooks,
    async invoke(command:string,input:Record<string,unknown>){invoked.push({command,input});
      if(command==='project.work')return {tasks:{items:tasks,truncated:false}};
      if(command==='subagents.control')return {...steer};
      if(command==='chat.send')return {runId:'run'};
      throw new Error(`unexpected ${command}`);}} as unknown as DomainContext;
  const hosts:string[]=[];
  const mailbox=createMailbox(context,{now:()=>clock,wakeGapMs:1000,toolHost:options.tools?()=>({async start(){hosts.push('started');return '/tmp/muster-mailbox-mcp';},dispose(){}}):false});
  t.after(()=>mailbox.module.dispose?.());
  const project=store.createProject('Launch','Ship it',[]),other=store.createProject('Other','',[]);
  const chat=(projectId?:string,title='Chat')=>{const created=store.createChat({...(projectId?{projectId}:{}),model:'m',mode:'agent'});return store.updateChat(created.id,{title});};
  const call=(command:string,input:Record<string,unknown>)=>Promise.resolve().then(()=>mailbox.module.handlers[command]!(input)) as Promise<any>;
  /** One provider turn: what the prompt carries, then the run settling with `status`. */
  const turn=async(target:Chat,status:'completed'|'failed'='completed')=>{const current=store.chat(target.id)!;const contributed=await hooks.contributePrompt({chat:current,prompt:'go'});hooks.runSettled({chat:current,runId:randomUUID(),status});await new Promise(resolve=>setImmediate(resolve));return contributed.text;};
  return {store,hooks,events,invoked,mailbox,call,turn,chat,project,other,tasks,steer,hosts,advance(ms:number){clock+=ms;},get now(){return clock;}};
}

test('user mail rides into the recipient chat\'s next turn once; a failed turn does not count as delivery',async t=>{
  const h=await harness(t),a=h.chat(h.project.id,'API worker');
  const sent=await h.call('mailbox.send',{to:{kind:'chat',id:a.id},subject:'Schema',body:'Use the v2 users table.'});
  assert.equal(sent.state,'pending');assert.equal(sent.sender.kind,'user');assert.equal(sent.recipient.label,'API worker');assert.equal(sent.projectId,h.project.id);
  assert.ok(h.events.some(event=>event.type==='mailboxChanged'&&event.chatIds.includes(a.id)));
  const failed=await h.turn(a,'failed');
  assert.match(failed,/<context source="mailbox">[\s\S]*#\d+ message from the user · Schema: Use the v2 users table\./);
  assert.equal((await h.call('mailbox.get',{id:sent.id})).state,'pending','a failed turn is not a delivery');
  const again=await h.turn(a);
  assert.match(again,/Use the v2 users table/,'re-offered on the next turn');
  const delivered=await h.call('mailbox.get',{id:sent.id});
  assert.equal(delivered.state,'delivered');assert.equal(delivered.deliveries[0].via,'turn');assert.equal(delivered.deliveries[0].chatId,a.id);
  assert.equal(await h.turn(a),'','delivered mail is not repeated');
  const listed=await h.call('mailbox.list',{chatId:a.id});
  assert.equal(listed.unacked,1);assert.equal(listed.pending,0);
  const acked=await h.call('mailbox.ack',{messageId:sent.id});
  assert.equal(acked.state,'acked');assert.ok(acked.deliveries[0].ackedAt);
  assert.equal((await h.call('mailbox.list',{chatId:a.id})).unacked,0);
});

test('idempotency keys: a retried send returns the first message; reusing a key for different content is refused',async t=>{
  const h=await harness(t),a=h.chat(h.project.id,'A'),b=h.chat(h.project.id,'B');
  const first=await h.mailbox.runTool(a.id,'mailbox_send',{to:`chat:${b.id}`,body:'Run the migration',idempotency_key:'mig-1'});
  const retry=await h.mailbox.runTool(a.id,'mailbox_send',{to:`chat:${b.id}`,body:'Run the migration',idempotency_key:'mig-1'});
  assert.match(text(first),/^Sent #(\d+) to B\./);
  assert.equal(text(retry).replace('Already sent','Sent'),text(first),'same message, same sequence number');
  assert.equal((await h.call('mailbox.list',{chatId:b.id})).messages.length,1);
  const clash=await h.mailbox.runTool(a.id,'mailbox_send',{to:`chat:${b.id}`,body:'Something else',idempotency_key:'mig-1'});
  assert.equal(clash.isError,true);assert.match(text(clash),/already used for a different message/);
  // Keys are per sender: the user may use the same key.
  const user=await h.call('mailbox.send',{to:{kind:'chat',id:b.id},body:'Run the migration',idempotencyKey:'mig-1'});
  assert.notEqual(user.seq,Number(/#(\d+)/.exec(text(first))![1]));
  // Sequence numbers are strictly increasing in send order.
  const seqs=(await h.call('mailbox.list',{chatId:b.id})).messages.map((m:{seq:number})=>m.seq);
  assert.deepEqual(seqs,[...seqs].sort((x:number,y:number)=>y-x));
});

test('expiry: undelivered mail past its expiry is never delivered and is hidden unless asked for',async t=>{
  const h=await harness(t),a=h.chat(h.project.id,'A');
  const short=await h.call('mailbox.send',{to:{kind:'chat',id:a.id},body:'Only relevant this minute',expiresInMs:60_000});
  const long=await h.call('mailbox.send',{to:{kind:'chat',id:a.id},body:'Still relevant'});
  assert.equal(short.expiresAt,new Date(h.now+60_000).toISOString());
  h.advance(61_000);
  const block=await h.turn(a);
  assert.doesNotMatch(block,/Only relevant/);assert.match(block,/Still relevant/);
  assert.equal((await h.call('mailbox.get',{id:short.id})).state,'expired');
  assert.equal((await h.call('mailbox.get',{id:long.id})).state,'delivered');
  assert.deepEqual((await h.call('mailbox.list',{chatId:a.id})).messages.map((m:{id:string})=>m.id),[long.id]);
  assert.equal((await h.call('mailbox.list',{chatId:a.id,includeExpired:true})).messages.length,2);
  await assert.rejects(h.call('mailbox.send',{to:{kind:'chat',id:a.id},body:'x',expiresInMs:10}),/Expiry must be between/);
});

test('request/reply: a reply before the deadline answers once; after it the reply is refused and the sender hears once',async t=>{
  const h=await harness(t),a=h.chat(h.project.id,'Lead'),b=h.chat(h.project.id,'Worker');
  const asked=text(await h.mailbox.runTool(a.id,'mailbox_send',{to:`chat:${b.id}`,body:'Is the users table migrated?',request:true,reply_within_minutes:5}));
  const ref=/#(\d+)/.exec(asked)![1];
  assert.match(asked,/Reply due by 2026-09-23T10:05:00.000Z/);
  const request=await h.call('mailbox.get',{id:ref});
  assert.equal(request.kind,'request');assert.equal(request.reply,'awaiting');assert.deepEqual(request.sender,{kind:'chat',id:a.id,label:'Lead'});
  assert.match(await h.turn(b),new RegExp(`#${ref} request, reply by 2026-09-23T10:05Z from chat "Lead" \\(chat:${a.id}\\)`));
  const replied=await h.mailbox.runTool(b.id,'mailbox_reply',{message_id:`#${ref}`,body:'Yes, done.',idempotency_key:'r1'});
  assert.match(text(replied),/^Replied #\d+ to Lead\./);
  assert.match(text(await h.mailbox.runTool(b.id,'mailbox_reply',{message_id:`#${ref}`,body:'Yes, done.',idempotency_key:'r1'})),/^Already replied/,'an idempotent retry is not a second reply');
  const answered=await h.call('mailbox.get',{id:ref});
  assert.equal(answered.reply,'answered');assert.ok(answered.replyId);
  assert.equal(answered.deliveries.find((d:{chatId:string})=>d.chatId===b.id).ackedAt!==null,true,'replying acknowledges the request');
  const second=await h.mailbox.runTool(b.id,'mailbox_reply',{message_id:ref,body:'Also…'});
  assert.equal(second.isError,true);assert.match(text(second),/already answered/);
  assert.match(await h.turn(a),/reply to #\d+ from chat "Worker"[\s\S]*Yes, done\./,'the reply reaches the requester next turn');

  const late=/#(\d+)/.exec(text(await h.mailbox.runTool(a.id,'mailbox_send',{to:`chat:${b.id}`,body:'Deploy?',request:true,reply_within_minutes:1})))![1];
  h.advance(61_000);
  assert.equal((await h.call('mailbox.get',{id:late})).reply,'timed-out');
  const refused=await h.mailbox.runTool(b.id,'mailbox_reply',{message_id:`#${late}`,body:'ok'});
  assert.equal(refused.isError,true);assert.match(text(refused),/reply deadline for request #\d+ passed/);
  assert.match(await h.turn(a),new RegExp(`#${late} your request to Worker got no reply by 2026-09-23T10:01Z`));
  assert.equal(await h.turn(a),'','the timeout is reported once');
  await assert.rejects(h.call('mailbox.send',{to:{kind:'chat',id:b.id},body:'x',kind:'request',replyWithinMs:1000}),/reply deadline must be between/i);
});

test('ack: only a recipient may acknowledge; project mail fans out to every other project chat with its own ack',async t=>{
  const h=await harness(t),a=h.chat(h.project.id,'A'),b=h.chat(h.project.id,'B'),c=h.chat(h.project.id,'C');
  const sent=text(await h.mailbox.runTool(a.id,'mailbox_send',{to:'project',body:'Freeze main until 3pm.'}));
  const ref=/#(\d+)/.exec(sent)![1];
  assert.equal(await h.turn(a),'','the sender does not receive its own broadcast');
  assert.match(await h.turn(b),/to the project/);assert.match(await h.turn(c),/Freeze main/);
  const notMine=await h.mailbox.runTool(a.id,'mailbox_ack',{message_id:ref});
  assert.equal(notMine.isError,true);assert.match(text(notMine),/not addressed to this chat/);
  assert.match(text(await h.mailbox.runTool(b.id,'mailbox_ack',{message_id:ref})),/^Acknowledged #/);
  const message=await h.call('mailbox.get',{id:ref});
  assert.equal(message.state,'acked');
  assert.deepEqual(message.deliveries.map((d:{chatId:string;ackedAt:string|null})=>[d.chatId,!!d.ackedAt]).sort(),[[b.id,true],[c.id,false]].sort());
  assert.equal((await h.call('mailbox.list',{chatId:c.id})).unacked,1);
  await assert.rejects(h.call('mailbox.ack',{messageId:ref}),/Choose which chat/);
  assert.equal((await h.call('mailbox.ack',{messageId:ref,chatId:c.id})).deliveries.every((d:{ackedAt:string|null})=>d.ackedAt),true);
  assert.equal((await h.call('mailbox.list',{projectId:h.project.id})).messages.length,1);
});

test('agents speak only as their own chat and only inside their project; the user box gets agent mail',async t=>{
  const h=await harness(t),a=h.chat(h.project.id,'A'),outsider=h.chat(h.other.id,'Outsider'),loose=h.chat(undefined,'Loose');
  for(const to of [`chat:${outsider.id}`,`project:${h.other.id}`,`chat:${a.id}`]){const result=await h.mailbox.runTool(a.id,'mailbox_send',{to,body:'hi'});assert.equal(result.isError,true,to);}
  assert.equal((await h.mailbox.runTool(loose.id,'mailbox_send',{to:'project',body:'hi'})).isError,true);
  assert.match(text(await h.mailbox.runTool(a.id,'mailbox_send',{to:'nobody',body:'hi'})),/to must be chat:<id>/);
  const toUser=text(await h.mailbox.runTool(a.id,'mailbox_send',{to:'user',body:'Need a decision on pricing.',request:true}));
  assert.match(toUser,/^Sent #\d+ to You\./);
  const box=await h.call('mailbox.list',{});
  assert.equal(box.messages[0].recipient.kind,'user');assert.equal(box.messages[0].state,'delivered');assert.equal(box.unacked,1);
  const answer=await h.call('mailbox.reply',{messageId:box.messages[0].id,body:'Go with $20.'});
  assert.equal(answer.recipient.id,a.id);assert.equal(answer.sender.kind,'user');
  assert.match(await h.turn(a),/reply to #\d+ from the user[\s\S]*Go with \$20\./);
  // The user may mail any chat, even outside a project.
  assert.equal((await h.call('mailbox.send',{to:{kind:'chat',id:loose.id},body:'hello'})).recipient.id,loose.id);
  await assert.rejects(h.call('mailbox.send',{to:{kind:'user',id:'user'},body:'self'}),/to yourself/);
});

test('task-run mail waits for the task\'s chat; subagent mail is steered in when the child is running, else read by the parent',async t=>{
  const h=await harness(t),lead=h.chat(h.project.id,'Lead');
  h.tasks.push({id:'task-1',title:'Build API'});
  const queued=await h.call('mailbox.send',{to:{kind:'taskRun',id:'task-1',projectId:h.project.id},body:'Use pagination.'});
  assert.equal(queued.recipient.label,'Build API');assert.equal(queued.recipient.chatId,undefined);
  const runner=h.chat(h.project.id,'Build API run');
  assert.equal(await h.turn(runner),'','not bound before the task runs in this chat');
  h.tasks[0]!.runChatId=runner.id;
  assert.match(await h.turn(runner),/for task "Build API"[\s\S]*Use pagination\./);

  h.store.appendItem(lead.id,'tool','spawn','completed',{type:'collabAgentToolCall',senderThreadId:'parent',receiverThreadIds:['child-1']});
  await assert.rejects(h.call('mailbox.send',{to:{kind:'agent',id:'ghost',chatId:lead.id},body:'x'}),/has not reported this subagent/);
  const parked=await h.call('mailbox.send',{to:{kind:'agent',id:'child-1',chatId:lead.id,label:'Reviewer'},body:'Check tests too.'});
  assert.equal(parked.state,'pending');
  assert.ok(h.invoked.some(call=>call.command==='subagents.control'&&call.input.action==='steer'&&call.input.threadId==='child-1'));
  assert.match(await h.turn(lead),/for your subagent Reviewer[\s\S]*Check tests too\./);
  h.steer.ok=true;
  const steered=await h.call('mailbox.send',{to:{kind:'agent',id:'child-1',chatId:lead.id},body:'Stop after lint.'});
  assert.equal(steered.state,'delivered');assert.equal(steered.deliveries[0].via,'steer');
  assert.equal(await h.turn(lead),'');
});

test('wake starts a turn in an idle recipient at most once per gap; the inbox block stays compact and bounded',async t=>{
  const h=await harness(t,{tools:true}),a=h.chat(h.project.id,'A'),b=h.chat(h.project.id,'B');
  assert.match(text(await h.mailbox.runTool(a.id,'mailbox_send',{to:`chat:${b.id}`,body:'ping',wake:true})),/Woke the recipient chat\./);
  assert.match(text(await h.mailbox.runTool(a.id,'mailbox_send',{to:`chat:${b.id}`,body:'ping again',wake:true})),/woken moments ago/);
  assert.equal(h.invoked.filter(call=>call.command==='chat.send').length,1);
  for(let index=0;index<MAILBOX_TURN_MESSAGES+3;index++)await h.call('mailbox.send',{to:{kind:'chat',id:b.id},body:`note ${index} `+'x'.repeat(5000)});
  const block=await h.turn(b);
  assert.equal(block.match(/^#\d+ /gm)?.length,MAILBOX_TURN_MESSAGES);
  assert.match(block,/\+5 more queued/);assert.match(block,/mailbox_reply/);
  assert.ok(block.length<4200,`inbox block is ${block.length} chars`);
  const options=await h.hooks.resolveRunOptions(h.store.chat(b.id)!);
  assert.equal(options.configOverrides?.['mcp_servers.muster_mailbox.env.MUSTER_CHAT_ID'],b.id);
  const loose=h.chat(undefined,'Loose');
  assert.equal((await h.hooks.resolveRunOptions(h.store.chat(loose.id)!)).configOverrides?.['mcp_servers.muster_mailbox.command'],undefined,'no mail, no project: no tools');
  await h.call('mailbox.send',{to:{kind:'chat',id:loose.id},body:'hi'});
  assert.ok((await h.hooks.resolveRunOptions(h.store.chat(loose.id)!)).configOverrides?.['mcp_servers.muster_mailbox.command']);
  const inbox=text(await h.mailbox.runTool(b.id,'mailbox_inbox',{}));
  assert.match(inbox,/Unacknowledged mail/);assert.match(inbox,new RegExp(`chat:${a.id} "A"`));
});

test('the MCP host authenticates, routes calls as the calling chat, and writes a launcher',async t=>{
  const dir=await directory(t),calls:string[]=[];
  const host=new MailboxToolHost({dir,execPath:process.execPath,run:(chatId,tool,args)=>{calls.push(`${chatId}:${tool}:${JSON.stringify(args)}`);return {content:[{type:'text',text:'ok'}]};}});
  t.after(()=>host.dispose());
  const launcher=await host.start();
  assert.equal(launcher,await host.start(),'started once');
  assert.ok(existsSync(launcher));
  const {url}=JSON.parse(await (await import('node:fs/promises')).readFile(join(dir,'mailbox-endpoint.json'),'utf8'));
  assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,403);
  assert.deepEqual(await host.call('chat-1','mailbox_ack',{message_id:'#1'}),{content:[{type:'text',text:'ok'}]});
  assert.equal((await host.call('bad id!','mailbox_ack',{})).isError,true);
  assert.equal((await host.call('chat-1','rm_rf',{})).isError,true);
  assert.deepEqual(calls,['chat-1:mailbox_ack:{"message_id":"#1"}']);
  assert.deepEqual(MAILBOX_TOOL_SPECS.map(spec=>spec.name),['mailbox_send','mailbox_reply','mailbox_ack','mailbox_inbox']);
});

test('end to end: the service puts pending mail in the next provider turn and persists across a restart',async t=>{
  const dataDir=await directory(t),inputs:ProviderInput[]=[];
  const provider:ProviderAdapter={info:()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture'}]}],
    async run(input){inputs.push(input);return {status:'completed',finalMessage:'ok',threadId:'thread-1',turnId:`turn-${inputs.length}`,dispatchState:'dispatched'};},stop:async()=>true,dispose(){}};
  let service=createAgentService({dataDir,provider,onEvent(){}});
  const chat=await service.invoke('chat.create',{});
  const sent=await service.invoke('mailbox.send',{to:{kind:'chat',id:chat.id},body:'Remember the changelog.'});
  await service.dispose();
  service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  assert.equal((await service.invoke('mailbox.get',{id:sent.id})).state,'pending','durable across restart');
  const settled=async()=>{for(let i=0;i<2000;i++){const status=(await service.invoke('app.snapshot',undefined)).chats.find(entry=>entry.id===chat.id)?.status;if(status!=='running'&&status!=='stopping'&&inputs.length)return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('run did not settle');};
  await service.invoke('chat.send',{id:chat.id,text:'hello',requestId:randomUUID()});await settled();
  assert.match(inputs[0]!.prompt,/<context source="mailbox">[\s\S]*Remember the changelog\.[\s\S]*Current user request:\nhello/);
  for(let i=0;i<200&&(await service.invoke('mailbox.get',{id:sent.id})).state!=='delivered';i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal((await service.invoke('mailbox.get',{id:sent.id})).state,'delivered');
  const before=inputs.length;
  await service.invoke('chat.send',{id:chat.id,text:'again',requestId:randomUUID()});
  for(let i=0;i<2000&&inputs.length===before;i++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.doesNotMatch(inputs.at(-1)!.prompt,/Remember the changelog/);
});
