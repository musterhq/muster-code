import React,{memo,useLayoutEffect,useRef,useState} from 'react';
import {ArrowDown,ChevronUp,ChevronDown,Undo2,Search,ChevronLeft,ChevronRight,X} from 'lucide-react';
import {railWindow,type TurnSummary} from './timeline-navigation-model';
import './timeline-navigation.css';

export const TimelineNavigation=memo(function TimelineNavigation({turns,currentId,canGoBack,onTurn,onBack,onLatest,searchQuery,onSearch,searchCount,searchIndex,onSearchStep}:{
  turns:readonly TurnSummary[];currentId?:string;canGoBack:boolean;
  onTurn:(id:string)=>void;onBack:()=>void;onLatest:()=>void;
  searchQuery?:string;onSearch?:(query:string)=>void;searchCount?:number;searchIndex?:number;onSearchStep?:(direction:1|-1)=>void;
}){
  const [focused,setFocused]=useState<string>(),[hovered,setHovered]=useState<string>(),[dismissed,setDismissed]=useState(false);
  const [windowFocus,setWindowFocus]=useState<string>();
  const buttons=useRef(new Map<string,HTMLButtonElement>()),focusNext=useRef<string|undefined>(undefined);
  const currentIndex=Math.max(0,turns.findIndex(turn=>turn.id===currentId));
  const focusIndex=turns.findIndex(turn=>turn.id===(focused??windowFocus));
  const index=focusIndex<0?currentIndex:focusIndex;
  const {start,end}=railWindow(turns.length,index);
  const preview=dismissed?undefined:turns.find(turn=>turn.id===(hovered??focused));
  useLayoutEffect(()=>{if(focusNext.current){buttons.current.get(focusNext.current)?.focus({preventScroll:true});focusNext.current=undefined;}},[start,end,focused]);
  const focus=(next:number)=>{const turn=turns[Math.max(0,Math.min(turns.length-1,next))];if(!turn)return;focusNext.current=turn.id;setFocused(turn.id);setWindowFocus(turn.id);setHovered(undefined);setDismissed(false);};
  const keyboard=(event:React.KeyboardEvent,index:number)=>{
    const next=event.key==='ArrowDown'?index+1:event.key==='ArrowUp'?index-1:event.key==='Home'?0:event.key==='End'?turns.length-1:event.key==='PageDown'?index+20:event.key==='PageUp'?index-20:undefined;
    if(next!==undefined){event.preventDefault();focus(next);}
  };
  if(!turns.length&&!onSearch)return null;
  return <nav className="turn-navigation" aria-label="Conversation turns" onKeyDown={event=>{if(event.key==='Escape'){setDismissed(true);setHovered(undefined);}}} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget)){setFocused(undefined);setWindowFocus(undefined);}}} onMouseLeave={()=>setHovered(undefined)}>
    {onSearch&&<div className="timeline-search">
      <label className="timeline-search-field"><Search size={13}/><input aria-label="Find in conversation" type="search" value={searchQuery??''} placeholder="Find" onChange={event=>onSearch(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();onSearchStep?.(event.shiftKey?-1:1);}if(event.key==='Escape'){event.preventDefault();onSearch('');event.currentTarget.blur();}}}/></label>
      {!!searchQuery&&<><span className="timeline-search-count" aria-live="polite">{searchCount?`${(searchIndex??-1)+1} of ${searchCount}`:'No matches'}</span><button type="button" aria-label="Previous match" title="Previous match" disabled={!searchCount} onClick={()=>onSearchStep?.(-1)}><ChevronLeft size={13}/></button><button type="button" aria-label="Next match" title="Next match" disabled={!searchCount} onClick={()=>onSearchStep?.(1)}><ChevronRight size={13}/></button><button type="button" aria-label="Clear search" title="Clear search" onClick={()=>onSearch('')}><X size={12}/></button></>}
    </div>}
    <div className="turn-rail">
      {start>0&&<button type="button" className="turn-page" aria-label="Earlier conversation turns" onClick={()=>focus(Math.max(0,start-1))}><ChevronUp size={12}/></button>}
      {turns.slice(start,end).map((turn,offset)=>{const turnIndex=start+offset;return <button type="button" key={turn.id} ref={node=>{if(node)buttons.current.set(turn.id,node);else buttons.current.delete(turn.id);}}
        className={`turn-tick${currentId===turn.id?' is-current':''}`} aria-label={`Turn ${turnIndex+1}: ${turn.prompt||'User message'}`} aria-current={currentId===turn.id?'location':undefined}
        aria-describedby={preview?.id===turn.id?'turn-navigation-preview':undefined} tabIndex={turnIndex===index?0:-1}
        onFocus={()=>{setFocused(turn.id);setHovered(undefined);setDismissed(false);}} onMouseEnter={()=>{setHovered(turn.id);setDismissed(false);}}
        onKeyDown={event=>keyboard(event,turnIndex)} onClick={()=>onTurn(turn.id)}><span aria-hidden="true"/></button>;})}
      {end<turns.length&&<button type="button" className="turn-page" aria-label="Later conversation turns" onClick={()=>focus(end)}><ChevronDown size={12}/></button>}
    </div>
    <div className="turn-navigation-actions">
      <button type="button" disabled={!canGoBack} onClick={onBack} aria-label="Back to previous reading position" title="Previous reading position"><Undo2 size={13}/></button>
      <button type="button" onClick={onLatest} aria-label="Go to latest conversation activity" title="Latest activity"><ArrowDown size={13}/></button>
    </div>
    {preview&&<div id="turn-navigation-preview" role="tooltip" className="turn-preview" data-native-preview-overlay><div className="turn-preview-label">Turn {turns.indexOf(preview)+1} · loaded conversation</div><p className="turn-preview-user">{preview.prompt||'User message'}</p><p>{preview.response||'No assistant prose in this turn yet.'}</p><span>Click or press Enter to jump</span></div>}
  </nav>;
});
