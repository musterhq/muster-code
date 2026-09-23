/** Remote pages receive none of this bridge. Only the local app renderer may invoke it. */
export interface BrowserBounds {x:number; y:number; width:number; height:number}
export interface BrowserOwner {owner:string}
/** A mount lease prevents stale renderer geometry from reviving a hidden surface. */
export interface BrowserSurface extends BrowserOwner {surfaceId:string}
export type BrowserViewport='fill'|'mobile'|'tablet'|'desktop';
/** CSS widths the page is laid out at; 'fill' follows the panel. */
export const BROWSER_VIEWPORTS:Record<Exclude<BrowserViewport,'fill'>,{width:number;label:string}>={mobile:{width:390,label:'Mobile · 390'},tablet:{width:820,label:'Tablet · 820'},desktop:{width:1280,label:'Desktop · 1280'}};
export type BrowserConsoleLevel='debug'|'info'|'warning'|'error'|'network';
export interface BrowserConsoleEntry {level:BrowserConsoleLevel; message:string; source:string; line:number; at:number}
/** A download waits for an explicit choice; nothing is written to Downloads until Save. */
export interface BrowserDownload {id:string; filename:string; totalBytes:number; receivedBytes:number; state:'pending'|'saving'|'saved'|'cancelled'|'failed'; savedName?:string}
export interface BrowserPickedElement {url:string; selector:string; tag:string; outerHTML:string; truncated:boolean; text:string; rect:BrowserBounds}
export interface BrowserCapture {dataUrl:string; width:number; height:number; url:string; title:string}
export interface BrowserProfile {id:string; label:string; tabs:number}
export interface BrowserState extends BrowserOwner {
  profileId:string;
  revision:number;
  url:string;
  title:string;
  /** data: URL (the app CSP loads no remote images). */
  favicon?:string;
  loading:boolean;
  canGoBack:boolean;
  canGoForward:boolean;
  visible:boolean;
  viewport:BrowserViewport;
  /** Messages logged since the last clear; it keeps rising past the 200 entries kept, so the drawer knows to refresh. */
  consoleCount:number;
  consoleErrors:number;
  error?:string;
  /** Main-frame TLS failure; never bypassed in-app. */
  certificateError?:{url:string; code:string};
  notice?:string;
  download?:BrowserDownload;
  /** A user-initiated sign-in pop-up shown over the page until it returns to the opener. */
  popup?:{url:string; title:string};
}
export type BrowserEvent = {type:'browserState'; state:BrowserState} | {type:'browserClosed'; owner:string};
export interface BrowserCommands {
  'browser.open': {input:BrowserSurface & {profileId:string; url?:string}; output:BrowserState};
  'browser.navigate': {input:BrowserOwner & {url:string}; output:BrowserState};
  'browser.back': {input:BrowserOwner; output:BrowserState};
  'browser.forward': {input:BrowserOwner; output:BrowserState};
  'browser.reload': {input:BrowserOwner; output:BrowserState};
  'browser.stop': {input:BrowserOwner; output:BrowserState};
  'browser.status': {input:BrowserOwner; output:BrowserState};
  'browser.position': {input:BrowserSurface & {bounds:BrowserBounds}; output:void};
  'browser.hide': {input:BrowserSurface; output:void};
  'browser.close': {input:BrowserOwner; output:void};
  /** Drops the page without a browserClosed event so the tab can reopen under another profile. */
  'browser.release': {input:BrowserOwner; output:void};
  'browser.openExternal': {input:BrowserOwner; output:void};
  'browser.console': {input:BrowserOwner & {clear?:boolean}; output:BrowserConsoleEntry[]};
  'browser.setViewport': {input:BrowserOwner & {preset:BrowserViewport}; output:BrowserState};
  /** select:true lets the user drag a region on the page first; null when they cancel. */
  'browser.capture': {input:BrowserOwner & {rect?:BrowserBounds; select?:boolean}; output:BrowserCapture|null};
  'browser.pickElement': {input:BrowserOwner; output:BrowserPickedElement|null};
  'browser.cancelPick': {input:BrowserOwner; output:void};
  'browser.profiles': {input:void; output:BrowserProfile[]};
  'browser.clearData': {input:{profileId:string}; output:void};
  'browser.download': {input:BrowserOwner & {id:string; action:'save'|'cancel'|'reveal'|'dismiss'}; output:BrowserState};
  'browser.closePopup': {input:BrowserOwner; output:BrowserState};
}
export const BROWSER_COMMANDS = {'browser.open':true, 'browser.navigate':true, 'browser.back':true, 'browser.forward':true, 'browser.reload':true, 'browser.stop':true, 'browser.status':true, 'browser.position':true, 'browser.hide':true, 'browser.close':true, 'browser.release':true, 'browser.openExternal':true, 'browser.console':true, 'browser.setViewport':true, 'browser.capture':true, 'browser.pickElement':true, 'browser.cancelPick':true, 'browser.profiles':true, 'browser.clearData':true, 'browser.download':true, 'browser.closePopup':true} as const satisfies Record<keyof BrowserCommands, true>;

/** No filesystem, script, custom protocol, embedded credentials, or opaque URL. */
export function browserURL(value:unknown):string {
  if(typeof value!=='string' || !value.trim() || value.length>8192 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Enter an HTTP or HTTPS address.');
  if(value.trim()==='about:blank') return 'about:blank';
  let url:URL;
  try {url=new URL(value.trim());} catch {throw new Error('Enter a complete HTTP or HTTPS address.');}
  if(!['http:','https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('Only HTTP and HTTPS addresses without embedded credentials are supported.');
  return url.href;
}

/** Address-bar convenience, not a search provider or navigation authority. */
export function browserAddress(value:string):string {
  const address=value.trim();
  if(/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(address)) return browserURL(`http://${address}`);
  const hostWithPort=/^[^\s/:]+:\d+(?:\/|$)/.test(address);
  return browserURL(!hostWithPort && /^[a-z][a-z\d+.-]*:/i.test(address) ? address : `https://${address}`);
}

/** A scoped profile keeps one folder's or Project's sign-ins away from every other scope.
 * Project wins over folder: a Project spans folders and is the identity the user works in. */
export function browserScopeProfile(scope:{folderId?:string|null; projectId?:string|null}|null|undefined):string {
  const id=(prefix:string,value:string)=>`${prefix}-${value.replace(/[^a-zA-Z0-9_-]/g,'_')}`.slice(0,64);
  if(scope?.projectId) return id('project',scope.projectId);
  if(scope?.folderId) return id('folder',scope.folderId);
  return 'personal';
}
