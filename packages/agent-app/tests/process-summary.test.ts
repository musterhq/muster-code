import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {getProcessSummaryState,subscribeProcessSummary,refreshProcessSummary} from '../src/renderer/processSummary.ts';
import type {ProcessSummarySnapshot} from '../src/shared/process-protocol.ts';

test('many consumers share one metadata-only subscription; initial/read races and cleanup are safe',async()=>{
  const global=globalThis as any,prior=global.window;
  let eventListener:((event:any)=>void)|undefined,subscribed=0,unsubscribed=0;
  const calls:string[]=[],reads:{resolve:(value:ProcessSummarySnapshot)=>void;reject:(error:Error)=>void}[]=[];
  global.window={muster:{subscribe(listener:(event:any)=>void){subscribed++;eventListener=listener;return()=>{unsubscribed++;eventListener=undefined;};},invoke(command:string){calls.push(command);return new Promise((resolve,reject)=>reads.push({resolve,reject}));}}};
  const sample=(revision:number,status:'running'|'exited'='running'):ProcessSummarySnapshot=>({revision,sessions:[{chatId:'chat',processId:'process:one',label:'Test command',purpose:'test',status,startedAt:'',updatedAt:''}]});
  const releases:(()=>void)[]=[];
  try{
    for(let index=0;index<20;index++)releases.push(subscribeProcessSummary(()=>{}));
    assert.equal(subscribed,1);assert.deepEqual(calls,['processes.summary']);
    eventListener!({type:'processMetadata',summary:sample(3,'exited')});
    reads[0].resolve(sample(1));await delay(0);
    assert.equal(getProcessSummaryState().summary?.sessions[0].status,'exited');
    assert.equal(getProcessSummaryState().summary?.revision,3);
    eventListener!({type:'processMetadata',summary:{revision:4,sessions:[]}});
    eventListener!({type:'processMetadata',summary:sample(2)});
    assert.deepEqual(getProcessSummaryState().summary?.sessions,[]);
    refreshProcessSummary();eventListener!({type:'processMetadata',summary:sample(6)});
    reads[1].reject(new Error('older failed read'));await delay(0);
    assert.equal(getProcessSummaryState().error,false);
    eventListener!({type:'snapshot'});assert.equal(calls.length,3);
    for(const release of releases.splice(0,19))release();assert.equal(unsubscribed,0);
    releases.pop()!();assert.equal(unsubscribed,1);
    reads[2].resolve(sample(100));await delay(0);assert.equal(getProcessSummaryState().summary,null);
    releases.push(subscribeProcessSummary(()=>{}));assert.equal(subscribed,2);assert.equal(calls.length,4);
    reads[3].resolve(sample(7));await delay(0);assert.equal(getProcessSummaryState().summary?.revision,7);
    assert.ok(calls.every(command=>command==='processes.summary'),'no process output attachment or launch');
  }finally{for(const release of releases)release();global.window=prior;}
});
