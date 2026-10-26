import type {TimelineItem} from '../../shared/protocol';
import {APPROVAL_WAIT_LABEL,awaitingApproval,classifyTool,executionDenied} from './toolPresentation.ts';
import {agentDisplayName,agentDisplayNames} from '../agentIdentity.ts';
import {projectSubagentActivity,subagentLifecycle,subagentState,type SubagentActivity,type SubagentLifecycleEvent} from '../subagentActivity.ts';

export interface ActivityEntry {kind:'activity';id:string;items:TimelineItem[];
  /** Sub-agent lifecycle already shown by earlier groups, so a later group does not repeat it (#582). */
  prior?:ReadonlyMap<string,SubagentLifecycleEvent>;
  /** The chat's sub-agents in report order, on groups that report one: every group names and numbers them alike (#582). */
  agents?:readonly SubagentActivity[]}
export type TranscriptEntry = TimelineItem | ActivityEntry;
const isCollab=(item:TimelineItem)=>item.kind==='tool'&&item.data?.type==='collabAgentToolCall';
// Timeline items are immutable: parse a report's lifecycle once, not on every streamed update.
const lifecycles=new WeakMap<TimelineItem,ReturnType<typeof subagentLifecycle>>();
const lifecycleOf=(item:TimelineItem)=>{let all=lifecycles.get(item);if(!all){all=subagentLifecycle(item);lifecycles.set(item,all);}return all;};
/** A transition is new unless the agent already shows it: a start once, then one finish or failure. */
const isNew=(event:SubagentLifecycleEvent,prior:SubagentLifecycleEvent|undefined)=>event==='started'?prior!=='started':prior===undefined||prior==='started';
function newLifecycle(item:TimelineItem,last:{get(id:string):SubagentLifecycleEvent|undefined}) {
  return isCollab(item)?lifecycleOf(item).filter(({id,event})=>isNew(event,last.get(id))):[];
}
/** The previous pass: its reports, roster and lifecycle snapshots. A streamed update that changed no report reuses them. */
export interface SubagentRoster {reports:readonly TimelineItem[];agents:readonly SubagentActivity[];snapshots:readonly ReadonlyMap<string,SubagentLifecycleEvent>[]}
/** Carries sub-agent lifecycle across activity groups in one pass over the timeline: `open` gives a new group what earlier
 *  groups already showed (the previous projection's map when unchanged), `see` records a tool item, `finish` hands every
 *  group that reports a sub-agent the chat-wide roster (the previous one when no report changed) and returns it. */
export function subagentContext(previous?:SubagentRoster) {
  const shown=new Map<string,SubagentLifecycleEvent>(),reporting:ActivityEntry[]=[],reports:TimelineItem[]=[];
  // Groups between two lifecycle changes share one snapshot. While every report so far is the previous pass's, the
  // previous pass's snapshot is reused, so unchanged groups keep the same `prior` across streamed updates.
  const snapshots:ReadonlyMap<string,SubagentLifecycleEvent>[]=[];let changed=true,unchanged=true;
  return {
    open(row:ActivityEntry):ActivityEntry {
      if(!shown.size)return row;
      if(changed){snapshots.push(unchanged&&previous?.snapshots[snapshots.length]||new Map(shown));changed=false;}
      row.prior=snapshots.at(-1);
      return row;
    },
    see(row:ActivityEntry,item:TimelineItem):void {
      if(!isCollab(item))return;
      if(reporting.at(-1)!==row)reporting.push(row);
      unchanged&&=previous?.reports[reports.length]===item;reports.push(item);
      for(const {id,event} of lifecycleOf(item))if(isNew(event,shown.get(id))){shown.set(id,event);changed=true;}
    },
    finish():SubagentRoster|undefined {
      if(!reporting.length)return undefined;
      const roster=unchanged&&previous&&previous.reports.length===reports.length?{...previous,snapshots}:{reports,agents:projectSubagentActivity(reports),snapshots};
      for(const row of reporting)row.agents=roster.agents;
      return roster;
    },
  };
}
export function groupActivity(items:TimelineItem[]):TranscriptEntry[] {
  const rows:TranscriptEntry[]=[],context=subagentContext();
  for(const item of items){
    const previous=rows.at(-1);
    if(item.kind==='tool') {
      let row:ActivityEntry;
      if(previous?.kind==='activity'){row=previous;row.items.push(item);}
      else {row=context.open({kind:'activity',id:item.id,items:[item]});rows.push(row);}
      context.see(row,item);
    } else rows.push(item);
  }
  context.finish();
  return rows;
}
export interface SubagentRowAgent {id:string;name:string;state:'working'|'done'|'failed'|'idle';
  /** Failed rows only: the provider's reason (DOGFOOD F51), or none when it gave none. */
  reason?:string}
export type ActivitySegment = {kind:'tools';id:string;items:TimelineItem[]} | {kind:'subagents';id:string;chatId:string;event:SubagentLifecycleEvent;agents:SubagentRowAgent[]};
/** Codex-style: subagent lifecycle leaves the tool group as its own ordered rows; adjacent starts merge. Reports with nothing new stay grouped tool work. */
/** `prior` and `roster` come from the whole chat (ActivityEntry): without them a group sees only its own reports. */
export function segmentActivity(items:TimelineItem[],prior?:ReadonlyMap<string,SubagentLifecycleEvent>,roster?:readonly SubagentActivity[]):ActivitySegment[] {
  // Events this group showed, over what earlier groups showed (read through, never copied: this runs per render).
  const own=new Map<string,SubagentLifecycleEvent>(),last={get:(id:string)=>own.get(id)??prior?.get(id)};
  const out:ActivitySegment[]=[];
  let agents:Map<string,SubagentActivity>|undefined,names:Map<string,string>|undefined;
  for(const item of items){
    const events=newLifecycle(item,last);
    if(!events.length){const previous=out.at(-1);if(previous?.kind==='tools')previous.items.push(item);else out.push({kind:'tools',id:item.id,items:[item]});continue;}
    for(const {id,event,name,reason} of events){
      own.set(id,event);
      if(!agents){const all=roster??projectSubagentActivity(items.filter(isCollab));agents=new Map(all.map(agent=>[agent.id,agent]));names=agentDisplayNames(all);}
      const known=agents.get(id),kind=subagentState(known?.state).kind;
      const agent:SubagentRowAgent={id,name:names!.get(id)??agentDisplayName({name}),state:event==='failed'?'failed':event==='finished'?'done':kind==='working'||kind==='waiting'||item.status==='running'&&kind==='unknown'?'working':'idle'};
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
  const running=unique.findLast(item=>item.status==='running'&&!executionDenied(item.data));
  if(running){const p=classifyTool(running.data);return `${awaitingApproval(running)?APPROVAL_WAIT_LABEL:p.runningVerb}${p.subject?' '+p.subject:''}`;}
  const read=new Set<string>(),edited=new Set<string>(),viewed=new Set<string>(),used=new Set<string>();let searches=0,commands=0,tools=0,agents=0;
  for(const item of unique.filter(item=>item.status==='completed'&&!executionDenied(item.data))){
    const p=classifyTool(item.data);
    if(p.images?.length) {for(const path of p.images)viewed.add(path);}
    else if(p.kind==='read') {for(const path of p.paths??[p.subject]) if(path)read.add(path);}
    else if(p.kind==='edit') {for(const path of p.paths??[p.subject]) if(path)edited.add(path);}
    else if(p.kind==='search') searches++;
    else if(p.kind==='command') commands++;
    else if(p.kind==='subagent') agents++;
    else if(p.kind==='computer'&&p.computer) used.add(p.computer.target==='browser'?'the browser':p.computer.app||'the computer');
    else tools++;
  }
  const count=(n:number,one:string,many=one+'s')=>`${n} ${n===1?one:many}`;
  // Codex order: the apps it drove ("Used Chrome integration"), what changed, what was looked at, then what ran.
  const parts=[used.size?`used ${namesLabel([...used])}`:'',edited.size?`edited ${count(edited.size,'file')}`:'',read.size?`read ${count(read.size,'file')}`:'',viewed.size?`viewed ${count(viewed.size,'image')}`:'',searches?`${count(searches,'search','searches')}`:'',commands?`ran ${count(commands,'command')}`:'',agents?`${count(agents,'agent action')}`:'',tools?`${count(tools,'tool call')}`:''].filter(Boolean);
  // #580: the counts match the rows: a refused tool "did not run", a stopped one reads Stopped.
  let failed=0,interrupted=0,cancelled=0,denied=0;
  for(const item of unique){if(executionDenied(item.data))denied++;else if(item.status==='failed')failed++;else if(item.status==='interrupted')interrupted++;else if(item.status==='cancelled')cancelled++;}
  if(denied)parts.push(`${denied} not run`);
  if(cancelled)parts.push(`${cancelled} cancelled`);
  if(failed)parts.push(`${failed} failed`);if(interrupted)parts.push(`${interrupted} stopped`);
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
/** The app a group drove (Codex shows its icon on the summary row): the running step's, else the newest. */
export function activityApp(items:readonly TimelineItem[]):{app:string;target:'computer'|'browser'}|undefined {
  const running=items.findLast(item=>item.status==='running');
  const pick=(item:TimelineItem|undefined)=>{const action=item?classifyTool(item.data).computer:undefined;return action?{app:action.app,target:action.target}:undefined;};
  if(running)return pick(running);
  for(let index=items.length-1;index>=0;index--){const hit=pick(items[index]);if(hit)return hit;}
  return undefined;
}
/** Paths of every image a group only viewed, for its thumbnail strip. */
export function viewedImages(items:readonly TimelineItem[]):string[] {
  return [...new Set(items.flatMap(item=>item.status==='completed'?classifyTool(item.data).images??[]:[]))];
}
