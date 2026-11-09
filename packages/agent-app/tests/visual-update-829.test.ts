/** #829 part 2: the agent updates a visual in place. render_html takes `replaces` (the reference of a page shown earlier in
 *  the chat); the new page becomes the next version of the canvas linked to that page (the model part 1 made for the user's
 *  edits), so the card shows it instead of a new card appearing. Another chat's page, or one that does not exist, is refused. */
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import {BrowserBridge} from '../src/main/agent-tools/browser-bridge.ts';
import {HtmlRenderStore} from '../src/main/agent-tools/html-render-store.ts';
import {BROWSER_TOOL_SPECS} from '../src/main/agent-tools/browser-tools.ts';
import {htmlRenderIdOf,htmlRenderUpdateOf} from '../src/shared/html-render.ts';
import {classifyTool} from '../src/renderer/components/toolPresentation.ts';
import {groupActivity,type TranscriptEntry} from '../src/renderer/components/activityGrouping.ts';
import {createTimelineProjection} from '../src/renderer/components/timeline-navigation-model.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';
import type {Canvas,CanvasSummary,CanvasVersion} from '../src/shared/domains/artifacts-protocol.ts';
import type {TimelineItem} from '../src/shared/protocol.ts';

const provider:ProviderAdapter={info:()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture'}]}],run:async()=>({status:'completed',finalMessage:'ok'}),stop:async()=>true,dispose(){}};
async function directory(t:TestContext,prefix='muster-visual-update-'){const path=await mkdtemp(join(tmpdir(),prefix));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
type Service=ReturnType<typeof createAgentService>;
const call=<T>(service:Service,command:string,input?:unknown)=>(service.invoke as unknown as (c:string,i:unknown)=>Promise<T>)(command,input);
const text=(result:{content:Array<{type:string;text?:string}>})=>result.content.map(part=>part.text??'').join('\n');
const refOf=(value:string)=>/muster-html:([a-f0-9]{32})/.exec(value)?.[1];
const row=(result:{content:Array<{type:string;text?:string}>})=>({type:'mcpToolCall',server:'muster_browser',tool:'render_html',result:{content:[{type:'text',text:text(result)}]}});

/** The bridge as main wires it: pages in their store, versions through the runtime's artifacts domain. */
async function setup(t:TestContext,options:{provider?:ProviderAdapter}={}){
  const dataDir=await directory(t);
  const events:Array<{type:string;canvas?:CanvasSummary}>=[];
  const service=createAgentService({dataDir,provider:options.provider??provider,onEvent(event){events.push(event as never);}});
  t.after(()=>service.dispose());
  const first=await service.invoke('chat.create',{}),second=await service.invoke('chat.create',{});
  const renders=new HtmlRenderStore(join(dataDir,'html-renders'));
  const browser={agentOpen:()=>({}) as never,hasTab:()=>false,agentPage:()=>({}) as never,back:()=>({}) as never,reload:()=>({}) as never,console:()=>[],frame:async()=>undefined};
  const bridge=new BrowserBridge({dir:join(dataDir,'agent-tools'),browser,execPath:'/usr/bin/env',script:'/x/browser-mcp.cjs',emit(){},lease:async()=>'agent',renders,
    updateVisual:input=>call(service,'artifacts.visual.agentUpdate',input),
    snapshot:async()=>({chats:[first,second].map(chat=>({...chat,mode:'agent',permissionMode:'workspace'})),folders:[],projects:[],version:1}) as never});
  return {service,bridge,renders,events,first,second,dataDir};
}
const pageCanvas=async(service:Service,chatId:string)=>(await call<{canvases:CanvasSummary[]}>(service,'artifacts.canvas.list',{chatId})).canvases.filter(canvas=>canvas.visual?.kind==='page');

// Spec: MUS-SPEC-21-829H (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-829h)
test('the agent updates a page in place: one canvas holds every version, the user\'s edits included',async t=>{
  const {service,bridge,renders,events,first}=await setup(t);
  const shown=await bridge.call(first.id,'render_html',{title:'Revenue',html:'<h1>Revenue</h1>'});
  const original=refOf(text(shown))!;
  assert.ok(original,'the first page answers with its reference');

  const updated=await bridge.call(first.id,'render_html',{title:'Revenue by region',html:'<h1>Revenue by region</h1>',replaces:`muster-html:${original}`});
  assert.notEqual(updated.isError,true,text(updated));
  assert.match(text(updated),new RegExp(`muster-html-update:${original}`),'the answer marks an update of the original page');
  assert.equal(htmlRenderIdOf(row(updated)),undefined,'no tool row draws the update as a second card');
  assert.equal(htmlRenderUpdateOf(row(updated)),original,'the row names the page it updated');
  assert.equal(htmlRenderIdOf(row(shown)),original,'the original row still draws its card');

  const [canvas]=await pageCanvas(service,first.id);
  assert.ok(canvas,'the page has a linked canvas');
  assert.deepEqual(canvas!.visual,{kind:'page',key:`page:${original}`});
  assert.equal(canvas!.kind,'html');assert.equal(canvas!.version,2);assert.equal(canvas!.updatedBy,'agent');assert.equal(canvas!.title,'Revenue by region');
  const versions=(await call<{versions:CanvasVersion[]}>(service,'artifacts.canvas.versions',{id:canvas!.id})).versions;
  assert.deepEqual(versions.map(version=>[version.version,version.author]),[[2,'agent'],[1,'agent']]);
  assert.equal((await call<{content:string}>(service,'artifacts.canvas.version',{id:canvas!.id,version:1})).content,'<h1>Revenue</h1>','version 1 is the original page');
  const newer=refOf(versions[0]!.note??'');
  assert.ok(newer&&newer!==original,'version 2 names the stored page it came from');
  assert.equal(renders.get(newer)!.html,'<h1>Revenue by region</h1>');
  assert.equal(renders.get(newer)!.chatId,first.id);
  assert.ok(events.some(event=>event.type==='canvasChanged'&&event.canvas?.id===canvas!.id),'the card hears about it');

  // The user edits it (part 1's Save), then the agent updates again through the newer page's reference.
  const edit=await call<{conflict:boolean;canvas:Canvas}>(service,'artifacts.canvas.update',{id:canvas!.id,content:'<h1>Revenue (mine)</h1>',baseVersion:2,note:'Edited in the chat'});
  assert.equal(edit.canvas.version,3);
  const again=await bridge.call(first.id,'render_html',{title:'Revenue by region',html:'<h1>Revenue, final</h1>',replaces:`muster-html:${newer}`});
  assert.notEqual(again.isError,true,text(again));
  assert.match(text(again),new RegExp(`muster-html-update:${original}`),'any version\'s reference reaches the original page');
  const after=await pageCanvas(service,first.id);
  assert.equal(after.length,1,'still one canvas for the page');
  assert.equal(after[0]!.version,4);
  const all=(await call<{versions:CanvasVersion[]}>(service,'artifacts.canvas.versions',{id:canvas!.id})).versions;
  assert.deepEqual(all.map(version=>[version.version,version.author]),[[4,'agent'],[3,'user'],[2,'agent'],[1,'agent']],'the user\'s edit keeps its place in the sequence');
  assert.equal((await call<Canvas>(service,'artifacts.canvas.get',{id:canvas!.id})).content,'<h1>Revenue, final</h1>');
});

// Spec: MUS-SPEC-21-829I (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-829i)
test('updating a page from another chat, or one that does not exist, is refused',async t=>{
  const {service,bridge,first,second,dataDir}=await setup(t);
  const theirs=refOf(text(await bridge.call(second.id,'render_html',{title:'Theirs',html:'<p>theirs</p>'})))!;
  const count=()=>readdirSync(join(dataDir,'html-renders')).filter(name=>name.endsWith('.json')).length;
  const before=count();

  const foreign=await bridge.call(first.id,'render_html',{title:'Mine',html:'<p>x</p>',replaces:`muster-html:${theirs}`});
  assert.equal(foreign.isError,true);
  assert.match(text(foreign),/another chat/i);assert.match(text(foreign),/this chat/i);
  const missing=await bridge.call(first.id,'render_html',{title:'Mine',html:'<p>x</p>',replaces:`muster-html:${'0'.repeat(32)}`});
  assert.equal(missing.isError,true);
  assert.match(text(missing),/no page/i);assert.match(text(missing),/without `?replaces`?/);
  const malformed=await bridge.call(first.id,'render_html',{title:'Mine',html:'<p>x</p>',replaces:'the revenue page'});
  assert.equal(malformed.isError,true);
  assert.match(text(malformed),/muster-html:/,'says what a reference looks like');

  assert.equal(count(),before,'no page was stored');
  assert.equal((await pageCanvas(service,first.id)).length,0);
  assert.equal((await pageCanvas(service,second.id)).length,0,'the other chat\'s page is untouched');
});

// Spec: MUS-SPEC-21-829J (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-829j)
test('an update reads as a compact Updated row and the page is not drawn twice',()=>{
  const at='2026-11-09T10:00:00Z',id='0123456789abcdef0123456789abcdef';
  const plain=(key:string,kind:TimelineItem['kind']):TimelineItem=>({id:key,kind,text:key,chatId:'chat',createdAt:at});
  const command=(key:string):TimelineItem=>({...plain(key,'tool'),status:'completed',data:{type:'commandExecution',command:'ls',exitCode:0}});
  const shown:TimelineItem={...plain('p1','tool'),status:'completed',data:{type:'mcpToolCall',server:'muster_browser',tool:'render_html',arguments:{title:'Revenue',html:'<p>a</p>'},
    result:`Shown to the user inline as “Revenue” (muster-html:${id}). It has no network access.`}};
  const updateData={type:'mcpToolCall',server:'muster_browser',tool:'render_html',arguments:{title:'Revenue by region',html:'<p>b</p>',replaces:`muster-html:${id}`}};
  const running:TimelineItem={...plain('p2','tool'),status:'inProgress',data:updateData};
  const updated:TimelineItem={...plain('p2','tool'),status:'completed',data:{...updateData,
    result:`Updated “Revenue by region” in place (muster-html-update:${id}): the card shows it as version 2. To change it again, pass replaces: "muster-html:${id}".`}};

  const live=classifyTool(running.data);
  assert.equal(live.runningVerb,'Updating');assert.equal(live.subject,'Revenue by region');
  const done=classifyTool(updated.data);
  assert.equal(done.verb,'Updated');assert.equal(done.subject,'Revenue by region');
  assert.equal(done.htmlRender?.id,undefined,'the update row draws no page of its own');
  assert.equal(classifyTool(shown.data).htmlRender?.id,id,'the original row still draws the page');

  const turn=[plain('u1','user'),shown,command('t1'),updated,plain('a1','assistant')];
  const shape=(rows:readonly TranscriptEntry[])=>rows.map(entry=>entry.kind==='activity'?`${'visual' in entry&&entry.visual?'visual':'activity'}[${entry.items.map(item=>item.id).join(',')}]`:entry.id);
  assert.deepEqual(shape(groupActivity(turn)),['u1','visual[p1]','activity[t1,p2]','a1'],'the update groups with the tools around it');
  assert.deepEqual(shape(createTimelineProjection()(turn).rows),['u1','visual[p1]','activity[t1,p2]','a1'],'and the same in the live chat view');
});

// Spec: MUS-SPEC-21-829L (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-829l)
test('agents are told about replaces, and the next turn carries only the user\'s edits',async t=>{
  const tool=BROWSER_TOOL_SPECS.find(spec=>spec.name==='render_html')!;
  assert.match(tool.description,/replaces/,'the tool description says how to update a page');
  assert.ok((tool.inputSchema as {properties:Record<string,unknown>}).properties.replaces,'and the schema takes it');
  const skill=readFileSync(new URL('../resources/skills/visualize/SKILL.md',import.meta.url),'utf8');
  assert.match(skill,/`replaces`/,'Muster\'s visualize skill says it too');

  const prompts:string[]=[];
  const recording:ProviderAdapter={...provider,run:async(input:{prompt:string})=>{prompts.push(input.prompt);return {status:'completed',finalMessage:'ok'};}} as ProviderAdapter;
  const {service,bridge,first}=await setup(t,{provider:recording});
  const original=refOf(text(await bridge.call(first.id,'render_html',{title:'Revenue',html:'<h1>Revenue</h1>'})))!;
  assert.notEqual((await bridge.call(first.id,'render_html',{title:'Revenue',html:'<h1>Revenue v2</h1>',replaces:`muster-html:${original}`})).isError,true);
  const send=async(textValue:string)=>{const before=prompts.length;await service.invoke('chat.send',{id:first.id,text:textValue,requestId:`send-${before}`} as never);for(let i=0;i<300&&prompts.length===before;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(prompts.length,before+1,'the turn was sent');return prompts.at(-1)!;};
  assert.doesNotMatch(await send('Thanks.'),/source="visual-edits"/,'the agent wrote the newest version itself');
  const [canvas]=await pageCanvas(service,first.id);
  await call(service,'artifacts.canvas.update',{id:canvas!.id,content:'<h1>Revenue (mine)</h1>',baseVersion:canvas!.version});
  const next=await send('Use my version.');
  assert.match(next,/<context source="visual-edits">[\s\S]*Revenue \(mine\)/,'a user edit after the update is carried');
});
