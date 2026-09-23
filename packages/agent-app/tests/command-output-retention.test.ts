import {test} from 'node:test';
import assert from 'node:assert/strict';
import {trimFinishedOutputs,MAX_FINISHED_OUTPUT_TOTAL,FINISHED_OUTPUT_TAIL,MAX_COMMAND_OUTPUT} from '../src/runtime/command-output-buffer.ts';

test('finished command output shares one budget: newest keep full tails, older keep short tails',()=>{
 const sessions=Array.from({length:32},(_,i)=>({output:'x'.repeat(MAX_COMMAND_OUTPUT-4)+`#${String(i).padStart(3,'0')}`,truncated:false,updatedAt:new Date(2026,0,1,0,i).toISOString()}));
 const trimmed=trimFinishedOutputs(sessions);
 const total=sessions.reduce((n,s)=>n+s.output.length,0);
 assert.ok(total<=MAX_FINISHED_OUTPUT_TOTAL+sessions.length*FINISHED_OUTPUT_TAIL,`total ${total}`);
 assert.ok(trimmed>0);
 const newest=sessions[31],oldest=sessions[0];
 assert.equal(newest.output.length,MAX_COMMAND_OUTPUT);assert.equal(newest.truncated,false);
 assert.equal(oldest.output.length,FINISHED_OUTPUT_TAIL);assert.equal(oldest.truncated,true);assert.ok(oldest.output.endsWith('#000'),'tail keeps the end of the output');
 assert.equal(trimFinishedOutputs(sessions),0,'idempotent once within budget');
});

test('small histories are untouched',()=>{
 const sessions=[{output:'done\n',truncated:false,updatedAt:'2026-01-01T00:00:00.000Z'}];
 assert.equal(trimFinishedOutputs(sessions),0);assert.deepEqual(sessions[0],{output:'done\n',truncated:false,updatedAt:'2026-01-01T00:00:00.000Z'});
});
