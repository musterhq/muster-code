/** Self-update from GitHub Releases for the packaged macOS app.
 *
 * Source: the repository baked into Info.plist (`MusterUpdateRepo`, written by scripts/package-release.mjs from
 * GITHUB_REPOSITORY or MUSTER_UPDATE_REPO). Releases are tagged `agent-v<version>` and carry
 * `Muster-Agent-<version>-<arch>.zip` plus `SHA256SUMS`. An update is installed only when the download matches its
 * published SHA-256, passes `codesign --verify --deep --strict`, and satisfies the running app's own designated
 * requirement (so only builds signed with the same key can replace it). Nothing here holds credentials. */
import {createHash} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {constants,createWriteStream,existsSync,promises as fs} from 'node:fs';
import path from 'node:path';
import {compareVersions,type UpdateChannel} from './update-channel.ts';

import type {UpdateRelease,UpdateStatus} from '../shared/update-protocol.ts';
export type {UpdateRelease,UpdateStatus};

interface GitHubAsset {name:string;browser_download_url:string;size?:number}
export interface GitHubRelease {tag_name:string;name?:string|null;body?:string|null;html_url:string;draft:boolean;prerelease:boolean;published_at?:string|null;assets:GitHubAsset[]}
export interface ReleaseCandidate {release:UpdateRelease;zip:GitHubAsset;sums:GitHubAsset}

const TAG_PREFIX='agent-v';
const VERSION=/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const REPO_PATTERN=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Newest release above `current` that carries this Mac's zip and SHA256SUMS. Stable skips prereleases. */
export function pickRelease(releases:readonly GitHubRelease[],current:string,channel:UpdateChannel,arch:string):ReleaseCandidate|undefined {
  let best:ReleaseCandidate|undefined;
  for(const release of releases){
    if(release.draft||!release.tag_name.startsWith(TAG_PREFIX))continue;
    if(release.prerelease&&channel==='stable')continue;
    const version=release.tag_name.slice(TAG_PREFIX.length);
    if(!VERSION.test(version)||compareVersions(version,current)<=0)continue;
    if(best&&compareVersions(version,best.release.version)<=0)continue;
    const zip=release.assets.find(asset=>asset.name===`Muster-Agent-${version}-${arch}.zip`),sums=release.assets.find(asset=>asset.name==='SHA256SUMS');
    if(!zip||!sums)continue;
    best={release:{version,notes:(release.body??'').trim(),pageUrl:release.html_url,...(release.published_at?{publishedAt:release.published_at}:{})},zip,sums};
  }
  return best;
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

const run=(file:string,args:string[]):Promise<{stdout:string;stderr:string}>=>new Promise((resolve,reject)=>execFile(file,args,{maxBuffer:4*1024*1024},(error,stdout,stderr)=>error?reject(Object.assign(error,{stderr:String(stderr)})):resolve({stdout:String(stdout),stderr:String(stderr)})));

/** Reads a string key from the bundle's Info.plist (XML), without spawning anything. */
export function plistString(xml:string,key:string):string|undefined {
  const match=new RegExp(`<key>${key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}</key>\\s*<string>([^<]*)</string>`).exec(xml);
  return match?.[1]?.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
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
  /** Relaunch command; tests pass /usr/bin/true so nothing opens. */
  relaunch?:string;
}

export class AppUpdater {
  private status:UpdateStatus;
  private candidate?:ReleaseCandidate;
  private staged?:string;
  private timer?:NodeJS.Timeout;
  private busy=false;
  private readonly fetcher:typeof fetch;
  constructor(private readonly options:UpdaterOptions) {
    this.fetcher=options.fetch??fetch;
    const repo=options.repo&&REPO_PATTERN.test(options.repo)?options.repo:undefined;
    this.status=repo?{phase:'idle',current:options.current,channel:options.channel,autoCheck:true}
      :{phase:'disabled',current:options.current,channel:options.channel,autoCheck:false,message:'This build has no update source.'};
  }
  get repo():string|undefined {return this.options.repo&&REPO_PATTERN.test(this.options.repo)?this.options.repo:undefined;}
  snapshot():UpdateStatus {return {...this.status};}
  private set(patch:Partial<UpdateStatus>,replace=false):void {
    const base={current:this.status.current,channel:this.status.channel,autoCheck:this.status.autoCheck};
    this.status=replace?{...base,...patch} as UpdateStatus:{...this.status,...patch};
    this.options.emit(this.snapshot());
  }

  async start():Promise<void> {
    if(!this.repo)return;
    try{const saved=JSON.parse(await fs.readFile(this.options.settingsFile,'utf8'));if(typeof saved?.autoCheck==='boolean')this.status.autoCheck=saved.autoCheck;}catch{}
    this.schedule(30_000);
  }
  stop():void {if(this.timer)clearTimeout(this.timer);this.timer=undefined;}
  private schedule(delay:number):void {
    this.stop();
    if(!this.status.autoCheck||!this.repo)return;
    this.timer=setTimeout(()=>{void this.check({quiet:true}).finally(()=>this.schedule(6*60*60_000));},delay);
    this.timer.unref?.();
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
      const response=await this.fetcher(`https://api.github.com/repos/${repo}/releases?per_page=30`,{headers:{accept:'application/vnd.github+json','user-agent':`MusterAgent/${this.options.current}`}});
      if(!response.ok)throw new Error(response.status===403?'GitHub is rate-limiting update checks. Try again later.':`GitHub answered ${response.status} for the release list.`);
      const releases=await response.json() as GitHubRelease[];
      const checkedAt=new Date().toISOString();
      const candidate=pickRelease(Array.isArray(releases)?releases:[],this.options.current,this.options.channel,this.options.arch);
      if(!candidate){this.candidate=undefined;this.set({phase:'up-to-date',checkedAt},true);return this.snapshot();}
      this.candidate=candidate;
      this.set({phase:'available',latest:candidate.release,checkedAt},true);
      this.busy=false;
      await this.download();
    }catch(cause){
      this.set({phase:'error',message:cause instanceof Error?cause.message:String(cause),checkedAt:new Date().toISOString(),...(this.candidate?{latest:this.candidate.release}:{})},true);
    }finally{this.busy=false;}
    return this.snapshot();
  }

  private async download():Promise<void> {
    const candidate=this.candidate;
    if(!candidate||this.busy)return;
    this.busy=true;
    const {version}=candidate.release,dir=path.join(this.options.stagingDir,version);
    try{
      const sumsResponse=await this.fetcher(candidate.sums.browser_download_url,{headers:{'user-agent':`MusterAgent/${this.options.current}`}});
      if(!sumsResponse.ok)throw new Error(`Couldn’t read SHA256SUMS (${sumsResponse.status}).`);
      const expected=checksumFor(await sumsResponse.text(),candidate.zip.name);
      if(!expected)throw new Error(`SHA256SUMS has no entry for ${candidate.zip.name}.`);
      await fs.rm(dir,{recursive:true,force:true});await fs.mkdir(dir,{recursive:true});
      const zipPath=path.join(dir,candidate.zip.name);
      const response=await this.fetcher(candidate.zip.browser_download_url,{headers:{'user-agent':`MusterAgent/${this.options.current}`}});
      if(!response.ok||!response.body)throw new Error(`Download failed (${response.status}).`);
      const total=Number(response.headers.get('content-length'))||candidate.zip.size||0;
      const hash=createHash('sha256'),out=createWriteStream(zipPath);
      let received=0,lastEmit=0;
      this.set({phase:'downloading',progress:0});
      for await(const chunk of response.body as unknown as AsyncIterable<Uint8Array>){
        hash.update(chunk);received+=chunk.byteLength;
        if(!out.write(chunk))await new Promise<void>(resolve=>out.once('drain',()=>resolve()));
        if(total&&Date.now()-lastEmit>250){lastEmit=Date.now();this.set({progress:Math.min(1,received/total)});}
      }
      await new Promise<void>((resolve,reject)=>out.end((error?:Error|null)=>error?reject(error):resolve()));
      if(hash.digest('hex')!==expected)throw new Error('The download didn’t match its published checksum, so it was discarded.');
      const unpacked=path.join(dir,'app');
      await run('/usr/bin/ditto',['-x','-k',zipPath,unpacked]);
      const name=(await fs.readdir(unpacked)).find(entry=>entry.endsWith('.app'));
      if(!name)throw new Error('The update archive has no app inside.');
      const next=path.join(unpacked,name);
      await this.verify(next,version);
      await fs.rm(zipPath,{force:true});
      this.staged=next;
      this.set({phase:'ready',progress:1});
    }catch(cause){
      await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});
      this.set({phase:'error',message:cause instanceof Error?cause.message:String(cause)});
    }finally{this.busy=false;}
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

  /** Quits, swaps the bundle once this process has exited, and reopens the new version. */
  async install():Promise<UpdateStatus> {
    if(this.status.phase!=='ready'||!this.staged||!existsSync(this.staged))return this.snapshot();
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
    spawn('/bin/sh',[script,String(this.options.pid??process.pid),bundle!,this.staged],{detached:true,stdio:'ignore'}).unref();
    this.options.quit();
    return this.snapshot();
  }
}
