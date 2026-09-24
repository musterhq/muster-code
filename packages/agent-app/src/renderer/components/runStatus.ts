import type {Chat, ChatStatus, TimelineItem} from '../../shared/protocol';
import {classifyTool} from './toolPresentation.ts';

/** Header status: an open approval or question outranks running; a stall shows Reconnecting; an idle chat with queued follow-ups shows Queued.
 *  Kept in its own non-JSX module so it (and planCardId below) can be unit tested with plain `node --test`, no DOM. */
export function displayStatus(chat:Pick<Chat,'status'|'queue'>,items:readonly TimelineItem[],stalled=false):ChatStatus {
  const live=chat.status==='running'||chat.status==='stopping';
  if(live&&items.some(item=>(item.kind==='approval'||item.kind==='question')&&item.status==='pending'))return 'waiting';
  if(live&&stalled)return 'reconnecting';
  if(!live&&chat.queue?.length&&chat.status!=='failed'&&chat.status!=='interrupted')return 'queued';
  return chat.status;
}

/** Which item (if any) is this Plan-mode chat's Plan card: the latest completed assistant answer, with
 *  no unanswered user message after it. Nothing while a turn is live or outside Plan mode. */
export function planCardId(items:readonly Pick<TimelineItem,'id'|'kind'|'status'>[],planMode:boolean,live:boolean):string|undefined{
  if(!planMode||live)return undefined;
  for(let i=items.length-1;i>=0;i--){
    const item=items[i]!;
    if(item.kind==='user')return undefined;
    if(item.kind==='assistant')return item.status==='completed'?item.id:undefined;
  }
  return undefined;
}

/** The Plan card's actual content: a `plan`-type tool call (Claude's ExitPlanMode, or a native plan
 *  item) carries the drafted plan itself, so it is the plan whenever there is one — the assistant's
 *  closing message is then a note ("confirm to proceed", open questions, caveats) shown under it, unless
 *  it merely repeats the plan. With no plan tool call, the assistant's own text is the plan. */
export function planCardContent(items:readonly Pick<TimelineItem,'id'|'kind'|'text'|'data'>[],anchorId:string):{plan:string;note?:string} {
  let toolPlan='';
  for(let i=items.length-1;i>=0;i--){
    const item=items[i]!;
    if(item.kind==='user')break;
    if(item.kind==='tool'){
      const presentation=classifyTool(item.data);
      // The latest plan tool call in the turn is the one that was submitted.
      if(presentation.plan&&presentation.planText?.trim()){toolPlan=presentation.planText.trim();break;}
    }
  }
  const assistantText=(items.find(item=>item.id===anchorId)?.text??'').trim();
  if(!toolPlan)return {plan:assistantText};
  const squash=(text:string)=>text.replace(/\s+/g,' ').trim().toLowerCase();
  const note=squash(assistantText),plan=squash(toolPlan);
  const trivial=!note||plan.includes(note)||note.includes(plan);
  return trivial?{plan:toolPlan}:{plan:toolPlan,note:assistantText};
}

/** Just the plan text of planCardContent. */
export function planCardText(items:readonly Pick<TimelineItem,'id'|'kind'|'text'|'data'>[],anchorId:string):string {
  return planCardContent(items,anchorId).plan;
}

/** Execute plan: switch the chat to Agent and send the execute prompt as one step. There is no runtime
 *  call that sends with a mode change, so a failed send reverts the mode (the chat must not be left in
 *  Agent mode with nothing running) and returns the error sentence; undefined on success. */
export async function executePlan(deps:{previousMode:'ask'|'plan'|'agent';setMode:(mode:'ask'|'plan'|'agent')=>Promise<unknown>;send:()=>Promise<boolean>;sendError:()=>string|undefined}):Promise<string|undefined> {
  const fallback='The plan could not be started. Try again.';
  try{await deps.setMode('agent');}
  catch(cause){return cause instanceof Error&&cause.message?cause.message:fallback;}
  let error:string|undefined;
  try{if(!(await deps.send()))error=deps.sendError()||fallback;}
  catch(cause){error=cause instanceof Error&&cause.message?cause.message:fallback;}
  if(error&&deps.previousMode!=='agent'){
    try{await deps.setMode(deps.previousMode);}
    catch{error+=' The chat was left in Agent mode.';}
  }
  return error;
}
