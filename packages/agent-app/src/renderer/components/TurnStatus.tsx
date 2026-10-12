import React,{useEffect,useRef,useState} from 'react';
import type {TimelineItem} from '../../shared/protocol';
import {announcements,createThrottledAnnouncer,type AnnounceState} from './turnStatusModel';
import './turn-status.css';

/** Codex text shimmer for live labels; static under reduced motion (CSS). */
export function Shimmer({children,active=true}:{children:React.ReactNode;active?:boolean}) {
  return <span className={active?'shimmer-text':undefined}>{children}</span>;
}

/** Visually hidden, throttled status for screen readers: run start/finish/failure, approvals, new tools. */
export function LiveAnnouncer({status,items}:{status?:string;items:readonly TimelineItem[]}) {
  const [text,setText]=useState('');
  const announcer=useRef<ReturnType<typeof createThrottledAnnouncer>|null>(null),state=useRef<AnnounceState|null>(null);
  useEffect(()=>{const value=createThrottledAnnouncer(setText);announcer.current=value;return()=>{value.dispose();announcer.current=null;};},[]);
  useEffect(()=>{const {messages,next}=announcements(state.current,status,items);state.current=next;for(const message of messages)announcer.current?.push(message);},[status,items]);
  return <div className="turn-live-region" role="status" aria-live="polite" aria-atomic="true">{text}</div>;
}
