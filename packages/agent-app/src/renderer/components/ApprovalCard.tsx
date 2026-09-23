import React,{useState} from 'react';
import {Check,CheckCheck,FileDiff,SquareTerminal,Wrench,X} from 'lucide-react';
import type {ApprovalData,ApprovalDecision,TimelineItem} from '../../shared/protocol';
import {invoke} from '../bridge';
import {InlineDiff} from './InlineDiff';
import './approval-card.css';

/** Readable outcome for a settled approval; unknown statuses fall back to a neutral label. */
export const APPROVAL_OUTCOME:Record<string,string>={
  approved:'Approved',
  'approved-session':'Approved for this session',
  declined:'Denied',
  expired:'Expired · no longer pending',
  interrupted:'Interrupted · the run stopped before a decision',
  unavailable:'Expired · reopen not possible',
};
export function approvalData(item:TimelineItem):ApprovalData {
  const data=(item.data??{}) as Partial<ApprovalData>;
  const method=typeof data.method==='string'?data.method:'';
  return {method,kind:data.kind??(method.includes('fileChange')?'fileChange':'command'),...data} as ApprovalData;
}
const TITLE={command:'Run this command?',fileChange:'Apply these file changes?',mcp:'Allow this tool call?'} as const;
const ICON={command:SquareTerminal,fileChange:FileDiff,mcp:Wrench} as const;

export function ApprovalCard({item}:{item:TimelineItem}):React.ReactElement {
  const data=approvalData(item),Icon=ICON[data.kind];
  const [busy,setBusy]=useState<ApprovalDecision|null>(null),[error,setError]=useState('');
  const pending=item.status==='pending';
  const respond=async(decision:ApprovalDecision)=>{
    if(busy)return;setBusy(decision);setError('');
    try{await invoke('approval.respond',{id:item.id,approved:decision!=='decline',decision});}
    catch(cause){setBusy(null);setError(cause instanceof Error?cause.message:'The decision was not accepted.');}
  };
  const restart=data.expiredReason==='restart';
  const outcome=restart?'Expired · reopen not possible':APPROVAL_OUTCOME[item.status??'']??(item.status??'Closed');
  return <div className={`approval-card${pending?'':' is-settled'}`} role="group" aria-label={TITLE[data.kind]}>
    <div className="approval-head"><Icon size={14} aria-hidden="true"/><strong>{TITLE[data.kind]}</strong>{data.kind==='mcp'&&data.server&&<span className="approval-origin">{data.server}</span>}</div>
    {data.reason&&<p className="approval-reason">{data.reason}</p>}
    {data.kind==='command'&&(data.command
      ?<div className="approval-command">{data.cwd&&<div className="approval-cwd" title={data.cwd}>{data.cwd}</div>}<pre><code>$ {data.command}</code></pre></div>
      :<div className="approval-text">{item.text}</div>)}
    {data.kind==='fileChange'&&(data.diff?.length
      ?<div className="approval-diffs">{data.diff.map(change=><div key={change.path} className="approval-diff"><div className="approval-diff-path" title={change.path}>{change.kind&&<span>{change.kind}</span>}{change.path}</div>{change.diff?<InlineDiff text={change.diff} path={change.path} maxRows={200}/>:<p className="approval-reason">No diff preview from the provider.</p>}</div>)}</div>
      :<div className="approval-text">{item.text}</div>)}
    {data.kind==='mcp'&&<div className="approval-command"><div className="approval-cwd">{data.tool??item.text}</div>{data.args&&<pre><code>{data.args}</code></pre>}</div>}
    {pending?<div className="approval-actions">
      <button type="button" className="approval-approve" disabled={!!busy} aria-busy={busy==='accept'||undefined} onClick={()=>void respond('accept')}><Check size={13} aria-hidden="true"/> Approve</button>
      <button type="button" className="approval-approve" disabled={!!busy} aria-busy={busy==='acceptForSession'||undefined} onClick={()=>void respond('acceptForSession')} title="Don’t ask again for this in the current provider session"><CheckCheck size={13} aria-hidden="true"/> Approve for this session</button>
      <button type="button" className="approval-deny" disabled={!!busy} aria-busy={busy==='decline'||undefined} onClick={()=>void respond('decline')}><X size={13} aria-hidden="true"/> Deny</button>
    </div>:<div className="approval-resolved" role="status">{outcome}</div>}
    {restart&&!pending&&<p className="approval-reason">Muster restarted while this request was open, so the provider stopped waiting for it.</p>}
    {error&&<p className="approval-error" role="alert">{error}</p>}
  </div>;
}
