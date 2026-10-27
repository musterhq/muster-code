// #729 (DOM): Claude Code commands and skills in the `/` picker, and plugin marks on MCP servers, apps and tool rows.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
(globalThis as any).require=require;
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
window.document.oninput=null;window.getSelection=()=>({anchorNode:null,anchorOffset:0,focusNode:null,focusOffset:0,rangeCount:0});
let focused:any=window.document.body;
Object.defineProperty(window.document,'activeElement',{get:()=>focused});
window.HTMLElement.prototype.focus=function(){focused=this;this.dispatchEvent(new window.Event('focusin',{bubbles:true}));};
window.HTMLElement.prototype.blur=function(){focused=window.document.body;};
window.HTMLElement.prototype.getBoundingClientRect=()=>({height:200,width:600,top:0,left:0,right:600,bottom:200,x:0,y:0});
window.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[this.getBoundingClientRect()];};
window.HTMLTextAreaElement.prototype.setSelectionRange=function(start:number,end:number){this.selectionStart=start;this.selectionEnd=end;};
Object.defineProperty(window.HTMLElement.prototype,'scrollHeight',{get:()=>40});
Object.defineProperty(window.HTMLElement.prototype,'clientWidth',{get:()=>600});
const style={minHeight:'26px',maxHeight:'200px',borderTopWidth:'0px',borderBottomWidth:'0px',lineHeight:'20px',paddingTop:'3px',paddingBottom:'3px',getPropertyValue:()=>'',display:'block',visibility:'visible',position:'static',overflow:'visible',animationName:'none',transitionDuration:'0s',transitionDelay:'0s',transitionProperty:'none',animationDuration:'0s',direction:'ltr',overflowX:'visible',overflowY:'visible',paddingLeft:'0px',paddingRight:'0px'};
window.getComputedStyle=()=>style;window.innerWidth=1200;window.innerHeight=800;
const memory=new Map<string,string>();
const localStorage={getItem:(key:string)=>memory.has(key)?memory.get(key)!:null,setItem:(key:string,value:string)=>{memory.set(key,String(value));},removeItem:(key:string)=>{memory.delete(key);}};
Object.assign(window,{localStorage});
Object.assign(globalThis,{window,document:window.document,Node:window.Node,HTMLElement:window.HTMLElement,HTMLButtonElement:window.HTMLButtonElement,Element:window.Element,ShadowRoot:window.ShadowRoot,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},localStorage,CustomEvent:window.CustomEvent,requestAnimationFrame:(callback:any)=>setTimeout(callback,0),cancelAnimationFrame:clearTimeout,getComputedStyle:()=>style});

const chat:any={id:'chat',title:'729',folderId:'folder',draft:'',pinned:false,archived:false,status:'completed',updatedAt:'',mode:'agent',permissionMode:'workspace',providerId:'claude',model:'m',providerThreadId:'thread-1'};
const calls:{command:string;input:any}[]=[],listeners=new Set<(event:any)=>void>();
const snapshot=()=>({chats:[chat],folders:[{id:'folder',name:'Workspace',path:'/workspace'}],projects:[],version:1,activeChatId:'chat'});
const skills=[
  {id:'/h/.claude/commands/bar.md',name:'bar',provenance:'~/.claude',path:'/h/.claude/commands/bar.md',readme:'Review $ARGUMENTS',readError:null,shortDescription:'Reviews a flow',claude:'command',argumentHint:'<flow>'},
  {id:'/h/.claude/skills/foo',name:'foo',provenance:'~/.claude',path:'/h/.claude/skills/foo',readme:'FOO',readError:null,shortDescription:'Formats the release notes',claude:'skill'},
  {id:'/h/.agents/skills/review',name:'review',provenance:'~/.agents',path:'/h/.agents/skills/review',readme:'R',readError:null,shortDescription:'Code review'},
];
const deploy={id:'/workspace/.claude/commands/deploy.md',name:'deploy',provenance:'.claude/commands (workspace)',path:'/workspace/.claude/commands/deploy.md',readme:'Deploy',readError:null,shortDescription:'Deploys this project',claude:'command'};
const githubIcon={kind:'image',dataUrl:'data:image/svg+xml;base64,R0g='};
const plugins=[
  {id:'/cache/c/github/1',name:'github',version:'1',provenance:'c',path:'/cache/c/github/1',skills:[],mcpServers:[{name:'github',transport:'remote'}],apps:[{name:'GitHub',id:'github-app',required:false}],readError:null,displayName:'GitHub',icon:githubIcon},
  {id:'/cache/c/figma/1',name:'figma',version:'1',provenance:'c',path:'/cache/c/figma/1',skills:[],mcpServers:[{name:'figma',transport:'remote'}],apps:[],readError:null,displayName:'Figma',icon:{kind:'image',dataUrl:'data:image/svg+xml;base64,Rkk='}},
  {id:'/cache/r/atlassian/2',name:'app-6a83901dde988191b3f3cefdcc19acfa',version:'2',provenance:'r',path:'/cache/r/atlassian/2',skills:[],mcpServers:[],apps:[{name:'app-6a83901dde988191b3f3cefdcc19acfa',id:'asdk_app_6a83901dde988191b3f3cefdcc19acfa',required:true}],readError:null,displayName:'Atlassian',shortDescription:'Jira, Confluence, Loom, & more'},
];
const server=(id:string,name:string)=>({id,name,transport:'http',url:`http://x/${name}`,args:[],env:{},auth:{kind:'none'},scope:'user',scopeId:'',enabled:true,createdAt:'',updatedAt:'',health:{lastTestAt:'2026-09-23',ok:true,consecutiveFailures:0,toolCount:3},configKey:name,healthy:true,loadedBy:[]});
const servers=[server('s1','github'),server('s2','postgres')];
const linearPkg:any={id:'src:linear',sourceId:'src',sourceLabel:'Claude market',name:'linear',kind:'plugin',displayName:'linear',version:'1.0.0',description:'Linear issue tracking',capabilities:{mcpServers:[{name:'linear',transport:'remote'}],apps:[],hooks:[],skills:[],commands:[],agents:[]},compatibility:{format:'claude',supported:true,unsupported:[],notes:[]}};
let catalog:any[]=[linearPkg];
(window as any).muster={subscribe(listener:any){listeners.add(listener);return()=>listeners.delete(listener);},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='app.snapshot')return snapshot();
  if(command==='chat.timeline')return {items:[],revision:1};
  if(command==='providers.list')return [{id:'claude',name:'Claude',available:true,models:[{id:'m',name:'Model M'}]}];
  if(command==='plugins.list')return (input?.folderPaths??[]).includes('/workspace')?[...skills,deploy]:skills;
  if(command==='plugins.inventory')return plugins.slice();
  if(command==='mcp.servers.list'||command==='mcp.servers.detect')return servers;
  if(command==='mcp.hooks.list')return [];
  if(command==='extensions.sources.list')return [{id:'src',kind:'local',path:'/m',label:'Claude market',addedAt:''}];
  if(command==='extensions.catalog')return catalog;
  if(command==='extensions.installed'||command==='extensions.enablement.list')return [];
  if(command==='extensions.inventory')return {skills:[],plugins:[]};
  if(command==='terminal.list')return [];
  if(command==='processes.list')return {chatId:input.chatId,sessions:[]};
  if(command==='processes.summary')return {revision:1,sessions:[]};
  if(command==='chat.contextTelemetry')return {usedTokens:null,windowTokens:null,source:null,compacted:false,updatedAt:null};
  if(command==='files.read')throw new Error('ENOENT');
  if(command==='chat.send')return {runId:'run'};
  if(command==='attachments.list'||command==='providers.usage'||command==='files.list')return [];
  return undefined;
}};
const React=await import('react'),{createRoot}=await import('react-dom/client');
const {Composer}=await import('../src/renderer/components/Composer');
const {ToolCard}=await import('../src/renderer/components/ToolCard');
const {McpServers}=await import('../src/renderer/components/McpServers');
const {PluginsScreen}=await import('../src/renderer/components/PluginsScreen');
const {NewChatScreen}=await import('../src/renderer/components/NewChatScreen');
const {PluginIcon}=await import('../src/renderer/components/PluginIcon');
const {useStore}=await import('../src/renderer/useStore');
const store=await import('../src/renderer/store');
const errors:unknown[]=[],root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
let toolset:any[]=[];
let generation=0,view:'composer'|'toolset'|'tools'|'settings'|'command'|'plugins'|'newchat'|'icons'='composer';
const toolItem=(id:string,server:string,tool:string,status='completed')=>({id,chatId:'chat',kind:'tool',text:'',status,createdAt:'',data:{type:'mcpToolCall',server,tool,status}});
const commandItem={id:'c1',chatId:'chat',kind:'tool',text:'/bar',status:'completed',createdAt:'',data:{type:'claudeCommand',kind:'command',name:'/bar',arguments:'the login flow',source:'.claude/commands (workspace)',path:'/workspace/.claude/commands/bar.md',output:'Review the login flow'}};
const tools=[toolItem('t1','mcp__codex_apps__github','search_issues'),toolItem('t2','codex_apps','figma.get_screenshot'),toolItem('t3','postgres','run_query'),toolItem('t4','plugin_figma_figma','get_metadata','failed')];
function Harness(){const state=useStore();if(!state.snapshot)return null;
  if(view==='tools')return <div className="tools">{tools.map(item=><ToolCard key={item.id} item={item as any}/>)}</div>;
  if(view==='toolset')return <div className="toolset">{toolset.map(item=><ToolCard key={item.id} item={item as any}/>)}</div>;
  if(view==='settings')return <McpServers/>;
  if(view==='command')return <div className="tools"><ToolCard item={commandItem as any}/></div>;
  if(view==='plugins')return <PluginsScreen/>;
  if(view==='newchat')return <NewChatScreen/>;
  if(view==='icons')return <div className="icons"><span className="pair"><PluginIcon name="Atlassian" icon={{kind:'image',dataUrl:'data:image/png;base64,TElHSFQ=',darkDataUrl:'data:image/png;base64,REFSSw=='}}/></span><div className="tools">{tools.slice(0,1).map(item=><ToolCard key={item.id} item={item as any}/>)}</div></div>;
  return <Composer key={generation} chat={state.snapshot.chats[0]}/>;}
const render=async()=>{root.render(<Harness/>);await delay(60);};
const byTest=(id:string)=>document.querySelector(`[data-testid="${id}"]`) as HTMLElement|null;
const input=()=>byTest('composer-input') as unknown as HTMLTextAreaElement;
const key=async(element:Element,value:string)=>{const event=new window.Event('keydown',{bubbles:true,cancelable:true});Object.assign(event,{key:value});element.dispatchEvent(event);await delay(35);return event;};
const setDraft=async(value:string)=>{store.setComposerDraft('chat',value);generation++;await render();};
const sectionRows=(title:string)=>{const rows:HTMLElement[]=[];let node=Array.from(document.querySelectorAll('.composer-menu-section')).find(header=>header.textContent===title)?.nextElementSibling;
  while(node&&!node.classList.contains('composer-menu-section')){rows.push(node as HTMLElement);node=node.nextElementSibling;}return rows;};
const label=(row:Element)=>row.querySelector('.composer-row-label')?.textContent;
await store.boot();await store.selectChat('chat');await render();
for(let end=Date.now()+3000;store.getState().skills.phase!=='ready'&&Date.now()<end;)await delay(20);
assert.deepEqual(errors,[]);

// Spec: MUS-SPEC-14-729F (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-729f)
await check('the / picker lists a Claude Code command as /name under Commands with a Claude Code badge and its argument hint',async()=>{
  await setDraft('/');
  for(let end=Date.now()+2000;!sectionRows('Commands').some(row=>label(row)==='/bar')&&Date.now()<end;)await delay(20);
  const commands=sectionRows('Commands'),bar=commands.find(row=>label(row)==='/bar');
  assert.ok(bar,`rows: ${JSON.stringify(commands.map(label))}`);
  assert.ok(commands.indexOf(bar!)>0,'after the built-in commands');
  assert.equal(bar!.querySelector('.composer-row-badge')?.textContent,'Claude Code');
  assert.match(bar!.textContent??'',/<flow> · Reviews a flow/);
  assert.ok(bar!.querySelector('svg.lucide-square-slash'),'the slash-command glyph');
  const skillRows=sectionRows('Skills');
  assert.deepEqual(skillRows.map(label).sort(),['foo','review'],'Claude skills stay under Skills; commands never duplicate there');
  assert.equal(skillRows.find(row=>label(row)==='foo')!.querySelector('.composer-row-badge')?.textContent,'Claude Code');
  assert.equal(skillRows.find(row=>label(row)==='review')!.querySelector('.composer-row-badge')?.textContent,'Personal');
});

// Spec: MUS-SPEC-14-729J (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-729j)
await check('picking /bar inserts a chip that reads /bar and sends the command structurally',async()=>{
  sectionRows('Commands').find(row=>label(row)==='/bar')!.click();await delay(50);
  const chip=document.querySelector('[data-testid="token-chip"]');
  assert.equal(chip?.getAttribute('data-kind'),'skill');assert.equal(chip?.textContent,'/bar');
  assert.ok(!document.querySelector('[data-testid="composer-popover"]'),'the picker closes');
  const sent=calls.filter(call=>call.command==='chat.send').length;
  (byTest('composer-primary') as HTMLButtonElement).click();await delay(60);
  const send=calls.filter(call=>call.command==='chat.send');assert.equal(send.length,sent+1);
  assert.equal(send.at(-1)!.input.skillId,'/h/.claude/commands/bar.md');
});

// Spec: MUS-SPEC-14-729K (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-729k)
await check('a hand-typed /bar is recognised as the Claude Code command and sent with it; a built-in /status keeps its own meaning',async()=>{
  await setDraft('/bar the signup flow');
  const chip=document.querySelector('[data-testid="token-chip"]');
  assert.equal(chip?.textContent,'/bar');assert.equal(chip?.getAttribute('data-kind'),'skill');
  (byTest('composer-primary') as HTMLButtonElement).click();await delay(60);
  const send=calls.filter(call=>call.command==='chat.send').at(-1)!;
  assert.equal(send.input.text,'/bar the signup flow');assert.deepEqual(send.input.skillIds??[send.input.skillId],['/h/.claude/commands/bar.md']);
  await setDraft('/status now');
  assert.equal(document.querySelector('[data-testid="token-chip"]')?.getAttribute('data-kind'),'command','the built-in wins its own name');
});

// Spec: MUS-SPEC-14-729N (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-729n)
await check('opening / in a folder chat lists that folder\'s .claude commands even when skills were already loaded for another scope',async()=>{
  await setDraft('');
  await store.loadSkills(true,[]);
  assert.ok(!store.getState().skills.value?.some((entry:any)=>entry.name==='deploy'),'the earlier load had no folder');
  await setDraft('/');
  for(let end=Date.now()+2000;!sectionRows('Commands').some(row=>label(row)==='/deploy')&&Date.now()<end;)await delay(20);
  assert.ok(sectionRows('Commands').some(row=>label(row)==='/deploy'),`rows: ${JSON.stringify(sectionRows('Commands').map(label))}`);
  assert.deepEqual(calls.filter(call=>call.command==='plugins.list').at(-1)!.input.folderPaths,['/workspace'],'asked for this chat\'s folder');
});

// Spec: MUS-SPEC-14-729L (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-729l)
await check('Connectors & MCP rows carry the plugin mark: a plugin server, its app and a user server named after the plugin',async()=>{
  await setDraft('');
  (byTest('composer-plus') as HTMLButtonElement).click();await delay(60);
  const rows=sectionRows('Connectors & MCP');
  const marks=rows.map(row=>`${label(row)}|${row.querySelector('img.item-icon')?'logo':'glyph'}`);
  assert.deepEqual(marks,['github|logo','postgres|glyph','GitHub|logo','figma|logo','Atlassian|glyph'],JSON.stringify(marks));
  rows[0].click();await delay(50);
  const chip=document.querySelector('[data-testid="token-chip"][data-kind="mcp"]')!;
  assert.ok(chip,'an @mcp chip');
  assert.equal(chip.getAttribute('data-plugin'),'GitHub');
  assert.ok(chip.querySelector('img.item-icon'),'the chip leads with the GitHub mark');
});

// Spec: MUS-SPEC-14-729R (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-729r)
await check('an app known only by an opaque id reads as its plugin in the + menu, on its chip and in the message the agent gets',async()=>{
  await setDraft('');
  (byTest('composer-plus') as HTMLButtonElement).click();await delay(60);
  const rows=sectionRows('Connectors & MCP');
  assert.ok(!rows.some(row=>/app-6a83/.test(row.textContent??'')),`no raw app id on screen: ${JSON.stringify(rows.map(row=>row.textContent))}`);
  const app=rows.find(row=>label(row)==='Atlassian')!;
  assert.ok(app,'the Atlassian app row');
  assert.equal(app.querySelector('.composer-row-badge')?.textContent,'App');
  assert.match(app.textContent??'',/Jira, Confluence, Loom, & more/,'described by what the plugin does');
  assert.equal(app.querySelector('.item-monogram')?.textContent,'A','no logo shipped: the plugin monogram');
  app.click();await delay(50);
  const chip=document.querySelector('[data-testid="token-chip"][data-kind="app"]')!;
  assert.ok(chip,'an @app chip');
  assert.match(chip.textContent??'',/Atlassian$/);assert.doesNotMatch(chip.textContent??'',/app-6a83/);
  assert.equal(chip.getAttribute('data-plugin'),'Atlassian');
  (byTest('composer-primary') as HTMLButtonElement).click();await delay(60);
  const sent=calls.filter(call=>call.command==='chat.send').at(-1)!.input.text;
  assert.match(sent,/@app:Atlassian/);assert.doesNotMatch(sent,/app-6a83/,'the agent reads the app by name too');
});

// Spec: MUS-SPEC-14-729U (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-729u)
await check('an open + menu redraws Atlassian with its logo when the background refresh caches it',async()=>{
  await setDraft('');
  (byTest('composer-plus') as HTMLButtonElement).click();await delay(60);
  const before=sectionRows('Connectors & MCP').find(row=>label(row)==='Atlassian')!;
  assert.equal(before.querySelector('.item-monogram')?.textContent,'A','no logo yet: the monogram');
  const prior=plugins[2]!.icon,reads=calls.filter(call=>call.command==='plugins.inventory').length;
  plugins[2]={...plugins[2]!,icon:{kind:'image',dataUrl:'data:image/png;base64,QVQ='}} as any;
  for(const listener of listeners)listener({type:'pluginIconsChanged'});await delay(80);
  assert.equal(calls.filter(call=>call.command==='plugins.inventory').length,reads+1,'plugins are read again once');
  const after=sectionRows('Connectors & MCP').find(row=>label(row)==='Atlassian');
  assert.ok(after,'the menu stays open');
  assert.equal(after.querySelector('img.item-icon')?.getAttribute('src'),'data:image/png;base64,QVQ=','the row now shows the logo');
  plugins[2]={...plugins[2]!,icon:prior} as any;
  for(const listener of listeners)listener({type:'pluginIconsChanged'});await delay(60);
});

// Spec: MUS-SPEC-14-729G (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-729g)
await check('MCP tool rows show the providing plugin mark; built-in servers keep the generic glyph',async()=>{
  view='tools';await render();
  const glyphs=Array.from(document.querySelectorAll('.tool-row-head > .tool-glyph'));
  assert.equal(glyphs.length,4);
  assert.deepEqual(glyphs.map(glyph=>glyph.getAttribute('data-plugin')??(glyph.querySelector('img')?'img':'generic')),['GitHub','Figma','generic','Figma']);
  assert.ok(glyphs[0].classList.contains('is-plugin')&&glyphs[0].querySelector('img.item-icon'));
  assert.ok(!glyphs[2].classList.contains('is-plugin')&&glyphs[2].querySelector('svg'),'an unbranded server keeps the thin glyph');
  const subjects=Array.from(document.querySelectorAll('.tool-row-head')).map(head=>`${head.querySelector('.tool-row-subject')?.textContent}|${head.querySelector('.tool-row-hit')?.getAttribute('title')}`);
  assert.deepEqual(subjects,['GitHub / search issues|mcp__codex_apps__github / search_issues','Figma / get screenshot|codex_apps / figma.get_screenshot','postgres / run_query|postgres / run_query','Figma / get metadata|plugin_figma_figma / get_metadata'],'plugin-named subjects; the raw server stays in the tooltip');
});

// Spec: MUS-SPEC-14-729M (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-729m)
await check('Settings › MCP servers shows each server with its plugin mark or a neutral tile, with the health dot on the mark',async()=>{
  view='settings';await render();
  for(let end=Date.now()+2000;!document.querySelector('.mcp-server-mark')&&Date.now()<end;)await delay(20);
  const marks=Array.from(document.querySelectorAll('.mcp-server-mark'));
  assert.equal(marks.length,2);
  assert.equal(marks[0].getAttribute('data-plugin'),'GitHub');assert.ok(marks[0].querySelector('img.item-icon'));
  assert.ok(!marks[1].getAttribute('data-plugin')&&marks[1].querySelector('.mcp-server-tile svg'),'postgres: neutral tile');
  assert.ok(marks.every(mark=>mark.querySelector('.mcp-dot.is-ok, .mcp-dot')),'health dot inside the mark');
});

// Spec: MUS-SPEC-14-729P (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-729p)
await check('a "Ran /bar" row reads like the typed command, carries the slash glyph and says where the command came from',async()=>{
  view='command';await render();
  const head=document.querySelector('.tool-row-head')!;
  assert.equal(head.querySelector('.tool-row-text')?.textContent,'Ran /bar the login flow');
  assert.ok(head.querySelector('.tool-glyph svg.lucide-square-slash'),'the slash glyph the picker uses');
  assert.equal(head.querySelector('.tool-row-hit')?.getAttribute('title'),'.claude/commands (workspace) · /workspace/.claude/commands/bar.md');
  (head.querySelector('.tool-row-hit') as HTMLElement).click();await delay(60);
  const body=document.querySelector('.tool-row-body')!;
  assert.equal(body.querySelector('.tool-row-source code')?.textContent,'/bar the login flow');
  assert.equal(body.querySelector('.tool-result header span')?.textContent,'Expanded prompt');
  assert.equal(body.querySelector('.tool-result-text')?.textContent,'Review the login flow');
  assert.ok(!Array.from(body.querySelectorAll('.tool-detail-trigger')).some(trigger=>trigger.textContent==='Arguments'),'the arguments are in the command line, not repeated as raw JSON');
  assert.match(body.querySelector('.tool-details dl')?.textContent??'',/Source\.claude\/commands \(workspace\)/);
});

// Spec: MUS-SPEC-14-729V (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-729v)
await check('an open Skills & plugins screen redraws Linear with the logo borrowed from the OpenAI catalog when it is cached',async()=>{
  view='plugins';await render();
  for(let end=Date.now()+2000;!document.querySelector('[role="tab"]')&&Date.now()<end;)await delay(20);
  (Array.from(document.querySelectorAll('[role="tab"]')).find(tab=>/^Discover/.test(tab.textContent??'')) as HTMLElement).click();
  for(let end=Date.now()+2000;!document.querySelector('.plugins-card')&&Date.now()<end;)await delay(20);
  const card=()=>Array.from(document.querySelectorAll('.plugins-card')).find(element=>/linear/.test(element.textContent??''));
  assert.ok(card(),'the Linear card is listed');
  assert.ok(!card()!.querySelector('img.item-icon'),'no logo yet: the monogram');
  const reads=calls.filter(call=>call.command==='extensions.catalog').length;
  catalog=[{...linearPkg,icon:{kind:'image',dataUrl:'data:image/png;base64,TEk='}}];
  for(const listener of listeners)listener({type:'pluginIconsChanged'});await delay(120);
  assert.equal(calls.filter(call=>call.command==='extensions.catalog').length,reads+1,'the catalog is read again once');
  assert.equal(card()?.querySelector('img.item-icon')?.getAttribute('src'),'data:image/png;base64,TEk=','the card now shows the Linear logo');
});

// Spec: MUS-SPEC-14-729W (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-729w)
await check('the New chat + menu lists MCP servers and plugin apps with their marks, and a pick inserts the connector chip',async()=>{
  view='newchat';await render();
  const plus=()=>document.querySelector('.composer-plus') as HTMLButtonElement|null;
  for(let end=Date.now()+2000;!plus()&&Date.now()<end;)await delay(20);
  assert.ok(plus(),'the New chat composer renders');
  plus()!.click();
  for(let end=Date.now()+2000;!sectionRows('Connectors & MCP').length&&Date.now()<end;)await delay(20);
  const rows=sectionRows('Connectors & MCP');
  assert.deepEqual(rows.map(label),['github','postgres','GitHub','figma','Atlassian'],'user servers, then what plugins bring (a server already listed is not repeated)');
  assert.equal(rows[0].querySelector('img.item-icon')?.getAttribute('src'),githubIcon.dataUrl,'the github server carries the GitHub plugin logo');
  assert.ok(!rows[1].querySelector('img.item-icon')&&rows[1].querySelector('svg'),'postgres: the generic server glyph');
  assert.equal(rows[0].querySelector('.composer-row-badge')?.textContent,'MCP');
  assert.ok(rows[3].querySelector('img.item-icon'),'the Figma server carries the Figma logo');
  assert.equal(rows[4].querySelector('.composer-row-badge')?.textContent,'App');
  rows[4].click();await delay(60);
  const chip=document.querySelector('[data-testid="token-chip"][data-kind="app"]');
  assert.ok(chip,'an @app chip in the draft');
  assert.match(chip!.textContent??'',/Atlassian$/);
  assert.equal(chip!.getAttribute('data-plugin'),'Atlassian','the chip wears the Atlassian mark');
  assert.ok(!document.querySelector('.composer-plus-popover'),'the menu closes');
  const {getNewChatDraft}=await import('../src/renderer/newChatDraft');
  assert.match(getNewChatDraft().text,/@app:Atlassian/,'the agent gets the app by name');
});

// Spec: MUS-SPEC-14-729E (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-729e)
await check('tool rows from connector and plugin servers draw that plugin\'s logo and read the tool, under every name the coding clients give them',async()=>{
  const extra=[['slack','Slack'],['google-drive','Google Drive'],['notion','Notion']].map(([name,displayName])=>({id:`/cache/c/${name}/1`,name,version:'1',provenance:'c',path:`/cache/c/${name}/1`,skills:[],mcpServers:name==='notion'?[{name,transport:'remote'}]:[],apps:[{name,id:`connector_${name}`,required:false}],readError:null,displayName,icon:{kind:'image',dataUrl:`data:image/png;base64,${Buffer.from(name).toString('base64')}`}}));
  plugins.push(...extra);
  try{
    await store.loadPlugins(true);
    toolset=[toolItem('e1','mcp__codex_apps__github','_create_pull_request'),toolItem('e2','mcp__codex_apps__slack','_slack_read_channel'),toolItem('e3','codex_apps','google_drive.list_drives'),toolItem('e4','plugin_figma_figma','get_design_context'),toolItem('e5','claude_ai_Notion','search'),toolItem('e6','mcp__node_repl','js'),toolItem('e7','muster_browser','browser_click')];
    view='toolset';await render();
    const rows=Array.from(document.querySelectorAll('.toolset .tool-row-head'));
    assert.equal(rows.length,7);
    const iconOf=(name:string)=>(plugins.find(entry=>entry.name===name) as any).icon.dataUrl;
    const drawn=rows.map(row=>{const glyph=row.querySelector('.tool-glyph');return [glyph?.getAttribute('data-plugin')??null,glyph?.querySelector('img.item-icon')?.getAttribute('src')??null];});
    assert.deepEqual(drawn,[['GitHub',iconOf('github')],['Slack',iconOf('slack')],['Google Drive',iconOf('google-drive')],['Figma',iconOf('figma')],['Notion',iconOf('notion')],[null,null],[null,null]],JSON.stringify(drawn));
    const text=rows.map(row=>row.textContent??'');
    for(const [index,subject] of [[0,'GitHub / create pull request'],[1,'Slack / read channel'],[2,'Google Drive / list drives'],[4,'Notion / search']] as const)assert.ok(text[index].includes(subject),`row ${index} reads "${subject}": ${text[index]}`);
    assert.ok(!text.slice(0,5).some(line=>/codex_apps|plugin_figma|claude_ai_/.test(line)),'no server plumbing on the rows');
  }finally{plugins.splice(plugins.length-extra.length,extra.length);await store.loadPlugins(true);view='composer';}
});

// Spec: MUS-SPEC-14-732G (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-732g)
await check('a hand-typed /foo, when a Claude Code skill and a command share the name, attaches the skill Claude Code would run',async()=>{
  const command={id:'/h/.claude/commands/foo.md',name:'foo',provenance:'~/.claude',path:'/h/.claude/commands/foo.md',readme:'FOO COMMAND',readError:null,shortDescription:'Foo command',claude:'command'};
  skills.unshift(command as any);
  try{
    view='composer';await store.loadSkills(true,['/workspace']);
    await setDraft('/foo the notes');
    const chip=document.querySelector('[data-testid="token-chip"]');
    assert.equal(chip?.textContent,'/foo');
    (byTest('composer-primary') as HTMLButtonElement).click();await delay(60);
    const send=calls.filter(call=>call.command==='chat.send').at(-1)!;
    assert.deepEqual(send.input.skillIds??[send.input.skillId],['/h/.claude/skills/foo'],'the skill wins its name, as in Claude Code');
  }finally{skills.shift();await store.loadSkills(true,['/workspace']);}
});

// Spec: MUS-SPEC-14-732H (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-732h)
await check('when only the dark-theme logo still draws, it shows in dark theme and the light theme gets the monogram',async()=>{
  view='icons';await render();
  const pair=()=>Array.from(document.querySelectorAll('.pair .item-icon'));
  const light=pair().find(node=>node.classList.contains('is-theme-light'));
  assert.ok(light,'the light logo is drawn first');light!.dispatchEvent(new window.Event('error'));await delay(40);
  const shown=pair().map(node=>[node.tagName.toLowerCase(),node.getAttribute('src'),node.classList.contains('is-theme-dark'),node.classList.contains('is-theme-light')]);
  assert.deepEqual(shown,[['img','data:image/png;base64,REFSSw==',true,false],['span',null,false,true]],JSON.stringify(shown));
  assert.ok(pair()[1].classList.contains('item-monogram'));
  view='composer';generation++;await render();
});

// Spec: MUS-SPEC-14-732F (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-732f)
await check('a logo the browser cannot draw falls back to the monogram on its row; a pair keeps the variant that still draws',async()=>{
  view='icons';await render();
  const fail=async(image:Element|null|undefined)=>{assert.ok(image,'the logo is drawn first');image!.dispatchEvent(new window.Event('error'));await delay(40);};
  const glyph=()=>document.querySelector('.tools .tool-row-head > .tool-glyph');
  await fail(glyph()?.querySelector('img.item-icon'));
  assert.ok(!glyph()?.querySelector('img'),'the broken GitHub logo is gone from the tool row');
  assert.equal(glyph()?.querySelector('.item-monogram')?.textContent?.trim().length?true:false,true,'the row shows the GitHub monogram instead');
  const pair=()=>Array.from(document.querySelectorAll('.pair img.item-icon'));
  assert.equal(pair().length,2,'a logo with a dark variant draws both, one per theme');
  await fail(pair().find(image=>image.classList.contains('is-theme-dark')));
  assert.deepEqual(pair().map(image=>[image.getAttribute('src'),image.classList.contains('is-theme-light')]),[['data:image/png;base64,TElHSFQ=',false]],'the light logo stays and now shows in both themes');
  await fail(pair()[0]);
  assert.equal(pair().length,0);
  assert.ok(document.querySelector('.pair .item-monogram'),'with neither variant drawable the monogram shows');
});

assert.deepEqual(errors,[]);
root.unmount();
console.log('#729 DOM checks passed: Claude commands under Commands as /name, skills under Skills, structural send, plugin marks on connectors, chips, tool rows and MCP settings.');
process.exit(0);
