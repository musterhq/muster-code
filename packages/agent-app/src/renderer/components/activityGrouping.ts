import type {TimelineItem} from '../../shared/protocol';
import {APPROVAL_WAIT_LABEL,awaitingApproval,classifyTool} from './toolPresentation.ts';
import {agentDisplayName} from '../agentIdentity.ts';
import {projectSubagentActivity,subagentLifecycle,subagentState,type SubagentLifecycleEvent} from '../subagentActivity.ts';

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
export interface SubagentRowAgent {id:string;name:string;state:'working'|'done'|'failed'|'idle';
  /** Failed rows only: the provider's reason (DOGFOOD F51), or none when it gave none. */
  reason?:string}
export type ActivitySegment = {kind:'tools';id:string;items:TimelineItem[]} | {kind:'subagents';id:string;chatId:string;event:SubagentLifecycleEvent;agents:SubagentRowAgent[]};
/** Codex-style: subagent lifecycle leaves the tool group as its own ordered rows; adjacent starts merge. Reports with nothing new stay grouped tool work. */
export function segmentActivity(items:TimelineItem[]):ActivitySegment[] {
  const out:ActivitySegment[]=[],last=new Map<string,SubagentLifecycleEvent>();
  const agents=new Map(projectSubagentActivity(items.filter(item=>item.data?.type==='collabAgentToolCall')).map(agent=>[agent.id,agent]));
  for(const item of items){
    const events=subagentLifecycle(item).filter(({id,event})=>{const prior=last.get(id);return event==='started'?prior!=='started':prior===undefined||prior==='started';});
    if(!events.length){const previous=out.at(-1);if(previous?.kind==='tools')previous.items.push(item);else out.push({kind:'tools',id:item.id,items:[item]});continue;}
    for(const {id,event,name,reason} of events){
      last.set(id,event);
      const known=agents.get(id),kind=subagentState(known?.state).kind;
      const ordinal=[...agents.keys()].indexOf(id)+1;
      const agent:SubagentRowAgent={id,name:agentDisplayName({name:name??known?.name,role:known?.role,prompt:known?.prompt},ordinal||undefined),state:event==='failed'?'failed':event==='finished'?'done':kind==='working'||kind==='waiting'||item.status==='running'&&kind==='unknown'?'working':'idle'};
      const why=event==='failed'?reason??known?.error:undefined;if(why)agent.reason=why;
      const previous=out.at(-1);
      if(event==='started'&&previous?.kind==='subagents'&&previous.event==='started'){if(!previous.agents.some(a=>a.id===id))previous.agents.push(agent);}
      else out.push({kind:'subagents',id:`${item.id}:${event}:${id}`,chatId:item.chatId,event,agents:[agent]});
    }
  }
  return out;
}
export function namesLabel(names:string[]):string {return names.length<2?names[0]??'':`${names.slice(0,-1).join(', ')} and ${names.at(-1)}`;}
/** A failed row's reason line: one agent's reason, or none when the provider gave none. */
export function subagentRowReason(row:{event:SubagentLifecycleEvent;agents:{reason?:string}[]}):string|undefined {
  if(row.event!=='failed')return undefined;
  const reasons=[...new Set(row.agents.map(agent=>agent.reason).filter((reason):reason is string=>!!reason))];
  return reasons.length?reasons.join(' · '):'No reason reported by the provider';
}
export function subagentRowLabel(row:{event:SubagentLifecycleEvent;agents:{name:string}[]}):string {
  return `${namesLabel(row.agents.map(agent=>agent.name))} ${row.event==='started'?'started working':row.event}`;
}
export function summarizeActivity(items:readonly TimelineItem[]):string {
  const unique=[...new Map(items.map(item=>[item.id,item])).values()];
  const running=unique.findLast(item=>item.status==='running');
  if(running){const p=classifyTool(running.data);return `${awaitingApproval(running)?APPROVAL_WAIT_LABEL:p.runningVerb}${p.subject?' '+p.subject:''}`;}
  const read=new Set<string>(),edited=new Set<string>(),viewed=new Set<string>();let searches=0,commands=0,tools=0,agents=0;
  for(const item of unique.filter(item=>item.status==='completed')){
    const p=classifyTool(item.data);
    if(p.images?.length) {for(const path of p.images)viewed.add(path);}
    else if(p.kind==='read') {for(const path of p.paths??[p.subject]) if(path)read.add(path);}
    else if(p.kind==='edit') {for(const path of p.paths??[p.subject]) if(path)edited.add(path);}
    else if(p.kind==='search') searches++;
    else if(p.kind==='command') commands++;
    else if(p.kind==='subagent') agents++;
    else tools++;
  }
  const count=(n:number,one:string,many=one+'s')=>`${n} ${n===1?one:many}`;
  // Codex order: what changed first, then what was looked at, then what ran.
  const parts=[edited.size?`edited ${count(edited.size,'file')}`:'',read.size?`read ${count(read.size,'file')}`:'',viewed.size?`viewed ${count(viewed.size,'image')}`:'',searches?`${count(searches,'search','searches')}`:'',commands?`ran ${count(commands,'command')}`:'',agents?`${count(agents,'agent action')}`:'',tools?`${count(tools,'tool call')}`:''].filter(Boolean);
  const failed=unique.filter(item=>item.status==='failed').length;
  const interrupted=unique.filter(item=>item.status==='interrupted').length;
  const cancelled=unique.filter(item=>item.status==='cancelled').length;
  if(cancelled)parts.push(`${cancelled} cancelled`);
  if(failed)parts.push(`${failed} failed`);if(interrupted)parts.push(`${interrupted} interrupted`);
  const summary=parts.join(', ');
  return summary?summary[0].toUpperCase()+summary.slice(1):'Activity';
}

/** Glyph for a group's summary row: the most significant thing it did (edits, then reads, …). */
export function activityKind(items:readonly TimelineItem[]):{kind:ReturnType<typeof classifyTool>['kind'];image:boolean} {
  const running=items.findLast(item=>item.status==='running');
  if(running){const p=classifyTool(running.data);return {kind:p.kind,image:!!p.images?.length};}
  const kinds=items.map(item=>classifyTool(item.data));
  for(const kind of ['edit','read','search','command','subagent','mcp','computer','list'] as const){const hit=kinds.find(p=>p.kind===kind&&!(kind==='read'&&p.images?.length));if(hit)return {kind,image:false};}
  if(kinds.some(p=>p.images?.length))return {kind:'read',image:true};
  return {kind:kinds[0]?.kind??'generic',image:false};
}
/** Paths of every image a group only viewed, for its thumbnail strip. */
export function viewedImages(items:readonly TimelineItem[]):string[] {
  return [...new Set(items.flatMap(item=>item.status==='completed'?classifyTool(item.data).images??[]:[]))];
}
