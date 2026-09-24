import React,{useEffect,useMemo,useState} from 'react';
import {Archive,ListChecks,Play,WifiOff} from 'lucide-react';
import type {TimelineItem} from '../../shared/protocol';
import {invoke} from '../bridge';
import {getState,sendMessage} from '../store';
import {useStoreSelector} from '../useStore';
import {MessageBody} from './MessageBody';
import {executePlan,planCardContent} from './runStatus';
import './run-states.css';
export {displayStatus, planCardId} from './runStatus';

/** Mid-stream silence longer than this while text is streaming reads as a transport stall. */
export const STALL_MS=5_000;
export const EXECUTE_PLAN_PROMPT='Execute the plan above.';

/** True while a running chat's streaming text has not advanced for STALL_MS. Tools and open requests may be silent legitimately. */
export function useTransportStall(items:readonly TimelineItem[],running:boolean):boolean {
  const last=items.at(-1);
  const streaming=running&&!!last&&(last.kind==='assistant'||last.kind==='reasoning')&&last.status==='running';
  const key=`${last?.id}:${last?.text.length}`;
  const [stalled,setStalled]=useState(false);
  useEffect(()=>{setStalled(false);if(!streaming)return;const timer=setTimeout(()=>setStalled(true),STALL_MS);return()=>clearTimeout(timer);},[streaming,key]);
  return streaming&&stalled;
}

export function ReconnectingPill():React.ReactElement {
  return <span className="reconnecting-pill" role="status"><WifiOff size={12} aria-hidden="true"/>Reconnecting…</span>;
}

/** Inline compaction row (Codex: "Context automatically compacted"); a manual compaction shows intent, completion or failure. */
export function CompactionRow({item}:{item:TimelineItem}):React.ReactElement {
  const failed=item.status==='failed',running=item.status==='running';
  // Codex: a quiet one-liner ("Context automatically compacted") with a thin glyph; the detail is a tooltip.
  return <div className={`compaction-row${failed?' is-failed':''}`} role="status" title={!running&&!failed?'Earlier turns were summarized for the model; this transcript is unchanged.':undefined}>
    <span className="tool-glyph" aria-hidden="true"><Archive size={15} strokeWidth={1.6}/></span>
    <span className="compaction-label">{item.text}</span>
  </div>;
}

/** Execute-plan failures by card, so the message survives the card unmounting and remounting while the
 *  mode flips to Agent and back. */
const planErrors=new Map<string,string>();

/** Plan-mode result: the plan, then Execute plan switches the chat to Agent and asks it to carry the plan out.
 *  The anchor item is the turn's last completed assistant message, but the real plan text often lives in a
 *  preceding `plan` tool call (Claude's ExitPlanMode) instead — that is the plan, with a non-trivial
 *  assistant note shown under it. A failed send reverts the mode and keeps its error on the card. */
export function PlanCard({item}:{item:TimelineItem}):React.ReactElement {
  const items=useStoreSelector(state=>state.timelines[item.chatId]?.value);
  const mode=useStoreSelector(state=>state.snapshot?.chats.find(chat=>chat.id===item.chatId)?.mode);
  const content=useMemo(()=>items?planCardContent(items,item.id):{plan:item.text.trim()},[items,item.id,item.text]);
  const text=content.plan;
  const empty=!text.trim();
  const [busy,setBusy]=useState(false),[error,setErrorState]=useState(()=>planErrors.get(item.id)??'');
  const setError=(value:string)=>{if(value)planErrors.set(item.id,value);else planErrors.delete(item.id);setErrorState(value);};
  const execute=async()=>{
    if(busy||empty)return;setBusy(true);setError('');
    const failure=await executePlan({
      previousMode:mode??'plan',
      setMode:next=>invoke('chat.update',{id:item.chatId,mode:next}),
      send:()=>sendMessage(item.chatId,EXECUTE_PLAN_PROMPT),
      sendError:()=>getState().sendErrors[item.chatId],
    });
    if(failure)planErrors.set(item.id,failure);
    // The card may have unmounted (mode flipped to Agent); a remount reads planErrors.
    setError(failure??'');setBusy(false);
  };
  return <section className="plan-card" id={`plan-card-${item.chatId}`} tabIndex={-1} aria-label="Plan">
    <header><ListChecks size={14} aria-hidden="true"/><strong>Plan</strong></header>
    <div className="plan-card-body">{empty?<p className="plan-card-empty">No plan text was returned for this turn.</p>:<MessageBody text={text}/>}</div>
    {content.note&&<div className="plan-card-note"><MessageBody text={content.note}/></div>}
    <footer>
      <button type="button" className="plan-card-execute" disabled={busy||empty} aria-busy={busy||undefined} title={empty?'There is no plan to execute yet.':undefined} onClick={()=>void execute()}><Play size={12} aria-hidden="true"/>{busy?'Starting…':'Execute plan'}</button>
      <span>Switches this chat to Agent mode and runs the plan.</span>
    </footer>
    {error&&<p className="plan-card-error" role="alert">{error}</p>}
  </section>;
}
