import type {TimelineItem} from '../../shared/protocol';
import type {TranscriptEntry} from './activityGrouping.ts';
import {APPROVAL_WAIT_LABEL,awaitingApproval,classifyTool} from './toolPresentation.ts';

/** Pure transcript-chrome model: every duration derives from TimelineItem.createdAt; no runtime timestamps. */
export const time=(value:string|undefined):number=>{const ms=value?Date.parse(value):NaN;return Number.isFinite(ms)?ms:NaN;};
export function elapsed(from:string|undefined,to:string|undefined):number|null {const ms=time(to)-time(from);return Number.isFinite(ms)&&ms>=0?ms:null;}
/** Codex style: "26s", "1m 12s", "2h 5m". */
export function formatDuration(ms:number):string {
  const s=Math.max(0,Math.floor(ms/1000));
  if(s<60)return `${s}s`;
  if(s<3600)return `${Math.floor(s/60)}m ${s%60}s`;
  return `${Math.floor(s/3600)}h ${Math.floor(s%3600/60)}m`;
}
export function thoughtLabel(status:string|undefined,ms:number|null):string {
  if(status==='running')return 'Thinking';
  if(status==='failed')return 'Thinking failed';
  if(status==='interrupted')return 'Thinking interrupted';
  if(ms==null)return 'Thought';
  return ms<2000?'Thought briefly':`Thought for ${formatDuration(ms)}`;
}
export const rowStart=(row:TranscriptEntry|undefined):string|undefined=>row?.kind==='activity'?row.items[0]?.createdAt:row?.createdAt;
export const rowEnd=(row:TranscriptEntry|undefined):string|undefined=>{
  if(row?.kind!=='activity')return row?.createdAt;
  let best:string|undefined,bestAt=-Infinity;for(const item of row.items){const at=time(item.createdAt);if(at>bestAt){bestAt=at;best=item.createdAt;}}return best;
};
const busy=(row:TranscriptEntry)=>row.kind==='activity'?row.items.some(item=>item.status==='running'):row.status==='running'||row.status==='pending';
export interface TurnInfo {id:string;row:number;end:number;durationMs:number|null;complete:boolean;work:number}
/** A turn is a user row plus every row up to the next user row. Only the tail turn can be live. */
export function describeTurns(rows:readonly TranscriptEntry[],running:boolean):{turns:Map<string,TurnInfo>;rowTurn:(string|undefined)[];last?:string} {
  const turns=new Map<string,TurnInfo>(),rowTurn:(string|undefined)[]=new Array(rows.length);let current:TurnInfo|undefined,live=false,latest=-Infinity,latestAt:string|undefined;
  const finish=(isLast:boolean)=>{if(!current)return;current.complete=!live&&!(isLast&&running);current.durationMs=current.work?elapsed(rowStart(rows[current.row]),latestAt):null;};
  for(let index=0;index<rows.length;index++){
    const row=rows[index];
    if(row.kind==='user'){finish(false);current={id:row.id,row:index,end:index,durationMs:null,complete:false,work:0};turns.set(row.id,current);live=false;latest=time(row.createdAt);latestAt=row.createdAt;rowTurn[index]=row.id;continue;}
    rowTurn[index]=current?.id;if(!current)continue;
    current.end=index;if(row.kind==='activity'||row.kind==='reasoning')current.work++;if(busy(row))live=true;
    const at=rowEnd(row),ms=time(at);if(ms>latest){latest=ms;latestAt=at;}
  }
  finish(true);
  return {turns,rowTurn,last:current?.id};
}
/** Rows a completed, folded turn hides: its tool activity and reasoning. Prose and approvals stay. */
export const foldable=(row:TranscriptEntry)=>row.kind==='activity'||row.kind==='reasoning';

export interface TailStatus {label:string;kind:'thinking'|'tool'|'responding'|'approval'|'retry';since?:string;retryAt?:number}
/** Live tail: what the agent is doing right now, and since when (the current turn's user message). */
export function tailStatus(items:readonly TimelineItem[]):TailStatus {
  let start=items.length-1;while(start>=0&&items[start].kind!=='user')start--;
  const since=items[start]?.createdAt??items[0]?.createdAt;
  for(let index=items.length-1;index>start;index--){
    const item=items[index];
    if(item.kind==='notice'&&item.data?.kind==='admission-retry'&&item.status==='running'){const at=typeof item.data.retryAt==='string'||typeof item.data.retryAt==='number'?new Date(item.data.retryAt).getTime():NaN;return {label:'Retrying',kind:'retry',since,retryAt:Number.isFinite(at)?at:undefined};}
    if(item.kind==='approval'&&item.status==='pending')return {label:'Waiting for approval',kind:'approval',since};
    if(item.kind==='question'&&item.status==='pending')return {label:'Waiting for your answer',kind:'approval',since};
    if(item.status!=='running')continue;
    if(item.kind==='tool'&&awaitingApproval(item))return {label:APPROVAL_WAIT_LABEL,kind:'approval',since};
    if(item.kind==='tool'){const p=classifyTool(item.data);const subject=p.kind==='read'||p.kind==='edit'?p.subject.split(', ').map(path=>path.split('/').filter(Boolean).at(-1)||path).join(', '):p.subject;return {label:`${p.runningVerb}${subject?' '+subject:''}`,kind:'tool',since};}
    if(item.kind==='assistant')return {label:'Responding',kind:'responding',since};
    if(item.kind==='reasoning')return {label:'Thinking',kind:'thinking',since};
  }
  return {label:'Thinking',kind:'thinking',since};
}
export function retryLabel(retryAt:number|undefined,now:number):string {
  if(retryAt==null)return 'Retrying';const s=Math.ceil((retryAt-now)/1000);return s>0?`Retrying in ${s}s`:'Retrying now';
}

export interface Announcement {text:string;important:boolean}
export interface AnnounceState {status?:string;count:number}
/** New-since-last-update announcements; the first observation seeds state silently. O(new items). */
export function announcements(prev:AnnounceState|null,status:string|undefined,items:readonly TimelineItem[]):{messages:Announcement[];next:AnnounceState} {
  const next={status,count:items.length};if(!prev)return {messages:[],next};
  const messages:Announcement[]=[];
  if(status!==prev.status){const text=status==='running'?'Agent started':status==='completed'?'Agent finished':status==='failed'?'Agent failed':status==='interrupted'?'Agent stopped':'';if(text)messages.push({text,important:true});}
  // A bulk jump (history reload) is not live news: speak status only.
  const fresh=items.length-prev.count>25?[]:items.slice(Math.min(prev.count,items.length));
  for(const item of fresh){
    if(item.kind==='approval'&&item.status==='pending')messages.push({text:'Needs approval',important:true});
    else if(item.kind==='question'&&item.status==='pending')messages.push({text:'Needs your answer',important:true});
    else if(item.kind==='tool'){const p=classifyTool(item.data);messages.push({text:`${awaitingApproval(item)?APPROVAL_WAIT_LABEL:item.status==='running'?p.runningVerb:p.verb}${p.subject?' '+p.subject.slice(0,120):''}`,important:false});}
  }
  return {messages,next};
}
/** One live-region message per interval; an important message replaces a queued routine one, never the reverse. */
export function createThrottledAnnouncer(emit:(text:string)=>void,{interval=3000,now=()=>Date.now(),setTimer=(fn:()=>void,ms:number):unknown=>setTimeout(fn,ms),clearTimer=(id:unknown)=>clearTimeout(id as ReturnType<typeof setTimeout>)}={}) {
  let last=-Infinity,pending:Announcement|null=null,timer:unknown=null;
  const flush=()=>{timer=null;if(!pending)return;const text=pending.text;pending=null;last=now();emit(text);};
  return {
    push(message:Announcement){
      if(pending?.important&&!message.important)return;
      pending=message;if(timer!=null)return;
      const wait=last+interval-now();if(wait<=0)flush();else timer=setTimer(flush,wait);
    },
    dispose(){if(timer!=null)clearTimer(timer);timer=null;pending=null;},
  };
}

/**
 * TRN-18: execution and review finish separately. While the run works the turn is 'working'; when it ends the
 * review (baseline list and diff) is re-read ('preparing', "Preparing review…"), and only then is it 'ready'
 * ("Ready to review"). Events out of order (a stale 'prepared', a 'settled' never seen live) change nothing.
 */
export type ReviewReadiness = 'working'|'preparing'|'ready'|'failed'|undefined;
/** TRN-18: a failed preparation is its own state ('failed', with Retry), never 'Ready to review'. */
export function advanceReviewReadiness(prev:ReviewReadiness,event:'live'|'settled'|'prepared'|'failed'|'retry'):ReviewReadiness {
  if(event==='live')return 'working';
  if(event==='settled')return prev==='working'?'preparing':prev;
  if(event==='failed')return prev==='preparing'?'failed':prev;
  if(event==='retry')return prev==='failed'?'preparing':prev;
  return prev==='preparing'?'ready':prev;
}
export const REVIEW_READINESS_LABEL={preparing:'Preparing review…',ready:'Ready to review',failed:'Couldn’t prepare review'} as const;
