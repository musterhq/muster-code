/** #423: the page the agent drives is the page the right pane shows (same tab, same view), with a live picture. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BrowserWorkspaceController,OFFSCREEN_BROWSER_BOUNDS} from '../src/main/browser-workspace.ts';
import {BrowserBridge} from '../src/main/agent-tools/browser-bridge.ts';
import {agentBrowserOwner,browserScopeProfile,type BrowserEvent} from '../src/shared/browser-protocol.ts';
import {agentBrowserBinding,bindAgentBrowser,liveViewTabId,mergeSources,recentComputerSources,sessionTabId,type PipSource} from '../src/renderer/computerUse.ts';

/** A WebContents double whose capture is empty while its view has no size, as Chromium's is. */
class Contents extends EventEmitter {
  url='about:blank';title='';destroyed=false;loads:string[]=[];
  constructor(private view:View){super();}
  navigationHistory={canGoBack:()=>false,canGoForward:()=>false};
  loadURL(url:string){this.loads.push(url);this.url=url;this.title=new URL(url).host;this.emit('did-start-navigation',{},url,false,true);return Promise.resolve();}
  capturePage(){const size=this.view.bounds;const empty=!size||size.width<1||size.height<1;return Promise.resolve({isEmpty:()=>empty,getSize:()=>({width:size?.width??0,height:size?.height??0}),resize(){return this;},toJPEG:()=>Buffer.from('jpeg'),toDataURL:()=>'data:image/png;base64,AA'});}
  executeJavaScriptInIsolatedWorld(){return Promise.resolve({url:this.url,title:this.title,outline:'- button "Validate" [ref=e1]',text:'checks'});}
  sendInputEvent(){} insertText(){return Promise.resolve();} isLoading(){return false;} getZoomFactor(){return 1;}
  isDestroyed(){return this.destroyed;} getTitle(){return this.title;} setAudioMuted(){} setWindowOpenHandler(){} setBackgroundThrottling(){}
  close(){this.destroyed=true;this.emit('destroyed');}
}
class View {
  bounds?:{x:number;y:number;width:number;height:number};visible=false;webContents:Contents=new Contents(this);
  setVisible(visible:boolean){this.visible=visible;} setBackgroundColor(){} setBounds(bounds:{x:number;y:number;width:number;height:number}){this.bounds=bounds;}
}
class Session extends EventEmitter {setPermissionRequestHandler(){} setPermissionCheckHandler(){} setDevicePermissionHandler(){} setDisplayMediaRequestHandler(){}}

function workspace() {
  const children:View[]=[],views:View[]=[],events:BrowserEvent[]=[],sessions=new Map<string,Session>();
  const window=Object.assign(new EventEmitter(),{webContents:Object.assign(new EventEmitter(),{getZoomFactor:()=>1,isDestroyed:()=>false}),isDestroyed:()=>false,isVisible:()=>true,isMinimized:()=>false,getContentSize:()=>[1400,900],
    contentView:{addChildView:(view:View)=>{children.push(view);},removeChildView:(view:View)=>{children.splice(children.indexOf(view),1);}}});
  const controller=new BrowserWorkspaceController(window as never,event=>events.push(event),{
    createView:()=>{const view=new View();views.push(view);return view as never;},
    getSession:partition=>{if(!sessions.has(partition))sessions.set(partition,new Session());return sessions.get(partition) as never;},
  },{freezeHidden:false,sweepIntervalMs:3_600_000});
  return {controller,children,views,events};
}

test('an agent tab that was never shown is laid out off screen at a real size, so its live picture is not empty',async()=>{
  const {controller,views,children}=workspace();
  const owner=agentBrowserOwner('c1');
  controller.agentOpen(owner,'personal','http://167.86.126.10:8080/');
  assert.equal(views.length,1);assert.equal(children.length,0,'nothing is put on screen by the agent');
  assert.deepEqual(views[0]!.bounds,OFFSCREEN_BROWSER_BOUNDS,'a 0×0 view captured as an empty image and the pane said "Starting…"');
  const frame=await controller.frame(owner);
  assert.ok(frame,'the hidden agent page yields a frame');
  assert.equal(frame!.url,'http://167.86.126.10:8080/');
  controller.dispose();
});

test('end to end: the agent opens a URL, the pane adopts the same tab and shows that URL in a sized, attached view',async()=>{
  const {controller,views,children,events}=workspace();
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'muster-pane-'));
  const emitted:{type:string;[key:string]:unknown}[]=[];
  const chat={id:'c1',mode:'agent',permissionMode:'full',projectId:'p1',folderId:'f1'};
  const bridge=new BrowserBridge({dir,browser:controller,execPath:'/usr/bin/env',script:'/x/browser-mcp.cjs',emit:event=>emitted.push(event as never),lease:async()=>'agent',
    snapshot:async()=>({chats:[chat],folders:[],projects:[],version:1} as never)});
  await bridge.start();
  const navigated=await bridge.call('c1','browser_navigate',{url:'http://167.86.126.10:8080/'});
  assert.notEqual(navigated.isError,true);
  await new Promise(resolve=>setTimeout(resolve,30));
  const opened=emitted.find(event=>event.type==='computerBrowserOpened')!;
  assert.equal(opened.owner,agentBrowserOwner('c1'));assert.equal(opened.profileId,browserScopeProfile(chat));
  const frame=emitted.find(event=>event.type==='computerFrame') as {frame:{owner:string;url:string;dataUrl:string}}|undefined;
  assert.ok(frame,'the PiP gets a live frame from the hidden page');
  assert.equal(frame!.frame.owner,opened.owner);assert.match(frame!.frame.dataUrl,/^data:image\/jpeg;base64,./);

  // The renderer reloads and misses computerBrowserOpened: the next call announces the binding again.
  emitted.length=0;
  await bridge.call('c1','browser_click',{ref:'e1',element:'Validate'});
  const again=emitted.find(event=>event.type==='computerBrowserOpened');
  assert.equal(again?.owner,agentBrowserOwner('c1'),'every call re-announces the tab the agent drives');

  // The renderer binds the transcript's step to that tab and opens it: same owner, same profile, same view.
  const step:PipSource={chatId:'c1',target:'browser',app:'Browser',label:'Clicked “Validate”',at:Date.now(),url:'http://167.86.126.10:8080/'};
  const [bound]=bindAgentBrowser([step],agentBrowserBinding('c1',chat));
  assert.equal(sessionTabId(bound!),opened.owner,'the sidebar opens the agent\'s own browser tab');
  const state=controller.open({owner:bound!.owner!,profileId:bound!.profileId!,surfaceId:'pane-1',url:bound!.url});
  assert.equal(state.url,'http://167.86.126.10:8080/');
  controller.position({owner:bound!.owner!,surfaceId:'pane-1',bounds:{x:900,y:60,width:480,height:700}});
  assert.equal(views.length,1,'the pane shows the agent\'s view, not a second page');
  assert.deepEqual(children,[views[0]],'the view is attached to the window');
  assert.deepEqual(views[0]!.bounds,{x:900,y:60,width:480,height:700});
  assert.equal(views[0]!.visible,true);
  const last=[...events].reverse().find(event=>event.type==='browserState');
  assert.equal(last?.type==='browserState'&&last.state.visible,true);
  assert.equal(last?.type==='browserState'&&last.state.url,'http://167.86.126.10:8080/');
  bridge.dispose();controller.dispose();fs.rmSync(dir,{recursive:true,force:true});
});

test('the pane binds a browser session to the chat\'s agent tab for every chat type',()=>{
  const now=Date.now();
  const steps=recentComputerSources([{id:'t1',chatId:'x',kind:'tool',text:'',status:'completed',createdAt:new Date(now-40_000).toISOString(),data:{type:'mcpToolCall',server:'muster_browser',tool:'browser_navigate',arguments:{url:'https://app.test/'}}},
    {id:'t2',chatId:'x',kind:'tool',text:'',status:'completed',createdAt:new Date(now-34_000).toISOString(),data:{type:'mcpToolCall',server:'muster_browser',tool:'browser_wait_for',arguments:{text:'checks'}}}] as never);
  const chats:Record<string,{folderId?:string|null;projectId?:string|null}>={folder:{folderId:'f1'},project:{projectId:'p1',folderId:'f1'},checkout:{projectId:'p9',folderId:null},imported:{folderId:'imp'},noFolder:{}};
  for(const [kind,chat] of Object.entries(chats)){
    const sources=bindAgentBrowser(mergeSources([],steps.map(step=>({...step,chatId:kind}))),agentBrowserBinding(kind,chat));
    assert.equal(sources[0]!.owner,agentBrowserOwner(kind),`${kind}: the step is bound to the agent's tab`);
    assert.equal(sources[0]!.profileId,browserScopeProfile(chat),`${kind}: in the chat's own browser profile`);
    assert.equal(sessionTabId(sources[0]!),agentBrowserOwner(kind),`${kind}: the sidebar opens the live tab, not "Starting…"`);
  }
  // Main's announcement wins over the derived name (it is the tab that exists).
  assert.deepEqual(agentBrowserBinding('c1',{folderId:'f1'},{owner:'browser:agent-c1--review',profileId:'personal'}),{owner:'browser:agent-c1--review',profileId:'personal'});
  // A pushed frame already names its tab; the picture-only id is separate from the tab id.
  const frame:PipSource={chatId:'c1',target:'browser',app:'A',label:'x',at:now,url:'https://a.test/',owner:'browser:agent-c1',profileId:'personal'};
  assert.deepEqual(bindAgentBrowser([frame],agentBrowserBinding('c1',{folderId:'f1'})),[frame]);
  assert.notEqual(liveViewTabId(frame),sessionTabId(frame));
  // Long ids still make a valid, stable tab identity; a sub-agent session gets its own tab.
  const long='x'.repeat(120);
  assert.match(agentBrowserOwner(long),/^browser:[a-zA-Z0-9_-]{1,128}$/);assert.equal(agentBrowserOwner(long,'s1'),agentBrowserOwner(long,'s1'));
  assert.notEqual(agentBrowserOwner(long,'s1'),agentBrowserOwner(long,'s2'));
  assert.equal(agentBrowserOwner('c1','reviewer'),'browser:agent-c1--reviewer');assert.equal(agentBrowserOwner('c1','bad key!'),'browser:agent-c1');
});
