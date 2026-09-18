import type {TimelineItem} from '../../shared/protocol';
import {classifyTool} from './toolPresentation.ts';

export interface ActivityEntry {kind:'activity';id:string;items:TimelineItem[]}
export type TranscriptEntry = TimelineItem | ActivityEntry;
export function groupActivity(items:TimelineItem[]):TranscriptEntry[] {
  const rows:TranscriptEntry[]=[];
  for(const item of items){
    const previous=rows.at(-1);
    if(item.kind==='tool') {
      if(previous?.kind==='activity') previous.items.push(item);
      else rows.push({kind:'activity',id:item.id,items:[item]});
    } else rows.push(item);
  }
  return rows;
}
export function summarizeActivity(items:TimelineItem[]):string {
  const unique=[...new Map(items.map(item=>[item.id,item])).values()];
  const running=unique.findLast(item=>item.status==='running');
  if(running){const p=classifyTool(running.data);return `${p.runningVerb}${p.subject?' '+p.subject:''}`;}
  const read=new Set<string>(),edited=new Set<string>();let searches=0,commands=0,tools=0,agents=0;
  for(const item of unique.filter(item=>item.status==='completed')){
    const p=classifyTool(item.data);
    if(p.kind==='read') {for(const path of p.paths??[p.subject]) if(path)read.add(path);}
    else if(p.kind==='edit') {for(const path of p.paths??[p.subject]) if(path)edited.add(path);}
    else if(p.kind==='search') searches++;
    else if(p.kind==='command') commands++;
    else if(p.kind==='subagent') agents++;
    else tools++;
  }
  const count=(n:number,one:string,many=one+'s')=>`${n} ${n===1?one:many}`;
  const parts=[read.size?`Read ${count(read.size,'file')}`:'',edited.size?`edited ${count(edited.size,'file')}`:'',searches?`${count(searches,'search','searches')}`:'',commands?`ran ${count(commands,'command')}`:'',agents?`${count(agents,'agent action')}`:'',tools?`${count(tools,'tool call')}`:''].filter(Boolean);
  const failed=unique.filter(item=>item.status==='failed').length;
  const interrupted=unique.filter(item=>item.status==='interrupted'||item.status==='cancelled').length;
  if(failed)parts.push(`${failed} failed`);if(interrupted)parts.push(`${interrupted} interrupted`);
  const summary=parts.join(', ');
  return summary?summary[0].toUpperCase()+summary.slice(1):'Activity';
}
