import React, {useEffect, useRef, useState} from 'react';
import type {Chat} from '../../shared/protocol';
import {invoke} from '../bridge';
import {sendMessage} from '../store';
import {useStoreSelector} from '../useStore';
import './recovery-notice.css';

/** Checking reads the saved provider attempt; it never sends the message again.
 * Retry is offered only for an admission rejection the runtime classified as
 * retryable, i.e. it proved no turn was dispatched; it resends the retained draft. */
/** While the provider reports the saved turn as active, status is re-read on this cadence until it settles or the cap passes. */
export const RECONCILE_POLL_MS=30_000, RECONCILE_POLL_LIMIT_MS=30*60_000;
export function RecoveryNotice({chat}:{chat:Chat}) {
  const [checking,setChecking]=useState(false),[retrying,setRetrying]=useState(false),[result,setResult]=useState(''),[stillRunning,setStillRunning]=useState(false);
  const pending=useRef(false);
  const uncertain=chat.recovery?.kind==='recovery-needed';
  const rejected=chat.recovery?.kind==='admission-rejected' && chat.recovery.retryable;
  const active=chat.status==='running' || chat.status==='stopping';
  // The composer's live draft, not the last persisted snapshot: sending a stale
  // chat.draft would send old text and then clear the newer composer contents.
  const live=useStoreSelector(state=>state.composerDrafts[chat.id]?.text)??chat.draft;
  const sending=useStoreSelector(state=>!!state.sending[chat.id]);
  const draft=live.trim();
  const check=async()=>{
    if(pending.current)return;
    pending.current=true;setChecking(true);setResult('');
    try {const response=await invoke('chat.reconcile',{id:chat.id});setStillRunning(!!response.stillRunning);setResult(response.stillRunning?'':response.reason);return !!response.stillRunning;}
    catch(error){setStillRunning(false);setResult(error instanceof Error?error.message:'Could not check the provider attempt.');return false;}
    finally {pending.current=false;setChecking(false);}
  };
  // A chat interrupted by a restart checks itself once, when the window has focus.
  const interrupted=uncertain&&chat.status==='interrupted';
  useEffect(()=>{
    if(!interrupted)return;
    let done=false;
    const run=()=>{if(done)return;done=true;window.removeEventListener('focus',run);void check();};
    if(typeof document.hasFocus!=='function'||document.hasFocus())run();else window.addEventListener('focus',run);
    return()=>{done=true;window.removeEventListener('focus',run);};
  },[interrupted]);
  useEffect(()=>{
    if(!stillRunning)return;
    const started=Date.now();
    const timer=setInterval(()=>{if(Date.now()-started>RECONCILE_POLL_LIMIT_MS){clearInterval(timer);setStillRunning(false);setResult('The provider still reports this turn as active after 30 minutes. Check again later.');return;}void check();},RECONCILE_POLL_MS);
    return()=>clearInterval(timer);
  },[stillRunning]);
  const retry=async()=>{
    if(pending.current || !draft)return;
    pending.current=true;setRetrying(true);setResult('');
    try {if(!(await sendMessage(chat.id,live)))setResult('The message was not sent. Your draft is retained; try again.');}
    finally {pending.current=false;setRetrying(false);}
  };
  if(!chat.error && !uncertain && !rejected)return null;
  // PER-08 (F42/F43): a user Stop is a normal ending: a neutral "Stopped" note, never a red failure,
  // and nothing to resolve before sending again (the composer is not blocked for 'cancelled').
  const stopped=chat.recovery?.kind==='cancelled';
  return <div className={interrupted||stopped?'chat-error-banner is-interrupted':'chat-error-banner'} role="status" data-recovery={chat.recovery?.kind}>
    <span>{stillRunning?'Still running at the provider. This updates when it finishes.':chat.recovery?.reason || chat.error}</span>
    {uncertain && <><p>Your draft is retained. Check the existing attempt before sending again.</p><button type="button" className="workspace-inline-link" disabled={checking || active} onClick={()=>void check()}>{checking?'Checking provider status…':stillRunning?'Check now':'Check provider status'}</button></>}
    {rejected && <><p>{draft?'No turn was dispatched; your draft is retained.':'No turn was dispatched. Write a message to retry.'}</p><button type="button" className="workspace-inline-link" aria-busy={retrying||undefined} disabled={retrying || sending || active || !draft} onClick={()=>void retry()}>{retrying?'Retrying…':'Retry now'}</button></>}
    {result && <p>{result}</p>}
  </div>;
}
