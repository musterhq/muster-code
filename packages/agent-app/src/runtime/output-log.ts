import {createHash} from 'node:crypto';
import {constants,promises as fs} from 'node:fs';
import {join} from 'node:path';

/** PER-05: durable, paged command/tool output beyond the in-memory tail.
 *
 * The live views keep a bounded tail (MAX_COMMAND_OUTPUT) so memory and IPC
 * stay flat. Every byte also goes to an append-only file per output stream, so
 * "Load earlier output" can page backwards through the whole log after the tail
 * dropped it, and after a restart. Files live under one directory per chat
 * (hashed ids; nothing user-controlled reaches the path) and share a disk budget:
 * each log stops growing at `maxLogBytes` (with a visible marker) and the oldest
 * logs are removed once the directory exceeds `maxTotalBytes`. */
export const OUTPUT_LOG_MAX_BYTES=32*1024*1024;
export const OUTPUT_LOG_TOTAL_BYTES=256*1024*1024;
export const OUTPUT_PAGE_BYTES=64*1024;
export const OUTPUT_PAGE_MAX_BYTES=1024*1024;
const FLUSH_MS=50, FLUSH_BYTES=256*1024;
export const OUTPUT_LOG_CAPPED_MARKER='\n[Muster: output log limit reached; later output is only in the live tail]\n';

export interface OutputPage {
  /** Byte offsets of `text` within the durable log: pass `start` as the next `before` to page backwards. */
  start:number; end:number; size:number; text:string;
  /** True when the log stopped growing at its per-stream budget. */
  capped:boolean;
}
export interface OutputLogOptions {maxLogBytes?:number; maxTotalBytes?:number}
interface Pending {file:string; dir:string; chunks:string[]; bytes:number}

const digest=(value:string,length:number)=>createHash('sha256').update(value).digest('hex').slice(0,length);
const validKey=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9:_-]{1,200}$/.test(value);

/** First index at or after `at` that begins a UTF-8 character. */
function charStart(buffer:Buffer,at:number):number {
  while(at<buffer.length&&(buffer[at]!&0xc0)===0x80)at++;
  return at;
}

export class OutputLog {
  private pending=new Map<string,Pending>();
  private sizes=new Map<string,number>();
  private capped=new Set<string>();
  private timer?:ReturnType<typeof setTimeout>;
  private writing:Promise<void>=Promise.resolve();
  private appendsSincePrune=0;
  private maxLogBytes:number; private maxTotalBytes:number;
  constructor(readonly root:string,options:OutputLogOptions={}) {
    this.maxLogBytes=Math.max(1024,options.maxLogBytes??OUTPUT_LOG_MAX_BYTES);
    this.maxTotalBytes=Math.max(this.maxLogBytes,options.maxTotalBytes??OUTPUT_LOG_TOTAL_BYTES);
  }
  private location(chatId:string,key:string):{dir:string;file:string} {
    if(!validKey(chatId)||!validKey(key))throw new Error('Invalid output log identity.');
    const dir=join(this.root,digest(chatId,24));
    return {dir,file:join(dir,`${digest(key,32)}.log`)};
  }
  /** Queue output for the durable log. Never throws for disk problems; the live tail is unaffected. */
  append(chatId:string,key:string,text:string):void {
    if(!text)return;
    let location;try{location=this.location(chatId,key);}catch{return;}
    const pending=this.pending.get(location.file)??{...location,chunks:[],bytes:0};
    pending.chunks.push(text);pending.bytes+=text.length;this.pending.set(location.file,pending);
    if(pending.bytes>=FLUSH_BYTES)void this.flush();
    else if(!this.timer){this.timer=setTimeout(()=>{this.timer=undefined;void this.flush();},FLUSH_MS);this.timer.unref?.();}
  }
  /** Write everything queued so far. Resolves after the bytes are on disk (or dropped on a disk error). */
  flush():Promise<void> {
    clearTimeout(this.timer);this.timer=undefined;
    const batch=[...this.pending.values()];this.pending.clear();
    this.writing=this.writing.then(async()=>{
      for(const item of batch){
        try{
          if(this.capped.has(item.file))continue;
          let size=this.sizes.get(item.file);
          if(size===undefined){try{size=(await fs.stat(item.file)).size;}catch{size=0;}}
          let data=Buffer.from(item.chunks.join(''),'utf8');
          const room=this.maxLogBytes-size;
          if(data.length>room){
            const marker=Buffer.from(OUTPUT_LOG_CAPPED_MARKER,'utf8');
            let cut=Math.max(0,room-marker.length);
            while(cut>0&&(data[cut]!&0xc0)===0x80)cut--;
            data=Buffer.concat([data.subarray(0,cut),marker]);this.capped.add(item.file);
          }
          await fs.mkdir(item.dir,{recursive:true,mode:0o700});
          await fs.appendFile(item.file,data,{mode:0o600});
          this.sizes.set(item.file,size+data.length);
          this.appendsSincePrune+=data.length;
        }catch{/* A full or read-only disk only loses the durable copy, never the live tail. */}
      }
      if(this.appendsSincePrune>=this.maxLogBytes/4){this.appendsSincePrune=0;await this.prune().catch(()=>{});}
    });
    return this.writing;
  }
  /** One page of the durable log ending at `before` (default: the end). */
  async page(chatId:string,key:string,options:{before?:number;bytes?:number}={}):Promise<OutputPage> {
    const {file}=this.location(chatId,key);
    await this.flush();
    const want=Math.max(1,Math.min(OUTPUT_PAGE_MAX_BYTES,Math.floor(options.bytes??OUTPUT_PAGE_BYTES)));
    let handle;
    try{handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {start:0,end:0,size:0,text:'',capped:false};throw error;}
    try{
      const size=(await handle.stat()).size;
      let end=Math.max(0,Math.min(size,options.before===undefined?size:Math.floor(Number(options.before))||0));
      const from=Math.max(0,end-want);
      // Read up to 3 bytes past `end` so a cursor inside a character moves back to its start.
      const raw=Buffer.alloc(Math.min(size,end+3)-from);
      if(raw.length)await handle.read(raw,0,raw.length,from);
      let cut=end-from;while(cut>0&&cut<raw.length&&(raw[cut]!&0xc0)===0x80)cut--;
      end=from+cut;const buffer=raw.subarray(0,cut);
      // Never begin inside a UTF-8 sequence; prefer a line start when one is near.
      let skip=from>0?charStart(buffer,0):0;
      if(from>0){const line=buffer.indexOf(0x0a,skip);if(line>=0&&line-skip<4096&&line+1<buffer.length)skip=line+1;}
      return {start:from+skip,end,size,text:buffer.subarray(skip).toString('utf8'),capped:this.capped.has(file)||size>=this.maxLogBytes};
    }finally{await handle.close();}
  }
  async remove(chatId:string,key:string):Promise<void> {
    let file;try{({file}=this.location(chatId,key));}catch{return;}
    this.pending.delete(file);
    await this.writing;
    this.sizes.delete(file);this.capped.delete(file);
    await fs.rm(file,{force:true}).catch(()=>{});
  }
  /** Keep the whole directory within maxTotalBytes by removing the least recently written logs. */
  async prune():Promise<number> {
    const files:{path:string;size:number;mtime:number}[]=[];
    let dirs:string[]=[];try{dirs=await fs.readdir(this.root);}catch{return 0;}
    for(const dir of dirs){
      let names:string[]=[];try{names=await fs.readdir(join(this.root,dir));}catch{continue;}
      for(const name of names){if(!name.endsWith('.log'))continue;const path=join(this.root,dir,name);try{const stat=await fs.stat(path);files.push({path,size:stat.size,mtime:stat.mtimeMs});}catch{/* raced a removal */}}
    }
    let total=files.reduce((sum,file)=>sum+file.size,0),removed=0;
    for(const file of files.sort((a,b)=>a.mtime-b.mtime)){
      if(total<=this.maxTotalBytes)break;
      await fs.rm(file.path,{force:true}).catch(()=>{});
      this.sizes.delete(file.path);this.capped.delete(file.path);total-=file.size;removed++;
    }
    return removed;
  }
}
