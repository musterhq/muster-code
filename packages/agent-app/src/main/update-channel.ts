/** PER-09: update-channel plumbing without secrets or implicit network calls.
 *
 * A build carries its channel (Info.plist `MusterUpdateChannel`, written by
 * scripts/package-preview.mjs) and the user may pin a different one. Update
 * checks are off unless a feed base URL is configured (MUSTER_UPDATE_BASE_URL
 * at package time or run time); nothing here holds credentials, and a manifest
 * is accepted only over HTTPS with a SHA-256 for the download, so the installer
 * step can verify what it fetched. Signing and notarization happen at package
 * time (see docs/RELEASE.md), not in the app. */
export type UpdateChannel='stable'|'beta'|'preview';
export const UPDATE_CHANNELS:readonly UpdateChannel[]=['stable','beta','preview'];
export interface UpdateManifest {channel:UpdateChannel; version:string; url:string; sha256:string; notes?:string; publishedAt?:string; minimumSystemVersion?:string}
export interface UpdateCheck {channel:UpdateChannel; current:string; latest?:UpdateManifest; available:boolean; disabledReason?:string}

const isChannel=(value:unknown):value is UpdateChannel=>typeof value==='string'&&(UPDATE_CHANNELS as readonly string[]).includes(value);
/** User choice wins, then the build's channel, then the environment, then 'preview'. */
export function resolveUpdateChannel(input:{userChoice?:unknown;bundle?:unknown;env?:NodeJS.ProcessEnv}):UpdateChannel {
  for(const candidate of [input.userChoice,input.bundle,input.env?.MUSTER_UPDATE_CHANNEL])if(isChannel(candidate))return candidate;
  return 'preview';
}

/** Semantic-version order with prerelease tags (1.2.0-beta.2 < 1.2.0). */
export function compareVersions(a:string,b:string):number {
  const parse=(value:string)=>{const match=/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim());if(!match)throw new Error(`Invalid version "${value}".`);return {core:[+match[1]!,+match[2]!,+match[3]!],pre:match[4]?.split('.')??[]};};
  const x=parse(a),y=parse(b);
  for(let i=0;i<3;i++)if(x.core[i]!==y.core[i])return x.core[i]!-y.core[i]!;
  if(!x.pre.length||!y.pre.length)return y.pre.length-x.pre.length;
  for(let i=0;i<Math.max(x.pre.length,y.pre.length);i++){
    const p=x.pre[i],q=y.pre[i];if(p===undefined)return -1;if(q===undefined)return 1;
    const np=/^\d+$/.test(p),nq=/^\d+$/.test(q);
    if(np&&nq&&+p!==+q)return +p-+q;if(np!==nq)return np?-1:1;if(p!==q)return p<q?-1:1;
  }
  return 0;
}

/** https://<base>/<channel>/<platform>-<arch>/latest.json — a static file any CDN or release bucket can serve. */
export function updateFeedURL(base:string,channel:UpdateChannel,platform:string=process.platform,arch:string=process.arch):string {
  const url=new URL(base);
  if(url.protocol!=='https:')throw new Error('The update feed must use HTTPS.');
  if(url.username||url.password)throw new Error('The update feed URL must not carry credentials.');
  url.pathname=`${url.pathname.replace(/\/+$/,'')}/${channel}/${platform}-${arch}/latest.json`;
  return url.toString();
}

export function parseUpdateManifest(value:unknown,channel:UpdateChannel):UpdateManifest {
  const raw=value as Partial<UpdateManifest>|null;
  if(!raw||typeof raw!=='object')throw new Error('The update manifest is not an object.');
  if(raw.channel!==channel)throw new Error(`The update manifest is for "${String(raw.channel)}", not "${channel}".`);
  if(typeof raw.version!=='string')throw new Error('The update manifest has no version.');
  compareVersions(raw.version,'0.0.0');
  let url:URL;try{url=new URL(String(raw.url));}catch{throw new Error('The update manifest has no download URL.');}
  if(url.protocol!=='https:'||url.username||url.password)throw new Error('Update downloads must use HTTPS without credentials.');
  if(typeof raw.sha256!=='string'||!/^[a-f0-9]{64}$/i.test(raw.sha256))throw new Error('The update manifest needs a SHA-256 for the download.');
  return {channel,version:raw.version,url:url.toString(),sha256:raw.sha256.toLowerCase(),
    ...(typeof raw.notes==='string'?{notes:raw.notes.slice(0,8192)}:{}),...(typeof raw.publishedAt==='string'?{publishedAt:raw.publishedAt.slice(0,64)}:{}),
    ...(typeof raw.minimumSystemVersion==='string'?{minimumSystemVersion:raw.minimumSystemVersion.slice(0,32)}:{})};
}

/** One check. `fetchJson` is injected (main passes net.fetch); without a feed base URL nothing is requested. */
export async function checkForUpdate(input:{current:string;channel:UpdateChannel;base?:string;fetchJson:(url:string)=>Promise<unknown>}):Promise<UpdateCheck> {
  if(!input.base)return {channel:input.channel,current:input.current,available:false,disabledReason:'No update feed is configured for this build.'};
  const latest=parseUpdateManifest(await input.fetchJson(updateFeedURL(input.base,input.channel)),input.channel);
  return {channel:input.channel,current:input.current,latest,available:compareVersions(latest.version,input.current)>0};
}
