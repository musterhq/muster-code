import assert from 'node:assert/strict';
import {test} from 'node:test';
import {captureAnchor,isAtBottom,rememberPosition,recallPosition,resolveAnchorIndex} from '../src/renderer/components/chatContinuity.ts';
test('reading anchor survives inserted earlier rows and respects the tail threshold',()=>{
 const anchor=captureAnchor([{key:'a',start:0,end:100},{key:'b',start:100,end:220}],145)!;
 assert.deepEqual(anchor,{itemId:'b',offset:45});
 assert.equal(resolveAnchorIndex(anchor,[{id:'new'},{id:'a'},{id:'b'}]),2);
 assert.equal(resolveAnchorIndex(anchor,[{id:'a'}]),-1);
 assert.equal(isAtBottom(400,1000,500),false);assert.equal(isAtBottom(480,1000,500),true);
 rememberPosition('one',anchor);rememberPosition('two',null);
 assert.deepEqual(recallPosition('one'),anchor);assert.equal(recallPosition('two'),null);
 for(let i=0;i<101;i++)rememberPosition('bounded'+i,null);
 assert.equal(recallPosition('one'),undefined);
});
