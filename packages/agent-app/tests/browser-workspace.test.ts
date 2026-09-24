import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BrowserWorkspaceController,browserBounds,browserPartition,MAX_BROWSER_VIEWS} from '../src/main/browser-workspace.ts';
import {browserAddress,browserScopeProfile,browserURL,type BrowserEvent} from '../src/shared/browser-protocol.ts';
import {consoleEntry,downloadFilename,pickedElement,uniqueFilename} from '../src/main/browser-inspect.ts';

let contentsIds=0;
class Contents extends EventEmitter {
  id=++contentsIds;emulation:any;scripts:string[]=[];pickResult:any=null;captured:any[]=[];
  enableDeviceEmulation(options:any){this.emulation=options;}
  disableDeviceEmulation(){this.emulation=undefined;}
  executeJavaScriptInIsolatedWorld(world:number,scripts:{code:string}[]){assert.equal(world,1047);this.scripts.push(scripts[0].code);return Promise.resolve(this.pickResult);}
  capturePage(rect?:any){this.captured.push(rect);return Promise.resolve({isEmpty:()=>false,getSize:()=>({width:rect?.width??600,height:rect?.height??400}),resize(){return this;},toDataURL:()=>'data:image/png;base64,AAAA'});}
  focus(){}
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
  permission:any;check:any;device:any;display:any;cleared=0;errorListener:any;completedListener:any;
  webRequest={onErrorOccurred:(listener:any)=>{this.errorListener=listener;},onCompleted:(listener:any)=>{this.completedListener=listener;}};
  clearStorageData(){this.cleared++;return Promise.resolve();}
  setPermissionRequestHandler(handler:any){this.permission=handler;}
  setPermissionCheckHandler(handler:any){this.check=handler;}
  setDevicePermissionHandler(handler:any){this.device=handler;}
  setDisplayMediaRequestHandler(handler:any){this.display=handler;}
}
const paths={downloads:fs.mkdtempSync(path.join(os.tmpdir(),'muster-dl-')),temp:fs.mkdtempSync(path.join(os.tmpdir(),'muster-tmp-'))};
test.after(()=>{for(const directory of Object.values(paths))fs.rmSync(directory,{recursive:true,force:true});});
class Item extends EventEmitter {
  savePath='';paused=false;resumed=false;cancelled=false;received=0;
  constructor(public name:string,public total:number){super();}
  setSavePath(value:string){this.savePath=value;}
  pause(){this.paused=true;}
  resume(){this.resumed=true;}
  cancel(){this.cancelled=true;this.emit('done',{},'cancelled');}
  getFilename(){return this.name;}
  getTotalBytes(){return this.total;}
  getReceivedBytes(){return this.received;}
}
function fixture(options:{maxLiveViews?:number}={}){
  const window=Object.assign(new EventEmitter(),{visible:true,minimized:false,destroyed:false,webContents:new Contents(),children:[] as View[],isDestroyed(){return this.destroyed;},isVisible(){return this.visible;},isMinimized(){return this.minimized;},getContentSize(){return [1000,800];},contentView:{addChildView(view:View){window.children.push(view);},removeChildView(view:View){window.children=window.children.filter(item=>item!==view);}}});
  const views:View[]=[],partitions=new Map<string,Session>(),events:BrowserEvent[]=[];
  const controller=new BrowserWorkspaceController(window as never,event=>events.push(event),{
    createView(options){const view=new View();view.options=options;views.push(view);return view as never;},
    getSession(partition){if(!partitions.has(partition))partitions.set(partition,new Session());return partitions.get(partition)! as never;},
    paths:()=>paths,
  },options);
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
  // Beyond the tab ceiling the oldest discarded (metadata-only) tab is dropped.
  open('extra');assert.throws(()=>controller.status('browser:tab-0'),/closed/);
  controller.close('browser:tab-1');open('extra-2');
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

test('profiles are bound to scope: folder and Project partitions never share storage with Personal',()=>{
  assert.equal(browserScopeProfile(undefined),'personal');
  assert.equal(browserScopeProfile({folderId:'repo-a'}),'folder-repo-a');
  assert.equal(browserScopeProfile({folderId:'repo-a',projectId:'p1'}),'project-p1','a Project spans folders and wins');
  assert.equal(browserScopeProfile({folderId:'weird id/..'}),'folder-weird_id___');
  assert.ok(browserScopeProfile({folderId:'x'.repeat(200)}).length<=64);
  const {controller,open,partitions}=fixture();
  open('one',browserScopeProfile({folderId:'a'}));open('two',browserScopeProfile({folderId:'b'}));open('three',browserScopeProfile({projectId:'p'}));open('four');
  assert.deepEqual([...partitions.keys()].sort(),['persist:muster-browser-folder-a','persist:muster-browser-folder-b','persist:muster-browser-personal','persist:muster-browser-project-p']);
  assert.deepEqual(controller.profiles().map(profile=>profile.id).sort(),['folder-a','folder-b','personal','project-p']);
  // Releasing a tab lets it reopen under another profile without a browserClosed report.
  controller.release('browser:one');open('one','personal');assert.equal(controller.status('browser:one').profileId,'personal');
  controller.dispose();
});

test('live pages beyond the cap evict the least recently used hidden page instead of failing',()=>{
  const {controller,open,position,views}=fixture({maxLiveViews:2});
  open('a');open('b');position('b','mount-b');open('c');
  assert.equal(controller.stats().live,2);assert.equal(views[0].webContents.destroyed,true,'a (oldest, hidden) was discarded');
  assert.equal(views[1].webContents.destroyed,false,'the visible page is never evicted');
  assert.equal(controller.status('browser:a').url,'https://example.test/','the discarded tab keeps its place');
  controller.dispose();
});

test('downloads wait for Save to Downloads or Cancel and never land silently',()=>{
  const {controller,open,views,partitions,events}=fixture();open();
  const session=[...partitions.values()][0],item=new Item('../../report.pdf',2048);
  let prevented=false;session.emit('will-download',{preventDefault(){prevented=true;}},item,views[0].webContents);
  assert.equal(prevented,false);assert.equal(item.paused,true,'paused until the user chooses');
  assert.ok(item.savePath.startsWith(path.join(paths.temp,'muster-browser-downloads')),'pending bytes stay out of Downloads');
  const state=controller.status('browser:one');
  assert.equal(state.download?.state,'pending');assert.equal(state.download?.filename,'report.pdf');
  assert.ok(events.some(event=>event.type==='browserState' && event.state.download?.state==='pending'),'the renderer is told');
  // A second download while one waits is refused with a notice.
  let second=false;session.emit('will-download',{preventDefault(){second=true;}},new Item('b.zip',1),views[0].webContents);
  assert.equal(second,true);assert.match(controller.status('browser:one').notice!,/Another download/);
  controller.download({owner:'browser:one',id:state.download!.id,action:'save'});
  assert.equal(item.resumed,true);assert.equal(controller.status('browser:one').download?.state,'saving');
  fs.writeFileSync(item.savePath,'pdf');item.emit('done',{},'completed');
  const saved=controller.status('browser:one').download!;
  assert.equal(saved.state,'saved');assert.equal(fs.readFileSync(path.join(paths.downloads,saved.savedName!),'utf8'),'pdf');
  assert.equal(controller.downloadPath('browser:one',saved.id),path.join(paths.downloads,saved.savedName!));
  controller.download({owner:'browser:one',id:saved.id,action:'dismiss'});assert.equal(controller.status('browser:one').download,undefined);
  // Cancel discards the pending file.
  const other=new Item('report.pdf',10);session.emit('will-download',{preventDefault(){}},other,views[0].webContents);
  controller.download({owner:'browser:one',id:controller.status('browser:one').download!.id,action:'cancel'});
  assert.equal(other.cancelled,true);assert.equal(controller.status('browser:one').download?.state,'cancelled');
  assert.equal(downloadFilename('..\\.hidden\u0001'),'hidden_');assert.equal(uniqueFilename('a.pdf',name=>name==='a.pdf'),'a (1).pdf');
  controller.dispose();
});

test('pop-ups: only after a click in the opener, shown over the page, closed on return to the opener origin',(t)=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {controller,open,position,views,window}=fixture();open();position();
  const contents=views[0].webContents;contents.emit('did-navigate',{},'https://app.test/login');
  assert.deepEqual(contents.popup({url:'https://auth.test/oauth',disposition:'new-window',features:'width=500'}),{action:'deny'});
  assert.match(controller.status('browser:one').notice!,/did not come from a click/);
  contents.emit('input-event',{},{type:'mouseDown'});
  const response=contents.popup({url:'https://auth.test/oauth',disposition:'new-window',features:'width=500'});
  assert.equal(response.action,'allow');assert.equal(response.overrideBrowserWindowOptions.webPreferences.sandbox,true);
  response.createWindow({webPreferences:{}});
  const popup=views.at(-1)!;
  assert.equal(popup.options.webPreferences.nodeIntegration,false);assert.equal(popup.options.webPreferences.contextIsolation,true);
  assert.ok(window.children.includes(popup),'the pop-up sits over the visible page');
  assert.equal(controller.status('browser:one').popup?.url,'https://auth.test/oauth');
  assert.equal(contents.popup({url:'https://auth.test/other',disposition:'new-window',features:''}).action,'deny','one sign-in window at a time');
  popup.webContents.emit('did-navigate',{},'https://auth.test/consent');assert.equal(popup.webContents.closed,false);
  popup.webContents.emit('did-navigate',{},'https://app.test/callback?code=1');
  t.mock.timers.tick(1500);
  assert.equal(popup.webContents.closed,true);assert.equal(controller.status('browser:one').popup,undefined);assert.ok(!window.children.includes(popup));
  // target=_blank links open in this tab after a click.
  contents.emit('input-event',{},{type:'mouseDown'});
  assert.deepEqual(contents.popup({url:'https://docs.test/',disposition:'foreground-tab',features:''}),{action:'deny'});
  assert.equal(controller.status('browser:one').url,'https://docs.test/');
  controller.dispose();
});

test('console and network errors are captured, bounded and clearable',async(t)=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {controller,open,views,partitions}=fixture();open();
  const contents=views[0].webContents;
  contents.emit('console-message',{message:'boom',level:'error',lineNumber:4,sourceId:'https://example.test/a.js'});
  contents.emit('console-message',{},1,'legacy info',2,'https://example.test/b.js');
  [...partitions.values()][0].errorListener({webContentsId:contents.id,error:'net::ERR_NAME_NOT_RESOLVED',method:'GET',url:'https://cdn.test/x.js'});
  [...partitions.values()][0].errorListener({webContentsId:contents.id,error:'net::ERR_ABORTED',method:'GET',url:'https://cdn.test/y.js'});
  [...partitions.values()][0].completedListener({webContentsId:contents.id,statusCode:503,method:'GET',url:'https://api.test/z',resourceType:'xhr'});
  const log=controller.console({owner:'browser:one'});
  assert.deepEqual(log.map(entry=>entry.level),['error','info','network','network']);
  assert.equal(log[0].line,4);assert.match(log[2].message,/ERR_NAME_NOT_RESOLVED/);
  t.mock.timers.tick(300);
  assert.equal(controller.status('browser:one').consoleErrors,3);
  for(let index=0;index<250;index++)contents.emit('console-message',{message:`m${index}`,level:'info',lineNumber:0,sourceId:''});
  assert.equal(controller.console({owner:'browser:one'}).length,200);
  assert.ok(controller.status('browser:one').consoleCount>200,'the count keeps moving past the kept window so an open drawer refreshes');
  assert.deepEqual(controller.console({owner:'browser:one',clear:true}),[]);assert.equal(controller.status('browser:one').consoleErrors,0);assert.equal(controller.status('browser:one').consoleCount,0);
  assert.equal(consoleEntry([{}, 'not-a-message'],1),undefined);
  controller.dispose();
});

test('certificate errors are refused, explained, and hand off to the system browser',()=>{
  const {controller,open,views}=fixture();open();
  let trusted:boolean|undefined,prevented=false;
  views[0].webContents.emit('certificate-error',{preventDefault(){prevented=true;}},'https://expired.test/','net::ERR_CERT_DATE_INVALID',{},(value:boolean)=>{trusted=value;},true);
  assert.equal(prevented,true);assert.equal(trusted,false);
  assert.deepEqual(controller.status('browser:one').certificateError,{url:'https://expired.test/',code:'net::ERR_CERT_DATE_INVALID'});
  assert.equal(controller.externalURL('browser:one'),'https://expired.test/');
  views[0].webContents.emit('did-fail-load',{},-201,'ERR_CERT_DATE_INVALID','https://example.test/',true);
  assert.equal(controller.status('browser:one').error,undefined,'the interstitial is the one explanation');
  open('blank','personal','m');controller.navigate({owner:'browser:blank',url:'about:blank'});
  assert.throws(()=>controller.externalURL('browser:blank'),/Open a page/);
  controller.dispose();
});

test('viewport presets, element pick and capture work on the live page',async()=>{
  const {controller,open,position,views}=fixture();open();position();
  controller.setViewport({owner:'browser:one',preset:'mobile'});
  assert.deepEqual(views[0].bounds,{x:505,y:80,width:390,height:600});assert.equal(views[0].webContents.emulation.screenPosition,'mobile');
  controller.setViewport({owner:'browser:one',preset:'desktop'});
  assert.deepEqual(views[0].bounds,{x:400,y:80,width:600,height:600});assert.equal(views[0].webContents.emulation.viewSize.width,1280);
  controller.setViewport({owner:'browser:one',preset:'fill'});assert.equal(views[0].webContents.emulation,undefined);
  assert.throws(()=>controller.setViewport({owner:'browser:one',preset:'watch' as never}),/Unknown viewport/);
  views[0].webContents.pickResult={selector:'main > button',tag:'button',outerHTML:'<button>Save</button>'+'x'.repeat(5000),text:'Save',rect:{x:-5,y:10,width:40,height:20}};
  const picked=await controller.pickElement('browser:one');
  assert.equal(picked?.selector,'main > button');assert.equal(picked?.truncated,true);assert.equal(picked?.outerHTML.length,4000);
  assert.deepEqual(picked?.rect,{x:0,y:10,width:35,height:20});assert.equal(picked?.url,'https://example.test/');
  assert.equal(pickedElement({selector:''},'u'),null);
  views[0].webContents.pickResult={rect:{x:10,y:20,width:100,height:50}};
  const shot=await controller.capture({owner:'browser:one',select:true});
  assert.deepEqual(views[0].webContents.captured.at(-1),{x:10,y:20,width:100,height:50});assert.equal(shot?.dataUrl,'data:image/png;base64,AAAA');
  views[0].webContents.pickResult=null;assert.equal(await controller.capture({owner:'browser:one',select:true}),null,'Escape cancels');
  await controller.clearData('personal');assert.equal(views[0].webContents.reloads,1);
  controller.dispose();
});
