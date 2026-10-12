import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {invoke} from '../bridge';
import {startActiveInterval,isWindowActive} from '../windowActivity';
import {elapsedLabel,type GitFacts} from '../sidebarSections';

/**
 * Live 'Working 20s' text. One shared one-second ticker writes straight into each registered element, so a
 * stream of running chats never re-renders a single sidebar row. The ticker stops when nobody is registered
 * and, through startActiveInterval, while the window is hidden.
 */
const timers=new Map<HTMLElement,number>();
let stopTicker:(()=>void)|undefined;
const paint=(now:number)=>{for(const [element,start] of timers)element.textContent=elapsedLabel(now-start);};
function register(element:HTMLElement,start:number):()=>void {
  timers.set(element,start);
  element.textContent=elapsedLabel(Date.now()-start);
  stopTicker??=startActiveInterval(()=>paint(Date.now()),1000);
  return()=>{timers.delete(element);if(!timers.size){stopTicker?.();stopTicker=undefined;}};
}
/** When this tab first saw each chat running (falls back to its last update if that is more recent than now). */
const startedAt=new Map<string,number>();
export function runStart(chatId:string,updatedAt:string,now=Date.now()):number {
  const known=startedAt.get(chatId);
  if(known!==undefined)return known;
  const updated=Date.parse(updatedAt);
  const start=Number.isFinite(updated)&&updated<=now?updated:now;
  startedAt.set(chatId,start);
  return start;
}
export const forgetRun=(chatId:string)=>{startedAt.delete(chatId);};
/** Test seam. */
export const liveTimerCount=()=>timers.size;

export function WorkingTimer({chatId,updatedAt}:{chatId:string;updatedAt:string}):React.ReactElement {
  const element=useRef<HTMLSpanElement>(null);
  useLayoutEffect(()=>{
    const node=element.current;
    if(!node)return;
    const off=register(node,runStart(chatId,updatedAt));
    return()=>{off();forgetRun(chatId);};
  },[chatId]);
  return <span ref={element} className="chat-row-elapsed" aria-hidden="true"/>;
}

/** Branch and open-PR count per folder, fetched lazily, a few at a time, cached for two minutes. */
const GIT_TTL=120_000,GIT_BATCH=6;
const gitCache=new Map<string,{at:number;facts:GitFacts}>();
const gitInflight=new Set<string>();
export function useFolderGit(folderIds:readonly string[]):ReadonlyMap<string,GitFacts> {
  const [,bump]=useState(0);
  const key=[...new Set(folderIds)].sort().join('|');
  useEffect(()=>{
    let cancelled=false;
    const wanted=key?key.split('|'):[];
    const stale=wanted.filter(id=>!gitInflight.has(id)&&(gitCache.get(id)?.at??0)<Date.now()-GIT_TTL).slice(0,GIT_BATCH);
    if(!stale.length||!isWindowActive())return;
    void (async()=>{
      for(const id of stale){
        gitInflight.add(id);
        try{
          const status=await invoke('git.status',{folderId:id});
          const facts:GitFacts={branch:status.detached?undefined:status.branch||undefined};
          try{
            const list=await invoke('git.pullRequests',{folderId:id});
            if(list.available&&facts.branch)facts.prs=list.items.filter(pr=>pr.headRefName===facts.branch&&pr.state.toUpperCase()==='OPEN').length;
          }catch{/* PR count is optional */}
          gitCache.set(id,{at:Date.now(),facts});
        }catch{gitCache.set(id,{at:Date.now(),facts:{}});}
        finally{gitInflight.delete(id);}
        if(cancelled)return;
        bump(n=>n+1);
      }
    })();
    return()=>{cancelled=true;};
  },[key]);
  const out=new Map<string,GitFacts>();
  for(const id of folderIds){const entry=gitCache.get(id);if(entry)out.set(id,entry.facts);}
  return out;
}
/** Test seam. */
export const seedGitCache=(id:string,facts:GitFacts)=>{gitCache.set(id,{at:Date.now(),facts});};
export const clearGitCache=()=>{gitCache.clear();gitInflight.clear();};
