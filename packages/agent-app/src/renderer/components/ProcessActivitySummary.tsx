import {ArrowUpRight,Check,CircleDot,CircleHelp,CircleX,Square,SquareTerminal} from 'lucide-react';
import {useMemo} from 'react';
import {useStoreSelector} from '../useStore';
import {agentCommands,refreshProcessSummary,useProcessSummary} from '../processSummary';
import {openTerminalTab} from './ProcessesTab';
import {isActiveProcess} from '../../shared/process-protocol';
import './process-activity-summary.css';
import { ResourceState } from './ResourceState';

const STATUS={starting:'Starting',running:'Running',stopping:'Stopping',exited:'Finished',failed:'Failed',stopped:'Stopped',lost:'Connection lost'} as const;

/** One overview summary; sidebar consumers share the same metadata subscription.
 * The agent's running commands (RUN-X2) come from this chat's live timeline. */
export function ProcessActivitySummary({chatId}:{chatId:string}) {
  const {summary,loading,error}=useProcessSummary();
  const title=useStoreSelector(state=>state.snapshot?.chats.find(chat=>chat.id===chatId)?.title)||'Conversation';
  const items=useStoreSelector(state=>state.timelines[chatId]?.value);
  const agent=useMemo(()=>agentCommands(items).filter(row=>row.running),[items]);
  const rows=(summary?.sessions??[]).filter(session=>session.chatId===chatId);
  const active=rows.filter(session=>isActiveProcess(session.status));
  const attention=rows.filter(session=>session.status==='failed'||session.status==='lost');
  const finished=rows.length-active.length-attention.length;
  const visible=[...active,...attention,...rows.filter(session=>!isActiveProcess(session.status)&&session.status!=='failed'&&session.status!=='lost')].slice(0,3);
  const open=()=>openTerminalTab(chatId,title,'commands');
  return <section className="process-activity-summary" aria-label="Terminal and commands">
    <div className="process-activity-heading"><button onClick={()=>openTerminalTab(chatId,title)} aria-label="Open Terminal"><SquareTerminal size={14} aria-hidden="true"/><span>Terminal</span><ArrowUpRight size={12} aria-hidden="true"/></button>
      {!loading&&summary&&<span className="process-activity-count" role="status">{active.length+agent.length} active{attention.length>0&&<> · <em>{attention.length} need attention</em></>}{finished>0&&<> · {finished} done</>}</span>}
    </div>
    {loading&&<ResourceState kind="loading" compact label="Loading command status" rows={2}/>}
    {error&&<ResourceState kind="error" compact message="Command status unavailable." onRetry={refreshProcessSummary}/>}
    {!loading&&!error&&rows.length===0&&!agent.length&&<p className="process-activity-note">No background commands running.</p>}
    <div className="process-activity-rows">{agent.slice(0,3).map(row=><button key={row.item.id} className="process-activity-row is-running" onClick={()=>openTerminalTab(chatId,title,'agent')} aria-label={`Open agent command ${row.command}, running`} title={row.command}><CircleDot size={12} aria-hidden="true"/><span>{row.command}</span><small>Agent · Running</small></button>)}{visible.map(session=>{
      const Icon=session.status==='lost'?CircleHelp:session.status==='failed'?CircleX:session.status==='stopped'?Square:session.status==='exited'?Check:CircleDot;
      return <button key={session.processId} className={`process-activity-row is-${session.status}`} onClick={open} aria-label={`Open local command ${session.label}, ${STATUS[session.status]}`} title={session.label}><Icon size={12} aria-hidden="true"/><span>{session.label}</span><small>You · {STATUS[session.status]}</small></button>;
    })}</div>
    {rows.length>visible.length&&<button className="process-activity-more" onClick={open}>View all {rows.length} background commands</button>}
  </section>;
}
