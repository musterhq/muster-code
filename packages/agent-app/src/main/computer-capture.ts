import type {ComputerAccessibilityText, ComputerCaptureSource, ComputerPermissions, ComputerPermissionState} from '../shared/domains/computer-protocol.ts';

/** The Electron pieces the probe and capture use; tests pass fakes. */
export interface PermissionProbe { isTrustedAccessibilityClient?(prompt: boolean): boolean; getMediaAccessStatus?(type: 'screen'): string }
interface NativeImageLike { isEmpty(): boolean; getSize(): {width: number; height: number}; toDataURL(): string; toJPEG?(quality: number): Buffer }
interface SourceLike { id: string; name: string; thumbnail: NativeImageLike; appIcon?: NativeImageLike | null }
export interface Capturer { getSources(options: {types: ('window' | 'screen')[]; thumbnailSize: {width: number; height: number}; fetchWindowIcons?: boolean}): Promise<SourceLike[]> }

const media = (value: string | undefined): ComputerPermissionState => value === 'granted' || value === 'denied' || value === 'restricted' ? value : value === 'not-determined' ? 'not-determined' : 'unknown';
/** CUA-07: what macOS allows Muster (and the computer-use helpers it spawns) to do right now. */
export function computerPermissions(probe: PermissionProbe, platform: string = process.platform): ComputerPermissions {
  if (platform !== 'darwin') return {platform, accessibility: 'granted', screen: 'granted'};
  let accessibility: ComputerPermissionState = 'unknown', screen: ComputerPermissionState = 'unknown';
  try { if (probe.isTrustedAccessibilityClient) accessibility = probe.isTrustedAccessibilityClient(false) ? 'granted' : 'denied'; } catch {}
  try { screen = media(probe.getMediaAccessStatus?.('screen')); } catch {}
  return {platform, accessibility, screen};
}
const SOURCE_ID = /^(window|screen):[0-9]+:[0-9]+$/;
/** CUA-08: windows and screens the user may attach, with small previews. Never includes Muster's own window. */
export async function captureSources(capturer: Capturer, ownWindowId?: string): Promise<ComputerCaptureSource[]> {
  const sources = await capturer.getSources({types: ['window', 'screen'], thumbnailSize: {width: 320, height: 200}, fetchWindowIcons: true});
  return sources.filter(source => SOURCE_ID.test(source.id) && source.id !== ownWindowId && !source.thumbnail.isEmpty()).slice(0, 48).map(source => {
    const size = source.thumbnail.getSize();
    return {id: source.id, name: source.name.slice(0, 200) || (source.id.startsWith('screen:') ? 'Screen' : 'Window'), kind: source.id.startsWith('screen:') ? 'screen' : 'window', thumbnail: source.thumbnail.toDataURL(), width: size.width, height: size.height, ...(source.appIcon && !source.appIcon.isEmpty() ? {icon: source.appIcon.toDataURL()} : {})};
  });
}
/** Full-resolution PNG of one window or screen, fetched fresh so it is current. */
export async function captureSource(capturer: Capturer, id: unknown, maxSize = {width: 2880, height: 1800}): Promise<{dataUrl: string; width: number; height: number; name: string}> {
  if (typeof id !== 'string' || !SOURCE_ID.test(id)) throw new Error('Invalid capture source.');
  const sources = await capturer.getSources({types: [id.startsWith('screen:') ? 'screen' : 'window'], thumbnailSize: maxSize});
  const source = sources.find(candidate => candidate.id === id);
  if (!source || source.thumbnail.isEmpty()) throw new Error('That window is no longer available. Pick it again.');
  const size = source.thumbnail.getSize();
  return {dataUrl: source.thumbnail.toDataURL(), width: size.width, height: size.height, name: source.name.slice(0, 200)};
}

/** CUA-08: at most this much window text rides along with a capture. */
export const MAX_ACCESSIBILITY_TEXT = 20_000;
/** JXA run by /usr/bin/osascript: maps the CGWindowID to its owning process (screens use the frontmost app), then
 *  walks that window's accessibility tree for visible strings. argv: [windowNumber, 'window'|'screen', maxChars]. */
export const ACCESSIBILITY_TEXT_SCRIPT = `ObjC.import('CoreGraphics');
function run(argv){
  var id=parseInt(argv[0],10),kind=argv[1],max=parseInt(argv[2],10),pid=0,owner='',title='';
  if(kind==='window'){
    var info=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(8,id)));
    if(!info||!info.length)return JSON.stringify({error:'That window is no longer open.'});
    pid=info[0].kCGWindowOwnerPID||0;owner=info[0].kCGWindowOwnerName||'';title=info[0].kCGWindowName||'';
  }
  var se=Application('System Events');
  var procs=pid?se.processes.whose({unixId:pid}):se.processes.whose({frontmost:true});
  if(!procs.length)return JSON.stringify({error:'The app that owns this window is not running.'});
  var proc=procs[0];if(!owner){try{owner=proc.name();}catch(e){}}
  var wins=proc.windows();if(!wins.length)return JSON.stringify({app:owner,window:title,text:'',truncated:false});
  var win=wins[0];
  if(title){for(var i=0;i<wins.length;i++){try{if(wins[i].name()===title){win=wins[i];break;}}catch(e){}}}
  try{if(!title)title=win.name()||'';}catch(e){}
  var seen={},out=[],size=0,truncated=false,els=win.entireContents();
  for(var j=0;j<els.length;j++){
    if(j>=4000){truncated=true;break;}
    var t='';
    try{var v=els[j].value();if(typeof v==='string')t=v;}catch(e){}
    if(!t){try{var n=els[j].name();if(typeof n==='string')t=n;}catch(e){}}
    t=(t||'').replace(/\\s+/g,' ').trim();
    if(!t||seen[t])continue;seen[t]=1;
    if(size+t.length+1>max){truncated=true;break;}
    out.push(t);size+=t.length+1;
  }
  return JSON.stringify({app:owner,window:title,text:out.join('\\n'),truncated:truncated});
}`;
export type ScriptRunner = (file: string, args: string[]) => Promise<string>;
/** Window text through macOS Accessibility, only when Muster is already trusted (never prompts). */
export async function accessibilityText(id: unknown, probe: PermissionProbe, run: ScriptRunner, platform: string = process.platform): Promise<ComputerAccessibilityText> {
  if (typeof id !== 'string' || !SOURCE_ID.test(id)) throw new Error('Invalid capture source.');
  if (platform !== 'darwin') return {available: false, reason: 'Window text is available on macOS only.'};
  if (computerPermissions(probe, platform).accessibility !== 'granted') return {available: false, reason: 'Turn on Accessibility for Muster in System Settings › Privacy & Security to include window text.'};
  const [kind, number] = id.split(':');
  let raw: string;
  try { raw = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', ACCESSIBILITY_TEXT_SCRIPT, number, kind, String(MAX_ACCESSIBILITY_TEXT)]); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {available: false, reason: /-1743|not allowed|not authori[sz]ed/i.test(message) ? 'Allow Muster to control System Events in System Settings › Privacy & Security › Automation to include window text.' : /timed? ?out|ETIMEDOUT|SIGTERM/i.test(message) ? 'Reading the window text took too long; the image was attached without it.' : 'The window text could not be read; the image was attached without it.'};
  }
  let parsed: {error?: unknown; app?: unknown; window?: unknown; text?: unknown; truncated?: unknown};
  try { parsed = JSON.parse(raw.trim()); } catch { return {available: false, reason: 'The window text could not be read; the image was attached without it.'}; }
  if (typeof parsed.error === 'string') return {available: false, reason: parsed.error.slice(0, 200)};
  const text = typeof parsed.text === 'string' ? parsed.text.slice(0, MAX_ACCESSIBILITY_TEXT) : '';
  if (!text.trim()) return {available: false, reason: 'This window exposes no readable text to Accessibility.'};
  return {available: true, app: typeof parsed.app === 'string' ? parsed.app.slice(0, 200) : '', window: typeof parsed.window === 'string' ? parsed.window.slice(0, 300) : '', text, truncated: parsed.truncated === true || (typeof parsed.text === 'string' && parsed.text.length > MAX_ACCESSIBILITY_TEXT)};
}
