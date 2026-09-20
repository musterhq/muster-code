import React, {useRef, useState} from 'react';
import type {Chat} from '../../shared/protocol';
import {invoke} from '../bridge';

/** Checking reads the saved provider attempt; it never sends the message again. */
export function RecoveryNotice({chat}:{chat:Chat}) {
  const [checking,setChecking]=useState(false),[result,setResult]=useState('');
  const pending=useRef(false);
  const uncertain=chat.recovery?.kind==='recovery-needed';
  const check=async()=>{
    if(pending.current)return;
    pending.current=true;setChecking(true);setResult('');
    try {const response=await invoke('chat.reconcile',{id:chat.id});setResult(response.reason);}
    catch(error){setResult(error instanceof Error?error.message:'Could not check the provider attempt.');}
    finally {pending.current=false;setChecking(false);}
  };
  if(!chat.error && !uncertain)return null;
  return <div className="chat-error-banner" role="status">
    <span>{chat.recovery?.reason || chat.error}</span>
    {uncertain && <><p>Your draft is retained. Check the existing attempt before sending again.</p><button type="button" className="workspace-inline-link" disabled={checking || chat.status==='running' || chat.status==='stopping'} onClick={()=>void check()}>{checking?'Checking provider status…':'Check provider status'}</button></>}
    {result && <p>{result}</p>}
  </div>;
}
