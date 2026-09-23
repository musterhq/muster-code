import React,{useEffect,useRef,useState} from 'react';
import {ChevronRight} from 'lucide-react';
import type {TimelineItem} from '../../shared/protocol';
import {announcements,createThrottledAnnouncer,formatDuration,retryLabel,tailStatus,time,type AnnounceState} from './turnStatusModel';
import './turn-status.css';

/** Codex text shimmer for live labels; static under reduced motion (CSS). */
export function Shimmer({children,active=true}:{children:React.ReactNode;active?:boolean}) {
  return <span className={active?'shimmer-text':undefined}>{children}</span>;
}

/** A 1s clock that ticks only while the element is on screen and the window is visible. */
export function useVisibleNow(ref:React.RefObject<HTMLElement|null>,active=true):number {
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{
    if(!active)return;
    let timer:number|undefined,onScreen=true;
    const tick=()=>setNow(Date.now());
    const sync=()=>{const run=onScreen&&document.visibilityState!=='hidden';if(run&&timer===undefined){tick();timer=window.setInterval(tick,1000);}else if(!run&&timer!==undefined){clearInterval(timer);timer=undefined;}};
    const observer=typeof IntersectionObserver==='function'&&ref.current?new IntersectionObserver(entries=>{onScreen=entries.at(-1)?.isIntersecting??true;sync();}):null;
    if(observer&&ref.current)observer.observe(ref.current);
    document.addEventListener('visibilitychange',sync);sync();
    return()=>{observer?.disconnect();document.removeEventListener('visibilitychange',sync);if(timer!==undefined)clearInterval(timer);};
  },[active,ref]);
  return now;
}

/** Transcript tail while a run is live: what the agent is doing now ("Thinking", "Running npm test"). The elapsed time sits in the turn's "Working for" header. */
export function WorkingTail({items}:{items:readonly TimelineItem[]}) {
  const status=tailStatus(items);
  // A streaming reasoning row already says "Thinking" (and expands); the tail does not repeat it.
  const last=items.at(-1),quiet=last?.kind==='reasoning'&&last.status==='running'&&!!last.text.trim();
  return <div className={`working-tail is-${status.kind}`}>
    {!quiet&&<WorkingLabel status={status}/>}
  </div>;
}
function WorkingLabel({status}:{status:ReturnType<typeof tailStatus>}) {
  const ref=useRef<HTMLSpanElement>(null),now=useVisibleNow(ref,status.kind==='retry');
  const label=status.kind==='retry'?retryLabel(status.retryAt,now):status.label;
  return <span ref={ref}><Shimmer active={status.kind!=='approval'}>{label}</Shimmer></span>;
}

/** Live turn header (Codex "Working for 11m 31s" with a rule): ticks while on screen. */
export function LiveTurnHeader({since}:{since:string}) {
  const ref=useRef<HTMLDivElement>(null),now=useVisibleNow(ref),start=time(since);
  return <div ref={ref} className="turn-worked is-live" role="status">
    <span>Working for {formatDuration(Number.isFinite(start)?Math.max(0,now-start):0)}</span>
  </div>;
}

/** "Worked for 26s ›": folds a completed turn's activity and reasoning. Folded, it says what the work was. */
export function TurnHeader({durationMs,open,onToggle,summary}:{durationMs:number|null;open:boolean;onToggle:()=>void;summary?:string}) {
  return <button type="button" className="turn-worked" aria-expanded={open} title={open?'Hide this turn’s activity':'Show this turn’s activity'} onClick={onToggle}>
    <span>{durationMs!=null?`Worked for ${formatDuration(durationMs)}`:'Worked'}</span>
    {!open&&summary&&<span className="turn-worked-summary"> · {summary}</span>}
    <ChevronRight className="turn-worked-chevron" size={12} aria-hidden="true"/>
  </button>;
}

/** Visually hidden, throttled status for screen readers: run start/finish/failure, approvals, new tools. */
export function LiveAnnouncer({status,items}:{status?:string;items:readonly TimelineItem[]}) {
  const [text,setText]=useState('');
  const announcer=useRef<ReturnType<typeof createThrottledAnnouncer>|null>(null),state=useRef<AnnounceState|null>(null);
  useEffect(()=>{const value=createThrottledAnnouncer(setText);announcer.current=value;return()=>{value.dispose();announcer.current=null;};},[]);
  useEffect(()=>{const {messages,next}=announcements(state.current,status,items);state.current=next;for(const message of messages)announcer.current?.push(message);},[status,items]);
  return <div className="turn-live-region" role="status" aria-live="polite" aria-atomic="true">{text}</div>;
}
