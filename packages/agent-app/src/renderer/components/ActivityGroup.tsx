import React,{useId,useState} from 'react';
import {ChevronDown,ChevronRight} from 'lucide-react';
import type {TimelineItem} from '../../shared/protocol';
import {ToolCard,ToolGlyph} from './ToolCard';
import {classifyTool} from './toolPresentation';
import {summarizeActivity} from './activityGrouping';
import './activity-group.css';
import {Collapsible} from '@base-ui/react/collapsible';

const disclosures=new Map<string,{open:boolean;page:number}>();
function remember(id:string,open:boolean,page:number){disclosures.delete(id);disclosures.set(id,{open,page});if(disclosures.size>200)disclosures.delete(disclosures.keys().next().value!);}
export function ActivityGroup({items}:{items:TimelineItem[]}) {
  const key=items[0]?.id??'';
  const [open,setOpen]=useState(()=>disclosures.get(key)?.open??items.some(item=>item.status==='running')),[page,setPage]=useState(()=>disclosures.get(key)?.page??0);const id=useId();
  const changePage=(value:number)=>{setPage(value);remember(key,open,value);};
  const active=items.some(item=>item.status==='running');
  const currentItem=items.findLast(item=>item.status==='running')??items.at(-1);
  const lastPage=Math.max(0,Math.ceil(items.length/40)-1),current=Math.min(page,lastPage);
  const label=summarizeActivity(items);
  if(items.length===1)return <ToolCard item={items[0]}/>;
  return <Collapsible.Root open={open} onOpenChange={value=>{setOpen(value);remember(key,value,page);}} className="activity-group" role="region" aria-label="Agent activity">
    <Collapsible.Trigger className="activity-summary" title={label}>
      <ToolGlyph kind={classifyTool(currentItem?.data).kind} running={active}/>
      <span>{label}</span><ChevronRight className="tool-chevron" size={12}/></Collapsible.Trigger>
    <Collapsible.Panel className="activity-disclosure"><div id={id} className="activity-details">
      {items.slice(current*40,(current+1)*40).map(item=><ToolCard key={item.id} item={item}/>)}
      {lastPage>0&&<div className="activity-pages"><button disabled={current===0} onClick={()=>changePage(current-1)}>Previous</button><span>{current*40+1}–{Math.min((current+1)*40,items.length)} of {items.length}</span><button disabled={current===lastPage} onClick={()=>changePage(current+1)}>Next</button></div>}
    </div></Collapsible.Panel>
  </Collapsible.Root>;
}
