/**
 * Pure helpers for the scoped computer's resources (SBX-08), read-only layers and export (SBX-16),
 * and supervised services (SBX-15). No Docker access here: ScopedComputers owns every container call
 * behind its ownership gate; these functions validate input, build shell text, parse `docker stats`,
 * snapshot layer sources and write export archives on the host side.
 */
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {chmod,cp,lstat,mkdir,mkdtemp,readdir,rename,rm,stat,writeFile} from 'node:fs/promises';
import {basename,dirname,join,relative,sep} from 'node:path';
import {SCOPED_COMPUTER_DEFAULT_LIMITS,SCOPED_COMPUTER_LIMIT_BOUNDS,type ScopedComputerLayer,type ScopedComputerLayerId,type ScopedComputerLimits,type ScopedComputerRestartPolicy,type ScopedComputerServiceSpec} from '../shared/scoped-computer-protocol.ts';

export class ExtrasInputError extends Error {}
export const LAYER_TARGETS:Readonly<Record<ScopedComputerLayerId,string>> = {skills:'/opt/muster/skills',tools:'/opt/muster/tools'};
export const LAYER_IDS=Object.keys(LAYER_TARGETS) as ScopedComputerLayerId[];
export const MAX_SERVICES=16;
const MAX_LAYER_BYTES=512*1024**2,MAX_LAYER_FILES=50_000,MAX_WALK=100_000;
const RESTART:readonly ScopedComputerRestartPolicy[]=['never','on-failure','always'];

/* ---------- SBX-08 limits ---------- */

/** Merges a partial update onto the current limits; every value must sit on the bounds' grid. */
export function mergeLimits(current:ScopedComputerLimits,patch:unknown):ScopedComputerLimits {
  if(!patch||typeof patch!=='object'||Array.isArray(patch))throw new ExtrasInputError('Choose the sandbox limits to change.');
  const next={...current};
  for(const key of Object.keys(patch as object)){
    if(!(key in SCOPED_COMPUTER_LIMIT_BOUNDS))throw new ExtrasInputError(`Unknown sandbox limit: ${key}.`);
    const value=(patch as Record<string,unknown>)[key],bounds=SCOPED_COMPUTER_LIMIT_BOUNDS[key as keyof ScopedComputerLimits];
    if(typeof value!=='number'||!Number.isFinite(value)||value<bounds.min||value>bounds.max||!Number.isInteger(Math.round(value/bounds.step*1e6)/1e6))throw new ExtrasInputError(`${limitLabel(key as keyof ScopedComputerLimits)} must be between ${bounds.min} and ${bounds.max} in steps of ${bounds.step}.`);
    next[key as keyof ScopedComputerLimits]=value;
  }
  return next;
}
export function validLimits(value:unknown):value is ScopedComputerLimits {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='cpus,memoryMiB,processes')return false;
  try {mergeLimits(SCOPED_COMPUTER_DEFAULT_LIMITS,value);return true;}catch {return false;}
}
const limitLabel=(key:keyof ScopedComputerLimits)=>key==='memoryMiB'?'Memory':key==='cpus'?'CPUs':'Processes';
/**
 * Grant limits for the core. Default memory/CPU are left undeclared so containers created before limits were
 * configurable keep their policy digest; the core's executor applies the same defaults (512 MiB, 1 CPU).
 */
export function grantLimits(limits:ScopedComputerLimits,layers:readonly (ScopedComputerLayer&{source:string})[]) {
  return {
    maxProcesses:limits.processes,
    ...(limits.memoryMiB!==SCOPED_COMPUTER_DEFAULT_LIMITS.memoryMiB?{memoryMib:limits.memoryMiB}:{}),
    ...(limits.cpus!==SCOPED_COMPUTER_DEFAULT_LIMITS.cpus?{cpus:limits.cpus}:{}),
    ...(layers.length?{readOnlyMounts:layers.map(layer=>({source:layer.source,target:layer.target}))}:{}),
  };
}

/* ---------- live usage ---------- */

const UNITS:Record<string,number>={b:1,kb:1e3,mb:1e6,gb:1e9,tb:1e12,kib:1024,mib:1024**2,gib:1024**3,tib:1024**4};
export function parseSize(text:string):number|null {
  const match=/^\s*([\d.]+)\s*([a-z]*)\s*$/i.exec(text);if(!match)return null;
  const factor=UNITS[(match[2]||'b').toLowerCase()];const value=Number(match[1]);
  return factor&&Number.isFinite(value)?Math.round(value*factor):null;
}
/** One `docker stats --no-stream --format '{{json .}}'` line. */
export function parseStats(line:string):{memoryBytes:number|null;memoryLimitBytes:number|null;cpuPercent:number|null;pids:number|null} {
  let data:Record<string,unknown>={};try {data=JSON.parse(line.trim().split('\n')[0]||'{}');}catch {}
  const [used,limit]=typeof data.MemUsage==='string'?data.MemUsage.split('/'):[];
  const cpu=typeof data.CPUPerc==='string'?Number.parseFloat(data.CPUPerc):NaN,pids=typeof data.PIDs==='string'?Number.parseInt(data.PIDs,10):NaN;
  return {memoryBytes:used?parseSize(used):null,memoryLimitBytes:limit?parseSize(limit):null,cpuPercent:Number.isFinite(cpu)?cpu:null,pids:Number.isFinite(pids)?pids:null};
}

/* ---------- SBX-15 services ---------- */

export const shellQuote=(value:string)=>`'${value.replace(/'/g,`'\\''`)}'`;
export function validateServiceSpec(input:unknown):ScopedComputerServiceSpec {
  if(!input||typeof input!=='object')throw new ExtrasInputError('Describe the service to register.');
  const spec=input as Record<string,unknown>;
  const name=typeof spec.name==='string'?spec.name.trim():'';
  if(!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(name))throw new ExtrasInputError('Name the service with up to 64 letters, digits, spaces, dots, dashes or underscores.');
  if(typeof spec.command!=='string'||!spec.command.trim()||spec.command.length>16*1024||spec.command.includes('\0'))throw new ExtrasInputError('Enter the service command (up to 16 KiB).');
  const cwd=spec.cwd===undefined||spec.cwd===''?'/workspace':spec.cwd;
  if(typeof cwd!=='string'||cwd.length>1024||/[\0\r\n]/.test(cwd)||!(cwd==='/workspace'||cwd.startsWith('/workspace/'))||cwd.split('/').includes('..'))throw new ExtrasInputError('The service folder must be /workspace or a folder inside it.');
  const env:Record<string,string>={};
  if(spec.env!==undefined){
    if(!spec.env||typeof spec.env!=='object'||Array.isArray(spec.env))throw new ExtrasInputError('Service environment must be NAME=value pairs.');
    const entries=Object.entries(spec.env as Record<string,unknown>);if(entries.length>32)throw new ExtrasInputError('A service can set up to 32 environment variables.');
    for(const [key,value] of entries){if(!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)||typeof value!=='string'||value.length>4096||value.includes('\0'))throw new ExtrasInputError(`Invalid environment variable ${key.slice(0,64)}.`);env[key]=value;}
  }
  const restart=spec.restart===undefined?'never':spec.restart;
  if(!RESTART.includes(restart as ScopedComputerRestartPolicy))throw new ExtrasInputError('Choose a restart policy: never, on failure, or always.');
  if(spec.role!==undefined&&spec.role!=='browser')throw new ExtrasInputError('Unknown service role.');
  return {name,command:spec.command,cwd:cwd.replace(/\/+$/,'')||'/workspace',env,restart:restart as ScopedComputerRestartPolicy,...(spec.role==='browser'?{role:'browser' as const}:{})};
}
/** The shell text handed to the sandbox runner (which wraps it once more to report the process group). */
export function serviceShell(spec:ScopedComputerServiceSpec):string {
  const env=Object.entries(spec.env??{}).map(([key,value])=>`${key}=${shellQuote(value)}`).join(' ');
  return `cd ${shellQuote(spec.cwd??'/workspace')} && exec env ${env?`${env} `:''}sh -c ${shellQuote(spec.command)}`;
}
/** Exponential backoff for supervised restarts; `null` once it is crash-looping (5 restarts within a minute). */
export function restartDelay(recentRestarts:readonly number[],now=Date.now(),base=1000):number|null {
  const window=recentRestarts.filter(at=>now-at<60_000);
  if(window.length>=5)return null;
  return Math.min(30_000,base*2**window.length);
}

/* ---------- SBX-11 browser service ---------- */

export const BROWSER_SERVICE_NAME='Sandbox browser';
export const BROWSER_DEBUG_URL='http://127.0.0.1:9222';
/** Headless Chromium bound to the container's loopback; its DevTools endpoint never leaves the sandbox. */
export const BROWSER_SERVICE_COMMAND=[
  'B=""; for c in chromium chromium-browser google-chrome /opt/muster/tools/chromium/chrome /opt/muster/tools/chrome-linux/chrome; do if command -v "$c" >/dev/null 2>&1; then B="$c"; break; fi; done',
  'if [ -z "$B" ]; then echo "No Chromium in this sandbox. Add a tools layer that provides chromium/chrome, or install it in the container." >&2; exit 127; fi',
  'exec "$B" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --user-data-dir=/tmp/muster-browser --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 about:blank',
].join('\n');

/* ---------- SBX-16 layers ---------- */

/** Content version of a layer source: sha256 over sorted relative paths, modes and bytes. Links are skipped (never followed). */
export async function layerVersion(source:string):Promise<{version:string;files:number;bytes:number}> {
  const info=await lstat(source).catch(()=>null);
  if(!info||!info.isDirectory()||info.isSymbolicLink())throw new ExtrasInputError('That layer source is not a folder.');
  const files:string[]=[];let bytes=0,seen=0;const stack=[source];
  while(stack.length){
    const current=stack.pop()!;
    for(const entry of await readdir(current,{withFileTypes:true})){
      if(++seen>MAX_WALK)throw new ExtrasInputError('That layer has too many items.');
      const path=join(current,entry.name);
      if(entry.isDirectory())stack.push(path);
      else if(entry.isFile()){files.push(path);bytes+=(await lstat(path)).size;if(files.length>MAX_LAYER_FILES||bytes>MAX_LAYER_BYTES)throw new ExtrasInputError('That layer is too large (limit 512 MB or 50,000 files).');}
    }
  }
  files.sort();const hash=createHash('sha256');
  for(const file of files){
    hash.update(`${relative(source,file).split(sep).join('/')}\0${(await stat(file)).mode&0o111?'x':'-'}\0`);
    await new Promise<void>((resolve,reject)=>createReadStream(file).on('data',chunk=>hash.update(chunk)).on('error',reject).on('end',()=>resolve()));
    hash.update('\0');
  }
  return {version:hash.digest('hex').slice(0,12),files:files.length,bytes};
}
/**
 * Copies a source into `<layersRoot>/<id>/<version>` once (immutable: an existing version is reused, never rewritten),
 * without links, and strips write permission from its files; Docker mounts it read-only.
 */
export async function snapshotLayer(layersRoot:string,id:ScopedComputerLayerId,label:string,source:string):Promise<ScopedComputerLayer&{source:string}> {
  const {version}=await layerVersion(source);
  const dir=join(layersRoot,id),final=join(dir,version);
  await mkdir(dir,{recursive:true,mode:0o700});
  const existing=await lstat(final).catch(()=>null);
  if(existing&&(!existing.isDirectory()||existing.isSymbolicLink()))throw new ExtrasInputError('A saved layer snapshot is damaged. Remove it and try again.');
  if(!existing){
    const temp=join(dir,`.${version}.${randomUUID()}.tmp`);
    try {
      await cp(source,temp,{recursive:true,errorOnExist:true,force:false,filter:async path=>!(await lstat(path)).isSymbolicLink()});
      await readOnly(temp);await rename(temp,final);
    }catch(error){await makeWritable(temp).catch(()=>{});await rm(temp,{recursive:true,force:true});if((await lstat(final).catch(()=>null))?.isDirectory())return {id,label,version,target:LAYER_TARGETS[id],source:final};throw error;}
  }
  return {id,label,version,target:LAYER_TARGETS[id],source:final};
}
export const layerPath=(layersRoot:string,id:ScopedComputerLayerId,version:string)=>join(layersRoot,id,version);
async function readOnly(root:string):Promise<void> {
  for(const entry of await readdir(root,{withFileTypes:true})){const path=join(root,entry.name);if(entry.isDirectory())await readOnly(path);else if(entry.isFile())await chmod(path,((await stat(path)).mode&0o111)?0o555:0o444);}
  // Folders stay owner-writable so the app (and the user) can delete old versions; files are read-only and the mount is too.
  await chmod(root,0o755);
}
async function makeWritable(root:string):Promise<void> {
  await chmod(root,0o755).catch(()=>{});
  for(const entry of await readdir(root,{withFileTypes:true}).catch(()=>[])){const path=join(root,entry.name);if(entry.isDirectory())await makeWritable(path);}
}

/* ---------- SBX-16 export ---------- */

export interface TreeCounts {files:number;directories:number;symlinks:number;bytes:number;truncated:boolean}
export async function countTree(root:string,limit=MAX_WALK):Promise<TreeCounts> {
  const counts:TreeCounts={files:0,directories:0,symlinks:0,bytes:0,truncated:false};const stack=[root];let seen=0;
  while(stack.length){
    const current=stack.pop()!;let entries;try {entries=await readdir(current,{withFileTypes:true});}catch {continue;}
    for(const entry of entries){
      if(++seen>limit){counts.truncated=true;return counts;}
      const path=join(current,entry.name);
      if(entry.isSymbolicLink())counts.symlinks++;
      else if(entry.isDirectory()){counts.directories++;stack.push(path);}
      else if(entry.isFile()){counts.files++;counts.bytes+=(await lstat(path)).size;}
    }
  }
  return counts;
}
const run=(bin:string,args:string[])=>new Promise<void>((resolve,reject)=>execFile(bin,args,{timeout:30*60_000,maxBuffer:1024*1024,windowsHide:true},error=>error?reject(error):resolve()));
async function sha256File(path:string):Promise<string> {
  const hash=createHash('sha256');
  await new Promise<void>((resolve,reject)=>createReadStream(path).on('data',chunk=>hash.update(chunk)).on('error',reject).on('end',()=>resolve()));
  return hash.digest('hex');
}
/**
 * Writes `destination` (.tar.gz) holding `muster-export.json` and the `workspace/` folder. tar stores links as links
 * (never follows them), so nothing outside the workspace is read. The archive is built beside the destination and
 * renamed into place; the manifest with the archive's size and sha256 is written next to it.
 */
export async function writeWorkspaceArchive<T extends {archiveBytes:number;archiveSha256:string}>(workspace:string,destination:string,manifest:T,scratch:string,tarBin='tar'):Promise<{manifest:T;manifestPath:string}> {
  const staging=await mkdtemp(join(scratch,'export-'));
  const partial=join(dirname(destination),`.${basename(destination)}.${randomUUID()}.partial`);
  try {
    await writeFile(join(staging,'muster-export.json'),`${JSON.stringify(manifest,null,2)}\n`,{mode:0o600});
    await run(tarBin,['-czf',partial,'-C',staging,'muster-export.json','-C',dirname(workspace),basename(workspace)]);
    await rename(partial,destination);
  }catch(error){await rm(partial,{force:true});throw error;}
  finally {await rm(staging,{recursive:true,force:true});}
  const final={...manifest,archiveBytes:(await stat(destination)).size,archiveSha256:await sha256File(destination)};
  const manifestPath=`${destination}.manifest.json`;
  await writeFile(manifestPath,`${JSON.stringify(final,null,2)}\n`,{mode:0o600});
  return {manifest:final,manifestPath};
}
