import assert from 'node:assert/strict';
import test from 'node:test';
import {fetchModelList,listChatModels} from '../src/runtime/adapters/http-chat.ts';
import {routerAgents} from '../src/runtime/provider-instances.ts';

const body={data:[
  {id:'intelligent-planner',owned_by:'combo',output_modalities:['text'],capabilities:{tool_calling:true}},
  {id:'auto/best-coding',owned_by:'combo'},
  {id:'smol',owned_by:'combo',display_name:'Smol'},
  {id:'codex/gpt-6-sol',owned_by:'codex'},
  {id:'aihorde/AnyLoRA',owned_by:'aihorde',type:'image',output_modalities:['image']},
  {id:'whisper',owned_by:'openai',type:'audio'},
  {id:'no-tools',owned_by:'x',capabilities:{tool_calling:false}},
]};
const fake=(async()=>new Response(JSON.stringify(body),{status:200})) as typeof fetch;

test('a /models listing keeps owner and tells chat models from image, audio and tool-less ones', async () => {
  const listed=await fetchModelList('https://r/v1/models',{},'Router',fake);
  assert.deepEqual(listed.map(m=>[m.id,m.owner,m.chat]),[['intelligent-planner','combo',true],['auto/best-coding','combo',true],['smol','combo',true],['codex/gpt-6-sol','codex',true],['aihorde/AnyLoRA','aihorde',false],['whisper','openai',false],['no-tools','x',false]]);
  assert.deepEqual((await listChatModels('https://r/v1/models',{},'Router',fake)).map(m=>m.id),['intelligent-planner','auto/best-coding','smol','codex/gpt-6-sol']);
});

test('router agents and combos are offered with readable names', async () => {
  const agents=routerAgents(await fetchModelList('https://r/v1/models',{},'Router',fake));
  assert.deepEqual(agents,[{id:'intelligent-planner',name:'Intelligent planner'},{id:'smol',name:'Smol'},{id:'auto/best-coding',name:'Auto · best coding'}],'named agents first');
});
