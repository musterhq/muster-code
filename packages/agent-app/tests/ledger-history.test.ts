/** Imported history for the Ledger (#190): past turns rebuilt from saved chats and imported Paperclip activity, once,
 *  outside the hash chain. Runs against the real AgentStore schema. */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {AgentStore} from '../src/runtime/store.ts';
import {TurnLedger} from '../src/runtime/turn-ledger.ts';
import {importLedgerHistory,matchReceipts,splitTurns} from '../src/runtime/ledger-history.ts';
import {MODEL_USAGE_SCHEMA} from '../src/runtime/domains/models.ts';
import {SqliteImportStore} from '../src/runtime/paperclip-import.ts';

async function fixture(t:TestContext){
  const dir=await mkdtemp(join(tmpdir(),'muster-ledger-history-'));
  const store=new AgentStore(dir);
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  const db=store.database();
  db.exec(MODEL_USAGE_SCHEMA);
  return {store,db,ledger:new TurnLedger(db)};
}
/** One sent turn: the send receipt and user message, then the agent's items, then the chat settles. */
function turn(store:AgentStore,chatId:string,text:string,items:[string,string,Record<string,unknown>?][]=[],status:'completed'|'failed'|'interrupted'='completed'){
  const {runId}=store.recordSend(chatId,`req-${text}`,text);
  for(const [kind,body,data] of items)store.appendItem(chatId,kind as never,body,'completed',data);
  store.updateChat(chatId,{status});
  return runId;
}
const live=(chatId:string,runId:string)=>({id:`${chatId}:${runId}`,chatId,runId,taskId:null,projectId:null,trigger:'chat',agent:'Chat',provider:'p',model:'m',tokens:null,costUsd:null,tools:[],approvals:0,tests:0,files:null,startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),durationMs:0,outcome:'completed'});

test('imported history: one entry per past turn with tools, tests, approvals and outcome, labelled history and never chained',async t=>{
  const {store,db,ledger}=await fixture(t);
  const a=store.createChat({model:'gpt-x',providerId:'openai',mode:'agent'});
  store.updateChat(a.id,{title:'Refactor login'});
  turn(store,a.id,'first',[['tool','npm test',{type:'commandExecution',command:'npm test'}],['tool','ls',{type:'commandExecution',command:'ls'}],['tool','fs / read',{type:'mcpToolCall',server:'fs',tool:'read'}],['approval','Run rm?',{method:'x'}],['assistant','Done.']]);
  turn(store,a.id,'second',[['assistant','Stopped.']],'interrupted');
  // A chat with one turn gets its stored usage; a busy chat is left for later.
  const b=store.createChat({model:'claude-x',providerId:'anthropic',mode:'agent'});
  turn(store,b.id,'only',[['assistant','Hi']]);
  db.prepare("INSERT INTO model_usage (chat_id, provider_id, model, input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, requests, updated_at) VALUES (?, 'anthropic', 'claude-x', 1000, 200, 300, 50, 2, ?)").run(b.id,new Date().toISOString());
  const busy=store.createChat({model:'m',mode:'agent'});
  store.recordSend(busy.id,'req-busy','still going');
  // A live receipt already on the chain before the import.
  const headBefore=ledger.append(live('other','r0')).hash;

  const first=await importLedgerHistory(db,ledger,{pricing:(provider,model)=>provider==='anthropic'&&model==='claude-x'?{inputPerMTok:3,outputPerMTok:15,cachedInputPerMTok:0.3,source:'catalog'}:null});
  assert.deepEqual(first,{chats:2,turns:3});
  const entries=ledger.list();
  const history=entries.filter(e=>e.source==='history');
  assert.equal(history.length,3);
  for(const e of history){assert.equal(e.seq,null);assert.equal(e.hash,null);assert.equal(e.prevHash,null);assert.match(e.id,/^history:/);}
  const [one,two]=history.filter(e=>e.chatId===a.id).sort((x,y)=>x.startedAt!.localeCompare(y.startedAt!));
  assert.equal(one.agent,'Refactor login');assert.equal(one.provider,'openai');assert.equal(one.model,'gpt-x');
  assert.deepEqual(one.tools,[{name:'shell',count:2},{name:'fs/read',count:1}]);
  assert.equal(one.tests,1);assert.equal(one.approvals,1);assert.equal(one.outcome,'completed');assert.equal(one.tokens,null,'usage is per chat: not split across turns');
  assert.equal(two.outcome,'interrupted','the last turn takes the chat’s final status');
  const solo=history.find(e=>e.chatId===b.id)!;
  assert.deepEqual(solo.tokens,{input:1000,cached:200,output:300,reasoning:50});
  assert.equal(solo.costUsd,(800*3+200*0.3+300*15)/1_000_000);
  assert.ok(!history.some(e=>e.chatId===busy.id),'a running chat is not imported while it runs');
  // The chain is untouched and still verifies.
  assert.deepEqual(ledger.verify(),{ok:true,entries:1,head:headBefore,brokenAt:null});

  // Idempotent: running again adds nothing.
  assert.deepEqual(await importLedgerHistory(db,ledger),{chats:0,turns:0});
  assert.equal(ledger.list().filter(e=>e.source==='history').length,3);
  // Live receipts keep chaining after an import, and verify() still passes.
  ledger.append(live('other','r1'));
  assert.equal(ledger.verify().ok,true);assert.equal(ledger.verify().entries,2);
  // The busy chat comes in on a later run, once it settled.
  store.updateChat(busy.id,{status:'completed'});
  assert.deepEqual(await importLedgerHistory(db,ledger),{chats:1,turns:1});
  assert.deepEqual(await importLedgerHistory(db,ledger),{chats:0,turns:0});
});

test('imported history skips turns the live ledger already recorded, matched through the send receipt',async t=>{
  const {store,db,ledger}=await fixture(t);
  const chat=store.createChat({model:'m',mode:'agent'});
  const old=turn(store,chat.id,'before upgrade',[['assistant','a']]);
  const recorded=turn(store,chat.id,'after upgrade',[['assistant','b']]);
  ledger.append(live(chat.id,recorded));
  await importLedgerHistory(db,ledger);
  const history=ledger.list({chatIds:[chat.id]}).filter(e=>e.source==='history');
  assert.deepEqual(history.map(e=>e.runId),[old],'only the unrecorded turn is imported, under its real run id');
  assert.equal(ledger.list({chatIds:[chat.id]}).length,2);
  assert.equal(ledger.verify().ok,true);
});

test('a task run’s chat is never imported as history, and a live task Receipt replaces any history row for it',async t=>{
  const {store,db,ledger}=await fixture(t);
  const chat=store.createChat({model:'m',mode:'agent'});
  const runId=turn(store,chat.id,'task prompt',[['assistant','done']]);
  await importLedgerHistory(db,ledger);
  assert.equal(ledger.list({chatIds:[chat.id]}).filter(e=>e.source==='history').length,1,'imported while it looked like an ordinary chat');
  ledger.append({...live(chat.id,'dispatched-run'),trigger:'task',agent:'CTO'});
  assert.deepEqual(ledger.list({chatIds:[chat.id]}).map(e=>`${e.source}:${e.agent}`),['local:CTO'],'the live task Receipt stands alone');
  db.exec('DELETE FROM turn_ledger_backfill');
  await importLedgerHistory(db,ledger);
  assert.deepEqual(ledger.list({chatIds:[chat.id]}).map(e=>e.source),['local'],'a task chat is skipped by the backfill');
  void runId;
});

test('imported Paperclip activity shows once per run as imported history',async t=>{
  const {db,ledger}=await fixture(t);
  const imports=new SqliteImportStore(db);
  imports.setMap('task','i-1','task-1','RAG-1',{projectId:'proj-1'});
  imports.addComment({sourceId:'c1',taskId:'task-1',authorKind:'agent',authorLabel:'CTO',body:'Working',createdAt:'2026-09-20T10:00:00.000Z',runId:'run-9'});
  imports.addComment({sourceId:'c2',taskId:'task-1',authorKind:'agent',authorLabel:'CTO',body:'Done',createdAt:'2026-09-20T10:05:00.000Z',runId:'run-9'});
  imports.addComment({sourceId:'c3',taskId:'task-1',authorKind:'user',authorLabel:'You',body:'Thanks',createdAt:'2026-09-20T10:06:00.000Z',runId:null});
  assert.deepEqual(await importLedgerHistory(db,ledger),{chats:0,turns:1});
  const [entry]=ledger.list({projectId:'proj-1'});
  assert.equal(entry.source,'history');assert.equal(entry.id,'history:paperclip:run-9');assert.equal(entry.agent,'CTO');assert.equal(entry.taskId,'task-1');assert.equal(entry.durationMs,300_000);
  assert.deepEqual(await importLedgerHistory(db,ledger),{chats:0,turns:0});
});

test('turn splitting and receipt matching hold for same-millisecond sends and retries',()=>{
  const at='2026-09-01T00:00:00.000Z',later='2026-09-01T00:10:00.000Z';
  const turns=splitTurns([{id:'u1',kind:'user',created_at:at,type:null,server:null,tool:null,command:null},{id:'x',kind:'assistant',created_at:at,type:null,server:null,tool:null,command:null},{id:'u2',kind:'user',created_at:at,type:null,server:null,tool:null,command:null}]);
  assert.equal(turns.length,2);
  assert.deepEqual(matchReceipts(turns,[{run_id:'r1',created_at:at},{run_id:'r2',created_at:at},{run_id:'retry',created_at:later}]),[['r1'],['r2','retry']]);
});
