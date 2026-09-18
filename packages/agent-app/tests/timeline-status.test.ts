import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';

test('reasoning is sealed before prose and failed commands retain their failure status', async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'muster-status-'));
 const provider:ProviderAdapter={info:()=>[{id:'test',name:'test',available:true,identityMasked:'test',models:[]}],stop:async()=>true,dispose(){},async run(input){
   input.onReasoning('Checking the file.');input.onDelta('I will inspect it.');
   input.onEvent('item/started',{item:{id:'command1',type:'commandExecution',command:'false'}});
   input.onEvent('item/completed',{item:{id:'command1',type:'commandExecution',command:'false',exitCode:1,aggregatedOutput:'failed'}});
   input.onDelta('The command failed.');return {status:'completed',finalMessage:'The command failed.'};
 }};
 const service=createAgentService({dataDir,provider,onEvent(){}});
 t.after(async()=>{await service.dispose();await rm(dataDir,{recursive:true,force:true});});
 const chat=await service.invoke('chat.create',{});
 await service.invoke('chat.send',{id:chat.id,text:'Inspect',requestId:'status_test'});
 for(let i=0;i<30;i++){const snapshot=await service.invoke('app.snapshot',undefined);if(snapshot.chats[0].status==='completed')break;await sleep(10);}
 const rows=await service.invoke('chat.select',{id:chat.id});
 assert.deepEqual(rows.map(row=>[row.kind,row.status]),[['user',undefined],['reasoning','completed'],['assistant','completed'],['tool','failed'],['assistant','completed']]);
});
