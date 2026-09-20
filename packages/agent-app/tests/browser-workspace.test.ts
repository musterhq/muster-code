import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {BrowserWorkspaceController,browserBounds,browserPartition,MAX_BROWSER_VIEWS} from '../src/main/browser-workspace.ts';
import {browserAddress,browserURL,type BrowserEvent} from '../src/shared/browser-protocol.ts';

class Contents extends EventEmitter {
  destroyed=false;loading=false;title='Fixture';url='about:blank';muted=false;loads:string[]=[];closed=false;stopped=false;reloads=0;index=-1;
  popup:(input:any)=>any=()=>{};
  navigationHistory={canGoBack:()=>this.index>0,canGoForward:()=>this.index<this.loads.length-1,goBack:()=>{this.index--;this.url=this.loads[this.index];this.emit('did-navigate',{},this.url);},goForward:()=>{this.index++;this.url=this.loads[this.index];this.emit('did-navigate',{},this.url);}};
  loadURL(url:string){this.loads=this.loads.slice(0,this.index+1);this.loads.push(url);this.index++;this.url=url;this.emit('did-start-navigation',{},url,false,true);return Promise.resolve();}
  isDestroyed(){return this.destroyed;}
  getTitle(){return this.title;}
  getURL(){return this.url;}
  isLoading(){return this.loading;}
  getZoomFactor(){return 1;}
  setAudioMuted(muted:boolean){this.muted=muted;}
  setWindowOpenHandler(handler:any){this.popup=handler;}
  reload(){this.reloads++;}
  stop(){this.stopped=true;}
  close(options:any){assert.equal(options.waitForBeforeUnload,false);this.destroyed=true;this.closed=true;this.emit('destroyed');}
}
class View {
  webContents=new Contents();visible=false;bounds:any;options:any;
  setVisible(visible:boolean){this.visible=visible;}
  setBackgroundColor(_color:string){}
  setBounds(bounds:any){this.bounds=bounds;}
}
class Session extends EventEmitter {
  permission:any;check:any;device:any;display:any;
  setPermissionRequestHandler(handler:any){this.permission=handler;}
  setPermissionCheckHandler(handler:any){this.check=handler;}
  setDevicePermissionHandler(handler:any){this.device=handler;}
  setDisplayMediaRequestHandler(handler:any){this.display=handler;}
}
function fixture(){
  const window=Object.assign(new EventEmitter(),{visible:true,minimized:false,destroyed:false,webContents:new Contents(),children:[] as View[],isDestroyed(){return this.destroyed;},isVisible(){return this.visible;},isMinimized(){return this.minimized;},getContentSize(){return [1000,800];},contentView:{addChildView(view:View){window.children.push(view);},removeChildView(view:View){window.children=window.children.filter(item=>item!==view);}}});
  const views:View[]=[],partitions=new Map<string,Session>(),events:BrowserEvent[]=[];
  const controller=new BrowserWorkspaceController(window as never,event=>events.push(event),{
    createView(options){const view=new View();view.options=options;views.push(view);return view as never;},
    getSession(partition){if(!partitions.has(partition))partitions.set(partition,new Session());return partitions.get(partition)! as never;},
  });
  const open=(id='one',profileId='personal',surfaceId='mount-one')=>controller.open({owner:`browser:${id}`,profileId,surfaceId,url:'https://example.test/'});
  const position=(id='one',surfaceId='mount-one')=>controller.position({owner:`browser:${id}`,surfaceId,bounds:{x:400,y:80,width:600,height:600}});
  return {window,views,partitions,events,controller,open,position};
}

test('browser URL policy rejects privileged schemes, credentials and control characters',()=>{
  for(const url of ['javascript:alert(1)','data:text/html,test','file:///etc/passwd','devtools://devtools','mailto:a@example.test','https://user:secret@example.test','https://example.test/\n','about:config',''])assert.throws(()=>browserURL(url));
  assert.equal(browserURL('about:blank'),'about:blank');
  assert.equal(browserURL(' https://example.test '),'https://example.test/');
  assert.equal(browserAddress('example.test/path'),'https://example.test/path');
  assert.equal(browserAddress('localhost:3000'),'http://localhost:3000/');
  assert.equal(browserAddress('example.test:8080'),'https://example.test:8080/');
  assert.notEqual(browserPartition('personal'),browserPartition('separate'));
  for(const profile of ['person@example.test','../secret','persist:default','',null])assert.throws(()=>browserPartition(profile));
});

test('geometry is clipped, zoom-aware and rejects malformed numbers',()=>{
  assert.deepEqual(browserBounds({x:-10,y:20,width:30,height:100},100,80),{x:0,y:20,width:20,height:60});
  assert.deepEqual(browserBounds({x:30,y:10,width:40,height:30},100,80,2),{x:60,y:20,width:40,height:60});
  assert.throws(()=>browserBounds({x:0,y:0,width:NaN,height:1},100,100));
  assert.throws(()=>browserBounds({x:0,y:0,width:-1,height:1},100,100));
});

test('remote contents are sandboxed, have no preload/Node bridge, and permissions/downloads/popups are denied',()=>{
  const {controller,open,views,partitions}=fixture();open();
  const preferences=views[0].options.webPreferences;
  assert.equal(preferences.sandbox,true);assert.equal(preferences.contextIsolation,true);assert.equal(preferences.nodeIntegration,false);
  assert.equal(preferences.nodeIntegrationInSubFrames,false);assert.equal(preferences.nodeIntegrationInWorker,false);
  assert.equal(preferences.webSecurity,true);assert.equal(preferences.webviewTag,false);assert.equal(preferences.preload,undefined);
  const session=[...partitions.values()][0];
  let granted=true;session.permission(null,'media',(value:boolean)=>{granted=value;});assert.equal(granted,false);
  assert.equal(session.check(),false);assert.equal(session.device(),false);
  let streams:any;session.display(null,(value:any)=>{streams=value;});assert.deepEqual(streams,{});
  let prevented=false;session.emit('will-download',{preventDefault(){prevented=true;}});assert.equal(prevented,true);
  assert.deepEqual(views[0].webContents.popup({url:'https://example.test/pop'}),{action:'deny'});
  for(const event of ['will-navigate','will-frame-navigate','will-redirect']){
    let blocked=false;views[0].webContents.emit(event,{url:'file:///secret',preventDefault(){blocked=true;}});assert.equal(blocked,true,event);
  }
  controller.dispose();
});

test('profile reuse is explicit and cannot replace the account storage of an existing tab',()=>{
  const {controller,open,partitions,views}=fixture();open('one','personal');open('two','personal');open('three','other');
  assert.equal(partitions.size,2);assert.equal(views[0].options.webPreferences.session,views[1].options.webPreferences.session);
  assert.notEqual(views[0].options.webPreferences.session,views[2].options.webPreferences.session);
  assert.throws(()=>open('one','other'),/different browser profile/);
  assert.throws(()=>controller.open({owner:'chat:one',profileId:'personal',surfaceId:'mount'}),/identity/);
  controller.dispose();
});

test('only one native surface attaches and old mounts cannot revive or hide another surface',()=>{
  const {controller,open,position,window,views}=fixture();open();position();assert.deepEqual(window.children,[views[0]]);
  open('two');position('two');assert.deepEqual(window.children,[views[1]]);assert.equal(views[0].visible,false);assert.equal(views[0].webContents.muted,true);
  controller.hide({owner:'browser:one',surfaceId:'mount-one'});assert.deepEqual(window.children,[views[1]]);
  open('two','personal','new-mount');position('two','new-mount');
  controller.hide({owner:'browser:two',surfaceId:'mount-one'});assert.deepEqual(window.children,[views[1]],'stale cleanup cannot hide the new mount');
  controller.hideAll(true);position('two','new-mount');assert.equal(window.children.length,0,'revoked geometry cannot reattach after app navigation');
  controller.dispose();
});

test('stale or hidden geometry cannot hide a newer native document through beforeReveal',()=>{
  const {controller,open,window}=fixture();open('one','personal','new-mount');
  let calls=0;
  const request={owner:'browser:one',surfaceId:'old-mount',bounds:{x:400,y:80,width:600,height:600}};
  controller.position(request,()=>calls++);assert.equal(calls,0);
  controller.position({...request,surfaceId:'new-mount',bounds:{x:0,y:0,width:0,height:0}},()=>calls++);assert.equal(calls,0);
  window.visible=false;controller.position({...request,surfaceId:'new-mount'},()=>calls++);assert.equal(calls,0);
  window.visible=true;controller.position({...request,surfaceId:'new-mount'},()=>calls++);assert.equal(calls,1);
  controller.dispose();
});

test('window hide/minimize and renderer navigation detach immediately; close destroys page history',()=>{
  const {controller,open,position,window,views}=fixture();open();position();
  window.visible=false;window.emit('hide');assert.equal(window.children.length,0);position();assert.equal(window.children.length,0);
  window.visible=true;position();assert.equal(window.children.length,1);
  window.emit('minimize');assert.equal(window.children.length,0);
  position();window.webContents.emit('did-start-loading');position();assert.equal(window.children.length,0);
  open('one','personal','new');position('one','new');controller.navigate({owner:'browser:one',url:'https://example.test/next'});
  assert.equal(controller.status('browser:one').canGoBack,true);
  controller.hide({owner:'browser:one',surfaceId:'new'});open('one','personal','again');assert.equal(views.length,1,'hide/reopen retains WebContents and history');
  controller.back('browser:one');assert.equal(controller.status('browser:one').canGoForward,true);
  controller.close('browser:one');assert.equal(views[0].webContents.closed,true);assert.equal(window.children.length,0);
  assert.throws(()=>controller.status('browser:one'),/closed/);
  open();assert.equal(views.length,2);assert.equal(controller.status('browser:one').canGoBack,false);
  controller.dispose();
});

test('bounded views, close cleanup and application disposal release remote contents and listeners',()=>{
  const {controller,open,views,partitions,window}=fixture();
  for(let index=0;index<MAX_BROWSER_VIEWS;index++)open(`tab-${index}`);
  assert.throws(()=>open('extra'),/maximum/);
  controller.close('browser:tab-0');open('extra');
  controller.dispose();controller.dispose();
  assert.ok(views.every(view=>view.webContents.closed));assert.equal(window.children.length,0);
  assert.equal(window.listenerCount('hide'),0);assert.equal(window.webContents.listenerCount('did-start-loading'),0);
  assert.ok([...partitions.values()].every(session=>session.listenerCount('will-download')===0));
  assert.throws(()=>open(),/closed/);
});

test('stopped or closed navigation promises cannot resurrect errors or native surfaces',async()=>{
  const {controller,open,views,events,position,window}=fixture();open();position();
  let reject!:(error:Error)=>void;
  views[0].webContents.loadURL=()=>new Promise((_resolve,onReject)=>{reject=onReject;});
  controller.navigate({owner:'browser:one',url:'https://example.test/slow'});controller.stop('browser:one');reject(new Error('late failure'));await Promise.resolve();
  assert.equal(controller.status('browser:one').error,undefined);
  controller.navigate({owner:'browser:one',url:'https://example.test/slow'});controller.close('browser:one');const count=events.length;
  reject(new Error('after close'));await Promise.resolve();assert.equal(events.length,count);assert.equal(window.children.length,0);
  controller.dispose();
});
