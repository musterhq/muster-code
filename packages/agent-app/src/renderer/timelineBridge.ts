import {BridgeError,getBridge} from './bridge';

/** Local wrapper for 'attachments.preview' so the transcript never depends on protocol additions.
 * Cache is bounded by count and by retained data-URL size (previews may be up to 4 MB each). */
const previews=new Map<string,Promise<string>>(),sizes=new Map<string,number>();
const MAX_PREVIEWS=60,MAX_PREVIEW_CHARS=24_000_000;
let retained=0;
const drop=(key:string)=>{previews.delete(key);retained-=sizes.get(key)??0;sizes.delete(key);};
export function attachmentPreview(chatId:string,id:string):Promise<string> {
  const key=chatId+'\0'+id,cached=previews.get(key);
  if(cached)return cached;
  const bridge=getBridge();
  const request=(async()=>{
    if(!bridge)throw new BridgeError('attachments.preview','Agent runtime is not connected');
    const result=await (bridge.invoke as unknown as (command:string,input:unknown)=>Promise<unknown>)('attachments.preview',{chatId,id});
    const dataUrl=(result as {dataUrl?:unknown}|null)?.dataUrl;
    if(typeof dataUrl!=='string'||!dataUrl.startsWith('data:image/'))throw new BridgeError('attachments.preview','No image preview');
    return dataUrl;
  })();
  previews.set(key,request);
  request.then(url=>{if(previews.get(key)!==request)return;sizes.set(key,url.length);retained+=url.length;
    for(const old of previews.keys()){if(retained<=MAX_PREVIEW_CHARS||old===key)break;drop(old);}},()=>{if(previews.get(key)===request)drop(key);});
  while(previews.size>MAX_PREVIEWS)drop(previews.keys().next().value!);
  return request;
}
