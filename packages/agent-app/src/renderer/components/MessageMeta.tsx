import React,{memo,useEffect,useMemo,useRef,useState} from 'react';
import {Check,Copy,LoaderCircle,TriangleAlert} from 'lucide-react';
import {copyText} from '../clipboard';
import './message-meta.css';

const clock=new Intl.DateTimeFormat(undefined,{hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const fullDate=new Intl.DateTimeFormat(undefined,{dateStyle:'full',timeStyle:'long'});
export const MessageMeta=memo(function MessageMeta({text,createdAt,label='Copy message'}:{text:string;createdAt:string;label?:string}) {
  const [status,setStatus]=useState<'idle'|'pending'|'copied'|'error'>('idle');
  const alive=useRef(true),pending=useRef(false),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const stamp=useMemo(()=>{const date=new Date(createdAt);return Number.isNaN(date.getTime())?null:{iso:date.toISOString(),clock:clock.format(date),full:fullDate.format(date)};},[createdAt]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;clearTimeout(timer.current);};},[]);
  const copy=async()=>{
    if(pending.current)return;
    pending.current=true;clearTimeout(timer.current);setStatus('pending');
    try {await copyText(text);if(alive.current)setStatus('copied');}
    catch {if(alive.current)setStatus('error');}
    finally {pending.current=false;if(alive.current)timer.current=setTimeout(()=>setStatus('idle'),2000);}
  };
  const feedback=status==='copied'?'Copied':status==='error'?'Could not copy. Try again.':status==='pending'?'Copying…':'';
  return <div className="message-meta" data-feedback={status==='copied'||status==='error'?true:undefined}>
    {stamp&&<time dateTime={stamp.iso} title={stamp.full} aria-label={stamp.full}>{stamp.clock}</time>}
    <button type="button" className="message-copy" aria-label={status==='copied'?`${label} — copied`:label} title={feedback||label} disabled={status==='pending'} onClick={()=>void copy()}>
      {status==='copied'?<Check size={13}/>:status==='error'?<TriangleAlert size={13}/>:status==='pending'?<LoaderCircle size={13}/>:<Copy size={13}/>} 
    </button>
    <span className="message-copy-feedback" role="status" aria-live="polite">{feedback}</span>
  </div>;
});
