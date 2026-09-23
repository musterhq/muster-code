import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {BrowserWindow, DownloadItem, NavigationEntry, Session, WebContents, WebContentsView, WebContentsViewConstructorOptions, WebPreferences} from 'electron';
import {BROWSER_VIEWPORTS, browserURL, type BrowserBounds, type BrowserCapture, type BrowserCommands, type BrowserConsoleEntry, type BrowserDownload, type BrowserEvent, type BrowserPickedElement, type BrowserProfile, type BrowserState, type BrowserSurface, type BrowserViewport} from '../shared/browser-protocol.ts';
import type {BrowserSessionVault, SavedBrowserSession} from './browser-session-vault.ts';
import {BROWSER_CANCEL_PICK_SCRIPT, BROWSER_PICK_WORLD, browserPickScript, consoleEntry, downloadFilename, faviconURL, MAX_CONSOLE_ENTRIES, pickedElement, pickedRect, uniqueFilename} from './browser-inspect.ts';

/** Browser tabs (live or discarded) tracked across every chat workspace. */
export const MAX_BROWSER_VIEWS=16;
/** Each live WebContents is a Chromium renderer process (commonly 100-300 MB).
 * Only this many stay resident; the least recently used hidden page is discarded. */
export const MAX_LIVE_BROWSER_VIEWS=3;
/** A hidden page that has not been shown for this long is discarded. */
export const BROWSER_IDLE_DISCARD_MS=10*60_000;
/** PER-04: a hidden page an agent touched stays running this long before it is frozen again. */
export const BROWSER_FREEZE_AFTER_MS=15_000;
const MAX_SAVED_HISTORY=50, MAX_SAVED_PAGE_STATE=256*1024;
/** A pop-up is allowed only this soon after a click or key press in the opener page. */
export const BROWSER_POPUP_GESTURE_MS=5000;
/** An unanswered download is cancelled after this long. */
export const BROWSER_DOWNLOAD_DECISION_MS=5*60_000;
const MAX_FAVICON_BYTES=64*1024, MAX_CAPTURE_WIDTH=2560, POPUP_RETURN_CLOSE_MS=1500;
export interface BrowserRuntime {
  createView(options:WebContentsViewConstructorOptions):WebContentsView;
  getSession(partition:string):Session;
  /** Pending downloads land in temp; Save moves them into downloads. */
  paths?():{downloads:string; temp:string};
}
export interface BrowserWorkspaceOptions {maxLiveViews?:number; idleDiscardMs?:number; now?:()=>number; sweepIntervalMs?:number; freezeHidden?:boolean; freezeAfterMs?:number; /** BRW-06: encrypted restore of tab history across restarts. */ vault?:BrowserSessionVault}
/** Optional Electron >= 32 history APIs; test doubles and older runtimes may omit them. */
interface HistoryAccess {getAllEntries?():NavigationEntry[]; getActiveIndex?():number; restore?(options:{entries:NavigationEntry[];index?:number}):Promise<void>}
function electronRuntime():BrowserRuntime {
  // The main bundle is CommonJS. Tests inject a runtime and never load Electron.
  const {WebContentsView,session,app}=createRequire(__filename)('electron') as typeof import('electron');
  return {createView:options=>new WebContentsView(options),getSession:partition=>session.fromPartition(partition),paths:()=>({downloads:app.getPath('downloads'),temp:app.getPath('temp')})};
}
export function browserPartition(profileId:unknown):string {
  if(typeof profileId!=='string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(profileId)) throw new Error('Invalid browser profile identity.');
  return `persist:muster-browser-${profileId}`;
}
function validOwner(owner:unknown):asserts owner is string {
  if(typeof owner!=='string' || !/^browser:[a-zA-Z0-9_-]{1,128}$/.test(owner)) throw new Error('Invalid browser tab identity.');
}
function validSurface(surfaceId:unknown):asserts surfaceId is string {
  if(typeof surfaceId!=='string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(surfaceId)) throw new Error('Invalid browser surface identity.');
}
/** Intersect CSS geometry with the app content area; never expand negative bounds. */
export function browserBounds(value:unknown,width:number,height:number,zoom=1):BrowserBounds {
  const bounds=value as BrowserBounds;
  if(!bounds || ![bounds.x,bounds.y,bounds.width,bounds.height].every(n=>typeof n==='number' && Number.isFinite(n)) || bounds.width<0 || bounds.height<0 || !Number.isFinite(zoom) || zoom<=0) throw new Error('Invalid browser bounds.');
  const x=Math.ceil(Math.max(0,Math.min(width,bounds.x*zoom))), y=Math.ceil(Math.max(0,Math.min(height,bounds.y*zoom)));
  const right=Math.floor(Math.max(x,Math.min(width,(bounds.x+bounds.width)*zoom))), bottom=Math.floor(Math.max(y,Math.min(height,(bounds.y+bounds.height)*zoom)));
  return {x,y,width:right-x,height:bottom-y};
}
export interface SavedBrowserHistory {entries:NavigationEntry[]; index:number}
interface PendingDownload {info:BrowserDownload; item:DownloadItem; tempPath:string; savedPath?:string; timer?:ReturnType<typeof setTimeout>}
interface Popup {view:WebContentsView; openerOrigin:string; url:string; title:string; attached:boolean; closeTimer?:ReturnType<typeof setTimeout>}
interface Entry {
  owner:string; profileId:string; surfaceId:string;
  /** Undefined while discarded: the tab keeps its URL/history but owns no renderer process. */
  view?:WebContentsView; attached:boolean;
  url:string; title:string; favicon?:string; revision:number; error?:string; notice?:string; navigation:number;
  certificateError?:{url:string;code:string};
  lastUsed:number; hiddenAt:number; history?:SavedBrowserHistory;
  viewport:BrowserViewport; hostBounds?:BrowserBounds; emulation?:string;
  console:BrowserConsoleEntry[]; consoleTotal:number; consoleErrors:number; consoleTimer?:ReturnType<typeof setTimeout>;
  lastGesture:number; download?:PendingDownload; popup?:Popup;
  /** PER-04: true while the hidden page's lifecycle is frozen (no timers, rAF, network callbacks or JS). */
  frozen?:boolean;
}
const SECURE_PREFERENCES:WebPreferences={contextIsolation:true,sandbox:true,nodeIntegration:false,nodeIntegrationInWorker:false,nodeIntegrationInSubFrames:false,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false,plugins:false,devTools:false,spellcheck:false,navigateOnDragDrop:false,disableDialogs:true,backgroundThrottling:true};
const originOf=(url:string)=>{try{return new URL(url).origin;}catch{return '';}};
type LiveEntry=Entry & {view:WebContentsView};

/** Bounded, validated copy of a page's back/forward stack for lazy recreation.
 * Any entry outside the HTTP(S) policy invalidates the copy (the tab then reloads its URL). */
export function savedBrowserHistory(entries:unknown,index:unknown):SavedBrowserHistory|undefined {
  if(!Array.isArray(entries) || !entries.length || typeof index!=='number' || !Number.isInteger(index) || index<0 || index>=entries.length) return undefined;
  const start=Math.max(0,Math.min(index-Math.floor(MAX_SAVED_HISTORY/2),entries.length-MAX_SAVED_HISTORY));
  const kept:NavigationEntry[]=[];
  for(const item of entries.slice(start,start+MAX_SAVED_HISTORY) as Partial<NavigationEntry>[]){
    let url:string;
    try {url=browserURL(item?.url);} catch {return undefined;}
    const title=typeof item.title==='string'?item.title.slice(0,512):'';
    kept.push({url,title,...(typeof item.pageState==='string' && item.pageState.length<=MAX_SAVED_PAGE_STATE?{pageState:item.pageState}:{})});
  }
  return {entries:kept,index:index-start};
}

/** Local browser profiles share cookies only within the same opaque profile ID.
 * Chromium enforces origin boundaries inside each profile. Back/forward history
 * lives in its WebContents while live. At most MAX_LIVE_BROWSER_VIEWS pages stay
 * resident: least-recently-used or long-hidden pages are discarded (renderer
 * process released) and recreated from a bounded history copy when shown or
 * used again. Close/restart discards history.
 */
export class BrowserWorkspaceController {
  private entries=new Map<string,Entry>();
  private protectedSessions=new Map<Session,()=>void>();
  private profileIds=new Set<string>(['personal']);
  private favicons=new Map<string,string>();
  private disposed=false;
  private runtime:BrowserRuntime;
  private ownerContents:WebContents;
  private maxLive:number; private idleMs:number; private now:()=>number;
  private freezeHidden:boolean; private freezeAfterMs:number;
  private sweeper?:ReturnType<typeof setInterval>;
  private onHide=()=>this.hideAll();
  private onRendererNavigation=()=>this.hideAll(true);
  private onClosed=()=>this.dispose();
  private vault?:BrowserSessionVault;
  constructor(private window:BrowserWindow,private emit:(event:BrowserEvent)=>void,runtime?:BrowserRuntime,options:BrowserWorkspaceOptions={}) {
    this.runtime=runtime??electronRuntime();
    this.maxLive=Math.max(1,Math.floor(options.maxLiveViews??MAX_LIVE_BROWSER_VIEWS));
    this.idleMs=Math.max(1000,options.idleDiscardMs??BROWSER_IDLE_DISCARD_MS);
    this.now=options.now??Date.now;
    this.vault=options.vault;
    this.freezeHidden=options.freezeHidden??true;
    this.freezeAfterMs=Math.max(0,options.freezeAfterMs??BROWSER_FREEZE_AFTER_MS);
    this.ownerContents=window.webContents;
    window.on('hide',this.onHide); window.on('minimize',this.onHide); window.on('closed',this.onClosed);
    this.ownerContents.on('did-start-loading',this.onRendererNavigation);
    this.sweeper=setInterval(()=>{this.discardIdle();this.freezeIdle();this.persistSessions();},Math.max(1000,options.sweepIntervalMs??60_000));
    this.sweeper.unref?.();
  }
  private assertAlive():void {if(this.disposed || this.window.isDestroyed()) throw new Error('Browser workspace is closed.');}
  /** The tab record, live or discarded. */
  private record(owner:unknown):Entry {
    this.assertAlive();validOwner(owner);
    const entry=this.entries.get(owner);
    if(!entry || entry.view?.webContents.isDestroyed()) throw new Error('Browser tab is closed. Open it again to continue.');
    return entry;
  }
  /** Commands that need a page recreate a discarded tab from its saved state. */
  private entry(owner:unknown,historyOffset=0):LiveEntry {
    const entry=this.record(owner);
    entry.lastUsed=this.now();
    if(!entry.view) this.revive(entry,historyOffset);
    else this.setFrozen(entry,false);
    return entry as LiveEntry;
  }
  private protect(session:Session):void {
    if(this.protectedSessions.has(session)) return;
    session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    session.setPermissionCheckHandler(()=>false);
    session.setDevicePermissionHandler(()=>false);
    session.setDisplayMediaRequestHandler((_request,callback)=>callback({}));
    const download=(event:{preventDefault():void},item?:DownloadItem,contents?:WebContents)=>this.willDownload(event,item,contents);
    session.on('will-download',download);
    // One listener per session: network failures and 4xx/5xx responses feed each tab's console.
    const requests=(session as Partial<Session>).webRequest;
    requests?.onErrorOccurred?.(details=>{
      if(details.error==='net::ERR_ABORTED') return;
      this.network(details.webContentsId,`${details.error} ${details.method} ${details.url}`,true);
    });
    requests?.onCompleted?.(details=>{
      if(details.statusCode>=400) this.network(details.webContentsId,`${details.statusCode} ${details.method} ${details.url}`,details.statusCode>=500 || details.resourceType==='mainFrame');
    });
    this.protectedSessions.set(session,()=>{
      session.off('will-download',download);
      requests?.onErrorOccurred?.(null);requests?.onCompleted?.(null);
    });
  }
  private byContents(contents:WebContents|undefined):Entry|undefined {
    if(!contents) return undefined;
    for(const entry of this.entries.values()) if(entry.view?.webContents===contents || entry.popup?.view.webContents===contents) return entry;
    return undefined;
  }
  private network(contentsId:number|undefined,message:string,error:boolean):void {
    const entry=[...this.entries.values()].find(candidate=>candidate.view && (candidate.view.webContents.id===contentsId || candidate.popup?.view.webContents.id===contentsId));
    if(entry) this.log(entry,{level:'network',message:message.slice(0,2000),source:'',line:0,at:this.now()},error);
  }
  private log(entry:Entry,item:BrowserConsoleEntry,error:boolean):void {
    entry.console.push(item);entry.consoleTotal++;
    if(entry.console.length>MAX_CONSOLE_ENTRIES) entry.console.splice(0,entry.console.length-MAX_CONSOLE_ENTRIES);
    if(error) entry.consoleErrors++;
    // Noisy pages log in bursts; one state report per quarter second is enough for the badge.
    if(!entry.consoleTimer){entry.consoleTimer=setTimeout(()=>{entry.consoleTimer=undefined;this.publish(entry);},250);entry.consoleTimer.unref?.();}
  }
  /** Nothing is written to Downloads until the user chooses Save. */
  private willDownload(event:{preventDefault():void},item?:DownloadItem,contents?:WebContents):void {
    const entry=this.byContents(contents), paths=this.runtime.paths?.();
    if(!item || !entry || !paths){event.preventDefault();if(entry){entry.notice='Downloads are not available in this browser.';this.publish(entry);}return;}
    if(entry.download && (entry.download.info.state==='pending' || entry.download.info.state==='saving')){event.preventDefault();entry.notice='Another download is waiting. Save or cancel it first.';this.publish(entry);return;}
    this.clearDownload(entry);
    const id=randomUUID(), directory=path.join(paths.temp,'muster-browser-downloads');
    try {fs.mkdirSync(directory,{recursive:true,mode:0o700});} catch {event.preventDefault();entry.notice='The download could not be prepared.';this.publish(entry);return;}
    const tempPath=path.join(directory,id);
    item.setSavePath(tempPath);item.pause();
    const pending:PendingDownload={item,tempPath,info:{id,filename:downloadFilename(item.getFilename()),totalBytes:Math.max(0,item.getTotalBytes()||0),receivedBytes:0,state:'pending'}};
    entry.download=pending;
    pending.timer=setTimeout(()=>{if(entry.download===pending && pending.info.state==='pending'){item.cancel();}},BROWSER_DOWNLOAD_DECISION_MS);pending.timer.unref?.();
    item.on('updated',()=>{if(entry.download!==pending)return;pending.info.receivedBytes=item.getReceivedBytes();pending.info.totalBytes=Math.max(pending.info.totalBytes,item.getTotalBytes()||0);this.publish(entry);});
    item.once('done',(_event,state)=>{
      clearTimeout(pending.timer);
      if(state==='completed' && pending.info.state==='saving' && paths){
        try {
          const name=uniqueFilename(pending.info.filename,candidate=>fs.existsSync(path.join(paths.downloads,candidate)));
          const target=path.join(paths.downloads,name);
          try {fs.renameSync(tempPath,target);} catch {fs.copyFileSync(tempPath,target,fs.constants.COPYFILE_EXCL);fs.rmSync(tempPath,{force:true});}
          pending.savedPath=target;pending.info={...pending.info,state:'saved',savedName:name,receivedBytes:pending.info.totalBytes||pending.info.receivedBytes};
        } catch {pending.info={...pending.info,state:'failed'};fs.rmSync(tempPath,{force:true});}
      } else {pending.info={...pending.info,state:state==='cancelled'?'cancelled':'failed'};fs.rmSync(tempPath,{force:true});}
      if(entry.download===pending && this.entries.get(entry.owner)===entry)this.publish(entry);
    });
    this.publish(entry);
  }
  private clearDownload(entry:Entry):void {
    const pending=entry.download;if(!pending)return;
    entry.download=undefined;clearTimeout(pending.timer);
    if(pending.info.state==='pending' || pending.info.state==='saving'){try {pending.item.cancel();} catch {/* Already finished. */}}
  }
  private snapshot(entry:Entry):BrowserState {
    const contents=entry.view?.webContents, history=entry.history;
    return {owner:entry.owner,profileId:entry.profileId,revision:entry.revision,url:entry.url,
      title:(contents?contents.getTitle():entry.title).slice(0,512),loading:contents?contents.isLoading():false,
      canGoBack:contents?contents.navigationHistory.canGoBack():!!history && history.index>0,
      canGoForward:contents?contents.navigationHistory.canGoForward():!!history && history.index<history.entries.length-1,
      visible:entry.attached,viewport:entry.viewport,consoleCount:entry.consoleTotal,consoleErrors:entry.consoleErrors,
      ...(entry.favicon?{favicon:entry.favicon}:{}),...(entry.error?{error:entry.error}:{}),...(entry.certificateError?{certificateError:{...entry.certificateError}}:{}),
      ...(entry.notice?{notice:entry.notice}:{}),...(entry.download?{download:{...entry.download.info}}:{}),...(entry.popup?{popup:{url:entry.popup.url,title:entry.popup.title.slice(0,256)}}:{})};
  }
  private publish(entry:Entry):void {
    if(this.disposed || this.entries.get(entry.owner)!==entry || entry.view?.webContents.isDestroyed()) return;
    entry.revision++; this.emit({type:'browserState',state:this.snapshot(entry)});
  }
  private detach(entry:Entry):void {
    const view=entry.view;
    if(view && !view.webContents.isDestroyed()){view.setVisible(false);view.webContents.setAudioMuted(true);}
    if(view && entry.attached && !this.window.isDestroyed()) this.window.contentView.removeChildView(view);
    this.detachPopup(entry);
    const changed=entry.attached; entry.attached=false;
    if(changed){entry.hiddenAt=this.now();this.publish(entry);}
    // A hidden page keeps its renderer (fast return) but runs nothing: timers, animation and JS stop.
    this.setFrozen(entry,true);
  }
  /** PER-04: Chromium's page lifecycle freeze through the page's own DevTools protocol client.
   * Best effort: a runtime without webContents.debugger (or one already attached elsewhere) keeps
   * the page throttled instead. Frozen pages never lose state; showing or using them thaws first. */
  private setFrozen(entry:Entry,frozen:boolean):void {
    if(frozen && !this.freezeHidden) return;
    const contents=entry.view?.webContents;
    if(!contents || contents.isDestroyed() || !!entry.frozen===frozen) return;
    if(frozen && (entry.attached || entry.download?.info.state==='saving')) return;
    const client=(contents as Partial<WebContents>).debugger;
    if(!client) return;
    try {if(!client.isAttached()) client.attach('1.3');} catch {return;}
    entry.frozen=frozen;
    void client.sendCommand('Page.setWebLifecycleState',{state:frozen?'frozen':'active'}).catch(()=>{if(entry.frozen===frozen)entry.frozen=undefined;});
  }
  /** Re-freeze hidden pages an agent woke once they have been idle for freezeAfterMs. */
  freezeIdle(now=this.now()):number {
    if(this.disposed || !this.freezeHidden) return 0;
    let frozen=0;
    for(const entry of this.live()) if(!entry.attached && !entry.frozen && now-entry.lastUsed>=this.freezeAfterMs){this.setFrozen(entry,true);if(entry.frozen)frozen++;}
    return frozen;
  }
  private createView(entry:Entry):WebContentsView {
    const session=this.runtime.getSession(browserPartition(entry.profileId));this.protect(session);
    this.profileIds.add(entry.profileId);
    const view=this.runtime.createView({webPreferences:{session,...SECURE_PREFERENCES}});
    entry.emulation=undefined;
    view.setVisible(false);view.setBackgroundColor('#181818');view.webContents.setAudioMuted(true);
    // Hidden pages must not keep timers and animation running at foreground rates.
    (view.webContents as Partial<WebContents>).setBackgroundThrottling?.(true);
    entry.view=view;this.wire(entry,view);
    return view;
  }
  private wire(entry:Entry,view:WebContentsView):void {
    const contents=view.webContents;
    // Handlers of a discarded or replaced page must never touch the tab again.
    const current=()=>entry.view===view && this.entries.get(entry.owner)===entry;
    const setURL=(url:string):boolean=>{try{entry.url=browserURL(url);return true;}catch{return false;}};
    const rejectNavigation=(event:{url:string;preventDefault():void})=>{
      try {browserURL(event.url);} catch {event.preventDefault();if(!current())return;entry.notice='This navigation was blocked. Only HTTP and HTTPS pages are supported.';this.publish(entry);}
    };
    contents.on('will-navigate',rejectNavigation);
    contents.on('will-frame-navigate',rejectNavigation);
    contents.on('will-redirect',rejectNavigation);
    contents.on('will-attach-webview',event=>event.preventDefault());
    contents.setWindowOpenHandler(details=>this.windowOpen(entry,view,details));
    contents.on('input-event',(_event,input)=>{if(/^(mouseDown|rawKeyDown|keyDown|touchStart|gestureTap)$/.test(input.type))entry.lastGesture=this.now();});
    contents.on('console-message',(...args:unknown[])=>{
      if(!current())return;
      const item=consoleEntry(args,this.now());if(item)this.log(entry,item,item.level==='error');
    });
    contents.on('page-favicon-updated',(_event,favicons)=>{if(current())void this.favicon(entry,view,faviconURL(favicons));});
    contents.on('certificate-error',(event,url,code,_certificate,callback,isMainFrame)=>{
      event.preventDefault();callback(false); // Never trusted in-app; the user may open the site externally.
      if(!current() || isMainFrame===false)return;
      let safe:string;try {safe=browserURL(url);} catch {return;}
      entry.certificateError={url:safe,code:String(code).slice(0,120)};entry.error=undefined;this.publish(entry);
    });
    contents.on('did-start-navigation',(_event,url,_inPlace,isMainFrame)=>{
      if(!current() || !isMainFrame)return;
      const origin=originOf(entry.url);
      if(setURL(url)){if(originOf(entry.url)!==origin)entry.favicon=undefined;entry.error=undefined;entry.notice=undefined;entry.certificateError=undefined;this.publish(entry);}
    });
    contents.on('did-redirect-navigation',(_event,url,_inPlace,isMainFrame)=>{if(current() && isMainFrame && setURL(url))this.publish(entry);});
    contents.on('did-navigate',(_event,url)=>{if(current() && setURL(url))this.publish(entry);});
    contents.on('did-navigate-in-page',(_event,url,isMainFrame)=>{if(current() && isMainFrame && setURL(url))this.publish(entry);});
    contents.on('did-start-loading',()=>{if(current())this.publish(entry);});
    contents.on('did-stop-loading',()=>{if(current())this.publish(entry);});
    contents.on('page-title-updated',()=>{if(current())this.publish(entry);});
    contents.on('did-fail-load',(_event,code,description,url,isMainFrame)=>{
      if(!current() || !isMainFrame || code===-3) return; // User stop/replacement is not a load failure.
      try {if(browserURL(url)!==entry.url)return;}catch{return;}
      if(entry.certificateError && code<=-200 && code>-300) return; // The interstitial already explains it.
      entry.error=`Could not load this page (${code}): ${description.slice(0,240)}`;this.publish(entry);
    });
    contents.on('render-process-gone',()=>{if(!current())return;entry.error='This browser page stopped unexpectedly. Reload to try again.';this.detach(entry);this.publish(entry);});
    contents.on('destroyed',()=>{
      if(!current()) return;
      this.detach(entry);this.entries.delete(entry.owner);entry.view=undefined;
      if(!this.disposed) this.emit({type:'browserClosed',owner:entry.owner});
    });
  }
  /** Tab-style opens (target=_blank) stay in this tab. A window.open pop-up (OAuth) is
   * allowed only right after a user gesture in this page, as one child view sharing
   * the partition, and closes once it returns to the opener's origin. */
  private windowOpen(entry:Entry,opener:WebContentsView,details:{url:string;disposition:string;features:string}):{action:'deny'}|{action:'allow';createWindow:(options:WebContentsViewConstructorOptions)=>WebContents;overrideBrowserWindowOptions:{webPreferences:WebPreferences}} {
    const current=entry.view===opener && this.entries.get(entry.owner)===entry;
    let url:string;
    try {url=browserURL(details.url);} catch {if(current){entry.notice='This pop-up was blocked. Only HTTP and HTTPS pages are supported.';this.publish(entry);}return {action:'deny'};}
    if(!current || url==='about:blank') return {action:'deny'};
    const gesture=this.now()-entry.lastGesture<=BROWSER_POPUP_GESTURE_MS;
    if(details.disposition==='foreground-tab' || details.disposition==='background-tab'){
      if(gesture) this.load(entry,url);
      else {entry.notice='A new tab was blocked because it did not come from a click.';this.publish(entry);}
      return {action:'deny'};
    }
    if(!gesture || entry.popup){entry.notice=entry.popup?'A sign-in window is already open. Finish or close it first.':'Pop-up blocked: it did not come from a click on this page.';this.publish(entry);return {action:'deny'};}
    const openerOrigin=originOf(entry.url);
    return {action:'allow',overrideBrowserWindowOptions:{webPreferences:{...SECURE_PREFERENCES}},createWindow:options=>{
      const view=this.runtime.createView({...options,webPreferences:{...options.webPreferences,...SECURE_PREFERENCES}} as WebContentsViewConstructorOptions);
      view.setBackgroundColor('#ffffff');view.setVisible(false);
      const popup:Popup={view,openerOrigin,url,title:'',attached:false};entry.popup=popup;this.wirePopup(entry,popup);
      if(entry.attached) this.layout(entry);
      this.publish(entry);
      return view.webContents;
    }};
  }
  private wirePopup(entry:Entry,popup:Popup):void {
    const contents=popup.view.webContents, live=()=>entry.popup===popup;
    const reject=(event:{url:string;preventDefault():void})=>{try {browserURL(event.url);} catch {event.preventDefault();}};
    contents.on('will-navigate',reject);contents.on('will-frame-navigate',reject);contents.on('will-redirect',reject);
    contents.on('will-attach-webview',event=>event.preventDefault());
    contents.setWindowOpenHandler(()=>({action:'deny'}));
    const navigated=(url:string)=>{
      if(!live())return;
      try {popup.url=browserURL(url);} catch {return;}
      // Back at the opener's origin: the flow is done. The callback page gets a moment to post its result.
      if(popup.openerOrigin && originOf(popup.url)===popup.openerOrigin && !popup.closeTimer){popup.closeTimer=setTimeout(()=>this.closePopupView(entry,popup),POPUP_RETURN_CLOSE_MS);popup.closeTimer.unref?.();}
      this.publish(entry);
    };
    contents.on('did-navigate',(_event,url)=>navigated(url));
    contents.on('did-redirect-navigation',(_event,url,_inPlace,isMainFrame)=>{if(isMainFrame)navigated(url);});
    contents.on('page-title-updated',(_event,title)=>{if(live()){popup.title=String(title??'');this.publish(entry);}});
    contents.on('console-message',(...args:unknown[])=>{if(!live())return;const item=consoleEntry(args,this.now());if(item)this.log(entry,{...item,message:`[pop-up] ${item.message}`},item.level==='error');});
    contents.on('destroyed',()=>{if(!live())return;clearTimeout(popup.closeTimer);this.removePopupView(entry,popup);entry.popup=undefined;if(this.entries.get(entry.owner)===entry)this.publish(entry);});
  }
  private detachPopup(entry:Entry):void {
    const popup=entry.popup;if(!popup)return;
    if(!popup.view.webContents.isDestroyed())popup.view.setVisible(false);
    this.removePopupView(entry,popup);
  }
  private removePopupView(_entry:Entry,popup:Popup):void {
    if(popup.attached && !this.window.isDestroyed())this.window.contentView.removeChildView(popup.view);
    popup.attached=false;
  }
  private closePopupView(entry:Entry,popup:Popup):void {
    clearTimeout(popup.closeTimer);popup.closeTimer=undefined;
    if(entry.popup!==popup)return;
    this.removePopupView(entry,popup);entry.popup=undefined;
    if(!popup.view.webContents.isDestroyed())popup.view.webContents.close({waitForBeforeUnload:false});
    if(this.entries.get(entry.owner)===entry)this.publish(entry);
  }
  /** Places the page for its viewport preset and any pop-up over it. */
  private layout(entry:LiveEntry|Entry):void {
    const view=entry.view,bounds=entry.hostBounds;
    if(!view || !bounds || view.webContents.isDestroyed())return;
    const contents=view.webContents as Partial<WebContents>;
    let placed=bounds,emulation='';
    if(entry.viewport!=='fill'){
      const width=BROWSER_VIEWPORTS[entry.viewport].width;
      if(width<=bounds.width) placed={x:bounds.x+Math.floor((bounds.width-width)/2),y:bounds.y,width,height:bounds.height};
      else {
        // Wider than the panel: lay the page out at the preset width and scale it down to fit.
        const scale=bounds.width/width,height=Math.max(1,Math.round(bounds.height/scale));
        emulation=JSON.stringify({width,height,scale,mobile:entry.viewport==='mobile'});
        if(entry.emulation!==emulation) contents.enableDeviceEmulation?.({screenPosition:entry.viewport==='mobile'?'mobile':'desktop',screenSize:{width,height},viewPosition:{x:0,y:0},deviceScaleFactor:0,viewSize:{width,height},scale});
      }
      if(!emulation && entry.viewport==='mobile'){
        emulation=`mobile:${placed.height}`;
        if(entry.emulation!==emulation) contents.enableDeviceEmulation?.({screenPosition:'mobile',screenSize:{width,height:placed.height},viewPosition:{x:0,y:0},deviceScaleFactor:0,viewSize:{width,height:placed.height},scale:1});
      }
    }
    if(!emulation && entry.emulation) contents.disableDeviceEmulation?.();
    entry.emulation=emulation||undefined;
    view.setBounds(placed);
    const popup=entry.popup;
    if(popup && entry.attached && !popup.view.webContents.isDestroyed()){
      const inset=Math.min(24,Math.floor(Math.min(bounds.width,bounds.height)/20));
      popup.view.setBounds({x:bounds.x+inset,y:bounds.y+inset,width:Math.max(1,bounds.width-inset*2),height:Math.max(1,bounds.height-inset*2)});
      if(!popup.attached){this.window.contentView.addChildView(popup.view);popup.attached=true;}
      popup.view.setVisible(true);
    }
  }
  private async favicon(entry:Entry,view:WebContentsView,url:string|undefined):Promise<void> {
    if(!url){if(entry.favicon){entry.favicon=undefined;this.publish(entry);}return;}
    const cached=this.favicons.get(url);
    if(cached!==undefined){if(entry.favicon!==(cached||undefined)){entry.favicon=cached||undefined;this.publish(entry);}return;}
    const session=this.runtime.getSession(browserPartition(entry.profileId)) as Partial<Session>;
    if(!session.fetch)return;
    let data='';
    try {
      const response=await session.fetch(url,{signal:AbortSignal.timeout(5000),credentials:'include'} as RequestInit);
      const type=(response.headers.get('content-type')??'').split(';')[0].trim().toLowerCase();
      if(response.ok && /^image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|gif|jpeg|webp)$/.test(type)){
        const bytes=Buffer.from(await response.arrayBuffer());
        if(bytes.length<=MAX_FAVICON_BYTES) data=`data:${type};base64,${bytes.toString('base64')}`;
      }
    } catch {/* No icon is not an error. */}
    if(this.favicons.size>=128) this.favicons.delete(this.favicons.keys().next().value!);
    this.favicons.set(url,data);
    if(entry.view!==view || this.entries.get(entry.owner)!==entry)return;
    entry.favicon=data||undefined;this.publish(entry);
  }
  /** Release the renderer process but keep URL, title and a bounded history copy. */
  private discard(entry:Entry):boolean {
    const view=entry.view;
    if(!view || entry.attached) return false;
    const contents=view.webContents;
    if(!contents.isDestroyed()){
      try {
        const history=contents.navigationHistory as unknown as HistoryAccess;
        entry.history=history.getAllEntries && history.getActiveIndex?savedBrowserHistory(history.getAllEntries(),history.getActiveIndex()):undefined;
      } catch {entry.history=undefined;}
      try {entry.title=contents.getTitle().slice(0,512);} catch {/* Keep the prior title. */}
    }
    if(entry.popup) this.closePopupView(entry,entry.popup);
    entry.view=undefined;entry.navigation++;entry.emulation=undefined;
    if(!contents.isDestroyed()) contents.close({waitForBeforeUnload:false});
    return true;
  }
  private revive(entry:Entry,historyOffset=0):void {
    this.assertAlive();
    this.enforceLiveLimit(entry,1);
    const view=this.createView(entry);
    const history=entry.history;entry.history=undefined;
    const index=history?Math.max(0,Math.min(history.entries.length-1,history.index+historyOffset)):0;
    const access=view.webContents.navigationHistory as unknown as HistoryAccess;
    if(history && access.restore){
      const navigation=++entry.navigation;entry.url=history.entries[index].url;entry.error=undefined;entry.notice=undefined;
      void access.restore({entries:history.entries,index}).catch(()=>{
        if(entry.view!==view || navigation!==entry.navigation || view.webContents.isDestroyed()) return;
        this.load(entry,entry.url);
      });
      this.publish(entry);
    } else this.load(entry,history?history.entries[index].url:entry.url);
  }
  private live():LiveEntry[] {return [...this.entries.values()].filter((entry):entry is LiveEntry=>!!entry.view);}
  /** Keep at most maxLive renderer processes, discarding least recently used hidden pages. */
  private enforceLiveLimit(keep?:Entry,reserve=0):void {
    const live=this.live();
    let excess=live.length+reserve-this.maxLive;
    if(excess<=0) return;
    for(const candidate of live.filter(entry=>entry!==keep && !entry.attached).sort((a,b)=>a.lastUsed-b.lastUsed)){
      if(excess<=0) break;
      if(this.discard(candidate)) excess--;
    }
  }
  /** Discard hidden pages idle beyond the limit. The most recently used page stays warm. */
  discardIdle(now=this.now()):number {
    if(this.disposed) return 0;
    let discarded=0;
    for(const entry of this.live().sort((a,b)=>b.lastUsed-a.lastUsed).slice(1))
      if(!entry.attached && now-Math.max(entry.hiddenAt,entry.lastUsed)>=this.idleMs && this.discard(entry)) discarded++;
    return discarded;
  }
  /** Resident-page counts for diagnostics and tests. */
  /** Hidden pages whose lifecycle is frozen right now. */
  frozenCount():number {return this.live().filter(entry=>entry.frozen).length;}
  stats():{tabs:number;live:number;attached:number} {
    const entries=[...this.entries.values()];
    return {tabs:entries.length,live:entries.filter(entry=>entry.view).length,attached:entries.filter(entry=>entry.attached).length};
  }
  open(input:BrowserCommands['browser.open']['input']):BrowserState {
    this.assertAlive();validOwner(input?.owner);validSurface(input?.surfaceId);
    browserPartition(input.profileId);
    const url=browserURL(input.url??'about:blank');
    const existing=this.entries.get(input.owner);
    if(existing){
      if(existing.profileId!==input.profileId) throw new Error('This tab belongs to a different browser profile. Open a new tab to change profiles.');
      existing.surfaceId=input.surfaceId;existing.lastUsed=this.now();this.detach(existing);
      if(!existing.view) this.revive(existing);
      this.publish(existing);return this.snapshot(existing);
    }
    if(this.entries.size>=MAX_BROWSER_VIEWS){
      // A discarded tab whose workspace is gone (deleted chat, abandoned scope)
      // is only metadata; drop the oldest one rather than refuse a new tab.
      const oldest=[...this.entries.values()].filter(entry=>!entry.view).sort((a,b)=>a.lastUsed-b.lastUsed)[0];
      if(oldest) this.forget(oldest);
    }
    if(this.entries.size>=MAX_BROWSER_VIEWS) throw new Error(`Close a browser tab before opening another (maximum ${MAX_BROWSER_VIEWS}).`);
    const now=this.now();
    const entry:Entry={owner:input.owner,profileId:input.profileId,surfaceId:input.surfaceId,attached:false,url,title:'',revision:0,navigation:0,lastUsed:now,hiddenAt:now,viewport:'fill',console:[],consoleTotal:0,consoleErrors:0,lastGesture:0};
    this.enforceLiveLimit(undefined,1);
    // BRW-06: a tab reopened after a restart gets its encrypted back/forward stack back (Chromium restores page state).
    const saved=this.vault?.take(input.owner,input.profileId);
    const unreadable=this.vault?.consumeUnreadableNotice()?'Saved browsing state could not be decrypted on this Mac. Sign in again if the page asks.':undefined;
    this.entries.set(entry.owner,entry);
    if(saved){
      // The renderer only persisted a redacted URL; the vault holds the real one (and the back/forward stack).
      try {entry.url=browserURL(saved.url);} catch {/* keep the requested URL */}
      entry.title=saved.title;if(saved.history)entry.history=saved.history;
      this.revive(entry);
    } else {this.createView(entry);this.load(entry,url);}
    if(unreadable){entry.notice=unreadable;this.publish(entry);}
    return this.snapshot(entry);
  }
  /** BRW-06: every open tab's URL and bounded history, for the encrypted vault. Never cookies or storage. */
  sessions():SavedBrowserSession[] {
    const at=this.now(), saved:SavedBrowserSession[]=[];
    for(const entry of this.entries.values()){
      let history=entry.history;
      const contents=entry.view?.webContents;
      if(contents && !contents.isDestroyed()){
        try {const access=contents.navigationHistory as unknown as HistoryAccess;history=access.getAllEntries && access.getActiveIndex?savedBrowserHistory(access.getAllEntries(),access.getActiveIndex()):undefined;} catch {history=undefined;}
      }
      let url:string;
      try {url=browserURL(entry.url);} catch {continue;}
      if(url==='about:blank' && !history) continue;
      saved.push({owner:entry.owner,profileId:entry.profileId,url,title:entry.title.slice(0,512),...(history?{history}:{}),savedAt:at});
    }
    return saved;
  }
  /** Best effort: a failure to encrypt or write never disturbs browsing. */
  persistSessions():void {
    if(!this.vault) return;
    try {this.vault.save(this.sessions());} catch {/* retried on the next sweep */}
  }
  private load(entry:Entry,url:string):void {
    const view=entry.view;if(!view) return;
    const navigation=++entry.navigation;entry.url=url;entry.error=undefined;entry.notice=undefined;
    void view.webContents.loadURL(url).catch(error=>{
      if(this.entries.get(entry.owner)!==entry || entry.view!==view || navigation!==entry.navigation || view.webContents.isDestroyed() || (error as {code?:string}).code==='ERR_ABORTED') return;
      entry.error=error instanceof Error?error.message.slice(0,320):'The page could not be loaded.';this.publish(entry);
    });
    this.publish(entry);
  }
  navigate(input:BrowserCommands['browser.navigate']['input']):BrowserState {this.record(input?.owner);const url=browserURL(input.url);const entry=this.entry(input.owner);this.load(entry,url);return this.snapshot(entry);}
  private step(owner:string,offset:-1|1):BrowserState {
    // A discarded page is recreated directly at the neighbouring history entry.
    if(!this.record(owner).view) return this.snapshot(this.entry(owner,offset));
    const entry=this.entry(owner),history=entry.view.webContents.navigationHistory;
    if(offset<0?history.canGoBack():history.canGoForward()){entry.navigation++;entry.error=undefined;if(offset<0)history.goBack();else history.goForward();}
    this.publish(entry);return this.snapshot(entry);
  }
  back(owner:string):BrowserState {return this.step(owner,-1);}
  forward(owner:string):BrowserState {return this.step(owner,1);}
  reload(owner:string):BrowserState {
    // Recreating a discarded page is its reload.
    if(!this.record(owner).view) return this.snapshot(this.entry(owner));
    const entry=this.entry(owner);entry.navigation++;entry.error=undefined;entry.notice=undefined;entry.view.webContents.reload();this.publish(entry);return this.snapshot(entry);
  }
  stop(owner:string):BrowserState {
    const entry=this.record(owner);
    if(entry.view){entry.navigation++;entry.view.webContents.stop();}
    this.publish(entry);return this.snapshot(entry);
  }
  /** Status never recreates a discarded page; showing (position) or using it does. */
  status(owner:string):BrowserState {return this.snapshot(this.record(owner));}
  position(input:BrowserCommands['browser.position']['input'],beforeReveal?:()=>void):void {
    const record=this.record(input?.owner);validSurface(input.surfaceId);
    if(record.surfaceId!==input.surfaceId) return;
    const [width,height]=this.window.getContentSize();
    const bounds=browserBounds(input.bounds,width,height,this.ownerContents.getZoomFactor());
    if(!this.window.isVisible() || this.window.isMinimized() || bounds.width<1 || bounds.height<1){this.detach(record);return;}
    beforeReveal?.();
    for(const other of this.entries.values()) if(other!==record) this.detach(other);
    const entry=this.entry(input.owner);
    entry.hostBounds=bounds;
    if(!entry.attached){this.window.contentView.addChildView(entry.view);entry.attached=true;}
    this.layout(entry);
    entry.view.setVisible(true);entry.view.webContents.setAudioMuted(false);this.publish(entry);
  }
  hide(input:BrowserSurface):void {
    validOwner(input?.owner);validSurface(input?.surfaceId);
    const entry=this.entries.get(input.owner);
    if(entry?.surfaceId===input.surfaceId){this.detach(entry);this.enforceLiveLimit();}
  }
  /** Parent calls this before switching resources or presenting native overlays. */
  hideAll(revokeSurfaces=false):void {for(const entry of this.entries.values()){if(revokeSurfaces) entry.surfaceId='';this.detach(entry);}}
  private forget(entry:Entry):void {
    this.detach(entry);
    if(entry.popup) this.closePopupView(entry,entry.popup);
    this.clearDownload(entry);clearTimeout(entry.consoleTimer);entry.consoleTimer=undefined;
    this.entries.delete(entry.owner);entry.navigation++;entry.history=undefined;
    const view=entry.view;entry.view=undefined;
    if(view && !view.webContents.isDestroyed()) view.webContents.close({waitForBeforeUnload:false});
  }
  close(owner:string):void {
    validOwner(owner);const entry=this.entries.get(owner);if(!entry)return;
    this.forget(entry);
    // Closing a tab forgets its saved session; shutdown (disposed) keeps it for the next launch.
    if(!this.disposed){try {this.vault?.forget(owner);} catch {} this.emit({type:'browserClosed',owner});}
  }
  /** Switching a tab's profile: drop its page silently so the renderer can reopen it. */
  release(owner:string):void {
    validOwner(owner);const entry=this.entries.get(owner);if(entry)this.forget(entry);
  }
  /** The page to hand to the system browser (the blocked URL for certificate failures). */
  externalURL(owner:string):string {
    const entry=this.record(owner),url=entry.certificateError?.url ?? entry.popup?.url ?? entry.url;
    if(url==='about:blank') throw new Error('Open a page first.');
    return browserURL(url);
  }
  console(input:BrowserCommands['browser.console']['input']):BrowserConsoleEntry[] {
    const entry=this.record(input?.owner);
    if(input.clear){entry.console=[];entry.consoleTotal=0;entry.consoleErrors=0;this.publish(entry);}
    return entry.console.map(item=>({...item}));
  }
  setViewport(input:BrowserCommands['browser.setViewport']['input']):BrowserState {
    const entry=this.record(input?.owner);
    if(input.preset!=='fill' && !Object.hasOwn(BROWSER_VIEWPORTS,input.preset)) throw new Error('Unknown viewport preset.');
    if(entry.viewport!==input.preset){entry.viewport=input.preset;if(entry.attached)this.layout(entry);this.publish(entry);}
    return this.snapshot(entry);
  }
  private async inspect(entry:LiveEntry,mode:'element'|'region'):Promise<unknown> {
    const contents=entry.view.webContents as Partial<WebContents>;
    if(!contents.executeJavaScriptInIsolatedWorld) throw new Error('Page inspection is not available in this browser.');
    if(!entry.attached) throw new Error('Show the page before picking from it.');
    contents.focus?.();
    return contents.executeJavaScriptInIsolatedWorld(BROWSER_PICK_WORLD,[{code:browserPickScript(mode)}],true);
  }
  async pickElement(owner:string):Promise<BrowserPickedElement|null> {
    const entry=this.entry(owner),url=entry.url,view=entry.view;
    const result=pickedElement(await this.inspect(entry,'element'),url);
    return entry.view===view?result:null;
  }
  cancelPick(owner:string):void {
    const entry=this.record(owner);
    void (entry.view?.webContents as Partial<WebContents>|undefined)?.executeJavaScriptInIsolatedWorld?.(BROWSER_PICK_WORLD,[{code:BROWSER_CANCEL_PICK_SCRIPT}]).catch(()=>{});
  }
  async capture(input:BrowserCommands['browser.capture']['input']):Promise<BrowserCapture|null> {
    const entry=this.entry(input?.owner),view=entry.view,contents=view.webContents as Partial<WebContents>;
    if(!contents.capturePage) throw new Error('Screenshots are not available in this browser.');
    let rect=input.rect===undefined?undefined:pickedRect(input.rect);
    if(input.rect!==undefined && !rect) throw new Error('Invalid capture region.');
    if(input.select){
      const selected=await this.inspect(entry,'region') as {rect?:unknown}|null;
      if(!selected) return null;
      rect=pickedRect(selected.rect);if(!rect) return null;
    }
    if(entry.view!==view) return null;
    // Region coordinates are CSS pixels; the page may be zoomed.
    const zoom=contents.getZoomFactor?.()||1;
    let image=await contents.capturePage(rect?{x:Math.round(rect.x*zoom),y:Math.round(rect.y*zoom),width:Math.max(1,Math.round(rect.width*zoom)),height:Math.max(1,Math.round(rect.height*zoom))}:undefined);
    if(image.isEmpty()) throw new Error('The page could not be captured. Show it and try again.');
    if(image.getSize().width>MAX_CAPTURE_WIDTH) image=image.resize({width:MAX_CAPTURE_WIDTH,quality:'better'});
    const size=image.getSize();
    return {dataUrl:image.toDataURL(),width:size.width,height:size.height,url:entry.url,title:(contents.getTitle?.()??entry.title).slice(0,512)};
  }
  /** RUN-X1: the agent's tab exists before any renderer surface mounts it; the right pane adopts it by owner. */
  agentOpen(owner:string,profileId:string,url?:string):BrowserState {
    this.assertAlive();validOwner(owner);browserPartition(profileId);
    const target=url===undefined?undefined:browserURL(url);
    const existing=this.entries.get(owner);
    if(!existing) return this.open({owner,surfaceId:'agent',profileId,url:target??'about:blank'});
    if(existing.profileId!==profileId) throw new Error('This browser tab belongs to a different profile.');
    const entry=this.entry(owner);
    if(target) this.load(entry,target);
    return this.snapshot(entry);
  }
  hasTab(owner:string):boolean {return this.entries.has(owner);}
  /** The live page for agent input; a discarded tab is recreated first. */
  agentPage(owner:string):{contents:WebContents;attached:boolean;fill:boolean;state:()=>BrowserState} {
    const entry=this.entry(owner);
    return {contents:entry.view.webContents,attached:entry.attached,fill:entry.viewport==='fill',state:()=>this.snapshot(entry)};
  }
  /** A small JPEG of the visible page for the live PiP; undefined while the page cannot be painted. */
  async frame(owner:string,width=640):Promise<{dataUrl:string;width:number;height:number;url:string;title:string}|undefined> {
    const entry=this.entries.get(owner),contents=entry?.view?.webContents as Partial<WebContents>|undefined;
    if(!entry || !contents?.capturePage || (contents as WebContents).isDestroyed()) return undefined;
    let image=await contents.capturePage(undefined,{stayHidden:true});
    if(image.isEmpty()) return undefined;
    if(image.getSize().width>width) image=image.resize({width,quality:'good'});
    const size=image.getSize();
    return {dataUrl:`data:image/jpeg;base64,${image.toJPEG(72).toString('base64')}`,width:size.width,height:size.height,url:entry.url,title:(contents.getTitle?.()??entry.title).slice(0,512)};
  }
  /** Profiles this session has used, with their open tab counts. Labels come from the caller. */
  profiles():BrowserProfile[] {
    const counts=new Map<string,number>([...this.profileIds].map(id=>[id,0]));
    for(const entry of this.entries.values()) counts.set(entry.profileId,(counts.get(entry.profileId)??0)+1);
    return [...counts].map(([id,tabs])=>({id,label:id==='personal'?'Personal':id,tabs}));
  }
  /** Sign-ins, cookies, storage and cache of one profile; its open pages reload signed out. */
  async clearData(profileId:string):Promise<void> {
    this.assertAlive();
    const session=this.runtime.getSession(browserPartition(profileId)) as Partial<Session>;
    await session.clearStorageData?.();await session.clearCache?.();await session.clearAuthCache?.();
    try {this.vault?.forgetProfile(profileId);} catch {/* the vault's rows for this profile expire anyway */}
    for(const entry of this.entries.values()) if(entry.profileId===profileId && entry.view && !entry.view.webContents.isDestroyed()){entry.view.webContents.reload();this.publish(entry);}
  }
  download(input:BrowserCommands['browser.download']['input']):BrowserState {
    const entry=this.record(input?.owner),pending=entry.download;
    if(!pending || pending.info.id!==input.id) throw new Error('This download is no longer available.');
    if(input.action==='save'){
      if(pending.info.state!=='pending') throw new Error('This download was already handled.');
      clearTimeout(pending.timer);pending.info={...pending.info,state:'saving'};pending.item.resume();
    } else if(input.action==='cancel'){
      if(pending.info.state==='pending' || pending.info.state==='saving'){clearTimeout(pending.timer);pending.item.cancel();}
      else entry.download=undefined;
    } else if(input.action==='dismiss'){
      if(pending.info.state==='pending' || pending.info.state==='saving') throw new Error('Save or cancel the download first.');
      entry.download=undefined;
    } else if(input.action!=='reveal') throw new Error('Unknown download action.');
    this.publish(entry);return this.snapshot(entry);
  }
  /** The saved file, for Show in Finder. */
  downloadPath(owner:string,id:string):string {
    const pending=this.record(owner).download;
    if(!pending || pending.info.id!==id || !pending.savedPath) throw new Error('This download is no longer available.');
    return pending.savedPath;
  }
  closePopup(owner:string):BrowserState {
    const entry=this.record(owner);if(entry.popup)this.closePopupView(entry,entry.popup);
    return this.snapshot(entry);
  }
  dispose():void {
    if(this.disposed)return;
    this.persistSessions();
    this.disposed=true;
    clearInterval(this.sweeper);this.sweeper=undefined;
    for(const owner of [...this.entries.keys()])this.close(owner);
    this.window.off('hide',this.onHide);this.window.off('minimize',this.onHide);this.window.off('closed',this.onClosed);
    if(!this.ownerContents.isDestroyed())this.ownerContents.off('did-start-loading',this.onRendererNavigation);
    for(const cleanup of this.protectedSessions.values())cleanup();this.protectedSessions.clear();
  }
}
