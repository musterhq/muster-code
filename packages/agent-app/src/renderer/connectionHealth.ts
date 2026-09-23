import {useSyncExternalStore} from 'react';

/** PER-14: transport health is modeled apart from data freshness.
 *
 * - Transport: can the renderer reach the runtime right now? Fed by every IPC
 *   call (bridge.invoke) and by explicit probes. 'reconnecting' after a failed
 *   call, 'offline' when the bridge is missing or calls keep failing.
 * - Freshness: is what a view shows current? A chat can be silent because the
 *   provider is thinking (fresh), because events were missed while the
 *   subscription was broken (stale: resync from a snapshot), or because the
 *   transport is down (reconnecting).
 *
 * The old heuristic treated any 5 s of streaming silence as "Reconnecting",
 * so a healthy socket with a quiet provider (or a dropped subscription that a
 * snapshot would fix) could show an endless Reconnecting pill. */
export type TransportState='connected'|'reconnecting'|'offline';
export type Freshness='live'|'stale'|'resyncing';
/** What a running chat's header should say about its stream. */
export type StreamPresence='live'|'waiting'|'syncing'|'reconnecting'|'offline';

export interface TransportHealth {state:TransportState; failures:number; lastOkAt:number; lastError?:string}
export const OFFLINE_AFTER_FAILURES=3;

/** Messages that mean the channel itself failed, not the command. */
const TRANSPORT_FAILURE=/not connected|object has been destroyed|no handler registered|ipc|timed out|timeout|disconnected|channel closed|render frame was disposed|ECONNRESET|EPIPE/i;
export function isTransportFailure(error:unknown):boolean {
  const message=error instanceof Error?error.message:String(error??'');
  return TRANSPORT_FAILURE.test(message);
}

export function nextTransport(previous:TransportHealth,outcome:{ok:true;at:number}|{ok:false;at:number;error:string}):TransportHealth {
  if(outcome.ok)return {state:'connected',failures:0,lastOkAt:outcome.at};
  const failures=previous.failures+1;
  return {state:failures>=OFFLINE_AFTER_FAILURES?'offline':'reconnecting',failures,lastOkAt:previous.lastOkAt,lastError:outcome.error};
}

/** Freshness of a replica after a probe read: the server revision vs what the view holds. */
export function freshnessAfterProbe(localRevision:number|undefined,serverRevision:number):Freshness {
  return localRevision===undefined||serverRevision>localRevision?'stale':'live';
}

/** Header presence for a running chat. Transport outranks freshness; silence with a healthy
 * transport and current data is the provider working ("waiting"), never "reconnecting". */
export function streamPresence(input:{transport:TransportState;freshness:Freshness;stalled:boolean}):StreamPresence {
  if(input.transport==='offline')return 'offline';
  if(input.transport==='reconnecting')return 'reconnecting';
  if(input.freshness!=='live')return 'syncing';
  return input.stalled?'waiting':'live';
}

// App-wide transport store (one per renderer).
let health:TransportHealth={state:'connected',failures:0,lastOkAt:Date.now()};
const listeners=new Set<()=>void>();
function publish(next:TransportHealth):void {
  if(next.state===health.state&&next.failures===health.failures&&next.lastError===health.lastError){health=next;return;}
  health=next;for(const listener of listeners)listener();
}
export function transportHealth():TransportHealth {return health;}
export function recordTransport(outcome:{ok:true}|{ok:false;error:unknown},now=Date.now()):void {
  if(outcome.ok){if(health.state!=='connected'||health.failures)publish(nextTransport(health,{ok:true,at:now}));else health={...health,lastOkAt:now};return;}
  if(!isTransportFailure(outcome.error))return;
  publish(nextTransport(health,{ok:false,at:now,error:outcome.error instanceof Error?outcome.error.message:String(outcome.error)}));
}
export function markTransportOffline(reason:string):void {publish({state:'offline',failures:OFFLINE_AFTER_FAILURES,lastOkAt:health.lastOkAt,lastError:reason});}
export function subscribeTransport(listener:()=>void):()=>void {listeners.add(listener);return()=>listeners.delete(listener);}
export function useTransportHealth():TransportHealth {return useSyncExternalStore(subscribeTransport,transportHealth,transportHealth);}
/** Tests only. */
export function resetTransportHealth():void {health={state:'connected',failures:0,lastOkAt:Date.now()};for(const listener of listeners)listener();}
