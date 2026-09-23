import React,{useEffect,useId,useMemo,useRef,useState} from 'react';
import {ChevronRight} from 'lucide-react';
import type {TimelineItem} from '../../shared/protocol';
import {ImageThumbs,ToolCard,ToolGlyph} from './ToolCard';
import {activityKind,segmentActivity,subagentRowLabel,subagentRowReason,summarizeActivity,viewedImages,type ActivitySegment} from './activityGrouping';
import {AgentGlyph} from '../agentIdentity';
import {selectSubagent} from '../subagentActivity';
import {getState,openSubagentsTab} from '../store';
import './activity-group.css';
import {Collapsible} from '@base-ui/react/collapsible';

const disclosures=new Map<string,{open:boolean;page:number;manual:boolean}>();
function remember(id:string,open:boolean,page:number,manual:boolean){disclosures.delete(id);disclosures.set(id,{open,page,manual});if(disclosures.size>200)disclosures.delete(disclosures.keys().next().value!);}
/** Codex: one agent opens its own transcript in the right pane; a merged row opens the list. */
function openAgents(chatId:string,threadId:string|null){const {snapshot}=getState(),chat=snapshot?.chats.find(chat=>chat.id===chatId);selectSubagent(chatId,threadId);openSubagentsTab(chatId,chat?.folderId??snapshot?.folders[0]?.id,chat?.title||'Conversation');}
function SubagentRow({row}:{row:Extract<ActivitySegment,{kind:'subagents'}>}) {
  const label=subagentRowLabel(row),reason=subagentRowReason(row);
  return <button type="button" className={`activity-summary subagent-row is-${row.event}`} title={[row.agents.length===1?`${label} · Open transcript`:label,reason].filter(Boolean).join('\n')} onClick={()=>openAgents(row.chatId,row.agents.length===1?row.agents[0].id:null)}>
    <span className="agent-glyph-stack">{row.agents.slice(0,4).map(agent=><AgentGlyph key={agent.id} name={agent.name} state={agent.state}/>)}</span>
    <span className="activity-summary-text">{label}</span>{reason&&<span className="subagent-row-reason">{reason}</span>}</button>;
}
/** `reveal` names an item holding the active find match: its group, page and card open.
 * `live`: this activity is still the tail of a running turn, so it stays open between tool calls. */
export function ActivityGroup({items,reveal,live=false}:{items:TimelineItem[];reveal?:string;live?:boolean}) {
  const segments=useMemo(()=>segmentActivity(items),[items,items.length]);
  if(segments.length===1&&segments[0].kind==='tools')return <ToolGroup items={segments[0].items} reveal={reveal} live={live}/>;
  return <>{segments.map((segment,index)=>segment.kind==='tools'?<ToolGroup key={segment.id} items={segment.items} reveal={reveal} live={live&&index===segments.length-1}/>:<SubagentRow key={segment.id} row={segment}/>)}</>;
}
const PAGE=40;
function ToolGroup({items,reveal,live}:{items:TimelineItem[];reveal?:string;live:boolean}) {
  const key=items[0]?.id??'';
  const active=items.some(item=>item.status==='running'),working=active||live;
  const [open,setOpen]=useState(()=>disclosures.get(key)?.open??working),[page,setPage]=useState(()=>disclosures.get(key)?.page??0);const id=useId();
  // Codex: a group that finishes (no running tool and no longer the live tail) collapses to its
  // one-line summary unless the reader chose otherwise; gaps between tool calls do not flicker it.
  const manual=useRef(disclosures.get(key)?.manual??false),wasWorking=useRef(working);
  useEffect(()=>{if(wasWorking.current&&!working&&!manual.current&&open){setOpen(false);remember(key,false,page,false);}else if(!wasWorking.current&&working&&!manual.current&&!open){setOpen(true);remember(key,true,page,false);}wasWorking.current=working;},[working]);
  const revealIndex=reveal?items.findIndex(item=>item.id===reveal):-1;
  useEffect(()=>{if(revealIndex<0)return;setOpen(true);setPage(Math.floor(revealIndex/PAGE));},[reveal,revealIndex]);
  const changePage=(value:number)=>{setPage(value);remember(key,open,value,manual.current);};
  const lastPage=Math.max(0,Math.ceil(items.length/PAGE)-1),current=Math.min(page,lastPage);
  const label=summarizeActivity(items),glyph=activityKind(items),images=useMemo(()=>viewedImages(items),[items]);
  if(items.length===1)return <ToolCard item={items[0]} reveal={revealIndex===0}/>;
  return <Collapsible.Root open={open} onOpenChange={value=>{manual.current=true;setOpen(value);remember(key,value,page,true);}} className="activity-group" role="region" aria-label="Agent activity">
    <Collapsible.Trigger className="activity-summary" title={label}>
      <ToolGlyph kind={glyph.kind} running={active} image={glyph.image}/>
      <span className="activity-summary-text">{label}</span><ChevronRight className="tool-chevron" size={13} aria-hidden="true"/></Collapsible.Trigger>
    {!open&&images.length>0&&<ImageThumbs item={items[0]} paths={images}/>}
    <Collapsible.Panel className="activity-disclosure"><div id={id} className="activity-details">
      {items.slice(current*PAGE,(current+1)*PAGE).map(item=><ToolCard key={item.id} item={item} reveal={item.id===reveal}/>)}
      {lastPage>0&&<div className="activity-pages"><button disabled={current===0} onClick={()=>changePage(current-1)}>Previous</button><span>{current*PAGE+1}–{Math.min((current+1)*PAGE,items.length)} of {items.length}</span><button disabled={current===lastPage} onClick={()=>changePage(current+1)}>Next</button></div>}
    </div></Collapsible.Panel>
  </Collapsible.Root>;
}
