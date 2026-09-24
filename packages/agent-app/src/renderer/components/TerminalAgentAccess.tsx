import React,{useEffect,useState} from 'react';
import {Eye,EyeOff} from 'lucide-react';
import {invoke,subscribe} from '../bridge';
import {Tip} from './Tooltip';

/** C3.b4 / CR-19: explicit per-chat consent for the agent's read-only, redacted `read_thread_terminal` tool. Off by default. */
export function TerminalAgentAccess({chatId}:{chatId:string}):React.ReactElement {
  const [allowed,setAllowed]=useState(false);
  const [busy,setBusy]=useState(false);
  useEffect(()=>{
    let live=true;
    void invoke('terminalAccess.get',{chatId}).then(access=>{if(live)setAllowed(access?.allowed===true);},()=>{});
    const off=subscribe(event=>{if(event?.type==='terminalAccessChanged'&&event.access?.chatId===chatId)setAllowed(event.access.allowed);});
    return ()=>{live=false;off();};
  },[chatId]);
  const toggle=async()=>{
    setBusy(true);
    try{setAllowed((await invoke('terminalAccess.set',{chatId,allowed:!allowed}))?.allowed===true);}catch{/* keep the shown state */}finally{setBusy(false);}
  };
  const label=allowed?'Stop letting the agent read this chat’s terminal':'Let the agent read this chat’s terminal';
  return <Tip label={allowed?'The agent can read this chat’s terminal output (read-only, secrets redacted). Click to revoke.':'Let the agent read this chat’s terminal output from its next turn (read-only, secrets redacted).'}><button type="button" className={`terminal-tool${allowed?' is-on':''}`} aria-pressed={allowed} aria-label={label} disabled={busy}
   
    onClick={()=>void toggle()}>{allowed?<Eye size={13}/>:<EyeOff size={13}/>}</button></Tip>;
}
