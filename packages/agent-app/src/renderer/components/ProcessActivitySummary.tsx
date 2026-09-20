import {ArrowUpRight,Check,CircleDot,CircleHelp,CircleX,Square,SquareTerminal} from 'lucide-react';
import {openProcessesTab} from '../store';
import {refreshProcessSummary,useProcessSummary} from '../processSummary';
import {isActiveProcess} from '../../shared/process-protocol';
import './process-activity-summary.css';

const STATUS={starting:'Starting',running:'Running',stopping:'Stopping',exited:'Finished',failed:'Failed',stopped:'Stopped',lost:'Connection lost'} as const;

/** One overview summary; sidebar consumers share the same metadata subscription. */
export function ProcessActivitySummary({chatId}:{chatId:string}) {
  const {summary,loading,error}=useProcessSummary();
  const rows=(summary?.sessions??[]).filter(session=>session.chatId===chatId);
  const active=rows.filter(session=>isActiveProcess(session.status));
  const attention=rows.filter(session=>session.status==='failed'||session.status==='lost');
  const finished=rows.length-active.length-attention.length;
  const visible=[...active,...attention,...rows.filter(session=>!isActiveProcess(session.status)&&session.status!=='failed'&&session.status!=='lost')].slice(0,3);
  const open=()=>openProcessesTab(chatId,'Local commands');
  return <section className="process-activity-summary" aria-label="Local commands">
    <div className="process-activity-heading"><button onClick={open} aria-label="Open local background commands"><SquareTerminal size={14} aria-hidden="true"/><span>Local commands</span><ArrowUpRight size={12} aria-hidden="true"/></button>
      {!loading&&summary&&<span className="process-activity-count" role="status">{active.length} active{attention.length>0&&<> · <em>{attention.length} need attention</em></>}{finished>0&&<> · {finished} done</>}</span>}
    </div>
    {loading&&<p className="process-activity-note" role="status">Loading command status…</p>}
    {error&&<p className="process-activity-note is-error" role="alert">Command status unavailable. <button onClick={refreshProcessSummary}>Retry</button></p>}
    {!loading&&!error&&rows.length===0&&<p className="process-activity-note">No local commands started.</p>}
    <div className="process-activity-rows">{visible.map(session=>{
      const Icon=session.status==='lost'?CircleHelp:session.status==='failed'?CircleX:session.status==='stopped'?Square:session.status==='exited'?Check:CircleDot;
      return <button key={session.processId} className={`process-activity-row is-${session.status}`} onClick={open} aria-label={`Open local command ${session.label}, ${STATUS[session.status]}`} title={session.label}><Icon size={12} aria-hidden="true"/><span>{session.label}</span><small>{STATUS[session.status]}</small></button>;
    })}</div>
    {rows.length>visible.length&&<button className="process-activity-more" onClick={open}>View all {rows.length} local commands</button>}
  </section>;
}
