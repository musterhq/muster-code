// #371 part 1: images the chat named are visible (thumbnails), and a vision model receives them.
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,mkdir,rm,symlink,truncate,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readChatImage,MAX_CHAT_IMAGE_BYTES} from '../src/runtime/file-assets.ts';
import {AgentStore} from '../src/runtime/store.ts';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';
import {executeTool,type ToolContext} from '../src/runtime/adapters/http-tools.ts';
import {entryAcceptsImages,fetchModelList,openAICompatibleAdapter} from '../src/runtime/adapters/http-chat.ts';
import {catalogModels,routerAgents} from '../src/runtime/provider-instances.ts';
import type {AdapterRunInput} from '../src/runtime/adapters/types.ts';

async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-img371-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
function png(width=4,height=3){
  const data=Buffer.alloc(33+12);Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(data);
  data.writeUInt32BE(13,8);data.write('IHDR',12,'latin1');data.writeUInt32BE(width,16);data.writeUInt32BE(height,20);data[24]=8;
  data.writeUInt32BE(0,33);data.write('IEND',37,'latin1');return data;
}
const info:ProviderAdapter['info']=()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'m',name:'M'}]}];

test('readChatImage: reads a real image from any absolute path, never a non-image, an oversize file or a mislabelled one',async t=>{
  const dir=await directory(t);
  await writeFile(join(dir,'shot.png'),png(7,5));
  const asset=await readChatImage(join(dir,'shot.png'));
  assert.equal(asset.mime,'image/png');assert.equal(asset.width,7);assert.equal(asset.height,5);assert.ok(asset.dataUrl.startsWith('data:image/png;base64,'));
  await writeFile(join(dir,'notes.txt'),'secret');
  await assert.rejects(readChatImage(join(dir,'notes.txt')),/Unsupported image type/);
  await writeFile(join(dir,'fake.png'),'not an image at all, just text');
  await assert.rejects(readChatImage(join(dir,'fake.png')),/Not a supported raster image/);
  await writeFile(join(dir,'big.png'),png());await truncate(join(dir,'big.png'),MAX_CHAT_IMAGE_BYTES+1);
  await assert.rejects(readChatImage(join(dir,'big.png')),/exceeds 20 MiB/);
  await assert.rejects(readChatImage(dir),/Unsupported image type/,'a directory is never listed or read');
  await mkdir(join(dir,'folder.png'));
  await assert.rejects(readChatImage(join(dir,'folder.png')));
  await assert.rejects(readChatImage('relative/shot.png'),/absolute/);
  await writeFile(join(dir,'clip.mp4'),Buffer.alloc(64));
  await assert.rejects(readChatImage(join(dir,'clip.mp4')),/Unsupported image type/,'no audio or video through this route');
  try{await symlink(join(dir,'notes.txt'),join(dir,'link.png'));await assert.rejects(readChatImage(join(dir,'link.png')));}catch(error){if((error as NodeJS.ErrnoException).code!=='EPERM')throw error;}
});

test('files.chatImage reads only paths this chat\'s own rows named',async t=>{
  const dataDir=await directory(t),pictures=await directory(t);
  const shot=join(pictures,'evidence.png'),other=join(pictures,'private.png');
  await writeFile(shot,png());await writeFile(other,png());
  let agent=createAgentService({dataDir,provider:{info,run:async()=>({status:'completed',finalMessage:''}),stop:async()=>true,dispose(){}},onEvent(){}});
  const chat=await agent.invoke('chat.create',{}),stranger=await agent.invoke('chat.create',{});
  await agent.dispose();
  const store=new AgentStore(dataDir);
  store.appendItem(chat.id,'tool','',  'completed',{type:'imageView',path:shot});
  store.appendItem(chat.id,'user',`please look at ${other}`);
  assert.equal(store.chatMentionsPath(chat.id,shot),true);
  assert.equal(store.chatMentionsPath(chat.id,other),false,'what the user typed is not a tool row');
  assert.equal(store.chatMentionsPath(stranger.id,shot),false,'another chat\'s rows do not count');
  store.close();
  agent=createAgentService({dataDir,provider:{info,run:async()=>({status:'completed',finalMessage:''}),stop:async()=>true,dispose(){}},onEvent(){}});
  assert.equal((await agent.invoke('files.chatImage',{chatId:chat.id,path:shot})).width,4);
  await assert.rejects(agent.invoke('files.chatImage',{chatId:chat.id,path:other}),/not part of this chat/);
  await assert.rejects(agent.invoke('files.chatImage',{chatId:stranger.id,path:shot}),/not part of this chat/);
  await assert.rejects(agent.invoke('files.chatImage',{chatId:chat.id,path:'/etc/passwd'}),/not part of this chat/);
  await agent.dispose();
});

const ctx=(cwd:string,extra:Partial<ToolContext>={}):ToolContext=>({cwd,access:'full',signal:new AbortController().signal,emit(){},threadId:'t',turnId:'u',...extra});
const call=(path:string,id='1')=>({id,name:'read_file',arguments:JSON.stringify({path})});

test('HTTP read_file of an image returns an image part for a vision model and a plain, single notice otherwise',async t=>{
  const dir=await directory(t);await writeFile(join(dir,'a.png'),png());await writeFile(join(dir,'b.png'),png());
  const seen=await executeTool(call(join(dir,'a.png')),ctx(dir,{vision:true}));
  assert.equal(seen.ok,true);assert.equal(seen.image?.mediaType,'image/png');assert.equal(Buffer.from(seen.image!.data,'base64').length,png().length);
  const note={told:false};
  const first=await executeTool(call(join(dir,'a.png')),ctx(dir,{visionNote:note}));
  assert.equal(first.ok,false);assert.equal(first.image,undefined);assert.match(first.content,/cannot see images/);
  const second=await executeTool(call(join(dir,'b.png')),ctx(dir,{visionNote:note}));
  assert.ok(second.content.length<first.content.length,'the explanation is given once; later reads are brief');
  await writeFile(join(dir,'lie.png'),'plain text');
  assert.equal((await executeTool(call(join(dir,'lie.png')),ctx(dir,{vision:true}))).ok,false,'a text file named .png is not sent as an image');
  await writeFile(join(dir,'big.png'),png());await truncate(join(dir,'big.png'),9*1024*1024);
  assert.match((await executeTool(call(join(dir,'big.png')),ctx(dir,{vision:true}))).content,/not sent to the model/);
});

test('the OpenAI-compatible route sends the picture as an image_url part after the tool reply',async t=>{
  const dir=await directory(t);await writeFile(join(dir,'a.png'),png());
  const bodies:any[]=[];
  const sse=(delta:object)=>new Response(`data: ${JSON.stringify({choices:[{delta}]})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
  const adapter=openAICompatibleAdapter({endpoint:'http://router.test/v1',apiKey:()=>'k',label:'Router',fetch:(async(_url:string,init:RequestInit)=>{
    bodies.push(JSON.parse(String(init.body)));
    return bodies.length===1?sse({tool_calls:[{index:0,id:'c1',function:{name:'read_file',arguments:JSON.stringify({path:join(dir,'a.png')})}}]}):sse({content:'I can see it'});
  }) as typeof fetch});
  const run=(vision:boolean)=>adapter.run({chat:{id:'c'} as never,cwd:dir,prompt:'look',model:'m',permissionMode:'full',signal:new AbortController().signal,...(vision?{vision:true}:{}),onThreadReady(){},onTurnAccepted(){},onDelta(){},onReasoning(){},onEvent(){}} as AdapterRunInput);
  assert.equal((await run(true)).status,'completed');
  const second=bodies[1].messages;
  const tool=second.findIndex((m:any)=>m.role==='tool');
  assert.equal(second[tool+1].role,'user');
  assert.equal(second[tool+1].content[1].type,'image_url');assert.match(second[tool+1].content[1].image_url.url,/^data:image\/png;base64,/);
  bodies.length=0;
  assert.equal((await run(false)).status,'completed');
  assert.ok(!JSON.stringify(bodies[1].messages).includes('image_url'),'a model without vision gets no picture');
  assert.match(bodies[1].messages.find((m:any)=>m.role==='tool').content,/cannot see images/);
});

test('gateway models report image input from modalities or capabilities.vision',async()=>{
  assert.equal(entryAcceptsImages({input_modalities:['text','image']}),true);
  assert.equal(entryAcceptsImages({input_modalities:['text']}),false);
  assert.equal(entryAcceptsImages({capabilities:{vision:true}}),true);
  assert.equal(entryAcceptsImages({capabilities:{vision:false}}),false);
  assert.equal(entryAcceptsImages({modalities:{input:['text','image']}}),true);
  assert.equal(entryAcceptsImages({id:'x'}),undefined);
  const {models}=catalogModels('gateway',[{slug:'a',input_modalities:['text','image']},{slug:'b',capabilities:{vision:true}},{slug:'c',input_modalities:['text']},{slug:'d'}]);
  assert.deepEqual(models.map(m=>m.images),[true,true,false,undefined]);
  const listed=await fetchModelList('http://router.test/v1/models',{},'Router',(async()=>new Response(JSON.stringify({data:[
    {id:'intelligent-planner',owned_by:'combo',input_modalities:['text','image'],capabilities:{vision:true}},{id:'text-only',owned_by:'combo',capabilities:{vision:false}},{id:'unknown',owned_by:'combo'}]})))as typeof fetch);
  assert.deepEqual(routerAgents(listed).map(m=>[m.id,m.images]),[['intelligent-planner',true],['text-only',false],['unknown',undefined]]);
});
