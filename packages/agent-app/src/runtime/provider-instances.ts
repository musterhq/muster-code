import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import * as nodeFs from 'node:fs';
import {homedir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import type {ProviderInfo} from '../shared/protocol.ts';
import {catalogPricing,type ExcludedModel} from '../shared/model-catalog.ts';
import type {RunnableAdapter} from './adapters/types.ts';

export interface ProviderInstance {
  info: ProviderInfo;
  command: string;
  env: Record<string,string>;
  sessionsRoot: string;
  /** Set for non-Codex routes (Claude Code, OpenCode, HTTP APIs); run() delegates to it instead of the app-server. */
  adapter?: RunnableAdapter;
}
/** The subset of node:fs this module touches; tests inject a counting wrapper. */
export type ProviderInstanceFs=Pick<typeof nodeFs,'openSync'|'fstatSync'|'readSync'|'closeSync'|'existsSync'|'accessSync'|'statSync'>;
export interface ProviderInstanceOptions {accountsFile?:string;directory?:string;home?:string;env?:NodeJS.ProcessEnv;fs?:Partial<ProviderInstanceFs>;now?:()=>number}
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
export function catalogModels(family:'hybrow'|'openai-direct',list:readonly unknown[]):{models:ProviderInfo['models'];excluded:ExcludedModel[]} {
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

/** Existing validated launchers and explicit local catalogs only. This does not
 * authenticate, start a process, probe a model or verify upstream entitlement.
 * The default CODEX_HOME keeps the ids `hybrow`/`openai-direct`; each extra account
 * adds `hybrow_<hash>` (when it has a gateway profile) and `openai-direct_<hash>`. */
export function configuredProviderInstances(options:ProviderInstanceOptions={}):ProviderInstance[] {
  const directory=options.directory??__dirname,home=options.home??homedir(),env=options.env??process.env;
  const fs:ProviderInstanceFs=options.fs?{...nodeFs,...options.fs}:nodeFs;
  const at=(options.now??Date.now)();
  const codexHome=env.CODEX_HOME||join(home,'.codex');
  const cli=env.MUSTER_CODEX_COMMAND||join(home,'.local/bin/codex');
  const accountsFile=options.accountsFile??(registeredDataDir?providerAccountsFile(registeredDataDir):undefined);
  const key=JSON.stringify([directory,codexHome,cli,env.MUSTER_PROVIDER_NODE??'',accountsFile??'']);
  const memo=memos.get(key);
  if(memo&&fresh(fs,memo,at))return memo.value;
  const files=new Map<string,Stamp>();
  const track=(file:string)=>{if(!files.has(file))files.set(file,stamp(fs,file));return file;};
  const node=env.MUSTER_PROVIDER_NODE||['/opt/homebrew/bin/node','/usr/local/bin/node'].find(candidate=>fs.existsSync(candidate))||'node';
  track(cli);
  const extra=accountsFile?readAccounts(fs,track(accountsFile)).filter(account=>account.codexHome!==codexHome):[];
  const value=[...homeInstances({fs,directory,codexHome,cli,node,env,track}),...extra.flatMap(account=>homeInstances({fs,directory,codexHome:account.codexHome,cli,node,env,track,account}))];
  if(!memo&&memos.size>=MAX_MEMOS)memos.delete(memos.keys().next().value!);
  memos.set(key,{checkedAt:at,files,value});
  return value;
}
function homeInstances({fs,directory,codexHome,cli,node,env,track,account}:{fs:ProviderInstanceFs;directory:string;codexHome:string;cli:string;node:string;env:NodeJS.ProcessEnv;track(file:string):string;account?:ProviderAccount}):ProviderInstance[] {
  let mcp:string[]=[];
  try {mcp=mcpServerNames(boundedFile(fs,track(join(codexHome,'config.toml'))));} catch {mcp=[];}
  const suffix=account?`_${accountHash(account.codexHome)}`:'';
  let email:string|undefined;
  if(account)try {email=maskedEmail((JSON.parse(boundedFile(fs,track(join(codexHome,'auth.json')))) as {tokens?:{id_token?:unknown}}).tokens?.id_token);} catch {email=undefined;}
  const profiles=([['hybrow','hybrow-gateway','Hybrow OmniRoute'],['openai-direct','openai-direct','OpenAI Direct']] as const)
    .filter(([,profile])=>!account||profile==='openai-direct'||(()=>{try {return fs.statSync(track(join(codexHome,`${profile}.config.toml`)),{throwIfNoEntry:false})?.isFile()===true;} catch {return false;}})());
  return profiles.map<ProviderInstance>(([family,profile,label])=>{
    const id=`${family}${suffix}`,name=account?`${label} · ${account.label??email??`account ${suffix.slice(1,7)}`}`:label;
    const command=track(join(directory,'resources',`codex-${profile}.sh`));
    const profilePath=track(join(codexHome,`${profile}.config.toml`));
    const childEnv={MUSTER_PROVIDER_NODE:node,CODEX_HOME:codexHome,...(env.MUSTER_CODEX_COMMAND?{MUSTER_CODEX_COMMAND:env.MUSTER_CODEX_COMMAND}:{})};
    const base={id,name,driver:'codex-app-server',identityMasked:family==='hybrow'?'Gateway profile · account hidden':email??'ChatGPT account · hidden',models:[],available:false,...(account?{source:`Codex account at ${account.codexHome}`}:{})} satisfies ProviderInfo;
    try {
      fs.accessSync(command,constants.X_OK);
      fs.accessSync(cli,constants.X_OK);
      const profileText=boundedFile(fs,profilePath);
      const validator=createRequire(join(directory,'provider-instances.cjs'))(join(directory,'resources','codex-profile.cjs')) as {profileOverrides(profile:string,text:string):string[]};
      const overrides=validator.profileOverrides(profile,profileText);
      const catalogField=overrides.find(value=>value.startsWith('model_catalog_json='));
      const catalogPath=JSON.parse(catalogField?.slice('model_catalog_json='.length)??'null') as unknown;
      if(typeof catalogPath!=='string'||!isAbsolute(catalogPath))throw new Error('A configured absolute model catalog is required.');
      const catalog=JSON.parse(boundedFile(fs,track(catalogPath))) as {models?:unknown};
      if(!Array.isArray(catalog.models))throw new Error('A model catalog is required.');
      const {models,excluded}=catalogModels(family,catalog.models);
      if(!models.length)throw new Error('No supported models in configured catalog.');
      // Direct account identity is stable across token refresh. Never expose the
      // account ID or token; opaque binding detects configuration/account change.
      let accountId='gateway-account-not-reported';
      if(family==='openai-direct'){
        const auth=JSON.parse(boundedFile(fs,track(join(codexHome,'auth.json')))) as {tokens?:{account_id?:unknown;access_token?:unknown}};
        if(typeof auth.tokens?.account_id!=='string'||!auth.tokens.account_id||typeof auth.tokens.access_token!=='string'||!auth.tokens.access_token)throw new Error('A locally identifiable ChatGPT sign-in is required.');
        accountId=auth.tokens.account_id;
      }
      const bindingId=createHash('sha256').update(JSON.stringify([family,codexHome,cli,profileText,accountId])).digest('hex');
      return {info:{...base,models,...(excluded.length?{excludedModels:excluded}:{}),available:true,status:'ready',bindingId,detail:`Executable profile and local model catalog configured. ${mcpDetail(mcp)} Upstream access is checked only when you run.`},command,env:childEnv,sessionsRoot:join(codexHome,'sessions')};
    } catch {
      const error=account?`This account needs an executable ${profile}.config.toml with a local model catalog${family==='openai-direct'?' and a ChatGPT sign-in (auth.json)':''} in ${codexHome}. No provider fallback will be used.`:'The executable, validated profile, local model catalog or identifiable account is unavailable. No provider fallback will be used.';
      return {info:{...base,status:'configured',error,detail:`${error} ${mcpDetail(mcp)}`},command,env:childEnv,sessionsRoot:join(codexHome,'sessions')};
    }
  });
}
