import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import * as nodeFs from 'node:fs';
import {homedir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import type {ProviderInfo} from '../shared/protocol.ts';
import {catalogPricing,type ExcludedModel} from '../shared/model-catalog.ts';
import type {RunnableAdapter, Validation} from './adapters/types.ts';
import {findBinary, locateCli, Validator} from './adapters/shared.ts';
import {fetchModelList,type ListedModel} from './adapters/http-chat.ts';

export interface ProviderInstance {
  info: ProviderInfo;
  command: string;
  env: Record<string,string>;
  sessionsRoot: string;
  /** Set for non-Codex routes (Claude Code, OpenCode, HTTP APIs); run() delegates to it instead of the app-server. */
  adapter?: RunnableAdapter;
}
/** The subset of node:fs this module touches; tests inject a counting wrapper. */
export type ProviderInstanceFs=Pick<typeof nodeFs,'openSync'|'fstatSync'|'readSync'|'closeSync'|'existsSync'|'accessSync'|'statSync'|'readdirSync'>;
export interface ProviderInstanceOptions {accountsFile?:string;directory?:string;home?:string;env?:NodeJS.ProcessEnv;fs?:Partial<ProviderInstanceFs>;now?:()=>number;/** Model listing for gateways without a catalog (tests). */fetch?:typeof fetch}
const {constants}=nodeFs;
const MAX_BYTES=1024*1024;
function boundedFile(fs:ProviderInstanceFs,file:string):string {
  const fd=fs.openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>MAX_BYTES)throw new Error('Unsupported configuration file.');
    const bytes=Buffer.alloc(MAX_BYTES+1);let length=0;
    while(length<bytes.length){const count=fs.readSync(fd,bytes,length,bytes.length-length,null);if(!count)break;length+=count;}
    if(length>MAX_BYTES)throw new Error('Configuration is too large.');
    return bytes.subarray(0,length).toString('utf8');
  } finally {fs.closeSync(fd);}
}
const EFFORTS=['low','medium','high','xhigh'] as const;
type Effort=typeof EFFORTS[number];
const effort=(value:unknown):Effort|undefined=>{const raw=value&&typeof value==='object'?(value as {effort?:unknown}).effort:value;return EFFORTS.find(item=>item===raw);};
/** Provider-reported reasoning levels (Codex `supported_reasoning_levels` / `default_reasoning_level`); absent when the catalog does not say. */
export function catalogEfforts(entry:Record<string,unknown>):{efforts?:Effort[];defaultEffort?:Effort} {
  const listed=entry.supported_reasoning_levels??entry.supportedReasoningLevels??entry.reasoning_efforts??entry.reasoningEfforts;
  const efforts=Array.isArray(listed)?EFFORTS.filter(item=>listed.some(value=>effort(value)===item)):[];
  const fallback=effort(entry.default_reasoning_level??entry.defaultReasoningLevel??entry.default_reasoning_effort??entry.defaultReasoningEffort);
  const defaultEffort=fallback&&(!efforts.length||efforts.includes(fallback))?fallback:undefined;
  return {...(efforts.length?{efforts}:{}),...(defaultEffort?{defaultEffort}:{})};
}
const directModel=(id:string)=>/^(?:gpt-[a-zA-Z0-9.-]+|o[1-9][a-zA-Z0-9.-]*)$/.test(id);
const MAX_CATALOG_ENTRIES=500;
/** PRO-04: the catalog decides what a route offers (this replaced a hardcoded gateway allowlist). Every entry
 * that is left out is returned in `excluded` with the reason, so nothing disappears silently. */
/** A router's own agents and combos ("combo" owner), named for the picker: "intelligent-planner" reads
 *  "Intelligent planner", "auto/best-coding" reads "Auto · best coding". */
export function routerAgents(listed:readonly ListedModel[]):Models {
  const pretty=(id:string)=>{const [head,...rest]=id.split('/');const words=(text:string)=>text.replace(/[-_:]+/g,' ').trim();
    const first=words(rest.length?head!:id);const title=first.charAt(0).toUpperCase()+first.slice(1);return rest.length?`${title} · ${words(rest.join('/'))}`:title;};
  // Named agents (planner, advisor, executor…) first, then auto/… routes.
  const combos=listed.filter(entry=>entry.owner==='combo'&&entry.chat!==false);
  return [...combos.filter(entry=>!entry.id.includes('/')),...combos.filter(entry=>entry.id.includes('/'))].slice(0,200).map(entry=>({id:entry.id,name:entry.name&&entry.name!==entry.id?entry.name:pretty(entry.id)}));
}
export function catalogModels(family:'openai-direct'|'gateway'|(string&{}),list:readonly unknown[]):{models:ProviderInfo['models'];excluded:ExcludedModel[]} {
  const models:ProviderInfo['models']=[],excluded:ExcludedModel[]=[];
  list.slice(0,MAX_CATALOG_ENTRIES).forEach((raw,index)=>{
    const entry=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:undefined;
    const model=entry?.slug??entry?.model??entry?.id;
    if(!entry||typeof model!=='string'||!model.trim()||model.length>200||/[\x00-\x1f]/.test(model)){excluded.push({id:`entry-${index+1}`,name:`Catalog entry ${index+1}`,reason:'The catalog entry has no usable model id.'});return;}
    const label=entry.display_name??entry.displayName??entry.name??model;
    const name=typeof label==='string'&&label.trim()?label.replace(/[\x00-\x1f]/g,'').slice(0,160):model;
    if(models.some(m=>m.id===model)){excluded.push({id:model,name,reason:'Listed more than once in the catalog; the first entry is used.'});return;}
    if(entry.hidden===true||entry.visibility==='hide'||entry.visibility==='hidden'){excluded.push({id:model,name,reason:'The provider catalog marks this model hidden.'});return;}
    if(family==='openai-direct'&&!directModel(model)){excluded.push({id:model,name,reason:'OpenAI Direct runs OpenAI model ids only; use a gateway profile for this model.'});return;}
    const modalities=entry.input_modalities??entry.inputModalities;
    const window=typeof entry.context_window==='number'&&entry.context_window>0?entry.context_window:typeof entry.contextWindow==='number'&&entry.contextWindow>0?entry.contextWindow:undefined;
    const search=entry.supports_search_tool??entry.supportsSearchTool;
    const pricing=catalogPricing(entry);
    models.push({id:model,name,...catalogEfforts(entry),...(Array.isArray(modalities)?{images:modalities.includes('image')}:{}),...(typeof search==='boolean'?{toolSearch:search}:{}),...(window?{contextWindow:window}:{}),...(pricing?{pricing}:{})});
  });
  if(list.length>MAX_CATALOG_ENTRIES)excluded.push({id:'catalog-overflow',name:`${list.length-MAX_CATALOG_ENTRIES} more catalog entries`,reason:`Only the first ${MAX_CATALOG_ENTRIES} catalog entries are read.`});
  return {models,excluded};
}

/** info() runs on every send, model change and providers.list. Reading and hashing
 * the profile, catalog and auth files each time is blocking I/O on a hot path, so
 * the result is memoised on a (path, mtime, ctime, size, mode) fingerprint of every
 * file it touched. The fingerprint is re-stat'ed at most once per second, except
 * while a tracked file was written within the last two seconds: a burst of writes
 * (token refresh, sign-in, a test rewriting a catalog) can land inside one stat
 * window, so recently written files are re-stat'ed on every call until they settle. */
export const PROVIDER_INSTANCES_STAT_INTERVAL_MS=1000;
const RECENT_WRITE_MS=2000;
const MAX_MEMOS=8;
interface Stamp {stamp:string;writtenAt:number}
interface Memo {checkedAt:number;files:Map<string,Stamp>;value:ProviderInstance[]}
const memos=new Map<string,Memo>();
/** Drops every memoised instance list; the next info() re-reads configuration. */
export function invalidateProviderInstances():void {memos.clear();}
/** PRO-05: every execution re-stats the catalog, profile and auth files (skipping the 1s throttle); files are re-read only when they changed. */
export function revalidateProviderInstances():void {for(const memo of memos.values())memo.checkedAt=Number.NEGATIVE_INFINITY;}
function stamp(fs:ProviderInstanceFs,file:string):Stamp {
  let stat:nodeFs.Stats|undefined;
  try {stat=fs.statSync(file,{throwIfNoEntry:false});} catch {stat=undefined;}
  return stat?{stamp:`${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.mode}`,writtenAt:stat.mtimeMs}:{stamp:'missing',writtenAt:0};
}
function fresh(fs:ProviderInstanceFs,memo:Memo,at:number):boolean {
  let recent=false;
  for(const file of memo.files.values())if(memo.checkedAt-file.writtenAt<RECENT_WRITE_MS){recent=true;break;}
  if(!recent&&at-memo.checkedAt<PROVIDER_INSTANCES_STAT_INTERVAL_MS)return true;
  for(const [file,known] of memo.files)if(stamp(fs,file).stamp!==known.stamp)return false;
  memo.checkedAt=at;return true;
}
/** Names of enabled `[mcp_servers.<name>]` tables in a Codex config.toml. Names only:
 * commands, URLs, env and headers are never read out of the file. */
export function mcpServerNames(text:string):string[] {
  const servers=new Map<string,boolean>();let current:string|undefined;
  for(const line of text.split(/\r?\n/)){
    const header=/^\s*\[(?!\[)\s*(.+?)\s*\]\s*(?:#.*)?$/.exec(line);
    if(header){
      const path=keyPath(header[1]!);current=undefined;
      if(path?.[0]==='mcp_servers'&&path[1]){if(!servers.has(path[1]))servers.set(path[1],true);if(path.length===2)current=path[1];}
      continue;
    }
    if(/^\s*\[\[/.test(line)){current=undefined;continue;}
    if(current&&/^\s*enabled\s*=\s*false\b/.test(line))servers.set(current,false);
  }
  return [...servers].filter(([name,on])=>on&&name.length<=64&&!/[\x00-\x1f]/.test(name)).map(([name])=>name).slice(0,64);
}
function keyPath(raw:string):string[]|undefined {
  const parts:string[]=[];const pattern=/\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y;let at=0;
  while(at<raw.length){pattern.lastIndex=at;const match=pattern.exec(raw);if(!match)return undefined;parts.push(match[1]??match[2]??match[3]!);at=pattern.lastIndex;if(!match[4])break;}
  return at>=raw.length?parts:undefined;
}
export const mcpDetail=(names:string[])=>names.length?`Inherits ${names.length} MCP ${names.length===1?'server':'servers'} from Codex config (${names.slice(0,6).join(', ')}${names.length>6?', …':''}).`:'No MCP servers are configured in the Codex config.';

/** Extra CODEX_HOME accounts (PRO-X2) live in `<dataDir>/provider-accounts.json` as
 * `{"accounts":[{"codexHome":"/abs/path","label":"Work"}]}`. The service's data dir is
 * registered by whichever runtime owns it; tests pass `accountsFile` directly. */
let registeredDataDir:string|undefined;
export function registerProviderDataDir(dir:string|undefined):void {registeredDataDir=dir;invalidateProviderInstances();}
export const providerDataDir=():string|undefined=>registeredDataDir;
export const providerAccountsFile=(dataDir:string)=>join(dataDir,'provider-accounts.json');
export interface ProviderAccount {codexHome:string;label?:string}
export function parseProviderAccounts(text:string):ProviderAccount[] {
  const raw=JSON.parse(text) as unknown;
  const list=Array.isArray(raw)?raw:raw&&typeof raw==='object'?(raw as {accounts?:unknown}).accounts:undefined;
  if(!Array.isArray(list))throw new Error('provider-accounts.json must hold an "accounts" array.');
  const accounts:ProviderAccount[]=[];
  for(const entry of list.slice(0,16)){
    const codexHome=typeof entry==='string'?entry:entry&&typeof entry==='object'?(entry as {codexHome?:unknown}).codexHome:undefined;
    const label=entry&&typeof entry==='object'?(entry as {label?:unknown}).label:undefined;
    if(typeof codexHome!=='string'||!isAbsolute(codexHome)||codexHome.length>1024||/[\x00-\x1f]/.test(codexHome)||accounts.some(a=>a.codexHome===codexHome))continue;
    accounts.push({codexHome,...(typeof label==='string'&&label.trim()&&label.length<=60&&!/[\x00-\x1f]/.test(label)?{label:label.trim()}:{})});
  }
  return accounts;
}
function readAccounts(fs:ProviderInstanceFs,file:string):ProviderAccount[] {
  try {return parseProviderAccounts(boundedFile(fs,file));} catch {return [];}
}
/** Adds (or relabels) an extra CODEX_HOME account. Only the path and label are stored. */
export function saveProviderAccount(dataDir:string,input:{codexHome:unknown;label?:unknown}):ProviderAccount[] {
  const file=providerAccountsFile(dataDir);
  if(typeof input.codexHome!=='string'||!isAbsolute(input.codexHome)||/[\x00-\x1f]/.test(input.codexHome))throw new Error('Choose an absolute Codex home folder.');
  if(!nodeFs.statSync(input.codexHome,{throwIfNoEntry:false})?.isDirectory())throw new Error('That Codex home folder does not exist.');
  let accounts:ProviderAccount[]=[];try {accounts=parseProviderAccounts(nodeFs.readFileSync(file,'utf8'));} catch {accounts=[];}
  const next=parseProviderAccounts(JSON.stringify({accounts:[...accounts.filter(a=>a.codexHome!==input.codexHome),{codexHome:input.codexHome,label:input.label}]}));
  if(!next.some(a=>a.codexHome===input.codexHome))throw new Error('At most 16 extra accounts are supported.');
  writeAccounts(file,next);return next;
}
export function removeProviderAccount(dataDir:string,codexHome:string):ProviderAccount[] {
  const file=providerAccountsFile(dataDir);let accounts:ProviderAccount[]=[];try {accounts=parseProviderAccounts(nodeFs.readFileSync(file,'utf8'));} catch {return [];}
  const next=accounts.filter(a=>a.codexHome!==codexHome);writeAccounts(file,next);return next;
}
function writeAccounts(file:string,accounts:ProviderAccount[]):void {
  const temp=`${file}.${process.pid}.tmp`;nodeFs.writeFileSync(temp,JSON.stringify({accounts},null,2)+'\n',{mode:0o600});nodeFs.renameSync(temp,file);invalidateProviderInstances();
}
export const accountHash=(codexHome:string)=>createHash('sha256').update(codexHome).digest('hex').slice(0,10);
function maskedEmail(idToken:unknown):string|undefined {
  if(typeof idToken!=='string'||idToken.length>16384)return undefined;
  try {
    const claims=JSON.parse(Buffer.from(idToken.split('.')[1]??'','base64url').toString('utf8')) as Record<string,unknown>;
    const email=claims.email??(claims['https://api.openai.com/profile'] as Record<string,unknown>|undefined)?.email;
    return typeof email==='string'&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)&&email.length<=254?`${email[0]}***${email.slice(email.indexOf('@'))}`:undefined;
  } catch {return undefined;}
}

/** A Codex route found in the user's own Codex configuration. Nothing here is assumed: the provider id,
 * its display name, endpoint and model catalog all come from `<CODEX_HOME>/config.toml`, the profile files
 * beside it (`<name>.config.toml`) and Codex's own model cache. */
interface CodexRouteSpec {
  modelProvider: string;
  kind: 'chatgpt' | 'gateway';
  /** Profile file stem, when the route comes from `<name>.config.toml`; else the table lives in config.toml. */
  profile?: string;
  name?: string; baseUrl?: string; envKey?: string; authCommand?: {command: string; args: string[]; timeoutMs?: number};
  catalogPath?: string;
  /** Profile text or config table, hashed into the binding so an edited route needs reselection. */
  fingerprint: string;
  invalid?: string;
}
interface CodexToml {values: Map<string,string>; multiline: Set<string>}
interface CodexProfileModule {profileOverrides(profile:string,text:string):string[]; parseToml(text:string):CodexToml}
const RESERVED=/^(?:claude-code|opencode|codex|openai-direct|env-.*|local-.*|custom_.*)$/;
const PROFILE_FILE=/^([A-Za-z0-9_.-]{1,64})\.config\.toml$/;
const MAX_PROFILES=32;
const tomlString=(toml:CodexToml,key:string):string|undefined=>{const raw=toml.values.get(key);if(raw===undefined)return undefined;try {const value=JSON.parse(raw) as unknown;return typeof value==='string'?value:undefined;} catch {return undefined;}};
const tomlArray=(toml:CodexToml,key:string):string[]|undefined=>{const raw=toml.values.get(key);if(raw===undefined)return undefined;try {const value=JSON.parse(raw) as unknown;return Array.isArray(value)&&value.every(item=>typeof item==='string')?value as string[]:undefined;} catch {return undefined;}};
const tomlNumber=(toml:CodexToml,key:string):number|undefined=>{const value=Number(toml.values.get(key));return Number.isFinite(value)&&value>0?value:undefined;};
/** The provider table `[model_providers.<id>]` of a parsed Codex TOML file. */
function providerTable(toml:CodexToml,id:string):Pick<CodexRouteSpec,'name'|'baseUrl'|'envKey'|'authCommand'>&{defined:boolean} {
  const at=`model_providers.${id}.`,command=tomlString(toml,`${at}auth.command`);
  return {defined:[...toml.values.keys()].some(key=>key.startsWith(at)),name:tomlString(toml,`${at}name`),baseUrl:tomlString(toml,`${at}base_url`),envKey:tomlString(toml,`${at}env_key`),
    ...(command?{authCommand:{command,args:tomlArray(toml,`${at}auth.args`)??[],...(tomlNumber(toml,`${at}auth.timeout_ms`)?{timeoutMs:tomlNumber(toml,`${at}auth.timeout_ms`)}:{})}}:{})};
}
/** Ids of every `[model_providers.<id>]` table in a parsed Codex TOML file. */
function providerIds(toml:CodexToml):string[] {
  const ids=new Set<string>();
  for(const key of [...toml.values.keys(),...toml.multiline]){const match=/^model_providers\.([A-Za-z0-9_-]{1,64})\./.exec(key);if(match)ids.add(match[1]!);}
  return [...ids];
}
const humanize=(id:string)=>id.split(/[-_]+/).filter(Boolean).map(word=>word[0]!.toUpperCase()+word.slice(1)).join(' ')||id;

/** Every Codex route in one CODEX_HOME: each profile file, each provider table in config.toml no profile covers,
 * and the ChatGPT sign-in (OpenAI's own provider) when Codex has one. */
function codexRoutes(fs:ProviderInstanceFs,codexHome:string,track:(file:string)=>string,validator:CodexProfileModule|undefined,signedIn:boolean):CodexRouteSpec[] {
  const routes:CodexRouteSpec[]=[];
  let config:CodexToml={values:new Map(),multiline:new Set()},configText='';
  try {configText=boundedFile(fs,track(join(codexHome,'config.toml')));config=validator?.parseToml(configText)??config;} catch {/* no config.toml, or not parseable */}
  const topProvider=tomlString(config,'model_provider')??'openai',topCatalog=tomlString(config,'model_catalog_json');
  let names:string[]=[];
  try {track(codexHome);names=(fs.readdirSync(codexHome) as string[]).filter(name=>PROFILE_FILE.test(name)&&name!=='config.toml').sort().slice(0,MAX_PROFILES);} catch {names=[];}
  for(const name of names){
    const profile=PROFILE_FILE.exec(name)![1]!;
    let text:string;
    try {text=boundedFile(fs,track(join(codexHome,name)));} catch {continue;}
    let toml:CodexToml|undefined;try {toml=validator?.parseToml(text);} catch {toml=undefined;}
    const modelProvider=toml?tomlString(toml,'model_provider'):undefined;
    if(!modelProvider||!/^[A-Za-z0-9_-]{1,64}$/.test(modelProvider)){
      // A TOML file that names no provider is not a route; one that cannot be parsed still shows why.
      if(!toml&&/^\s*model_provider\s*=/m.test(text))routes.push({modelProvider:profile.replace(/[^A-Za-z0-9_-]/g,'-'),kind:'gateway',profile,fingerprint:text,invalid:'The profile could not be read as TOML.'});
      continue;
    }
    let invalid:string|undefined;
    try {validator?.profileOverrides(profile,text);} catch (error) {invalid=error instanceof Error?error.message:'The profile did not validate.';}
    const table=providerTable(toml!,modelProvider),fromConfig=table.defined?table:providerTable(config,modelProvider);
    routes.push({modelProvider,kind:modelProvider==='openai'?'chatgpt':'gateway',profile,name:fromConfig.name,baseUrl:fromConfig.baseUrl,envKey:fromConfig.envKey,...(fromConfig.authCommand?{authCommand:fromConfig.authCommand}:{}),catalogPath:tomlString(toml!,'model_catalog_json'),fingerprint:text,...(invalid?{invalid}:{})});
  }
  for(const id of providerIds(config)){
    if(id==='openai'||routes.some(route=>route.modelProvider===id&&!route.invalid))continue;
    const table=providerTable(config,id);
    routes.push({modelProvider:id,kind:'gateway',...table,catalogPath:topProvider===id?topCatalog:undefined,fingerprint:JSON.stringify([id,table])});
  }
  // OpenAI's own provider needs no table: a Codex sign-in is enough.
  if(signedIn&&!routes.some(route=>route.modelProvider==='openai'&&!route.invalid))routes.push({modelProvider:'openai',kind:'chatgpt',catalogPath:topProvider==='openai'?topCatalog:undefined,fingerprint:'openai'});
  return routes;
}

/** Stable provider ids: OpenAI's own route is `openai-direct`; a gateway keeps its Codex provider id (so a chat
 * bound to it keeps working), prefixed when it would collide with another Muster route. */
function routeIds(routes:CodexRouteSpec[]):string[] {
  const used=new Set<string>();
  return routes.map(route=>{
    let id=route.modelProvider==='openai'?'openai-direct':RESERVED.test(route.modelProvider)?`codex-${route.modelProvider}`:route.modelProvider;
    if(used.has(id)&&route.profile)id=`${id}-${route.profile.replace(/[^A-Za-z0-9-]/g,'-')}`;
    while(used.has(id))id=`${id}-2`;
    used.add(id);return id;
  });
}

/** A gateway with no model catalog lists its models from `<base_url>/models`, the way it would authenticate a run:
 * its `env_key` variable, its own `auth.command` helper (the one Codex runs), or nothing for a local endpoint. */
type Models=ProviderInfo['models'];
const listings=new Map<string,Validator<ListedModel[]>>();
const settleListeners=new Set<()=>void>();
/** Called when a model listing settles, so a cached instance list is rebuilt with its result. */
export function onProviderListingSettled(listener:()=>void):()=>void {settleListeners.add(listener);return ()=>settleListeners.delete(listener);}
/** Resolves once no model listing is in flight. */
export async function providerListingsSettled():Promise<void> {await Promise.all([...listings.values()].map(listing=>listing.settled()));}
async function helperToken(command:{command:string;args:string[];timeoutMs?:number},env:NodeJS.ProcessEnv):Promise<string> {
  return new Promise((resolve,reject)=>execFile(command.command,command.args,{timeout:Math.min(command.timeoutMs??5000,15_000),maxBuffer:64*1024,env,encoding:'utf8'},(error,stdout)=>{
    const token=String(stdout??'').trim().split('\n')[0]??'';
    if(error||!token)reject(new Error('The provider’s auth helper did not return a token.'));else resolve(token);
  }));
}
function listing(route:CodexRouteSpec,env:NodeJS.ProcessEnv,fetcher:typeof fetch|undefined):Validation<ListedModel[]> {
  const base=route.baseUrl!.replace(/\/+$/,''),key=JSON.stringify([base,route.envKey??'',route.authCommand?.command??'',route.envKey?createHash('sha256').update(env[route.envKey]??'').digest('hex'):'']);
  let found=listings.get(key);
  if(!found){
    found=new Validator<ListedModel[]>(async()=>{
      const token=route.envKey?env[route.envKey]:route.authCommand?await helperToken(route.authCommand,env):undefined;
      if(route.envKey&&!token)throw new Error(`${route.envKey} is not set in Muster’s environment.`);
      const models=await fetchModelList(`${base}/models`,token?{authorization:`Bearer ${token}`}:{},route.name??route.modelProvider,fetcher);
      return models;
    });
    if(listings.size>=32)listings.delete(listings.keys().next().value!);
    listings.set(key,found);
  }
  const before=found.current(key);
  if(before.status==='pending')void found.settled().then(()=>{invalidateProviderInstances();for(const listener of settleListeners)listener();});
  return before;
}

/** Node for the launcher: MUSTER_PROVIDER_NODE, a `node` on PATH or in a standard location, else Electron itself run as Node. */
export function providerNode(env:NodeJS.ProcessEnv=process.env,home:string=homedir()):{node:string;env:Record<string,string>} {
  if(env.MUSTER_PROVIDER_NODE)return {node:env.MUSTER_PROVIDER_NODE,env:{}};
  const found=findBinary('node',env,home);
  if(found)return {node:found,env:{}};
  return process.versions.electron?{node:process.execPath,env:{ELECTRON_RUN_AS_NODE:'1'}}:{node:process.execPath,env:{}};
}
/** The Codex CLI: MUSTER_CODEX_COMMAND, else `codex` on PATH, a standard install location, or a ChatGPT/Codex app bundle. */
export const codexCli=(env:NodeJS.ProcessEnv,home:string):string|undefined=>env.MUSTER_CODEX_COMMAND||locateCli('codex',env,home);

/** The launcher's own profile validator and TOML reader: bundled beside the launcher, or (running from source) the
 *  app's own resources/ copy. Only this file decides what a valid profile is. */
function profileModule(directory:string):CodexProfileModule|undefined {
  // Bundled: dist/runtime/resources. From source (tests run ESM, where __dirname is undefined): packages/agent-app/resources.
  const here=typeof __dirname==='string'?__dirname:join(process.cwd(),'src','runtime');
  for(const file of [join(directory,'resources','codex-profile.cjs'),join(here,'resources','codex-profile.cjs'),join(here,'..','..','resources','codex-profile.cjs')]){
    try {return createRequire(join(directory,'provider-instances.cjs'))(file) as CodexProfileModule;} catch {/* next location */}
  }
  return undefined;
}
/** Routes read from the user's Codex configuration. This does not authenticate, start Codex, or verify upstream
 * entitlement; a gateway without a catalog is asked for its model list (see `listing`). The default CODEX_HOME
 * keeps plain ids; each extra account adds `<id>_<hash>`. */
export function configuredProviderInstances(options:ProviderInstanceOptions={}):ProviderInstance[] {
  const directory=options.directory??(typeof __dirname==='string'?__dirname:join(process.cwd(),'src','runtime')),home=options.home??homedir(),env=options.env??process.env;
  const fs:ProviderInstanceFs=options.fs?{...nodeFs,...options.fs}:nodeFs;
  const at=(options.now??Date.now)();
  const codexHome=env.CODEX_HOME||join(home,'.codex');
  const cli=codexCli(env,home);
  const accountsFile=options.accountsFile??(registeredDataDir?providerAccountsFile(registeredDataDir):undefined);
  const key=JSON.stringify([directory,codexHome,cli??'',env.MUSTER_PROVIDER_NODE??'',accountsFile??'',env.PATH??'']);
  const memo=memos.get(key);
  if(memo&&fresh(fs,memo,at))return memo.value;
  const files=new Map<string,Stamp>();
  const track=(file:string)=>{if(!files.has(file))files.set(file,stamp(fs,file));return file;};
  const node=providerNode(env,home);
  if(cli)track(cli);
  const validator=profileModule(directory);
  const context={fs,directory,cli,node,env,track,validator,fetch:options.fetch};
  const extra=accountsFile?readAccounts(fs,track(accountsFile)).filter(account=>account.codexHome!==codexHome):[];
  const value=[...homeInstances({...context,codexHome}),...extra.flatMap(account=>homeInstances({...context,codexHome:account.codexHome,account}))];
  if(!memo&&memos.size>=MAX_MEMOS)memos.delete(memos.keys().next().value!);
  memos.set(key,{checkedAt:at,files,value});
  return value;
}
interface HomeContext {fs:ProviderInstanceFs;directory:string;codexHome:string;cli?:string;node:{node:string;env:Record<string,string>};env:NodeJS.ProcessEnv;track(file:string):string;validator?:CodexProfileModule;fetch?:typeof fetch;account?:ProviderAccount}
function homeInstances({fs,directory,codexHome,cli,node,env,track,validator,fetch:fetcher,account}:HomeContext):ProviderInstance[] {
  let mcp:string[]=[];
  try {mcp=mcpServerNames(boundedFile(fs,track(join(codexHome,'config.toml'))));} catch {mcp=[];}
  const suffix=account?`_${accountHash(account.codexHome)}`:'';
  let auth:{tokens?:{id_token?:unknown;account_id?:unknown;access_token?:unknown};OPENAI_API_KEY?:unknown}|undefined;
  try {auth=JSON.parse(boundedFile(fs,track(join(codexHome,'auth.json'))));} catch {auth=undefined;}
  const email=account?maskedEmail(auth?.tokens?.id_token):undefined;
  // A sign-in held outside auth.json (Keychain, the ChatGPT app's own CLI) still leaves Codex's model cache behind, which
  // Codex only writes after an authenticated model listing: then the ChatGPT route is offered without asking to sign in.
  let cached=false;try {cached=fs.statSync(track(join(codexHome,'models_cache.json')),{throwIfNoEntry:false})?.isFile()===true;} catch {cached=false;}
  const signedIn=Boolean(auth)||(!account&&Boolean(cli)&&cached);
  const routes=codexRoutes(fs,codexHome,track,validator,signedIn);
  const ids=routeIds(routes);
  const names=routes.map(route=>route.kind==='chatgpt'?'OpenAI (ChatGPT sign-in)':route.name?.replace(/[\x00-\x1f]/g,'').slice(0,80)||humanize(route.modelProvider));
  const command=track(join(directory,'resources','codex-launch.sh'));
  return routes.map<ProviderInstance>((route,index)=>{
    const id=`${ids[index]}${suffix}`;
    const duplicate=names.filter(name=>name===names[index]).length>1&&route.profile;
    const label=duplicate?`${names[index]} (${route.profile})`:names[index]!;
    const name=account?`${label} · ${account.label??email??`account ${suffix.slice(1,7)}`}`:label;
    const catalogPath=route.catalogPath&&isAbsolute(route.catalogPath)?route.catalogPath:undefined;
    const childEnv:Record<string,string>={MUSTER_PROVIDER_NODE:node.node,...node.env,CODEX_HOME:codexHome,...(cli?{MUSTER_CODEX_COMMAND:cli}:{}),
      ...(route.profile?{MUSTER_CODEX_PROFILE:route.profile}:{MUSTER_CODEX_PROVIDER:route.modelProvider,...(catalogPath?{MUSTER_CODEX_CATALOG:catalogPath}:{})})};
    const codex={modelProvider:route.modelProvider,kind:route.kind,...(route.profile?{profile:route.profile}:{}),...(account?{account:suffix.slice(1)}:{})} satisfies NonNullable<ProviderInfo['codex']>;
    const source=route.profile?`Codex profile ${route.profile}.config.toml${account?` in ${account.codexHome}`:''}`:route.kind==='chatgpt'?`Codex sign-in${account?` at ${account.codexHome}`:''}`:`[model_providers.${route.modelProvider}] in Codex config.toml${account?` at ${account.codexHome}`:''}`;
    const base={id,name,driver:'codex-app-server',codex,identityMasked:route.kind==='gateway'?'Gateway · account hidden':email??'ChatGPT account · hidden',models:[],available:false,source,...(route.baseUrl?{endpoint:route.baseUrl}:{})} satisfies ProviderInfo;
    const sessionsRoot=join(codexHome,'sessions');
    const fail=(error:string,status:'configured'|'error'='configured'):ProviderInstance=>({info:{...base,status,error,detail:`${error} No provider fallback will be used. ${mcpDetail(mcp)}`},command,env:childEnv,sessionsRoot});
    if(route.invalid)return fail(`${route.profile}.config.toml did not validate: ${route.invalid}`,'error');
    try {fs.accessSync(command,constants.X_OK);} catch {return fail('Muster’s bundled Codex launcher is missing. Reinstall Muster.','error');}
    if(!cli)return fail('The Codex CLI was not found. Install it, or set MUSTER_CODEX_COMMAND to its path.');
    try {fs.accessSync(cli,constants.X_OK);} catch {return fail(`The Codex CLI at ${cli} is not executable.`);}
    let list:unknown[]|undefined,incremental=false,catalogSource='';
    if(catalogPath){
      try {const catalog=JSON.parse(boundedFile(fs,track(catalogPath))) as {models?:unknown;reports_incremental_input?:unknown};if(Array.isArray(catalog.models)){list=catalog.models;incremental=catalog.reports_incremental_input===true;catalogSource='its model catalog';}} catch {list=undefined;}
      if(!list)return fail(`The model catalog ${catalogPath} is missing, unreadable or has no "models" array.`);
    } else if(route.kind==='chatgpt'){
      // Codex keeps the model list of a ChatGPT sign-in in its own cache.
      try {const cache=JSON.parse(boundedFile(fs,track(join(codexHome,'models_cache.json')))) as {models?:unknown};if(Array.isArray(cache.models)){list=cache.models;catalogSource='Codex’s model cache';}} catch {list=undefined;}
      if(!list)return fail('Codex has not listed this account’s models yet. Run `codex` once, or set model_catalog_json in config.toml.');
    }
    let models:Models,excluded:ExcludedModel[]=[];
    if(list){
      ({models,excluded}=catalogModels(route.kind==='chatgpt'?'openai-direct':'gateway',list));
      // A gateway with a hand-written catalog also offers the router's own agents and combos (owned_by "combo":
      // planner, advisor, executor, auto routes), read live so new ones appear without editing the catalog.
      // While the listing loads, or if it fails, the catalog alone is offered.
      if(route.kind==='gateway'&&route.baseUrl){
        const live=listing(route,env,fetcher);
        if(live.status==='ok'){
          for(const entry of routerAgents(live.value!))if(!models.some(model=>model.id===entry.id))models.push(entry);
          // Everything else the router serves is loaded too, off in the picker until switched on in Settings › Models.
          const known=new Set(models.map(model=>model.id));
          for(const entry of live.value!)if(entry.chat!==false&&entry.owner!=='combo'&&!known.has(entry.id)){known.add(entry.id);models.push({id:entry.id,name:entry.name,hiddenByDefault:true,...(entry.owner?{group:entry.owner}:{})});}
        }
      }
    }
    else if(route.baseUrl){
      const listed=listing(route,env,fetcher);
      if(listed.status==='pending')return {info:{...base,status:'configured',detail:`Listing models from ${route.baseUrl}… Scan again in a moment. ${mcpDetail(mcp)}`},command,env:childEnv,sessionsRoot};
      if(listed.status==='error')return fail(`${listed.reason} Add model_catalog_json to the profile to list models without asking the endpoint.`,'error');
      const runnable=listed.value!.filter(entry=>entry.chat!==false);
      models=runnable.slice(0,MAX_CATALOG_ENTRIES).map(({id,name})=>({id,name}));catalogSource=`${route.baseUrl}/models`;
      if(listed.value!.length>runnable.length)excluded.push({id:'non-chat-models',name:`${listed.value!.length-runnable.length} image, audio and other models`,reason:'These models cannot run a chat.'});
      if(runnable.length>MAX_CATALOG_ENTRIES)excluded.push({id:'listing-overflow',name:`${runnable.length-MAX_CATALOG_ENTRIES} more models`,reason:`Only the first ${MAX_CATALOG_ENTRIES} listed models are offered; add model_catalog_json to choose.`});
    } else return fail(`[model_providers.${route.modelProvider}] has no base_url and no model catalog.`);
    if(!models.length)return fail('The provider reported no models Muster can run.','error');
    // Direct account identity is stable across token refresh. Never expose the
    // account ID or token; the opaque binding detects configuration/account change.
    let accountId='gateway-account-not-reported';
    if(route.kind==='chatgpt'){
      const tokenAccount=auth?.tokens?.account_id,apiKey=typeof auth?.OPENAI_API_KEY==='string'&&auth.OPENAI_API_KEY?createHash('sha256').update(auth.OPENAI_API_KEY).digest('hex'):undefined;
      if(route.profile==='openai-direct'&&(typeof tokenAccount!=='string'||!tokenAccount||typeof auth?.tokens?.access_token!=='string'||!auth.tokens.access_token))return fail('A locally identifiable ChatGPT sign-in is required. Run `codex login`.');
      accountId=typeof tokenAccount==='string'&&tokenAccount?tokenAccount:apiKey??'codex-sign-in';
    }
    const bindingId=createHash('sha256').update(JSON.stringify([route.modelProvider,route.profile??'',codexHome,cli,route.fingerprint,accountId])).digest('hex');
    return {info:{...base,models,...(excluded.length?{excludedModels:excluded}:{}),...(incremental?{incrementalInput:true}:{}),available:true,status:'ready',bindingId,detail:`Runs through the Codex CLI with ${catalogSource}. ${mcpDetail(mcp)} Upstream access is checked only when you run.`},command,env:childEnv,sessionsRoot};
  });
}

/** The Codex route behind a provider id, from the current instance list; undefined for non-Codex routes. */
export function codexRouteFor(id:string,options:ProviderInstanceOptions={}):{codex:NonNullable<ProviderInfo['codex']>;codexHome:string;sessionsRoot:string;instance:ProviderInstance}|undefined {
  const instance=configuredProviderInstances(options).find(row=>row.info.id===id&&row.info.codex);
  return instance?{codex:instance.info.codex!,codexHome:instance.env.CODEX_HOME!,sessionsRoot:instance.sessionsRoot,instance}:undefined;
}
