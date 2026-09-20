import {useSyncExternalStore} from 'react';
import {invoke,subscribe} from './bridge.ts';
import {mergeProcessSummary,type ProcessSummarySnapshot} from '../shared/process-protocol.ts';

export interface ProcessSummaryState {summary:ProcessSummarySnapshot|null;loading:boolean;error:boolean}
const initial=():ProcessSummaryState=>({summary:null,loading:true,error:false});
let state=initial(),epoch=0,readId=0,applied=0;
let unsubscribe:(()=>void)|undefined;
const listeners=new Set<()=>void>();
const update=(next:ProcessSummaryState)=>{state=next;for(const listener of listeners)listener();};
export const getProcessSummaryState=():ProcessSummaryState=>state;

/** A single metadata reader for any number of overview/sidebar consumers. */
export function refreshProcessSummary():void {
  if(!listeners.size)return;
  const generation=epoch,request=++readId,priorApplied=applied;
  void invoke('processes.summary',{}).then(next=>{
    if(generation!==epoch||!listeners.size)return;
    const summary=mergeProcessSummary(state.summary,next);
    if(summary!==state.summary||state.loading||state.error){applied++;update({summary,loading:false,error:false});}
  }).catch(()=>{
    // An older failed read cannot invalidate a newer authoritative report.
    if(generation===epoch&&listeners.size&&request===readId&&priorApplied===applied)update({...state,loading:false,error:true});
  });
}

export function subscribeProcessSummary(listener:()=>void):()=>void {
  listeners.add(listener);
  if(listeners.size===1){
    const generation=++epoch;
    unsubscribe=subscribe(event=>{
      if(generation!==epoch)return;
      if(event.type==='processMetadata'){
        const summary=mergeProcessSummary(state.summary,event.summary);
        if(summary!==state.summary||state.loading||state.error){applied++;update({summary,loading:false,error:false});}
      }else if(event.type==='snapshot')refreshProcessSummary();
    });
    refreshProcessSummary();
  }
  let released=false;
  return()=>{
    if(released)return;released=true;listeners.delete(listener);
    if(!listeners.size){epoch++;unsubscribe?.();unsubscribe=undefined;state=initial();}
  };
}

export function useProcessSummary():ProcessSummaryState {
  return useSyncExternalStore(subscribeProcessSummary,getProcessSummaryState);
}
