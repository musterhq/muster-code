import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ProjectEventLog} from '../src/runtime/project-event-log.ts';
import {ProjectEventCursor,replayProjectEvents} from '../src/shared/project-events.ts';

test('PRJ-07: sequence numbers are per Project, durable and monotonic',()=>{
  const db=new DatabaseSync(':memory:'),log=new ProjectEventLog(db);
  assert.equal(log.append('p1','t1'),1);assert.equal(log.append('p1','t2'),2);assert.equal(log.append('p2'),1);
  assert.equal(new ProjectEventLog(db).append('p1'),3,'a new log instance (restart) continues the sequence');
  assert.equal(log.latest('p1'),3);assert.equal(log.latest('p3'),0);
  db.close();
});

test('PRJ-07: a client that missed events while disconnected replays exactly the missed ones, in order',async()=>{
  const db=new DatabaseSync(':memory:'),log=new ProjectEventLog(db),cursor=new ProjectEventCursor();
  for(let i=0;i<3;i++)log.append('p','t'+i);
  cursor.reset('p',log.latest('p'));
  // Live events apply in order; a replayed duplicate is ignored.
  assert.equal(cursor.observe('p',log.append('p','live')),'apply');
  assert.equal(cursor.observe('p',4),'duplicate');
  // Disconnected: 450 changes happen (more than one replay page).
  for(let i=0;i<450;i++)log.append('p',`offline-${i}`);
  const live=log.append('p','after-reconnect');
  assert.equal(cursor.observe('p',live),'gap','a jump in sequence reveals missed events');
  let calls=0;
  const result=await replayProjectEvents('p',cursor,async after=>{calls++;return log.since('p',after);});
  assert.equal(result.reset,false);assert.equal(result.events.length,451);
  assert.deepEqual(result.events.map(e=>e.seq),Array.from({length:451},(_,i)=>i+5),'every missed sequence, in order, no gaps');
  assert.equal(result.events[0]!.taskId,'offline-0');assert.equal(result.events.at(-1)!.taskId,'after-reconnect');
  assert.equal(calls,3,'paged at 200 per request');
  assert.equal(cursor.last('p'),live);
  assert.deepEqual(await replayProjectEvents('p',cursor,async after=>log.since('p',after)),{changed:false,reset:false,events:[]});
  db.close();
});

test('PRJ-07: a cursor older than the retained window (or ahead of the server) resets to a snapshot reload',async()=>{
  const db=new DatabaseSync(':memory:'),log=new ProjectEventLog(db,100),cursor=new ProjectEventCursor();
  log.append('p');cursor.reset('p',1);
  for(let i=0;i<400;i++)log.append('p');
  const stale=log.since('p',1);
  assert.equal(stale.reset,true);assert.equal(stale.latest,401);
  const result=await replayProjectEvents('p',cursor,async after=>log.since('p',after));
  assert.equal(result.reset,true);assert.equal(result.changed,true);assert.equal(cursor.last('p'),401);
  assert.equal(log.since('p',999).reset,true,'a cursor from another database never silently applies');
  assert.throws(()=>log.since('p',-1),/Invalid event cursor/);
  db.close();
});
