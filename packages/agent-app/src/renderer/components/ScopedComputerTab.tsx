import React,{useEffect,useRef,useState} from 'react';
import {Monitor,Play,RefreshCw,Square,Trash2} from 'lucide-react';
import type {ScopedComputerRef,ScopedComputerStatus,ScopedComputerExecution} from '../../shared/scoped-computer-protocol';
import {invoke} from '../bridge';
import './scoped-computer.css';

export function ScopedComputerTab({scope}:{scope:ScopedComputerRef}) {
  const [computer,setComputer]=useState<ScopedComputerStatus>(),[execution,setExecution]=useState<ScopedComputerExecution>();
  const [command,setCommand]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[remove,setRemove]=useState(false),[refreshVersion,setRefreshVersion]=useState(0);
  const alive=useRef(true),pending=useRef(false),request=useRef<{text:string;id:string}|undefined>(undefined);
  const scopeKey=`${scope.kind}:${scope.id}`;
  const refresh=async()=>{try{const value=await invoke('computer.inspect',{scope});if(alive.current)setComputer(value);}catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:String(cause));}};
  useEffect(()=>{alive.current=true;void refresh();return()=>{alive.current=false;};},[scopeKey]);
  const executionId=execution?.state==='running'?execution.executionId:computer?.activeExecutionId;
  useEffect(()=>{
    if(!executionId)return;
    let cancelled=false,timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      try{
        const value=await invoke('computer.execution',{scope,executionId});
        if(cancelled)return;setExecution(value);
        if(value.state==='running')timer=setTimeout(()=>void poll(),1000);
        else void refresh();
      }catch(cause){if(!cancelled)setError(cause instanceof Error?cause.message:String(cause));}
    };
    void poll();return()=>{cancelled=true;clearTimeout(timer);};
  },[scopeKey,executionId,refreshVersion]);
  const action=async(kind:'start'|'stop'|'destroy')=>{
    if(pending.current)return;pending.current=true;setBusy(true);setError('');
    try{const value=await invoke(`computer.${kind}`,{scope});if(alive.current){setComputer(value);setRemove(false);}}
    catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:String(cause));}
    finally{pending.current=false;if(alive.current)setBusy(false);}
  };
  const run=async()=>{
    if(pending.current||!command.trim()||executionId)return;
    pending.current=true;setBusy(true);setError('');
    const submitted=command;
    if(request.current?.text!==submitted)request.current={text:submitted,id:crypto.randomUUID()};
    try{
      const started=await invoke('computer.exec',{scope,command:submitted,requestId:request.current.id,timeoutMs:60000});
      if(alive.current){setExecution({executionId:started.executionId,computerId:computer?.id??'',state:'running',stdout:'',stderr:'',stdoutTruncated:false,stderrTruncated:false,exitCode:null,computerStopped:false});request.current=undefined;}
    }catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:String(cause));}
    finally{pending.current=false;if(alive.current)setBusy(false);}
  };
  const cancel=async()=>{
    if(pending.current||!executionId)return;pending.current=true;setBusy(true);setError('');
    try{const value=await invoke('computer.cancel',{scope,executionId});if(alive.current){setExecution(value);void refresh();}}
    catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:String(cause));}
    finally{pending.current=false;if(alive.current)setBusy(false);}
  };
  return <section className="scoped-computer" aria-label="Scoped local computer">
    <header><Monitor size={18}/><div><h2>{computer?.label??'Scoped computer'}</h2><p>Local Linux container · isolated workspace</p></div><button className="icon-button" aria-label="Refresh computer status" disabled={busy} onClick={()=>{setRefreshVersion(version=>version+1);void refresh();}}><RefreshCw size={14}/></button></header>
    <div className="computer-status" role="status">{computer?computer.state.replaceAll('-',' '):'Checking local computer…'}</div>
    {computer?.reason&&<p className="computer-note">{computer.reason}</p>}
    <p className="computer-note">512 MiB memory · 1 CPU · no network · workspace retained when stopped</p>
    <div className="computer-actions">
      <button disabled={busy||!!executionId||computer?.state==='running'} onClick={()=>void action('start')}><Play size={13}/>{computer?.state==='stopped'?'Start again':'Start computer'}</button>
      <button disabled={busy||!computer||['not-created','unavailable','stopped'].includes(computer.state)} onClick={()=>void action('stop')}><Square size={13}/>Stop computer</button>
      <button disabled={busy||!!executionId||!computer||computer.state==='not-created'} onClick={()=>setRemove(true)}><Trash2 size={13}/>Remove container</button>
    </div>
    {remove&&<div className="computer-remove" role="group" aria-label="Confirm container removal"><p>Remove this scope’s container? Its workspace files will remain on this Mac.</p><button disabled={busy} onClick={()=>void action('destroy')}>Remove container</button><button disabled={busy} onClick={()=>setRemove(false)}>Cancel</button></div>}
    <label className="computer-command">Run in this computer<textarea aria-label="Scoped command" placeholder="For example: node --version" value={command} onChange={event=>setCommand(event.target.value)} spellCheck={false}/></label>
    <div className="computer-actions"><button disabled={busy||computer?.state!=='running'||!!executionId||!command.trim()} onClick={()=>void run()}><Play size={13}/>Run command</button>{executionId&&<button disabled={busy} onClick={()=>void cancel()}><Square size={13}/>Cancel and stop computer</button>}</div>
    <p className="computer-note">Commands have a 60-second limit here. Cancellation or timeout stops this entire scoped computer; files are retained.</p>
    {error&&<p className="computer-error" role="alert">{error}</p>}
    {execution&&<section className="computer-output" aria-label="Scoped command result"><header>{execution.state.replaceAll('-',' ')}{execution.exitCode!==null?` · exit ${execution.exitCode}`:''}</header>{execution.reason&&<p>{execution.reason}</p>}<pre>{execution.stdout}{execution.stderr?`\n${execution.stderr}`:''}</pre>{(execution.stdoutTruncated||execution.stderrTruncated)&&<p>Output was truncated to its capture limit.</p>}</section>}
  </section>;
}
