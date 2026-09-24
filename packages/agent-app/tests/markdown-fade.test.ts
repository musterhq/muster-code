import assert from 'node:assert/strict';
import test from 'node:test';
import type {Root} from 'hast';
import {advanceFade,createFadeState,fadePieces,rehypeStreamFade} from '../src/renderer/markdown-fade.ts';

const text=(value:string,start:number)=>({type:'text' as const,value,position:{start:{line:1,column:start+1,offset:start},end:{line:1,column:start+value.length+1,offset:start+value.length}}});
const run=(tree:Root,state:ReturnType<typeof createFadeState>|null)=>{rehypeStreamFade(()=>state)()(tree);return tree;};
const spans=(tree:Root)=>JSON.stringify(tree).match(/"md-fade"/g)?.length??0;

test('growth appends stretches; an edit or replacement resets, and text from the first render never fades', () => {
  let state=createFadeState('Hello');
  assert.equal(advanceFade(state,'Hello'),state,'the same text is a no-op (StrictMode double render)');
  state=advanceFade(state,'Hello wor');
  state=advanceFade(state,'Hello world.');
  assert.deepEqual(state.starts,[5,9]);
  assert.equal(state.base,5);
  assert.deepEqual(fadePieces(0,12,state),[{from:0,to:5,fade:false},{from:5,to:9,fade:true},{from:9,to:12,fade:true}]);
  const edited=advanceFade(state,'Goodbye');
  assert.deepEqual(edited,{base:7,starts:[],text:'Goodbye'});
  assert.deepEqual(fadePieces(0,5,createFadeState('Hello')),[{from:0,to:5,fade:false}]);
});

test('the plugin wraps only new text in spans, one per stretch, and leaves code and unmapped text alone', () => {
  let state=createFadeState('Hi');
  state=advanceFade(state,'Hi there');
  state=advanceFade(state,'Hi there, friend');
  const tree:Root={type:'root',children:[{type:'element',tagName:'p',properties:{},children:[text('Hi there, friend',0)]}]};
  run(tree,state);
  const p=tree.children[0] as any;
  assert.deepEqual(p.children.map((c:any)=>c.type==='text'?c.value:`<${c.children[0].value}>`),['Hi','< there>','<, friend>']);
  assert.equal(p.children[1].position.start.offset,2,'a span keeps the start offset of its stretch');

  const code:Root={type:'root',children:[{type:'element',tagName:'pre',properties:{},children:[{type:'element',tagName:'code',properties:{},children:[text('Hi there, friend',0)]}]}]};
  assert.equal(spans(run(code,state)),0,'code is never split');

  const escaped:Root={type:'root',children:[{type:'element',tagName:'p',properties:{},children:[{...text('Hi there',0),value:'Hi there, friend!'}]}]};
  assert.equal(spans(run(escaped,state)),0,'a node whose value does not map 1:1 onto the source is left as is');

  const off:Root={type:'root',children:[{type:'element',tagName:'p',properties:{},children:[text('Hi there, friend',0)]}]};
  assert.equal(spans(run(off,null)),0,'no state, no animation');
});
