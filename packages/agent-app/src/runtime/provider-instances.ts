import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {constants,openSync,fstatSync,readSync,closeSync,existsSync,accessSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import type {ProviderInfo} from '../shared/protocol.ts';

export interface ProviderInstance {
  info: ProviderInfo;
  command: string;
  env: Record<string,string>;
  sessionsRoot: string;
}
const MAX_BYTES=1024*1024;
function boundedFile(file:string):string {
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const stat=fstatSync(fd);if(!stat.isFile()||stat.size>MAX_BYTES)throw new Error('Unsupported configuration file.');
    const bytes=Buffer.alloc(MAX_BYTES+1);let length=0;
    while(length<bytes.length){const count=readSync(fd,bytes,length,bytes.length-length,null);if(!count)break;length+=count;}
    if(length>MAX_BYTES)throw new Error('Configuration is too large.');
    return bytes.subarray(0,length).toString('utf8');
  } finally {closeSync(fd);}
}
const GATEWAY_MODELS=new Set(['claude/claude-fable-5','codex/gpt-5.6-terra','codex/gpt-5.6-luna','codex/gpt-5.6-sol','codex/gpt-6-astra']);
const directModel=(id:string)=>/^(?:gpt-[a-zA-Z0-9.-]+|o[1-9][a-zA-Z0-9.-]*)$/.test(id);
/** Existing validated launchers and explicit local catalogs only. This does not
 * authenticate, start a process, probe a model or verify upstream entitlement. */
export function configuredProviderInstances(options:{directory?:string;home?:string;env?:NodeJS.ProcessEnv}={}):ProviderInstance[] {
  const directory=options.directory??__dirname,home=options.home??homedir(),env=options.env??process.env;
  const codexHome=env.CODEX_HOME||join(home,'.codex');
  const node=env.MUSTER_PROVIDER_NODE||['/opt/homebrew/bin/node','/usr/local/bin/node'].find(existsSync)||'node';
  return ([['hybrow','hybrow-gateway','Hybrow OmniRoute'],['openai-direct','openai-direct','OpenAI Direct']] as const).map<ProviderInstance>(([id,profile,name])=>{
    const command=join(directory,'resources',`codex-${profile}.sh`);
    const childEnv={MUSTER_PROVIDER_NODE:node,CODEX_HOME:codexHome,...(env.MUSTER_CODEX_COMMAND?{MUSTER_CODEX_COMMAND:env.MUSTER_CODEX_COMMAND}:{})};
    const base={id,name,driver:'codex-app-server',identityMasked:id==='hybrow'?'Gateway profile · account hidden':'ChatGPT account · hidden',models:[],available:false} satisfies ProviderInfo;
    try {
      accessSync(command,constants.X_OK);
      const cli=env.MUSTER_CODEX_COMMAND||join(home,'.local/bin/codex');accessSync(cli,constants.X_OK);
      const profileText=boundedFile(join(codexHome,`${profile}.config.toml`));
      const validator=createRequire(join(directory,'provider-instances.cjs'))(join(directory,'resources','codex-profile.cjs')) as {profileOverrides(profile:string,text:string):string[]};
      const overrides=validator.profileOverrides(profile,profileText);
      const catalogField=overrides.find(value=>value.startsWith('model_catalog_json='));
      const catalogPath=JSON.parse(catalogField?.slice('model_catalog_json='.length)??'null') as unknown;
      if(typeof catalogPath!=='string'||!isAbsolute(catalogPath))throw new Error('A configured absolute model catalog is required.');
      const catalog=JSON.parse(boundedFile(catalogPath)) as {models?:unknown};
      if(!Array.isArray(catalog.models))throw new Error('A model catalog is required.');
      const models:ProviderInfo['models']=[];
      for(const entry of catalog.models.slice(0,500)){
        if(!entry||typeof entry!=='object'||entry.hidden===true)continue;
        const model=entry.slug??entry.model??entry.id;
        if(typeof model!=='string'||model.length>200||!(id==='hybrow'?GATEWAY_MODELS.has(model):directModel(model))||models.some(m=>m.id===model))continue;
        const label=entry.display_name??entry.displayName??entry.name??model;
        models.push({id:model,name:typeof label==='string'?label.replace(/[\x00-\x1f]/g,'').slice(0,160):model});
      }
      if(!models.length)throw new Error('No supported models in configured catalog.');
      // Direct account identity is stable across token refresh. Never expose the
      // account ID or token; opaque binding detects configuration/account change.
      let account='gateway-account-not-reported';
      if(id==='openai-direct'){
        const auth=JSON.parse(boundedFile(join(codexHome,'auth.json'))) as {tokens?:{account_id?:unknown;access_token?:unknown}};
        if(typeof auth.tokens?.account_id!=='string'||!auth.tokens.account_id||typeof auth.tokens.access_token!=='string'||!auth.tokens.access_token)throw new Error('A locally identifiable ChatGPT sign-in is required.');
        account=auth.tokens.account_id;
      }
      const bindingId=createHash('sha256').update(JSON.stringify([id,codexHome,cli,profileText,account])).digest('hex');
      return {info:{...base,models,available:true,status:'ready',bindingId,detail:'Executable profile and local model catalog configured. Upstream access is checked only when you run.'},command,env:childEnv,sessionsRoot:join(codexHome,'sessions')};
    } catch {
      return {info:{...base,status:'configured',error:'The executable, validated profile, local model catalog or identifiable account is unavailable. No provider fallback will be used.'},command,env:childEnv,sessionsRoot:join(codexHome,'sessions')};
    }
  });
}
