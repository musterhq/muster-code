import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appendCommandOutput,finishCommandOutput,MAX_COMMAND_OUTPUT} from '../src/runtime/command-output-buffer.ts';
test('keeps complete stream when final event is merely its suffix, without duplication',()=>{
 const a=appendCommandOutput({output:'',truncated:false},'first\n');
 const b=appendCommandOutput(a,'last\n');
 assert.deepEqual(finishCommandOutput(b,'last\n'),{output:'first\nlast\n',truncated:false});
 assert.deepEqual(finishCommandOutput(b,null),b);
 assert.equal(finishCommandOutput({output:'last\n',truncated:false},'first\nlast\n').output,'first\nlast\n');
});
test('streaming and completion retain identical bounded tails with explicit truncation',()=>{
 const big='a'.repeat(MAX_COMMAND_OUTPUT)+'final';
 const streamed=appendCommandOutput({output:'start',truncated:false},big);
 const completed=finishCommandOutput({output:'',truncated:false},'start'+big);
 assert.deepEqual(streamed,completed);assert.equal(streamed.output.length,MAX_COMMAND_OUTPUT);assert.equal(streamed.truncated,true);assert.ok(streamed.output.endsWith('final'));
 assert.equal(finishCommandOutput(streamed,'final').truncated,true);
});
