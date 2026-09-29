/** The Inbox model the sidebar badge and the Inbox page share (#189): a chat problem or wait badges only while unread,
 *  a read problem stays listed for 3 days, "interrupted" reads as a quit to continue from, and Dismiss is per item and time. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {badgeCount,buildActivity,INTERRUPTED_WHY} from '../src/renderer/inboxModel.ts';

const NOW=Date.parse('2026-09-29T12:00:00.000Z'),DAY=86_400_000;
const ago=(days:number)=>new Date(NOW-days*DAY).toISOString();
const chat=(id:string,status:string,extra:object={})=>({id,title:`Chat ${id}`,status,archived:false,updatedAt:ago(0.1),pinned:false,draft:'',model:'m',mode:'agent',...extra});
const app=(chats:object[],attention:object[]=[])=>({chats,folders:[],projects:[],attention:{totalRequests:attention.length,chats:attention}}) as any;

test('the founder’s case: a chat interrupted 5 days ago and already opened is neither listed nor badged',()=>{
  const items=buildActivity(app([chat('old','interrupted',{updatedAt:ago(5),unread:false})]),null,NOW);
  assert.deepEqual(items,[]);
  assert.equal(badgeCount(items),0);
});

test('a problem badges only while unread; once read it stays listed under Problems for 3 days, then drops off',()=>{
  const items=buildActivity(app([
    chat('failed-new','failed',{unread:true,error:'Rate limited'}),
    chat('failed-read','failed',{updatedAt:ago(1)}),
    chat('failed-old-unread','failed',{updatedAt:ago(9),unread:true}),
    chat('failed-old-read','failed',{updatedAt:ago(4)}),
  ]),null,NOW);
  assert.deepEqual(items.map(i=>i.id).sort(),['chat-problem:failed-new','chat-problem:failed-old-unread','chat-problem:failed-read']);
  assert.ok(items.every(i=>i.bucket==='problems'));
  assert.equal(badgeCount(items),2,'the two unread ones');
});

test('an interrupted turn reads as a quit to continue from, and stops badging once the chat is opened',()=>{
  const unread=buildActivity(app([chat('i','interrupted',{unread:true,error:'The provider exited.'})]),null,NOW);
  assert.equal(unread[0].why,INTERRUPTED_WHY);
  assert.equal(INTERRUPTED_WHY,'Interrupted when Muster quit — continue?');
  assert.equal(badgeCount(unread),1);
  const read=buildActivity(app([chat('i','interrupted',{updatedAt:ago(2)})]),null,NOW);
  assert.equal(read.length,1,'still listed inside the 3-day window');
  assert.equal(badgeCount(read),0);
});

test('waiting chats badge only while unread; pending approvals and questions always badge',()=>{
  const items=buildActivity(app([chat('w-read','waiting'),chat('w-new','waiting',{unread:true}),chat('ask','running')],
    [{chatId:'ask',chatTitle:'Chat ask',approvalCount:1,questionCount:0,requests:[{itemId:'x',kind:'approval',createdAt:ago(3),sourceLabel:'Provider approval'}]}]),null,NOW);
  assert.deepEqual(items.map(i=>i.id).sort(),['chat-needs:ask','chat-needs:w-new','chat-needs:w-read']);
  assert.equal(badgeCount(items),2);
});

test('Dismiss hides an item at its time only: a new failure in the same chat shows and badges again',()=>{
  const failedAt=ago(0.5),chats=[chat('c','failed',{unread:true,updatedAt:failedAt})];
  const dismissed=new Map([['chat-problem:c',failedAt]]);
  assert.deepEqual(buildActivity(app(chats),null,NOW,[],dismissed),[]);
  const again=buildActivity(app([chat('c','failed',{unread:true,updatedAt:ago(0.1)})]),null,NOW,[],dismissed);
  assert.equal(again.length,1);assert.equal(badgeCount(again),1);
  // Workspace items are dismissed the same way, by their ws: id.
  const ws={inbox:[{id:'task:t1',kind:'failed_run',title:'LP-1',why:'tests failed',severity:'high',at:failedAt,taskId:'t1',agentId:null,runId:null,group:'Launch',source:'local'}]} as any;
  assert.equal(buildActivity(app([]),ws,NOW).length,1);
  assert.equal(buildActivity(app([]),ws,NOW,[],new Map([['ws:task:t1',failedAt]])).length,0);
});
