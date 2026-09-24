import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {computerUseTarget, maskComputerArguments, parseArguments} from '../shared/computer-use.ts';

/** A tool-result image: saved once under the image store and referenced by id; inline only without a store. */
export interface ToolImage {id?:string; mime:string; bytes:number; width?:number; height?:number; dataUrl?:string}
const IMAGE_MIME=/^image\/(png|jpeg|webp|gif)$/;
const EXT:Record<string,string>={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'};
export const MAX_TOOL_IMAGES=6, MAX_TOOL_IMAGE_BYTES=24*1024*1024, MAX_INLINE_IMAGE_BYTES=4*1024*1024;
let imageDir:string|undefined;
/** The computer domain points this at <dataDir>/tool-images when the runtime starts. */
export function setToolImageStore(dir:string|undefined):void { imageDir=dir; }
export function toolImageStore():string|undefined { return imageDir; }
export const TOOL_IMAGE_ID=/^[a-f0-9]{32}\.(png|jpg|webp|gif)$/;
export const TOOL_IMAGE_MIME:Record<string,string>={png:'image/png',jpg:'image/jpeg',webp:'image/webp',gif:'image/gif'};

/** Pixel size from the PNG IHDR, GIF screen descriptor or a JPEG SOF marker; undefined when unknown. */
export function imageSize(buffer:Buffer):{width:number;height:number}|undefined {
  if(buffer.length>=24&&buffer.readUInt32BE(0)===0x89504e47)return {width:buffer.readUInt32BE(16),height:buffer.readUInt32BE(20)};
  if(buffer.length>=10&&buffer.toString('ascii',0,3)==='GIF')return {width:buffer.readUInt16LE(6),height:buffer.readUInt16LE(8)};
  if(buffer.length>=4&&buffer[0]===0xff&&buffer[1]===0xd8){
    let offset=2;
    while(offset+9<buffer.length){
      if(buffer[offset]!==0xff){offset++;continue;}
      const marker=buffer[offset+1],length=buffer.readUInt16BE(offset+2);
      if(marker>=0xc0&&marker<=0xcf&&marker!==0xc4&&marker!==0xc8&&marker!==0xcc)return {height:buffer.readUInt16BE(offset+5),width:buffer.readUInt16BE(offset+7)};
      offset+=2+length;
    }
  }
  return undefined;
}
function decode(mime:string,base64:string,budget:{bytes:number}):ToolImage|undefined {
  if(!IMAGE_MIME.test(mime)||!/^[A-Za-z0-9+/=\s]+$/.test(base64.slice(0,256)))return undefined;
  const buffer=Buffer.from(base64,'base64');
  if(!buffer.length||budget.bytes+buffer.length>MAX_TOOL_IMAGE_BYTES)return undefined;
  budget.bytes+=buffer.length;
  const size=imageSize(buffer),image:ToolImage={mime,bytes:buffer.length,...(size?size:{})};
  if(imageDir){
    // Content-addressed: re-reading a thread (subagent hydration, completed events) never duplicates a file.
    const id=`${createHash('sha256').update(buffer).digest('hex').slice(0,32)}.${EXT[mime]}`,file=path.join(imageDir,id);
    try{ if(!fs.existsSync(file)){fs.mkdirSync(imageDir,{recursive:true,mode:0o700});fs.writeFileSync(file,buffer,{mode:0o600});} return {...image,id}; }catch{/* Fall back to inline below. */}
  }
  return buffer.length<=MAX_INLINE_IMAGE_BYTES?{...image,dataUrl:`data:${mime};base64,${buffer.toString('base64')}`}:undefined;
}
/** Pulls MCP `{type:'image',data,mimeType}` and Codex `{type:'inputImage',imageUrl:'data:…'}` parts out of a
 * tool result, returning the images and a copy whose image parts are replaced by a short placeholder. */
export function extractToolImages(value:unknown,images:ToolImage[]=[],budget={bytes:0},depth=0):unknown {
  if(depth>8||value==null||typeof value!=='object')return value;
  if(Array.isArray(value))return value.slice(0,512).map(entry=>extractToolImages(entry,images,budget,depth+1));
  const row=value as Record<string,unknown>;
  const dataUrl=typeof row.imageUrl==='string'?row.imageUrl:typeof row.image_url==='string'?row.image_url:undefined;
  const inline=dataUrl?/^data:(image\/[a-z]+);base64,(.*)$/s.exec(dataUrl):null;
  if((row.type==='image'&&typeof row.data==='string')||inline){
    const mime=inline?inline[1]:typeof row.mimeType==='string'?row.mimeType:typeof row.mime_type==='string'?row.mime_type:'image/png';
    const image=images.length<MAX_TOOL_IMAGES?decode(mime,inline?inline[2]:String(row.data),budget):undefined;
    if(image)images.push(image);
    return {type:'image',mimeType:mime,...(image?{shown:images.length}:{omitted:true})};
  }
  return Object.fromEntries(Object.entries(row).slice(0,256).map(([key,entry])=>[key,extractToolImages(entry,images,budget,depth+1)]));
}

/** Bounded, explicit provider metadata. Shell text is never parsed into actions. Screenshots become images, not text. */
export function toolEventDetails(item: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ['outputSource','type','command','cwd','title','name','path','query','server','tool','namespace','prompt','model','senderThreadId']) {
    if (typeof item[key] === 'string') result[key] = item[key].slice(0, 32768);
  }
  for (const key of ['durationMs','exitCode']) if (typeof item[key] === 'number' && Number.isFinite(item[key]) && (key === 'exitCode' || item[key] >= 0)) result[key] = item[key];
  for (const key of ['agentNickname', 'agentRole']) {
    if (typeof item[key] === 'string') result[key] = item[key].slice(0, 256);
  }
  if (Array.isArray(item.commandActions)) result.commandActions = item.commandActions.slice(0,256).filter(isObject).map(action=>pick(action,['outputSource','type','command','path','name','query']));
  if (Array.isArray(item.changes)) result.changes = fileChanges(item.changes);
  // TRN-X4: todo lists keep their steps so the transcript can show a checklist. A native plan item
  // (or ExitPlanMode's own `plan` argument) is markdown text, not steps — kept verbatim so the
  // Plan card has something to show instead of silently dropping a non-array `plan`.
  if (Array.isArray(item.items)) result.items = (item.items as unknown[]).slice(0,100).filter(isObject).map(step=>({...pick(step,['text','step','content','title','status']),...(typeof step.completed==='boolean'?{completed:step.completed}:{})}));
  if (Array.isArray(item.plan)) result.plan = (item.plan as unknown[]).slice(0,100).filter(isObject).map(step=>({...pick(step,['text','step','content','title','status']),...(typeof step.completed==='boolean'?{completed:step.completed}:{})}));
  else if (typeof item.plan === 'string') result.plan = item.plan.slice(0, 32768);
  if (Array.isArray(item.receiverThreadIds)) result.receiverThreadIds = item.receiverThreadIds.filter((v):v is string=>typeof v==='string').slice(0,256).map(v=>v.slice(0,256));
  const computer = computerUseTarget(item);
  if (computer) result.computer = computer;
  const images: ToolImage[] = [], budget = {bytes: 0};
  for (const key of ['arguments','result','error','agentsStates','receiverAgents','contentItems','appContext']) {
    if (item[key] != null) {
      // CUA-06: image parts are decoded and kept at full resolution; the JSON keeps only a placeholder.
      let value = key === 'result' || key === 'contentItems' || key === 'error' ? extractToolImages(item[key], images, budget) : item[key];
      // CUA-04: typed secrets never reach the transcript.
      if (key === 'arguments' && computer) { const args = parseArguments(value); if (Object.keys(args).length) value = maskComputerArguments(args); }
      try { const json = JSON.stringify(value); result[key] = json.length <= 32768 ? json : json.slice(0,32768)+'\n[Details truncated]'; } catch {}
    }
  }
  if (images.length) result.images = images;
  return result;
}
/** Per-change and per-item patch budgets: whole-file adds are routine, so 32 KB was far too small. */
export const MAX_CHANGE_DIFF = 512 * 1024, MAX_CHANGES_DIFF = 2 * 1024 * 1024;
/**
 * File changes keep their full patch up to a budget and say when it was cut. Codex reports `kind` as
 * `{type:'add'|'delete'|'update', move_path}`: the type is kept as a string (an add's `diff` is the whole
 * new file, so the renderer must know) and a rename keeps its destination.
 */
export function fileChanges(changes: unknown[]): Record<string, unknown>[] {
  let budget = MAX_CHANGES_DIFF;
  return changes.slice(0,256).filter(isObject).map(change => {
    const out: Record<string, unknown> = pick(change, ['path','kind']);
    const kind = isObject(change.kind) ? change.kind : undefined;
    if (kind && typeof kind.type === 'string') out.kind = kind.type.slice(0, 32);
    const move = [change.move_path, change.movePath, kind?.move_path, kind?.movePath].find((value): value is string => typeof value === 'string' && !!value);
    if (move) out.movePath = move.slice(0, 4096);
    if (typeof change.diff === 'string') {
      const limit = Math.max(0, Math.min(MAX_CHANGE_DIFF, budget));
      // Cut on a line boundary so the renderer never shows half a line as a change.
      const cut = change.diff.length > limit ? change.diff.slice(0, Math.max(0, change.diff.lastIndexOf('\n', limit))) : change.diff;
      out.diff = cut; budget -= cut.length;
      if (cut.length < change.diff.length) out.diffTruncated = true;
    }
    return out;
  });
}
function isObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value==='object' && !Array.isArray(value); }
function pick(value:Record<string,unknown>,keys:string[]):Record<string,unknown> {
  return Object.fromEntries(keys.flatMap(key=>typeof value[key]==='string'?[[key,value[key].slice(0,32768)]]:[]));
}
