import {createRequire} from 'node:module';
import type {BrowserWindow, Session, WebContents, WebContentsView, WebContentsViewConstructorOptions} from 'electron';
import {browserURL, type BrowserBounds, type BrowserCommands, type BrowserEvent, type BrowserState, type BrowserSurface} from '../shared/browser-protocol.ts';

export const MAX_BROWSER_VIEWS=4;
export interface BrowserRuntime {
  createView(options:WebContentsViewConstructorOptions):WebContentsView;
  getSession(partition:string):Session;
}
function electronRuntime():BrowserRuntime {
  // The main bundle is CommonJS. Tests inject a runtime and never load Electron.
  const {WebContentsView,session}=createRequire(__filename)('electron') as typeof import('electron');
  return {createView:options=>new WebContentsView(options),getSession:partition=>session.fromPartition(partition)};
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
interface Entry {
  owner:string; profileId:string; surfaceId:string; view:WebContentsView; attached:boolean;
  url:string; revision:number; error?:string; notice?:string; navigation:number;
}

/** Local browser profiles share cookies only within the same opaque profile ID.
 * Chromium enforces origin boundaries inside each profile. Back/forward history
 * lives only in its WebContents: hiding keeps it; close/restart discards it.
 */
export class BrowserWorkspaceController {
  private entries=new Map<string,Entry>();
  private protectedSessions=new Map<Session,()=>void>();
  private disposed=false;
  private runtime:BrowserRuntime;
  private ownerContents:WebContents;
  private onHide=()=>this.hideAll();
  private onRendererNavigation=()=>this.hideAll(true);
  private onClosed=()=>this.dispose();
  constructor(private window:BrowserWindow,private emit:(event:BrowserEvent)=>void,runtime?:BrowserRuntime) {
    this.runtime=runtime??electronRuntime();
    this.ownerContents=window.webContents;
    window.on('hide',this.onHide); window.on('minimize',this.onHide); window.on('closed',this.onClosed);
    this.ownerContents.on('did-start-loading',this.onRendererNavigation);
  }
  private assertAlive():void {if(this.disposed || this.window.isDestroyed()) throw new Error('Browser workspace is closed.');}
  private entry(owner:unknown):Entry {
    this.assertAlive();validOwner(owner);
    const entry=this.entries.get(owner);
    if(!entry || entry.view.webContents.isDestroyed()) throw new Error('Browser tab is closed. Open it again to continue.');
    return entry;
  }
  private protect(session:Session):void {
    if(this.protectedSessions.has(session)) return;
    session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    session.setPermissionCheckHandler(()=>false);
    session.setDevicePermissionHandler(()=>false);
    session.setDisplayMediaRequestHandler((_request,callback)=>callback({}));
    const denyDownload=(event:{preventDefault():void})=>event.preventDefault();
    session.on('will-download',denyDownload);
    this.protectedSessions.set(session,()=>session.off('will-download',denyDownload));
  }
  private snapshot(entry:Entry):BrowserState {
    const contents=entry.view.webContents;
    return {owner:entry.owner,profileId:entry.profileId,revision:entry.revision,url:entry.url,title:contents.getTitle().slice(0,512),loading:contents.isLoading(),canGoBack:contents.navigationHistory.canGoBack(),canGoForward:contents.navigationHistory.canGoForward(),visible:entry.attached,...(entry.error?{error:entry.error}:{}),...(entry.notice?{notice:entry.notice}:{})};
  }
  private publish(entry:Entry):void {
    if(this.disposed || this.entries.get(entry.owner)!==entry || entry.view.webContents.isDestroyed()) return;
    entry.revision++; this.emit({type:'browserState',state:this.snapshot(entry)});
  }
  private detach(entry:Entry):void {
    if(!entry.view.webContents.isDestroyed()){entry.view.setVisible(false);entry.view.webContents.setAudioMuted(true);}
    if(entry.attached && !this.window.isDestroyed()) this.window.contentView.removeChildView(entry.view);
    const changed=entry.attached; entry.attached=false;
    if(changed) this.publish(entry);
  }
  private wire(entry:Entry):void {
    const contents=entry.view.webContents;
    const setURL=(url:string):boolean=>{try{entry.url=browserURL(url);return true;}catch{return false;}};
    const rejectNavigation=(event:{url:string;preventDefault():void})=>{
      try {browserURL(event.url);} catch {event.preventDefault();entry.notice='This navigation was blocked. Only HTTP and HTTPS pages are supported.';this.publish(entry);}
    };
    contents.on('will-navigate',rejectNavigation);
    contents.on('will-frame-navigate',rejectNavigation);
    contents.on('will-redirect',rejectNavigation);
    contents.on('will-attach-webview',event=>event.preventDefault());
    contents.setWindowOpenHandler(()=>{entry.notice='Pop-up windows are blocked in this browser.';this.publish(entry);return {action:'deny'};});
    contents.on('did-start-navigation',(_event,url,_inPlace,isMainFrame)=>{if(isMainFrame && setURL(url)){entry.error=undefined;entry.notice=undefined;this.publish(entry);}});
    contents.on('did-redirect-navigation',(_event,url,_inPlace,isMainFrame)=>{if(isMainFrame && setURL(url))this.publish(entry);});
    contents.on('did-navigate',(_event,url)=>{if(setURL(url))this.publish(entry);});
    contents.on('did-navigate-in-page',(_event,url,isMainFrame)=>{if(isMainFrame && setURL(url))this.publish(entry);});
    contents.on('did-start-loading',()=>this.publish(entry));
    contents.on('did-stop-loading',()=>this.publish(entry));
    contents.on('page-title-updated',()=>this.publish(entry));
    contents.on('did-fail-load',(_event,code,description,url,isMainFrame)=>{
      if(!isMainFrame || code===-3) return; // User stop/replacement is not a load failure.
      try {if(browserURL(url)!==entry.url)return;}catch{return;}
      entry.error=`Could not load this page (${code}): ${description.slice(0,240)}`;this.publish(entry);
    });
    contents.on('render-process-gone',()=>{entry.error='This browser page stopped unexpectedly. Reload to try again.';this.detach(entry);this.publish(entry);});
    contents.on('destroyed',()=>{
      if(this.entries.get(entry.owner)!==entry) return;
      this.detach(entry);this.entries.delete(entry.owner);
      if(!this.disposed) this.emit({type:'browserClosed',owner:entry.owner});
    });
  }
  open(input:BrowserCommands['browser.open']['input']):BrowserState {
    this.assertAlive();validOwner(input?.owner);validSurface(input?.surfaceId);
    const partition=browserPartition(input.profileId),url=browserURL(input.url??'about:blank');
    const existing=this.entries.get(input.owner);
    if(existing){
      if(existing.profileId!==input.profileId) throw new Error('This tab belongs to a different browser profile. Open a new tab to change profiles.');
      existing.surfaceId=input.surfaceId;this.detach(existing);this.publish(existing);return this.snapshot(existing);
    }
    if(this.entries.size>=MAX_BROWSER_VIEWS) throw new Error(`Close a browser tab before opening another (maximum ${MAX_BROWSER_VIEWS}).`);
    const session=this.runtime.getSession(partition);this.protect(session);
    const view=this.runtime.createView({webPreferences:{session,contextIsolation:true,sandbox:true,nodeIntegration:false,nodeIntegrationInWorker:false,nodeIntegrationInSubFrames:false,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false,plugins:false,devTools:false,spellcheck:false,navigateOnDragDrop:false,disableDialogs:true}});
    view.setVisible(false);view.setBackgroundColor('#181818');view.webContents.setAudioMuted(true);
    const entry:Entry={owner:input.owner,profileId:input.profileId,surfaceId:input.surfaceId,view,attached:false,url,revision:0,navigation:0};
    this.entries.set(entry.owner,entry);this.wire(entry);this.load(entry,url);return this.snapshot(entry);
  }
  private load(entry:Entry,url:string):void {
    const navigation=++entry.navigation;entry.url=url;entry.error=undefined;entry.notice=undefined;
    void entry.view.webContents.loadURL(url).catch(error=>{
      if(this.entries.get(entry.owner)!==entry || navigation!==entry.navigation || entry.view.webContents.isDestroyed() || (error as {code?:string}).code==='ERR_ABORTED') return;
      entry.error=error instanceof Error?error.message.slice(0,320):'The page could not be loaded.';this.publish(entry);
    });
    this.publish(entry);
  }
  navigate(input:BrowserCommands['browser.navigate']['input']):BrowserState {const entry=this.entry(input?.owner);this.load(entry,browserURL(input.url));return this.snapshot(entry);}
  back(owner:string):BrowserState {const entry=this.entry(owner);if(entry.view.webContents.navigationHistory.canGoBack()){entry.navigation++;entry.error=undefined;entry.view.webContents.navigationHistory.goBack();}this.publish(entry);return this.snapshot(entry);}
  forward(owner:string):BrowserState {const entry=this.entry(owner);if(entry.view.webContents.navigationHistory.canGoForward()){entry.navigation++;entry.error=undefined;entry.view.webContents.navigationHistory.goForward();}this.publish(entry);return this.snapshot(entry);}
  reload(owner:string):BrowserState {const entry=this.entry(owner);entry.navigation++;entry.error=undefined;entry.notice=undefined;entry.view.webContents.reload();this.publish(entry);return this.snapshot(entry);}
  stop(owner:string):BrowserState {const entry=this.entry(owner);entry.navigation++;entry.view.webContents.stop();this.publish(entry);return this.snapshot(entry);}
  status(owner:string):BrowserState {return this.snapshot(this.entry(owner));}
  position(input:BrowserCommands['browser.position']['input'],beforeReveal?:()=>void):void {
    const entry=this.entry(input?.owner);validSurface(input.surfaceId);
    if(entry.surfaceId!==input.surfaceId) return;
    const [width,height]=this.window.getContentSize();
    const bounds=browserBounds(input.bounds,width,height,this.ownerContents.getZoomFactor());
    if(!this.window.isVisible() || this.window.isMinimized() || bounds.width<1 || bounds.height<1){this.detach(entry);return;}
    beforeReveal?.();
    for(const other of this.entries.values()) if(other!==entry) this.detach(other);
    entry.view.setBounds(bounds);
    if(!entry.attached){this.window.contentView.addChildView(entry.view);entry.attached=true;}
    entry.view.setVisible(true);entry.view.webContents.setAudioMuted(false);this.publish(entry);
  }
  hide(input:BrowserSurface):void {
    validOwner(input?.owner);validSurface(input?.surfaceId);
    const entry=this.entries.get(input.owner);
    if(entry?.surfaceId===input.surfaceId) this.detach(entry);
  }
  /** Parent calls this before switching resources or presenting native overlays. */
  hideAll(revokeSurfaces=false):void {for(const entry of this.entries.values()){if(revokeSurfaces) entry.surfaceId='';this.detach(entry);}}
  close(owner:string):void {
    validOwner(owner);const entry=this.entries.get(owner);if(!entry)return;
    this.detach(entry);this.entries.delete(owner);entry.navigation++;
    if(!entry.view.webContents.isDestroyed()) entry.view.webContents.close({waitForBeforeUnload:false});
    if(!this.disposed)this.emit({type:'browserClosed',owner});
  }
  dispose():void {
    if(this.disposed)return;this.disposed=true;
    for(const owner of [...this.entries.keys()])this.close(owner);
    this.window.off('hide',this.onHide);this.window.off('minimize',this.onHide);this.window.off('closed',this.onClosed);
    if(!this.ownerContents.isDestroyed())this.ownerContents.off('did-start-loading',this.onRendererNavigation);
    for(const cleanup of this.protectedSessions.values())cleanup();this.protectedSessions.clear();
  }
}
