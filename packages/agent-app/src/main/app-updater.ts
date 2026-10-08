/** Self-update from GitHub Releases.
 *
 * Source: the repository baked into the packaged app (Info.plist `MusterUpdateRepo` on macOS, written by
 * scripts/package-release.mjs; `musterUpdateRepo` in the packaged package.json on Windows and Linux, written by
 * electron-builder extraMetadata). Releases are tagged `agent-v<version>` and carry one file per platform plus
 * `SHA256SUMS`. Every update, on every platform:
 *   - comes only from https://github.com/<repo>/releases/download/… or its API asset endpoint (the fallback when the
 *     direct download is failing), never another host;
 *   - is newer than the running version (no downgrades; stable never takes a prerelease);
 *   - matches its SHA-256 in SHA256SUMS before anything is installed, including a file rebuilt from a differential
 *     download (update-differential.ts), which falls back to the whole file when it does not match.
 * How it installs depends on how this copy was installed (`UpdateInstallMethod`, see detectInstallMethod):
 *   mac-bundle  `Muster-Agent-<v>-<arch>.zip`; also passes `codesign --verify --deep --strict` and the running app's
 *               designated requirement (only builds signed with the same key can replace it), then replaces the .app.
 *   nsis        `Muster-Agent-<v>-win-<arch>-setup.exe`, rebuilt from the last verified installer and the new
 *               `.blockmap` when one is cached; once Muster has quit, runs it silently for this user and relaunches.
 *   appimage    `Muster-Agent-<v>-linux-<arch>.AppImage`, rebuilt from the running AppImage's embedded block map;
 *               once Muster has quit, replaces the AppImage file and relaunches.
 *   deb         `Muster-Agent-<v>-linux-<arch>.deb`; installed with `pkexec apt-get install` (the desktop asks for an
 *               administrator password), else Muster shows the command to run; then relaunches.
 *   manual      the release page opens (portable zip, tar.gz, development builds).
 * Nothing here holds credentials. */
import {createHash} from 'node:crypto';
import {execFile,spawn,type ChildProcess} from 'node:child_process';
import {constants,createWriteStream,existsSync,promises as fs} from 'node:fs';
import path from 'node:path';
import {compareVersions,type UpdateChannel} from './update-channel.ts';
import {differentialWorthIt,embeddedMapRange,parseBlockMap,planDifferential,readEmbeddedBlockMap,type BlockMap} from './update-differential.ts';

import type {UpdateInstallMethod,UpdateRelease,UpdateStatus} from '../shared/update-protocol.ts';
export type {UpdateInstallMethod,UpdateRelease,UpdateStatus};

interface GitHubAsset {name:string;browser_download_url:string;/** API endpoint for the asset; works when browser_download_url is down. */url?:string;size?:number}
export interface GitHubRelease {tag_name:string;name?:string|null;body?:string|null;html_url:string;draft:boolean;prerelease:boolean;published_at?:string|null;assets:GitHubAsset[]}
/** `zip` is the update file for this install method (the Mac zip, setup.exe, AppImage or .deb); `blockmap` is the
 *  setup.exe's block map when the release has one. */
export interface ReleaseCandidate {release:UpdateRelease;zip:GitHubAsset;sums:GitHubAsset;blockmap?:GitHubAsset}

const TAG_PREFIX='agent-v';
const VERSION=/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** Background checks run hourly; focusing the window also checks when the last look is over 10 minutes old. */
export const CHECK_EVERY_MS=60*60_000;
/** Waits between attempts on one source (so 3 attempts), and the per-request limits. */
export const RETRY_DELAYS_MS:readonly number[]=[1_000,3_000];
const API_TIMEOUT_MS=30_000,HEADER_TIMEOUT_MS=30_000,STALL_TIMEOUT_MS=60_000;
/** A GitHub outage the user can do nothing about: 5xx, 429, a network error or a timeout. */
class TransientError extends Error {constructor(readonly status:number|undefined,message:string){super(message);}}
/** The server answered a range request with the whole file: differential download is not possible. */
class NoRangeSupport extends Error {}
const outage=(status?:number)=>new TransientError(status,`GitHub didn’t respond${status?` (${status})`:''}. Muster will try again automatically.`);
export const REPO_PATTERN=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Exact release asset names, as electron-builder (Windows, Linux) and package-release.mjs (macOS) write them. */
export function updateAssetName(method:UpdateInstallMethod,version:string,arch:string):string|undefined {
  switch(method){
    case 'mac-bundle':return `Muster-Agent-${version}-${arch}.zip`;
    case 'nsis':return `Muster-Agent-${version}-win-${arch}-setup.exe`;
    case 'appimage':return `Muster-Agent-${version}-linux-${arch==='x64'?'x86_64':arch}.AppImage`;
    case 'deb':return `Muster-Agent-${version}-linux-${arch==='x64'?'amd64':arch}.deb`;
    case 'manual':return undefined;
  }
}

const METHODS:readonly string[]=['mac-bundle','nsis','appimage','deb','manual'];
/** A platform name (older callers) or an install method. macOS always installs in place. */
const methodOf=(value:string):UpdateInstallMethod=>METHODS.includes(value)?value as UpdateInstallMethod:value==='darwin'?'mac-bundle':'manual';

/** Newest release above `current` that this copy can install. Stable skips prereleases. In-place methods need their
 *  own file and SHA256SUMS in the release; `manual` (or a non-Mac platform name) takes any newer release, which is
 *  offered as a download from the release page. */
export function pickRelease(releases:readonly GitHubRelease[],current:string,channel:UpdateChannel,arch:string,methodOrPlatform:string=process.platform):ReleaseCandidate|undefined {
  const method=methodOf(methodOrPlatform);
  let best:ReleaseCandidate|undefined;
  for(const release of releases){
    if(release.draft||!release.tag_name.startsWith(TAG_PREFIX))continue;
    if(release.prerelease&&channel==='stable')continue;
    const version=release.tag_name.slice(TAG_PREFIX.length);
    if(!VERSION.test(version)||compareVersions(version,current)<=0)continue;
    if(best&&compareVersions(version,best.release.version)<=0)continue;
    const name=updateAssetName(method,version,arch);
    const zip=name?release.assets.find(asset=>asset.name===name):undefined,sums=release.assets.find(asset=>asset.name==='SHA256SUMS');
    if(method!=='manual'&&(!zip||!sums))continue;
    const blockmap=method==='nsis'?release.assets.find(asset=>asset.name===`${name}.blockmap`):undefined;
    best={release:{version,notes:(release.body??'').trim(),pageUrl:release.html_url,...(release.published_at?{publishedAt:release.published_at}:{})},zip:zip!,sums:sums!,...(blockmap?{blockmap}:{})};
  }
  return best;
}

/** Only HTTPS release downloads of this repository on github.com, or its API asset endpoint. */
export function isGitHubAssetUrl(url:string|undefined,repo:string):boolean {
  if(!url)return false;
  let parsed:URL;try{parsed=new URL(url);}catch{return false;}
  if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port)return false;
  const pathname=parsed.pathname.toLowerCase(),own=repo.toLowerCase();
  if(parsed.hostname==='github.com')return pathname.startsWith(`/${own}/releases/download/`);
  if(parsed.hostname==='api.github.com')return pathname.startsWith(`/repos/${own}/releases/assets/`);
  return false;
}

/** `shasum -a 256` output: "<64 hex>  <name>" per line. */
export function checksumFor(sums:string,name:string):string|undefined {
  for(const line of sums.split(/\r?\n/)){
    const match=/^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if(match&&match[2]!.trim()===name)return match[1]!.toLowerCase();
  }
  return undefined;
}

/** The .app bundle that contains this executable, or undefined when not running from one. */
export function bundlePathOf(exe:string):string|undefined {
  const at=exe.indexOf('.app/Contents/MacOS/');
  return at===-1?undefined:exe.slice(0,at+4);
}

/** Why this copy cannot replace itself, if it cannot. */
export async function installBlocker(bundle:string|undefined):Promise<string|undefined> {
  if(!bundle)return 'Updates install only from the packaged app.';
  if(bundle.includes('/AppTranslocation/'))return 'Move Muster Agent to the Applications folder to install updates.';
  if(bundle.startsWith('/Volumes/'))return 'Muster Agent is running from the disk image. Drag it to Applications first.';
  try{await fs.access(path.dirname(bundle),constants.W_OK);}catch{return `Muster Agent can’t write to ${path.dirname(bundle)}. Install the update from the release page.`;}
  return undefined;
}

export interface InstallTarget {method:UpdateInstallMethod;/** appimage: the AppImage file. */target?:string;/** deb: what to start after installing. */relaunch?:string}
/** Where the deb installs (electron-builder: /opt/<productName>) and dpkg's record of the package. */
export const DEB_DIR='/opt/muster-agent',DEB_RECORD='/var/lib/dpkg/info/muster-agent.list';
/** How this copy installs updates. Windows: the NSIS install leaves its uninstaller beside the executable (the zip
 *  has none). Linux: an AppImage runs with $APPIMAGE set; the deb lives in /opt/muster-agent and is known to dpkg. */
export function detectInstallMethod(input:{platform:string;exe:string;env:NodeJS.ProcessEnv;packaged:boolean;exists:(file:string)=>boolean;writable:(dir:string)=>boolean}):InstallTarget {
  const {platform,exe,env,exists}=input;
  if(platform==='darwin')return {method:'mac-bundle'};
  if(!input.packaged)return {method:'manual'};
  if(platform==='win32'){
    // electron-builder names it after the executable ("Uninstall muster-agent.exe"); older configs used the product name.
    const dir=path.win32.dirname(exe),stem=path.win32.basename(exe).replace(/\.exe$/i,'');
    return [`Uninstall ${stem}.exe`,'Uninstall Muster Agent.exe'].some(name=>exists(path.win32.join(dir,name)))?{method:'nsis'}:{method:'manual'};
  }
  if(platform==='linux'){
    const image=env.APPIMAGE;
    if(image&&path.posix.isAbsolute(image)&&exists(image))return input.writable(path.posix.dirname(image))?{method:'appimage',target:image}:{method:'manual'};
    if(exe.startsWith(`${DEB_DIR}/`)&&exists(DEB_RECORD))return {method:'deb',relaunch:`${DEB_DIR}/muster-agent`};
  }
  return {method:'manual'};
}

/** The AppImage keeps its name unless the name carries the version (Muster-Agent-0.3.5-linux-x86_64.AppImage), which
 *  then follows the update. */
export function nextAppImagePath(target:string,current:string,next:string):string {
  const base=path.posix.basename(target);
  return base.includes(current)?path.posix.join(path.posix.dirname(target),base.split(current).join(next)):target;
}

const run=(file:string,args:string[]):Promise<{stdout:string;stderr:string}>=>new Promise((resolve,reject)=>execFile(file,args,{maxBuffer:4*1024*1024},(error,stdout,stderr)=>error?reject(Object.assign(error,{stderr:String(stderr)})):resolve({stdout:String(stdout),stderr:String(stderr)})));
const posixQuote=(value:string)=>`'${value.replace(/'/g,`'\\''`)}'`;
const psQuote=(value:string)=>`'${value.replace(/'/g,`''`)}'`;

/** Reads a string key from the bundle's Info.plist (XML), without spawning anything. */
export function plistString(xml:string,key:string):string|undefined {
  const match=new RegExp(`<key>${key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}</key>\\s*<string>([^<]*)</string>`).exec(xml);
  return match?.[1]?.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
}

/** PowerShell for the Windows hand-off: wait (up to 5 minutes) for Muster to exit, then run the installer silently.
 *  `--updated` keeps the installer quiet about the running app, `--force-run` starts the new version when it is done. */
export function windowsInstallScript(pid:number,installer:string):string {
  return [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `$deadline = (Get-Date).AddMinutes(5)`,
    `while ((Get-Process -Id ${pid} -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 200 }`,
    `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { exit 1 }`,
    `Start-Process -FilePath ${psQuote(installer)} -ArgumentList '--updated','/S','--force-run'`,
  ].join('\n');
}

/** The environment for the hand-off and the relaunched app: nothing from the old AppImage mount (its AppRun prepends
 *  $APPDIR paths and sets APPIMAGE/APPDIR, which would point the new version at a directory that is gone). */
export function handOffEnv(source:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
  const env={...source},mount=source.APPDIR;
  for(const key of ['APPIMAGE','APPDIR','ARGV0','OWD','ELECTRON_RUN_AS_NODE'])delete env[key];
  if(mount)for(const key of ['PATH','LD_LIBRARY_PATH','XDG_DATA_DIRS','GSETTINGS_SCHEMA_DIR']){
    const value=env[key];if(value===undefined)continue;
    const kept=value.split(':').filter(entry=>entry&&entry!==mount&&!entry.startsWith(`${mount}/`));
    if(kept.length)env[key]=kept.join(':');else delete env[key];
  }
  return env;
}

export interface UpdaterOptions {
  current:string;
  arch:string;
  exe:string;
  repo?:string;
  channel:UpdateChannel;
  settingsFile:string;
  stagingDir:string;
  emit:(status:UpdateStatus)=>void;
  quit:()=>void;
  fetch?:typeof fetch;
  pid?:number;
  /** Where this copy runs; with no `install`, macOS installs in place and everything else opens the release page. */
  platform?:string;
  /** How this copy installs updates (detectInstallMethod). */
  install?:InstallTarget;
  /** Windows: the last verified installer and its block map are kept here for the next differential download. */
  cacheDir?:string;
  /** Opens a URL in the default browser (manual updates download from the release page). */
  openExternal?:(url:string)=>void;
  /** Relaunch command; tests pass /usr/bin/true so nothing opens. */
  relaunch?:string;
  /** Waits between attempts on one source; tests pass zeros. */
  retryDelaysMs?:readonly number[];
  /** deb: pkexec and apt-get (tests pass stand-ins). An empty pkexec means none is available. */
  pkexec?:string;
  aptGet?:string;
  /** Starts the detached hand-off process (tests record it instead). */
  spawnDetached?:(file:string,args:string[],env:NodeJS.ProcessEnv)=>ChildProcess;
  /** Windows: PowerShell for the hand-off. */
  powershell?:string;
}

const defaultSpawn=(file:string,args:string[],env:NodeJS.ProcessEnv):ChildProcess=>spawn(file,args,{detached:true,stdio:'ignore',env,windowsHide:true});

export class AppUpdater {
  private status:UpdateStatus;
  private candidate?:ReleaseCandidate;
  private staged?:string;
  private timer?:NodeJS.Timeout;
  private installer?:ChildProcess;
  private busy=false;
  /** deb: the package is installed; what is left is the restart. */
  private debInstalled=false;
  private readonly fetcher:typeof fetch;
  private readonly method:UpdateInstallMethod;
  constructor(private readonly options:UpdaterOptions) {
    this.fetcher=options.fetch??fetch;
    this.method=options.install?.method??methodOf(options.platform??process.platform);
    const repo=options.repo&&REPO_PATTERN.test(options.repo)?options.repo:undefined;
    this.status=repo?{phase:'idle',current:options.current,channel:options.channel,autoCheck:true,method:this.method}
      :{phase:'disabled',current:options.current,channel:options.channel,autoCheck:false,method:this.method,message:'This build has no update source.'};
  }
  get repo():string|undefined {return this.options.repo&&REPO_PATTERN.test(this.options.repo)?this.options.repo:undefined;}
  snapshot():UpdateStatus {return {...this.status};}
  private set(patch:Partial<UpdateStatus>,replace=false):void {
    const base={current:this.status.current,channel:this.status.channel,autoCheck:this.status.autoCheck,method:this.method};
    this.status=replace?{...base,...patch} as UpdateStatus:{...this.status,...patch};
    for(const key of Object.keys(patch) as (keyof UpdateStatus)[])if(patch[key]===undefined)delete this.status[key];
    this.options.emit(this.snapshot());
  }

  async start():Promise<void> {
    if(!this.repo)return;
    try{const saved=JSON.parse(await fs.readFile(this.options.settingsFile,'utf8'));if(typeof saved?.autoCheck==='boolean')this.status.autoCheck=saved.autoCheck;}catch{}
    // Windows and Linux: whatever an earlier update left in staging is stale once a new process starts (the Windows
    // installer itself lives in cacheDir). macOS cleans up in its install script.
    if(this.method!=='mac-bundle'&&this.method!=='manual')await fs.rm(this.options.stagingDir,{recursive:true,force:true}).catch(()=>{});
    this.schedule(30_000);
  }
  stop():void {if(this.timer)clearTimeout(this.timer);this.timer=undefined;}
  private schedule(delay:number):void {
    this.stop();
    if(!this.status.autoCheck||!this.repo)return;
    this.timer=setTimeout(()=>{void this.check({quiet:true}).finally(()=>this.schedule(CHECK_EVERY_MS));},delay);
    this.timer.unref?.();
  }
  /** Coming back to the window re-checks when the last look is older than `minAgeMs` (automatic checks only). */
  checkIfStale(minAgeMs=10*60_000):void {
    if(!this.repo||!this.status.autoCheck)return;
    const last=this.status.checkedAt?Date.parse(this.status.checkedAt):0;
    if(Date.now()-last>=minAgeMs)void this.check({quiet:true});
  }
  async setAutoCheck(enabled:boolean):Promise<UpdateStatus> {
    if(!this.repo)return this.snapshot();
    this.set({autoCheck:enabled});
    await fs.mkdir(path.dirname(this.options.settingsFile),{recursive:true});
    await fs.writeFile(this.options.settingsFile,JSON.stringify({autoCheck:enabled}),'utf8');
    this.schedule(enabled?5_000:0);
    return this.snapshot();
  }

  /** Looks for a newer release; when one exists it is downloaded and verified in the background. */
  async check({quiet=false}:{quiet?:boolean}={}):Promise<UpdateStatus> {
    const repo=this.repo;
    if(!repo||this.busy||this.status.phase==='ready'||this.status.phase==='installing')return this.snapshot();
    this.busy=true;
    const previous=this.status.phase;
    if(!quiet||previous==='idle')this.set({phase:'checking',message:undefined});
    try{
      const response=await this.fetcher(`https://api.github.com/repos/${repo}/releases?per_page=30`,{headers:{accept:'application/vnd.github+json','user-agent':`MusterAgent/${this.options.current}`},signal:AbortSignal.timeout(API_TIMEOUT_MS)});
      if(!response.ok)throw new Error(response.status===403?'GitHub is rate-limiting update checks. Try again later.':`GitHub answered ${response.status} for the release list.`);
      const releases=await response.json() as GitHubRelease[];
      const checkedAt=new Date().toISOString();
      const candidate=pickRelease(Array.isArray(releases)?releases:[],this.options.current,this.options.channel,this.options.arch,this.method);
      if(!candidate){this.candidate=undefined;this.set({phase:'up-to-date',checkedAt},true);return this.snapshot();}
      this.candidate=candidate;
      this.set({phase:'available',latest:candidate.release,checkedAt},true);
      this.busy=false;
      // Manual: the update is a download from the release page (install() opens it).
      if(this.method==='manual')return this.snapshot();
      await this.download();
    }catch(cause){
      this.set({phase:'error',message:cause instanceof Error?cause.message:String(cause),checkedAt:new Date().toISOString(),...(this.candidate?{latest:this.candidate.release}:{})},true);
    }finally{this.busy=false;}
    return this.snapshot();
  }

  /** One request with a header timeout. `arm()` restarts a stall timer (for streaming bodies); `done()` clears it. */
  private async attempt(url:string,headers:Record<string,string>):Promise<{response:Response;arm:()=>void;done:()=>void}> {
    const controller=new AbortController();
    let timer:NodeJS.Timeout|undefined;
    const arm=(ms=STALL_TIMEOUT_MS)=>{if(timer)clearTimeout(timer);timer=setTimeout(()=>controller.abort(),ms);};
    const done=()=>{if(timer)clearTimeout(timer);timer=undefined;};
    arm(HEADER_TIMEOUT_MS);
    try{
      const response=await this.fetcher(url,{headers,signal:controller.signal});
      if(response.ok){arm();return {response,arm,done};}
      done();
      return {response,arm,done};
    }catch{done();throw outage();}
  }

  /** Fetches a release asset (or a byte range of it): browser_download_url first, then the API asset endpoint when
   *  GitHub is failing. Only this repository's GitHub URLs are used. Each source gets bounded retries with backoff on
   *  5xx, 429, network errors and timeouts; other 4xx fail at once. */
  private async fetchAsset(asset:GitHubAsset,label:string,range?:{start:number;length:number}):Promise<{response:Response;arm:()=>void;done:()=>void}> {
    const repo=this.repo!;
    const ua=`MusterAgent/${this.options.current}`;
    const extra:Record<string,string>=range?{range:`bytes=${range.start}-${range.start+range.length-1}`}:{};
    const sources:{url:string;headers:Record<string,string>}[]=[];
    if(isGitHubAssetUrl(asset.browser_download_url,repo))sources.push({url:asset.browser_download_url,headers:{'user-agent':ua,...extra}});
    if(isGitHubAssetUrl(asset.url,repo))sources.push({url:asset.url!,headers:{accept:'application/octet-stream','user-agent':ua,...extra}});
    if(!sources.length)throw new Error(`${asset.name} isn’t a download from this repository’s GitHub releases, so it was not fetched.`);
    const delays=this.options.retryDelaysMs??RETRY_DELAYS_MS;
    let last:TransientError=outage();
    for(const source of sources){
      for(let tries=0;tries<=delays.length;tries++){
        if(tries>0)await new Promise<void>(resolve=>{const t=setTimeout(resolve,delays[tries-1]);t.unref?.();});
        try{
          const result=await this.attempt(source.url,source.headers);
          const {status}=result.response;
          if(range&&status===200){result.done();await result.response.body?.cancel().catch(()=>{});throw new NoRangeSupport('The download server ignored a range request.');}
          if(result.response.ok&&result.response.body)return result;
          if(status===429||status>=500){last=outage(status);continue;}
          throw new Error(`${label} (${status}).`);
        }catch(cause){
          if(cause instanceof TransientError){last=cause;continue;}
          throw cause;
        }
      }
    }
    throw last;
  }

  /** Streams a whole asset or a range of it to `sink`, keeping the stall timer armed; returns the bytes received. */
  private async stream(asset:GitHubAsset,label:string,sink:(chunk:Uint8Array)=>Promise<void>|void,range?:{start:number;length:number},onResponse?:(response:Response)=>void):Promise<number> {
    const {response,arm,done}=await this.fetchAsset(asset,label,range);
    onResponse?.(response);
    let received=0;
    try{for await(const chunk of response.body as unknown as AsyncIterable<Uint8Array>){arm();received+=chunk.byteLength;await sink(chunk);}}
    catch(error){throw error instanceof TransientError?error:outage();}
    finally{done();}
    if(range&&received!==range.length)throw new NoRangeSupport('A range download came back the wrong size.');
    return received;
  }
  private async bytes(asset:GitHubAsset,label:string,range?:{start:number;length:number}):Promise<Buffer> {
    const parts:Uint8Array[]=[];await this.stream(asset,label,chunk=>{parts.push(chunk);},range);return Buffer.concat(parts);
  }

  /** Downloads the whole asset to `file`; returns its SHA-256. */
  private async downloadWhole(asset:GitHubAsset,file:string):Promise<string> {
    const hash=createHash('sha256'),out=createWriteStream(file);
    let total=0,received=0,lastEmit=0;
    try{
      await this.stream(asset,'Download failed',async chunk=>{
        hash.update(chunk);received+=chunk.byteLength;
        if(!out.write(chunk))await new Promise<void>(resolve=>out.once('drain',()=>resolve()));
        if(total&&Date.now()-lastEmit>250){lastEmit=Date.now();this.set({progress:Math.min(1,received/total)});}
      },undefined,response=>{
        total=Number(response.headers.get('content-length'))||asset.size||0;
        this.set({phase:'downloading',progress:0,downloadBytes:total||undefined,fullBytes:total||undefined});
      });
    }catch(error){out.destroy();throw error;}
    await new Promise<void>((resolve,reject)=>out.end((error?:Error|null)=>error?reject(error):resolve()));
    return hash.digest('hex');
  }

  /** Rebuilds the new file from `oldFile` plus the changed ranges; returns its SHA-256. `tail` (AppImage: the new
   *  embedded block map and its length) is appended as is. */
  private async downloadDifferential(asset:GitHubAsset,file:string,oldFile:string,oldMap:BlockMap,newMap:BlockMap,tail?:Buffer):Promise<string|undefined> {
    const plan=planDifferential(oldMap,newMap);
    if(!differentialWorthIt(plan))return undefined;
    const fullBytes=asset.size||plan.totalBytes+(tail?.length??0);
    const hash=createHash('sha256');
    const [source,out]=await Promise.all([fs.open(oldFile,'r'),fs.open(file,'w')]);
    let received=0,lastEmit=0;
    this.set({phase:'downloading',progress:0,downloadBytes:plan.downloadBytes,fullBytes});
    const write=async(chunk:Uint8Array)=>{hash.update(chunk);await out.write(chunk);};
    try{
      const buffer=Buffer.alloc(1024*1024);
      for(const op of plan.ops){
        if(op.kind==='copy'){
          for(let done=0;done<op.length;){
            const want=Math.min(buffer.length,op.length-done);
            const {bytesRead}=await source.read(buffer,0,want,op.from+done);
            if(bytesRead!==want)throw new NoRangeSupport('The installed copy is shorter than its block map says.');
            await write(buffer.subarray(0,want));done+=want;
          }
        }else{
          await this.stream(asset,'Download failed',async chunk=>{
            await write(chunk);received+=chunk.byteLength;
            if(plan.downloadBytes&&Date.now()-lastEmit>250){lastEmit=Date.now();this.set({progress:Math.min(1,received/plan.downloadBytes)});}
          },{start:op.start,length:op.length});
        }
      }
      if(tail)await write(tail);
    }finally{await Promise.all([source.close(),out.close()]);}
    return hash.digest('hex');
  }

  /** Differential first when there is something to diff against, the whole file otherwise or when the rebuilt file
   *  does not match its checksum. Throws when the whole file does not match either. */
  private async fetchVerified(candidate:ReleaseCandidate,file:string,expected:string,sums:string):Promise<{blockmap?:Buffer}> {
    const asset=candidate.zip;
    let blockmap:Buffer|undefined;
    try{
      const prepared=await this.prepareDifferential(candidate,sums);
      blockmap=prepared.blockmap;
      const diff=prepared.diff;
      if(diff&&await this.downloadDifferential(asset,file,diff.oldFile,diff.oldMap,diff.newMap,diff.tail)===expected)return {blockmap};
    }catch(cause){
      // An outage is reported as such; anything else about the differential path only means "download it all".
      if(cause instanceof TransientError)throw cause;
    }
    if(await this.downloadWhole(asset,file)!==expected)throw new Error('The download didn’t match its published checksum, so it was discarded.');
    return {blockmap};
  }

  /** What to diff against and the new file's block map, when this install method has both. */
  private async prepareDifferential(candidate:ReleaseCandidate,sums:string):Promise<{blockmap?:Buffer;diff?:{oldFile:string;oldMap:BlockMap;newMap:BlockMap;tail?:Buffer}}> {
    if(this.method==='appimage'){
      const oldFile=this.options.install?.target,size=candidate.zip.size;
      if(!oldFile||!size||size<8)return {};
      const old=await readEmbeddedBlockMap(oldFile);
      const last4=await this.bytes(candidate.zip,'Download failed',{start:size-4,length:4});
      const range=embeddedMapRange(size,last4);
      const mapBytes=await this.bytes(candidate.zip,'Download failed',{start:range.start,length:range.end-range.start});
      return {diff:{oldFile,oldMap:old.map,newMap:parseBlockMap(mapBytes,'deflate'),tail:Buffer.concat([mapBytes,last4])}};
    }
    if(this.method!=='nsis'||!candidate.blockmap)return {};
    const blockmap=await this.bytes(candidate.blockmap,'Couldn’t read the block map');
    const listed=checksumFor(sums,candidate.blockmap.name);
    if(listed&&createHash('sha256').update(blockmap).digest('hex')!==listed)return {};
    const oldFile=this.options.cacheDir?path.join(this.options.cacheDir,'installer.exe'):undefined;
    const oldMapBytes=oldFile&&existsSync(oldFile)?await fs.readFile(`${oldFile}.blockmap`).catch(()=>undefined):undefined;
    if(!oldFile||!oldMapBytes)return {blockmap};
    return {blockmap,diff:{oldFile,oldMap:parseBlockMap(oldMapBytes,'gzip'),newMap:parseBlockMap(blockmap,'gzip')}};
  }

  private async download():Promise<void> {
    const candidate=this.candidate;
    if(!candidate||this.busy)return;
    // Belt and braces: pickRelease already refuses anything not newer than this copy.
    if(compareVersions(candidate.release.version,this.options.current)<=0)return;
    this.busy=true;
    const {version}=candidate.release,dir=path.join(this.options.stagingDir,version);
    try{
      const sumsFetch=await this.fetchAsset(candidate.sums,'Couldn’t read SHA256SUMS');
      const sumsText=await sumsFetch.response.text().finally(sumsFetch.done);
      const expected=checksumFor(sumsText,candidate.zip.name);
      if(!expected)throw new Error(`SHA256SUMS has no entry for ${candidate.zip.name}.`);
      await fs.rm(dir,{recursive:true,force:true});await fs.mkdir(dir,{recursive:true});
      const filePath=path.join(dir,candidate.zip.name);
      if(this.method==='mac-bundle'){
        if(await this.downloadWhole(candidate.zip,filePath)!==expected)throw new Error('The download didn’t match its published checksum, so it was discarded.');
        const unpacked=path.join(dir,'app');
        await run('/usr/bin/ditto',['-x','-k',filePath,unpacked]);
        const name=(await fs.readdir(unpacked)).find(entry=>entry.endsWith('.app'));
        if(!name)throw new Error('The update archive has no app inside.');
        const next=path.join(unpacked,name);
        await this.verify(next,version);
        await fs.rm(filePath,{force:true});
        this.staged=next;
      }else{
        const {blockmap}=await this.fetchVerified(candidate,filePath,expected,sumsText);
        this.staged=await this.keep(filePath,blockmap);
      }
      this.set({phase:'ready',progress:1});
    }catch(cause){
      await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});
      this.set({phase:'error',message:cause instanceof Error?cause.message:String(cause)});
    }finally{this.busy=false;}
  }

  /** Windows keeps the verified installer (and its block map) for the next differential download and runs it from
   *  there; the AppImage is made executable. */
  private async keep(file:string,blockmap?:Buffer):Promise<string> {
    if(this.method==='appimage'){await fs.chmod(file,0o755);return file;}
    if(this.method!=='nsis'||!this.options.cacheDir)return file;
    const cache=this.options.cacheDir,installer=path.join(cache,'installer.exe');
    await fs.mkdir(cache,{recursive:true});
    await fs.rm(`${installer}.blockmap`,{force:true});
    await fs.rename(file,installer).catch(async()=>{await fs.copyFile(file,installer);await fs.rm(file,{force:true});});
    if(blockmap)await fs.writeFile(`${installer}.blockmap`,blockmap);
    return installer;
  }

  /** Same bundle id and the advertised version, a valid signature, and the running app's designated requirement. */
  private async verify(next:string,version:string):Promise<void> {
    const plist=await fs.readFile(path.join(next,'Contents/Info.plist'),'utf8');
    const running=bundlePathOf(this.options.exe);
    const ownPlist=running?await fs.readFile(path.join(running,'Contents/Info.plist'),'utf8').catch(()=>''):'';
    const id=plistString(plist,'CFBundleIdentifier'),ownId=plistString(ownPlist,'CFBundleIdentifier');
    if(!id||(ownId&&id!==ownId))throw new Error('The update is a different app.');
    if(plistString(plist,'CFBundleShortVersionString')!==version)throw new Error('The update’s version doesn’t match its release.');
    await run('/usr/bin/codesign',['--verify','--deep','--strict',next]).catch(()=>{throw new Error('The update’s signature is invalid.');});
    if(!running)throw new Error('Updates install only from the packaged app.');
    const {stdout,stderr}=await run('/usr/bin/codesign',['-d','-r-',running]);
    const requirement=/designated => (.+)/.exec(`${stdout}\n${stderr}`)?.[1]?.trim();
    if(!requirement||requirement.startsWith('cdhash'))throw new Error('This copy of Muster Agent isn’t signed, so it can’t verify updates.');
    await run('/usr/bin/codesign',['--verify',`-R=${requirement}`,next]).catch(()=>{throw new Error('The update isn’t signed by the same publisher.');});
  }

  /** The hand-off runs once this process has exited (a cancelled quit stops it, see cancelInstall). */
  private handOff(file:string,args:string[]):void {
    const env=handOffEnv(process.env);
    this.set({phase:'installing',message:undefined});
    this.installer=(this.options.spawnDetached??defaultSpawn)(file,args,env);
    this.installer.unref?.();
    this.options.quit();
  }

  private async posixScript(name:string,lines:string[]):Promise<string> {
    const script=path.join(this.options.stagingDir,name);
    await fs.mkdir(this.options.stagingDir,{recursive:true});
    await fs.writeFile(script,['#!/bin/sh',...lines,''].join('\n'),{mode:0o755});
    return script;
  }
  private readonly waitLines=[
    '# Wait (up to 5 minutes) for Muster Agent to finish quitting.',
    'while kill -0 "$pid" 2>/dev/null; do sleep 0.2; waited=$((waited+1)); [ "$waited" -gt 1500 ] && exit 1; done',
  ];

  /** Installs the verified update the way this copy was installed, then relaunches. */
  async install():Promise<UpdateStatus> {
    if(this.method==='manual'){if(this.status.latest)this.options.openExternal?.(this.status.latest.pageUrl);return this.snapshot();}
    if(this.method==='deb'&&this.debInstalled)return this.relaunchDeb();
    if(this.status.phase!=='ready'||!this.staged||!existsSync(this.staged))return this.snapshot();
    const pid=String(this.options.pid??process.pid);
    switch(this.method){
      case 'nsis':{
        const script=windowsInstallScript(Number(pid),this.staged);
        this.handOff(this.options.powershell??'powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')]);
        return this.snapshot();
      }
      case 'appimage':{
        const target=this.options.install?.target;
        if(!target){this.set({phase:'error',message:'Muster Agent can’t tell which AppImage it was started from.'});return this.snapshot();}
        const next=nextAppImagePath(target,this.options.current,this.status.latest?.version??this.options.current);
        const script=await this.posixScript('install-appimage.sh',[
          'pid="$1"; staged="$2"; target="$3"; next="$4"; cleanup="$5"; waited=0',
          ...this.waitLines,
          'chmod 755 "$staged" || exit 1',
          '# Same file system: an atomic rename. Elsewhere mv copies, and the old AppImage is only removed after that worked.',
          'mv -f "$staged" "$next" || exit 1',
          '[ "$next" != "$target" ] && rm -f "$target"',
          'rm -rf "$cleanup"',
          `exec ${this.options.relaunch?`${posixQuote(this.options.relaunch)} `:''}"$next"`,
        ]);
        this.handOff('/bin/sh',[script,pid,this.staged,target,next,path.dirname(this.staged)]);
        return this.snapshot();
      }
      case 'deb':return this.installDeb();
      case 'mac-bundle':break;
    }
    const bundle=bundlePathOf(this.options.exe);
    const blocker=await installBlocker(bundle);
    if(blocker){this.set({phase:'error',message:blocker});return this.snapshot();}
    const script=path.join(this.options.stagingDir,'install.sh');
    await fs.writeFile(script,[
      '#!/bin/sh',
      'pid="$1"; target="$2"; staged="$3"; waited=0',
      '# Wait (up to 5 minutes) for Muster Agent to finish quitting.',
      'while kill -0 "$pid" 2>/dev/null; do sleep 0.2; waited=$((waited+1)); [ "$waited" -gt 1500 ] && exit 1; done',
      'backup="$target.previous"',
      'rm -rf "$backup"',
      '# Only touch the installed app once it has been moved aside; a failed copy puts it back.',
      'if mv "$target" "$backup"; then',
      '  if /usr/bin/ditto "$staged" "$target"; then rm -rf "$backup"; else rm -rf "$target"; mv "$backup" "$target"; fi',
      'fi',
      '/usr/bin/xattr -dr com.apple.quarantine "$target" 2>/dev/null',
      'rm -rf "$(dirname "$(dirname "$staged")")"',
      `${this.options.relaunch??'/usr/bin/open'} "$target"`,
      '',
    ].join('\n'),{mode:0o755});
    this.set({phase:'installing'});
    this.installer=spawn('/bin/sh',[script,String(this.options.pid??process.pid),bundle!,this.staged],{detached:true,stdio:'ignore'});
    this.installer.unref();
    this.options.quit();
    return this.snapshot();
  }

  /** The command a person can run instead of the prompt. */
  private debCommand(file:string):string {return `sudo apt-get install ${posixQuote(file)}`;}

  /** apt-get installs the verified .deb as root after the desktop's password prompt (pkexec). Without pkexec, or if
   *  it fails, the update stays ready and Muster shows the command to run. */
  private async installDeb():Promise<UpdateStatus> {
    const file=this.staged!,command=this.debCommand(file);
    const pkexec=this.options.pkexec??(existsSync('/usr/bin/pkexec')?'/usr/bin/pkexec':'');
    if(!pkexec){this.set({phase:'ready',manualCommand:command,message:'Run this command in a terminal to install the update, then restart Muster Agent.'});return this.snapshot();}
    this.set({phase:'installing',manualCommand:undefined,message:'Enter your password to let apt install the update…'});
    const outcome=await new Promise<{code:number;stderr:string}>(resolve=>{
      execFile(pkexec,[this.options.aptGet??'/usr/bin/apt-get','install','-y',file],{maxBuffer:4*1024*1024},(error,_stdout,stderr)=>{
        const status=(error as {code?:unknown}|null)?.code;
        const code=error?(typeof status==='number'?status:1):0;
        resolve({code,stderr:String(stderr)});
      });
    });
    if(outcome.code===0){this.debInstalled=true;return this.relaunchDeb();}
    const reason=outcome.code===126?'The password prompt was closed, so nothing was installed.'
      :outcome.code===127?'You aren’t allowed to install packages here.'
      :`apt couldn’t install the update${outcome.stderr.trim()?`: ${outcome.stderr.trim().split('\n').at(-1)!.slice(0,200)}`:'.'}`;
    this.set({phase:'ready',manualCommand:command,message:`${reason} Run this command in a terminal instead, then restart Muster Agent.`});
    return this.snapshot();
  }

  private async relaunchDeb():Promise<UpdateStatus> {
    const relaunch=this.options.relaunch??this.options.install?.relaunch??`${DEB_DIR}/muster-agent`;
    const script=await this.posixScript('relaunch.sh',[
      'pid="$1"; cleanup="$2"; waited=0',
      ...this.waitLines,
      'rm -rf "$cleanup"',
      `exec ${posixQuote(relaunch)}`,
    ]);
    this.handOff('/bin/sh',[script,String(this.options.pid??process.pid),this.staged?path.dirname(this.staged):path.join(this.options.stagingDir,'none')]);
    return this.snapshot();
  }

  /** The quit that install() asked for did not happen (the user chose Cancel or Keep Working in Background, or
   *  shutdown failed). Stop the waiting installer, or it would give up after five minutes and leave the update
   *  stuck on "installing"; the verified update goes back to "ready" so it can be installed again. */
  cancelInstall():void {
    if(this.status.phase!=='installing')return;
    try{this.installer?.kill('SIGTERM');}catch{}
    this.installer=undefined;
    if(this.debInstalled)this.set({phase:'ready',progress:1,message:`Version ${this.status.latest?.version} is installed. Restart Muster Agent to use it.`});
    else this.set({phase:'ready',progress:1});
  }
}
