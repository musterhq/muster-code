import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {BrowserWorkspaceController,MAX_LIVE_BROWSER_VIEWS,savedBrowserHistory} from '../src/main/browser-workspace.ts';
import type {BrowserEvent} from '../src/shared/browser-protocol.ts';

/** A WebContents double with Electron's history export/restore API. */
class Contents extends EventEmitter {
  destroyed=false;closed=false;loading=false;title='Fixture';muted=false;throttled:boolean|undefined;
  entries:{url:string;title:string;pageState?:string}[]=[];index=-1;restored?:{entries:any[];index?:number};
  navigationHistory={
    canGoBack:()=>this.index>0,canGoForward:()=>this.index<this.entries.length-1,
    goBack:()=>{this.index--;this.emit('did-navigate',{},this.entries[this.index].url);},
    goForward:()=>{this.index++;this.emit('did-navigate',{},this.entries[this.index].url);},
    getAllEntries:()=>this.entries.map(entry=>({...entry})),getActiveIndex:()=>this.index,
    restore:(options:{entries:any[];index?:number})=>{this.restored=options;this.entries=options.entries.map(entry=>({...entry}));this.index=options.index??this.entries.length-1;this.emit('did-navigate',{},this.entries[this.index].url);return Promise.resolve();},
  };
  loadURL(url:string){this.entries=this.entries.slice(0,this.index+1);this.entries.push({url,title:url,pageState:'state'});this.index++;this.emit('did-start-navigation',{},url,false,true);return Promise.resolve();}
  isDestroyed(){return this.destroyed;}
  getTitle(){return this.title;}
  isLoading(){return this.loading;}
  getZoomFactor(){return 1;}
  setAudioMuted(muted:boolean){this.muted=muted;}
  setBackgroundThrottling(value:boolean){this.throttled=value;}
  setWindowOpenHandler(){}
  reload(){}
  stop(){}
  close(){this.destroyed=true;this.closed=true;this.emit('destroyed');}
}
class View {webContents=new Contents();visible=false;options:any;setVisible(v:boolean){this.visible=v;}setBackgroundColor(){}setBounds(){}}
class Session extends EventEmitter {setPermissionRequestHandler(){}setPermissionCheckHandler(){}setDevicePermissionHandler(){}setDisplayMediaRequestHandler(){}}

function fixture(options:{maxLiveViews?:number;idleDiscardMs?:number}={}){
  let clock=1_000;
  const window=Object.assign(new EventEmitter(),{webContents:new Contents(),children:[] as View[],isDestroyed:()=>false,isVisible:()=>true,isMinimized:()=>false,getContentSize:()=>[1000,800],contentView:{addChildView(view:View){window.children.push(view);},removeChildView(view:View){window.children=window.children.filter(item=>item!==view);}}});
  const views:View[]=[],events:BrowserEvent[]=[],session=new Session();
  const controller=new BrowserWorkspaceController(window as never,event=>events.push(event),{
    createView(options){const view=new View();view.options=options;views.push(view);return view as never;},
    getSession(){return session as never;},
  },{...options,now:()=>clock});
  const tick=(ms=1)=>{clock+=ms;};
  const open=(id:string,url=`https://example.test/${id}`)=>{tick();return controller.open({owner:`browser:${id}`,profileId:'personal',surfaceId:`mount-${id}`,url});};
  const show=(id:string)=>{tick();controller.position({owner:`browser:${id}`,surfaceId:`mount-${id}`,bounds:{x:400,y:80,width:600,height:600}});};
  const hide=(id:string)=>{tick();controller.hide({owner:`browser:${id}`,surfaceId:`mount-${id}`});};
  const liveViews=()=>views.filter(view=>!view.webContents.destroyed);
  return {controller,views,events,window,open,show,hide,tick,liveViews};
}

test('live browser renderers are capped: least recently used hidden pages are discarded, never the visible one',()=>{
  const {controller,open,show,hide,liveViews,events,window}=fixture();
  for(const id of ['a','b','c','d','e']){open(id);show(id);hide(id);}
  show('e');
  assert.equal(liveViews().length,MAX_LIVE_BROWSER_VIEWS);
  assert.deepEqual(controller.stats(),{tabs:5,live:MAX_LIVE_BROWSER_VIEWS,attached:1});
  assert.equal(window.children.length,1);
  assert.ok(!events.some(event=>event.type==='browserClosed'),'discarding is invisible to the renderer: the tab stays open');
  // A discarded tab still answers status without recreating a renderer.
  const status=controller.status('browser:a');
  assert.equal(status.url,'https://example.test/a');assert.equal(status.visible,false);
  assert.equal(liveViews().length,MAX_LIVE_BROWSER_VIEWS);
  controller.dispose();
  assert.equal(liveViews().length,0,'dispose closes every live page');
});

test('views opt into background throttling',()=>{
  const {controller,open,views}=fixture();open('a');
  assert.equal(views[0].options.webPreferences.backgroundThrottling,true);
  assert.equal(views[0].webContents.throttled,true);
  controller.dispose();
});

test('a discarded tab is recreated lazily when shown, with its URL and back/forward history',()=>{
  const {controller,open,show,hide,views,liveViews}=fixture({maxLiveViews:1});
  open('a');show('a');controller.navigate({owner:'browser:a',url:'https://example.test/a2'});hide('a');
  open('b');show('b');hide('b');
  assert.equal(views[0].webContents.closed,true,'opening b discarded hidden a');
  const discarded=controller.status('browser:a');
  assert.equal(discarded.url,'https://example.test/a2');assert.equal(discarded.canGoBack,true,'saved history still reports back navigation');
  show('a');
  assert.equal(views.length,3);assert.equal(liveViews().length,1);
  const revived=views[2].webContents;
  assert.deepEqual(revived.restored?.entries.map(entry=>entry.url),['https://example.test/a','https://example.test/a2']);
  assert.equal(revived.restored?.index,1);
  assert.equal(revived.restored?.entries[1].pageState,'state','scroll/form page state survives the discard');
  assert.equal(controller.status('browser:a').canGoBack,true);
  controller.dispose();
});

test('back on a discarded tab recreates it one entry earlier',()=>{
  const {controller,open,show,hide,views}=fixture({maxLiveViews:1});
  open('a');controller.navigate({owner:'browser:a',url:'https://example.test/a2'});hide('a');open('b');
  const state=controller.back('browser:a');
  assert.equal(state.url,'https://example.test/a');
  assert.equal(views.at(-1)!.webContents.restored?.index,0);
  assert.equal(views[1].webContents.closed,true,'b (hidden, least recent) made room');
  controller.dispose();
});

test('hidden pages idle beyond the limit are discarded; the most recent one stays warm',()=>{
  const {controller,open,show,hide,tick,liveViews}=fixture({idleDiscardMs:60_000});
  open('a');show('a');hide('a');open('b');show('b');hide('b');
  tick(30_000);assert.equal(controller.discardIdle(),0);
  tick(31_000);assert.equal(controller.discardIdle(),1);
  assert.equal(liveViews().length,1);
  assert.equal(controller.status('browser:b').url,'https://example.test/b');
  show('a');tick(120_000);assert.equal(controller.discardIdle(),1,'hidden b is discarded');
  assert.deepEqual(controller.stats(),{tabs:2,live:1,attached:1},'the visible page is never discarded');
  tick(600_000);assert.equal(controller.discardIdle(),0);
  controller.dispose();
});

test('closing a discarded tab releases its record and reports closure once',()=>{
  const {controller,open,hide,events}=fixture({maxLiveViews:1});
  open('a');hide('a');open('b');
  controller.close('browser:a');
  assert.deepEqual(events.filter(event=>event.type==='browserClosed'),[{type:'browserClosed',owner:'browser:a'}]);
  assert.throws(()=>controller.status('browser:a'),/closed/);
  assert.equal(controller.stats().tabs,1);
  controller.dispose();
});

test('late events from a discarded renderer cannot change the tab',()=>{
  const {controller,open,hide,views}=fixture({maxLiveViews:1});
  open('a');hide('a');open('b');
  views[0].webContents.emit('did-navigate',{},'https://evil.test/');
  views[0].webContents.emit('render-process-gone');
  assert.equal(controller.status('browser:a').url,'https://example.test/a');
  assert.equal(controller.status('browser:a').error,undefined);
  controller.dispose();
});

test('saved history is bounded and rejects entries outside the HTTP(S) policy',()=>{
  const many=Array.from({length:120},(_,i)=>({url:`https://example.test/${i}`,title:'x'.repeat(600),pageState:i===100?'y'.repeat(300*1024):'s'}));
  const saved=savedBrowserHistory(many,100)!;
  assert.equal(saved.entries.length,50);assert.equal(saved.entries[saved.index].url,'https://example.test/100');
  assert.equal(saved.entries[saved.index].pageState,undefined,'oversized page state is dropped');
  assert.equal(saved.entries[0].title.length,512);
  assert.equal(savedBrowserHistory([{url:'file:///etc/passwd',title:''}],0),undefined);
  assert.equal(savedBrowserHistory([],0),undefined);
  assert.equal(savedBrowserHistory(many,500),undefined);
});
