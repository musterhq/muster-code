/** Remote pages receive none of this bridge. Only the local app renderer may invoke it. */
export interface BrowserBounds {x:number; y:number; width:number; height:number}
export interface BrowserOwner {owner:string}
/** A mount lease prevents stale renderer geometry from reviving a hidden surface. */
export interface BrowserSurface extends BrowserOwner {surfaceId:string}
export interface BrowserState extends BrowserOwner {
  profileId:string;
  revision:number;
  url:string;
  title:string;
  loading:boolean;
  canGoBack:boolean;
  canGoForward:boolean;
  visible:boolean;
  error?:string;
  notice?:string;
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
}

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
