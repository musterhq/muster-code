/**
 * #829 part 3: office previews refresh by themselves. A preview (an office_render result in the chat, the file viewer's
 * office reader) asks the runtime to watch its file only while it is on screen and the window is showing; the runtime
 * debounces changes and says when the file changed (office_render results are re-rendered there first). The preview
 * then redraws in place and says "Updated just now"; a failed refresh keeps the last pages and shows why.
 */
import React,{useEffect,useRef,useState} from 'react';
import {invoke,subscribe} from './bridge';
import {usePageVisible} from './pageVisibility';
import type {OfficeLiveSource} from '../shared/domains/office-protocol';

export type OfficeLiveStatus={phase:'idle'}|{phase:'updating'}|{phase:'updated';at:number}|{phase:'failed';error:string};

/** True while the element is in the viewport (always, without IntersectionObserver). */
function useOnScreen(ref:React.RefObject<Element|null>,enabled:boolean):boolean {
  const [visible,setVisible]=useState(typeof IntersectionObserver==='undefined');
  useEffect(()=>{
    const element=ref.current;
    if(!enabled||!element||typeof IntersectionObserver==='undefined'){setVisible(typeof IntersectionObserver==='undefined');return;}
    const observer=new IntersectionObserver(entries=>{const entry=entries.at(-1);if(entry)setVisible(entry.isIntersecting);});
    observer.observe(element);
    return()=>observer.disconnect();
  },[ref,enabled]);
  return visible;
}

/** Two mounts of one preview (a row's collapsed and open views) share one watch. */
const watchers=new Map<string,number>();
function retain(id:string,source:OfficeLiveSource,since:number|undefined):Promise<{version:number}|undefined> {
  const count=watchers.get(id)??0;watchers.set(id,count+1);
  if(count)return Promise.resolve(undefined);
  return invoke('office.live.watch',{id,source,...(since===undefined?{}:{since})}).catch(()=>undefined);
}
function release(id:string):void {
  const count=(watchers.get(id)??0)-1;
  if(count>0){watchers.set(id,count);return;}
  watchers.delete(id);
  void invoke('office.live.unwatch',{id}).catch(()=>undefined);
}

/**
 * Watches `source` while `ref` is on screen. `onUpdated` redraws the preview; it runs for each refresh, never two at
 * once, and a throw shows as the failure (the preview keeps what it showed). `since`: when the shown pages were made.
 */
export function useOfficeLive(ref:React.RefObject<Element|null>,id:string|null,source:OfficeLiveSource|null,since:number|undefined,onUpdated:(version:number)=>Promise<void>|void):OfficeLiveStatus {
  const [status,setStatus]=useState<OfficeLiveStatus>({phase:'idle'});
  const pageVisible=usePageVisible();
  const onScreen=useOnScreen(ref,!!id);
  const active=!!id&&!!source&&pageVisible&&onScreen;
  const latest=useRef({onUpdated,source,since});latest.current={onUpdated,source,since};
  const sourceKey=source?JSON.stringify(source):'';
  // A refresh runs to its end before the next one; an update meanwhile gives one more after it.
  const queue=useRef<{running:boolean;next:number|null}>({running:false,next:null});
  useEffect(()=>{
    if(!id)return;
    const run=async(version:number)=>{
      const state=queue.current;
      if(state.running){state.next=version;return;}
      state.running=true;
      try {
        for(let next:number|null=version;next!==null;next=state.next,state.next=null){
          try{await latest.current.onUpdated(next);setStatus({phase:'updated',at:Date.now()});}
          catch(error){setStatus({phase:'failed',error:error instanceof Error?error.message:String(error)});}
        }
      } finally {state.running=false;}
    };
    return subscribe(event=>{
      if(event.type!=='officeLiveChanged'||event.id!==id)return;
      if(event.phase==='rendering')setStatus({phase:'updating'});
      else if(event.phase==='failed')setStatus({phase:'failed',error:event.error??'The preview could not be redrawn.'});
      else if(event.phase==='updated')void run(event.version);
    });
  },[id]);
  useEffect(()=>{
    if(!active||!id||!latest.current.source)return;
    let live=true;
    void retain(id,latest.current.source,latest.current.since).then(state=>{
      // Refreshed while this mount was away (scrolled off, remounted): show the newest pages.
      // (A file viewer reads the file when it mounts, so only office_render pages need this.)
      if(live&&state&&state.version>0&&latest.current.source?.kind==='render')void Promise.resolve(latest.current.onUpdated(state.version)).catch(()=>undefined);
    });
    return()=>{live=false;release(id);};
  },[active,id,sourceKey]);
  return status;
}

const JUST_NOW_MS=60_000;
const clock=(at:number)=>new Date(at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
/** The quiet line under a live preview: Updating…, Updated just now (then the time), or why a refresh failed. */
export function OfficeLiveLine({status}:{status:OfficeLiveStatus}):React.ReactElement|null {
  const [,tick]=useState(0);
  const at=status.phase==='updated'?status.at:0;
  useEffect(()=>{if(!at)return;const timer=setTimeout(()=>tick(value=>value+1),Math.max(0,at+JUST_NOW_MS-Date.now())+50);return()=>clearTimeout(timer);},[at]);
  if(status.phase==='idle')return null;
  const text=status.phase==='updating'?'Updating…':status.phase==='updated'?(Date.now()-status.at<JUST_NOW_MS?'Updated just now':`Updated ${clock(status.at)}`):`Couldn’t redraw: ${status.error} Showing the last version.`;
  return <p className="office-live-status" data-state={status.phase} role="status" aria-live="polite">{text}</p>;
}
