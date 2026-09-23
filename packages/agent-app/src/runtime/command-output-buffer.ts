export const MAX_COMMAND_OUTPUT = 131072;
export interface CommandOutput {output:string;truncated:boolean}
/** Index at or after `index` that starts a whole character: never a low surrogate,
 * combining mark, variation selector or joiner left over from the dropped head. */
export function safeTailStart(text:string,index:number):number {
 let at=Math.max(0,index);
 const code=text.charCodeAt(at);if(code>=0xdc00&&code<=0xdfff)at++;
 while(at<text.length&&/^[\p{M}\u200d\ufe0e\ufe0f]$/u.test(String.fromCodePoint(text.codePointAt(at)!)))at+=text.codePointAt(at)!>0xffff?2:1;
 return at;
}
const tail=(text:string,max:number)=>text.length>max?text.slice(safeTailStart(text,text.length-max)):text;
/** Complete ANSI/VT escape sequences (CSI colours, OSC titles/links, two-byte escapes).
 * A sequence split across chunks stays until the next chunk completes it. */
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
/** Tool rows show plain text; terminal colour codes are noise there (F39). */
export function stripAnsi(text:string):string {return text.includes('\u001b')?text.replace(ANSI,''):text;}
export function appendCommandOutput(previous:CommandOutput,delta:string):CommandOutput {
 return {output:tail(previous.output+tail(delta,MAX_COMMAND_OUTPUT),MAX_COMMAND_OUTPUT),truncated:previous.truncated||previous.output.length+delta.length>MAX_COMMAND_OUTPUT};
}
export function finishCommandOutput(previous:CommandOutput,finalOutput:string|null):CommandOutput {
 if(finalOutput===null||(previous.output&&previous.output.endsWith(finalOutput)))return previous;
 return {output:tail(finalOutput,MAX_COMMAND_OUTPUT),truncated:finalOutput.length>MAX_COMMAND_OUTPUT};
}
/** Total output characters kept across finished commands (newest first). */
export const MAX_FINISHED_OUTPUT_TOTAL = 2 * 1024 * 1024;
/** Tail kept for older finished commands once the total budget is spent. */
export const FINISHED_OUTPUT_TAIL = 8 * 1024;
/** Bound retained output of finished commands: the newest keep their full
 * (already per-command bounded) tail until the shared budget is spent; older
 * ones keep only a short tail and are marked truncated. Mutates in place. */
export function trimFinishedOutputs<T extends CommandOutput & {updatedAt:string}>(finished:T[],budget=MAX_FINISHED_OUTPUT_TOTAL,tail=FINISHED_OUTPUT_TAIL):number {
 let used=0,trimmed=0;
 for(const item of [...finished].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))){
  if(used+item.output.length>budget && item.output.length>tail){
   // Array join flattens the tail so it does not retain the larger parent string.
   item.output=[item.output.slice(-tail)].join('');item.truncated=true;trimmed++;
  }
  used+=item.output.length;
 }
 return trimmed;
}

export const TERMINAL_MAX_LINES=5000;
export const TERMINAL_MAX_BYTES=8*1024*1024;
const CHUNK=16384;
const newlines=(text:string)=>{let count=0;for(let at=text.indexOf('\n');at>=0;at=text.indexOf('\n',at+1))count++;return count;};
/** UTF-16 index of the first whole character at or after `bytes` UTF-8 bytes into `text`. */
function byteIndex(text:string,bytes:number):number {
 const buffer=Buffer.from(text,'utf8');if(bytes>=buffer.length)return text.length;
 let at=bytes;while(at<buffer.length&&(buffer[at]&0xc0)===0x80)at++;
 return buffer.subarray(0,at).toString('utf8').length;
}
/** Terminal replay ring (RUN-05): at most 5,000 lines and 8 MiB of UTF-8. The dropped
 * head ends on a line break when one is near, otherwise on a whole character, so a
 * replay never begins with half a surrogate pair or a stray combining mark. */
export class TerminalRing {
 private chunks:string[]=[];private bytes=0;private lines=0;
 truncatedBytes=0;omittedLines=0;end=0;
 constructor(private maxLines=TERMINAL_MAX_LINES,private maxBytes=TERMINAL_MAX_BYTES){}
 append(data:string):void {
  if(!data)return;this.end+=data.length;
  const last=this.chunks.length-1;
  if(last>=0&&this.chunks[last].length+data.length<=CHUNK)this.chunks[last]+=data;else this.chunks.push(data);
  this.bytes+=Buffer.byteLength(data,'utf8');this.lines+=newlines(data);this.trim();
 }
 private trim():void {
  while(this.chunks.length&&(this.lines>this.maxLines||this.bytes>this.maxBytes)){
   const head=this.chunks[0],excessLines=this.lines-this.maxLines,excessBytes=this.bytes-this.maxBytes;
   let lineCut=0,byteCut=0;
   if(excessLines>0){let at=-1;for(let n=0;n<excessLines;n++){at=head.indexOf('\n',at+1);if(at<0)break;}lineCut=at<0?head.length:at+1;}
   if(excessBytes>0){byteCut=byteIndex(head,excessBytes);if(byteCut<head.length&&head[byteCut-1]!=='\n'){const next=head.indexOf('\n',byteCut);byteCut=next>=0&&next-byteCut<4096?next+1:safeTailStart(head,byteCut);}}
   const cut=Math.max(lineCut,byteCut);
   const removed=cut>=head.length?head:head.slice(0,cut);
   if(cut>=head.length)this.chunks.shift();else this.chunks[0]=[head.slice(cut)].join('');
   const bytes=Buffer.byteLength(removed,'utf8'),lines=newlines(removed);
   this.bytes-=bytes;this.lines-=lines;this.truncatedBytes+=bytes;this.omittedLines+=lines;
  }
 }
 get lineCount():number {return this.lines;}
 get byteLength():number {return this.bytes;}
 snapshot():{data:string;truncatedBytes:number;omittedLines:number;end:number} {
  return {data:this.chunks.join(''),truncatedBytes:this.truncatedBytes,omittedLines:this.omittedLines,end:this.end};
 }
 /** The newest `maxBytes` of UTF-8, cut on a whole character (for the saved tail of an ended terminal). */
 tail(maxBytes:number):string {
  let from=this.chunks.length,bytes=0;
  while(from>0&&bytes<=maxBytes)bytes+=Buffer.byteLength(this.chunks[--from],'utf8');
  const data=this.chunks.slice(from).join(''),size=Buffer.byteLength(data,'utf8');
  if(size<=maxBytes)return data;
  const start=safeTailStart(data,byteIndex(data,size-maxBytes)),line=data.indexOf('\n',start);
  return data.slice(line>=0&&line-start<4096?line+1:start);
 }
 clear():void {this.truncatedBytes+=this.bytes;this.omittedLines+=this.lines;this.chunks=[];this.bytes=0;this.lines=0;}
}
