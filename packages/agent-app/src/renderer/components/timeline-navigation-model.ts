import type {TranscriptEntry} from './activityGrouping.ts';
import type {TimelineItem} from '../../shared/protocol';

export interface TurnSummary {id:string;rowIndex:number;prompt:string;response:string}
export interface TranscriptMatch {rowIndex:number;offset:number;itemId:string;occurrence:number}
export const MAX_TRANSCRIPT_MATCHES=5000;
/** Every occurrence in loaded prose and grouped activity, without depending on virtualized DOM.
 * `occurrence` is the ordinal within its row so the rendered row can mark the same hit. */
export function findTranscriptMatches(rows:readonly TranscriptEntry[],query:string):TranscriptMatch[] {
  const needle=query.trim().toLocaleLowerCase();if(!needle)return [];
  const matches:TranscriptMatch[]=[];
  for(let rowIndex=0;rowIndex<rows.length;rowIndex++){
    const row=rows[rowIndex],items=row.kind==='activity'?row.items:[row];let occurrence=0;
    for(const item of items){
      const text=item.text.toLocaleLowerCase();
      for(let offset=text.indexOf(needle);offset>=0;offset=text.indexOf(needle,offset+needle.length)){
        matches.push({rowIndex,offset,itemId:item.id,occurrence:occurrence++});
        if(matches.length>=MAX_TRANSCRIPT_MATCHES)return matches;
      }
    }
  }
  return matches;
}
const preview=(text:string,limit:number)=>{
  const normalized=text.slice(0,2000).replace(/\s+/g,' ').trim();
  return normalized.length>limit?normalized.slice(0,limit-1)+'…':normalized;
};
/** User rows are the only turn anchors. Tool/reasoning output is never promoted
 * to assistant prose. Reuse summaries/array when streaming past preview limits. */
export function summarizeTurns(rows:readonly TranscriptEntry[],previous:readonly TurnSummary[]=[]):readonly TurnSummary[] {
  const prior=new Map(previous.map(turn=>[turn.id,turn]));
  const turns:TurnSummary[]=[];let current:TurnSummary|undefined;
  for(let rowIndex=0;rowIndex<rows.length;rowIndex++){
    const row=rows[rowIndex];
    if(row.kind==='user'){current={id:row.id,rowIndex,prompt:preview(row.text,150),response:''};turns.push(current);}
    else if(current&&row.kind==='assistant'&&!current.response)current.response=preview(row.text,240);
  }
  for(let i=0;i<turns.length;i++){
    const old=prior.get(turns[i].id),next=turns[i];
    if(old&&old.rowIndex===next.rowIndex&&old.prompt===next.prompt&&old.response===next.response)turns[i]=old;
  }
  return previous.length===turns.length&&turns.every((turn,index)=>turn===previous[index])?previous:turns;
}
/** The timeline already groups every immutable update. Build navigation in that
 * same pass, caching prose prefixes and retaining the row index on text deltas.
 * There is no second per-token scan or DOM query. Arbitrary historical edits
 * still invalidate the corresponding immutable item, not an assumed suffix. */
export function createTimelineProjection(){
  const snippets=new WeakMap<TimelineItem,string>();
  let prior:{rows:TranscriptEntry[];turns:readonly TurnSummary[];rowIndexes:Map<string,number>}={rows:[],turns:[],rowIndexes:new Map()};
  return (items:readonly TimelineItem[])=>{
    const rows:TranscriptEntry[]=[],turns:TurnSummary[]=[];
    let current:TurnSummary|undefined,sameTurns=true,sameRows=true;
    const finish=()=>{
      if(!current)return;
      const old=prior.turns[turns.length];
      const next=old&&old.id===current.id&&old.rowIndex===current.rowIndex&&old.prompt===current.prompt&&old.response===current.response?old:current;
      sameTurns&&=next===old;turns.push(next);
    };
    for(const item of items){
      const last=rows.at(-1);
      if(item.kind==='tool'&&last?.kind==='activity'){last.items.push(item);continue;}
      const rowIndex=rows.length;
      sameRows&&=prior.rows[rowIndex]?.id===item.id;
      rows.push(item.kind==='tool'?{kind:'activity',id:item.id,items:[item]}:item);
      if(item.kind==='user'||item.kind==='assistant'){
        let text=snippets.get(item);
        if(text===undefined){text=preview(item.text,item.kind==='user'?150:240);snippets.set(item,text);}
        if(item.kind==='user'){finish();current={id:item.id,rowIndex,prompt:text,response:''};}
        else if(current&&!current.response)current.response=text;
      }
    }
    finish();sameRows&&=rows.length===prior.rows.length;sameTurns&&=turns.length===prior.turns.length;
    prior={rows,turns:sameTurns?prior.turns:turns,rowIndexes:sameRows?prior.rowIndexes:new Map(rows.map((row,index)=>[row.id,index]))};
    return prior;
  };
}
/** Binary search in logical rows; no DOM traversal or rendered-row assumption. */
export function turnAtRow(turns:readonly TurnSummary[],rowIndex:number):string|undefined {
  let low=0,high=turns.length-1,result=-1;
  while(low<=high){const middle=(low+high)>>>1;if(turns[middle].rowIndex<=rowIndex){result=middle;low=middle+1;}else high=middle-1;}
  return result<0?undefined:turns[result].id;
}
export const MAX_RAIL_TURNS=33;
export function railWindow(length:number,index:number):{start:number;end:number} {
  const start=Math.max(0,Math.min(Math.max(0,length-MAX_RAIL_TURNS),index-Math.floor(MAX_RAIL_TURNS/2)));
  return {start,end:Math.min(length,start+MAX_RAIL_TURNS)};
}
