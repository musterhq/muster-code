import test from 'node:test';
import assert from 'node:assert/strict';
import {freshnessAfterProbe,isTransportFailure,markTransportOffline,nextTransport,recordTransport,resetTransportHealth,streamPresence,subscribeTransport,transportHealth} from '../src/renderer/connectionHealth.ts';

test('PER-14: a quiet provider on a healthy transport is "waiting", never "reconnecting"',()=>{
  assert.equal(streamPresence({transport:'connected',freshness:'live',stalled:true}),'waiting');
  assert.equal(streamPresence({transport:'connected',freshness:'live',stalled:false}),'live');
  assert.equal(streamPresence({transport:'connected',freshness:'stale',stalled:true}),'syncing','missed events resync; they are not a transport fault');
  assert.equal(streamPresence({transport:'reconnecting',freshness:'live',stalled:true}),'reconnecting');
  assert.equal(streamPresence({transport:'offline',freshness:'stale',stalled:false}),'offline');
});

test('PER-14: healthy socket, failed subscription: a probe finds the newer revision and marks the view stale (resync), not reconnecting',()=>{
  assert.equal(freshnessAfterProbe(10,14),'stale');
  assert.equal(freshnessAfterProbe(14,14),'live');
  assert.equal(freshnessAfterProbe(undefined,1),'stale');
});

test('PER-14: only channel failures move transport health; command errors do not',()=>{
  resetTransportHealth();
  let notified=0;const off=subscribeTransport(()=>notified++);
  recordTransport({ok:false,error:new Error('Project not found.')});
  assert.equal(transportHealth().state,'connected');assert.equal(notified,0);
  assert.equal(isTransportFailure(new Error("Error invoking remote method 'agent:invoke': Error: No handler registered for 'agent:invoke'")),true);
  recordTransport({ok:false,error:new Error('Timeline probe timed out')});
  assert.equal(transportHealth().state,'reconnecting');
  recordTransport({ok:false,error:new Error('Object has been destroyed')});
  recordTransport({ok:false,error:new Error('Object has been destroyed')});
  assert.equal(transportHealth().state,'offline');
  recordTransport({ok:true});
  assert.equal(transportHealth().state,'connected');assert.equal(transportHealth().failures,0);
  markTransportOffline('Agent runtime is not connected');assert.equal(transportHealth().state,'offline');
  assert.equal(notified,5,"each distinct health change notifies once");
  off();resetTransportHealth();
  assert.deepEqual(nextTransport({state:'connected',failures:0,lastOkAt:1},{ok:false,at:2,error:'x'}),{state:'reconnecting',failures:1,lastOkAt:1,lastError:'x'});
});
